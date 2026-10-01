import type { Download, SearchResult } from './types';
import { downloadSearchState, searchResultHash, type SearchDownloadState } from './search-download-state';

export const SEARCH_DOWNLOAD_HISTORY_LIMIT = 1000;
export const SEARCH_SOURCE_KEYS_LIMIT = 20;
export interface SearchDownloadHistoryEntry {
  downloadId: string;
  infoHash?: string;
  name: string;
  totalSize: number;
  sourceKeys: string[];
  updatedAt: number;
  removedAt?: number;
}
export interface SearchDownloadHistoryData { version: 1; entries: SearchDownloadHistoryEntry[] }
export type SearchHistoryState = SearchDownloadState | 'removed';
/** For an uncertain match, describe the previous entry without claiming identity. */
export type SearchDownloadMatch = { state: SearchHistoryState }
  | { state: 'possible'; previousState: SearchHistoryState };

/** Keep the complete release name: stripping years/quality/episodes would merge editions. */
export function searchHistoryTitle(value: string): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function sanitizeSearchSourceKeys(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((key): key is string =>
    typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)))].slice(0, SEARCH_SOURCE_KEYS_LIMIT) : [];
}

/** Disk data is versioned, bounded and contains no download URLs or credentials. */
export function sanitizeSearchDownloadHistory(value: unknown): SearchDownloadHistoryData {
  const data = value as Partial<SearchDownloadHistoryData> | null;
  if (!data || data.version !== 1 || !Array.isArray(data.entries)) return { version: 1, entries: [] };
  const entries = new Map<string, SearchDownloadHistoryEntry>();
  for (const raw of data.entries.slice(0, SEARCH_DOWNLOAD_HISTORY_LIMIT * 2)) {
    if (!raw || typeof raw.downloadId !== 'string' || !raw.downloadId || raw.downloadId.length > 128 ||
        typeof raw.name !== 'string' || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0 ||
        (raw.removedAt !== undefined && (!Number.isFinite(raw.removedAt) || raw.removedAt < 0))) continue;
    const hash = typeof raw.infoHash === 'string' ? searchResultHash({ infoHash: raw.infoHash }) : null;
    const entry: SearchDownloadHistoryEntry = {
      downloadId: raw.downloadId, name: raw.name.slice(0, 2000),
      totalSize: Number.isFinite(raw.totalSize) && raw.totalSize > 0 ? raw.totalSize : 0,
      sourceKeys: sanitizeSearchSourceKeys(raw.sourceKeys), updatedAt: raw.updatedAt,
      ...(raw.removedAt !== undefined ? { removedAt: raw.removedAt } : {}),
      ...(hash ? { infoHash: hash } : {}),
    };
    const previous = entries.get(entry.downloadId);
    if (!previous || previous.updatedAt <= entry.updatedAt) entries.set(entry.downloadId, entry);
  }
  return { version: 1, entries: [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, SEARCH_DOWNLOAD_HISTORY_LIMIT) };
}

export function rememberSearchDownload(
  history: SearchDownloadHistoryData, download: Download, sourceKeys: string[] = [],
  removed = false, now = Date.now(),
): SearchDownloadHistoryData {
  const current = sanitizeSearchDownloadHistory(history);
  const old = current.entries.find(entry => entry.downloadId === download.id);
  const infoHash = searchResultHash({ infoHash: download.infoHash, magnetUri: download.sourceUri });
  const entry: SearchDownloadHistoryEntry = {
    downloadId: download.id, name: download.name, totalSize: download.totalSize,
    sourceKeys: sanitizeSearchSourceKeys([...sourceKeys, ...(old?.sourceKeys ?? [])]),
    updatedAt: now, ...(removed ? { removedAt: now } : {}),
    ...(infoHash ? { infoHash } : old?.infoHash ? { infoHash: old.infoHash } : {}),
  };
  return sanitizeSearchDownloadHistory({ version: 1, entries: [entry, ...current.entries.filter(item => item.downloadId !== download.id)] });
}

interface IndexedEntry { hash: string | null; name: string; size: number; state: SearchHistoryState; keys: string[] }
export interface SearchDownloadHistoryIndex {
  hashes: Map<string, SearchHistoryState>;
  sources: Map<string, IndexedEntry[]>;
  titles: Map<string, IndexedEntry[]>;
}
const statePriority = (state: SearchHistoryState) => state === 'downloaded' ? 3 : state === 'inDownloads' ? 2 : 1;

export function indexSearchDownloadHistory(downloads: Download[], history: SearchDownloadHistoryEntry[]): SearchDownloadHistoryIndex {
  const index: SearchDownloadHistoryIndex = { hashes: new Map(), sources: new Map(), titles: new Map() };
  const live = new Map(downloads.filter(download => download.status !== 'removed').map(download => [download.id, download]));
  const saved = sanitizeSearchDownloadHistory({ version: 1, entries: history }).entries;
  const savedById = new Map(saved.map(entry => [entry.downloadId, entry]));
  const add = (entry: IndexedEntry) => {
    if (entry.hash) {
      const oldState = index.hashes.get(entry.hash);
      if (!oldState || statePriority(entry.state) > statePriority(oldState)) index.hashes.set(entry.hash, entry.state);
    }
    for (const key of entry.keys) index.sources.set(key, [...(index.sources.get(key) ?? []), entry]);
    const title = searchHistoryTitle(entry.name);
    if (title.length >= 8 && entry.size > 0) index.titles.set(title, [...(index.titles.get(title) ?? []), entry]);
  };
  for (const download of live.values()) add({
    hash: searchResultHash({ infoHash: download.infoHash, magnetUri: download.sourceUri }),
    name: download.name, size: download.totalSize, state: downloadSearchState(download)!,
    keys: savedById.get(download.id)?.sourceKeys ?? [],
  });
  for (const entry of saved) {
    // A failed add/cleanup is not a removal, and a removed entry cannot override a live copy.
    if (live.has(entry.downloadId) || entry.removedAt === undefined) continue;
    add({ hash: entry.infoHash ?? null, name: entry.name, size: entry.totalSize, state: 'removed', keys: entry.sourceKeys });
  }
  return index;
}

export function matchSearchDownload(result: SearchResult, index: SearchDownloadHistoryIndex): SearchDownloadMatch | null {
  const hash = searchResultHash(result);
  if (hash) {
    const state = index.hashes.get(hash);
    // An explicit, different hash is a different torrent, regardless of shared title/URL.
    return state ? { state } : null;
  }
  const candidates = sanitizeSearchSourceKeys(result.historyKeys).flatMap(key => index.sources.get(key) ?? []);
  if (!candidates.length && result.size > 0) {
    for (const entry of index.titles.get(searchHistoryTitle(result.title)) ?? []) {
      if (Math.abs(entry.size - result.size) / Math.max(entry.size, result.size) <= 0.01) candidates.push(entry);
    }
  }
  const best = candidates.sort((a, b) => statePriority(b.state) - statePriority(a.state))[0];
  return best ? { state: 'possible', previousState: best.state } : null;
}
