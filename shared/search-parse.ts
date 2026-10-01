/**
 * Search-script output sanitizer.
 *
 * This is the trust boundary between a user-provided search script (whose stdout
 * is fully untrusted) and the Havvn UI. It lives in `shared/` with no
 * Electron / Node imports so it can be unit-tested in isolation.
 */

import { SearchResult } from './types';
import { sanitizeReleaseMedia } from './release-languages';

/** Upper bound on rows accepted from a single script run. */
export const SCRIPT_MAX_RESULTS = 500;

/** Coerce to a trimmed, length-capped string (UI safety). */
export function sanitizeString(v: unknown): string {
  if (v == null) return '';
  const s = String(v).trim();
  return s.length > 2000 ? s.slice(0, 2000) : s;
}

/** Coerce to a non-negative finite integer; anything else becomes 0. */
export function sanitizeCount(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** A script result's links flow into the downloader, so only allow safe schemes. */
function asMagnet(v: unknown): string {
  const s = sanitizeString(v);
  return /^magnet:/i.test(s) ? s : '';
}
function asHttpUrl(v: unknown): string {
  const s = sanitizeString(v);
  return /^https?:\/\//i.test(s) ? s : '';
}

/**
 * Parse a search script's stdout into trusted SearchResult rows.
 *
 * Accepts either a bare JSON array or a `{ results: [...] }` wrapper. Throws on
 * non-JSON or non-array shapes so the caller can report a clear provider error.
 * Rows without a title, or with no way to fetch the torrent (no magnet, torrent
 * URL, or info hash), are dropped.
 */
export function parseScriptOutput(stdout: string, providerName: string): SearchResult[] {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('Script did not return valid JSON');
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.results)
    ? (parsed as any).results
    : null;
  if (!rows) throw new Error('Script output must be a JSON array of results');

  const out: SearchResult[] = [];
  for (const raw of rows.slice(0, SCRIPT_MAX_RESULTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const title = sanitizeString(r.title);
    let magnetUri = asMagnet(r.magnetUri ?? r.magnet);
    let torrentUrl = asHttpUrl(r.torrentUrl ?? r.url);
    // `link` is ambiguous (qBittorrent-style plugins use it for either) — route
    // it by scheme so a magnet in `link` still works and bad schemes are dropped.
    const link = sanitizeString(r.link);
    if (!magnetUri && /^magnet:/i.test(link)) magnetUri = link;
    if (!torrentUrl && /^https?:\/\//i.test(link)) torrentUrl = link;
    const infoHash = sanitizeString(r.infoHash ?? r.hash);
    // A row is useless without a title and at least one way to fetch it.
    if (!title || (!magnetUri && !torrentUrl && !infoHash)) continue;

    out.push({
      title,
      magnetUri: magnetUri || undefined,
      torrentUrl: torrentUrl || undefined,
      size: sanitizeCount(r.size),
      seeds: sanitizeCount(r.seeds ?? r.seeders),
      leechers: sanitizeCount(r.leechers ?? r.peers),
      provider: providerName,
      publishDate: sanitizeString(r.publishDate ?? r.date) || undefined,
      category: sanitizeString(r.category) || undefined,
      infoHash: infoHash || undefined,
      media: sanitizeReleaseMedia(r.media),
    });
  }
  return out;
}
