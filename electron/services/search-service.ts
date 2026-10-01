/**
 * Search Service
 * Plugin-based torrent search using Jackett/Torznab/Custom providers.
 * Users configure their own providers — no hardcoded tracker URLs.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { createRequire } from 'module';
import { app } from 'electron';
import { openProviderNetworkBridge } from './provider-network-bridge';
import { providerNetwork } from './provider-network';
import { getProviderRoute, rememberProviderMirror } from './provider-network-store';
import { ProviderNetworkError, pluginNetworkError } from '../../shared/provider-network';
import { httpProviderBase, httpResultUrl, rebaseProviderUrl, type HttpProviderAddress } from '../../shared/provider-mirrors';
import { readHttpMirrors, HTTP_MIRROR_BUDGET_MS } from './provider-mirrors';
import { logger, httpFetchText, httpFetch } from '../utils';
import { t } from '../i18n';
import * as db from '../db/store';
import { SearchProvider, SearchResult, SearchProgress, ProviderStat, SearchCaps, SearchCategory } from '../../shared/types';
import { parseScriptOutput } from '../../shared/search-parse';
import { decodeEntities } from '../../shared/feed-parse';
import { parseCaps, mergeCategories } from '../../shared/torznab-caps';
import { parsePluginManifest, PluginManifest, MANIFEST_SCAN_BYTES } from '../../shared/plugin-manifest';
import { detectPython } from './python-detector';
import { searchSourceHistoryKeys } from './search-source-history';
import { sanitizeReleaseMedia } from '../../shared/release-languages';

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

/** Providers queried at once. Without a cap, twenty script providers meant twenty
 *  simultaneous python processes. */
const MAX_CONCURRENT_PROVIDERS = 4;

/** Caps describe an indexer's shape, which barely moves — an hour is plenty. */
const CAPS_TTL_MS = 60 * 60 * 1000;

/**
 * How long a completed search stays replayable. Long enough that flipping
 * between two queries, or coming back to the page, costs nothing; short enough
 * that seed counts are still roughly true.
 */
const RESULT_TTL_MS = 5 * 60 * 1000;

/** Searches kept before the oldest is dropped. */
const RESULT_CACHE_MAX = 20;

interface CachedSearch {
  at: number;
  stats: ProviderStat[];
  results: SearchResult[];
}

interface SearchRun {
  controller: AbortController;
  /** Resolved once every provider has reported. */
  finished: Promise<void>;
}

export type SearchProgressSink = (progress: SearchProgress) => void;

export class SearchService {
  private sources = new Map<string, { provider: SearchProvider; result: SearchResult; mirrorBase?: string }>();
  private resultBases = new WeakMap<SearchResult, string>();
  private runs = new Map<string, SearchRun>();
  private capsCache = new Map<string, { caps: SearchCaps; at: number }>();
  private resultCache = new Map<string, CachedSearch>();

  /**
   * Start a search. Returns as soon as the provider list is known; each provider
   * pushes its own results through `emit` as it finishes, and a final `done`
   * message closes the run.
   *
   * The old shape awaited every provider before returning anything, so one slow
   * script provider (25s ceiling) held up results a fast indexer had ready in
   * half a second, and there was no way to give up on a search in flight.
   */
  async start(
    query: string,
    category: string | undefined,
    emit: SearchProgressSink,
    options: { refresh?: boolean; providerId?: string } = {}
  ): Promise<{ searchId: string; providers: string[]; cached?: boolean }> {
    const providers = await db.getSearchProviders();
    const enabled = providers.filter(p => p.enabled && (!options.providerId || p.id === options.providerId));
    const searchId = randomUUID();

    if (enabled.length === 0) {
      log.info('No search providers configured');
      // Still opens and closes the run so the caller has one code path.
      queueMicrotask(() => emit({ searchId, done: true }));
      return { searchId, providers: [] };
    }

    const cacheKey = this.cacheKey(query, category, enabled);
    if (!options.refresh) {
      const hit = this.resultCache.get(cacheKey);
      if (hit && Date.now() - hit.at < RESULT_TTL_MS) {
        log.info('Search served from cache', { query, category, searchId });
        // Replay through the same channel the live path uses, so the renderer
        // has exactly one way to receive results.
        queueMicrotask(() => {
          for (const stat of hit.stats) {
            emit({
              searchId,
              done: false,
              stat,
              results: hit.results.filter(r => r.provider === stat.name),
            });
          }
          emit({ searchId, done: true });
        });
        return { searchId, providers: enabled.map(p => p.name), cached: true };
      }
    }

    log.info('Searching', { query, category, providers: enabled.length, searchId });

    const controller = new AbortController();
    const finished = this.runProviders(searchId, enabled, query, category, controller, emit, cacheKey);
    this.runs.set(searchId, { controller, finished });

    finished.finally(() => this.runs.delete(searchId));

    return { searchId, providers: enabled.map(p => p.name) };
  }

