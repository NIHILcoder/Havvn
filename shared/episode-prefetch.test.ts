import { expect, it } from 'vitest';
import { prefetchPieceRange, shouldPrefetchEpisode, validateEpisodePrefetch, PREFETCH_MAX_BYTES } from './episode-prefetch';

it('bounds the selected pieces even when a file begins inside a piece', () => {
  expect(prefetchPieceRange(100, 10000, 1024, 2048)).toEqual({ start: 0, end: 1, bytes: 2048 });
  expect(prefetchPieceRange(4096, 500, 1024, 10000)).toEqual({ start: 4, end: 4, bytes: 1024 });
  expect(prefetchPieceRange(0, 10000, 1024, 512)).toBeNull();
  expect(prefetchPieceRange(0, 1000000000, 1024, 1000000000)?.bytes).toBe(PREFETCH_MAX_BYTES);
});
it('requires the final three minutes with enough buffer and active playback', () => {
  const eligible = { enabled: true, paused: false, seeking: false, readyState: 4, time: 900, duration: 1000, bufferSeconds: 30 };
  expect(shouldPrefetchEpisode(eligible)).toBe(true);
  for (const override of [{ enabled: false }, { paused: true }, { seeking: true }, { readyState: 2 }, { bufferSeconds: 19 }, { duration: Infinity }, { time: 500 }, { time: 1000 }]) {
    expect(shouldPrefetchEpisode({ ...eligible, ...override })).toBe(false);
  }
});
it('rejects excessive budgets, invalid file indexes and invalid leases', () => {
  const request = { currentFile: 0, nextFile: 1, budgetBytes: 1024, allowExcluded: false, lease: 'test-lease' };
  expect(() => validateEpisodePrefetch(request)).not.toThrow();
  for (const override of [{ nextFile: 0 }, { budgetBytes: PREFETCH_MAX_BYTES + 1 }, { currentFile: -1 }, { budgetBytes: NaN }, { lease: 'bad' }]) {
    expect(() => validateEpisodePrefetch({ ...request, ...override })).toThrow();
  }
});
