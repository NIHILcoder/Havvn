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
  trackers: [] as any[],   // FakeTracker instances in creation order
  clients: [] as any[],    // FakeWebTorrent instances in creation order
}));

// WebTorrent stand-in: infoHash is the sha1 of the content (deterministic
// fileId); downloads never complete on their own — the test drives progress by
// mutating torrent.progress and emitting 'download' / 'done'.
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
    emit(ev: string): void { for (const fn of this.handlers[ev] ?? []) fn(); }
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
    seed(p: string, _opts: any, cb: (t: any) => void): void {
      const content = fsMod.readFileSync(p);
      const infoHash = createHash('sha1').update(content).digest('hex');
      const t = this.torrents.get(infoHash) ?? new FakeTorrent(infoHash, content.length, true);
      this.torrents.set(infoHash, t);
      cb(t);
    }
    add(magnet: string, _opts: any, cb: (t: any) => void): void {
      const infoHash = /btih:([0-9a-f]+)/.exec(magnet)?.[1] ?? '';
      const t = new FakeTorrent(infoHash, 0, false); // never completes by itself
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
