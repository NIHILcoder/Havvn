/**
 * Integration test for the operator console command (`srv-cmd`) anti-replay floor.
 *
 * Same harness as room-revive/room-liveness: REAL room-engine instances with the
 * Electron/WebTorrent/tracker boundaries mocked and wired together with in-memory
 * peers, plus a hostile peer that holds the room code and re-sends frames the
 * test crafts.
 *
 * The property under test is narrow and easy to lose: a `srv-cmd` signature
 * proves WHO typed the command and nothing about WHEN. Relay dedup is keyed on a
 * sender-chosen gid and lives only for the session, so re-flooding a captured
 * frame under a fresh gid clears every other gate. Without a per-member `at`
 * floor, any keyholder — including a viewer the host deliberately did NOT make an
 * operator — can replay an operator's `stop` or `op <them>` at will, forever.
 * That is a privilege escalation, and the only thing standing in its way is the
 * floor asserted below.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deriveMemberId, deriveKey, topicHash, encrypt, decrypt } from './room-crypto';

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
const idFor = (label: string): string => keysFor(label).memberId;

type Sent = { channel: string; payload: any };
type EngineCtx = { listeners: Record<string, (e: any, msg: any) => void>; sent: Sent[] };

const H = vi.hoisted(() => ({ trackers: [] as any[] }));

vi.mock('webtorrent', () => {
  class FakeWebTorrent {
    torrents = new Map<string, any>();
    handlers: Record<string, any[]> = {};
    on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
    once(ev: string, fn: any): void { this.on(ev, fn); }
    removeListener(ev: string, fn: any): void {
      this.handlers[ev] = (this.handlers[ev] ?? []).filter((f) => f !== fn);
    }
    seed(_p: string, _o: any, cb: (t: any) => void): void { cb({ infoHash: '', on() {}, once() {} }); }
    add(_m: string, _o: any, cb: (t: any) => void): void { cb({ infoHash: '', on() {}, once() {} }); }
    get(): null { return null; }
    remove(): void { /* no-op */ }
    destroy(): void { /* no-op */ }
    throttleUpload(): void { /* no-op */ }
    throttleDownload(): void { /* no-op */ }
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

/** A member gone hostile: holds the code, but the test crafts every frame. */
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

let reqSeq = 7000;
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

const ROOM_ID = 'room-srv-cmd-1';
const CODE = 'copper-lantern-willow-anchor';
const KEY = deriveKey(CODE);
const TOPIC = topicHash(CODE);

function joinPayload(label: string, folder: string) {
  const k = keysFor(label);
  return {
    type: 'join',
    payload: {
      roomId: ROOM_ID, name: 'Server room', code: CODE, folder,
      self: { memberId: k.memberId, name: label, avatarSeed: label, pub: k.pub, priv: k.priv },
      useTurn: false, turnServers: [],
      tombstones: {}, manifest: [], ownerId: idFor('A'), mutes: [], history: [], chat: [],
      identities: {}, e2e: false, secret: '', cacheDir: '',
    },
  };
}

/** Exactly the bytes room-engine signs for a srv-cmd. */
function srvCmdCanonical(m: { by: string; instanceId: string; command: string; at: number }): Buffer {
  return Buffer.from(JSON.stringify(['srv-cmd', TOPIC, m.by, m.instanceId, m.command, m.at]), 'utf8');
}

/** Decrypt a FakePeer's outbound frames and keep those of one gossip type. */
function sentMsgs(peer: FakePeer, t: string): any[] {
  const out: any[] = [];
  for (const f of peer.sentFrames) {
    try {
      const m = decrypt<any>(KEY, typeof f === 'string' ? f : Buffer.from(f).toString('utf8'));
      if (m?.t === t) out.push(m);
    } catch { /* not for us */ }
  }
  return out;
}

/** Every srv-remote-cmd this engine handed to the main process. */
const forwarded = (inst: Engine): any[] =>
  inst.sent.filter((s) => s.channel === 'srv-remote-cmd').map((s) => s.payload);

let dir: string;

