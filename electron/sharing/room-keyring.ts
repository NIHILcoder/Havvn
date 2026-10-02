import crypto from 'crypto';
import { ROOM_KEY_LIMIT, ROOM_KEY_PAGE_SIZE, type RoomE2ECfg, type RoomKeyPage,
  validKeyMetadata, validKeyPage, keyMetadataCanonical, keyPageCanonical } from '../../shared/room-keyring';

export function contentKeyEpoch(secret: string): string {
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('Invalid room content key');
  return crypto.createHash('sha256').update('th-room-content-epoch:v2\0').update(Buffer.from(secret, 'hex')).digest('hex');
}
export function mergeContentKeys(current: string, ...lists: string[][]): string[] {
  const keys = [...new Set(lists.flat().filter(k => typeof k === 'string' && /^[a-f0-9]{64}$/i.test(k)).map(k => k.toLowerCase()))].filter(k => k !== current.toLowerCase());
  if (keys.length + (current ? 1 : 0) > ROOM_KEY_LIMIT) throw new Error('Room key history is full; create a new room and share the active files there');
  return keys;
}
const entriesFor = (keys: string[]) => [...new Set(keys.map(k => k.toLowerCase()))].map(secret => ({ epoch: contentKeyEpoch(secret), secret })).sort((a, b) => a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : 0);
const rootFor = (entries: ReturnType<typeof entriesFor>) => crypto.createHash('sha256').update(JSON.stringify(entries.map(e => [e.epoch, e.secret]))).digest('hex');

export function mintKeyPages(topic: string, cfg: RoomE2ECfg, previous: string[], priv: string): RoomKeyPage[] {
  if (!cfg.e2e || !cfg.secret) return [];
  const entries = entriesFor([cfg.secret, ...mergeContentKeys(cfg.secret, previous)]);
  const key = crypto.createPrivateKey(priv);
  const body = { v: 2 as const, epoch: contentKeyEpoch(cfg.secret), root: rootFor(entries), total: entries.length, pages: Math.ceil(entries.length / ROOM_KEY_PAGE_SIZE), sig: '' };
  body.sig = crypto.sign(null, keyMetadataCanonical(topic, cfg, body), key).toString('base64');
  cfg.keys = body;
  return Array.from({ length: body.pages }, (_, page) => {
    const p: RoomKeyPage = { t: 'e2e-keys', ownerId: cfg.ownerId, epoch: body.epoch, root: body.root, total: body.total,
      page, entries: entries.slice(page * ROOM_KEY_PAGE_SIZE, (page + 1) * ROOM_KEY_PAGE_SIZE), pub: cfg.pub, sig: '' };
    p.sig = crypto.sign(null, keyPageCanonical(topic, p), key).toString('base64');
    return p;
  });
}
export function verifyKeyMetadata(topic: string, cfg: RoomE2ECfg): boolean {
  try { return !!cfg.keys && validKeyMetadata(cfg.keys) && cfg.keys.epoch === contentKeyEpoch(cfg.secret)
    && crypto.verify(null, keyMetadataCanonical(topic, cfg, cfg.keys), crypto.createPublicKey(cfg.pub), Buffer.from(cfg.keys.sig, 'base64')); }
  catch { return false; }
}
export function verifyKeyPage(topic: string, cfg: RoomE2ECfg, p: RoomKeyPage): boolean {
  try { return !!cfg.keys && verifyKeyMetadata(topic, cfg) && validKeyPage(p) && p.ownerId === cfg.ownerId && p.pub === cfg.pub
    && p.epoch === cfg.keys.epoch && p.root === cfg.keys.root && p.total === cfg.keys.total
    && p.entries.every(e => contentKeyEpoch(e.secret) === e.epoch)
    && crypto.verify(null, keyPageCanonical(topic, p), crypto.createPublicKey(p.pub), Buffer.from(p.sig, 'base64')); }
  catch { return false; }
}
export function completeKeyPages(cfg: RoomE2ECfg, pages: RoomKeyPage[]): boolean {
  if (!cfg.keys || pages.length !== cfg.keys.pages || new Set(pages.map(p => p.page)).size !== pages.length) return false;
  const entries = [...pages].sort((a, b) => a.page - b.page).flatMap(p => p.entries);
  return entries.length === cfg.keys.total && new Set(entries.map(e => e.epoch)).size === entries.length && rootFor(entries) === cfg.keys.root;
}

/** Rebuild proof pages only when every key in the signed root is held locally. */
export function completeContentKeys(cfg: RoomE2ECfg | null, current: string, previous: string[]): boolean {
  if (!cfg?.keys) return true;
  try { const entries = entriesFor([current, ...previous].filter(Boolean));
    return entries.length === cfg.keys.total && rootFor(entries) === cfg.keys.root; }
  catch { return false; }
}
