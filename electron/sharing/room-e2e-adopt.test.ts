/**
 * Integration tests for how a room learns its E2E config (flag + content secret).
 *
 * Same harness as room-autofetch.test.ts: REAL room-engine instances with the
 * Electron/WebTorrent/tracker boundaries mocked, wired together in memory. A
 * "hostile member" is a raw FakePeer the test drives directly — it holds the
 * room code (so its gossip decrypts fine) but sends whatever frames we craft.
 *
 * What must hold:
 *   • the invite code's "-e2e" marker tells a joiner the room is E2E before any
 *     peer speaks, so it refuses to seed plaintext into an empty/hostile swarm;
 *   • the secret is adopted only from the OWNER's Ed25519-signed config in
 *     new-format rooms — a hostile member can't plant one, forge one, tamper
 *     with one, or replay one across topics;
 *   • members re-serve the signed blob, so joiners converge with the owner offline;
 *   • legacy rooms (old codes, unsigned config) still work: monotonic flag,
 *     adopt-once secret — and the owner's signed config RECOVERS a member that
 *     a hostile peer got to first;
 *   • kick/rekey keeps the marker, ROTATES the content secret (the outgoing
 *     one joins the signed decrypt-only keyring) and re-signs for the new topic;
 *   • ownership transfer (M8): the CURRENT owner's signed handover applies at
 *     every member, chains verifiably back to the invite pin for late joiners,
 *     survives restart, and re-anchors the E2E config on the new owner.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { deriveKey, topicHash, encrypt, generateRoomCode, codeIsE2E, deriveMemberId } from './room-crypto';
import { generateRoomSecret } from './room-e2e';

type Sent = { channel: string; payload: any };
type EngineCtx = {
  listeners: Record<string, (e: any, msg: any) => void>;
  sent: Sent[];
};

const H = vi.hoisted(() => ({
  trackers: [] as any[],   // FakeTracker instances in creation order
}));

// WebTorrent stand-in: infoHash is the sha1 of the file content, so the fileId
// is deterministic from content. add() never completes (not needed here).
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

/** A real Ed25519 identity in the PEM shapes the engine expects. */
function makeKeys(): { pub: string; priv: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function joinPayload(o: { roomId: string; code: string; memberId: string; folder: string;
  ownerId?: string; ownerPin?: string; e2e?: boolean; secret?: string; e2eCfg?: any; keys?: { pub: string; priv: string };
  transferChain?: any[] }) {
  return {
    type: 'join',
    payload: {
      roomId: o.roomId, name: 'E2E adopt test', code: o.code, folder: o.folder,
      self: { memberId: o.memberId, name: o.memberId, avatarSeed: o.memberId, pub: o.keys?.pub ?? '', priv: o.keys?.priv ?? '' },
      useTurn: false, turnServers: [],
      tombstones: {}, manifest: [], ownerId: o.ownerId ?? '', ownerPin: o.ownerPin ?? '', mutes: [], history: [], chat: [],
      identities: {}, e2e: o.e2e ?? false, secret: o.secret ?? '', e2eCfg: o.e2eCfg ?? null,
      transferChain: o.transferChain ?? [],
      cacheDir: path.join(o.folder, 'enc'),
    },
  };
}

/** Attach a test-controlled raw peer to an engine (a member gone hostile:
 *  it holds the code, but the test decides every frame it sends). */
function hostilePeer(inst: Engine): FakePeer {
  const pEngine = new FakePeer(); const pTest = new FakePeer();
  pEngine.other = pTest; pTest.other = pEngine;
  inst.tracker.emitPeer(pEngine);
  return pTest;
}

/** An encrypted HELLO frame as a (possibly lying) member would send it. */
function helloFrame(code: string, over: Record<string, unknown>): string {
  return encrypt(deriveKey(code), {
    t: 'hello', memberId: 'MAL', name: 'Mallory', avatarSeed: 'mal',
    have: [], files: [], tombs: [], roomName: '', ownerId: '', e2e: false, secret: '',
    ...over,
  });
}

/** All E2E persistence calls (room-e2e IPC) an engine has made, oldest first. */
const e2ePersists = (inst: Engine) => inst.sent.filter((s) => s.channel === 'room-e2e').map((s) => s.payload);

/** Verify a persisted cfg blob exactly like a peer would. */
function cfgVerifies(cfg: any, topic: string, ownerPub: string): boolean {
  const canon = Buffer.from(JSON.stringify(['th-room-e2e:v1', topic, cfg.ownerId, cfg.e2e, cfg.secret]), 'utf8');
  return crypto.verify(null, canon, crypto.createPublicKey(ownerPub), Buffer.from(cfg.sig, 'base64'));
}

let dir: string;
let sourceFile: string;
let roomSeq = 0;
const newFolder = () => path.join(dir, 'install-' + ++roomSeq);

beforeAll(() => {
  (globalThis as any).window = globalThis; // engine reads window.* for native WebRTC
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-e2e-adopt-'));
  sourceFile = path.join(dir, 'episode.mkv');
  fs.writeFileSync(sourceFile, 'e2e adopt test content -> deterministic fileId');
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('invite code E2E marker', () => {
  it('generateRoomCode marks E2E rooms and codeIsE2E parses it', () => {
    const plain = generateRoomCode();
    const sealed = generateRoomCode(true);
    expect(codeIsE2E(plain)).toBe(false);
    expect(sealed.endsWith('-e2e')).toBe(true);
    expect(codeIsE2E(sealed)).toBe(true);
    // Survives the copy/paste normalization joiners go through.
    expect(codeIsE2E(' Swift-Amber-Otter-Comet-4821-E2E ')).toBe(true);
    // Old-format codes (or hand-typed ones) never read as E2E.
    expect(codeIsE2E('swift-amber-otter-comet-4821')).toBe(false);
  });

  it('a joiner refuses to seed plaintext into an E2E room it has no secret for yet', async () => {
    const code = generateRoomCode(true);
    const J = await makeEngine();
    // The manager passes e2e:false for a bare code-join — the CODE alone must flip it.
    await cmd(J, joinPayload({ roomId: 'r-guard', code, memberId: 'member-J', folder: newFolder() }));
    const state = await cmd(J, { type: 'snapshot', roomId: 'r-guard' });
    expect(state.e2e).toBe(true); // learned from the code, no peer needed
    await expect(cmd(J, { type: 'addFiles', roomId: 'r-guard', paths: [sourceFile] }))
      .rejects.toThrow(/encryption key/i);
    const after = await cmd(J, { type: 'snapshot', roomId: 'r-guard' });
    expect(after.files).toHaveLength(0); // nothing was shared, plaintext or otherwise
  });
});

describe('owner-signed E2E config', () => {
  const S = generateRoomSecret();      // the room's real content secret
  const W = generateRoomSecret();      // what a hostile member tries to plant
  const ownerKeys = makeKeys();
  const OWNER = deriveMemberId(ownerKeys.pub); // memberId is the hash of the key (production anchor)

  it('a joiner adopts the owner-signed flag+secret and persists the blob', async () => {
    const code = generateRoomCode(true);
    const roomId = 'r-adopt';
    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: OWNER, ownerId: OWNER, e2e: true, secret: S, keys: ownerKeys, folder: newFolder() }));
    O.tracker = H.trackers[H.trackers.length - 1];
    const J = await makeEngine();
    await cmd(J, joinPayload({ roomId, code, memberId: 'member-J', folder: newFolder() }));
    J.tracker = H.trackers[H.trackers.length - 1];
    connect(O, J);
    await flush();

    const persisted = e2ePersists(J).at(-1);
    expect(persisted?.e2e).toBe(true);
    expect(persisted?.secret).toBe(S);
    expect(persisted?.cfg?.ownerId).toBe(OWNER);
    expect(cfgVerifies(persisted.cfg, topicHash(code), ownerKeys.pub)).toBe(true);
    const state = await cmd(J, { type: 'snapshot', roomId });
    expect(state.ownerId).toBe(OWNER);

    // With the secret in hand the joiner can share — encrypted, not plaintext.
    const shared = await cmd(J, { type: 'addFiles', roomId, paths: [sourceFile] });
    expect(shared.files).toHaveLength(1);
    expect(shared.files[0].enc).toBe(true);
  });

  it('a hostile member cannot plant a secret in a signed-format room; the owner still gets through', async () => {
    const code = generateRoomCode(true);
    const roomId = 'r-plant';
    const J = await makeEngine();
    await cmd(J, joinPayload({ roomId, code, memberId: 'member-J', folder: newFolder() }));
    J.tracker = H.trackers[H.trackers.length - 1];

    // Mallory races the owner: unsigned secret + a bald ownership claim.
    const mal = hostilePeer(J);
    mal.send(helloFrame(code, { e2e: true, secret: W, ownerId: 'MAL' }));
    await flush();
    expect(e2ePersists(J)).toHaveLength(0); // nothing adopted, nothing persisted

    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: OWNER, ownerId: OWNER, e2e: true, secret: S, keys: ownerKeys, folder: newFolder() }));
    O.tracker = H.trackers[H.trackers.length - 1];
    connect(O, J);
    await flush();

    const persisted = e2ePersists(J).at(-1);
    expect(persisted?.secret).toBe(S);
    // The signed config also corrects Mallory's unsigned ownership claim.
    const state = await cmd(J, { type: 'snapshot', roomId });
    expect(state.ownerId).toBe(OWNER);
  });

  it('rejects a forged config (attacker key) and a tampered one (owner sig, altered secret)', async () => {
    const code = generateRoomCode(true);
    const roomId = 'r-forge';
    const topic = topicHash(code);
    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: OWNER, ownerId: OWNER, e2e: true, secret: S, keys: ownerKeys, folder: newFolder() }));
    O.tracker = H.trackers[H.trackers.length - 1];
    const J = await makeEngine();
    await cmd(J, joinPayload({ roomId, code, memberId: 'member-J', folder: newFolder() }));
    J.tracker = H.trackers[H.trackers.length - 1];
    connect(O, J);
    await flush();
    const before = e2ePersists(J).length;
    const realCfg = e2ePersists(J).at(-1)!.cfg;

    // Forged: attacker signs with their OWN key but claims the owner's id.
    const att = makeKeys();
    const forgedCanon = Buffer.from(JSON.stringify(['th-room-e2e:v1', topic, OWNER, true, W]), 'utf8');
    const forged = {
      ownerId: OWNER, e2e: true, secret: W, pub: att.pub,
      sig: crypto.sign(null, forgedCanon, crypto.createPrivateKey(att.priv)).toString('base64'),
    };
    // Tampered: the owner's genuine signature over a swapped secret.
    const tampered = { ...realCfg, secret: W };
    const mal = hostilePeer(J);
    mal.send(helloFrame(code, { cfg: forged }));
    mal.send(helloFrame(code, { cfg: tampered }));
    await flush();

    expect(e2ePersists(J)).toHaveLength(before); // nothing new was adopted
    expect(e2ePersists(J).at(-1)?.secret).toBe(S);
  });

  it('members re-serve the signed config, so a joiner converges with the owner offline', async () => {
    const code = generateRoomCode(true);
    const roomId = 'r-relay';
    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: OWNER, ownerId: OWNER, e2e: true, secret: S, keys: ownerKeys, folder: newFolder() }));
    O.tracker = H.trackers[H.trackers.length - 1];
    const J1 = await makeEngine();
    await cmd(J1, joinPayload({ roomId, code, memberId: 'member-J1', folder: newFolder() }));
    J1.tracker = H.trackers[H.trackers.length - 1];
    const [pO] = connect(O, J1);
    await flush();
    expect(e2ePersists(J1).at(-1)?.secret).toBe(S);

    // Owner drops off; a fresh joiner reaches only J1.
    pO.destroy();
    const J2 = await makeEngine();
    await cmd(J2, joinPayload({ roomId, code, memberId: 'member-J2', folder: newFolder() }));
    J2.tracker = H.trackers[H.trackers.length - 1];
    connect(J1, J2);
    await flush();

    const persisted = e2ePersists(J2).at(-1);
    expect(persisted?.secret).toBe(S);
    expect(cfgVerifies(persisted.cfg, topicHash(code), ownerKeys.pub)).toBe(true);
  });

  it('legacy rooms: monotonic flag + adopt-once secret, and the owner-signed config recovers a planted one', async () => {
    const code = generateRoomCode(); // old format — no marker, unsigned gossip allowed
    const roomId = 'r-legacy';
    const J = await makeEngine();
    await cmd(J, joinPayload({ roomId, code, memberId: 'member-J', folder: newFolder() }));
    J.tracker = H.trackers[H.trackers.length - 1];

    // Mallory reaches the joiner first: the legacy path adopts once (old-owner
    // compatibility) — this is the denial-of-decryption plant.
    const mal = hostilePeer(J);
    mal.send(helloFrame(code, { e2e: true, secret: W, ownerId: 'MAL' }));
    await flush();
    expect(e2ePersists(J).at(-1)?.secret).toBe(W);

    // A second conflicting unsigned secret is logged, never obeyed…
    mal.send(helloFrame(code, { e2e: true, secret: generateRoomSecret() }));
    // …and an unsigned "downgrade to plaintext" is ignored outright.
    mal.send(helloFrame(code, { e2e: false }));
    await flush();
    expect(e2ePersists(J).at(-1)?.secret).toBe(W);
    expect((await cmd(J, { type: 'snapshot', roomId })).e2e).toBe(true);

    // The real owner appears: its SIGNED config overrides the plant (recovery).
    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: OWNER, ownerId: OWNER, e2e: true, secret: S, keys: ownerKeys, folder: newFolder() }));
    O.tracker = H.trackers[H.trackers.length - 1];
    connect(O, J);
    await flush();

    const persisted = e2ePersists(J).at(-1);
    expect(persisted?.secret).toBe(S);
    expect(persisted?.cfg?.ownerId).toBe(OWNER);
    expect((await cmd(J, { type: 'snapshot', roomId })).ownerId).toBe(OWNER);
  });

  it('kick/rekey keeps the marker, rotates the secret and keyrings the old one', async () => {
    const code = generateRoomCode(true);
    const roomId = 'r-rekey';
    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: OWNER, ownerId: OWNER, e2e: true, secret: S, keys: ownerKeys, folder: newFolder() }));
    O.tracker = H.trackers[H.trackers.length - 1];
    const J = await makeEngine();
    await cmd(J, joinPayload({ roomId, code, memberId: 'member-J', folder: newFolder() }));
    J.tracker = H.trackers[H.trackers.length - 1];
    const M = await makeEngine();
    await cmd(M, joinPayload({ roomId, code, memberId: 'member-M', folder: newFolder() }));
    M.tracker = H.trackers[H.trackers.length - 1];
    connect(O, J);
    connect(O, M);
    await flush();
    expect(e2ePersists(J).at(-1)?.secret).toBe(S);

    await cmd(O, { type: 'kick', roomId, memberId: 'member-M' });
    await new Promise((r) => setTimeout(r, 400)); // kickMember defers the rekey 300ms
    await flush();

    const rekey = J.sent.filter((s) => s.channel === 'room-rekey').map((s) => s.payload).at(-1);
    expect(rekey?.code).toBeTruthy();
    expect(rekey.code).not.toBe(code);
    expect(codeIsE2E(rekey.code)).toBe(true); // the replacement code keeps the marker
    expect(rekey.banId).toBe('member-M');     // the survivor bans the kicked identity

    // The survivor ends up holding a config re-signed over the NEW topic with
    // a ROTATED secret (the kicked member never receives it); the outgoing
    // secret lands in the decrypt-only keyring so old files stay readable.
    const persisted = e2ePersists(J).at(-1);
    expect(persisted?.secret).toBeTruthy();
    expect(persisted?.secret).not.toBe(S);
    expect(persisted?.prevSecrets).toContain(S);
    expect(persisted?.cfg).toBeTruthy();
    expect(cfgVerifies(persisted.cfg, topicHash(rekey.code), ownerKeys.pub)).toBe(true);
    expect(persisted.cfg.prevSecrets).toContain(S);          // keyring rides the cfg…
    expect(typeof persisted.cfg.prevSig).toBe('string');     // …under its own signature
  });
});

