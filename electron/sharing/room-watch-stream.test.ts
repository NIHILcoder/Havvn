/**
 * Integration test for watch-while-downloading (M10).
 *
 * Same harness as room-autofetch.test.ts, but the FakeTorrent also implements
 * WebTorrent's per-torrent stream server (`createServer` → listen/address/close)
 * and reports `ready`, so the engine's `watchStream` command can be exercised:
 *   • a non-E2E, still-downloading file yields a 127.0.0.1 stream port;
 *   • the server is reused (one createServer per file), and closed on leave;
 *   • an E2E room refuses (no plaintext until decrypt);
 *   • watching a manual-mode, not-yet-fetched file auto-starts its download.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

type Sent = { channel: string; payload: any };
type EngineCtx = { listeners: Record<string, (e: any, msg: any) => void>; sent: Sent[] };

const H = vi.hoisted(() => ({ trackers: [] as any[], createServerCalls: 0, closedPorts: [] as number[], portSeq: 40000 }));

vi.mock('webtorrent', async () => {
  const { default: fsMod } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  class FakeServer {
    port = 0;
    private handlers: Record<string, any[]> = {};
    listen(_p: number, _host: string, cb: () => void): void { this.port = ++H.portSeq; cb(); }
    address(): { port: number } { return { port: this.port }; }
    on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
    close(): void { H.closedPorts.push(this.port); }
  }
  class FakeTorrent {
    handlers: Record<string, any[]> = {};
    infoHash: string; magnetURI: string; length: number; progress: number; done: boolean; ready = true;
    files: Array<{ name: string; select: () => void }>;
    constructor(infoHash: string, length: number, done: boolean) {
      this.infoHash = infoHash;
      this.magnetURI = 'magnet:?xt=urn:btih:' + infoHash;
      this.length = length; this.done = done; this.progress = done ? 1 : 0;
      this.files = [{ name: 'clip.mp4', select: () => { /* no-op */ } }];
    }
    on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
    once(ev: string, fn: any): void { this.on(ev, fn); }
    createServer(_opts: any): FakeServer { H.createServerCalls++; return new FakeServer(); }
  }
  class FakeWebTorrent {
    torrents = new Map<string, FakeTorrent>();
    handlers: Record<string, any[]> = {};
    on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
    once(ev: string, fn: any): void { this.on(ev, fn); }
    removeListener(ev: string, fn: any): void { this.handlers[ev] = (this.handlers[ev] ?? []).filter((f) => f !== fn); }
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
    get(infoHash: string): FakeTorrent | null { return (infoHash && this.torrents.get(infoHash)) || null; }
    remove(t: FakeTorrent): void { this.torrents.delete(t.infoHash); }
    destroy(cb?: () => void): void { if (cb) cb(); }
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

vi.mock('../torrent/stream-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../torrent/stream-server')>();
  return { createTorrentStreamServer: (...args: Parameters<typeof actual.createTorrentStreamServer>) => {
    const server = actual.createTorrentStreamServer(...args);
    H.createServerCalls++;
    server.on('listening', () => {
      const address = server.address();
      if (address && typeof address !== 'string') server.on('close', () => H.closedPorts.push(address.port));
    });
    return server;
  } };
});

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
  destroy(): void { this.connected = false; for (const fn of this.handlers['close'] ?? []) fn(); }
}

function connect(a: { tracker: any }, b: { tracker: any }): [FakePeer, FakePeer] {
  const pA = new FakePeer(); const pB = new FakePeer();
  pA.other = pB; pB.other = pA;
  a.tracker.emitPeer(pA);
  b.tracker.emitPeer(pB);
  return [pA, pB];
}

const flush = async (rounds = 25): Promise<void> => { for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0)); };

type Engine = EngineCtx & { tracker?: any };

