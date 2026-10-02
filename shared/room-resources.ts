/** File budgets are shared by desktop room clients; voice/video/LAN are separate. */
export interface RoomResourcePolicy {
  maxUpKbps: number;
  maxDownKbps: number;
  voicePriority: boolean;
  /** Video encoder ceiling per remote peer, in decimal kbit/s. */
  screenBitrateKbps: number;
}

export interface RoomResourceResult {
  ok: true;
  saved: true;
  applied: boolean;
  policy: RoomResourcePolicy;
  error?: string;
}

export const DEFAULT_ROOM_RESOURCES: Readonly<RoomResourcePolicy> = Object.freeze({
  maxUpKbps: 256, maxDownKbps: 0, voicePriority: true, screenBitrateKbps: 2500,
});

export function validateRoomResources(value: unknown): RoomResourcePolicy {
  const p = value as RoomResourcePolicy;
  if (!p || typeof p.voicePriority !== 'boolean' ||
      !Number.isInteger(p.maxUpKbps) || p.maxUpKbps < 0 || p.maxUpKbps > 1_000_000 ||
      !Number.isInteger(p.maxDownKbps) || p.maxDownKbps < 0 || p.maxDownKbps > 1_000_000 ||
      !Number.isInteger(p.screenBitrateKbps) || p.screenBitrateKbps < 250 || p.screenBitrateKbps > 20_000) {
    throw new Error('Invalid room resource settings');
  }
  return { maxUpKbps: p.maxUpKbps, maxDownKbps: p.maxDownKbps,
    voicePriority: p.voicePriority, screenBitrateKbps: p.screenBitrateKbps };
}

/** Older stores, unlike live edits, may be incomplete. */
export function readRoomResources(value?: Partial<RoomResourcePolicy>): RoomResourcePolicy {
  try { return validateRoomResources({ ...DEFAULT_ROOM_RESOURCES, ...value }); }
  catch { return { ...DEFAULT_ROOM_RESOURCES }; }
}

/** Equal shares with capped rooms' unused allocation redistributed. -1 = unlimited. */
export function allocateRoomRates(totalKbps: number, capsKbps: number[]): number[] {
  if (!totalKbps) return capsKbps.map(cap => cap ? cap * 1024 : -1);
  const rates = capsKbps.map(() => 0);
  let remaining = totalKbps * 1024, pending = capsKbps.map((cap, i) => ({ i, cap: cap ? cap * 1024 : Infinity }));
  while (pending.length) {
    const share = Math.floor(remaining / pending.length);
    const capped = pending.filter(p => p.cap <= share);
    if (!capped.length) {
      pending.forEach((p, i) => { rates[p.i] = share + (i < remaining % pending.length ? 1 : 0); });
      break;
    }
    for (const p of capped) { rates[p.i] = p.cap; remaining -= p.cap; }
    pending = pending.filter(p => p.cap > share);
  }
  return rates;
}

export function roomFileBudget(policy: RoomResourcePolicy, voiceActive: boolean): { up: number; down: number } {
  const priority = policy.voicePriority && voiceActive;
  // A finite fallback also protects a call when the normal file budget is unlimited.
  const reduce = (normal: number, ceiling: number) => normal ? Math.min(normal, ceiling) : ceiling;
  return { up: priority ? reduce(policy.maxUpKbps, 64) : policy.maxUpKbps,
    down: priority ? reduce(policy.maxDownKbps, 2048) : policy.maxDownKbps };
}
