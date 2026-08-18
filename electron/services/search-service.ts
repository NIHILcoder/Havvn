/**
 * Search Service
 * Plugin-based torrent search using Jackett/Torznab/Custom providers.
 * Users configure their own providers — no hardcoded tracker URLs.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { app } from 'electron';
import { logger, httpFetchText } from '../utils';
import { t } from '../i18n';
import * as db from '../db/store';
import { SearchProvider, SearchResult } from '../../shared/types';
import { parseScriptOutput } from '../../shared/search-parse';
import { decodeEntities } from '../../shared/feed-parse';
import { detectPython } from './python-detector';

const log = logger.child('SearchService');

// Hard limits for the script-provider sandbox: a plugin can't run forever or
// flood us with output.
const SCRIPT_TIMEOUT_MS = 25000;
const SCRIPT_MAX_BUFFER = 8 * 1024 * 1024; // 8 MB of stdout

// Network limits for the HTTP-backed providers (Jackett / Torznab / custom).
const FETCH_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Read one attribute out of a start tag, accepting either quote style.
 * The value is entity-decoded, as a real XML parser would: magnet URLs arrive
 * with "&amp;" between parameters and are dead links until that is undone.
 */
function xmlAttr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? '');
}

export class SearchService {

  async search(query: string, category?: string): Promise<SearchResult[]> {
    const providers = await db.getSearchProviders();
    const enabled = providers.filter(p => p.enabled);

    if (enabled.length === 0) {
      log.info('No search providers configured');
      return [];
    }

    log.info('Searching', { query, category, providers: enabled.length });

    const results = await Promise.allSettled(
      enabled.map(p => this.searchProvider(p, query, category))
    );

    const allResults: SearchResult[] = [];
    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        allResults.push(...result.value);
      } else {
        // Resilient aggregate: one bad provider shouldn't fail the whole search
        log.warn('Provider search failed', {
          provider: enabled[idx]?.name,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });

    // Sort by seeds descending
    allResults.sort((a, b) => b.seeds - a.seeds);
    log.info(`Search complete: ${allResults.length} results`);
    return allResults;
  }

  async testProvider(id: string): Promise<{ success: boolean; message: string }> {
    const providers = await db.getSearchProviders();
    const provider = providers.find(p => p.id === id);
    if (!provider) return { success: false, message: t('search.providerNotFound') };

    try {
      await this.searchProvider(provider, 'test', undefined);
      return { success: true, message: t('search.providerWorking') };
    } catch (err: any) {
      return { success: false, message: err?.message || String(err) };
    }
  }

  private async searchProvider(provider: SearchProvider, query: string, category?: string): Promise<SearchResult[]> {
    switch (provider.type) {
      case 'jackett':
        return this.searchJackett(provider, query, category);
      case 'torznab':
        return this.searchTorznab(provider, query, category);
      case 'custom':
        return this.searchCustom(provider, query, category);
      case 'script':
        return this.searchScript(provider, query, category);
      default:
        // 'archive' (Internet Archive) was removed: archive.org disabled public
        // .torrent downloads in late 2024 (HTTP 401), so it can't serve torrents.
        return [];
    }
  }

  /**
   * Jackett API — https://github.com/Jackett/Jackett
   * GET /api/v2.0/indexers/all/results?apikey=XXX&Query=XXX&Category[]=XXX
   */
  private async searchJackett(provider: SearchProvider, query: string, category?: string): Promise<SearchResult[]> {
    const baseUrl = provider.url.replace(/\/$/, '');
    const params = new URLSearchParams({
      apikey: provider.apiKey || '',
      Query: query,
    });
    if (category) params.append('Category[]', category);

    const url = `${baseUrl}/api/v2.0/indexers/all/results?${params}`;
    const response = await this.fetchJSON(url);

    if (!response || !Array.isArray(response.Results)) {
      throw new Error('Unexpected Jackett response (missing Results array)');
    }

    return response.Results.map((r: any): SearchResult => ({
      title: r.Title || '',
      magnetUri: r.MagnetUri || undefined,
      torrentUrl: r.Link || undefined,
      size: r.Size || 0,
      seeds: r.Seeders || 0,
      leechers: r.Peers || 0,
      provider: provider.name,
      publishDate: r.PublishDate || undefined,
      category: r.CategoryDesc || undefined,
      infoHash: r.InfoHash || undefined,
    }));
  }

