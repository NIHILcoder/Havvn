/**
 * Integration test for `srv-mirror` gossip: several members hosting at once.
 *
 * "Host" here is whoever runs the server, not the room owner — any member can.
 * The engine used to keep ONE mirror slot per room with ONE `at` floor, so two
 * members with servers overwrote each other and, because the floor was shared,
 * whichever machine had the faster clock buried the other's servers permanently.
 * Everything below is about that: mirrors are per publisher, floors are per
 * publisher, and an EMPTY mirror is a real message ("my last server is gone")
 * rather than something to skip.
 *
 * Same harness as room-revive/room-srv-cmd: real engines, mocked boundaries,
 * in-memory peers, plus a hostile peer that crafts frames.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deriveMemberId, deriveKey, topicHash, encrypt } from './room-crypto';
import type { ServerMirrorState } from '../../shared/gameserver-types';

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

function hostilePeer(inst: { tracker: any }): FakePeer {
  const pEngine = new FakePeer(); const pTest = new FakePeer();
  pEngine.other = pTest; pTest.other = pEngine;
  inst.tracker.emitPeer(pEngine);
  return pTest;
}

const flush = async (rounds = 25): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * Wait until a pushed snapshot satisfies `check`. State pushes are throttled to
 * one per 700ms per room, so asserting straight after a `flush()` reads whatever
 * the PREVIOUS push happened to contain — which passes or fails on timing rather
 * than on behaviour.
 */
