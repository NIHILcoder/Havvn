import { watchHostCanonical, watchCanonical, type WatchMessage } from '../../shared/room-watch-sync';
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
import { GuestRoom } from '../../guest/mesh';
import { generateIdentityWeb } from '../../shared/room-web-crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { deriveKey, topicHash, encrypt, decrypt, generateRoomCode, codeIsE2E, deriveMemberId } from './room-crypto';
import { generateRoomSecret, decryptFile } from './room-e2e';
import { banSnapshotCanonical, ROOM_BAN_LIMIT, type RoomBanSnapshot } from '../../shared/room-bans';
import { mintKeyPages, contentKeyEpoch, verifyKeyMetadata, verifyKeyPage } from './room-keyring';

type Sent = { channel: string; payload: any };
type EngineCtx = {
  listeners: Record<string, (e: any, msg: any) => void>;
  sent: Sent[];
};

const H = vi.hoisted(() => ({
  clients: [] as any[],
  trackers: [] as any[],   // FakeTracker instances in creation order
}));

// WebTorrent stand-in: infoHash comes from real single-file torrent metadata, so the fileId
// is deterministic from content. add() never completes (not needed here).
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
    throttleUpload(): void { /* no-op */ }
    throttleDownload(): void { /* no-op */ }
    destroyed = false;
    constructor() { H.clients.push(this); }
    torrents = new Map<string, FakeTorrent>();
    handlers: Record<string, any[]> = {};
    on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
    once(ev: string, fn: any): void { this.on(ev, fn); }
    removeListener(ev: string, fn: any): void {
      this.handlers[ev] = (this.handlers[ev] ?? []).filter((f) => f !== fn);
    }
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
    destroy(cb?: () => void): void { this.destroyed = true; this.torrents.clear(); cb?.(); }
    get(infoHash: string): FakeTorrent | null {
      return (infoHash && this.torrents.get(infoHash)) || null;
    }
    remove(t: FakeTorrent, done?: () => void): void { this.torrents.delete(t.infoHash); done?.(); }
  }
  return { default: FakeWebTorrent };
});