  /**
   * Cache identity. The provider set is part of it: enabling an indexer must not
   * serve a cached answer that predates it.
   */
  private cacheKey(query: string, category: string | undefined, providers: SearchProvider[]): string {
    const ids = providers.map(p => p.id).sort().join(',');
    return `${query.trim().toLowerCase()}\u0000${category || ''}\u0000${ids}`;
  }

  private remember(key: string, stats: ProviderStat[], results: SearchResult[]): void {
    this.resultCache.set(key, { at: Date.now(), stats, results });
    // Map iteration is insertion-ordered, so the first key is the oldest.
    while (this.resultCache.size > RESULT_CACHE_MAX) {
      const oldest = this.resultCache.keys().next().value;
      if (oldest === undefined) break;
      this.resultCache.delete(oldest);
    }
  }

  /** Drop cached results — called when the provider set changes under us. */
  clearResultCache(): void {
    this.resultCache.clear();
    this.capsCache.clear();
    for (const run of this.runs.values()) run.controller.abort();
  }

  /** Abort a search in flight — in-flight HTTP requests and scripts included. */
  cancel(searchId: string): void {
    const run = this.runs.get(searchId);
    if (!run) return;
    log.info('Search cancelled', { searchId });
    run.controller.abort();
  }

  /** Query providers a few at a time, emitting each one's results as they land. */
  private async runProviders(
    searchId: string,
    providers: SearchProvider[],
    query: string,
    category: string | undefined,
    controller: AbortController,
    emit: SearchProgressSink,
    cacheKey: string
  ): Promise<void> {
    const queue = [...providers];
    const collectedStats: ProviderStat[] = [];
    const collectedResults: SearchResult[] = [];

    const worker = async (): Promise<void> => {
      for (;;) {
        const provider = queue.shift();
        if (!provider || controller.signal.aborted) return;

        const startedAt = Date.now();
        try {
          const results = await this.searchProvider(provider, query, category, controller.signal);
          const checkedAt = Date.now();
          for (const result of results) {
            result.checkedAt = checkedAt;
            const key = randomUUID();
            const mirrorBase = this.resultBases.get(result);
            const primary = mirrorBase ? httpProviderBase(provider as HttpProviderAddress) : undefined;
            // Mirror changes must not turn one hashless source into new history.
            const canonical = (value?: string) => value && mirrorBase && primary ? rebaseProviderUrl(value, mirrorBase, primary) ?? value : value;
            result.historyKeys = searchSourceHistoryKeys(provider.id, { ...result, torrentUrl: canonical(result.torrentUrl), detailsUrl: canonical(result.detailsUrl) });
            this.sources.set(key, { provider, result: { ...result }, mirrorBase });
            // Download URLs may embed an API key/passkey. Main resolves the capability.
            result.torrentUrl = undefined;
            result.sourceRefs = [key];
          }
          while (this.sources.size > 10000) this.sources.delete(this.sources.keys().next().value!);
          if (controller.signal.aborted) return;
          const stat: ProviderStat = {
            providerId: provider.id,
            name: provider.name,
            count: results.length,
            ms: Date.now() - startedAt,
            state: 'ok',
          };
          collectedStats.push(stat);
          collectedResults.push(...results);
          emit({ searchId, done: false, stat, results });
        } catch (err) {
          if (controller.signal.aborted) return;
          const message = err instanceof ProviderNetworkError ? t('search.network.' + err.code) : err instanceof Error ? err.message : String(err);
          // Resilient aggregate: one bad provider shouldn't fail the whole
          // search — but the user gets told, instead of seeing "no results".
          log.warn('Provider search failed', { provider: provider.name, error: message });
          const stat: ProviderStat = {
            providerId: provider.id,
            name: provider.name,
            count: 0,
            ms: Date.now() - startedAt,
            error: message,
            state: 'failed',
          };
          collectedStats.push(stat);
          emit({ searchId, done: false, stat, results: [] });
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_PROVIDERS, providers.length) },
      () => worker()
    );
    await Promise.all(workers);

    // Only a run that finished is worth replaying; a cancelled one is partial by
    // definition and would masquerade as a complete answer.
    if (!controller.signal.aborted) {
      this.remember(cacheKey, collectedStats, collectedResults);
    }

    emit({ searchId, done: true });
    log.info('Search complete', { searchId, cancelled: controller.signal.aborted });
  }

