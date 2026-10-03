export const ROOM_VOICE_PEERS = 8;
export const ROOM_VOICE_PARTICIPANTS = ROOM_VOICE_PEERS + 1;
export const ROOM_VOICE_ROSTER = 256;
/** Every client chooses the same mesh once signed presence has converged. */
export function voiceMeshMembers(self: string, active: boolean, roster: Iterable<string>): Set<string> {
  const ids = new Set(roster);
  if (active) ids.add(self); else ids.delete(self);
  return new Set([...ids].sort().slice(0, ROOM_VOICE_PARTICIPANTS));
}
export const ROOM_VOICE_FLOORS = 2048;
/** Floors survive leave/rekey. Never evict a floor to make an old signature fresh. */
export function acceptVoiceStamp(floors: Map<string, number>, id: string, at: number, now = Date.now()): boolean {
  if (!id || !Number.isSafeInteger(at) || at <= (floors.get(id) ?? 0) || at > now + 60_000
    || !floors.has(id) && floors.size >= ROOM_VOICE_FLOORS) return false;
  floors.set(id, at);
  return true;
}