// Rendezvous tracker stand-in: never touches the network; the test injects
// wires by emitting 'peer' on the captured instance.
vi.mock('bittorrent-tracker', () => {
  class FakeTracker {
    handlers: Record<string, any[]> = {};
    peerId: unknown;
    constructor(opts: { peerId: unknown }) { this.peerId = opts.peerId; H.trackers.push(this); }
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
  intercept?: (frame: any) => boolean;
  handlers: Record<string, any[]> = {};
  on(ev: string, fn: any): void { (this.handlers[ev] ??= []).push(fn); }
  once(ev: string, fn: any): void { this.on(ev, fn); }
  send(data: any): void {
    if (this.intercept && !this.intercept(data)) return;
    const o = this.other;
    if (!o || !o.connected) return;
    queueMicrotask(() => { for (const fn of o.handlers['data'] ?? []) fn(data); });
  }
  destroy(): void {
    this.connected = false;
    for (const fn of this.handlers['close'] ?? []) fn();
  }
}

// A rekey replaces the tracker; keep test connections on the current rendezvous.
const currentTracker = (inst: { tracker: { peerId: unknown } }) => H.trackers.findLast(t => t.peerId === inst.tracker.peerId) ?? inst.tracker;
function connect(a: { tracker: any }, b: { tracker: any }): [FakePeer, FakePeer] {
  const pA = new FakePeer(); const pB = new FakePeer();
  pA.other = pB; pB.other = pA;
  currentTracker(a).emitPeer(pA);
  currentTracker(b).emitPeer(pB);
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
  transferChain?: any[]; bans?: string[]; banState?: RoomBanSnapshot; prevSecrets?: string[]; keyPages?: any[]; manifest?: any[] }) {
  return {
    type: 'join',
    payload: {
      roomId: o.roomId, name: 'E2E adopt test', code: o.code, folder: o.folder,
      self: { memberId: o.memberId, name: o.memberId, avatarSeed: o.memberId, pub: o.keys?.pub ?? '', priv: o.keys?.priv ?? '' },
      useTurn: false, turnServers: [],
      tombstones: {}, manifest: o.manifest || [], ownerId: o.ownerId ?? '', ownerPin: o.ownerPin ?? '', mutes: [], history: [], chat: [],
      identities: {}, e2e: o.e2e ?? false, secret: o.secret ?? '', e2eCfg: o.e2eCfg ?? null,
      transferChain: o.transferChain ?? [], bans: o.bans ?? [], banState: o.banState, prevSecrets: o.prevSecrets ?? [], keyPages: o.keyPages ?? [],
      cacheDir: path.join(o.folder, 'enc'),
    },
  };
}

/** Attach a test-controlled raw peer to an engine (a member gone hostile:
 *  it holds the code, but the test decides every frame it sends). */
function hostilePeer(inst: Engine): FakePeer {
  const pEngine = new FakePeer(); const pTest = new FakePeer();
  pEngine.other = pTest; pTest.other = pEngine;
  currentTracker(inst).emitPeer(pEngine);
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
    const bKeys = makeKeys(), B_ID = deriveMemberId(bKeys.pub);
    const B = await makeEngine();
    await cmd(B, joinPayload({ roomId, code, memberId: B_ID, ownerPin: OWNER, keys: bKeys, folder: newFolder() }));
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
    await cmd(A, { type: 'kick', roomId, memberId: B_ID });
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
    // A malformed nested proof rejects the whole frame before relay.
    expect((await cmd(J2, { type: 'snapshot', roomId: 'r-forged2' })).ownerId).toBe('');
    hostilePeer(J2).send(helloFrame(code, { ownerId: A_ID, transferChain: [good] }));
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


describe('paged E2E history across many rotations and offline-owner joins', () => {
  it('keeps the original file readable after 12 rotations, restarts and an offline-owner late join', async () => {
    const roomId = 'many-epochs', original = generateRoomSecret(), keys = makeKeys(), ownerId = deriveMemberId(keys.pub);
    let code = generateRoomCode(true);
    const O = await makeEngine();
    await cmd(O, joinPayload({ roomId, code, memberId: ownerId, ownerId, ownerPin: ownerId, e2e: true, secret: original, keys, folder: newFolder() }));
    O.tracker = H.trackers.at(-1);
    const state = await cmd(O, { type: 'addFiles', roomId, paths: [sourceFile] });
    expect(state.files[0].keyEpoch).toBe(contentKeyEpoch(original));
    const manifest = O.sent.filter(s => s.channel === 'room-manifest-add').at(-1)!.payload.file;
    for (let i = 0; i < 12; i++) {
      await cmd(O, { type: 'kick', roomId, memberId: 'removed-' + i });
      await vi.waitFor(() => { if (e2ePersists(O).length < i + 1) throw Error('waiting for rekey'); }, { timeout: 1500, interval: 15 });
      code = O.sent.filter(s => s.channel === 'room-rekey').at(-1)!.payload.code;
    }
    const saved = e2ePersists(O).at(-1)!;
    expect(saved.prevSecrets).toHaveLength(12); expect(saved.prevSecrets).toContain(original);
    expect(saved.cfg.prevSecrets).toHaveLength(8); expect(saved.cfg.prevSecrets).not.toContain(original);
    expect(verifyKeyMetadata(topicHash(code), saved.cfg)).toBe(true); expect(saved.keyPages.every((p: any) => verifyKeyPage(topicHash(code), saved.cfg, p))).toBe(true);
    const R = await makeEngine(), relayKeys = makeKeys();
    await cmd(R, joinPayload({ roomId, code, memberId: deriveMemberId(relayKeys.pub), ownerId, ownerPin: ownerId, e2e: true, secret: saved.secret,
      e2eCfg: saved.cfg, prevSecrets: saved.prevSecrets, keyPages: saved.keyPages, keys: relayKeys, folder: newFolder() }));
    R.tracker = H.trackers.at(-1);
    await cmd(O, { type: 'leave', roomId }); // owner is genuinely absent from the joined mesh
    const J = await makeEngine(), folder = newFolder(), guestKeys = makeKeys();
    await cmd(J, joinPayload({ roomId, code, memberId: deriveMemberId(guestKeys.pub), ownerPin: ownerId, keys: guestKeys, folder,
      manifest: [{ ...manifest, localPath: undefined, localOriginal: false }] }));
    J.tracker = H.trackers.at(-1); connect(R, J); await flush(50);
    const learned = e2ePersists(J).at(-1)!;
    expect(learned.prevSecrets).toContain(original); expect(learned.keyPages).toHaveLength(saved.cfg.keys.pages);
    await vi.waitFor(async () => { const snapshot = await cmd(J, { type: 'snapshot', roomId }); expect(snapshot.transfers[manifest.fileId].haveLocally).toBe(true); }, { timeout: 2500, interval: 30 });
    const snapshot = await cmd(J, { type: 'snapshot', roomId });
    expect(fs.readFileSync(snapshot.transfers[manifest.fileId].localPath)).toEqual(fs.readFileSync(sourceFile));
    const plain = path.join(folder, 'independent-output'); await decryptFile(manifest.cipherPath, plain, learned.prevSecrets.find((s: string) => contentKeyEpoch(s) === manifest.keyEpoch));
    expect(fs.readFileSync(plain)).toEqual(fs.readFileSync(sourceFile));
    await cmd(R, { type: 'leave', roomId }); await cmd(J, { type: 'leave', roomId });
  }, 20_000);
});


describe('key-history integrity and transfer ordering', () => {
  it('finishes paged history before a newly elected owner re-signs it, and ignores stripped/forged pages', async () => {
    const roomId = 'transfer-history', code = generateRoomCode(true), secret = generateRoomSecret(), owner = makeKeys(), next = makeKeys();
    const ownerId = deriveMemberId(owner.pub), nextId = deriveMemberId(next.pub);
    const previous = Array.from({ length: 80 }, () => generateRoomSecret());
    const O = await makeEngine(); await cmd(O, joinPayload({ roomId, code, memberId: ownerId, ownerId, ownerPin: ownerId, e2e: true, secret, prevSecrets: previous, keys: owner, folder: newFolder() })); O.tracker = H.trackers.at(-1);
    const J = await makeEngine(); await cmd(J, joinPayload({ roomId, code, memberId: nextId, ownerPin: ownerId, keys: next, folder: newFolder() })); J.tracker = H.trackers.at(-1);
    const held: any[] = [], [outgoing] = connect(O, J);
    outgoing.intercept = frame => { const msg = decrypt<any>(deriveKey(code), frame); if (msg.t === 'e2e-keys') { held.push(frame); return false; } return true; };
    await flush();
    const cfg = e2ePersists(J).at(-1)!.cfg;
    expect(cfg.keys.total).toBe(81); expect(held).toHaveLength(3); expect(e2ePersists(J).at(-1)!.prevSecrets).toHaveLength(8);
    const hostile = hostilePeer(J), relayed: any[] = [];
    outgoing.other!.intercept = frame => { relayed.push(decrypt(deriveKey(code), frame)); return true; };
    const wrong = { ...decrypt<any>(deriveKey(code), held[0]), root: 'f'.repeat(64), _g: 'wrong-page' };
    hostile.send(encrypt(deriveKey(code), wrong));
    const stripped = { ...cfg }; delete stripped.keys;
    hostile.send(helloFrame(code, { cfg: stripped })); await flush();
    expect(e2ePersists(J).at(-1)!.cfg.keys.root).toBe(cfg.keys.root); expect(relayed.some(m => m._g === 'wrong-page')).toBe(false);
    await cmd(O, { type: 'transferOwner', roomId, memberId: nextId }); await flush();
    expect((await cmd(J, { type: 'snapshot', roomId })).ownerId).toBe(nextId);
    expect(e2ePersists(J).at(-1)!.cfg.ownerId).toBe(ownerId); // no partial-history mint
    await expect(cmd(J, { type: 'kick', roomId, memberId: 'someone' })).rejects.toThrow(/history to finish/);
    outgoing.intercept = undefined;
    for (const frame of [...held].reverse()) outgoing.send(frame); await flush(50);
    const minted = e2ePersists(J).at(-1)!;
    expect(minted.cfg.ownerId).toBe(nextId); expect(minted.cfg.keys.total).toBe(81); expect(minted.prevSecrets).toHaveLength(80);
    expect(minted.prevSecrets).toEqual(expect.arrayContaining(previous)); expect(minted.keyPages.every((p: any) => verifyKeyPage(topicHash(code), minted.cfg, p))).toBe(true);
    await cmd(O, { type: 'leave', roomId }); await cmd(J, { type: 'leave', roomId });
  }, 15_000);
  it('answers missing-page requests after throttling expires without silently discarding history', async () => {
    const roomId = 'retry-keys', code = generateRoomCode(true), keys = makeKeys(), ownerId = deriveMemberId(keys.pub), secret = generateRoomSecret();
    const O = await makeEngine(); await cmd(O, joinPayload({ roomId, code, memberId: ownerId, ownerId, ownerPin: ownerId, e2e: true, secret, keys, prevSecrets: Array.from({ length: 40 }, () => generateRoomSecret()), folder: newFolder() })); O.tracker = H.trackers.at(-1);
    const J = await makeEngine(); await cmd(J, joinPayload({ roomId, code, memberId: 'retry-member', ownerPin: ownerId, folder: newFolder() })); J.tracker = H.trackers.at(-1);
    const [outgoing] = connect(O, J); let dropped = 0;
    outgoing.intercept = frame => { const m = decrypt<any>(deriveKey(code), frame); if (m.t === 'e2e-keys' && m.page === 0) { dropped++; return false; } return true; }; await flush();
    expect(dropped).toBe(1); const cfg = e2ePersists(J).at(-1)!.cfg;
    outgoing.send(helloFrame(code, { memberId: ownerId, pub: keys.pub, ownerId, cfg })); await flush(); expect(dropped).toBe(1);
    outgoing.intercept = undefined; const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 15_100);
    try { outgoing.send(helloFrame(code, { memberId: ownerId, pub: keys.pub, ownerId, cfg })); await flush(); } finally { clock.mockRestore(); }
    expect(e2ePersists(J).at(-1)!.keyPages).toHaveLength(2); expect(e2ePersists(J).at(-1)!.prevSecrets).toHaveLength(40);
    await cmd(O, { type: 'leave', roomId }); await cmd(J, { type: 'leave', roomId });
  }, 15_000);
});


describe('rotation retention boundaries', () => {
  it('rejects concurrent kicks before generating a conflicting content/gossip epoch', async () => {
    const roomId = 'rotate-once', code = generateRoomCode(true), keys = makeKeys(), ownerId = deriveMemberId(keys.pub);
    const O = await makeEngine(); await cmd(O, joinPayload({ roomId, code, memberId: ownerId, ownerId, e2e: true, secret: generateRoomSecret(), keys, folder: newFolder() }));
    await cmd(O, { type: 'kick', roomId, memberId: 'first' });
    await expect(cmd(O, { type: 'kick', roomId, memberId: 'second' })).rejects.toThrow(/already in progress/);
    await expect(cmd(O, { type: 'transferOwner', roomId, memberId: 'other' })).rejects.toThrow(/already in progress/);
    await vi.waitFor(() => expect(e2ePersists(O)).toHaveLength(1), { timeout: 1500 });
    expect(e2ePersists(O)[0].prevSecrets).toHaveLength(1); await cmd(O, { type: 'leave', roomId });
  });
  it('refuses rotation at the bounded history limit without deleting an old key or emitting a rekey', async () => {
    const roomId = 'full-key-history', code = generateRoomCode(true), keys = makeKeys(), ownerId = deriveMemberId(keys.pub), secret = generateRoomSecret();
    const previous = Array.from({ length: 2047 }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
    const O = await makeEngine(); await cmd(O, joinPayload({ roomId, code, memberId: ownerId, ownerId, e2e: true, secret, prevSecrets: previous, keys, folder: newFolder() }));
    await expect(cmd(O, { type: 'kick', roomId, memberId: 'member' })).rejects.toThrow(/history is full/);
    expect((await cmd(O, { type: 'snapshot', roomId })).code).toBe(code); expect(e2ePersists(O)).toEqual([]);
    await cmd(O, { type: 'leave', roomId });
  }, 10_000);
});


describe('current-owner key provenance after transfer', () => {
  it('does not let a former owner replace the verified current content key/history', async () => {
    const roomId = 'no-past-key-rollback', code = generateRoomCode(true), secret = generateRoomSecret(), owner = makeKeys(), next = makeKeys();
    const ownerId = deriveMemberId(owner.pub), nextId = deriveMemberId(next.pub);
    const O = await makeEngine(); await cmd(O, joinPayload({ roomId, code, memberId: ownerId, ownerId, ownerPin: ownerId, e2e: true, secret, keys: owner, folder: newFolder() })); O.tracker = H.trackers.at(-1);
    const J = await makeEngine(); await cmd(J, joinPayload({ roomId, code, memberId: nextId, ownerPin: ownerId, keys: next, folder: newFolder() })); J.tracker = H.trackers.at(-1);
    connect(O, J); await flush(); const oldCfg = e2ePersists(J).at(-1)!.cfg;
    await cmd(O, { type: 'transferOwner', roomId, memberId: nextId }); await flush();
    const current = e2ePersists(J).at(-1)!; expect(current.cfg.ownerId).toBe(nextId);
    const forged = { ownerId, e2e: true, secret: generateRoomSecret(), pub: owner.pub, sig: '' };
    forged.sig = crypto.sign(null, Buffer.from(JSON.stringify(['th-room-e2e:v1', topicHash(code), ownerId, true, forged.secret])), crypto.createPrivateKey(owner.priv)).toString('base64');
    mintKeyPages(topicHash(code), forged, [], owner.priv); const malicious = hostilePeer(J);
    malicious.send(helloFrame(code, { cfg: forged })); malicious.send(helloFrame(code, { cfg: oldCfg })); await flush();
    expect(e2ePersists(J).at(-1)!.cfg.ownerId).toBe(nextId); expect(e2ePersists(J).at(-1)!.secret).toBe(secret); expect(e2ePersists(J).at(-1)!.cfg.keys.root).toBe(current.cfg.keys.root);
    await cmd(O, { type: 'leave', roomId }); await cmd(J, { type: 'leave', roomId });
  }, 10_000);
});

const banPersists = (inst: Engine) => inst.sent.filter(s => s.channel === 'room-bans').map(s => s.payload);
function banProof(code: string, who: { pub: string; priv: string }, bans: string[], revision = 1): RoomBanSnapshot {
  const p: RoomBanSnapshot = { v: 1, ownerId: deriveMemberId(who.pub), revision, bans: [...bans].sort(), pub: who.pub, sig: '' };
  p.sig = crypto.sign(null, banSnapshotCanonical(topicHash(code), p), who.priv).toString('base64'); return p;
}
describe('desktop signed room bans', () => {
  it('serves the complete signed bans after a kick, holder restart and owner departure; a leaked code does not admit the banned profile', async () => {
    const code = generateRoomCode(true), keys = makeKeys(), holderKeys = makeKeys(), bannedKeys = makeKeys();
    const owner = deriveMemberId(keys.pub), holderId = deriveMemberId(holderKeys.pub), bannedId = deriveMemberId(bannedKeys.pub);
    const a = await makeEngine(), h = await makeEngine(); const secret = generateRoomSecret(), folder = newFolder();
    await cmd(a, joinPayload({ roomId: 'ban-owner', code, memberId: owner, folder: newFolder(), ownerId: owner, keys, e2e: true, secret })); a.tracker = H.trackers.at(-1);
    await cmd(h, joinPayload({ roomId: 'ban-holder', code, memberId: holderId, folder, ownerPin: owner, keys: holderKeys })); h.tracker = H.trackers.at(-1);
    connect(a, h); await flush(); await cmd(a, { type: 'kick', roomId: 'ban-owner', memberId: bannedId });
    await new Promise(r => setTimeout(r, 380)); await flush();
    const state = await cmd(h, { type: 'snapshot', roomId: 'ban-holder' }), saved = banPersists(h).at(-1), cfg = e2ePersists(h).at(-1);
    expect(saved.bans).toContain(bannedId); expect(saved.banState.bans).toContain(bannedId);
    expect(crypto.verify(null, banSnapshotCanonical(topicHash(state.code), saved.banState), keys.pub, Buffer.from(saved.banState.sig, 'base64'))).toBe(true);
    await cmd(a, { type: 'leave', roomId: 'ban-owner' }); await cmd(h, { type: 'leave', roomId: 'ban-holder' });
    const restarted = await makeEngine();
    await cmd(restarted, joinPayload({ roomId: 'ban-restarted', code: state.code, memberId: holderId, folder, ownerId: owner, ownerPin: owner, keys: holderKeys,
      bans: saved.bans, banState: saved.banState, e2e: true, secret: cfg.secret, e2eCfg: cfg.cfg, prevSecrets: cfg.prevSecrets, keyPages: cfg.keyPages })); restarted.tracker = H.trackers.at(-1);
    const late = await makeEngine(), lateKeys = makeKeys();
    await cmd(late, joinPayload({ roomId: 'ban-late', code: state.code, memberId: deriveMemberId(lateKeys.pub), folder: newFolder(), ownerPin: owner, keys: lateKeys })); late.tracker = H.trackers.at(-1);
    connect(restarted, late); await flush(); expect(banPersists(late).at(-1).banState).toEqual(saved.banState);
    const guest = new GuestRoom({ identity: await generateIdentityWeb(), name: 'Guest', avatarSeed: 'guest', trackers: [], onChange: vi.fn() });
    const g = guest as any; g.key = new Uint8Array(deriveKey(state.code)); g.topic = topicHash(state.code); g.code = state.code; guest.ownerPin = owner;
    const rec = { id: 1, wire: { send: vi.fn(), destroy: vi.fn() } }; g.wires.set(1, rec);
    const captured: string[] = [], probe = hostilePeer(restarted); probe.on('data', raw => captured.push(String(raw))); await flush();
    for (const raw of captured) await g.onFrame(rec, raw);
    expect(g.banState).toEqual(saved.banState); expect(g.bans.has(bannedId)).toBe(true); g.teardown();
    const excluded = await makeEngine();
    await cmd(excluded, joinPayload({ roomId: 'ban-excluded', code: state.code, memberId: bannedId, folder: newFolder(), ownerPin: owner, keys: bannedKeys })); excluded.tracker = H.trackers.at(-1);
    connect(restarted, excluded); await flush();
    expect((await cmd(excluded, { type: 'snapshot', roomId: 'ban-excluded' })).kicked).toBe(true);
    expect(e2ePersists(excluded)).toHaveLength(0);
    for (const [inst, id] of [[late, 'ban-late'], [excluded, 'ban-excluded'], [restarted, 'ban-restarted']] as const) await cmd(inst, { type: 'leave', roomId: id });
  }, 15_000); // Six real crypto sessions, deferred rekey and five graceful teardowns exceed 5s on Windows.
  it('rejects modified signatures, other owners, lower revisions and implicit unbans before forwarding them', async () => {
    const code = generateRoomCode(), keys = makeKeys(), selfKeys = makeKeys(), other = makeKeys();
    const owner = deriveMemberId(keys.pub), banned = deriveMemberId(other.pub), inst = await makeEngine();
    await cmd(inst, joinPayload({ roomId: 'ban-invalid', code, memberId: deriveMemberId(selfKeys.pub), folder: newFolder(), ownerPin: owner, keys: selfKeys })); inst.tracker = H.trackers.at(-1);
    const raw = hostilePeer(inst), proof = banProof(code, keys, [banned], 2);
    raw.send(helloFrame(code, { ownerId: owner, banState: { ...proof, bans: [] } })); await flush(); expect(banPersists(inst)).toHaveLength(0);
    raw.send(helloFrame(code, { ownerId: owner, banState: banProof(code, other, [owner]) })); await flush(); expect(banPersists(inst)).toHaveLength(0);
    raw.send(helloFrame(code, { ownerId: owner, banState: proof })); await flush(); expect(banPersists(inst).at(-1).banState).toEqual(proof);
    raw.send(helloFrame(code, { ownerId: owner, banState: banProof(code, keys, [], 3) }));
    raw.send(helloFrame(code, { ownerId: owner, banState: banProof(code, keys, [banned], 1) }));
    raw.send(helloFrame(code, { ownerId: owner })); await flush(); expect(banPersists(inst).at(-1).banState).toEqual(proof);
    await cmd(inst, { type: 'leave', roomId: 'ban-invalid' });
  });
  it('stops file swarms as well as gossip when an authenticated snapshot excludes self, without deleting the source', async () => {
    const code = generateRoomCode(), keys = makeKeys(), selfKeys = makeKeys(), self = deriveMemberId(selfKeys.pub), inst = await makeEngine();
    await cmd(inst, joinPayload({ roomId: 'ban-stop', code, memberId: self, folder: newFolder(), ownerPin: deriveMemberId(keys.pub), keys: selfKeys })); inst.tracker = H.trackers.at(-1);
    await cmd(inst, { type: 'addFiles', roomId: 'ban-stop', paths: [sourceFile] }); const client = H.clients.at(-1);
    hostilePeer(inst).send(helloFrame(code, { ownerId: deriveMemberId(keys.pub), banState: banProof(code, keys, [self]) })); await flush();
    expect((await cmd(inst, { type: 'snapshot', roomId: 'ban-stop' })).kicked).toBe(true); expect(client.destroyed).toBe(true); expect(fs.existsSync(sourceFile)).toBe(true);
    await cmd(inst, { type: 'leave', roomId: 'ban-stop' });
  });
  it('does not silently evict bans when their history is full', async () => {
    const code = generateRoomCode(), keys = makeKeys(), owner = deriveMemberId(keys.pub), inst = await makeEngine();
    const bans = Array.from({ length: ROOM_BAN_LIMIT }, (_, i) => String(i).padStart(32, '0'));
    await cmd(inst, joinPayload({ roomId: 'ban-limit', code, memberId: owner, folder: newFolder(), ownerId: owner, keys, bans })); inst.tracker = H.trackers.at(-1);
    await expect(cmd(inst, { type: 'kick', roomId: 'ban-limit', memberId: 'new-profile' })).rejects.toThrow('ban history is full');
    expect((await cmd(inst, { type: 'snapshot', roomId: 'ban-limit' })).code).toBe(code); expect(banPersists(inst).at(-1).bans).toEqual(bans);
    await cmd(inst, { type: 'leave', roomId: 'ban-limit' });
  });
});

describe('desktop ban proof ownership', () => {
  it('inherits bans on transfer and preserves the chain when the former owner is then banned', async () => {
    const code = generateRoomCode(), oldKeys = makeKeys(), nextKeys = makeKeys(), old = deriveMemberId(oldKeys.pub), next = deriveMemberId(nextKeys.pub);
    const a = await makeEngine(); await cmd(a, joinPayload({ roomId: 'ban-transfer-a', code, memberId: old, ownerId: old, keys: oldKeys, folder: newFolder(), bans: ['removed-before-transfer'] })); a.tracker = H.trackers.at(-1);
    const b = await makeEngine(); await cmd(b, joinPayload({ roomId: 'ban-transfer-b', code, memberId: next, ownerPin: old, keys: nextKeys, folder: newFolder() })); b.tracker = H.trackers.at(-1);
    connect(a, b); await flush(); await cmd(a, { type: 'transferOwner', roomId: 'ban-transfer-a', memberId: next }); await flush();
    expect(banPersists(b).at(-1).banState).toMatchObject({ ownerId: next, bans: ['removed-before-transfer'] });
    await cmd(b, { type: 'kick', roomId: 'ban-transfer-b', memberId: old }); await new Promise(r => setTimeout(r, 380)); await flush();
    const state = await cmd(b, { type: 'snapshot', roomId: 'ban-transfer-b' });
    expect((await cmd(a, { type: 'snapshot', roomId: 'ban-transfer-a' })).kicked).toBe(true);
    const c = await makeEngine(), cKeys = makeKeys();
    await cmd(c, joinPayload({ roomId: 'ban-transfer-late', code: state.code, memberId: deriveMemberId(cKeys.pub), ownerPin: old, keys: cKeys, folder: newFolder() })); c.tracker = H.trackers.at(-1);
    connect(b, c); await flush(); expect((await cmd(c, { type: 'snapshot', roomId: 'ban-transfer-late' })).ownerId).toBe(next);
    expect(banPersists(c).at(-1).bans).toContain(old); expect(banPersists(c).at(-1).bans).toContain('removed-before-transfer');
    const observed: any[] = [], observer = hostilePeer(c); observer.on('data', raw => observed.push(decrypt(deriveKey(state.code), String(raw))));
    observer.send(helloFrame(state.code, { memberId: 'observer' })); await flush();
    const forkKeys = makeKeys(), forkOwner = deriveMemberId(forkKeys.pub), originalChain = b.sent.filter(e => e.channel === 'room-transfer').at(-1)!.payload.chain;
    const forkBody = { by: old, newOwnerId: forkOwner, at: originalChain[0].at + 1 };
    const forkSig = crypto.sign(null, Buffer.from(JSON.stringify(['th-room-transfer:v1', old, old, forkOwner, forkBody.at])), oldKeys.priv).toString('base64');
    hostilePeer(c).send(helloFrame(state.code, { ownerId: forkOwner, transferChain: [{ ...forkBody, pub: oldKeys.pub, sig: forkSig }], banState: banProof(state.code, forkKeys, [next]), _g: 'banned-owner-fork', _t: 4 })); await flush();
    expect((await cmd(c, { type: 'snapshot', roomId: 'ban-transfer-late' })).ownerId).toBe(next);
    expect(banPersists(c).at(-1).bans).not.toContain(next);
    expect(observed.some(m => m._g === 'banned-owner-fork')).toBe(false);
    const keys = makeKeys(), d = await makeEngine();
    await cmd(d, joinPayload({ roomId: 'ban-poison', code, memberId: deriveMemberId(keys.pub), ownerId: old, ownerPin: old, keys, folder: newFolder() })); d.tracker = H.trackers.at(-1);
    const chain = b.sent.filter(e => e.channel === 'room-transfer').at(-1)!.payload.chain;
    hostilePeer(d).send(helloFrame(code, { ownerId: next, transferChain: chain, banState: banProof(code, oldKeys, [next]) })); await flush();
    expect((await cmd(d, { type: 'snapshot', roomId: 'ban-poison' })).ownerId).toBe(next);
    expect(banPersists(d).some(p => p.bans.includes(next))).toBe(false);
    for (const [inst, id] of [[a, 'ban-transfer-a'], [b, 'ban-transfer-b'], [c, 'ban-transfer-late'], [d, 'ban-poison']] as const) await cmd(inst, { type: 'leave', roomId: id });
  }, 15_000); // Four real crypto sessions, a deferred kick and graceful store teardown.
});

it('receives ban history when a signed live handover arrives before any owner hello', async () => {
  const code = generateRoomCode(), oldKeys = makeKeys(), selfKeys = makeKeys(), old = deriveMemberId(oldKeys.pub), self = deriveMemberId(selfKeys.pub), inst = await makeEngine();
  await cmd(inst, joinPayload({ roomId: 'ban-first-transfer', code, memberId: self, ownerPin: old, keys: selfKeys, folder: newFolder() })); inst.tracker = H.trackers.at(-1);
  const body = { by: old, newOwnerId: self, at: Date.now() };
  const sig = crypto.sign(null, Buffer.from(JSON.stringify(['th-room-transfer:v1', old, old, self, body.at])), oldKeys.priv).toString('base64');
  hostilePeer(inst).send(encrypt(deriveKey(code), { t: 'transfer', ...body, pub: oldKeys.pub, sig, banState: banProof(code, oldKeys, ['previously-removed']) })); await flush();
  expect((await cmd(inst, { type: 'snapshot', roomId: 'ban-first-transfer' })).ownerId).toBe(self);
  expect(banPersists(inst).at(-1).banState).toMatchObject({ ownerId: self, bans: ['previously-removed'] });
  await cmd(inst, { type: 'leave', roomId: 'ban-first-transfer' });
});

describe('desktop watch host authority', () => {
  it('chooses an acknowledged host, blocks follower controls, relays requests and serves late joiners', async () => {
    const code = generateRoomCode(), roomId = 'watch-host-authority', ownerKeys = makeKeys(), viewerKeys = makeKeys();
    const owner = deriveMemberId(ownerKeys.pub), viewer = deriveMemberId(viewerKeys.pub);
    const a = await makeEngine(); await cmd(a, joinPayload({ roomId, code, memberId: owner, ownerId: owner, keys: ownerKeys, folder: newFolder() })); a.tracker = H.trackers.at(-1);
    const b = await makeEngine(); await cmd(b, joinPayload({ roomId, code, memberId: viewer, ownerPin: owner, keys: viewerKeys, folder: newFolder() })); b.tracker = H.trackers.at(-1);
    connect(a, b); await flush(); const added = await cmd(a, { type: 'addFiles', roomId, paths: [sourceFile] }); await flush();
    const fileId = added.files[0].fileId;
    try {
      await expect(cmd(b, { type: 'watchPolicy', roomId, hostId: viewer })).rejects.toThrow('Only the room owner');
      await expect(cmd(a, { type: 'watchPolicy', roomId, hostId: 'missing' })).rejects.toThrow('unavailable');
      const state = await cmd(a, { type: 'watchPolicy', roomId, hostId: owner }); await flush();
      expect((await cmd(b, { type: 'snapshot', roomId })).watchPolicy).toEqual(state.watchPolicy);
      const topic = topicHash(code), policy = state.watchPolicy;
      expect(crypto.verify(null, Buffer.from(JSON.stringify(['watch-policy-v1', topic, owner, 0, owner, policy.at])), ownerKeys.pub, Buffer.from(policy.sig, 'base64'))).toBe(true);
      await expect(cmd(b, { type: 'sync', roomId, payload: { fileId, action: 'play', position: 1, together: true } })).rejects.toThrow('Only the watch host');
      await cmd(b, { type: 'sync', roomId, payload: { fileId, action: 'request', requested: 'pause', position: 2, together: true, readiness: 'ready' } }); await flush();
      expect(a.sent.filter(m => m.channel === 'room-sync').at(-1)?.payload).toMatchObject({ memberId: viewer, action: 'request', requested: 'pause', readiness: 'ready' });
      await cmd(a, { type: 'sync', roomId, payload: { fileId, action: 'play', position: 3, together: true, readiness: 'ready' } }); await flush();
      expect(b.sent.filter(m => m.channel === 'room-sync').at(-1)?.payload).toMatchObject({ memberId: owner, action: 'play', policyAt: policy.at });
      const next = await cmd(a, { type: 'watchPolicy', roomId, hostId: viewer }); await flush();
      await expect(cmd(a, { type: 'sync', roomId, payload: { fileId, action: 'pause', position: 4, together: true } })).rejects.toThrow('Only the watch host');
      let frame!: WatchMessage; const [wire] = connect(b, a); wire.intercept = raw => { const m = decrypt<WatchMessage>(deriveKey(code), String(raw)); if (m.t === 'sync-v2') frame = m; return true; }; await flush();
      await cmd(b, { type: 'sync', roomId, payload: { fileId, action: 'seek', position: 8, together: true } }); await flush();
      expect(a.sent.filter(m => m.channel === 'room-sync').at(-1)?.payload).toMatchObject({ action: 'seek', position: 8 });
      expect(crypto.verify(null, watchCanonical(topic, frame), viewerKeys.pub, Buffer.from(frame.sig, 'base64'))).toBe(true);
      expect(crypto.verify(null, watchHostCanonical(topic, frame), viewerKeys.pub, Buffer.from(frame.hostSig, 'base64'))).toBe(true);
      const count = a.sent.filter(m => m.channel === 'room-sync').length;
      hostilePeer(a).send(encrypt(deriveKey(code), { ...frame, position: 90, _g: 'tampered-control', _t: 4 })); await flush();
      expect(a.sent.filter(m => m.channel === 'room-sync')).toHaveLength(count);
      const c = await makeEngine(), cKeys = makeKeys(); await cmd(c, joinPayload({ roomId: roomId + '-late', code, memberId: deriveMemberId(cKeys.pub), ownerPin: owner, keys: cKeys, folder: newFolder() })); c.tracker = H.trackers.at(-1);
      connect(b, c); await flush(); expect((await cmd(c, { type: 'snapshot', roomId: roomId + '-late' })).watchPolicy).toEqual(next.watchPolicy);
      wire.intercept = undefined;
      await cmd(a, { type: 'kick', roomId, memberId: deriveMemberId(cKeys.pub) }); await new Promise(resolve => setTimeout(resolve, 380)); await flush();
      const rotated = await cmd(b, { type: 'snapshot', roomId });
      expect(rotated.code).not.toBe(code); expect(rotated.watchPolicy).toMatchObject({ by: owner, hostId: viewer }); expect(rotated.watchPolicy.at).toBeGreaterThan(next.watchPolicy.at);
      await cmd(c, { type: 'leave', roomId: roomId + '-late' });
      await cmd(a, { type: 'watchPolicy', roomId, hostId: '' }); await flush();
      await cmd(b, { type: 'sync', roomId, payload: { fileId, action: 'play', position: 10, together: true } }); await flush();
      expect(a.sent.filter(m => m.channel === 'room-sync').at(-1)?.payload).toMatchObject({ action: 'play', position: 10 });
      await cmd(a, { type: 'watchPolicy', roomId, hostId: owner }); await flush();
      await cmd(a, { type: 'transferOwner', roomId, memberId: viewer }); await flush();
      expect((await cmd(a, { type: 'snapshot', roomId })).watchPolicy).toBeUndefined();
      expect((await cmd(b, { type: 'snapshot', roomId })).watchPolicy).toBeUndefined();
    } finally { await cmd(a, { type: 'leave', roomId }); await cmd(b, { type: 'leave', roomId }); }
  }, 15_000);
});