beforeAll(() => {
  (globalThis as any).window = globalThis;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-srv-cmd-'));
  for (const d of ['a', 'b', 'c']) fs.mkdirSync(path.join(dir, d));
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('srv-cmd: an operator command reaches the host exactly once', () => {
  let A: Engine; let B: Engine;
  let pB: FakePeer;

  it('delivers a signed operator command to the host', async () => {
    A = await makeEngine();          // the host
    B = await makeEngine();          // the operator
    await cmd(A, joinPayload('A', path.join(dir, 'a')));
    await cmd(B, joinPayload('B', path.join(dir, 'b')));
    A.tracker = H.trackers[0]; B.tracker = H.trackers[1];
    [, pB] = connect(A, B);
    await flush();

    await cmd(B, { type: 'srvCmd', roomId: ROOM_ID, instanceId: 'inst-1', command: 'say hello' });
    await flush();

    const got = forwarded(A);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ roomId: ROOM_ID, by: idFor('B'), instanceId: 'inst-1', command: 'say hello' });
  });

  it('re-flooding the captured frame under a fresh gid is refused', async () => {
    // The attacker is a viewer: they hold the room code (so they can decrypt and
    // re-encrypt) but no operator grant. They cannot forge B's signature — they
    // do not need to. They replay B's.
    const captured = sentMsgs(pB, 'srv-cmd')[0];
    expect(captured).toBeTruthy();

    const before = forwarded(A).length;
    const attacker = hostilePeer(A);
    for (let i = 0; i < 5; i++) {
      // A fresh gid every time, which is all the relay dedup ever looked at.
      attacker.send(encrypt(KEY, { ...captured, _g: crypto.randomBytes(6).toString('hex'), _t: 4 }));
    }
    await flush();

    expect(forwarded(A).length).toBe(before);
  });

  it('a later command from the same operator still gets through', async () => {
    // The floor must stop replays without wedging the operator: the whole point
    // is that legitimate traffic keeps flowing after an attack.
    const before = forwarded(A).length;
    await cmd(B, { type: 'srvCmd', roomId: ROOM_ID, instanceId: 'inst-1', command: 'stop' });
    await flush();

    const got = forwarded(A);
    expect(got.length).toBe(before + 1);
    expect(got[got.length - 1]).toMatchObject({ command: 'stop' });
  });

  it('two commands inside one millisecond both arrive', async () => {
    // The sender stamps `at` strictly above its own last one, so a fast pair (or
    // a paste) cannot look like a replay of the first.
    const before = forwarded(A).length;
    const now = Date.now();
    const realNow = Date.now;
    Date.now = () => now;                    // freeze the clock: same millisecond
    try {
      await cmd(B, { type: 'srvCmd', roomId: ROOM_ID, instanceId: 'inst-1', command: 'list' });
      await cmd(B, { type: 'srvCmd', roomId: ROOM_ID, instanceId: 'inst-1', command: 'seed' });
    } finally {
      Date.now = realNow;
    }
    await flush();

    const got = forwarded(A).slice(before);
    expect(got.map((g) => g.command)).toEqual(['list', 'seed']);
  });

  it('a command with a rewound `at` is refused even with a valid signature', async () => {
    // The attacker signs with their OWN key (so verifySignedBy passes for them)
    // but stamps an `at` below the floor their earlier traffic set. This is the
    // shape a captured-and-edited frame takes once the signature is re-made.
    const k = keysFor('B');
    const stale = 1;
    const body = { by: k.memberId, instanceId: 'inst-1', command: 'op attacker', at: stale };
    const sig = crypto.sign(null, srvCmdCanonical(body), crypto.createPrivateKey(k.priv)).toString('base64');

    const before = forwarded(A).length;
    const attacker = hostilePeer(A);
    attacker.send(encrypt(KEY, {
      t: 'srv-cmd', ...body, pub: k.pub, sig,
      _g: crypto.randomBytes(6).toString('hex'), _t: 4,
    }));
    await flush();

    expect(forwarded(A).length).toBe(before);
  });
});
