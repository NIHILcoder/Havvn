import { expect, it } from 'vitest';
import { inferMediaClassification, libraryAvailability, libraryKey, mergeMediaLibrary, groupMediaLibrary, inLibraryView, normalizeMediaClassification, normalizeMediaLibraryItem } from './media-library';
import type { MediaLibrarySource } from './media-library';
import type { Download } from './types';
import type { WatchEntry } from './watch-history';
const entry: WatchEntry = { identity: 'hash', downloadId: 'old', title: 'Show', path: 'Show/S01E02.mp4', fileIndex: 1, position: 33, duration: 900, lastOpened: 100, updatedAt: 101, completed: false };
const source = (): MediaLibrarySource => ({ download: { id: 'new', infoHash: 'hash', name: 'Renamed', savePath: 'D:/moved', status: 'paused' } as Download,
  files: [{ index: 1, path: entry.path, name: 'S01E02.mp4', length: 100, downloaded: 100, progress: 1, availability: 'local' }], truncated: false });
it('keeps the existing history identity across display rename, moved root, re-add and reordered indices', () => {
  const first = mergeMediaLibrary([], [source()], [entry]);
  const changed = source(); changed.download.name = 'Another title'; changed.download.id = 'third'; changed.files[0].index = 9;
  const next = mergeMediaLibrary(first, [changed], [entry]);
  expect(next).toHaveLength(1); expect(libraryKey(next[0])).toBe(libraryKey(entry)); expect(next[0]).toMatchObject({ downloadId: 'third', fileIndex: 9 });
  expect(entry.position).toBe(33);
});
it('never joins another torrent or a repeated basename from another season', () => {
  const a = source(), b = source(); b.download.infoHash = 'other';
  expect(mergeMediaLibrary([], [a, b], [entry])).toHaveLength(2);
  b.download.infoHash = 'hash'; b.files[0].path = 'OtherSeason/S01E02.mp4';
  expect(mergeMediaLibrary([], [a, b], [entry])).toHaveLength(2);
});
it('recognizes one explicit episode but leaves ranges and ambiguous filenames for manual correction', () => {
  expect(inferMediaClassification('Show.S02E03.1080p.mkv', 'Ignored')).toMatchObject({ kind: 'series', title: 'Show', season: 2, episode: 3 });
  expect(inferMediaClassification('Show/S01E01.mp4', 'Ignored')).toMatchObject({ kind: 'series', title: 'Show' });
  for (const path of ['Show.S01E01-E03.mkv', 'Show.S01E01E02.mkv', 'Show.S01E01.S01E02.mkv', 'Unknown.1080p.mkv']) expect(inferMediaClassification(path, 'Show').kind).toBe('unknown');
  expect(inferMediaClassification('Album/Song.flac', 'Album').kind).toBe('audio');
});
it('sorts episodes numerically within a known season and keeps distinct source groups separate', () => {
  const a = source(), b = source(); b.files[0].path = 'Show/S01E10.mp4'; b.files[0].name = 'S01E10.mp4';
  const items = mergeMediaLibrary([], [b, a], []), groups = groupMediaLibrary(items);
  expect(groups).toHaveLength(1); expect(groups[0].items.map(i => i.inferred.episode)).toEqual([2, 10]);
  items[1].identity = 'other'; expect(groupMediaLibrary(items)).toHaveLength(2);
});
it('retains manual metadata when refreshed after removal and re-add', () => {
  const first = mergeMediaLibrary([], [source()], [entry]); first[0].manual = { kind: 'series', title: 'My title', season: 4, episode: 7 };
  const missing = mergeMediaLibrary(first, [], [entry]);
  const restored = mergeMediaLibrary(missing, [source()], [entry]); expect(restored[0].manual).toEqual(first[0].manual);
});
it('has separate continue, watching, completed and all views without treating unwatched items as started', () => {
  expect(inLibraryView(undefined, 'all')).toBe(true); expect(inLibraryView(undefined, 'watching')).toBe(false);
  expect(inLibraryView({ ...entry, position: 0 }, 'watching')).toBe(true); expect(inLibraryView({ ...entry, position: 0 }, 'continue')).toBe(false);
  expect(inLibraryView(entry, 'continue')).toBe(true); expect(inLibraryView({ ...entry, completed: true }, 'completed')).toBe(true);
});
it('never persists positive availability across missing sources, failed metadata or expired observations', () => {
  const s = source(), item = mergeMediaLibrary([], [s], [entry])[0];
  expect(libraryAvailability(item, [s.download], [s])).toMatchObject({ state: 'ready', playable: true });
  expect(libraryAvailability(item, [], [s])).toMatchObject({ state: 'missing', playable: false });
  expect(libraryAvailability(item, [{ ...s.download, infoHash: 'wrong' }], [s]).playable).toBe(false);
  expect(libraryAvailability(item, [s.download], []).state).toBe('unverified');
  expect(libraryAvailability(item, [{ ...s.download, savePath: 'D:/another' }], [s]).state).toBe('unverified');
  s.checkedAt = 1; expect(libraryAvailability(item, [s.download], [s])).toMatchObject({ state: 'unverified', playable: false });
});
it('distinguishes active incomplete and stopped sources from a ready local file', () => {
  const s = source(), item = mergeMediaLibrary([], [s], [entry])[0];
  s.files[0].availability = 'paused'; s.files[0].downloaded = 20;
  expect(libraryAvailability(item, [s.download], [s])).toMatchObject({ state: 'stopped', playable: false });
  s.files[0].availability = 'missing';
  expect(libraryAvailability(item, [s.download], [s])).toMatchObject({ state: 'stopped', playable: false });
  s.files[0].availability = 'stream'; s.download.status = 'downloading';
  expect(libraryAvailability(item, [s.download], [s])).toMatchObject({ state: 'downloading', playable: true });
});
it('validates manual data and rejects corrupt records without carrying unrelated fields', () => {
  expect(normalizeMediaClassification({ kind: 'series', title: 'Show', season: -1 })).toBeNull();
  expect(normalizeMediaClassification({ kind: 'series', title: 'Show', episode: 0 })).toBeNull();
  const item = mergeMediaLibrary([], [source()], [entry])[0];
  expect(normalizeMediaLibraryItem({ ...item, length: NaN })).toBeNull();
  expect(normalizeMediaLibraryItem({ ...item, availability: 'ready' })).not.toHaveProperty('availability');
  expect(inferMediaClassification('.mp4', 'Hidden media').title).toBe('Hidden media');
  const invalid = source(); invalid.files[0].length = NaN;
  expect(mergeMediaLibrary([item], [invalid], [])).toEqual([item]);
});
