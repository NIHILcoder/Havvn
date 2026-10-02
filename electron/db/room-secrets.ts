import { validBanSnapshot } from '../../shared/room-bans';
import { encryptSecret, decryptSecretStrict, isEncrypted } from './secrets';
import { ROOM_KEY_LIMIT, ROOM_KEY_PAGE_LIMIT, validKeyPage } from '../../shared/room-keyring';
import type { PersistedRoom } from './store';

export type RoomStorageError = 'unavailable' | 'decrypt-failed' | 'migration-failed' | 'write-failed' | 'unsupported';
type PrivateRoom = Pick<PersistedRoom, 'code' | 'secret' | 'prevSecrets' | 'e2eCfg' | 'keyPages' | 'banState'>;
export type StoredRoom = Omit<PersistedRoom, keyof PrivateRoom | 'storageError'> & Partial<PrivateRoom> & {
  secrets?: { version: 1; payload: string };
};

function validPrivateRoom(v: PrivateRoom): boolean {
  return typeof v.code === 'string' && v.code.length > 0 && v.code.length <= 256
    && (v.secret === undefined || typeof v.secret === 'string' && v.secret.length <= 256)
    && (v.prevSecrets === undefined || Array.isArray(v.prevSecrets) && v.prevSecrets.length <= ROOM_KEY_LIMIT && v.prevSecrets.every(s => typeof s === 'string' && s.length <= 256))
    && (v.banState === undefined || validBanSnapshot(v.banState))
    && (v.e2eCfg === undefined || !!v.e2eCfg && typeof v.e2eCfg === 'object' && !Array.isArray(v.e2eCfg))
    && (v.keyPages === undefined || Array.isArray(v.keyPages) && v.keyPages.length <= ROOM_KEY_PAGE_LIMIT
      && v.keyPages.every(p => validKeyPage(p) && typeof p.pub === 'string' && p.pub.length <= 2048 && typeof p.sig === 'string' && p.sig.length <= 1024));
}

/** A single protected payload also covers duplicate secrets inside signed cfg/pages.
 * JSON round-trips those proofs without changing their canonical signed fields.
 * roomId binds the ciphertext to its record (copying another record fails closed).
 */
export function sealRoom(room: PersistedRoom): StoredRoom {
  if (room.storageError || !room.code) throw new Error('Room secrets are locked; restore system storage access and retry');
  const { code, secret, prevSecrets, e2eCfg, keyPages, banState, storageError: _error, ...publicRoom } = room;
  const value: PrivateRoom = { code, secret, prevSecrets, e2eCfg, keyPages, banState };
  if (!validPrivateRoom(value)) throw new Error('Invalid or oversized room secret payload');
  const payload = encryptSecret(JSON.stringify({ roomId: room.roomId, ...value }), false);
  return { ...publicRoom, secrets: { version: 1, payload } };
}

export function openRoom(room: StoredRoom): PersistedRoom {
  if (!room.secrets) return { ...room } as PersistedRoom; // legacy, migrated by store before use
  if (room.secrets.version !== 1 || !isEncrypted(room.secrets.payload)) throw new Error('Unsupported room secret storage format');
  const parsed = JSON.parse(decryptSecretStrict(room.secrets.payload));
  if (!parsed || parsed.roomId !== room.roomId || !validPrivateRoom(parsed)) throw new Error('Invalid protected room payload');
  const value: PrivateRoom = { code: parsed.code, secret: parsed.secret, prevSecrets: parsed.prevSecrets, e2eCfg: parsed.e2eCfg, keyPages: parsed.keyPages, banState: parsed.banState ?? room.banState };
  if (!validPrivateRoom(value)) throw new Error('Invalid protected room ban payload');
  const { secrets: _secrets, code: _code, secret: _secret, prevSecrets: _prev, e2eCfg: _cfg, keyPages: _pages, banState: _bans, ...publicRoom } = room;
  return { ...publicRoom, ...structuredClone(value) };
}

export function lockedRoom(room: StoredRoom, storageError: RoomStorageError): PersistedRoom {
  const { secrets: _secrets, code: _code, secret: _secret, prevSecrets: _prev, e2eCfg: _cfg, keyPages: _pages, banState: _bans, ...publicRoom } = room;
  return { ...publicRoom, code: '', storageError };
}
