/** Normalize a manifest name without importing Node path into the browser. */
export function roomFileName(name: unknown): string {
  if (typeof name !== 'string' || !name) return '';
  const withoutDrive = name.replace(/^[a-z]:/i, '');
  const base = withoutDrive.replace(/[\\/]+$/g, '').split(/[\\/]/).at(-1) || '';
  return base === '.' || base === '..' ? '' : base;
}

/** Browser-safe ownership policy. Crypto is supplied by Node/WebCrypto callers. */
export interface OwnerTransfer { by: string; newOwnerId: string; at: number; pub: string; sig: string }
export interface OwnerLine { ownerId: string; ownerPin: string; transferChain: OwnerTransfer[]; transferAt: number }
export const ROOM_TRANSFER_LIMIT = 8;
export function transferCanonical(root: string, link: Pick<OwnerTransfer, 'by' | 'newOwnerId' | 'at'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(['th-room-transfer:v1', root, link.by, link.newOwnerId, link.at]));
}
/** Frozen v1 policy: walk only a contiguous, increasing, non-future prefix. */
export function orderedTransferPrefix(links: unknown, now = Date.now()): OwnerTransfer[] {
  if (!Array.isArray(links)) return [];
  const out: OwnerTransfer[] = [];
  for (const l of links.slice(0, ROOM_TRANSFER_LIMIT)) {
    if (!l || typeof l !== 'object' || !['by', 'newOwnerId', 'pub', 'sig'].every(k => typeof l[k] === 'string' && l[k].length > 0)
      || l.by === l.newOwnerId || !Number.isSafeInteger(l.at) || l.at <= (out.at(-1)?.at ?? 0) || l.at > now + 60_000
      || out.length && l.by !== out.at(-1)!.newOwnerId) break;
    out.push({ by: l.by, newOwnerId: l.newOwnerId, at: l.at, pub: l.pub, sig: l.sig });
  }
  return out;
}
/** Older prefixes are safe to relay; a conflicting signed branch is not. */
export function ownerChainsCompatible(held: OwnerTransfer[], incoming: OwnerTransfer[]): boolean {
  return held.slice(0, incoming.length).every((link, i) => link.by === incoming[i].by
    && link.newOwnerId === incoming[i].newOwnerId && link.at === incoming[i].at);
}
/** Call only with a chain whose signatures and signer identities were verified. */
export function ownerChainAnchored(line: Pick<OwnerLine, 'ownerId' | 'ownerPin' | 'transferChain'>, chain: OwnerTransfer[]): boolean {
  if (!chain.length) return false;
  // A verified handover is irreversible: a past owner cannot replace the known
  // line with a freshly signed fork, even when its final timestamp is newer.
  if (chain.length < line.transferChain.length || !ownerChainsCompatible(line.transferChain, chain)) return false;
  const root = chain[0].by;
  if (line.ownerPin) return root === line.ownerPin || chain.some(l => l.newOwnerId === line.ownerPin);
  const known = line.transferChain[0]?.by || line.ownerId;
  return !known || root === known || chain.some(l => l.by === known || l.newOwnerId === known);
}
export function ownerChainAdvances(line: OwnerLine, chain: OwnerTransfer[]): boolean {
  const at = chain.at(-1)?.at ?? 0;
  return ownerChainAnchored(line, chain) && (at > line.transferAt || at === line.transferAt && chain.length > line.transferChain.length);
}
export function canDeleteRoomFile(owner: string, author: string | undefined, by: string): boolean {
  return !!by && (!!owner && by === owner || !!author && by === author);
}
export function canReviveRoomFile(owner: string, deleter: string | undefined, by: string): boolean {
  return canDeleteRoomFile(owner, deleter, by);
}
export function currentRoomDeletion(at: number, addedAt?: number, revivedAt?: number, now = Date.now()): boolean {
  return Number.isSafeInteger(at) && at > 0 && at <= now + 60_000
    && !(addedAt !== undefined && addedAt > at) && !(revivedAt !== undefined && revivedAt >= at);
}
