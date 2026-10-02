import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
const state = vi.hoisted(() => ({ stores: new Map<string, Record<string, any>>(), available: true, encryptFail: false, decryptFail: false, diskFail: false, writes: [] as unknown[] }));
vi.mock('electron', () => ({ app: { getPath: () => 'D:/isolated-room-store' }, safeStorage: {
  isEncryptionAvailable: () => state.available,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (text: string) => {
    if (state.encryptFail) throw new Error('OS encryption failed');
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv);
    return Buffer.concat([iv, c.update(text), c.final(), c.getAuthTag()]);
  },
  decryptString: (b: Buffer) => {
    if (state.decryptFail) throw new Error('OS storage locked');
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.alloc(32, 7), b.subarray(0, 12)); d.setAuthTag(b.subarray(-16));
    return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
  },
} }));
vi.mock('electron-store', () => ({ default: class {
  name: string;
  constructor(o: { name: string; defaults: object }) { this.name = o.name; if (!state.stores.has(o.name)) state.stores.set(o.name, structuredClone(o.defaults)); }
  get(k: string) { return structuredClone(state.stores.get(this.name)?.[k]); }
  set(k: string | object, value?: unknown) {
    if (state.diskFail) throw new Error('disk full');
    const patch = typeof k === 'string' ? { [k]: value } : k;
    state.writes.push(structuredClone(patch)); state.stores.set(this.name, { ...state.stores.get(this.name), ...structuredClone(patch) });
  }
  has(k: string) { return k in state.stores.get(this.name)!; }
  delete(k: string) { delete state.stores.get(this.name)![k]; }
} }));
import * as db from './store';
import { banSnapshotCanonical } from '../../shared/room-bans';
import { sealRoom, openRoom } from './room-secrets';
import { deriveMemberId } from '../sharing/room-crypto';
import { mintKeyPages, verifyKeyMetadata, verifyKeyPage } from '../sharing/room-keyring';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const room = (): db.PersistedRoom => {
  const secret = '12'.repeat(32), topic = 'topic';
  const cfg = { ownerId: deriveMemberId(pub), e2e: true, secret, pub,
    sig: crypto.sign(null, Buffer.from(JSON.stringify(['th-room-e2e:v1', topic, deriveMemberId(pub), true, secret])), privateKey).toString('base64'),
    prevSecrets: ['34'.repeat(32)], prevSig: crypto.sign(null, Buffer.from(JSON.stringify(['th-room-e2e-prev:v1', topic, deriveMemberId(pub), ['34'.repeat(32)]])), privateKey).toString('base64') };
  const keyPages = mintKeyPages(topic, cfg, ['34'.repeat(32)], priv);
  return { roomId: 'A', name: 'My room', createdAt: 7, code: 'private-invite-code-e2e', folder: 'D:/rooms/A', secret, prevSecrets: ['34'.repeat(32)], e2e: true, e2eCfg: cfg, keyPages };
};
const raw = () => state.stores.get('rooms')!;
beforeEach(() => { state.available = true; state.encryptFail = false; state.decryptFail = false; state.diskFail = false; raw().rooms = {}; raw().roomIdentity = null; raw().roomProfile = null; state.writes = []; });