describe('owner pin: a joiner adopts only the pinned owner', () => {
  const OWNER = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 32-hex owner id carried in the invite

  it('rejects a self-declared impostor owner, then adopts the real pinned owner', async () => {
    const code = generateRoomCode();
    const roomId = 'r-pin';
    // J joined via the FULL invite, so it holds the owner pin = OWNER.
    const J = await makeEngine();
    await cmd(J, joinPayload({ roomId, code, memberId: 'member-J', ownerPin: OWNER, folder: newFolder() }));
    J.tracker = H.trackers[H.trackers.length - 1];

    // A hostile member races in first, claiming to be the owner with its OWN id.
    const mal = hostilePeer(J);
    mal.send(helloFrame(code, { memberId: 'MAL', ownerId: 'MAL' }));
    await flush();
    // The pin rejects it — J does NOT adopt the impostor as owner.
    expect((await cmd(J, { type: 'snapshot', roomId })).ownerId).toBe('');

    // The real owner (matching the pin) greets — now J adopts it.
    const real = hostilePeer(J);
    real.send(helloFrame(code, { memberId: OWNER, ownerId: OWNER }));
    await flush();
    expect((await cmd(J, { type: 'snapshot', roomId })).ownerId).toBe(OWNER);

    // A later impostor can no longer displace the established owner either.
    mal.send(helloFrame(code, { memberId: 'MAL2', ownerId: 'MAL2' }));
    await flush();
    expect((await cmd(J, { type: 'snapshot', roomId })).ownerId).toBe(OWNER);
  });

  it('without a pin, owner adoption is trust-on-first-use (unchanged fallback)', async () => {
    const code = generateRoomCode();
    const roomId = 'r-nopin';
    const J = await makeEngine();
    await cmd(J, joinPayload({ roomId, code, memberId: 'member-J', folder: newFolder() })); // no ownerPin
    J.tracker = H.trackers[H.trackers.length - 1];
    const p = hostilePeer(J);
    p.send(helloFrame(code, { memberId: 'FIRST', ownerId: 'FIRST' }));
    await flush();
    expect((await cmd(J, { type: 'snapshot', roomId })).ownerId).toBe('FIRST'); // first claim wins when unpinned
  });
});

