/** Owner-local schedule; never accepts authority or secrets from gossip. */
export const ROOM_KEY_ROTATION_CAPABILITY = 'key-rotation-v1';
export interface RoomKeyRotationPlan {
  intervalMinutes: number;
  /** Zero repeats until the owner stops the schedule. */
  repetitions: number;
}
export interface RoomKeyRotationState {
  ownerId: string;
  intervalMinutes: number;
  remaining: number | null;
  nextAt: number;
  /** A failed automatic rotation pauses the schedule instead of retrying blindly. */
  error?: string;
}
export function validKeyRotationPlan(value: unknown): value is RoomKeyRotationPlan {
  if (!value || typeof value !== 'object') return false;
  const p = value as RoomKeyRotationPlan;
  return Number.isInteger(p.intervalMinutes) && p.intervalMinutes >= 1 && p.intervalMinutes <= 1440
    && Number.isInteger(p.repetitions) && p.repetitions >= 0 && p.repetitions <= 1000;
}
export function createKeyRotationSchedule(ownerId: string, plan: RoomKeyRotationPlan, now = Date.now()): RoomKeyRotationState {
  if (!ownerId || !validKeyRotationPlan(plan)) throw new Error('Invalid key rotation schedule');
  return { ownerId, intervalMinutes: plan.intervalMinutes, remaining: plan.repetitions || null,
    nextAt: now + plan.intervalMinutes * 60_000 };
}
export function restoreKeyRotationSchedule(value: unknown, ownerId: string, now = Date.now()): RoomKeyRotationState | undefined {
  if (!value || typeof value !== 'object') return;
  const s = value as RoomKeyRotationState;
  if (!ownerId || s.ownerId !== ownerId || !validKeyRotationPlan({ intervalMinutes: s.intervalMinutes, repetitions: s.remaining ?? 0 })
    || s.remaining !== null && (!Number.isInteger(s.remaining) || s.remaining < 1)
    || !Number.isSafeInteger(s.nextAt) || s.nextAt < 0 || s.nextAt === 0 && !s.error
    || s.error !== undefined && (typeof s.error !== 'string' || s.error.length > 500)) return;
  // Sleep/restart never causes a burst of missed rotations or consumes repeats.
  return { ownerId, intervalMinutes: s.intervalMinutes, remaining: s.remaining,
    nextAt: s.error ? 0 : s.nextAt <= now ? now + s.intervalMinutes * 60_000 : Math.min(s.nextAt, now + s.intervalMinutes * 60_000),
    ...(s.error ? { error: s.error } : {}) };
}
export function advanceKeyRotationSchedule(s: RoomKeyRotationState, now = Date.now()): RoomKeyRotationState | undefined {
  if (s.remaining === 1) return;
  return { ownerId: s.ownerId, intervalMinutes: s.intervalMinutes,
    remaining: s.remaining === null ? null : s.remaining - 1, nextAt: now + s.intervalMinutes * 60_000 };
}
