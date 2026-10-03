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
import { chatCanonical, chatContextCanonical, editCanonical, voiceStateCanonical, voiceStateV2Canonical } from '../../shared/room-canonicals';
import { decrypt } from './room-crypto';
import { GuestRoom } from '../../guest/mesh';
import { generateIdentityWeb } from '../../shared/room-web-crypto';
vi.mock('../../guest/voice', () => ({ GuestVoice: class { participants() { return []; } reannounce() {} leave() {} } }));

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

// WebTorrent stand-in: infoHash comes from real single-file torrent metadata, so the fileId
// is deterministic from content — the exact property behind the original bug.
vi.mock('webtorrent', async () => {
  const { default: fsMod } = await import('node:fs');
  const { default: createTorrent } = await import('create-torrent');
  const { default: parseTorrent } = await import('parse-torrent');
  class FakeTorrent {
    handlers: Record<string, any[]> = {};
    torrentFile?: Buffer;
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
    throttleUpload(): void { /* no-op */ }
    throttleDownload(): void { /* no-op */ }
    torrents = new Map<string, FakeTorrent>();
    handlers: Record<string, any[]> = {};
    on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
    once(ev: string, fn: any): void { this.on(ev, fn); }
    removeListener(ev: string, fn: any): void {
      this.handlers[ev] = (this.handlers[ev] ?? []).filter((f) => f !== fn);
    }
    seed(p: string, opts: any, cb: (t: any) => void): void {
      createTorrent(p, { name: opts.name, announce: [] }, (error, bytes) => {
        if (error) throw error;
        const raw = Buffer.from(bytes!), meta = parseTorrent(raw);
        const t = this.torrents.get(meta.infoHash) ?? new FakeTorrent(meta.infoHash, meta.length, true);
        t.torrentFile = raw;
        this.torrents.set(meta.infoHash, t); cb(t);
      });
    }
    add(source: string | Buffer, _opts: any, cb: (t: any) => void): FakeTorrent {
      const meta = parseTorrent(source);
      const t = new FakeTorrent(meta.infoHash, meta.length || 0, Buffer.isBuffer(source));
      this.torrents.set(meta.infoHash, t);
      // A magnet has not received metadata yet, so it cannot call onready.
      if (Buffer.isBuffer(source)) { t.torrentFile = source; cb(t); }
      return t;
    }
    get(infoHash: string): FakeTorrent | null {
      return (infoHash && this.torrents.get(infoHash)) || null;
    }
    remove(t: FakeTorrent, done?: () => void): void { this.torrents.delete(t.infoHash); done?.(); }
    destroy(done?: () => void): void { this.torrents.clear(); done?.(); }
  }
  return { default: FakeWebTorrent };
});

