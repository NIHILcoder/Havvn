/**
 * Integration test for E2E flag/secret adoption over gossip.
 *
 * A fresh joiner doesn't know the room is E2E yet, so its first HELLO carries
 * e2e:false — adoption must be strictly monotonic (upgrade-only) or the owner's
 * room gets flipped out of E2E by the very peer it invited (and a file shared
 * in that window would hit the swarm as plaintext). The content secret is
 * adopt-once: first learned wins; a conflicting one is never obeyed.
 *
 * Same harness as room-revive.test.ts: REAL room-engine instances with the
 * Electron/WebTorrent/tracker boundaries mocked, wired with in-memory peers.
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
      const t = new FakeTorrent(infoHash, 0, false);
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

function connect(a: { tracker?: any }, b: { tracker?: any }): [FakePeer, FakePeer] {
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

const ROOM_ID = 'room-e2e-adopt-1';
const CODE = 'ember-vault-signal-harbor';
const SECRET = 'a'.repeat(64);        // the owner's real content key (32-byte hex)
const WRONG_SECRET = 'b'.repeat(64);  // a conflicting key from a confused/hostile peer

function joinPayload(memberId: string, folder: string, e2e: boolean, secret: string) {
  return {
    type: 'join',
    payload: {
      roomId: ROOM_ID, name: 'E2E room', code: CODE, folder,
      self: { memberId, name: memberId, avatarSeed: memberId, pub: '', priv: '' },
      useTurn: false, turnServers: [],
      tombstones: {}, manifest: [], ownerId: 'A', mutes: [], history: [], chat: [],
      identities: {}, e2e, secret, cacheDir: path.join(folder, 'cache'),
    },
  };
}

let dir: string;
beforeAll(() => {
  (globalThis as any).window = globalThis; // engine reads window.* for native WebRTC
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-e2e-adopt-'));
  for (const d of ['a', 'b', 'c']) fs.mkdirSync(path.join(dir, d));
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('E2E adoption is monotonic: joiners upgrade, owners never downgrade', () => {
  let A: Engine; let B: Engine;

  it("a fresh joiner's e2e:false HELLO does not strip the owner's E2E flag", async () => {
    A = await makeEngine();
    B = await makeEngine();
    await cmd(A, joinPayload('A', path.join(dir, 'a'), true, SECRET));
    await cmd(B, joinPayload('B', path.join(dir, 'b'), false, ''));
    A.tracker = H.trackers[0]; B.tracker = H.trackers[1];
    connect(A, B);
    await flush();

    const stateA = await cmd(A, joinPayload('A', path.join(dir, 'a'), true, SECRET));
    expect(stateA.e2e).toBe(true);
    // The owner never re-learned its own config (the pre-fix engine flipped to
    // false here and persisted the downgrade via 'room-e2e').
    expect(A.sent.filter((s) => s.channel === 'room-e2e')).toHaveLength(0);
  });

  it('the joiner upgrades to e2e and adopts the secret from the HELLO', async () => {
    const stateB = await cmd(B, joinPayload('B', path.join(dir, 'b'), false, ''));
    expect(stateB.e2e).toBe(true);
    const learned = B.sent.filter((s) => s.channel === 'room-e2e');
    expect(learned).toHaveLength(1);
    expect(learned[0].payload).toMatchObject({ e2e: true, secret: SECRET });
  });

  it('a conflicting secret is never adopted (first learned wins)', async () => {
    const C = await makeEngine();
    await cmd(C, joinPayload('C', path.join(dir, 'c'), true, WRONG_SECRET));
    C.tracker = H.trackers[2];
    connect(A, C);
    await flush();

    // Neither side re-persisted E2E config: A kept SECRET, C kept its own.
    expect(A.sent.filter((s) => s.channel === 'room-e2e')).toHaveLength(0);
    expect(C.sent.filter((s) => s.channel === 'room-e2e')).toHaveLength(0);
    const stateA = await cmd(A, joinPayload('A', path.join(dir, 'a'), true, SECRET));
    expect(stateA.e2e).toBe(true);
  });
});
