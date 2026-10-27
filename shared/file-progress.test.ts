import { describe, expect, it } from 'vitest';
import { fileProgress } from './file-progress';

describe('file byte progress contract', () => {
  it.each([-1465635, -1, NaN, Infinity, -Infinity, undefined])('rejects invalid downloaded bytes %s', downloaded => {
    expect(fileProgress(61, downloaded as number)).toEqual({ length: 61, downloaded: 0, progress: 0 });
  });
  it('bounds bytes by the file length and derives the matching ratio', () => {
    expect(fileProgress(61, 30)).toEqual({ length: 61, downloaded: 30, progress: 30 / 61 });
    expect(fileProgress(61, 9000)).toEqual({ length: 61, downloaded: 61, progress: 1 });
  });
  it('distinguishes an empty file from missing metadata', () => {
    expect(fileProgress(0, 0).progress).toBe(1);
    for (const length of [-1, NaN, Infinity, 0.5]) expect(fileProgress(length, 100)).toEqual({ length: 0, downloaded: 0, progress: 0 });
  });
});