let reqSeq = 7000;
async function cmd<T = any>(inst: Engine, msg: Record<string, unknown>): Promise<T> {
  const reqId = ++reqSeq;
  inst.listeners['room-cmd'](null, { reqId, ...msg });
  // Await the actual reply rather than 25 unconditional timer ticks per command.
  // Windows timer granularity makes those ticks consume most of the test budget.
  const res = await vi.waitFor(() => {
    const response = inst.sent.filter((s) => s.channel === 'room-res')
      .map((s) => s.payload).find((p) => p?.reqId === reqId);
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

function joinPayload(o: { roomId: string; memberId: string; folder: string; autoFetch?: boolean; e2e?: boolean; secret?: string }) {
  return {
    type: 'join',
    payload: {
      roomId: o.roomId, name: 'Watch-stream test', code: o.e2e ? 'ember-graphite-olive-hairline-e2e' : 'ember-graphite-olive-hairline', folder: o.folder,
      self: { memberId: o.memberId, name: o.memberId, avatarSeed: o.memberId, pub: '', priv: '' },
      useTurn: false, turnServers: [],
      tombstones: {}, manifest: [], ownerId: 'A', mutes: [], history: [], chat: [],
      identities: {}, e2e: o.e2e ?? false, secret: o.secret ?? '', cacheDir: path.join(o.folder, 'enc'),
      ...(o.autoFetch === undefined ? {} : { autoFetch: o.autoFetch }),
    },
  };
}

let dir: string;
let sourceFile: string;
let seq = 0;
const folder = () => { const f = path.join(dir, 'inst-' + ++seq); fs.mkdirSync(f, { recursive: true }); return f; };

beforeAll(() => {
  (globalThis as any).window = globalThis;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-watch-stream-'));
  sourceFile = path.join(dir, 'clip.mp4');
  fs.writeFileSync(sourceFile, 'watch-while-downloading test content -> deterministic fileId');
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('watch-while-downloading (engine watchStream)', () => {
  it('a still-downloading non-E2E file yields a reusable 127.0.0.1 stream port, closed on leave', async () => {
    const before = H.createServerCalls;
    const A = await makeEngine(); // seeder
    const B = await makeEngine(); // downloader watches mid-download
    await cmd(A, joinPayload({ roomId: 'r-ws', memberId: 'A', folder: folder() }));
    await cmd(B, joinPayload({ roomId: 'r-ws', memberId: 'B', folder: folder() }));
    A.tracker = H.trackers[H.trackers.length - 2];
    B.tracker = H.trackers[H.trackers.length - 1];
    connect(A, B);
    await flush();

    const stateA = await cmd(A, { type: 'addFiles', roomId: 'r-ws', paths: [sourceFile] });
    const fileId = stateA.files[0].fileId;
    await flush();
    const stateB = await cmd(B, { type: 'snapshot', roomId: 'r-ws' });
    expect(stateB.transfers[fileId]?.status).toBe('downloading'); // B is mid-download, not complete

    const info = await cmd<{ port: number; index: number }>(B, { type: 'watchStream', roomId: 'r-ws', fileId });
    expect(info.index).toBe(0);
    expect(info.port).toBeGreaterThan(0);
    expect(H.createServerCalls).toBe(before + 1); // one server created

    // A second watch of the same file reuses the cached server (no new createServer).
    const again = await cmd<{ port: number }>(B, { type: 'watchStream', roomId: 'r-ws', fileId });
    expect(again.port).toBe(info.port);
    expect(H.createServerCalls).toBe(before + 1);

    // Leaving the room closes the stream server.
    await cmd(B, { type: 'leave', roomId: 'r-ws' });
    await new Promise((r) => setTimeout(r, 250)); // leaveRoom defers teardown ~200ms
    expect(H.closedPorts).toContain(info.port);
  });

  it('an E2E room refuses to stream (no plaintext until decrypt)', async () => {
    const A = await makeEngine();
    const B = await makeEngine();
    await cmd(A, joinPayload({ roomId: 'r-ws-e2e', memberId: 'A', folder: folder(), e2e: true, secret: 'ff'.repeat(32) }));
    await cmd(B, joinPayload({ roomId: 'r-ws-e2e', memberId: 'B', folder: folder(), e2e: true }));
    A.tracker = H.trackers[H.trackers.length - 2];
    B.tracker = H.trackers[H.trackers.length - 1];
    connect(A, B);
    await flush();
    const stateA = await cmd(A, { type: 'addFiles', roomId: 'r-ws-e2e', paths: [sourceFile] });
    const fileId = stateA.files[0].fileId;
    await flush();
    await expect(cmd(B, { type: 'watchStream', roomId: 'r-ws-e2e', fileId }))
      .rejects.toThrow(/encrypted/i);
  });

  it('watching a manual-mode, not-yet-fetched file auto-starts its download', async () => {
    const A = await makeEngine();
    const M = await makeEngine();
    await cmd(A, joinPayload({ roomId: 'r-ws-manual', memberId: 'A', folder: folder() }));
    await cmd(M, joinPayload({ roomId: 'r-ws-manual', memberId: 'M', folder: folder(), autoFetch: false }));
    A.tracker = H.trackers[H.trackers.length - 2];
    M.tracker = H.trackers[H.trackers.length - 1];
    connect(A, M);
    await flush();
    const stateA = await cmd(A, { type: 'addFiles', roomId: 'r-ws-manual', paths: [sourceFile] });
    const fileId = stateA.files[0].fileId;
    await flush();
    // Manual mode: nothing fetched yet.
    expect((await cmd(M, { type: 'snapshot', roomId: 'r-ws-manual' })).transfers[fileId]).toBeUndefined();
    // Watching it kicks off the download AND returns a stream port.
    const info = await cmd<{ port: number }>(M, { type: 'watchStream', roomId: 'r-ws-manual', fileId });
    expect(info.port).toBeGreaterThan(0);
    expect((await cmd(M, { type: 'snapshot', roomId: 'r-ws-manual' })).transfers[fileId]?.status).toBe('downloading');
  });
});