describe('protected room records and atomic legacy migration', () => {
  it('protects codes, all content keys, cfg duplicates and pages; preserves every signed byte', () => {
    const r = room(); db.savePersistedRoom(r);
    const json = JSON.stringify(raw());
    for (const secret of [r.code, r.secret!, ...r.prevSecrets!]) expect(json).not.toContain(secret);
    expect(raw().rooms.A).not.toHaveProperty('code'); expect(raw().rooms.A).not.toHaveProperty('e2eCfg');
    expect(db.getPersistedRooms()).toEqual([r]);
    const restored = db.getPersistedRooms()[0].e2eCfg!;
    expect(crypto.verify(null, Buffer.from(JSON.stringify(['th-room-e2e:v1', 'topic', restored.ownerId, true, restored.secret])), publicKey, Buffer.from(restored.sig, 'base64'))).toBe(true);
    expect(verifyKeyMetadata('topic', restored)).toBe(true); expect(verifyKeyPage('topic', restored, db.getPersistedRooms()[0].keyPages![0])).toBe(true);
  });
  it('migrates legacy rooms once in one atomic write and returns original plaintext in memory only', () => {
    const a = room(), b = { ...room(), roomId: 'B', code: 'other-private-code' }; raw().rooms = { A: a, B: b };
    expect(db.getPersistedRooms()).toEqual([a, b]); expect(state.writes).toHaveLength(1);
    expect(JSON.stringify(raw())).not.toContain(a.code); const saved = structuredClone(raw().rooms);
    expect(db.getPersistedRooms()).toEqual([a, b]); expect(state.writes).toHaveLength(1); expect(raw().rooms).toEqual(saved);
  });
  it('preserves the original legacy record on unavailable encryption, encryption error or disk error, then retries', () => {
    for (const failure of ['available', 'encryptFail', 'diskFail'] as const) {
      const a = room(); raw().rooms = { A: a }; state.writes = [];
      state[failure] = failure !== 'available';
      const result = db.getPersistedRooms()[0]; expect(result.code).toBe(''); expect(result.storageError).toBeTruthy(); expect(result.secret).toBeUndefined();
      expect(raw().rooms.A).toEqual(a); expect(state.writes).toEqual([]);
      state.available = true; state.encryptFail = false; state.diskFail = false;
      expect(db.getPersistedRooms()).toEqual([a]); expect(raw().rooms.A.secrets.version).toBe(1);
    }
  });
  it('does not erase ciphertext when the OS rejects decryption; unrelated rooms stay available', () => {
    const a = room(); db.savePersistedRoom(a); const original = structuredClone(raw().rooms.A);
    state.decryptFail = true;
    const locked = db.getPersistedRooms()[0]; expect(locked.storageError).toBe('decrypt-failed');
    expect(() => db.savePersistedRoom(locked)).toThrow(/locked/); expect(() => db.savePersistedRoom(a)).toThrow(/decrypt/);
    expect(raw().rooms.A).toEqual(original);
    state.decryptFail = false; expect(db.getPersistedRooms()).toEqual([a]);
  });
  it('refuses swapped, truncated or unknown-version encrypted payloads without rewriting them', () => {
    const a = room(), b = { ...room(), roomId: 'B' }; const sealed = sealRoom(a);
    for (const value of [{ ...sealed, roomId: 'B' }, { ...sealed, secrets: { version: 1, payload: sealed.secrets!.payload.slice(0, -5) } }, { ...sealed, secrets: { version: 2, payload: sealed.secrets!.payload } }]) {
      raw().rooms = { [value.roomId]: value }; const original = structuredClone(raw().rooms);
      expect(db.getPersistedRooms()[0].storageError).toBeTruthy(); expect(raw().rooms).toEqual(original);
    }
    raw().rooms = { A: { ...sealed, secrets: { version: 2, payload: sealed.secrets!.payload } }, B: sealRoom(b) };
    expect(db.getPersistedRooms().find(r => r.roomId === 'B')).toEqual(b);
  });
  it('preserves protected blobs for preference writes and deletion of another room', () => {
    const a = room(); db.savePersistedRoom(a); const protectedSecrets = raw().rooms.A.secrets;
    db.setRoomAutoFetch('A', false); db.setRoomNotifyMuted('A', true); db.setRoomLimits('A', 100, 200); db.deletePersistedRoom('B');
    expect(raw().rooms.A.secrets).toEqual(protectedSecrets); expect(JSON.stringify(raw())).not.toContain(a.code);
    expect(db.getPersistedRooms()[0]).toMatchObject({ autoFetch: false, notifyMuted: true, upKbps: 100, downKbps: 200, code: a.code });
  });
  it('rejects oversized imported/legacy histories before any protected write', () => {
    const a = { ...room(), prevSecrets: Array(2049).fill('12'.repeat(32)) };
    raw().rooms = { A: a }; expect(db.getPersistedRooms()[0].storageError).toBe('migration-failed'); expect(raw().rooms.A).toEqual(a);
    expect(() => db.savePersistedRoom(a)).toThrow(/oversized/); expect(state.writes).toEqual([]);
  });
  it('never writes a half-protected record or overwrites the prior record on failed save', () => {
    const a = room(); db.savePersistedRoom(a); const original = structuredClone(raw());
    state.encryptFail = true; expect(() => db.savePersistedRoom({ ...a, code: 'new-code' })).toThrow(); expect(raw()).toEqual(original);
    state.encryptFail = false; state.diskFail = true; expect(() => db.savePersistedRoom({ ...a, code: 'new-code' })).toThrow(); expect(raw()).toEqual(original);
  });
  it('does not mistake plaintext values starting with the ciphertext tag for pre-encrypted room secrets', () => {
    const a = { ...room(), code: 'enc:v1:literal' }; expect(openRoom(sealRoom(a))).toEqual(a);
  });
});

