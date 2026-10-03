/**
 * Integration test for per-room speed limits.
 *
 * Same harness as room-revive/room-autofetch: REAL room-engine instances with
 * the Electron/WebTorrent/tracker boundaries mocked. Rooms now get a WebTorrent
 * client EACH — that's what makes per-room throttling real — so the fake
 * captures constructor options and throttle calls per instance.
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
  trackers: [] as any[],
  clients: [] as any[],    // FakeWebTorrent instances in creation order
}));

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
    torrents = new Map<string, FakeTorrent>();
    handlers: Record<string, any[]> = {};
    opts: any;
    throttleCalls: Array<[string, number]> = [];
    destroyed = false;
    constructor(opts: any) { this.opts = opts; H.clients.push(this); }
    on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
    once(ev: string, fn: any): void { this.on(ev, fn); }
    removeListener(ev: string, fn: any): void {
      this.handlers[ev] = (this.handlers[ev] ?? []).filter((f) => f !== fn);
    }
    throttleUpload(rate: number): void { this.throttleCalls.push(['up', rate]); }
    throttleDownload(rate: number): void { this.throttleCalls.push(['down', rate]); }
    destroy(done?: () => void): void { this.destroyed = true; done?.(); }
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

const flush = async (rounds = 25): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

type Engine = EngineCtx;

let reqSeq = 3000;
async function cmd<T = any>(inst: Engine, msg: Record<string, unknown>): Promise<T> {
  const reqId = ++reqSeq;
  await inst.listeners['room-cmd'](null, { reqId, ...msg });
  await flush();
  const res = inst.sent
    .filter((s) => s.channel === 'room-res')
    .map((s) => s.payload)
    .find((p) => p?.reqId === reqId);
  if (!res) throw new Error('engine sent no response');
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

function joinPayload(roomId: string, code: string, memberId: string, folder: string, limits?: { upKbps?: number; downKbps?: number }) {
  return {
    type: 'join',
    payload: {
      roomId, name: 'Limits ' + roomId, code, folder,
      self: { memberId, name: memberId, avatarSeed: memberId, pub: '', priv: '' },
      useTurn: false, turnServers: [],
      tombstones: {}, manifest: [], ownerId: memberId, mutes: [], history: [], chat: [],
      identities: {}, e2e: false, secret: '', cacheDir: '',
      ...(limits ?? {}),
    },
  };
}

let dir: string;
let fileA: string;
let fileB: string;

beforeAll(() => {
  (globalThis as any).window = globalThis;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-limits-'));
  fileA = path.join(dir, 'a.mkv');
  fileB = path.join(dir, 'b.mkv');
  fs.writeFileSync(fileA, 'limits test content A');
  fs.writeFileSync(fileB, 'limits test content B');
  for (const d of ['r1', 'r2']) fs.mkdirSync(path.join(dir, d));
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('per-room speed limits', () => {
  let E: Engine;

  it("the room's client is created with the persisted ceilings (KB/s → bytes/s)", async () => {
    E = await makeEngine();
    const state = await cmd(E, joinPayload('room-1', 'code-one-alpha', 'A', path.join(dir, 'r1'), { upKbps: 500, downKbps: 100 }));
    expect(state.upKbps).toBe(500);
    expect(state.downKbps).toBe(100);

    // The client is lazy — seeding the first file constructs it.
    await cmd(E, { type: 'addFiles', roomId: 'room-1', paths: [fileA] });
    const c1 = H.clients[H.clients.length - 1];
    expect(c1.opts.uploadLimit).toBe(0); // no traffic before shared allocation
    expect(c1.throttleCalls).toContainEqual(['up', 256 * 1024]);
    expect(c1.opts.downloadLimit).toBe(0);
    expect(c1.throttleCalls).toContainEqual(['down', 100 * 1024]);
  });

  it('setLimits applies the per-room ceiling inside the shared budget', async () => {
    const c1 = H.clients[H.clients.length - 1];
    await cmd(E, { type: 'setLimits', roomId: 'room-1', upKbps: 256, downKbps: 0 });
    expect(c1.throttleCalls).toContainEqual(['up', 256 * 1024]);
    expect(c1.throttleCalls).toContainEqual(['down', -1]);

    const state = await cmd(E, { type: 'snapshot', roomId: 'room-1' });
    expect(state.upKbps).toBe(256);
    expect(state.downKbps).toBe(0);
  });

  it('each room gets its own client with its own ceilings', async () => {
    await cmd(E, joinPayload('room-2', 'code-two-bravo', 'A', path.join(dir, 'r2'))); // no limits
    await cmd(E, { type: 'addFiles', roomId: 'room-2', paths: [fileB] });
    const c2 = H.clients[H.clients.length - 1];
    const c1 = H.clients[H.clients.length - 2];
    expect(c2).not.toBe(c1);
    expect(c2.opts.uploadLimit).toBe(0);
    expect(c2.opts.downloadLimit).toBe(0);
    expect(c1.throttleCalls).toContainEqual(['up', 128 * 1024]);
    expect(c2.throttleCalls).toContainEqual(['up', 128 * 1024]);

    // Capping room-2 returns its spare share to room-1.
    const before = c1.throttleCalls.length;
    await cmd(E, { type: 'setLimits', roomId: 'room-2', upKbps: 64, downKbps: 32 });
    expect(c2.throttleCalls).toContainEqual(['up', 64 * 1024]);
    expect(c1.throttleCalls.length).toBeGreaterThan(before);
    expect(c1.throttleCalls).toContainEqual(['up', 192 * 1024]);
  });

  it('rolls back both limits if applying the second fails and keeps the actual snapshot', async () => {
    const c1 = H.clients[H.clients.length - 2];
    const throttle = vi.spyOn(c1, 'throttleDownload').mockImplementationOnce(() => { throw new Error('limiter failed'); });
    await expect(cmd(E, { type: 'setLimits', roomId: 'room-1', upKbps: 700, downKbps: 800 })).rejects.toThrow('limiter failed');
    expect(c1.throttleCalls.slice(-2)).toEqual([['up', 192 * 1024], ['down', -1]]);
    expect(await cmd(E, { type: 'snapshot', roomId: 'room-1' })).toMatchObject({ upKbps: 256, downKbps: 0 });
    throttle.mockRestore();
  });

  it('returns applied values and rejects invalid ceilings and settings for an inactive room', async () => {
    expect(await cmd(E, { type: 'setLimits', roomId: 'room-2', upKbps: 50, downKbps: 20 })).toMatchObject({ upKbps: 50, downKbps: 20 });
    for (const rate of [NaN, Infinity, -1, 1_000_001]) {
      await expect(cmd(E, { type: 'setLimits', roomId: 'room-2', upKbps: rate, downKbps: 20 })).rejects.toThrow('Invalid');
    }
    for (const type of ['setLimits', 'setAutoFetch', 'mute', 'setFolderAutoFetch']) {
      await expect(cmd(E, { type, roomId: 'missing', upKbps: 0, downKbps: 0 })).rejects.toThrow('Room not active');
    }
  });

  it("leaving a room destroys ITS client only", async () => {
    const c1 = H.clients[H.clients.length - 2];
    const c2 = H.clients[H.clients.length - 1];
    await cmd(E, { type: 'leave', roomId: 'room-1' });
    expect(c1.destroyed).toBe(true);
    expect(c2.destroyed).toBe(false);
  });

  it('stops a client if restoring its previous limits fails too', async () => {
    const c2 = H.clients[H.clients.length - 1];
    const throttle = vi.spyOn(c2, 'throttleDownload').mockImplementation(() => { throw new Error('broken limiter'); });
    await expect(cmd(E, { type: 'setLimits', roomId: 'room-2', upKbps: 999, downKbps: 999 })).rejects.toThrow('broken limiter');
    expect(c2.destroyed).toBe(true);
    expect(await cmd(E, { type: 'snapshot', roomId: 'room-2' })).toMatchObject({ upKbps: 50, downKbps: 20 });
    throttle.mockRestore();
  });
});
