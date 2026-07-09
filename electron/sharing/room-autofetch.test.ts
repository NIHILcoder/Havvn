/**
 * Integration test for the per-room auto-download toggle.
 *
 * Same harness as room-revive.test.ts: REAL room-engine instances with the
 * Electron/WebTorrent/tracker boundaries mocked, wired together in memory.
 *
 *   auto (default) → a peer's share starts downloading by itself;
 *   manual         → the share is listed but nothing fetches until an explicit
 *                    fetchFile; flipping auto back on pulls what's pending.
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
// is deterministic from content. add() never completes — a transfer stuck at
// 'downloading' is exactly what these tests assert on.
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

let reqSeq = 2000;
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

/** Boot a fresh room-engine module instance (a simulated separate install). */
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

const ROOM_ID = 'room-autofetch-1';
const CODE = 'ember-graphite-olive-hairline';

function joinPayload(memberId: string, folder: string, autoFetch?: boolean) {
  return {
    type: 'join',
    payload: {
      roomId: ROOM_ID, name: 'Fetch test room', code: CODE, folder,
      self: { memberId, name: memberId, avatarSeed: memberId, pub: '', priv: '' },
      useTurn: false, turnServers: [],
      tombstones: {}, manifest: [], ownerId: 'A', mutes: [], history: [], chat: [],
      identities: {}, e2e: false, secret: '', cacheDir: '',
      ...(autoFetch === undefined ? {} : { autoFetch }),
    },
  };
}

let dir: string;
let sourceFile: string;

beforeAll(() => {
  (globalThis as any).window = globalThis; // engine reads window.* for native WebRTC
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-autofetch-'));
  sourceFile = path.join(dir, 'episode.mkv');
  fs.writeFileSync(sourceFile, 'autofetch test content -> deterministic fileId');
  for (const d of ['a', 'b', 'c', 'd']) fs.mkdirSync(path.join(dir, d));
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('room auto-download toggle', () => {
  let A: Engine;
  let fileId: string;

  it('auto (default): a peer share starts downloading by itself', async () => {
    A = await makeEngine();
    const B = await makeEngine();
    await cmd(A, joinPayload('A', path.join(dir, 'a')));
    await cmd(B, joinPayload('B', path.join(dir, 'b'))); // autoFetch omitted → true
    A.tracker = H.trackers[0]; B.tracker = H.trackers[1];
    connect(A, B);
    await flush();

    const stateA = await cmd(A, { type: 'addFiles', roomId: ROOM_ID, paths: [sourceFile] });
    fileId = stateA.files[0].fileId;
    await flush();

    const stateB = await cmd(B, { type: 'snapshot', roomId: ROOM_ID });
    expect(stateB.autoFetch).toBe(true);
    expect(stateB.files.map((f: any) => f.fileId)).toEqual([fileId]);
    expect(stateB.transfers[fileId]?.status).toBe('downloading'); // fetch started on its own
  });

  it('manual: the share is listed but nothing fetches', async () => {
    const C = await makeEngine();
    await cmd(C, joinPayload('C', path.join(dir, 'c'), false));
    C.tracker = H.trackers[H.trackers.length - 1];
    connect(A, C);
    await flush();

    const stateC = await cmd(C, { type: 'snapshot', roomId: ROOM_ID });
    expect(stateC.autoFetch).toBe(false);
    expect(stateC.files.map((f: any) => f.fileId)).toEqual([fileId]); // visible…
    expect(stateC.transfers[fileId]).toBeUndefined();                 // …but not fetching

    // An explicit fetch pulls exactly that file.
    const fetched = await cmd(C, { type: 'fetchFile', roomId: ROOM_ID, fileId });
    expect(fetched.transfers[fileId]?.status).toBe('downloading');
  });

  it('flipping auto back on pulls everything left unfetched', async () => {
    const D = await makeEngine();
    await cmd(D, joinPayload('D', path.join(dir, 'd'), false));
    D.tracker = H.trackers[H.trackers.length - 1];
    connect(A, D);
    await flush();

    let stateD = await cmd(D, { type: 'snapshot', roomId: ROOM_ID });
    expect(stateD.transfers[fileId]).toBeUndefined(); // manual — untouched

    await cmd(D, { type: 'setAutoFetch', roomId: ROOM_ID, autoFetch: true });
    stateD = await cmd(D, { type: 'snapshot', roomId: ROOM_ID });
    expect(stateD.autoFetch).toBe(true);
    expect(stateD.transfers[fileId]?.status).toBe('downloading'); // pending share pulled
  });

  it('fetchFile on an unknown file fails loudly', async () => {
    await expect(cmd(A, { type: 'fetchFile', roomId: ROOM_ID, fileId: 'nope' }))
      .rejects.toThrow(/not found/i);
  });
});
