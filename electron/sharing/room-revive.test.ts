/**
 * Integration test for room file deletion tombstones and revive-by-re-share.
 *
 * Spins up REAL room-engine instances (one per simulated install) with the
 * Electron/WebTorrent/tracker boundaries mocked, wires them together with
 * in-memory peers, and drives the actual gossip protocol:
 *
 *   share → remove (tombstone) → re-share (revive) → peers converge,
 *   including a peer that was OFFLINE during the revive and comes back
 *   holding the stale tombstone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deriveMemberId, deriveKey, topicHash, encrypt } from './room-crypto';

// Stable Ed25519 identity per simulated member — a member's key is persistent
// across rejoins, so its signed deletes verify against the pub peers TOFU-bound
// from its hello. Regenerating per join would look like an identity swap.
// memberId is DERIVED from the pubkey (deriveMemberId), exactly like production,
// so signed commands pass the id↔pub anchor in verifySignedBy.
const identityKeys = new Map<string, { pub: string; priv: string; memberId: string }>();
function keysFor(label: string): { pub: string; priv: string; memberId: string } {
  let k = identityKeys.get(label);
  if (!k) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    k = { pub, priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), memberId: deriveMemberId(pub) };
    identityKeys.set(label, k);
  }
  return k;
}
/** The key-derived memberId for a simulated member label ('A', 'B', ...). */
function idFor(label: string): string { return keysFor(label).memberId; }

type Sent = { channel: string; payload: any };
type EngineCtx = {
  listeners: Record<string, (e: any, msg: any) => void>;
  sent: Sent[];
};

const H = vi.hoisted(() => ({
  trackers: [] as any[],   // FakeTracker instances in creation order
}));

// WebTorrent stand-in: infoHash is the sha1 of the file content, so the fileId
// is deterministic from content — the exact property behind the original bug.
vi.mock('webtorrent', async () => {
  const { default: fsMod } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  class FakeTorrent {
    handlers: Record<string, any[]> = {};
    infoHash: string; magnetURI: string; length: number; progress: number; done: boolean;
    constructor(infoHash: string, length: number, done: boolean) {
      this.infoHash = infoHash;
      this.magnetURI = 'magnet:?xt=urn:btih:' + infoHash;
      this.length = length; this.done = done; this.progress = done ? 1 : 0;
    }
    on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
    once(ev: string, fn: any): void { this.on(ev, fn); }
  }
  class FakeWebTorrent {
    torrents = new Map<string, FakeTorrent>();
    handlers: Record<string, any[]> = {};
    on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
    once(ev: string, fn: any): void { this.on(ev, fn); }
    removeListener(ev: string, fn: any): void {
      this.handlers[ev] = (this.handlers[ev] ?? []).filter((f) => f !== fn);
    }
    seed(p: string, _opts: any, cb: (t: any) => void): void {
      const content = fsMod.readFileSync(p);
      const infoHash = createHash('sha1').update(content).digest('hex');
      const t = this.torrents.get(infoHash) ?? new FakeTorrent(infoHash, content.length, true);
      this.torrents.set(infoHash, t);
      cb(t);
    }
    add(magnet: string, _opts: any, cb: (t: any) => void): void {
      const infoHash = /btih:([0-9a-f]+)/.exec(magnet)?.[1] ?? '';
      const t = new FakeTorrent(infoHash, 0, false); // download never completes
      this.torrents.set(infoHash, t);
      cb(t);
    }
    get(infoHash: string): FakeTorrent | null {
      return (infoHash && this.torrents.get(infoHash)) || null;
    }
    remove(t: FakeTorrent): void { this.torrents.delete(t.infoHash); }
  }
  return { default: FakeWebTorrent };
});

// Rendezvous tracker stand-in: never touches the network; the test injects
// wires by emitting 'peer' on the captured instance.
vi.mock('bittorrent-tracker', () => {
  class FakeTracker {
    handlers: Record<string, any[]> = {};
    constructor() { H.trackers.push(this); }
    on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
    emitPeer(peer: any): void { for (const fn of this.handlers['peer'] ?? []) fn(peer); }
    start(): void { /* no-op */ }
    stop(): void { /* no-op */ }
    destroy(): void { /* no-op */ }
  }
  return { default: FakeTracker };
});