// Rendezvous tracker stand-in: never touches the network; the test injects
// wires by emitting 'peer' on the captured instance.
vi.mock('bittorrent-tracker', () => {
  class FakeTracker {
    handlers: Record<string, any[]> = {};
    peerId: unknown;
    constructor(opts: { peerId: unknown }) { this.peerId = opts.peerId; H.trackers.push(this); }
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

// Rekey recreates the rendezvous tracker with the same local peer ID. Network
// injections must target that current instance rather than the captured old one.
const currentTracker = (inst: { tracker: { peerId: unknown } }) => H.trackers.findLast(t => t.peerId === inst.tracker.peerId) ?? inst.tracker;
function connect(a: { tracker: any }, b: { tracker: any }): [FakePeer, FakePeer] {
  const pA = new FakePeer(); const pB = new FakePeer();
  pA.other = pB; pB.other = pA;
  currentTracker(a).emitPeer(pA);
  currentTracker(b).emitPeer(pB);
  return [pA, pB];
}

/** A raw test-controlled peer attached to an engine (a member gone hostile: holds
 *  the code, but the test crafts every frame). Returns the sending end. */
function hostilePeer(inst: { tracker: any }): FakePeer {
  const pEngine = new FakePeer(); const pTest = new FakePeer();
  pEngine.other = pTest; pTest.other = pEngine;
  currentTracker(inst).emitPeer(pEngine);
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
  const res = await vi.waitFor(() => {
    const response = inst.sent
      .filter((s) => s.channel === 'room-res')
      .map((s) => s.payload)
      .find((p) => p?.reqId === reqId);
    if (!response) throw new Error('engine sent no response');
    return response;
  }, { timeout: 2000, interval: 10 });
  if (!res.ok) throw new Error(res.error);
  return res.data as T;
}

/** Boot a fresh room-engine module instance (a simulated separate install).
 *  vi.doMock (not the hoisted vi.mock) gives EACH import its own ipcRenderer,
 *  bound by closure to that instance's ctx — a hoisted factory would run once
 *  and every engine would share the first context. */
async function makeEngine(): Promise<Engine> {
  const ctx: Engine = { listeners: {}, sent: [] };
  const savedChat = new Map<string, any>();
  vi.resetModules();
  vi.doMock('electron', () => ({
    ipcRenderer: {
      on: (channel: string, fn: any) => { ctx.listeners[channel] = fn; },
      send: (channel: string, ...args: any[]) => { ctx.sent.push({ channel, payload: args[0] }); },
      invoke: async (channel: string, payload: any) => {
        if (channel === 'room-persist-chat-edit') return payload.edit;
        if (channel !== 'room-persist-chat') throw new Error('Unexpected persistence channel: ' + channel);
        const key = payload.roomId + ':' + payload.message.id, prior = savedChat.get(key);
        if (prior && (prior.text !== payload.message.text || prior.replyTo !== payload.message.replyTo)) throw new Error('Conflicting message ID');
        if (!prior) savedChat.set(key, payload.message);
        return { duplicate: !!prior, message: prior ?? payload.message };
      },
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

  it('restores 150 clock-skewed messages, quotes and an edit before its original after reconnect', async () => {
    const A = await makeEngine(); await cmd(A, cp('CA')); A.tracker = H.trackers.at(-1);
    const B = await makeEngine(); await cmd(B, cp('CB')); B.tracker = H.trackers.at(-1);
    const author = keysFor('ClockAuthor'), topic = topicHash(CODE), wireKey = deriveKey(CODE);
    const signed = (i: number, at: number, quote = false) => {
      const m = { id: 'offline-' + i, memberId: author.memberId, name: 'CA', avatarSeed: 'CA', at, text: 'missed ' + i,
        ...(quote ? { replyTo: 'offline-0', replyName: 'CA', replyText: 'edited original' } : {}) };
      return { ...m, pub: author.pub, sig: crypto.sign(null, Buffer.from(chatCanonical(topic, m)), author.priv).toString('base64'), chatV: 2,
        contextSig: crypto.sign(null, Buffer.from(chatContextCanonical(topic, m)), author.priv).toString('base64') };
    };
    const rawA = hostilePeer(A);
    rawA.send(encrypt(wireKey, { t: 'chat', ...signed(999, Date.now() + 3600000) }));
    const [wireA, wireB] = connect(A, B); await flush();
    expect((await cmd(B, cp('CB'))).chat).toHaveLength(1);
    wireA.destroy(); wireB.destroy();
    const messages = Array.from({ length: 150 }, (_, i) => signed(i, 1000 - i, i === 80));
    const edit = { msgId: messages[0].id, memberId: author.memberId, at: 2000, text: 'edited original' };
    rawA.send(encrypt(wireKey, { t: 'chat-edit', ...edit, pub: author.pub, sig: crypto.sign(null, Buffer.from(editCanonical(topic, edit)), author.priv).toString('base64') }));
    for (const m of messages) rawA.send(encrypt(wireKey, { t: 'chat', ...m }));
    await flush();
    expect((await cmd(A, cp('CA'))).chat).toHaveLength(151); // full snapshot beyond the old 100-message tail
    const rawB = hostilePeer(B), quoted = messages[80];
    rawB.send(encrypt(wireKey, { t: 'chat', ...quoted, replyText: 'forged' }));
    await flush();
    expect((await cmd(B, cp('CB'))).chat).toHaveLength(1);
    // A legacy relay can remove the additive signature. It must be marked legacy
    // and must not prevent the authenticated context arriving on reconciliation.
    const legacy = { ...quoted } as any; delete legacy.chatV; delete legacy.contextSig;
    rawB.send(encrypt(wireKey, { t: 'chat', ...legacy, replyTo: 'forged-parent' }));
    await flush();
    expect((await cmd(B, cp('CB'))).chat.at(-1).chatV).toBeUndefined();
    connect(A, B); await flush();
    const snapshot = await cmd(B, cp('CB'));
    expect(snapshot.chat.map((m: any) => m.id)).toEqual(['offline-999', quoted.id, ...messages.filter(m => m.id !== quoted.id).map(m => m.id)]);
    expect(snapshot.chat[1]).toMatchObject({ replyTo: 'offline-0', replyName: 'CA', replyText: 'edited original', chatV: 2 });
    expect(snapshot.chatEdits['offline-0'].text).toBe('edited original');
    connect(A, B); await flush();
    expect((await cmd(B, cp('CB'))).chat).toHaveLength(151);
  }, 30000);

  it('exchanges signed replies and history with the actual browser guest mesh', async () => {
    const A = await makeEngine(); await cmd(A, cp('CA')); A.tracker = H.trackers.at(-1);
    for (let i = 0; i < 150; i++) await cmd(A, { type: 'chat', roomId: ROOMC, payload: { text: 'desktop ' + i, id: i.toString(16).padStart(32, '0') } });
    const guest = new GuestRoom({ identity: await generateIdentityWeb(), name: 'Web guest', avatarSeed: 'guest', trackers: [], onChange() {} });
    const g = guest as any;
    g.key = new Uint8Array(deriveKey(CODE)); g.topic = topicHash(CODE); g.ownerId = idFor('CA');
    g.identities.set(guest.identity.memberId, guest.identity.pub);
    const pEngine = new FakePeer(), pGuest = new FakePeer();
    pEngine.other = pGuest; pGuest.other = pEngine;
    g.attach({ get connected() { return pGuest.connected; }, send: (raw: string) => pGuest.send(raw), destroy: () => pGuest.destroy(),
      onData: (cb: (raw: string) => void) => pGuest.on('data', (raw: string) => cb(String(raw))), onClose: (cb: () => void) => pGuest.on('close', cb) });
    A.tracker.emitPeer(pEngine);
    await vi.waitFor(() => expect(guest.snapshot().chat).toHaveLength(150), { timeout: 5000 });
    const parent = guest.snapshot().chat[0];
    await guest.sendChat('reply from browser', parent.id);
    await vi.waitFor(async () => expect(texts(await cmd(A, cp('CA')))).toContain('reply from browser'), { timeout: 5000 });
    const snapshot = await cmd(A, cp('CA'));
    expect(snapshot.chat.at(-1)).toMatchObject({ replyTo: parent.id, replyText: parent.text, chatV: 2, memberId: guest.identity.memberId });
    await cmd(A, { type: 'chat', roomId: ROOMC, payload: { text: 'desktop reply', replyTo: snapshot.chat.at(-1).id } });
    await vi.waitFor(() => expect(guest.snapshot().chat.at(-1)?.text).toBe('desktop reply'), { timeout: 5000 });
    expect(guest.snapshot().chat.at(-1)).toMatchObject({ chatV: 2, replyText: 'reply from browser' });
    pEngine.destroy(); pGuest.destroy();
  }, 30000);

  it('a member that was offline receives the messages it missed', async () => {
    fs.mkdirSync(path.join(dir, 'chat-ca'), { recursive: true }); fs.mkdirSync(path.join(dir, 'chat-cb'), { recursive: true });
    const A = await makeEngine(); await cmd(A, cp('CA')); A.tracker = H.trackers[H.trackers.length - 1];
    const B = await makeEngine(); await cmd(B, cp('CB')); B.tracker = H.trackers[H.trackers.length - 1];
    const [aWire, bWire] = connect(A, B);
    await flush();

    // A speaks while B is online — B gets it live.
    const chatId = 'a'.repeat(32);
    const acknowledgment = await cmd(A, { type: 'chat', roomId: ROOMC, payload: { id: chatId, text: 'hello while online' } });
    expect(acknowledgment).toEqual({ ok: true, id: chatId, state: 'saved-locally' });
    await cmd(A, { type: 'chat', roomId: ROOMC, payload: { id: chatId, text: 'hello while online' } });
    await flush();
    expect(texts(await cmd(B, cp('CB')))).toContain('hello while online');
    expect(texts(await cmd(B, cp('CB'))).filter((text: string) => text === 'hello while online')).toHaveLength(1);

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


describe('desktop room protocol boundary', () => {
  it('drops malformed/forged gossip before relay and still accepts the valid frame with that id', async () => {
    const A = await makeEngine(); await cmd(A, joinPayload('A', path.join(dir, 'a'))); A.tracker = H.trackers.at(-1);
    const B = await makeEngine(); await cmd(B, joinPayload('B', path.join(dir, 'b'))); B.tracker = H.trackers.at(-1);
    const [, wireB] = connect(A, B); await flush();
    const relayed: any[] = []; wireB.on('data', (raw: any) => relayed.push(decrypt(deriveKey(CODE), raw)));
    const raw = hostilePeer(A), k = keysFor('WireAuthor');
    const body = { id: 'valid-after-malformed', at: Date.now(), memberId: k.memberId, name: 'Author', avatarSeed: 'author', text: 'valid' };
    const m = { t: 'chat', ...body, pub: k.pub, sig: crypto.sign(null, Buffer.from(chatCanonical(topicHash(CODE), body)), k.priv).toString('base64'), _g: 'shared-gossip-id', _t: 4 };
    for (const value of [null, false, 7, [], 'frame', { t: 'unknown', _g: 'future' }, { ...m, text: 'forged' }]) raw.send(encrypt(deriveKey(CODE), value));
    await flush();
    expect(relayed.filter(x => x.t === 'chat')).toEqual([]);
    raw.send(encrypt(deriveKey(CODE), m)); await flush();
    expect(relayed.filter(x => x.t === 'chat')).toEqual([{ ...m, _t: 3 }]);
    expect((await cmd(B, { type: 'snapshot', roomId: ROOM_ID })).chat.at(-1).text).toBe('valid');
  }, 15000);
  it('keeps local history after rekey and sends current manifests/chat to a late joiner without stale proofs', async () => {
    const roomId = 'protocol-rotation', join = (label: string, code = CODE) => {
      const p = joinPayload(label, path.join(dir, 'a')); p.payload.roomId = roomId; p.payload.code = code; return p;
    };
    const A = await makeEngine(); await cmd(A, join('A')); A.tracker = H.trackers.at(-1);
    const B = await makeEngine(); await cmd(B, join('B')); B.tracker = H.trackers.at(-1);
    connect(A, B); await flush();
    await cmd(A, { type: 'addFiles', roomId, paths: [sourceFile] });
    await cmd(A, { type: 'setTopic', roomId, text: 'topic before rotation' });
    const old = await cmd(A, { type: 'chat', roomId, payload: { text: 'old history' } });
    await cmd(A, { type: 'editChat', roomId, payload: { msgId: old.id, text: 'old edited' } });
    await cmd(A, { type: 'kick', roomId, memberId: idFor('C') });
    await new Promise(resolve => setTimeout(resolve, 400)); await flush();
    const code = A.sent.filter(x => x.channel === 'room-rekey').at(-1)?.payload.code;
    expect(code).toBeTruthy();
    await cmd(A, { type: 'chat', roomId, payload: { text: 'current history' } }); await flush();
    expect((await cmd(A, { type: 'snapshot', roomId })).chat).toHaveLength(2);
    const C = await makeEngine(); await cmd(C, join('FreshJoiner', code)); C.tracker = H.trackers.at(-1);
    connect(B, C); await flush(100);
    const late = await cmd(C, { type: 'snapshot', roomId });
    expect(late.files).toHaveLength(1);
    expect(late.chat.map((m: any) => m.text)).toEqual(['current history']);
  }, 20000);
  it('exchanges signed watch controls with the browser guest and refuses replay, forgery and legacy controls', async () => {
    const A = await makeEngine(); await cmd(A, joinPayload('A', path.join(dir, 'a'))); A.tracker = H.trackers.at(-1);
    const state = await cmd(A, { type: 'addFiles', roomId: ROOM_ID, paths: [sourceFile] });
    const fileId = state.files[0].fileId;
    const guest = new GuestRoom({ identity: await generateIdentityWeb(), name: 'Guest', avatarSeed: 'guest', trackers: [], onChange() {} });
    const internals = guest as any; internals.key = new Uint8Array(deriveKey(CODE)); internals.topic = topicHash(CODE); internals.code = CODE;
    const pEngine = new FakePeer(), pGuest = new FakePeer(); pEngine.other = pGuest; pGuest.other = pEngine;
    internals.attach({ get connected() { return pGuest.connected; }, send: (raw: string) => pGuest.send(raw),
      destroy: () => pGuest.destroy(), onData: (fn: any) => pGuest.on('data', fn), onClose: (fn: any) => pGuest.on('close', fn) });
    A.tracker.emitPeer(pEngine); await flush(100);
    const events: any[] = []; guest.onSync = ev => events.push(ev);
    const control = { fileId, action: 'play', position: 42, rate: 1.5, playing: true, together: true };
    await cmd(A, { type: 'sync', roomId: ROOM_ID, payload: control }); await flush(30);
    expect(events.at(-1)).toMatchObject({ ...control, memberId: idFor('A') });
    await guest.sendSync({ ...control, action: 'seek', at: Date.now() }); await flush(30);
    expect(A.sent.filter(x => x.channel === 'room-sync').at(-1)?.payload).toMatchObject({ ...control, action: 'seek', memberId: guest.identity.memberId });
    const captured: any[] = []; pEngine.on('data', (raw: any) => captured.push(decrypt(deriveKey(CODE), raw)));
    await guest.sendSync({ ...control, action: 'beat', at: Date.now() }); await flush(30);
    const beat = captured.find(x => x.t === 'sync-v2'), count = A.sent.filter(x => x.channel === 'room-sync').length;
    pGuest.send(encrypt(deriveKey(CODE), { ...beat, _g: 'replay' }));
    pGuest.send(encrypt(deriveKey(CODE), { ...beat, _g: 'forged', position: 999 }));
    pGuest.send(encrypt(deriveKey(CODE), { ...beat, _g: 'legacy', t: 'sync' })); await flush(30);
    expect(A.sent.filter(x => x.channel === 'room-sync')).toHaveLength(count);
    guest.leave(); await flush();
  }, 20000);
});


describe('desktop and browser authority convergence', () => {
  async function attachGuest(engine: Engine, pin: string) {
    const guest = new GuestRoom({ identity: await generateIdentityWeb(), name: 'Guest', avatarSeed: 'guest', trackers: [], onChange() {} });
    const internals = guest as any; internals.key = new Uint8Array(deriveKey(CODE)); internals.topic = topicHash(CODE); internals.code = CODE;
    guest.ownerPin = pin;
    const desktop = new FakePeer(), browser = new FakePeer(); desktop.other = browser; browser.other = desktop;
    internals.attach({ get connected() { return browser.connected; }, send: (raw: string) => browser.send(raw), destroy: () => browser.destroy(),
      onData: (fn: any) => browser.on('data', fn), onClose: (fn: any) => browser.on('close', fn) });
    engine.tracker.emitPeer(desktop); await flush(100);
    return guest;
  }
  it('converges on author delete/revive, live transfer and late root/current invite; refuses assigning management to a browser', async () => {
    const A = await makeEngine(); await cmd(A, joinPayload('A', path.join(dir, 'a'))); A.tracker = H.trackers.at(-1);
    const B = await makeEngine(); await cmd(B, joinPayload('B', path.join(dir, 'b'))); B.tracker = H.trackers.at(-1);
    connect(A, B); await flush(50);
    const state = await cmd(B, { type: 'addFiles', roomId: ROOM_ID, paths: [sourceFile] }); await flush(50);
    const id = state.files[0].fileId, guest = await attachGuest(A, idFor('A'));
    expect(guest.snapshot().files[0].addedBy).toBe(idFor('B'));
    await cmd(B, { type: 'removeFile', roomId: ROOM_ID, fileId: id }); await flush(50);
    expect(guest.snapshot().files).toEqual([]);
    await cmd(B, { type: 'addFiles', roomId: ROOM_ID, paths: [sourceFile] }); await flush(50);
    expect(guest.snapshot().files).toHaveLength(1);
    await cmd(A, { type: 'transferOwner', roomId: ROOM_ID, memberId: idFor('B') }); await flush(50);
    expect(guest.ownerId).toBe(idFor('B'));
    await cmd(B, { type: 'rename', roomId: ROOM_ID, name: 'Browser follows new owner' }); await flush(50);
    expect(guest.roomName).toBe('Browser follows new owner');
    await expect(cmd(B, { type: 'transferOwner', roomId: ROOM_ID, memberId: guest.identity.memberId })).rejects.toThrow(/desktop|management/i);
    const rootGuest = await attachGuest(B, idFor('A')), currentGuest = await attachGuest(B, idFor('B'));
    for (const g of [rootGuest, currentGuest]) {
      expect(g.ownerId).toBe(idFor('B')); expect(g.snapshot().files).toHaveLength(1);
      expect(g.snapshot().members.find(m => m.memberId === idFor('B'))?.capabilities).toContain('owner-manage');
    }
    await cmd(B, { type: 'pinOwner', roomId: ROOM_ID, ownerPin: idFor('A') });
    await cmd(B, { type: 'pinOwner', roomId: ROOM_ID, ownerPin: idFor('B') });
    await expect(cmd(B, { type: 'pinOwner', roomId: ROOM_ID, ownerPin: idFor('C') })).rejects.toThrow(/conflict/i);
    expect((await cmd(B, { type: 'snapshot', roomId: ROOM_ID })).ownerId).toBe(idFor('B'));
    for (const g of [guest, rootGuest, currentGuest]) g.leave(); await flush();
    await cmd(A, { type: 'leave', roomId: ROOM_ID }); await cmd(B, { type: 'leave', roomId: ROOM_ID });
  }, 20000);

  it('does not accept a foreign pending tomb as authority to protect a revived manifest from owner deletion', async () => {
    const A = await makeEngine(), join = joinPayload('D', path.join(dir, 'a')); (join.payload as any).autoFetch = false;
    await cmd(A, join); A.tracker = H.trackers.at(-1);
    const wire = hostilePeer(A), c = keysFor('C'), owner = keysFor('A'), fileId = 'f'.repeat(40), topic = topicHash(CODE);
    const signed = (who: { priv: string }, body: unknown[]) => crypto.sign(null, Buffer.from(JSON.stringify(body)), who.priv).toString('base64');
    wire.send(encrypt(deriveKey(CODE), { t: 'del', fileId, memberId: c.memberId, at: 40, pub: c.pub, sig: signed(c, ['del', topic, fileId, c.memberId, 40]) }));
    wire.send(encrypt(deriveKey(CODE), { t: 'add', file: { fileId, infoHash: fileId, name: 'pending.mkv', magnetURI: 'magnet:?xt=urn:btih:' + fileId,
      size: 10, addedBy: idFor('B'), addedByName: 'B', addedAt: 1, revAt: 40, revBy: c.memberId, revPub: c.pub,
      revSig: signed(c, ['revive', topic, fileId, 40, c.memberId]) } })); await flush();
    expect((await cmd(A, { type: 'snapshot', roomId: ROOM_ID })).files).toHaveLength(1);
    wire.send(encrypt(deriveKey(CODE), { t: 'del', fileId, memberId: owner.memberId, at: 30, pub: owner.pub, sig: signed(owner, ['del', topic, fileId, owner.memberId, 30]) })); await flush();
    expect((await cmd(A, { type: 'snapshot', roomId: ROOM_ID })).files).toEqual([]);
    await cmd(A, { type: 'leave', roomId: ROOM_ID });
  });

  it('requires known voice membership, authenticates deafened, and refuses replay or a downgrade', async () => {
    const A = await makeEngine(); await cmd(A, joinPayload('A', path.join(dir, 'a'))); A.tracker = H.trackers.at(-1);
    const wire = hostilePeer(A), k = keysFor('C'), topic = topicHash(CODE);
    const send = (msg: any) => wire.send(encrypt(deriveKey(CODE), msg));
    const state = (at: number, extra: any = {}, v2 = true) => {
      const m = { memberId: k.memberId, inVoice: true, muted: false, deafened: false, at, ...extra };
      const sign = (bytes: Uint8Array) => crypto.sign(null, bytes, k.priv).toString('base64');
      return { t: 'voice-state', ...m, pub: k.pub, sig: sign(voiceStateCanonical(topic, m)),
        ...(v2 ? { voiceV: 2, stateSig: sign(voiceStateV2Canonical(topic, m)) } : {}) };
    };
    send(state(10)); await flush(); expect((await cmd(A, { type: 'snapshot', roomId: ROOM_ID })).voice.participants).toEqual([]);
    send({ t: 'hello', memberId: k.memberId, pub: k.pub, name: 'C', avatarSeed: 'C' }); await flush();
    send(state(10, { deafened: true }, false)); await flush();
    expect((await cmd(A, { type: 'snapshot', roomId: ROOM_ID })).voice.participants[0].deafened).toBe(false);
    const signed = state(20, { deafened: true }); send({ ...signed, deafened: false }); await flush();
    expect((await cmd(A, { type: 'snapshot', roomId: ROOM_ID })).voice.participants[0].deafened).toBe(false);
    send(signed); await flush(); expect((await cmd(A, { type: 'snapshot', roomId: ROOM_ID })).voice.participants[0].deafened).toBe(true);
    send(state(21, {}, false)); await flush(); expect((await cmd(A, { type: 'snapshot', roomId: ROOM_ID })).voice.participants[0].deafened).toBe(true);
    send(state(30, { inVoice: false })); send({ ...signed, _g: 'new-gossip-id' }); await flush();
    expect((await cmd(A, { type: 'snapshot', roomId: ROOM_ID })).voice.participants).toEqual([]);
    await cmd(A, { type: 'leave', roomId: ROOM_ID });
  }, 20000);
});
