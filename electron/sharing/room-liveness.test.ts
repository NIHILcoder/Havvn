/**
 * Integration test for gossip liveness: typing indicators, file reactions and
 * coarse download progress.
 *
 * Same harness as room-revive/room-limits: REAL room-engine instances with the
 * Electron/WebTorrent/tracker boundaries mocked, wired together with in-memory
 * peers. The FakePeer additionally RECORDS every frame it sends, and the test
 * decrypts them with the room key (real room-crypto) to assert exactly which
 * gossip went on the wire — that's how the typing rate-limit and the 10%-step
 * progress throttle are verified, not just the converged state.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deriveKey, encrypt, decrypt } from './room-crypto';

type Sent = { channel: string; payload: any };
type EngineCtx = {
  listeners: Record<string, (e: any, msg: any) => void>;
  sent: Sent[];
};

const H = vi.hoisted(() => ({
  catalog: new Map<string, { raw: Buffer; source: string }>(),
  trackers: [] as any[],   // FakeTracker instances in creation order
  clients: [] as any[],    // FakeWebTorrent instances in creation order
}));

// WebTorrent stand-in: infoHash comes from real torrent metadata (deterministic
// fileId); downloads never complete on their own — the test drives progress by
// mutating torrent.progress and emitting 'download' / 'done'.
vi.mock('webtorrent', async () => {
  const { default: fsMod } = await import('node:fs');
  const { default: createTorrent } = await import('create-torrent');
  const { default: parseTorrent } = await import('parse-torrent');
  class FakeTorrent {
    handlers: Record<string, any[]> = {};
    torrentFile?: Buffer; downloadPath?: string;
    infoHash: string; magnetURI: string; length: number; progress: number; done: boolean;
    constructor(infoHash: string, length: number, done: boolean) {
      this.infoHash = infoHash;
      this.magnetURI = 'magnet:?xt=urn:btih:' + infoHash;
      this.length = length; this.done = done; this.progress = done ? 1 : 0;
    }
    on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
    once(ev: string, fn: any): void { this.on(ev, fn); }
    emit(ev: string): void { if (ev === 'done' && this.downloadPath) fsMod.copyFileSync(H.catalog.get(this.infoHash)!.source, this.downloadPath); for (const fn of this.handlers[ev] ?? []) fn(); }
  }
  class FakeWebTorrent {
    torrents = new Map<string, FakeTorrent>();
    handlers: Record<string, any[]> = {};
    constructor(_opts: any) { H.clients.push(this); }
    on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
    once(ev: string, fn: any): void { this.on(ev, fn); }
    removeListener(ev: string, fn: any): void {
      this.handlers[ev] = (this.handlers[ev] ?? []).filter((f) => f !== fn);
    }
    throttleUpload(): void { /* no-op */ }
    throttleDownload(): void { /* no-op */ }
    destroy(): void { /* no-op */ }
    seed(p: string, opts: any, cb: (t: any) => void): void {
      createTorrent(p, { name: opts.name, announce: [] }, (error, bytes) => {
        if (error) throw error;
        const raw = Buffer.from(bytes!), meta = parseTorrent(raw);
        const t = this.torrents.get(meta.infoHash) ?? new FakeTorrent(meta.infoHash, meta.length, true);
        t.torrentFile = raw; H.catalog.set(meta.infoHash, { raw, source: p });
        this.torrents.set(meta.infoHash, t); cb(t);
      });
    }
    add(source: string | Buffer, opts: any, cb: (t: any) => void): FakeTorrent {
      const parsed = parseTorrent(source), raw = Buffer.isBuffer(source) ? source : H.catalog.get(parsed.infoHash)?.raw;
      const meta = raw ? parseTorrent(raw) : parsed;
      const t = new FakeTorrent(meta.infoHash, meta.length || 0, false);
      t.torrentFile = raw; t.downloadPath = raw ? opts.path + '/' + meta.name : undefined;
      this.torrents.set(meta.infoHash, t);
      if (raw) cb(t);
      return t;
    }
    get(infoHash: string): FakeTorrent | null {
      return (infoHash && this.torrents.get(infoHash)) || null;
    }
    remove(t: FakeTorrent, done?: () => void): void { this.torrents.delete(t.infoHash); done?.(); }
  }
  return { default: FakeWebTorrent };
});

