import { classifyMediaKind } from './media';
import { watchKey, resumablePosition, type WatchEntry, type WatchTarget } from './watch-history';
import type { Download } from './types';
import type { HistoryPlaybackFile } from './history-playback';

export const MEDIA_LIBRARY_LIMIT = 500;
export const MEDIA_LIBRARY_SOURCE_LIMIT = 50;
export const MEDIA_LIBRARY_BYTES = 1024 * 1024;
export const MEDIA_LIBRARY_KINDS = ['unknown', 'movie', 'series', 'audio'] as const;
export type MediaLibraryKind = typeof MEDIA_LIBRARY_KINDS[number];
export type MediaLibraryView = 'continue' | 'all' | 'watching' | 'completed';
export interface MediaClassification { kind: MediaLibraryKind; title: string; season?: number; episode?: number }
export interface MediaLibraryItem extends WatchTarget {
  length: number;
  firstSeen: number;
  lastSeen: number;
  inferred: MediaClassification;
  manual?: MediaClassification;
}
export interface MediaLibrarySource { download: Download; files: HistoryPlaybackFile[]; truncated: boolean; checkedAt?: number }
export type MediaAvailability = 'ready' | 'downloading' | 'stopped' | 'missing' | 'unverified';

export const libraryKey = (item: Pick<WatchTarget, 'identity' | 'path'>) => watchKey(item);
const name = (text: string) => text.replace(/[._]+/g, ' ').trim().slice(0, 160);
export function inferMediaClassification(filePath: string, downloadTitle: string): MediaClassification {
  const parts = filePath.replace(/\\/g, '/').split('/'), basename = parts.pop() || filePath;
  const title = name(basename.replace(/\.[^.]+$/, '')) || name(downloadTitle) || basename.slice(0, 160);
  if (classifyMediaKind(basename) === 'audio') return { kind: 'audio', title };
  const markers = [...title.matchAll(/(?:^|\s|-)S(\d{1,2})\s*E(\d{1,3})(?=$|[^\d])/gi)];
  const marker = markers[0];
  // Ranges, lists and multi-episode files require a deliberate classification.
  if (markers.length !== 1 || !marker || Number(marker[2]) < 1 || /^(?:\s*[-–]\s*(?:E?\d)|\s*E\d)/i.test(title.slice(marker.index! + marker[0].length))) return { kind: 'unknown', title };
  const series = name(title.slice(0, marker.index).replace(/[-\s]+$/, '')) || name(parts[parts.length - 1] || downloadTitle);
  return series ? { kind: 'series', title: series, season: Number(marker[1]), episode: Number(marker[2]) } : { kind: 'unknown', title };
}
export function normalizeMediaClassification(value: unknown): MediaClassification | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as MediaClassification;
  if (!MEDIA_LIBRARY_KINDS.includes(v.kind) || typeof v.title !== 'string' || !v.title.trim() || v.title.length > 160) return null;
  if (v.season !== undefined && (!Number.isInteger(v.season) || v.season < 0 || v.season > 99) ||
      v.episode !== undefined && (!Number.isInteger(v.episode) || v.episode < 1 || v.episode > 9999)) return null;
  return { kind: v.kind, title: v.title.trim(), ...(v.kind === 'series' && v.season !== undefined ? { season: v.season } : {}), ...(v.kind === 'series' && v.episode !== undefined ? { episode: v.episode } : {}) };
}
export function normalizeMediaLibraryItem(value: unknown): MediaLibraryItem | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as MediaLibraryItem;
  if (![v.identity, v.downloadId, v.title, v.path].every(s => typeof s === 'string' && s.length > 0 && s.length <= 4096) ||
      !Number.isSafeInteger(v.fileIndex) || v.fileIndex < 0 || !Number.isSafeInteger(v.length) || v.length < 0 ||
      ![v.firstSeen, v.lastSeen].every(n => Number.isFinite(n) && n >= 0 && n <= 8.64e15)) return null;
  const inferred = normalizeMediaClassification(v.inferred), manual = v.manual === undefined ? undefined : normalizeMediaClassification(v.manual);
  if (!inferred || manual === null) return null;
  return { identity: v.identity, downloadId: v.downloadId, title: v.title, path: v.path.replace(/\\/g, '/'), fileIndex: v.fileIndex,
    length: v.length, firstSeen: v.firstSeen, lastSeen: v.lastSeen, inferred, ...(manual ? { manual } : {}) };
}
export function libraryItemFromWatch(entry: WatchEntry): MediaLibraryItem {
  return { identity: entry.identity, downloadId: entry.downloadId, title: entry.title, path: entry.path, fileIndex: entry.fileIndex,
    length: 0, firstSeen: entry.lastOpened, lastSeen: entry.updatedAt, inferred: inferMediaClassification(entry.path, entry.title) };
}
export function mergeMediaLibrary(previous: MediaLibraryItem[], sources: MediaLibrarySource[], history: WatchEntry[], now = Date.now()): MediaLibraryItem[] {
  const items = new Map(previous.map(item => [libraryKey(item), item]));
  for (const entry of history) if (!items.has(libraryKey(entry))) items.set(libraryKey(entry), libraryItemFromWatch(entry));
  for (const { download, files } of sources) for (const file of files) {
    if (classifyMediaKind(file.name) === 'other') continue;
    const target = { identity: download.infoHash || download.id, downloadId: download.id, title: download.name, path: (file.path || file.name).replace(/\\/g, '/'), fileIndex: file.index ?? 0 };
    const key = libraryKey(target), old = items.get(key);
    const changed = !old || old.downloadId !== target.downloadId || old.title !== target.title || old.fileIndex !== target.fileIndex || old.length !== file.length;
    const item = normalizeMediaLibraryItem({ ...target, length: file.length, firstSeen: old?.firstSeen ?? now, lastSeen: changed ? now : old.lastSeen,
      inferred: inferMediaClassification(target.path, target.title), ...(old?.manual ? { manual: old.manual } : {}) });
    if (item) items.set(key, item);
  }
  const positions = new Map(history.map(entry => [libraryKey(entry), entry.lastOpened]));
  return [...items.values()].sort((a, b) => Number(!!b.manual) - Number(!!a.manual) || (positions.get(libraryKey(b)) ?? 0) - (positions.get(libraryKey(a)) ?? 0) || b.lastSeen - a.lastSeen || libraryKey(a).localeCompare(libraryKey(b))).slice(0, MEDIA_LIBRARY_LIMIT);
}
export function inLibraryView(entry: WatchEntry | undefined, view: MediaLibraryView): boolean {
  return view === 'all' || view === 'completed' ? view === 'all' || entry?.completed === true
    : view === 'watching' ? !!entry && !entry.completed : resumablePosition(entry) > 0;
}
export function libraryAvailability(item: MediaLibraryItem, downloads: Download[], sources: MediaLibrarySource[]) {
  const download = downloads.find(d => d.status !== 'removed' && (d.infoHash || d.id) === item.identity);
  if (!download) return { state: 'missing' as MediaAvailability, playable: false };
  const source = sources.find(s => s.download.id === download.id && (s.download.infoHash || s.download.id) === item.identity && s.download.savePath === download.savePath && s.download.status === download.status);
  const file = source?.files.find(f => (f.path || f.name).replace(/\\/g, '/') === item.path);
  if (!source || source.checkedAt !== undefined && Date.now() - source.checkedAt > 20000 || !file && (!source.files.length || source.truncated)) return { state: 'unverified' as MediaAvailability, playable: false, download };
  const playable = file?.availability === 'local' || file?.availability === 'stream';
  const state: MediaAvailability = file?.availability === 'local' ? 'ready' : file?.availability === 'stream' ? 'downloading'
    : file?.availability === 'paused' || file && file.downloaded < file.length && ['paused', 'error'].includes(download.status) ? 'stopped'
    : file && file.downloaded < file.length && ['downloading', 'queued', 'seeding'].includes(download.status) ? 'downloading' : 'missing';
  return { state, playable, download, file };
}
export function groupMediaLibrary(items: MediaLibraryItem[]) {
  const groups = new Map<string, { key: string; classification: MediaClassification | null; items: MediaLibraryItem[] }>();
  for (const item of items) {
    const c = item.manual ?? item.inferred;
    const key = c.kind === 'series' ? JSON.stringify(['series', item.identity, c.title.toLowerCase(), c.season ?? null]) : 'ungrouped';
    const group = groups.get(key) ?? { key, classification: c.kind === 'series' ? c : null, items: [] };
    group.items.push(item); groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group, items: !group.classification ? group.items : group.items.sort((a, b) => {
    const ac = a.manual ?? a.inferred, bc = b.manual ?? b.inferred;
    return (ac.episode ?? Infinity) - (bc.episode ?? Infinity) || a.path.localeCompare(b.path, undefined, { numeric: true });
  }) }));
}
