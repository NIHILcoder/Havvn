import { MEDIA_LIBRARY_BYTES, MEDIA_LIBRARY_LIMIT, MEDIA_LIBRARY_SOURCE_LIMIT, libraryKey, mergeMediaLibrary, normalizeMediaLibraryItem, normalizeMediaClassification,
  type MediaLibraryItem, type MediaLibrarySource, type MediaClassification } from '../../shared/media-library';
import type { Download } from '../../shared/types';
import type { WatchEntry } from '../../shared/watch-history';
import type { HistoryLibraryFiles } from '../../shared/history-playback';

export const MEDIA_LIBRARY_KEY = 'havvn.mediaLibrary.v1';
const EVENT = 'havvn:mediaLibrary';
export function readMediaLibrary(): { items: MediaLibraryItem[]; failed: boolean } {
  try {
    const text = localStorage.getItem(MEDIA_LIBRARY_KEY); if (!text) return { items: [], failed: false };
    if (text.length * 2 > MEDIA_LIBRARY_BYTES) throw Error('Index limit');
    const raw = JSON.parse(text);
    if (raw.version !== 1 || !Array.isArray(raw.items) || raw.items.length > MEDIA_LIBRARY_LIMIT) throw Error('Invalid index');
    const items = raw.items.map(normalizeMediaLibraryItem);
    if (items.some((item: MediaLibraryItem | null) => !item) || new Set(items.map(libraryKey)).size !== items.length) throw Error('Invalid item');
    return { items, failed: false };
  } catch { return { items: [], failed: true }; }
}
function write(items: MediaLibraryItem[]): boolean {
  if (readMediaLibrary().failed) return false;
  const text = JSON.stringify({ version: 1, items });
  if (items.length > MEDIA_LIBRARY_LIMIT || text.length * 2 > MEDIA_LIBRARY_BYTES) return false;
  try { if (localStorage.getItem(MEDIA_LIBRARY_KEY) !== text) { localStorage.setItem(MEDIA_LIBRARY_KEY, text); window.dispatchEvent(new Event(EVENT)); } return true; } catch { return false; }
}
export function rememberMediaLibrary(sources: MediaLibrarySource[], history: WatchEntry[], now = Date.now()): boolean {
  const current = readMediaLibrary(); if (current.failed) return false;
  return write(mergeMediaLibrary(current.items, sources, history, now));
}
export function classifyLibraryItem(item: MediaLibraryItem, manual: MediaClassification | null): boolean {
  const current = readMediaLibrary(); if (current.failed) return false;
  const value = manual === null ? null : normalizeMediaClassification(manual); if (manual !== null && !value) return false;
  if (!current.items.some(i => libraryKey(i) === libraryKey(item)) && current.items.length >= MEDIA_LIBRARY_LIMIT && current.items.every(i => !!i.manual)) return false;
  const items = current.items.filter(i => libraryKey(i) !== libraryKey(item));
  const updated = { ...item }; delete updated.manual; if (value) updated.manual = value;
  items.unshift(updated); return write(items.slice(0, MEDIA_LIBRARY_LIMIT));
}
export function subscribeMediaLibrary(fn: () => void) {
  const storage = (event: StorageEvent) => { if (!event.key || event.key === MEDIA_LIBRARY_KEY) fn(); };
  window.addEventListener(EVENT, fn); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(EVENT, fn); window.removeEventListener('storage', storage); };
}
/** At most three read-only requests at once; no directory walk or download activation. */
export async function scanMediaLibrary(downloads: Download[], history: WatchEntry[], filesFor: (id: string, limit: number) => Promise<HistoryLibraryFiles>, offset = 0, canceled = () => false) {
  const watched = new Set(history.map(entry => entry.identity));
  const candidates = downloads.filter(d => d.status !== 'removed').sort((a, b) => Number(watched.has(b.infoHash || b.id)) - Number(watched.has(a.infoHash || a.id)) || String(a.id).localeCompare(b.id));
  const selected = candidates.slice(offset, offset + MEDIA_LIBRARY_SOURCE_LIMIT), sources: MediaLibrarySource[] = [];
  let cursor = 0, found = 0, failures = 0, truncated = false;
  await Promise.all(Array.from({ length: Math.min(3, selected.length) }, async () => {
    while (cursor < selected.length && found < MEDIA_LIBRARY_LIMIT && !canceled()) {
      const download = selected[cursor++];
      try {
        const page = await filesFor(download.id, MEDIA_LIBRARY_LIMIT);
        const remaining = MEDIA_LIBRARY_LIMIT - found;
        const files = page.files.slice(0, remaining); found += files.length;
        truncated ||= page.truncated || files.length !== page.files.length;
        sources.push({ download, files, truncated: page.truncated || files.length !== page.files.length, checkedAt: Date.now() });
      } catch { failures++; }
    }
  }));
  return { sources, failures, limited: truncated || cursor < selected.length || offset + selected.length < candidates.length, nextOffset: offset + cursor, totalSources: candidates.length };
}
