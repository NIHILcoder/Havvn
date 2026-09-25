import { afterEach, expect, it, vi } from 'vitest';
import { EpisodePrefetcher, type PrefetchTorrent } from './episode-prefetch';

afterEach(() => vi.useRealTimers());
function fixture() {
  const normal = { from: 0, to: 100, priority: 0 };
  const current = { from: 0, to: 3, priority: 1, isStreamSelection: true };
  const items = [normal, current];
  const torrent = { pieceLength: 1024, bitfield: { get: vi.fn(() => false) }, _selections: { _items: items },
    _select: vi.fn((from, to, priority, notify, isStreamSelection) => items.push({ from, to, priority, notify, isStreamSelection })),
    _updateSelections: vi.fn() } as unknown as PrefetchTorrent;
  return { torrent, normal, current, prefetch: new EpisodePrefetcher() };
}
it('uses a bounded independent range below current playback priority', () => {
  const { prefetch, torrent, normal, current } = fixture();
  expect(prefetch.start('one', 'owner-1', torrent, 1, 4096, 100000, 2048)).toEqual({ state: 'active', bytes: 2048 });
  expect(torrent._select).toHaveBeenCalledWith(4, 5, 0.5, expect.any(Function), true);
  prefetch.cancel('one', 'owner-1');
  expect(torrent._selections._items).toEqual([normal, current]);
});
it('renews without duplicate selections and expires if the player disappears', () => {
  vi.useFakeTimers();
  const { prefetch, torrent } = fixture();
  prefetch.start('one', 'owner-1', torrent, 1, 4096, 100000, 2048);
  vi.advanceTimersByTime(4000);
  prefetch.start('one', 'owner-1', torrent, 1, 4096, 100000, 2048);
  expect(torrent._select).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(4999);
  expect(torrent._selections._items.length).toBe(3);
  vi.advanceTimersByTime(1);
  expect(torrent._selections._items.length).toBe(2);
});
it('does not let cleanup from an older player cancel a replacement lease', () => {
  const { prefetch, torrent } = fixture();
  prefetch.start('one', 'owner-1', torrent, 1, 4096, 100000, 2048);
  prefetch.start('one', 'owner-2', torrent, 2, 8192, 100000, 2048);
  prefetch.cancel('one', 'owner-1');
  expect(torrent._selections._items.length).toBe(3);
  prefetch.clear();
  expect(torrent._selections._items.length).toBe(2);
});
it('does not select already present pieces', () => {
  const { prefetch, torrent } = fixture();
  vi.mocked(torrent.bitfield.get).mockReturnValue(true);
  expect(prefetch.start('one', 'owner-1', torrent, 1, 4096, 100000, 2048).state).toBe('ready');
  expect(torrent._select).not.toHaveBeenCalled();
});