describe('room rename: owner-only, signed, last-writer-wins', () => {
  const ownerKeys = makeKeys();
  const OWNER = deriveMemberId(ownerKeys.pub);

  it('the owner renames the room and a connected member applies it; a non-owner cannot', async () => {
    const code = generateRoomCode();
    const roomId = 'r-rename';
    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: OWNER, ownerId: OWNER, ownerPin: OWNER, keys: ownerKeys, folder: newFolder() }));
    O.tracker = H.trackers[H.trackers.length - 1];
    const J = await makeEngine();
    await cmd(J, joinPayload({ roomId, code, memberId: 'member-J', ownerPin: OWNER, folder: newFolder() }));
    J.tracker = H.trackers[H.trackers.length - 1];
    connect(O, J);
    await flush();
    // J adopts the pinned owner from O's hello.
    expect((await cmd(J, { type: 'snapshot', roomId })).ownerId).toBe(OWNER);

    // The owner renames — J applies it.
    await cmd(O, { type: 'rename', roomId, name: 'Movie Night' });
    await flush();
    expect((await cmd(J, { type: 'snapshot', roomId })).name).toBe('Movie Night');

    // A hostile member forges a rename with its OWN id — J ignores it (not the owner).
    const mal = hostilePeer(J);
    mal.send(encrypt(deriveKey(code), { t: 'rename', name: 'Hacked', at: Date.now() + 10_000, by: 'MAL', pub: 'x', sig: 'x' }));
    await flush();
    expect((await cmd(J, { type: 'snapshot', roomId })).name).toBe('Movie Night');

    // A stale (older `at`) owner-signed rename is ignored (last-writer-wins).
    const topic = topicHash(code);
    const staleAt = 1; // far in the past
    const canon = Buffer.from(JSON.stringify(['rename', topic, 'Old Name', staleAt, OWNER]), 'utf8');
    const sig = crypto.sign(null, canon, crypto.createPrivateKey(ownerKeys.priv)).toString('base64');
    mal.send(encrypt(deriveKey(code), { t: 'rename', name: 'Old Name', at: staleAt, by: OWNER, pub: ownerKeys.pub, sig }));
    await flush();
    expect((await cmd(J, { type: 'snapshot', roomId })).name).toBe('Movie Night');

    // A member floods an unsigned HELLO with a huge nameAt (>= 2^53) trying to
    // wedge the LWW clock so the owner can never rename again. It must be clamped.
    mal.send(helloFrame(code, { memberId: 'MAL', roomName: 'Movie Night', nameAt: 1e16, ownerId: OWNER }));
    await flush();

    // A genuinely newer owner rename still wins (the poison was clamped, not wedged).
    await cmd(O, { type: 'rename', roomId, name: 'Final Name' });
    await flush();
    expect((await cmd(J, { type: 'snapshot', roomId })).name).toBe('Final Name');
  }, 25000);

  it('a non-owner engine cannot rename its own room (engine refuses)', async () => {
    const code = generateRoomCode();
    const roomId = 'r-rename-noowner';
    const M = await makeEngine();
    // Owner is someone else (not us) — we're just a member.
    await cmd(M, joinPayload({ roomId, code, memberId: 'member-M', ownerId: OWNER, keys: makeKeys(), folder: newFolder() }));
    await expect(cmd(M, { type: 'rename', roomId, name: 'Nope' })).rejects.toThrow(/owner/i);
  });
});

