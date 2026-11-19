import { expect, it } from 'vitest';
import { formatTorrentBytes, TORRENT_PIECE_SIZES } from './create-torrent-labels';

it('localizes labels without changing numeric torrent piece sizes', () => {
  expect(TORRENT_PIECE_SIZES).toEqual([0, 16384, 32768, 65536, 131072, 262144, 524288, 1048576, 2097152, 4194304, 8388608, 16777216]);
  expect(formatTorrentBytes(16384, 'ru')).toBe('16 КиБ');
  expect(formatTorrentBytes(16384, 'en')).toBe('16 KiB');
  expect(formatTorrentBytes(1536, 'ru')).toBe('1,5 КиБ');
  expect(formatTorrentBytes(0, 'ru')).toBe('0 Б');
  expect(formatTorrentBytes(.5, 'en')).toBe('0.5 B');
  for (const invalid of [-1, Infinity, NaN]) expect(formatTorrentBytes(invalid, 'ru')).toBe('—');
});