  async testProvider(id: string): Promise<{ success: boolean; message: string }> {
    const providers = await db.getSearchProviders();
    const provider = providers.find(p => p.id === id);
    if (!provider) return { success: false, message: t('search.providerNotFound') };

    try {
      // Torznab-speaking providers answer `t=caps` — a cheap metadata call that
      // proves URL, key and reachability without making the indexer run a real
      // query for the literal word "test".
      if (provider.type === 'torznab' || provider.type === 'jackett') {
        const caps = await this.fetchCaps(provider);
        if (!caps.searchAvailable) {
          return { success: false, message: t('search.providerNoSearch') };
        }
        return { success: true, message: t('search.providerWorking') };
      }
      if (provider.type === 'script') await this.searchScript(provider, 'test', undefined, undefined, true);
      else await this.searchProvider(provider, 'test', undefined);
      return { success: true, message: t('search.providerWorking') };
    } catch (err: any) {
      return { success: false, message: err instanceof ProviderNetworkError ? t('search.network.' + err.code) : err?.message || String(err) };
    }
  }

  /**
   * Categories every enabled provider supports, unioned for one dropdown.
   * Providers that can't answer (custom, script, unreachable) simply contribute
   * nothing rather than failing the call.
   */
  async getCategories(): Promise<SearchCategory[]> {
    const providers = await db.getSearchProviders();
    const capable = providers.filter(p => p.enabled && (p.type === 'torznab' || p.type === 'jackett'));

    const sets = await Promise.all(
      capable.map(async p => {
        try {
          return (await this.getCaps(p)).categories;
        } catch (err) {
          log.debug('Caps unavailable', { provider: p.name, error: String(err) });
          return [];
        }
      })
    );

    return mergeCategories(sets);
  }

  /**
   * Read a script plugin's self-description, if it has one.
   *
   * Only the head of the file is read: a manifest belongs near the top, and this
   * runs on a path the user just picked in a file dialog.
   */
  async readScriptManifest(scriptPath: string): Promise<PluginManifest | null> {
    const resolved = path.resolve((scriptPath || '').trim());
    if (!/\.py$/i.test(resolved)) return null;

    try {
      const handle = await fs.promises.open(resolved, 'r');
      try {
        const buffer = Buffer.alloc(MANIFEST_SCAN_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, MANIFEST_SCAN_BYTES, 0);
        return parsePluginManifest(buffer.subarray(0, bytesRead).toString('utf-8'));
      } finally {
        await handle.close();
      }
    } catch (err) {
      log.debug('Could not read plugin manifest', { scriptPath: resolved, error: String(err) });
      return null;
    }
  }

  /** Caps for one provider, cached — they change about as often as the indexer does. */
  private async getCaps(provider: SearchProvider): Promise<SearchCaps> {
    const cached = this.capsCache.get(provider.id);
    if (cached && Date.now() - cached.at < CAPS_TTL_MS) return cached.caps;

    const caps = await this.fetchCaps(provider);
    this.capsCache.set(provider.id, { caps, at: Date.now() });
    return caps;
  }

  private async fetchCaps(provider: SearchProvider): Promise<SearchCaps> {
    const baseUrl = provider.url.replace(/\/$/, '');
    const params = new URLSearchParams({ apikey: provider.apiKey || '', t: 'caps' });
    // Jackett serves a Torznab endpoint too, aggregating every configured tracker.
    const url = provider.type === 'jackett'
      ? `${baseUrl}/api/v2.0/indexers/all/results/torznab/api?${params}`
      : `${baseUrl}/api?${params}`;

    return this.readHTTP(provider, url, text => parseCaps(text));
  }

