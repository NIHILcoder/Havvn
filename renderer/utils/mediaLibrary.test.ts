import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MEDIA_LIBRARY_KEY, readMediaLibrary, rememberMediaLibrary, classifyLibraryItem, scanMediaLibrary, subscribeMediaLibrary } from './mediaLibrary';
import { libraryKey, mergeMediaLibrary, MEDIA_LIBRARY_LIMIT } from '../../shared/media-library';
import type { MediaLibrarySource } from '../../shared/media-library';
import type { Download } from '../../shared/types';
import type { WatchEntry } from '../../shared/watch-history';
import { watchEntries, beginWatch, saveWatch, clearWatchHistory } from './watchHistory';
let storage: Map<string, string>;
const download = { id: 'one', infoHash: 'hash', name: 'Show', status: 'paused' } as Download;
const sources: MediaLibrarySource[] = [{ download, files: [{ name: 'S01E01.mp4', path: 'Show/S01E01.mp4', index: 0, length: 100, downloaded: 100, progress: 1, availability: 'local' }], truncated: false }];
beforeEach(() => { storage = new Map(); vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }); });
afterEach(() => vi.unstubAllGlobals());
it('persists classification independently from playback, including a restart, history clear and re-add', () => {
  const watch = { identity: 'hash', downloadId: 'one', title: 'Show', path: sources[0].files[0].path, fileIndex: 0, position: 22, duration: 100, lastOpened: 1, updatedAt: 1, completed: false } as WatchEntry;
  saveWatch(watch, beginWatch(watch.identity, watch.path)); expect(rememberMediaLibrary(sources, watchEntries())).toBe(true);
  const item = readMediaLibrary().items[0]; expect(classifyLibraryItem(item, { kind: 'series', title: 'Corrected', season: 2, episode: 3 })).toBe(true);
  expect(watchEntries()[0].position).toBe(22);
  expect(readMediaLibrary().items[0].manual?.title).toBe('Corrected');
  clearWatchHistory(); rememberMediaLibrary([], watchEntries()); rememberMediaLibrary([{ ...sources[0], download: { ...download, id: 'new' } }], []);
  expect(readMediaLibrary().items[0].manual?.title).toBe('Corrected'); expect(watchEntries()).toEqual([]);
});
it('bounds the index and prioritizes manual corrections when new media arrive', () => {
  const files = Array.from({ length: 600 }, (_, index) => ({ ...sources[0].files[0], path: 'Show/' + index + '.mp4', index }));
  expect(rememberMediaLibrary([{ download, files, truncated: true }], [])).toBe(true); expect(readMediaLibrary().items).toHaveLength(MEDIA_LIBRARY_LIMIT);
  const item = readMediaLibrary().items[0]; classifyLibraryItem(item, { kind: 'movie', title: 'Keep' });
  rememberMediaLibrary([{ download, files: files.map(file => ({ ...file, path: 'New/' + file.path })), truncated: true }], []);
  expect(readMediaLibrary().items.some(i => libraryKey(i) === libraryKey(item) && i.manual?.title === 'Keep')).toBe(true);
});
it('never overwrites corrupt, future or unavailable storage with an empty index', () => {
  for (const value of ['broken', JSON.stringify({ version: 99, items: [] })]) {
    storage.set(MEDIA_LIBRARY_KEY, value); expect(readMediaLibrary().failed).toBe(true); expect(rememberMediaLibrary(sources, [])).toBe(false); expect(storage.get(MEDIA_LIBRARY_KEY)).toBe(value);
  }
  storage.clear(); expect(rememberMediaLibrary(sources, [])).toBe(true); const previous = storage.get(MEDIA_LIBRARY_KEY);
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: () => { throw Error('quota'); } });
  expect(classifyLibraryItem(readMediaLibrary().items[0], { kind: 'movie', title: 'New' })).toBe(false); expect(storage.get(MEDIA_LIBRARY_KEY)).toBe(previous);
});
it('broadcasts metadata changes and cleans up subscriptions', () => {
  const changed = vi.fn(), off = subscribeMediaLibrary(changed); rememberMediaLibrary(sources, []); expect(changed).toHaveBeenCalledOnce(); off();
  classifyLibraryItem(readMediaLibrary().items[0], null); expect(changed).toHaveBeenCalledOnce();
});
it('does not rewrite an unchanged index on every availability refresh', () => {
  const write = vi.fn((key: string, value: string) => storage.set(key, value));
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: write });
  rememberMediaLibrary(sources, [], 1); rememberMediaLibrary(sources, [], 200);
  expect(write).toHaveBeenCalledOnce();
});
it('limits scan concurrency, source count and retained files without activating downloads', async () => {
  let active = 0, peak = 0;
  const api = vi.fn(async () => { peak = Math.max(peak, ++active); await Promise.resolve(); active--; return { files: [], truncated: false }; });
  const downloads = Array.from({ length: 90 }, (_, i) => ({ ...download, id: String(i) }));
  const scan = await scanMediaLibrary(downloads, [], api); expect(peak).toBeLessThanOrEqual(3); expect(api).toHaveBeenCalledTimes(50); expect(scan.limited).toBe(true);
  const many = vi.fn(async () => ({ files: Array.from({ length: 500 }, () => sources[0].files[0]), truncated: true }));
  const full = await scanMediaLibrary(downloads, [], many); expect(full.sources.flatMap(s => s.files)).toHaveLength(500); expect(many.mock.calls.length).toBeLessThanOrEqual(3);
});
it('does not continue a canceled scan or lose a manual edit made while metadata was loading', async () => {
  expect((await scanMediaLibrary([download], [], async () => { throw Error('Must not call'); }, 0, () => true)).sources).toEqual([]);
  rememberMediaLibrary(sources, []); const original = readMediaLibrary().items[0];
  const scan = await scanMediaLibrary([download], [], async () => { classifyLibraryItem(original, { kind: 'movie', title: 'Edit during scan' }); return { files: sources[0].files, truncated: false }; });
  rememberMediaLibrary(scan.sources, []); expect(readMediaLibrary().items[0].manual?.title).toBe('Edit during scan');
  expect(mergeMediaLibrary([], scan.sources, [])).toHaveLength(1);
});
