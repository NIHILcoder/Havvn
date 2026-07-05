/**
 * Seeding auto-stop decision — pure logic extracted from the manager's
 * checkSeedingLimits loop so the boundary math (ratio precedence, divide-by-zero
 * guard, per-torrent-overrides-global, >= boundary) can be pinned by tests. A
 * wrong boundary here either seeds forever (wasted bandwidth) or stops instantly
 * (breaks ratio obligations on private trackers).
 */

export interface SeedDefaults {
  /** Global default seed-ratio limit; <= 0 means unlimited. */
  ratioLimit: number;
  /** Global default seed-time limit in minutes; <= 0 means unlimited. */
  timeLimitMinutes: number;
}

export interface SeedState {
  downloadedBytes: number;
  uploadedBytes: number;
  /** Per-torrent overrides (0/null/undefined => fall back to the global default). */
  seedRatioLimit?: number | null;
  seedTimeLimitMinutes?: number | null;
  /** Epoch ms when seeding began; null/undefined => time limit can't apply yet. */
  seedingStartedAt?: number | null;
}

export type SeedStopReason = 'ratio' | 'time' | null;

/**
 * Decide whether a seeding torrent should auto-stop, and why. Ratio is checked
 * before time (matching the engine). Returns { stop:false, reason:null } when it
 * should keep seeding.
 */
export function shouldStopSeeding(d: SeedState, defaults: SeedDefaults, now: number): { stop: boolean; reason: SeedStopReason } {
  const ratio = d.downloadedBytes > 0 ? d.uploadedBytes / d.downloadedBytes : 0;

  const ratioLimit = (d.seedRatioLimit != null && d.seedRatioLimit > 0)
    ? d.seedRatioLimit
    : defaults.ratioLimit;
  if (ratioLimit > 0 && ratio >= ratioLimit) return { stop: true, reason: 'ratio' };

  const timeLimit = (d.seedTimeLimitMinutes != null && d.seedTimeLimitMinutes > 0)
    ? d.seedTimeLimitMinutes
    : defaults.timeLimitMinutes;
  if (timeLimit > 0 && d.seedingStartedAt) {
    const elapsedMinutes = (now - d.seedingStartedAt) / 60000;
    if (elapsedMinutes >= timeLimit) return { stop: true, reason: 'time' };
  }

  return { stop: false, reason: null };
}