describe('ownership transfer: signed chain over the invite pin (M8)', () => {
  const ownerKeys = makeKeys();
  const OWNER = deriveMemberId(ownerKeys.pub);
  const aKeys = makeKeys();
  const A_ID = deriveMemberId(aKeys.pub);

  /** Sign one transfer link exactly like the engine does — the signature domain
   *  is the chain's GENESIS owner id (chain[0].by), stable across rekeys, NOT the
   *  rotating topic. */
  function signTransfer(rootOwnerId: string, by: string, newOwnerId: string, at: number, priv: string): string {
    const canon = Buffer.from(JSON.stringify(['th-room-transfer:v1', rootOwnerId, by, newOwnerId, at]), 'utf8');
    return crypto.sign(null, canon, crypto.createPrivateKey(priv)).toString('base64');
  }

  /** The last ownership-transfer chain an engine persisted (room-transfer IPC). */
  const chainPersists = (inst: Engine) =>
    inst.sent.filter((s) => s.channel === 'room-transfer').map((s) => s.payload);

  it('a transfer applies at every live member and the new owner can kick', async () => {
    const code = generateRoomCode();
    const roomId = 'r-transfer';
    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: OWNER, ownerId: OWNER, ownerPin: OWNER, keys: ownerKeys, folder: newFolder() }));
    O.tracker = H.trackers[H.trackers.length - 1];
    const A = await makeEngine();
    await cmd(A, joinPayload({ roomId, code, memberId: A_ID, ownerPin: OWNER, keys: aKeys, folder: newFolder() }));
    A.tracker = H.trackers[H.trackers.length - 1];
    const B = await makeEngine();
    await cmd(B, joinPayload({ roomId, code, memberId: 'member-B', ownerPin: OWNER, keys: makeKeys(), folder: newFolder() }));
    B.tracker = H.trackers[H.trackers.length - 1];
    connect(O, A);
    connect(O, B);
    connect(A, B);
    await flush();
    expect((await cmd(B, { type: 'snapshot', roomId })).ownerId).toBe(OWNER);

    const after = await cmd(O, { type: 'transferOwner', roomId, memberId: A_ID });
    expect(after.ownerId).toBe(A_ID);
    expect(after.canManage).toBe(false); // the old owner is a regular member now
    await flush();

    // Every live member converges on the new owner and persists both the id and the chain.
    expect((await cmd(A, { type: 'snapshot', roomId })).ownerId).toBe(A_ID);
    expect((await cmd(A, { type: 'snapshot', roomId })).canManage).toBe(true);
    expect((await cmd(B, { type: 'snapshot', roomId })).ownerId).toBe(A_ID);
    expect(chainPersists(B).at(-1)?.chain).toHaveLength(1);
    expect(chainPersists(B).at(-1)?.chain[0]?.newOwnerId).toBe(A_ID);
    // The handover lands in the activity log on both sides.
    const hist = (await cmd(B, { type: 'snapshot', roomId })).history;
    expect(hist.some((ev: any) => ev.type === 'ownership-transferred' && ev.targetName === A_ID)).toBe(true);

    // The NEW owner kicks B; the OLD owner applies the rekey (it accepts A's authority).
    await cmd(A, { type: 'kick', roomId, memberId: 'member-B' });
    await new Promise((r) => setTimeout(r, 400)); // kickMember defers the rekey 300ms
    await flush();
    expect((await cmd(B, { type: 'snapshot', roomId })).kicked).toBe(true);
    const rekey = O.sent.filter((s) => s.channel === 'room-rekey').map((s) => s.payload).at(-1);
    expect(rekey?.code).toBeTruthy();
    expect(rekey.code).not.toBe(code);

    // And the OLD owner's own commands are refused now.
    await expect(cmd(O, { type: 'rename', roomId, name: 'Nope' })).rejects.toThrow(/owner/i);
  }, 25000);

  it('a pin-joiner on the OLD invite reaches the new owner through the chain', async () => {
    const code = generateRoomCode();
    const roomId = 'r-chainwalk';
    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: OWNER, ownerId: OWNER, ownerPin: OWNER, keys: ownerKeys, folder: newFolder() }));
    O.tracker = H.trackers[H.trackers.length - 1];
    const A = await makeEngine();
    await cmd(A, joinPayload({ roomId, code, memberId: A_ID, ownerPin: OWNER, keys: aKeys, folder: newFolder() }));
    A.tracker = H.trackers[H.trackers.length - 1];
    connect(O, A);
    await flush();
    await cmd(O, { type: 'transferOwner', roomId, memberId: A_ID });
    await flush();

    // J joins via the ORIGINAL invite (pin = the FIRST owner) and reaches only A.
    // A's re-served chain proves pin → A, so J adopts A despite the pin mismatch.
    const J = await makeEngine();
    await cmd(J, joinPayload({ roomId, code, memberId: 'member-J', ownerPin: OWNER, folder: newFolder() }));
    J.tracker = H.trackers[H.trackers.length - 1];
    connect(A, J);
    await flush();
    expect((await cmd(J, { type: 'snapshot', roomId })).ownerId).toBe(A_ID);
    expect(chainPersists(J).at(-1)?.chain).toHaveLength(1);
  }, 25000);

  it('a forged link kills the chain: the owner stays the last verified one', async () => {
    const code = generateRoomCode();
    const att = makeKeys();
    const MAL = deriveMemberId(att.pub);

    // Chain [pin → MAL] claiming by=OWNER but signed by the ATTACKER's key: the
    // very first link fails to verify, so nothing is adopted.
    const J1 = await makeEngine();
    await cmd(J1, joinPayload({ roomId: 'r-forged1', code, memberId: 'member-J1', ownerPin: OWNER, folder: newFolder() }));
    J1.tracker = H.trackers[H.trackers.length - 1];
    const forged = { newOwnerId: MAL, at: Date.now() - 1000, by: OWNER, pub: att.pub, sig: signTransfer(OWNER, OWNER, MAL, Date.now() - 1000, att.priv) };
    hostilePeer(J1).send(helloFrame(code, { ownerId: MAL, transferChain: [forged] }));
    await flush();
    expect((await cmd(J1, { type: 'snapshot', roomId: 'r-forged1' })).ownerId).toBe('');
    expect(chainPersists(J1)).toHaveLength(0);

    // Chain [pin → A (genuine), A → MAL (wrong key)]: the walk stops at the
    // break — A (the last verified hop) stays owner, the forged tail is dead.
    const J2 = await makeEngine();
    await cmd(J2, joinPayload({ roomId: 'r-forged2', code, memberId: 'member-J2', ownerPin: OWNER, folder: newFolder() }));
    J2.tracker = H.trackers[H.trackers.length - 1];
    const at1 = Date.now() - 2000;
    const at2 = Date.now() - 1000;
    // Domain = the chain's genesis owner (OWNER) for BOTH links.
    const good = { newOwnerId: A_ID, at: at1, by: OWNER, pub: ownerKeys.pub, sig: signTransfer(OWNER, OWNER, A_ID, at1, ownerKeys.priv) };
    const bad = { newOwnerId: MAL, at: at2, by: A_ID, pub: aKeys.pub, sig: signTransfer(OWNER, A_ID, MAL, at2, att.priv) };
    hostilePeer(J2).send(helloFrame(code, { ownerId: MAL, transferChain: [good, bad] }));
    await flush();
    expect((await cmd(J2, { type: 'snapshot', roomId: 'r-forged2' })).ownerId).toBe(A_ID);
    expect(chainPersists(J2).at(-1)?.chain).toHaveLength(1);
  });

  it('a transfer from a non-owner is dropped', async () => {
    const code = generateRoomCode();
    const roomId = 'r-nonowner';
    const J = await makeEngine();
    await cmd(J, joinPayload({ roomId, code, memberId: 'member-J', ownerId: OWNER, ownerPin: OWNER, folder: newFolder() }));
    J.tracker = H.trackers[H.trackers.length - 1];
    const att = makeKeys();
    const MAL = deriveMemberId(att.pub);
    const mal = hostilePeer(J);

    // A validly-SIGNED transfer whose signer simply isn't the owner: its chain
    // roots at MAL, which the pin (OWNER) does not anchor — dropped.
    const at = Date.now();
    mal.send(encrypt(deriveKey(code), { t: 'transfer', newOwnerId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', at, by: MAL, pub: att.pub, sig: signTransfer(MAL, MAL, 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', at, att.priv) }));
    // An owner-CLAIMED transfer signed with the attacker's key: signature dies.
    mal.send(encrypt(deriveKey(code), { t: 'transfer', newOwnerId: MAL, at: at + 1, by: OWNER, pub: att.pub, sig: signTransfer(OWNER, OWNER, MAL, at + 1, att.priv) }));
    await flush();
    expect((await cmd(J, { type: 'snapshot', roomId })).ownerId).toBe(OWNER);
    expect(chainPersists(J)).toHaveLength(0);

    // And a member engine refuses the local command outright.
    await expect(cmd(J, { type: 'transferOwner', roomId, memberId: OWNER })).rejects.toThrow(/owner/i);
  });

  it('after the transfer the NEW owner\'s signed E2E config is accepted (verify walk)', async () => {
    const S = generateRoomSecret();
    const code = generateRoomCode(true);
    const roomId = 'r-transfer-e2e';
    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: OWNER, ownerId: OWNER, ownerPin: OWNER, e2e: true, secret: S, keys: ownerKeys, folder: newFolder() }));
    O.tracker = H.trackers[H.trackers.length - 1];
    const A = await makeEngine();
    await cmd(A, joinPayload({ roomId, code, memberId: A_ID, ownerPin: OWNER, keys: aKeys, folder: newFolder() }));
    A.tracker = H.trackers[H.trackers.length - 1];
    connect(O, A);
    await flush();
    expect(e2ePersists(A).at(-1)?.secret).toBe(S); // A adopted the OLD owner's cfg

    await cmd(O, { type: 'transferOwner', roomId, memberId: A_ID });
    await flush();

    // A (now the owner) re-minted the config under ITS key, same topic + secret.
    const minted = e2ePersists(A).at(-1);
    expect(minted?.cfg?.ownerId).toBe(A_ID);
    expect(minted?.secret).toBe(S);
    expect(cfgVerifies(minted.cfg, topicHash(code), aKeys.pub)).toBe(true);
    // The OLD owner adopted the new owner's config too (its own became stale).
    const oldOwners = e2ePersists(O).at(-1);
    expect(oldOwners?.cfg?.ownerId).toBe(A_ID);

    // A pin-joiner on the OLD invite: chain walk first, then the NEW owner's
    // cfg verifies against the chain-proven owner — it gets the secret from A.
    const J = await makeEngine();
    await cmd(J, joinPayload({ roomId, code, memberId: 'member-J', ownerPin: OWNER, folder: newFolder() }));
    J.tracker = H.trackers[H.trackers.length - 1];
    connect(A, J);
    await flush();
    const adopted = e2ePersists(J).at(-1);
    expect(adopted?.secret).toBe(S);
    expect(adopted?.cfg?.ownerId).toBe(A_ID);
    expect((await cmd(J, { type: 'snapshot', roomId })).ownerId).toBe(A_ID);
  }, 25000);

  it('restart: the chain persists, restores past the pin and is re-served', async () => {
    const code = generateRoomCode();
    const roomId = 'r-restart';
    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: OWNER, ownerId: OWNER, ownerPin: OWNER, keys: ownerKeys, folder: newFolder() }));
    O.tracker = H.trackers[H.trackers.length - 1];
    const A = await makeEngine();
    await cmd(A, joinPayload({ roomId, code, memberId: A_ID, ownerPin: OWNER, keys: aKeys, folder: newFolder() }));
    A.tracker = H.trackers[H.trackers.length - 1];
    connect(O, A);
    await flush();
    await cmd(O, { type: 'transferOwner', roomId, memberId: A_ID });
    await flush();
    const chain = chainPersists(A).at(-1)?.chain;
    expect(chain).toHaveLength(1);

    // "Restart" A's install: a fresh engine fed the persisted ownerId + chain.
    // The pin no longer matches the owner — only the re-verified chain restores it.
    const R = await makeEngine();
    await cmd(R, joinPayload({ roomId, code, memberId: A_ID, ownerId: A_ID, ownerPin: OWNER, keys: aKeys, transferChain: chain, folder: newFolder() }));
    R.tracker = H.trackers[H.trackers.length - 1];
    expect((await cmd(R, { type: 'snapshot', roomId })).ownerId).toBe(A_ID);
    expect((await cmd(R, { type: 'snapshot', roomId })).canManage).toBe(true);

    // A TAMPERED persisted chain is rejected wholesale — the pin guard zeroes
    // the (non-pin) persisted owner and the room re-learns from peers.
    const T = await makeEngine();
    const tampered = [{ ...chain[0], newOwnerId: 'deadbeefdeadbeefdeadbeefdeadbeef' }];
    await cmd(T, joinPayload({ roomId: 'r-restart-bad', code, memberId: 'member-T', ownerId: A_ID, ownerPin: OWNER, transferChain: tampered, folder: newFolder() }));
    expect((await cmd(T, { type: 'snapshot', roomId: 'r-restart-bad' })).ownerId).toBe('');

    // The restarted install re-serves the chain: a fresh pin-joiner converges.
    const J = await makeEngine();
    await cmd(J, joinPayload({ roomId, code, memberId: 'member-J', ownerPin: OWNER, folder: newFolder() }));
    J.tracker = H.trackers[H.trackers.length - 1];
    connect(R, J);
    await flush();
    expect((await cmd(J, { type: 'snapshot', roomId })).ownerId).toBe(A_ID);
  }, 25000);

  it('transfer then a KICK (topic rotates) then restart still restores ownership', async () => {
    const code = generateRoomCode();
    const roomId = 'r-transfer-kick';
    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: OWNER, ownerId: OWNER, ownerPin: OWNER, keys: ownerKeys, folder: newFolder() }));
    O.tracker = H.trackers[H.trackers.length - 1];
    const A = await makeEngine();
    await cmd(A, joinPayload({ roomId, code, memberId: A_ID, ownerPin: OWNER, keys: aKeys, folder: newFolder() }));
    A.tracker = H.trackers[H.trackers.length - 1];
    const B = await makeEngine();
    await cmd(B, joinPayload({ roomId, code, memberId: 'member-B', ownerPin: OWNER, keys: makeKeys(), folder: newFolder() }));
    B.tracker = H.trackers[H.trackers.length - 1];
    connect(O, A);
    connect(O, B);
    connect(A, B);
    await flush();

    await cmd(O, { type: 'transferOwner', roomId, memberId: A_ID });
    await flush();
    const chain = chainPersists(A).at(-1)?.chain;
    expect(chain).toHaveLength(1);

    // The new owner A kicks B — this ROTATES the room code and topic. Transfer
    // links are signed over the stable genesis root, NOT the topic, so they must
    // still verify after the rotation.
    await cmd(A, { type: 'kick', roomId, memberId: 'member-B' });
    await new Promise((r) => setTimeout(r, 400));
    await flush();
    const rekey = A.sent.filter((s) => s.channel === 'room-rekey').map((s) => s.payload).find((p) => p?.code);
    const newCode = rekey.code as string;
    expect(newCode).not.toBe(code);
    const chainAfterKick = chainPersists(A).at(-1)?.chain;

    // "Restart" A with the ROTATED code (the persisted post-kick code) + the
    // chain signed under the ORIGINAL topic. Ownership must survive.
    const R = await makeEngine();
    await cmd(R, joinPayload({ roomId, code: newCode, memberId: A_ID, ownerId: A_ID, ownerPin: OWNER, keys: aKeys, transferChain: chainAfterKick, folder: newFolder() }));
    R.tracker = H.trackers[H.trackers.length - 1];
    expect((await cmd(R, { type: 'snapshot', roomId })).ownerId).toBe(A_ID);
    expect((await cmd(R, { type: 'snapshot', roomId })).canManage).toBe(true);
    // The restarted owner can still administer the room (rename doesn't throw).
    await expect(cmd(R, { type: 'rename', roomId, name: 'Still Mine' })).resolves.toBeTruthy();
  }, 25000);

  it('a mid-chain-pinned member re-serves the FULL chain, so an old-invite joiner converges without the root online', async () => {
    const code = generateRoomCode();
    const roomId = 'r-fullchain';
    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: OWNER, ownerId: OWNER, ownerPin: OWNER, keys: ownerKeys, folder: newFolder() }));
    O.tracker = H.trackers[H.trackers.length - 1];
    const A = await makeEngine();
    await cmd(A, joinPayload({ roomId, code, memberId: A_ID, ownerPin: OWNER, keys: aKeys, folder: newFolder() }));
    A.tracker = H.trackers[H.trackers.length - 1];
    const [pOA] = connect(O, A);
    await flush();
    await cmd(O, { type: 'transferOwner', roomId, memberId: A_ID });
    await flush();

    // E joins via A's NEW invite (pins the CURRENT owner A, mid-chain), reaching
    // only A. E must store and later re-serve the FULL chain [O→A], not a suffix.
    const E = await makeEngine();
    await cmd(E, joinPayload({ roomId, code, memberId: 'member-E', ownerPin: A_ID, folder: newFolder() }));
    E.tracker = H.trackers[H.trackers.length - 1];
    connect(A, E);
    await flush();
    expect((await cmd(E, { type: 'snapshot', roomId })).ownerId).toBe(A_ID);
    expect(chainPersists(E).at(-1)?.chain).toHaveLength(1); // the full [O→A], not empty

    // The root owner O drops off; a joiner D on the ORIGINAL invite (pin=O)
    // reaches only the mid-chain member E. E's re-served full chain lets D walk
    // pin O → A even though O is gone.
    pOA.destroy();
    const D = await makeEngine();
    await cmd(D, joinPayload({ roomId, code, memberId: 'member-D', ownerPin: OWNER, folder: newFolder() }));
    D.tracker = H.trackers[H.trackers.length - 1];
    connect(E, D);
    await flush();
    expect((await cmd(D, { type: 'snapshot', roomId })).ownerId).toBe(A_ID);
  }, 25000);
});