describe('portable room identity import/export', () => {
  const bundle = () => ({ version: 1, exportedAt: '', profile: { memberId: deriveMemberId(pub), name: 'Alice', avatarSeed: 'a' }, identity: { pub, priv }, rooms: [room()] });
  it('re-protects every imported room and atomically commits identity, profile and rooms', () => {
    const input = bundle(); expect(db.importRoomIdentityBundle(input)).toEqual({ rooms: 1 });
    expect(state.writes).toHaveLength(1); for (const key of ['roomIdentity', 'roomProfile', 'rooms']) expect(state.writes[0]).toHaveProperty(key);
    const json = JSON.stringify(raw()); for (const value of [priv, input.rooms[0].code, input.rooms[0].secret!]) expect(json).not.toContain(value);
    expect(db.exportRoomIdentityBundle()).toMatchObject({ identity: { pub, priv }, rooms: input.rooms }); expect(input).toEqual(bundle());
  });
  it('rejects a failed import or mismatched keypair before changing any record', () => {
    const original = structuredClone(raw()); state.encryptFail = true;
    expect(() => db.importRoomIdentityBundle(bundle())).toThrow(); expect(raw()).toEqual(original);
    state.encryptFail = false; state.diskFail = true; expect(() => db.importRoomIdentityBundle(bundle())).toThrow(); expect(raw()).toEqual(original);
    state.diskFail = false; const foreign = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => db.importRoomIdentityBundle({ ...bundle(), identity: { pub, priv: foreign } })).toThrow(/do not match/); expect(raw()).toEqual(original);
  });
  it('fails export with a locked room instead of producing an incomplete recovery bundle', () => {
    db.importRoomIdentityBundle(bundle()); state.decryptFail = true; expect(() => db.exportRoomIdentityBundle()).toThrow(/locked/);
  });
});

it('round-trips signed bans with protected secrets through migration, import and export', () => {
  const r = room(), proof = { v: 1 as const, ownerId: deriveMemberId(pub), revision: 1, bans: ['removed-profile'], pub, sig: '' };
  proof.sig = crypto.sign(null, banSnapshotCanonical('topic', proof), privateKey).toString('base64');
  r.bans = proof.bans; r.banState = proof; raw().rooms = { A: r };
  const read = db.getPersistedRooms()[0]; expect(read.banState).toEqual(proof);
  expect(raw().rooms.A.banState).toBeUndefined(); expect(JSON.stringify(raw())).not.toContain(proof.sig);
  const oldProtected = { ...sealRoom(room()), banState: proof, bans: proof.bans }; raw().rooms = { A: oldProtected };
  expect(db.getPersistedRooms()[0].banState).toEqual(proof); expect(raw().rooms.A.banState).toBeUndefined();
  expect(JSON.stringify(raw())).not.toContain(proof.sig);
  expect(crypto.verify(null, banSnapshotCanonical('topic', read.banState!), pub, Buffer.from(read.banState!.sig, 'base64'))).toBe(true);
  expect(openRoom(sealRoom(read)).banState).toEqual(proof);
  db.importRoomIdentityBundle({ version: 1, exportedAt: '', identity: { pub, priv }, profile: { memberId: deriveMemberId(pub), name: 'Alice', avatarSeed: 'a' }, rooms: [read] });
  const exported = db.exportRoomIdentityBundle(); expect(exported.rooms[0].banState).toEqual(proof);
  raw().rooms = {}; db.importRoomIdentityBundle(exported);
  const again = db.getPersistedRooms()[0].banState!;
  expect(crypto.verify(null, banSnapshotCanonical('topic', again), pub, Buffer.from(again.sig, 'base64'))).toBe(true);
});