vi.mock('bittorrent-tracker', () => {
  class FakeTracker {
    handlers: Record<string, any[]> = {};
    announce: string[];
    constructor(opts: { announce: string[] }) { this.announce = opts.announce; H.trackers.push(this); }
    on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
    emitPeer(peer: any): void { for (const fn of this.handlers['peer'] ?? []) fn(peer); }
    start(): void { /* no-op */ }
    stop(): void { /* no-op */ }
    destroy(): void { /* no-op */ }
  }
  return { default: FakeTracker };
});

/** In-memory simple-peer stand-in; records every outgoing frame for the test
 *  to decrypt, then delivers it to the paired peer. */
class FakePeer {
  connected = true;
  other: FakePeer | null = null;
  handlers: Record<string, any[]> = {};
  sentFrames: any[] = [];
  on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
  once(ev: string, fn: any): void { this.on(ev, fn); }
  send(data: any): void {
    this.sentFrames.push(data);
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

const flush = async (rounds = 25): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

type Engine = EngineCtx & { tracker?: any };

let reqSeq = 5000;
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

const ROOM_ID = 'room-liveness-1';
const CODE = 'ember-forest-granite-harbor';
const KEY = deriveKey(CODE);

/** Decrypt the frames a FakePeer sent and keep those of one gossip type. */
function sentMsgs(peer: FakePeer, t: string): any[] {
  const out: any[] = [];
  for (const f of peer.sentFrames) {
    try {
      const m = decrypt<any>(KEY, typeof f === 'string' ? f : Buffer.from(f).toString('utf8'));
      if (m?.t === t) out.push(m);
    } catch { /* a frame we crafted with junk — ignore */ }
  }
  return out;
}

function joinPayload(memberId: string, folder: string) {
  return {
    type: 'join',
    payload: {
      roomId: ROOM_ID, name: 'Liveness room', code: CODE, folder,
      self: { memberId, name: memberId, avatarSeed: memberId, pub: '', priv: '' },
      useTurn: false, turnServers: [],
      tombstones: {}, manifest: [], ownerId: 'A', mutes: [], history: [], chat: [],
      identities: {}, e2e: false, secret: '', cacheDir: '',
    },
  };
}

const snapshot = (inst: Engine) => cmd(inst, { type: 'snapshot', roomId: ROOM_ID });

let dir: string;
let sourceFile: string;

beforeAll(() => {
  (globalThis as any).window = globalThis; // engine reads window.* for native WebRTC
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-liveness-'));
  sourceFile = path.join(dir, 'show.mkv');
  fs.writeFileSync(sourceFile, 'liveness test content');
  for (const d of ['a', 'b', 'c']) fs.mkdirSync(path.join(dir, d));
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('room liveness: file reactions, typing, coarse progress', () => {
  let A: Engine; let B: Engine; let C: Engine;
  let pA: FakePeer; let pB: FakePeer;
  let fileId: string;

  it('sets up two members sharing one file', async () => {
    A = await makeEngine();
    B = await makeEngine();
    await cmd(A, joinPayload('A', path.join(dir, 'a')));
    await cmd(B, joinPayload('B', path.join(dir, 'b')));
    A.tracker = H.trackers[0]; B.tracker = H.trackers[1];
    [pA, pB] = connect(A, B);
    await flush();

    const stateA = await cmd(A, { type: 'addFiles', roomId: ROOM_ID, paths: [sourceFile] });
    fileId = stateA.files[0].fileId;
    await flush();
    const stateB = await snapshot(B);
    expect(stateB.files.map((f: any) => f.fileId)).toEqual([fileId]);
  });

  it('a reaction toggles on for both sides — and toggles back off', async () => {
    await cmd(B, { type: 'reactFile', roomId: ROOM_ID, fileId, emoji: '🔥' });
    await flush();
    expect((await snapshot(B)).fileReacts[fileId]['🔥']).toEqual(['B']);
    expect((await snapshot(A)).fileReacts[fileId]['🔥']).toEqual(['B']);
    // Both installs persisted the map (sender AND receiver survive restart).
    for (const inst of [A, B]) {
      const last = inst.sent.filter((s) => s.channel === 'room-reacts').pop();
      expect(last?.payload.reacts[fileId]['🔥']).toEqual(['B']);
    }

    // Same command again = toggle OFF, converging everywhere.
    await cmd(B, { type: 'reactFile', roomId: ROOM_ID, fileId, emoji: '🔥' });
    await flush();
    expect((await snapshot(B)).fileReacts[fileId]).toBeUndefined();
    expect((await snapshot(A)).fileReacts[fileId]).toBeUndefined();
    const offMsgs = sentMsgs(pB, 'react-file');
    expect(offMsgs.map((m) => m.on)).toEqual([true, false]);
  });

  it('non-whitelisted emoji are rejected — own command AND hostile gossip', async () => {
    await expect(cmd(B, { type: 'reactFile', roomId: ROOM_ID, fileId, emoji: '💀' }))
      .rejects.toThrow(/Unsupported reaction/);

    // A malicious member skips the engine and injects the frame directly.
    pB.send(encrypt(KEY, { t: 'react-file', memberId: 'B', fileId, emoji: '💀', on: true }));
    pB.send(encrypt(KEY, { t: 'react-file', memberId: 'B', fileId, emoji: 'x'.repeat(500), on: true }));
    await flush();
    expect((await snapshot(A)).fileReacts[fileId]).toBeUndefined();
  });

  it('a late joiner unions existing reactions from HELLO', async () => {
    await cmd(B, { type: 'reactFile', roomId: ROOM_ID, fileId, emoji: '🔥' });
    await cmd(A, { type: 'reactFile', roomId: ROOM_ID, fileId, emoji: '👍' });
    await flush();

    C = await makeEngine();
    await cmd(C, joinPayload('C', path.join(dir, 'c')));
    C.tracker = H.trackers[2];
    connect(A, C);
    await flush();

    const stateC = await snapshot(C);
    expect(stateC.fileReacts[fileId]['🔥']).toEqual(['B']);
    expect(stateC.fileReacts[fileId]['👍']).toEqual(['A']);
    // The merge is persisted like any other reaction change.
    const last = C.sent.filter((s) => s.channel === 'room-reacts').pop();
    expect(last?.payload.reacts[fileId]['👍']).toEqual(['A']);
  });

  it('typing broadcasts are rate-limited, stamp peers, and expire after the TTL', async () => {
    const before = sentMsgs(pB, 'typing').length;
    // Three keystroke-driven calls in quick succession → ONE broadcast (≥2s gap).
    await cmd(B, { type: 'typing', roomId: ROOM_ID });
    await cmd(B, { type: 'typing', roomId: ROOM_ID });
    await cmd(B, { type: 'typing', roomId: ROOM_ID });
    expect(sentMsgs(pB, 'typing').length - before).toBe(1);

    // A sees B typing; B never lists itself.
    expect((await snapshot(A)).typingMemberIds).toEqual(['B']);
    expect((await snapshot(B)).typingMemberIds).toEqual([]);

    // 5s later the stamp is stale and drops out of the state.
    const realNow = Date.now;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + 5000);
    try {
      expect((await snapshot(A)).typingMemberIds).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("coarse progress gossips only on 10% steps and yields to 'have' on completion", async () => {
    // B's client is the one still downloading the file (A's seeds it, done).
    const cB = H.clients.find((c) => c.torrents.get(fileId)?.done === false);
    expect(cB).toBeTruthy();
    const t = cB.torrents.get(fileId);
    const before = sentMsgs(pB, 'prog').length;

    t.progress = 0.05; t.emit('download'); await flush();  // below the first step — silent
    t.progress = 0.34; t.emit('download'); await flush();  // crosses 30
    t.progress = 0.38; t.emit('download'); await flush();  // same step — silent
    t.progress = 0.71; t.emit('download'); await flush();  // crosses 70

    const progs = sentMsgs(pB, 'prog').slice(before);
    expect(progs.map((m) => m.pct)).toEqual([30, 70]);
    expect((await snapshot(A)).memberProg['B'][fileId]).toBe(70);

    // Completion rides the normal 'have': the coarse entry disappears (100 is
    // implicit in the member's have list).
    t.progress = 1; t.done = true;
    t.emit('done'); await flush();
    const stateA = await snapshot(A);
    expect(stateA.members.find((m: any) => m.memberId === 'B').have).toContain(fileId);
    expect(stateA.memberProg['B']).toBeUndefined();
    expect(sentMsgs(pB, 'prog').slice(before).map((m) => m.pct)).toEqual([30, 70]); // no extra frames
  });
});

describe('room connection diagnostics on real engine commands and peer frames', () => {
  it('tracks discovery, handshake and sync, and retries without dropping established peers', async () => {
    const A = await makeEngine(); await cmd(A, joinPayload('A', path.join(dir, 'a')));
    A.tracker = H.trackers.at(-1);
    const B = await makeEngine(); await cmd(B, joinPayload('B', path.join(dir, 'b')));
    B.tracker = H.trackers.at(-1);
    try {
      expect((await snapshot(A)).connection.phase).toBe('discovering');
      A.tracker.handlers.update[0]({ announce: A.tracker.announce[0] });
      expect((await snapshot(A)).connection).toMatchObject({ phase: 'waiting', trackers: { acknowledged: 1 } });
      const pA = new FakePeer(), pB = new FakePeer(); pA.connected = false;
      A.tracker.emitPeer(pA);
      expect((await snapshot(A)).connection.phase).toBe('connecting');
      Object.assign(pA, { _pc: { getStats: async () => new Map([
        ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
        ['pair', { type: 'candidate-pair', id: 'pair', localCandidateId: 'local', remoteCandidateId: 'remote' }],
        ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay' }],
        ['remote', { id: 'remote', type: 'remote-candidate', candidateType: 'host' }],
      ]) } });
      pA.connected = true; pA.handlers.connect[0]();
      expect((await snapshot(A)).connection.phase).toBe('authenticating');
      pA.other = pB; pB.other = pA; B.tracker.emitPeer(pB); await flush();
      const established = (await snapshot(A)).connection;
      expect(established).toMatchObject({ phase: 'ready', channels: { open: 1, identified: 1, turn: 1 } });
      expect(established.lastSyncAt).toBeGreaterThan(0);
      const full = sentMsgs(pB, 'hello').find(m => m.manifestFull === true); expect(full).toBeTruthy();
      pA.handlers.data[0](encrypt(KEY, { ...full, manifestFull: false, files: [] }));
      pA.handlers.data[0]('malformed-frame');
      pA.handlers.data[0](encrypt(KEY, { t: 'hello', manifestFull: 'invalid-marker' }));
      const after = (await snapshot(A)).connection;
      expect(after.phase).toBe('ready'); expect(after.lastConnectedAt).toBe(established.lastConnectedAt);
      expect(after.observations).toMatchObject({ 'frame-unreadable': 1, 'message-rejected': 1 });
      const oldTracker = A.tracker;
      const retried = await cmd(A, { type: 'retryConnection', roomId: ROOM_ID });
      expect(retried.connection).toMatchObject({ phase: 'ready', channels: { open: 1 }, trackers: { acknowledged: 0 }, observations: { 'discovery-retry': 1 } });
      expect(pA.connected).toBe(true);
      oldTracker.handlers.error[0](new Error('PRIVATE_TRACKER_DETAIL'));
      oldTracker.handlers.update[0]({ announce: oldTracker.announce[0] });
      const stalePeer = new FakePeer(); oldTracker.emitPeer(stalePeer);
      expect(stalePeer.connected).toBe(false);
      expect((await snapshot(A)).connection.observations['tracker-unavailable']).toBe(0);
      pA.destroy(); expect((await snapshot(A)).connection.phase).toBe('waiting');
    } finally {
      await cmd(A, { type: 'leave', roomId: ROOM_ID }); await cmd(B, { type: 'leave', roomId: ROOM_ID });
    }
  });
});


describe('manifest paging through real room engines', () => {
  it('persists an unpaged legacy greeting in bounded batches without losing files', async () => {
    const a = await makeEngine(), b = await makeEngine();
    const pa = joinPayload('A', path.join(dir, 'legacy-a')), pb = joinPayload('B', path.join(dir, 'legacy-b'));
    Object.assign(pa.payload, { autoFetch: false }); Object.assign(pb.payload, { autoFetch: false });
    await cmd(a, pa); a.tracker = H.trackers.at(-1);
    await cmd(b, pb); b.tracker = H.trackers.at(-1);
    const [wire] = connect(a, b);
    try {
      await flush();
      const hello = sentMsgs(wire, 'hello').find(m => m.manifestFull === true);
      expect(hello).toBeTruthy();
      const files = Array.from({ length: 500 }, (_, i) => ({ fileId: i.toString(16).padStart(40, '0'),
        infoHash: i.toString(16).padStart(40, '0'), name: 'Legacy ' + i + '.mkv', size: i,
        magnetURI: 'magnet:?xt=urn:btih:' + i.toString(16).padStart(40, '0'), addedBy: 'A', addedByName: 'A', addedAt: 1 }));
      wire.send(encrypt(KEY, { ...hello, files }));
      await vi.waitFor(async () => expect((await snapshot(b)).files).toHaveLength(500));
      const batches = b.sent.filter(s => s.channel === 'room-manifest-batch');
      expect(batches).toHaveLength(8);
      expect(batches.every(s => s.payload.files.length <= 64 && s.payload.events.length <= 64)).toBe(true);
      expect(batches.flatMap(s => s.payload.files.map((f: { fileId: string }) => f.fileId))).toEqual(files.map(f => f.fileId));
    } finally { await cmd(a, { type: 'leave', roomId: ROOM_ID }); await cmd(b, { type: 'leave', roomId: ROOM_ID }); }
  });
  it.each([500, 5000])('converges %i files without oversized frames or per-file persistence IPC', async count => {
    const a = await makeEngine(), b = await makeEngine();
    const files = Array.from({ length: count }, (_, i) => ({ fileId: i.toString(16).padStart(40, '0'),
      infoHash: i.toString(16).padStart(40, '0'), name: 'Film ' + i + '.mkv', size: i,
      magnetURI: 'magnet:?xt=urn:btih:' + i.toString(16).padStart(40, '0'), addedBy: 'A', addedByName: 'A', addedAt: 1 }));
    const pa = joinPayload('A', path.join(dir, 'a')), pb = joinPayload('B', path.join(dir, 'b'));
    Object.assign(pa.payload, { manifest: files, autoFetch: false }); Object.assign(pb.payload, { autoFetch: false });
    await cmd(a, pa); a.tracker = H.trackers.at(-1);
    await cmd(b, pb); b.tracker = H.trackers.at(-1);
    const [wire] = connect(a, b);
    try {
      await vi.waitFor(async () => {
        const state = await snapshot(b);
        expect(state.files).toHaveLength(count);
        expect(state.connection?.phase).toBe('ready');
      }, { timeout: 30_000, interval: 100 });
      expect(wire.sentFrames.every(frame => String(frame).length < 1_000_000)).toBe(true);
      const batches = b.sent.filter(s => s.channel === 'room-manifest-batch');
      expect(batches.reduce((n, s) => n + s.payload.files.length, 0)).toBe(count);
      expect(batches.every(s => s.payload.files.length <= 64 && s.payload.events.length <= 64)).toBe(true);
      expect(b.sent.filter(s => s.channel === 'room-manifest-add')).toHaveLength(0);
      const pages = sentMsgs(wire, 'hello').filter(m => m.manifestPart);
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.every(page => page.files.length <= 64)).toBe(true);
    } finally { await cmd(a, { type: 'leave', roomId: ROOM_ID }); await cmd(b, { type: 'leave', roomId: ROOM_ID }); }
  }, 35_000);
});