  /**
   * Torznab API — compatible with Prowlarr, NZBHydra2, etc.
   * GET /api?apikey=XXX&t=search&q=XXX&cat=XXX
   */
  private async searchTorznab(provider: SearchProvider, query: string, category?: string): Promise<SearchResult[]> {
    const baseUrl = provider.url.replace(/\/$/, '');
    const params = new URLSearchParams({
      apikey: provider.apiKey || '',
      t: 'search',
      q: query,
    });
    if (category) params.append('cat', category);

    const url = `${baseUrl}/api?${params}`;
    const xml = await this.fetchText(url);

    return this.parseTorznabXML(xml, provider.name);
  }

  private parseTorznabXML(xml: string, providerName: string): SearchResult[] {
    const results: SearchResult[] = [];

    try {
      // Tolerate attributes on the element (`<item xmlns:…>`) and whitespace in
      // the closing tag; the old `/<item>/` only matched the bare form and
      // returned zero results for indexers that emit either.
      const itemRegex = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi;
      let match;

      while ((match = itemRegex.exec(xml)) !== null) {
        const item = match[1];
        const title = this.extractXMLTag(item, 'title') || '';

        // Extract magnet from torznab:attr
        let magnetUri: string | undefined;
        let infoHash: string | undefined;
        let size = 0;
        let seeds = 0;
        let leechers = 0;

        // Servers vary: the namespace prefix isn't guaranteed, `value` sometimes
        // precedes `name`, and single quotes are legal XML. Grab whole elements
        // and pull each attribute out individually rather than assuming a layout.
        const attrRegex = /<(?:\w+:)?attr\s[^>]*?\/?>/gi;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(item)) !== null) {
          const name = xmlAttr(attrMatch[0], 'name');
          const value = xmlAttr(attrMatch[0], 'value');
          if (!name || value === null) continue;
          switch (name.toLowerCase()) {
            case 'magneturl': magnetUri = value; break;
            case 'infohash': infoHash = value; break;
            case 'seeders': seeds = parseInt(value) || 0; break;
            case 'peers': leechers = parseInt(value) || 0; break;
            case 'size': size = parseInt(value) || 0; break;
          }
        }

        // Fallback size from enclosure
        const enclosureMatch = item.match(/<enclosure[^>]*length="(\d+)"/i);
        if (enclosureMatch && !size) size = parseInt(enclosureMatch[1]) || 0;

        const torrentUrl = this.extractXMLTag(item, 'link') || undefined;
        const pubDate = this.extractXMLTag(item, 'pubDate') || undefined;

        results.push({
          title,
          magnetUri,
          torrentUrl,
          size,
          seeds,
          leechers,
          provider: providerName,
          publishDate: pubDate,
          infoHash,
        });
      }
    } catch (err) {
      log.error('Torznab XML parse error', { error: err });
    }

    return results;
  }

  /**
   * Custom provider — simple GET with {query} placeholder in URL.
   * Expects JSON response: { results: [{ title, magnetUri, size, seeds, leechers }] }
   */
  private async searchCustom(provider: SearchProvider, query: string, _category?: string): Promise<SearchResult[]> {
    const url = provider.url
      .replace('{query}', encodeURIComponent(query))
      .replace('{apikey}', provider.apiKey || '');

    const response = await this.fetchJSON(url);

    if (!response || !Array.isArray(response.results)) {
      throw new Error('Unexpected response (missing results array)');
    }

    return response.results.map((r: any): SearchResult => ({
      title: r.title || '',
      magnetUri: r.magnetUri || r.magnet || undefined,
      torrentUrl: r.torrentUrl || r.url || undefined,
      size: r.size || 0,
      seeds: r.seeds || r.seeders || 0,
      leechers: r.leechers || r.peers || 0,
      provider: provider.name,
      publishDate: r.publishDate || r.date || undefined,
      category: r.category || undefined,
      infoHash: r.infoHash || r.hash || undefined,
    }));
  }

  /**
   * Script provider — runs a local Python plugin the user explicitly added.
   * Contract (kept deliberately small so the engine has ONE parse path):
   *   - We invoke:  <python> <script.py> <query> <category>
   *     (category is "" when none is selected).
   *   - The script MUST print to stdout a JSON array of result objects:
   *       { title, magnetUri?, torrentUrl?, size?, seeds?, leechers?,
   *         publishDate?, category?, infoHash? }
   *   - Anything on stderr is treated as diagnostics, never parsed.
   *
   * Security posture: execFile (no shell → no command injection), a hard
   * timeout + output cap, the script must be a user-provided .py file, and
   * every parsed field is coerced/clamped before it reaches the UI. The whole
   * point of language-side qBittorrent compatibility lives in a userland
   * adapter script, NOT here — this stays a single, auditable code path.
   */
  private async searchScript(provider: SearchProvider, query: string, category?: string): Promise<SearchResult[]> {
    const raw = (provider.url || '').trim();
    if (!raw) throw new Error('No script path configured');
    if (!/\.py$/i.test(raw)) {
      throw new Error('Script provider must point to a .py file');
    }
    // Resolve to an absolute path so a leading "-" can never be parsed as a
    // Python flag (e.g. "-c.py"), and so cwd-relative paths are unambiguous.
    const scriptPath = path.resolve(raw);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(scriptPath);
    } catch {
      throw new Error(`Script not found: ${scriptPath}`);
    }
    if (!stat.isFile()) throw new Error('Script path is not a file');

    const py = await detectPython();
    if (!py) {
      throw new Error('Python 3 was not found on your system — install it and try again');
    }

    const args = [...py.baseArgs, scriptPath, query, category || ''];
    log.info('Running script provider', { name: provider.name, command: py.command });

    // Pass the provider's (decrypted) credentials to the plugin via the
    // environment so auth'd indexers (e.g. RuTracker) work while the actual
    // scraping/login stays entirely in the userland .py — the core never logs in.
    const credEnv: Record<string, string> = {};
    if (provider.username) credEnv.TH_USERNAME = provider.username;
    if (provider.password) credEnv.TH_PASSWORD = provider.password;
    if (provider.apiKey) credEnv.TH_APIKEY = provider.apiKey;
    if (provider.url) credEnv.TH_PROVIDER_URL = provider.url;

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        py.command,
        args,
        {
          timeout: SCRIPT_TIMEOUT_MS,
          maxBuffer: SCRIPT_MAX_BUFFER,
          windowsHide: true,
          cwd: path.dirname(scriptPath),
          env: { ...process.env, ...credEnv, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        },
        (err, out, errOut) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            const detail = (errOut || '').toString().trim().slice(0, 400);
            if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              reject(new Error('Script produced too much output'));
            } else if ((err as any).killed) {
              reject(new Error('Script timed out'));
            } else {
              reject(new Error(detail || err.message || 'Script failed'));
            }
            return;
          }
          resolve((out || '').toString());
        }
      );
      // A plugin should never need stdin; close it so a script that reads stdin
      // gets EOF immediately instead of blocking until the timeout.
      child.stdin?.end();
    });

    return parseScriptOutput(stdout, provider.name);
  }

  private extractXMLTag(xml: string, tag: string): string | null {
    const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
    const cdataMatch = xml.match(cdataRegex);
    // CDATA content is literal — don't entity-decode it.
    if (cdataMatch) return cdataMatch[1].trim();

    const normalRegex = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
    const normalMatch = xml.match(normalRegex);
    // Regular text content is entity-encoded ("&amp;", "&#39;", …) — decode it
    // so titles and links aren't shown/queried with raw entities.
    if (normalMatch) return decodeEntities(normalMatch[1].trim());

    return null;
  }

  private async fetchJSON(url: string): Promise<any> {
    const text = await this.fetchText(url, { 'Accept': 'application/json' });
    return JSON.parse(text);
  }

  /**
   * Fetch a provider response as text. Redirect hops are capped and resolved
   * against the current URL, the body is size-capped, and the bytes are decoded
   * with the declared charset — trackers that answer in windows-1251 used to
   * come back as mojibake. See `utils/http-fetch`.
   */
  private async fetchText(url: string, extraHeaders: Record<string, string> = {}): Promise<string> {
    return httpFetchText(url, {
      headers: {
        'User-Agent': `Havvn/${app.getVersion()} Search`,
        ...extraHeaders,
      },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      what: 'search provider',
    });
  }
}

let searchService: SearchService | null = null;

export function getSearchService(): SearchService {
  if (!searchService) {
    searchService = new SearchService();
  }
  return searchService;
}
