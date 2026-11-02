import { expect, it } from 'vitest';
import { resolveResourceMode, resourceFeatures, validResourceSnapshot, validateResourceMode } from './resource-mode';

it.each(['normal', 'economy', 'auto'] as const)('resolves %s across AC, battery and unknown power without inventing a power source', mode => {
  for (const power of ['ac', 'battery', 'unknown'] as const) {
    const state = resolveResourceMode(mode, power, 4);
    expect(state.power).toBe(power); expect(state.economy).toBe(mode === 'economy' || mode === 'auto' && power === 'battery');
    expect(state.source).toBe(mode === 'auto' ? power : 'manual'); expect(validResourceSnapshot(state)).toBe(true);
  }
});
it('rejects invalid choices and inconsistent or stale-shaped IPC snapshots', () => {
  for (const mode of [null, undefined, 'battery', {}, 1]) expect(() => validateResourceMode(mode)).toThrow();
  expect(validResourceSnapshot({ ...resolveResourceMode('auto', 'unknown'), economy: true })).toBe(false);
  expect(validResourceSnapshot({ ...resolveResourceMode('normal', 'ac'), revision: -1 })).toBe(false);
  expect(validResourceSnapshot({})).toBe(false);
});
it('recomputes restrictions from current preferences without saving temporary values', () => {
  const base = Object.freeze({ quality: 'full' as const, motion: true, prefetch: true });
  expect(resourceFeatures(base, true)).toEqual({ quality: 'light', motion: false, prefetch: false });
  expect(resourceFeatures(base, false)).toEqual(base);
  expect(resourceFeatures({ quality: 'light', motion: false, prefetch: false }, false)).toEqual({ quality: 'light', motion: false, prefetch: false });
});