/** In-memory simple-peer stand-in; a connected pair delivers each other's frames. */
class FakePeer {
  connected = true;
  other: FakePeer | null = null;
  handlers: Record<string, any[]> = {};
  on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
  once(ev: string, fn: any): void { this.on(ev, fn); }
  send(data: any): void {
    const o = this.other;
    if (!o || !o.connected) return;
    queueMicrotask(() => { for (const fn of o.handlers['data'] ?? []) fn(data); });
  }
  destroy(): void {
    this.connected = false;
    for (const fn of this.handlers['close'] ?? []) fn();
  }
}

function connect(a: { tracker: any }, b: { tracker: any }): [FakePeer, FakePeer] {
  const pA = new FakePeer(); const pB = new FakePeer();
  pA.other = pB; pB.other = pA;
  a.tracker.emitPeer(pA);
  b.tracker.emitPeer(pB);
  return [pA, pB];
}

/** A raw test-controlled peer attached to an engine (a member gone hostile: holds
 *  the code, but the test crafts every frame). Returns the sending end. */
function hostilePeer(inst: { tracker: any }): FakePeer {
  const pEngine = new FakePeer(); const pTest = new FakePeer();
  pEngine.other = pTest; pTest.other = pEngine;
  inst.tracker.emitPeer(pEngine);
  return pTest;
}

const flush = async (rounds = 25): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

type Engine = EngineCtx & { tracker?: any };

let reqSeq = 1000;
async function cmd<T = any>(inst: Engine, msg: Record<string, unknown>): Promise<T> {
  const reqId = ++reqSeq;
  inst.listeners['room-cmd'](null, { reqId, ...msg });
  await flush();
  const res = inst.sent
    .filter((s) => s.channel === 'room-res')
    .map((s) => s.payload)
    .find((p) => p?.reqId === reqId);
  if (!res) throw new Error('engine sent no response');
  if (!res.ok) throw new Error(res.error);
  return res.data as T;
}

/** Boot a fresh room-engine module instance (a simulated separate install).
 *  vi.doMock (not the hoisted vi.mock) gives EACH import its own ipcRenderer,
 *  bound by closure to that instance's ctx — a hoisted factory would run once
 *  and every engine would share the first context. */
async function makeEngine(): Promise<Engine> {
  const ctx: Engine = { listeners: {}, sent: [] };
  vi.resetModules();
  vi.doMock('electron', () => ({
    ipcRenderer: {
      on: (channel: string, fn: any) => { ctx.listeners[channel] = fn; },
      send: (channel: string, ...args: any[]) => { ctx.sent.push({ channel, payload: args[0] }); },
    },
  }));
  await import('./room-engine');
  return ctx;
}

const ROOM_ID = 'room-test-1';
const CODE = 'apple-battery-copper-dragon';

function joinPayload(label: string, folder: string, tombstones: Record<string, number> = {}) {
  const k = keysFor(label);
  return {
    type: 'join',
    payload: {
      roomId: ROOM_ID, name: 'Test room', code: CODE, folder,
      self: { memberId: k.memberId, name: label, avatarSeed: label, pub: k.pub, priv: k.priv },
      useTurn: false, turnServers: [],
      tombstones, manifest: [], ownerId: idFor('A'), mutes: [], history: [], chat: [],
      identities: {}, e2e: false, secret: '', cacheDir: '',
    },
  };
}

let dir: string;
let sourceFile: string;

