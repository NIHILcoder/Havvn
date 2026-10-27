import { expect, it } from 'vitest';
import { calculateTorrentPieceLength, mergeTorrentSources, parseTorrentUrls, torrentSelectionStats } from './torrent-creation';

it('keeps the auto piece policy bounded and uses larger pieces for large sources', () => {
  const sizes = [0, 1, 64 * 1024 ** 2, 65 * 1024 ** 2, 1024 ** 3, 17 * 1024 ** 3, 513 * 1024 ** 3];
  const pieces = sizes.map(calculateTorrentPieceLength);
  expect(pieces[0]).toBe(16384); expect(pieces.at(-1)).toBe(16 * 1024 ** 2);
  expect(pieces.every((size, i) => size >= 16384 && !(size & (size - 1)) && (!i || size >= pieces[i - 1]))).toBe(true);
});

it('excludes all descendants from preview size and count when a directory is excluded', () => {
  const result = torrentSelectionStats([{ path: 'folder', isDirectory: true, size: 9999, children: [
    { path: 'folder/a', size: 100, isDirectory: false },
    { path: 'folder/nested', size: 400, isDirectory: true, children: [{ path: 'folder/nested/b', size: 300, isDirectory: false }] },
  ] }, { path: 'keep', size: 50, isDirectory: false }], new Set(['folder']));
  expect(result).toEqual({ total: 3, excluded: 2, totalSize: 450, excludedSize: 400 });
});

it('deduplicates Windows paths and collapses dropped children without matching a similar sibling prefix', () => {
  expect(mergeTorrentSources(['D:\\Media\\Movies\\one.mkv'], ['d:/media/movies/', 'D:/Media/Movies-other/two.mkv', 'D:/MEDIA/MOVIES/three.mkv']))
    .toEqual(['d:/media/movies/', 'D:/Media/Movies-other/two.mkv']);
  expect(mergeTorrentSources(['/source/A', '/source/a'], ['/source/A/file'])).toEqual(['/source/A', '/source/a']);
});

it('preserves tracker tiers while identifying duplicates and invalid line numbers', () => {
  const result = parseTorrentUrls('http://tracker.invalid/announce\nhttp://tracker.invalid/announce\n\nudp://tracker.invalid:1234\nfile:///bad\nnot a URL\n\nwss://tracker.invalid', 'tracker');
  expect(result.groups).toEqual([['http://tracker.invalid/announce'], ['udp://tracker.invalid:1234'], ['wss://tracker.invalid']]);
  expect(result.duplicates).toBe(1); expect(result.invalidLines).toEqual([5, 6]);
});

it('accepts only HTTP(S) web seeds and leaves an empty tracker list empty', () => {
  const result = parseTorrentUrls('https://seed.invalid/content\nhttp://seed.invalid/file\nudp://tracker.invalid:1234\nmagnet:?xt=test', 'webSeed');
  expect(result.urls).toEqual(['https://seed.invalid/content', 'http://seed.invalid/file']); expect(result.invalidLines).toEqual([3, 4]);
  expect(parseTorrentUrls('\n\n', 'tracker')).toEqual({ groups: [], urls: [], invalidLines: [], duplicates: 0 });
});
