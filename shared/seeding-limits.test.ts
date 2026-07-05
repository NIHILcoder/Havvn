import { describe, it, expect } from 'vitest';
import { shouldStopSeeding, SeedDefaults, SeedState } from './seeding-limits';

const NONE: SeedDefaults = { ratioLimit: 0, timeLimitMinutes: 0 };
const base = (o: Partial<SeedState> = {}): SeedState => ({ downloadedBytes: 1000, uploadedBytes: 0, ...o });
const T0 = 1_000_000_000_000;

describe('shouldStopSeeding', () => {
  it('keeps seeding when no limits are set', () => {
    expect(shouldStopSeeding(base({ uploadedBytes: 999999 }), NONE, T0)).toEqual({ stop: false, reason: null });
  });

  it('stops on the global ratio limit at the boundary (>=)', () => {
    const d = base({ downloadedBytes: 1000, uploadedBytes: 2000 }); // ratio 2.0
    expect(shouldStopSeeding(d, { ratioLimit: 2, timeLimitMinutes: 0 }, T0)).toEqual({ stop: true, reason: 'ratio' });
  });

  it('does not stop just below the ratio limit', () => {
    const d = base({ downloadedBytes: 1000, uploadedBytes: 1999 }); // ratio 1.999
    expect(shouldStopSeeding(d, { ratioLimit: 2, timeLimitMinutes: 0 }, T0).stop).toBe(false);
  });

  it('never divides by zero when nothing was downloaded (start-seeding)', () => {
    const d = base({ downloadedBytes: 0, uploadedBytes: 5000 }); // ratio treated as 0
    expect(shouldStopSeeding(d, { ratioLimit: 1, timeLimitMinutes: 0 }, T0).stop).toBe(false);
  });

  it('per-torrent ratio overrides the global default', () => {
    const d = base({ downloadedBytes: 1000, uploadedBytes: 1500, seedRatioLimit: 1 }); // ratio 1.5, per-torrent 1
    expect(shouldStopSeeding(d, { ratioLimit: 5, timeLimitMinutes: 0 }, T0)).toEqual({ stop: true, reason: 'ratio' });
  });

  it('a per-torrent 0 falls back to the global default', () => {
    const d = base({ downloadedBytes: 1000, uploadedBytes: 3000, seedRatioLimit: 0 });
    expect(shouldStopSeeding(d, { ratioLimit: 2, timeLimitMinutes: 0 }, T0)).toEqual({ stop: true, reason: 'ratio' });
  });

  it('stops on the time limit at the boundary', () => {
    const d = base({ seedingStartedAt: T0 });
    const now = T0 + 60 * 60000; // 60 min later
    expect(shouldStopSeeding(d, { ratioLimit: 0, timeLimitMinutes: 60 }, now)).toEqual({ stop: true, reason: 'time' });
  });

  it('does not apply the time limit without a seedingStartedAt', () => {
    const d = base({ seedingStartedAt: null });
    expect(shouldStopSeeding(d, { ratioLimit: 0, timeLimitMinutes: 1 }, T0 + 999999).stop).toBe(false);
  });

  it('ratio is evaluated before time', () => {
    const d = base({ downloadedBytes: 1000, uploadedBytes: 2000, seedingStartedAt: T0 });
    const r = shouldStopSeeding(d, { ratioLimit: 2, timeLimitMinutes: 1 }, T0 + 999 * 60000);
    expect(r).toEqual({ stop: true, reason: 'ratio' });
  });
});