async function waitFor<T>(read: () => T, check: (v: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const v = read();
    if (check(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

type Engine = EngineCtx & { tracker?: any };

let reqSeq = 9000;
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

const ROOM_ID = 'room-srv-mirror-1';
const CODE = 'harbor-thistle-basalt-meadow';
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

function srvMirrorCanonical(m: { hostId: string; at: number; body: string }): Buffer {
  return Buffer.from(JSON.stringify(['srv-mirror', TOPIC, m.hostId, m.at, m.body]), 'utf8');
}

/** A mirror frame signed by `label`, ready to drop on a hostile wire. */
function mirrorFrame(label: string, at: number, instanceIds: string[]): any {
  const k = keysFor(label);
  const body = JSON.stringify({
    hostId: k.memberId,
    at,
    instances: instanceIds.map((instanceId) => ({
      instanceId, moduleId: 'minecraft', name: instanceId, version: '1.21',
      status: 'running', since: at, operators: [], autoRestart: false,
    })),
  } satisfies ServerMirrorState as unknown as ServerMirrorState);
  const sig = crypto.sign(null, srvMirrorCanonical({ hostId: k.memberId, at, body }), crypto.createPrivateKey(k.priv)).toString('base64');
  return {
    t: 'srv-mirror', hostId: k.memberId, at, body, pub: k.pub, sig,
    _g: crypto.randomBytes(6).toString('hex'), _t: 4,
  };
}

/** The latest RoomState this engine pushed to main. */
const state = (inst: Engine): any =>
  inst.sent.filter((s) => s.channel === 'room-update').map((s) => s.payload).pop();

const mirrorsIn = (inst: Engine): ServerMirrorState[] => state(inst)?.srvMirrors ?? [];
const instanceIdsFrom = (mirrors: ServerMirrorState[]): string[] =>
  mirrors.flatMap((m) => m.instances.map((i) => i.instanceId)).sort();

let dir: string;

beforeAll(() => {
  (globalThis as any).window = globalThis;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-srv-mirror-'));
  for (const d of ['a', 'b', 'c']) fs.mkdirSync(path.join(dir, d));
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('srv-mirror: several members can host at once', () => {
  let A: Engine; let B: Engine; let C: Engine;
  let viewer: FakePeer;

  const seesInstances = (want: string[]) =>
    waitFor(() => instanceIdsFrom(mirrorsIn(C)), (got) => JSON.stringify(got) === JSON.stringify(want), `instances ${want.join()}`);

  it('joins three members and connects the viewer to both hosts', async () => {
    A = await makeEngine();   // host #1
    B = await makeEngine();   // host #2
    C = await makeEngine();   // the viewer, hosts nothing
    await cmd(A, joinPayload('A', path.join(dir, 'a')));
    await cmd(B, joinPayload('B', path.join(dir, 'b')));
    await cmd(C, joinPayload('C', path.join(dir, 'c')));
    A.tracker = H.trackers[0]; B.tracker = H.trackers[1]; C.tracker = H.trackers[2];
    connect(A, C);
    connect(B, C);

    await waitFor(
      () => state(C)?.members.filter((m: any) => m.online).length ?? 0,
      (n) => n === 3,
      'three online members',
    );
  });

  it('shows BOTH hosts’ servers — neither buries the other', async () => {
    // A publishes first with a LATER timestamp than B. Under the old shared
    // floor this is exactly the arrangement that made B invisible forever.
    viewer = hostilePeer(C);
    viewer.send(encrypt(KEY, mirrorFrame('A', 50_000, ['a-survival'])));
    await flush();
    viewer.send(encrypt(KEY, mirrorFrame('B', 10_000, ['b-creative'])));

    await seesInstances(['a-survival', 'b-creative']);
    expect(mirrorsIn(C).map((m) => m.hostId).sort()).toEqual([idFor('A'), idFor('B')].sort());
  });

  it('keeps a per-host floor: a rewound mirror is refused, its host is not', async () => {
    // B, whose own floor is still at 10_000, moves forward freely — while A's
    // replayed older state must not roll A back. Both are asserted by the single
    // settled snapshot below: 'a-stale' never appears, 'b-second' does.
    viewer.send(encrypt(KEY, mirrorFrame('A', 20_000, ['a-stale'])));
    await flush();
    viewer.send(encrypt(KEY, mirrorFrame('B', 70_000, ['b-creative', 'b-second'])));

    await seesInstances(['a-survival', 'b-creative', 'b-second']);
  });

  it('an empty mirror clears that host’s servers and leaves the others alone', async () => {
    // "I deleted my last server." Skipping empty payloads is what left a ghost
    // server on every peer forever.
    viewer.send(encrypt(KEY, mirrorFrame('B', 80_000, [])));

    await seesInstances(['a-survival']);
    // B is gone from the state entirely — an empty mirror is kept in memory as
    // that host's replay floor, but there is nothing in it to show.
    expect(mirrorsIn(C).map((m) => m.hostId)).toEqual([idFor('A')]);
  });

  it('having said it has none, B cannot be rolled back to its old servers', async () => {
    // The floor survives even though the empty mirror left the state: replaying
    // B's pre-deletion payload must not resurrect the servers it just dropped.
    viewer.send(encrypt(KEY, mirrorFrame('B', 70_000, ['b-creative', 'b-second'])));
    await flush(40);

    expect(instanceIdsFrom(mirrorsIn(C))).toEqual(['a-survival']);
  });

  it('refuses a mirror whose body claims a different host than the signer', async () => {
    // The signature is valid for A, so only the body/envelope cross-check can
    // catch a body that names B.
    const frame = mirrorFrame('A', 90_000, ['a-survival']);
    const body = JSON.stringify({
      hostId: idFor('B'), at: 90_000,
      instances: [{ instanceId: 'forged', moduleId: 'minecraft', name: 'f', version: '1', status: 'running', since: 1, operators: [], autoRestart: false }],
    });
    const k = keysFor('A');
    frame.body = body;
    frame.sig = crypto.sign(null, srvMirrorCanonical({ hostId: k.memberId, at: 90_000, body }), crypto.createPrivateKey(k.priv)).toString('base64');
    viewer.send(encrypt(KEY, frame));
    await flush(40);

    expect(instanceIdsFrom(mirrorsIn(C))).toEqual(['a-survival']);
  });

  it('refuses a mirror signed by a key that is not the claimed host', async () => {
    const frame = mirrorFrame('B', 95_000, ['b-back']);
    frame.hostId = idFor('A');           // claim A, still signed by B
    viewer.send(encrypt(KEY, frame));
    await flush(40);

    expect(instanceIdsFrom(mirrorsIn(C))).toEqual(['a-survival']);
  });

  it('drops the mirror of a member who has left', async () => {
    // Presence is the expiry, not a clock: an idle host publishes only when
    // something changes, so a TTL would hide a perfectly good stopped server.
    // A member who is gone, on the other hand, cannot be reached at all.
    viewer.send(encrypt(KEY, { t: 'bye', memberId: idFor('A'), _g: crypto.randomBytes(6).toString('hex'), _t: 4 }));

    await seesInstances([]);
    // Nothing left to carry: the key is omitted rather than sent as an empty list.
    expect(state(C).srvMirrors).toBeUndefined();
  });
});