beforeAll(() => {
  (globalThis as any).window = globalThis; // engine reads window.* for native WebRTC
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-revive-'));
  sourceFile = path.join(dir, 'movie.mkv');
  fs.writeFileSync(sourceFile, 'deterministic content -> deterministic fileId');
  for (const d of ['a', 'b', 'c']) fs.mkdirSync(path.join(dir, d));
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('room tombstones: delete stays deleted, explicit re-share revives', () => {
  let A: Engine; let B: Engine; let C: Engine;
  let fileId: string;
  let tombAt: number;

  it('shares a file from A and gossips it to B', async () => {
    A = await makeEngine();
    B = await makeEngine();
    await cmd(A, joinPayload('A', path.join(dir, 'a')));
    await cmd(B, joinPayload('B', path.join(dir, 'b')));
    A.tracker = H.trackers[0]; B.tracker = H.trackers[1];
    connect(A, B);
    await flush();

    const stateA = await cmd(A, { type: 'addFiles', roomId: ROOM_ID, paths: [sourceFile] });
    expect(stateA.files).toHaveLength(1);
    fileId = stateA.files[0].fileId;
    await flush();

    const stateB = await cmd(B, joinPayload('B', path.join(dir, 'b')));
    expect(stateB.files.map((f: any) => f.fileId)).toEqual([fileId]);
    // The gossiped entry keeps its provenance: clampFile used to drop
    // addedByName (history showed "added by ?") and infoHash (voiding the
    // c.get() re-entry guard for every remote file).
    expect(stateB.files[0].addedByName).toBe('A');
    expect(stateB.files[0].infoHash).toBe(fileId);
    const added = stateB.history.find((e: any) => e.type === 'file-added');
    expect(added?.actorName).toBe('A');
  });

  it('removeFile tombstones it on both sides', async () => {
    tombAt = Date.now();
    await cmd(A, { type: 'removeFile', roomId: ROOM_ID, fileId, at: tombAt });
    await flush();

    const stateA = await cmd(A, joinPayload('A', path.join(dir, 'a')));
    const stateB = await cmd(B, joinPayload('B', path.join(dir, 'b')));
    expect(stateA.files).toHaveLength(0);
    expect(stateB.files).toHaveLength(0);
    // B persisted the peer's deletion with its timestamp.
    const tomb = B.sent.find((s) => s.channel === 'room-tomb');
    expect(tomb?.payload).toMatchObject({ roomId: ROOM_ID, fileId, at: tombAt });
  });

  it('re-sharing the same content revives it for A and for connected B', async () => {
    const stateA = await cmd(A, { type: 'addFiles', roomId: ROOM_ID, paths: [sourceFile] });
    await flush();

    expect(stateA.files.map((f: any) => f.fileId)).toEqual([fileId]);
    // The revive is stamped strictly after the deletion so it wins everywhere.
    expect(stateA.files[0].addedAt).toBeGreaterThan(tombAt);
    // Both installs lifted their persisted tombstones.
    expect(A.sent.some((s) => s.channel === 'room-tomb-del' && s.payload.fileId === fileId)).toBe(true);
    expect(B.sent.some((s) => s.channel === 'room-tomb-del' && s.payload.fileId === fileId)).toBe(true);

    const stateB = await cmd(B, joinPayload('B', path.join(dir, 'b')));
    expect(stateB.files.map((f: any) => f.fileId)).toEqual([fileId]);
  });

  it('a peer that was offline during the revive converges to revived, not deleted', async () => {
    // C rejoins holding the stale tombstone it persisted before going offline.
    C = await makeEngine();
    await cmd(C, joinPayload('C', path.join(dir, 'c'), { [fileId]: tombAt }));
    C.tracker = H.trackers[2];
    connect(A, C);
    await flush();

    // C's stale tombstone (in its HELLO) must NOT kill A's newer re-share...
    const stateA = await cmd(A, joinPayload('A', path.join(dir, 'a')));
    expect(stateA.files.map((f: any) => f.fileId)).toEqual([fileId]);
    // ...and A's newer add must lift C's tombstone and bring the file back.
    const stateC = await cmd(C, joinPayload('C', path.join(dir, 'c')));
    expect(stateC.files.map((f: any) => f.fileId)).toEqual([fileId]);
    expect(C.sent.some((s) => s.channel === 'room-tomb-del' && s.payload.fileId === fileId)).toBe(true);
  });

  it('a fresh deletion still beats the revive (delete wins when newer)', async () => {
    // The owner/author deletes; a delete stamped after the revive wins everywhere.
    await cmd(A, { type: 'removeFile', roomId: ROOM_ID, fileId, at: Date.now() });
    await flush();
    for (const inst of [A, B, C]) {
      const state = await cmd(inst, joinPayload('X', path.join(dir, 'a')));
      expect(state.files).toHaveLength(0);
    }
  });

  it('a non-author, non-owner delete is dropped by everyone else', async () => {
    // Re-share so there is a live file authored by A (the owner).
    const shared = await cmd(A, { type: 'addFiles', roomId: ROOM_ID, paths: [sourceFile] });
    expect(shared.files.map((f: any) => f.fileId)).toEqual([fileId]);
    await flush();

    // B (neither the file's author nor the owner) tries to delete it for the room.
    await cmd(B, { type: 'removeFile', roomId: ROOM_ID, fileId, at: Date.now() });
    await flush();

    // B hides it locally (its own choice), but A and C keep the file — B's
    // unauthorized delete never becomes room-wide.
    const stateB = await cmd(B, joinPayload('B', path.join(dir, 'b')));
    expect(stateB.files).toHaveLength(0);
    const stateA = await cmd(A, joinPayload('A', path.join(dir, 'a')));
    const stateC = await cmd(C, joinPayload('C', path.join(dir, 'c')));
    expect(stateA.files.map((f: any) => f.fileId)).toEqual([fileId]);
    expect(stateC.files.map((f: any) => f.fileId)).toEqual([fileId]);
  });
});

describe('revive authorization: only the owner or the deleter can bring a deleted file back', () => {
  const ROOM = 'room-revive-auth';
  const OWNER_FOLDER = () => path.join(dir, 'auth-o');
  const MEMBER_FOLDER = () => path.join(dir, 'auth-m');
  function payload(label: string, folder: string, ownerLabel: string) {
    const k = keysFor(label);
    return {
      type: 'join',
      payload: {
        roomId: ROOM, name: 'Auth room', code: CODE, folder,
        self: { memberId: k.memberId, name: label, avatarSeed: label, pub: k.pub, priv: k.priv },
        useTurn: false, turnServers: [],
        tombstones: {}, manifest: [], ownerId: idFor(ownerLabel), mutes: [], history: [], chat: [],
        identities: {}, e2e: false, secret: '', cacheDir: '',
      },
    };
  }

  it('a non-owner, non-deleter re-share cannot resurrect an owner-deleted file', async () => {
    for (const d of [OWNER_FOLDER(), MEMBER_FOLDER()]) fs.mkdirSync(d, { recursive: true });
    const O = await makeEngine(); // 'AO' is the owner
    const M = await makeEngine(); // 'AM' is a plain member
    await cmd(O, payload('AO', OWNER_FOLDER(), 'AO'));
    await cmd(M, payload('AM', MEMBER_FOLDER(), 'AO'));
    O.tracker = H.trackers[H.trackers.length - 2]; M.tracker = H.trackers[H.trackers.length - 1];
    connect(O, M);
    await flush();

    const shared = await cmd(O, { type: 'addFiles', roomId: ROOM, paths: [sourceFile] });
    const fid = shared.files[0].fileId;
    await flush();
    expect((await cmd(M, payload('AM', MEMBER_FOLDER(), 'AO'))).files.map((f: any) => f.fileId)).toEqual([fid]);

    // The owner deletes it — an AUTHENTICATED tombstone lands on both installs.
    await cmd(O, { type: 'removeFile', roomId: ROOM, fileId: fid, at: Date.now() });
    await flush();
    expect((await cmd(O, payload('AO', OWNER_FOLDER(), 'AO'))).files).toHaveLength(0);
    expect((await cmd(M, payload('AM', MEMBER_FOLDER(), 'AO'))).files).toHaveLength(0);

    // The plain member re-sharing the same content is REFUSED (it cannot lift an
    // authenticated tombstone), so it can't resurrect the file for anyone.
    await expect(cmd(M, { type: 'addFiles', roomId: ROOM, paths: [sourceFile] })).rejects.toThrow(/restored/i);
    await flush();
    expect((await cmd(O, payload('AO', OWNER_FOLDER(), 'AO'))).files).toHaveLength(0);
    expect((await cmd(M, payload('AM', MEMBER_FOLDER(), 'AO'))).files).toHaveLength(0);

    // ...but the OWNER can bring it back (an authorized, signed revive).
    const revived = await cmd(O, { type: 'addFiles', roomId: ROOM, paths: [sourceFile] });
    expect(revived.files.map((f: any) => f.fileId)).toEqual([fid]);
    await flush();
    expect((await cmd(M, payload('AM', MEMBER_FOLDER(), 'AO'))).files.map((f: any) => f.fileId)).toEqual([fid]);
  }, 20000);

  it('an author deletion converges to a late joiner via a pending proof, blocking a straggler re-seed', async () => {
    const ROOM2 = 'room-revive-pending';
    const fld = (n: string) => path.join(dir, 'pend-' + n);
    for (const n of ['o', 'm', 'p', 'j']) fs.mkdirSync(fld(n), { recursive: true });
    function pl(label: string, folder: string) {
      const k = keysFor(label);
      return { type: 'join', payload: {
        roomId: ROOM2, name: 'Pending room', code: CODE, folder,
        self: { memberId: k.memberId, name: label, avatarSeed: label, pub: k.pub, priv: k.priv },
        useTurn: false, turnServers: [], tombstones: {}, manifest: [], ownerId: idFor('PO'),
        mutes: [], history: [], chat: [], identities: {}, e2e: false, secret: '', cacheDir: '',
      } };
    }
    const O = await makeEngine(); await cmd(O, pl('PO', fld('o'))); O.tracker = H.trackers[H.trackers.length - 1];
    const M = await makeEngine(); await cmd(M, pl('PM', fld('m'))); M.tracker = H.trackers[H.trackers.length - 1];
    const P = await makeEngine(); await cmd(P, pl('PP', fld('p'))); P.tracker = H.trackers[H.trackers.length - 1];
    connect(O, M);
    const [oToP] = connect(O, P); // capture O's and M's wires to P so we can cut them
    const [mToP] = connect(M, P);
    await flush();

    // Member M (NOT the owner) authors and shares X; owner O and holder P list it.
    const shared = await cmd(M, { type: 'addFiles', roomId: ROOM2, paths: [sourceFile] });
    const fid = shared.files[0].fileId;
    await flush();
    expect((await cmd(P, pl('PP', fld('p')))).files.map((f: any) => f.fileId)).toEqual([fid]);

    // P goes offline (its only wires were to O and M) BEFORE M deletes its own file,
    // so the authenticated author tombstone reaches O but never the offline P.
    oToP.destroy(); mToP.destroy();
    await cmd(M, { type: 'removeFile', roomId: ROOM2, fileId: fid, at: Date.now() });
    await flush();
    expect((await cmd(O, pl('PO', fld('o')))).files).toHaveLength(0); // owner converged on the delete
    expect((await cmd(P, pl('PP', fld('p')))).files.map((f: any) => f.fileId)).toEqual([fid]); // straggler still holds X

    // Late joiner J connects to O only: it never held X, and M isn't the owner, so
    // it can't authorize the tombstone yet — it stores the signed proof as PENDING.
    const J = await makeEngine(); await cmd(J, pl('PJ', fld('j'))); J.tracker = H.trackers[H.trackers.length - 1];
    connect(O, J);
    await flush();
    expect((await cmd(J, pl('PJ', fld('j')))).files).toHaveLength(0);

    // The straggler P (still seeding X, no tombstone) reaches J. Without the pending
    // proof J would resurrect X; with it, J recognizes M as X's author, verifies the
    // deletion, and drops the re-seed.
    connect(P, J);
    await flush();
    expect((await cmd(J, pl('PJ', fld('j')))).files).toHaveLength(0);
  }, 30000);

  it('a future-dated revive cannot make a file permanently un-deletable', async () => {
    const ROOM3 = 'room-revive-future';
    for (const n of ['fo', 'fm']) fs.mkdirSync(path.join(dir, 'fut-' + n), { recursive: true });
    const plf = (label: string) => {
      const k = keysFor(label);
      return { type: 'join', payload: {
        roomId: ROOM3, name: 'Future room', code: CODE, folder: path.join(dir, 'fut-' + (label === 'FO' ? 'fo' : 'fm')),
        self: { memberId: k.memberId, name: label, avatarSeed: label, pub: k.pub, priv: k.priv },
        useTurn: false, turnServers: [], tombstones: {}, manifest: [], ownerId: idFor('FO'),
        mutes: [], history: [], chat: [], identities: {}, e2e: false, secret: '', cacheDir: '',
      } };
    };
    const O = await makeEngine(); await cmd(O, plf('FO')); O.tracker = H.trackers[H.trackers.length - 1];
    const M = await makeEngine(); await cmd(M, plf('FM')); M.tracker = H.trackers[H.trackers.length - 1];
    connect(O, M);
    await flush();

    // Member M authors and shares X, then deletes it (author delete) — O records an
    // authenticated tombstone (proof.by = M).
    const shared = await cmd(M, { type: 'addFiles', roomId: ROOM3, paths: [sourceFile] });
    const fid = shared.files[0].fileId;
    await flush();
    await cmd(M, { type: 'removeFile', roomId: ROOM3, fileId: fid, at: Date.now() });
    await flush();
    expect((await cmd(O, plf('FO'))).files).toHaveLength(0);

    // M crafts a VALID but FUTURE-DATED revive of its own file (revAt = year 9999),
    // signed with M's own key — the attack that would otherwise plant an eternal
    // re-deletion guard and block the owner from ever removing X.
    const futureAt = 253402300799000; // year 9999
    const mk = keysFor('FM');
    const canon = Buffer.from(JSON.stringify(['revive', topicHash(CODE), fid, futureAt, mk.memberId]), 'utf8');
    const revSig = crypto.sign(null, canon, crypto.createPrivateKey(mk.priv)).toString('base64');
    const frame = encrypt(deriveKey(CODE), {
      t: 'add',
      file: {
        fileId: fid, name: 'movie.mkv', size: 1, infoHash: fid, magnetURI: shared.files[0].magnetURI,
        addedBy: mk.memberId, addedByName: 'FM', addedAt: Date.now(),
        revBy: mk.memberId, revPub: mk.pub, revAt: futureAt, revSig,
      },
    });
    hostilePeer(O).send(frame);
    await flush();

    // The future-dated revive is REJECTED: X stays deleted (not resurrected)...
    expect((await cmd(O, plf('FO'))).files).toHaveLength(0);
    // ...and no eternal guard was planted, so the owner can still delete X for good
    // (here it's already gone; re-share as owner then delete to prove moderation).
    const reshared = await cmd(O, { type: 'addFiles', roomId: ROOM3, paths: [sourceFile] });
    expect(reshared.files.map((f: any) => f.fileId)).toEqual([fid]); // owner revived it (owner authority)
    await flush();
    await cmd(O, { type: 'removeFile', roomId: ROOM3, fileId: fid, at: Date.now() });
    await flush();
    expect((await cmd(O, plf('FO'))).files).toHaveLength(0); // owner deletion still works — not blocked
  }, 30000);
});

describe('chat backfill: messages said while offline arrive on reconnect', () => {
  const ROOMC = 'room-chat-backfill';
  function cp(label: string) {
    const k = keysFor(label);
    return { type: 'join', payload: {
      roomId: ROOMC, name: 'Chat room', code: CODE, folder: path.join(dir, 'chat-' + label.toLowerCase()),
      self: { memberId: k.memberId, name: label, avatarSeed: label, pub: k.pub, priv: k.priv },
      useTurn: false, turnServers: [], tombstones: {}, manifest: [], ownerId: idFor('CA'),
      mutes: [], history: [], chat: [], identities: {}, e2e: false, secret: '', cacheDir: '',
    } };
  }
  const texts = (s: any) => s.chat.map((m: any) => m.text);

  it('a member that was offline receives the messages it missed', async () => {
    fs.mkdirSync(path.join(dir, 'chat-ca'), { recursive: true }); fs.mkdirSync(path.join(dir, 'chat-cb'), { recursive: true });
    const A = await makeEngine(); await cmd(A, cp('CA')); A.tracker = H.trackers[H.trackers.length - 1];
    const B = await makeEngine(); await cmd(B, cp('CB')); B.tracker = H.trackers[H.trackers.length - 1];
    const [aWire, bWire] = connect(A, B);
    await flush();

    // A speaks while B is online — B gets it live.
    await cmd(A, { type: 'chat', roomId: ROOMC, payload: { text: 'hello while online' } });
    await flush();
    expect(texts(await cmd(B, cp('CB')))).toContain('hello while online');

    // B goes offline; A keeps talking.
    aWire.destroy(); bWire.destroy();
    await cmd(A, { type: 'chat', roomId: ROOMC, payload: { text: 'you missed this one' } });
    await flush();
    // B hasn't received the offline message.
    expect(texts(await cmd(B, cp('CB')))).not.toContain('you missed this one');

    // B reconnects: its HELLO says how caught-up it is, and A backfills the gap.
    connect(A, B);
    await flush();
    const after = texts(await cmd(B, cp('CB')));
    expect(after).toContain('hello while online');
    expect(after).toContain('you missed this one'); // backfilled + signature re-verified
  }, 30000);
});
