/** Owner-signed, additive room bans. A profile ID is not a person's identity. */
export const ROOM_BAN_LIMIT = 2048;
export interface RoomBanSnapshot {
  v: 1; ownerId: string; revision: number; bans: string[]; pub: string; sig: string;
}
export function validBanSnapshot(value: unknown): value is RoomBanSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as RoomBanSnapshot;
  return p.v === 1 && typeof p.ownerId === 'string' && p.ownerId.length > 0 && p.ownerId.length <= 1024
    && Number.isSafeInteger(p.revision) && p.revision > 0
    && typeof p.pub === 'string' && p.pub.length > 0 && p.pub.length <= 2048
    && typeof p.sig === 'string' && p.sig.length > 0 && p.sig.length <= 1024
    && Array.isArray(p.bans) && p.bans.length <= ROOM_BAN_LIMIT
    && p.bans.every((id, i) => typeof id === 'string' && id.length > 0 && id.length <= 128
      && id !== p.ownerId && (!i || id > p.bans[i - 1]));
}
export function banSnapshotCanonical(topic: string, p: Pick<RoomBanSnapshot, 'ownerId' | 'revision' | 'bans'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(['th-room-bans:v1', topic, p.ownerId, p.revision, p.bans]));
}
/** Crypto and owner-chain verification precede this policy. No implicit unban. */
export function banSnapshotAdvances(p: RoomBanSnapshot, ownerId: string, previous: RoomBanSnapshot | null, held: ReadonlySet<string>): boolean {
  const incoming = new Set(p.bans);
  if (p.ownerId !== ownerId || [...held].some(id => !incoming.has(id))) return false;
  if (!previous || previous.ownerId !== p.ownerId) return true;
  return p.revision > previous.revision
    || p.revision === previous.revision && p.sig === previous.sig;
}
/** Drop unsigned extension fields before retaining/re-serving a proof. */
export function copyBanSnapshot(p: RoomBanSnapshot): RoomBanSnapshot {
  return { v: 1, ownerId: p.ownerId, revision: p.revision, bans: [...p.bans], pub: p.pub, sig: p.sig };
}
