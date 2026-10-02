/** Additive E2E key history. The v1 cfg/keyring canonicals remain byte-stable. */
export const ROOM_KEY_LIMIT = 2048;
export const ROOM_KEY_PAGE_SIZE = 32;
export const ROOM_KEY_PAGE_LIMIT = ROOM_KEY_LIMIT / ROOM_KEY_PAGE_SIZE;
export interface RoomKeyEntry { epoch: string; secret: string }
export interface RoomKeyMetadata { v: 2; epoch: string; root: string; total: number; pages: number; sig: string }
export interface RoomE2ECfg {
  ownerId: string; e2e: boolean; secret: string; pub: string; sig: string;
  prevSecrets?: string[]; prevSig?: string; keys?: RoomKeyMetadata;
}
export interface RoomKeyPage {
  t: 'e2e-keys'; ownerId: string; epoch: string; root: string;
  page: number; total: number; entries: RoomKeyEntry[]; pub: string; sig: string;
}
const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function validKeyMetadata(k: RoomKeyMetadata): boolean {
  return !!k && k.v === 2 && hex(k.epoch) && hex(k.root) && Number.isInteger(k.total) && k.total > 0 && k.total <= ROOM_KEY_LIMIT
    && k.pages === Math.ceil(k.total / ROOM_KEY_PAGE_SIZE) && typeof k.sig === 'string' && k.sig.length > 0 && k.sig.length <= 1024;
}
export function validKeyPage(p: RoomKeyPage): boolean {
  return !!p && hex(p.epoch) && hex(p.root) && Number.isInteger(p.total) && p.total > 0 && p.total <= ROOM_KEY_LIMIT
    && Number.isInteger(p.page) && p.page >= 0 && p.page < Math.ceil(p.total / ROOM_KEY_PAGE_SIZE)
    && Array.isArray(p.entries) && p.entries.length === Math.min(ROOM_KEY_PAGE_SIZE, p.total - p.page * ROOM_KEY_PAGE_SIZE)
    && p.entries.every(e => !!e && hex(e.epoch) && hex(e.secret)) && new Set(p.entries.map(e => e.epoch)).size === p.entries.length;
}
const json = (fields: unknown[]) => new TextEncoder().encode(JSON.stringify(fields));
export function keyMetadataCanonical(topic: string, cfg: Pick<RoomE2ECfg, 'ownerId' | 'e2e' | 'secret'>, k: RoomKeyMetadata): Uint8Array {
  return json(['th-room-e2e-keys:v2', topic, cfg.ownerId, cfg.e2e, cfg.secret, k.epoch, k.root, k.total, k.pages]);
}
export function keyPageCanonical(topic: string, p: Omit<RoomKeyPage, 'pub' | 'sig' | 't'>): Uint8Array {
  return json(['th-room-e2e-key-page:v2', topic, p.ownerId, p.epoch, p.root, p.page, p.total, p.entries.map(e => [e.epoch, e.secret])]);
}