describe('portable recovery records', () => {
  const roomId='12345678-1234-1234-1234-123456789abc';
  function recovery() {
    db.importRoomIdentityBundle({version:1,identity:{pub,priv},profile:{memberId:deriveMemberId(pub),name:'Alice',avatarSeed:'a'},rooms:[{...room(),roomId}]});
    db.upsertRoomManifestFile(roomId,{fileId:'ab'.repeat(20),infoHash:'ab'.repeat(20),name:'saved.txt',size:3,magnetURI:'magnet:?xt=urn:btih:'+ 'ab'.repeat(20),addedBy:deriveMemberId(pub),addedByName:'Alice',addedAt:1,localPath:'D:/original/private.txt',cipherPath:'D:/cache/cipher',localOriginal:true,torrentFile:'metadata'});
    db.addRoomTombstone(roomId,'deleted',17);db.addRoomRevive(roomId,'revived',20);
    db.addRoomIdentity(roomId,deriveMemberId(pub),pub);
    const backup=db.exportRoomRecoveryBundle();raw().rooms={};return backup;
  }
  it('round-trips old keys, signatures and deletion floors without importing disk paths or privilege flags', () => {
    const input=recovery(), original=structuredClone(input);
    expect(JSON.stringify(input)).not.toContain('D:/original');expect(JSON.stringify(input)).not.toContain('D:/cache');
    expect(db.importRoomRecoveryBundle(input,'D:/restore/Rooms')).toEqual({rooms:1});expect(input).toEqual(original);
    const saved=db.getPersistedRooms()[0];expect(saved.folder.replaceAll('\\','/')).toBe('D:/restore/Rooms/'+roomId);expect(saved.autoFetch).toBe(false);
    expect(saved.prevSecrets).toEqual(original.rooms[0].prevSecrets);expect(saved.keyPages).toEqual(original.rooms[0].keyPages);
    expect(verifyKeyMetadata('topic',saved.e2eCfg!)).toBe(true);expect(verifyKeyPage('topic',saved.e2eCfg!,saved.keyPages![0])).toBe(true);
    expect(db.getRoomTombstones(roomId).deleted).toBe(17);expect(db.getRoomRevives(roomId).revived).toBe(20);
    expect(db.getRoomManifest(roomId)[0]).toMatchObject({receivePaused:true});
    expect(db.getRoomManifest(roomId)[0].localPath).toBeUndefined();expect(db.getRoomManifest(roomId)[0].localOriginal).toBeUndefined();
    expect(JSON.stringify(raw())).not.toContain(priv);expect(JSON.stringify(raw())).not.toContain(saved.secret);
  });
  it('refuses restore into joined rooms and malformed keys, paths, clocks before changing identity', () => {
    const input=recovery(), previous=structuredClone(raw());
    const cases=[{...input,profile:{...input.profile,memberId:'other'}}, {...input,rooms:[{...input.rooms[0],roomId:'../outside'}]}, {...input,recovery:{...input.recovery,[roomId]:{...input.recovery![roomId],tombstones:{deleted:'wrong'}}}}];
    for(const bad of cases){expect(()=>db.importRoomRecoveryBundle(bad,'D:/restore')).toThrow();expect(raw()).toEqual(previous);}
    db.savePersistedRoom({...room(),roomId:'joined'});expect(()=>db.importRoomRecoveryBundle(input,'D:/restore')).toThrow(/no joined rooms/);
  });
  it('does not write any restoration record if OS protection or the atomic store write fails', () => {
    const input=recovery(),previous=structuredClone(raw());state.encryptFail=true;
    expect(()=>db.importRoomRecoveryBundle(input,'D:/restore')).toThrow();expect(raw()).toEqual(previous);
    state.encryptFail=false;state.diskFail=true;
    expect(()=>db.importRoomRecoveryBundle(input,'D:/restore')).toThrow();expect(raw()).toEqual(previous);
  });
});


it('preserves no-expiry history for legacy rooms and sets 30 days only for a new room', () => {
  raw().roomHistoryRetention={};raw().rooms={A:room()};
  expect(db.getRoomHistoryRetention('A')).toBe(0);
  db.savePersistedRoom({...room(),roomId:'new'});expect(db.getRoomHistoryRetention('new')).toBe(30);
  db.savePersistedRoom({...room(),name:'Renamed'});expect(db.getRoomHistoryRetention('A')).toBe(0);
});

it('can export one room without exposing another room invitation or keys', () => {
  const profile={memberId:deriveMemberId(pub),name:'Alice',avatarSeed:'a'};
  db.importRoomIdentityBundle({version:1,profile,identity:{pub,priv},rooms:[room(),{...room(),roomId:'other',code:'other-private-invite',secret:'56'.repeat(32)}]});
  const selected=db.exportRoomRecoveryBundle('A');expect(selected.rooms).toHaveLength(1);expect(Object.keys(selected.recovery!)).toEqual(['A']);
  expect(JSON.stringify(selected)).not.toContain('other-private-invite');expect(JSON.stringify(selected)).not.toContain('56'.repeat(32));
  expect(()=>db.exportRoomRecoveryBundle('missing')).toThrow(/not found/);
});