  private async searchProvider(
    provider: SearchProvider,
    query: string,
    category?: string,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    switch (provider.type) {
      case 'jackett':
        return this.searchJackett(provider, query, category, signal);
      case 'torznab':
        return this.searchTorznab(provider, query, category, signal);
      case 'custom':
        return this.searchCustom(provider, query, signal);
      case 'script':
        return this.searchScript(provider, query, category, signal);
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
  private async searchJackett(
    provider: SearchProvider,
    query: string,
    category?: string,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    const baseUrl = provider.url.replace(/\/$/, '');
    const params = new URLSearchParams({
      apikey: provider.apiKey || '',
      Query: query,
    });
    if (category) params.append('Category[]', category);

    const url = `${baseUrl}/api/v2.0/indexers/all/results?${params}`;
    return this.readHTTP(provider, url, (text, base, responseUrl) => {
      const response = JSON.parse(text);

      if (!response || !Array.isArray(response.Results)) {
        throw new Error('Unexpected Jackett response (missing Results array)');
      }

      return this.bindHttpResults(provider, response.Results.map((r: any): SearchResult => ({
        title: r.Title || '',
        magnetUri: r.MagnetUri || undefined,
        torrentUrl: r.Link || undefined,
        size: r.Size || 0,
        seeds: r.Seeders || 0,
        leechers: r.Peers || 0,
        provider: provider.name,
        // Jackett fans one query out over every configured tracker, so the row's
        // real origin is r.Tracker — labelling them all "Jackett" threw away the
        // one thing that distinguishes them.
        indexer: r.Tracker || undefined,
        publishDate: r.PublishDate || undefined,
        category: r.CategoryDesc || undefined,
        infoHash: r.InfoHash || undefined,
        detailsUrl: r.Details || r.Guid || undefined,
        grabs: typeof r.Grabs === 'number' ? r.Grabs : undefined,
        freeleech: r.DownloadVolumeFactor === 0 || undefined,
        imdbId: r.Imdb ? `tt${String(r.Imdb).padStart(7, '0')}` : undefined,
      })), base, responseUrl);
    }, signal, { Accept: 'application/json' });
  }

  /**
   * Torznab API — compatible with Prowlarr, NZBHydra2, etc.
   * GET /api?apikey=XXX&t=search&q=XXX&cat=XXX
   */
  private async searchTorznab(
    provider: SearchProvider,
    query: string,
    category?: string,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    const baseUrl = provider.url.replace(/\/$/, '');
    const params = new URLSearchParams({
      apikey: provider.apiKey || '',
      t: 'search',
      q: query,
    });
    if (category) params.append('cat', category);

    const url = `${baseUrl}/api?${params}`;
    return this.readHTTP(provider, url, (xml, base, responseUrl) => {
      if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml) || !/<\/channel\s*>/i.test(xml) || !/<\/rss\s*>/i.test(xml)) {
        throw new ProviderNetworkError('invalid-response');
      }
      return this.bindHttpResults(provider, this.parseTorznabXML(xml, provider.name), base, responseUrl);
    }, signal);
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
        let grabs: number | undefined;
        let freeleech: boolean | undefined;
        let imdbId: string | undefined;

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
            case 'grabs': grabs = parseInt(value) || undefined; break;
            // 0 means the download doesn't count against your ratio.
            case 'downloadvolumefactor': freeleech = parseFloat(value) === 0; break;
            case 'imdb': imdbId = `tt${value.replace(/^tt/i, '').padStart(7, '0')}`; break;
            case 'imdbid': imdbId = value.startsWith('tt') ? value : `tt${value}`; break;
          }
        }

        // Fallback size from enclosure
        const enclosureMatch = item.match(/<enclosure[^>]*length="(\d+)"/i);
        if (enclosureMatch && !size) size = parseInt(enclosureMatch[1]) || 0;

        const torrentUrl = this.extractXMLTag(item, 'link') || undefined;
        const pubDate = this.extractXMLTag(item, 'pubDate') || undefined;
        // <comments> is where torznab puts the human-readable release page;
        // <guid> is the fallback when it is a URL rather than an opaque id.
        const comments = this.extractXMLTag(item, 'comments');
        const guid = this.extractXMLTag(item, 'guid');
        const detailsUrl = comments || (guid && /^https?:\/\//i.test(guid) ? guid : undefined);

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
          detailsUrl: detailsUrl || undefined,
          grabs,
          freeleech: freeleech || undefined,
          imdbId,
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
  private async searchCustom(provider: SearchProvider, query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = provider.url
      .replace('{query}', encodeURIComponent(query))
      .replace('{apikey}', provider.apiKey || '');

    return this.readHTTP(provider, url, (text, base, responseUrl) => {
      const response = JSON.parse(text);

      if (!response || !Array.isArray(response.results)) {
        throw new Error('Unexpected response (missing results array)');
      }

      return this.bindHttpResults(provider, response.results.map((r: any): SearchResult => ({
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
        detailsUrl: r.detailsUrl || r.details || undefined,
        media: sanitizeReleaseMedia(r.media),
      })), base, responseUrl);
    }, signal, { Accept: 'application/json' });
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
  private async searchScript(
    provider: SearchProvider,
    query: string,
    category?: string,
    signal?: AbortSignal,
    checkOnly = false
  ): Promise<SearchResult[]> {
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
      throw new Error(t('search.plugin.pythonMissing'));
    }

    const args = [...py.baseArgs, scriptPath, query, category || ''];
    log.info('Running script provider', { name: provider.name, command: py.command });

    // Pass the provider's (decrypted) credentials to the plugin via the
    // environment so auth'd indexers (e.g. RuTracker) work while the actual
    // scraping/login stays entirely in the userland .py — the core never logs in.
    const credEnv: Record<string, string> = {};
    credEnv.HAVVN_CHECK_ONLY = checkOnly ? '1' : '0';
    if (provider.username) credEnv.TH_USERNAME = provider.username;
    if (provider.password) credEnv.TH_PASSWORD = provider.password;
    if (provider.apiKey) credEnv.TH_APIKEY = provider.apiKey;
    if (provider.url) credEnv.TH_PROVIDER_URL = provider.url;

    const route = getProviderRoute(provider.id);
    const supportsNetwork = /#\s*havvn-network:\s*1\b/.test((await fs.promises.readFile(scriptPath, 'utf8')).slice(0, 4096));
    if (route && !supportsNetwork) throw new Error(t('search.plugin.updateRequired'));
    const bridge = route ? await openProviderNetworkBridge(provider.id, route.connection, route.origins) : null;
    if (route?.mirrors.length) credEnv.HAVVN_SOURCE_MIRRORS = JSON.stringify(route.mirrors);
    if (bridge) {
      credEnv.HAVVN_NETWORK_URL = bridge.url;
      credEnv.HAVVN_NETWORK_TOKEN = bridge.token;
      const sdkPath = app.isPackaged ? path.join(process.resourcesPath, 'search-sdk') : path.join(app.getAppPath(), 'docs/search-plugins');
      credEnv.PYTHONPATH = [sdkPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    }
    try {
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
          // Cancelling the search kills the interpreter instead of leaving it to
          // run out its 25-second ceiling in the background.
          signal,
        },
        (err, out, errOut) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            let detail = (errOut || '').toString().trim();
            for (const secret of [provider.password, provider.apiKey, bridge?.token]) {
              if (secret) detail = detail.split(secret).join('[redacted]');
            }
            detail = detail.slice(0, 400);
            if (signal?.aborted) {
              reject(new ProviderNetworkError('cancelled'));
            } else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              reject(new Error('Script produced too much output'));
            } else if ((err as any).killed) {
              reject(new ProviderNetworkError('timeout'));
            } else {
              reject(pluginNetworkError((errOut || '').toString()) || new Error(detail || err.message || 'Script failed'));
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

    const results = parseScriptOutput(stdout, provider.name);
    // The plugin may confirm a working mirror even when the search has zero hits.
    let reportedMirror: unknown;
    try { reportedMirror = JSON.parse(stdout)?.mirror; } catch { /* parser above validates result data */ }
    const workingMirror = route?.mirrors.find(m => m === reportedMirror || results.some(r => r.detailsUrl?.startsWith(m + '/')));
    if (workingMirror) rememberProviderMirror(provider.id, workingMirror);
    return results;
    } finally { await bridge?.close(); }
  }

  /** Only main's registered fingerprints may be associated with an added download. */
  historyKeysForSources(refs: string[]): string[] {
    if (!Array.isArray(refs) || !refs.length || refs.length > 20 || refs.some(ref => typeof ref !== 'string' || ref.length > 128)) {
      throw new Error('Invalid search source');
    }
    return [...new Set(refs.flatMap(ref => this.sources.get(ref)?.result.historyKeys ?? []))].slice(0, 20);
  }

  /** Resolve a result using its registered source, never a renderer-supplied URL. */
  async resolveSource(refs: string[]): Promise<{ sourceType: 'magnet' | 'torrent_file'; sourceUri: string }> {
    if (!Array.isArray(refs) || !refs.length || refs.length > 20 || refs.some(r => typeof r !== 'string')) throw new Error('Invalid search source');
    const providers = await db.getSearchProviders();
    let lastError: unknown = new Error('Search result expired; search again');
    const deadline = Date.now() + HTTP_MIRROR_BUDGET_MS;
    for (const ref of refs) {
      if (Date.now() >= deadline) throw new ProviderNetworkError('timeout');
      const item = this.sources.get(ref);
      if (!item) continue;
      const provider = providers.find(p => p.id === item.provider.id);
      if (!provider) continue;
      if (item.result.magnetUri?.startsWith('magnet:')) return { sourceType: 'magnet', sourceUri: item.result.magnetUri };
      const url = item.result.torrentUrl;
      if (!url) continue;
      try {
        const route = getProviderRoute(provider.id);
        const parseTorrent = createRequire(__filename)('parse-torrent') as (buffer: Buffer) => { infoHash?: string };
        const validate = (bytes: Buffer) => {
          try {
            const hash = parseTorrent(bytes).infoHash;
            if (!hash || (item.result.infoHash && /^[a-f\d]{40}$/i.test(item.result.infoHash) && hash.toLowerCase() !== item.result.infoHash.toLowerCase())) throw new Error();
            return bytes;
          } catch { throw new Error('Invalid torrent metadata'); }
        };
        let body: Buffer;
        if (route && provider.type !== 'script') {
          body = await readHttpMirrors(provider, url, response => validate(response.body), {
            maxBytes: 8 * 1024 * 1024, timeoutMs: deadline - Date.now(),
          }, item.mirrorBase);
        } else if (route) {
          const origins = [...route.origins];
          body = validate((await providerNetwork.request(provider.id, route.connection, url, { allowedOrigins: origins, maxBytes: 8 * 1024 * 1024, timeoutMs: deadline - Date.now() })).body);
        } else {
          body = validate((await httpFetch(url, { maxBytes: 8 * 1024 * 1024, timeoutMs: deadline - Date.now(), what: 'torrent metadata' })).body);
        }
        const dir = path.join(app.getPath('temp'), 'havvn-search-torrents');
        await fs.promises.mkdir(dir, { recursive: true });
        const file = path.join(dir, randomUUID() + '.torrent');
        await fs.promises.writeFile(file, body);
        return { sourceType: 'torrent_file', sourceUri: file };
      } catch (error) { lastError = error instanceof ProviderNetworkError ? error : new Error('Could not retrieve torrent metadata'); }
    }
    throw lastError;
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

  private bindHttpResults(provider: SearchProvider, results: SearchResult[], base: string, responseUrl: string): SearchResult[] {
    const primary = httpProviderBase(provider as HttpProviderAddress);
    for (const result of results) {
      result.torrentUrl = httpResultUrl(result.torrentUrl, responseUrl, primary, base);
      result.detailsUrl = httpResultUrl(result.detailsUrl, responseUrl, primary, base);
      this.resultBases.set(result, base);
    }
    return results;
  }

  /** Validate before remembering a mirror; legacy sources retain their client. */
  private async readHTTP<T>(provider: SearchProvider, url: string,
    read: (text: string, base: string, responseUrl: string) => T, signal?: AbortSignal,
    extraHeaders: Record<string, string> = {}): Promise<T> {
    const primary = httpProviderBase(provider as HttpProviderAddress);
    const parse = (text: string, base: string, responseUrl: string) => {
      try { return read(text, base, responseUrl); }
      catch (error) { throw error instanceof ProviderNetworkError ? error : new ProviderNetworkError('invalid-response'); }
    };
    const options = {
      headers: { 'User-Agent': 'Havvn/' + app.getVersion() + ' Search', ...extraHeaders },
      signal, timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES,
    };
    const route = getProviderRoute(provider.id);
    if (route) {
      return readHttpMirrors(provider, url, (response, base) => parse(response.text(), base ?? primary,
        response.url ?? rebaseProviderUrl(url, primary, base ?? primary) ?? url), options);
    }
    return parse(await httpFetchText(url, { ...options, what: 'search provider' }), primary, url);
  }
}

let searchService: SearchService | null = null;

export function getSearchService(): SearchService {
  if (!searchService) {
    searchService = new SearchService();
  }
  return searchService;
}
