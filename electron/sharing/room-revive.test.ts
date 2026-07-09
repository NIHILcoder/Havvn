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
import fs from 'fs';
import os from 'os';
import path from 'path';

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

function joinPayload(memberId: string, folder: string, tombstones: Record<string, number> = {}) {
  return {
    type: 'join',
    payload: {
      roomId: ROOM_ID, name: 'Test room', code: CODE, folder,
      self: { memberId, name: memberId, avatarSeed: memberId, pub: '', priv: '' },
      useTurn: false, turnServers: [],
      tombstones, manifest: [], ownerId: 'A', mutes: [], history: [], chat: [],
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
    await cmd(B, { type: 'removeFile', roomId: ROOM_ID, fileId, at: Date.now() });
    await flush();
    for (const inst of [A, B, C]) {
      const state = await cmd(inst, joinPayload('X', path.join(dir, 'a')));
      expect(state.files).toHaveLength(0);
    }
  });
});
