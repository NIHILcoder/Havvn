/**
 * Room engine — runs as the PRELOAD of a hidden BrowserWindow (one per app),
 * exactly like share-seeder.ts, so it uses Chromium's native WebRTC (the native
 * @roamhq/wrtc module crashes under Electron on connect).
 *
 * It does three things for each joined room:
 *   1. Rendezvous: a bittorrent-tracker client announces the room's topicHash on
 *      the WSS trackers and hands us WebRTC wires (simple-peer) to other members.
 *   2. Gossip: over each wire we exchange AES-GCM-encrypted messages (key derived
 *      from the invite code) — HELLO/ADD/HAVE/PING — to converge an add-only file
 *      manifest and a live "who has what" / presence view. A wrong code fails the
 *      GCM auth tag, so it doubles as the membership check.
 *   3. Transfer: every manifest file is moved P2P over a normal WebTorrent swarm
 *      (its own infoHash) — local files are seeded from disk, remote files are
 *      auto-downloaded into the room folder. Same swarm infra as share links.
 *
 * Talks to the main process over ipcRenderer:
 *   main → here:  'room-cmd'    { type, reqId, ... }
 *   here → main:  'room-res'    { reqId, ok, data|error }
 *   here → main:  'room-update' RoomState           (pushed on change, throttled)
 *   here → main:  'room-log'    string
 */

import { ipcRenderer } from 'electron';
import fs from 'fs';
import path from 'path';
import WebTorrent from 'webtorrent';
import { deriveKey, topicHash, randomPeerId, encrypt, decrypt, generateRoomCode } from './room-crypto';
import { encryptFile, decryptFile } from './room-e2e';
import { RoomFile, RoomMember, RoomState, RoomTransfer, PersistedRoomFile, RoomEvent, RoomChatMessage } from '../../shared/types';
import crypto from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TrackerClient = require('bittorrent-tracker') as any;

import { STUN_SERVERS, RENDEZVOUS_TRACKERS } from './ice-servers';

const ROOM_TRACKERS = RENDEZVOUS_TRACKERS;

const w = window as any;
const nativeWrtc = {
  RTCPeerConnection: w.RTCPeerConnection,
  RTCSessionDescription: w.RTCSessionDescription,
  RTCIceCandidate: w.RTCIceCandidate,
};

const PING_INTERVAL = 15000;   // heartbeat to peers
const OFFLINE_AFTER = 45000;   // mark a member offline after this silence
const SNAPSHOT_THROTTLE = 700; // min ms between pushed state snapshots per room

// ── Peer-relay (gossip flooding) ──────────────────────────────────────────────
// Two members who can't form a direct WebRTC wire (NAT) still converge if some
// reachable member is connected to both: every node re-broadcasts gossip it hasn't
// seen to its OTHER wires (deduped by a per-message id, bounded by a hop count),
// so any node with ≥2 wires implicitly relays. Free, no servers — the "relay" is
// just another member. Targeted/keyed messages (rekey, kicked) are NOT flooded.
const RELAY_TTL = 4;                 // max hops a gossip message travels
const SEEN_GID_CAP = 4096;           // dedup memory per room (FIFO)
const RELAYABLE = new Set(['hello', 'ping', 'add', 'have', 'del', 'chat', 'sync', 'bye']);

// ── Gossip input hardening ────────────────────────────────────────────────────
// Decryption already proves a peer holds the room code, but a *malicious member*
// could still send oversized/malformed gossip to exhaust memory — and peer-relay
// would re-flood it. So every inbound frame is size-capped before we even decrypt,
// and the decoded message's strings/arrays are clamped to sane bounds (in place,
// so the relayed copy is bounded too). Limits are far above any legitimate use.
const MAX_FRAME_CHARS = 1_000_000;   // reject an encrypted frame larger than ~1 MB
const MAX_ARRAY = 5000;              // have / files / tombs entries
const MAX_STR = 1024;                // ids, names, seeds
const MAX_MAGNET = 4096;             // a magnet URI
const MAX_TEXT = 2000;               // a chat message body
const MAX_SECRET = 256;              // E2E content key (hex)

function log(msg: string): void { try { ipcRenderer.send('room-log', msg); } catch { /* ignore */ } }

// ── Gossip message shapes (post-decrypt) ───────────────────────────────────
type Msg =
  | { t: 'hello'; memberId: string; name: string; avatarSeed: string; have: string[]; files: RoomFile[]; tombs: string[]; roomName: string; ownerId: string; e2e: boolean; secret: string }
  | { t: 'add'; file: RoomFile }
  | { t: 'have'; memberId: string; fileId: string }
  | { t: 'ping'; memberId: string; name: string; avatarSeed: string; have: string[]; roomName: string; ownerId: string }
  // Remove a shared file from the room (everyone drops it; tombstone prevents resurrection).
  | { t: 'del'; fileId: string; memberId: string }
  // Owner kicked a member: rotate the room to a new code. Sent encrypted with the
  // OLD key to everyone EXCEPT the kicked member, who never learns the new code.
  | { t: 'rekey'; newCode: string; kickedId: string; kickedName: string; by: string }
  // Explicit notice sent to the member being removed (under the CURRENT key,
  // which they can still read) right before the room rotates away from them, so
  // they get a clear "you were removed" instead of silently going stale.
  | { t: 'kicked'; targetId: string; by: string; byName: string }
  // Sent when a member leaves voluntarily so peers drop them at once instead of
  // keeping a 45s offline ghost in the list.
  | { t: 'bye'; memberId: string }
  // Watch-together: relayed verbatim to peers; the renderers keep playback in sync
  // and show who's in the session ('join'/'leave'/'beat' presence).
  | { t: 'sync'; fileId: string; action: 'play' | 'pause' | 'seek' | 'state' | 'join' | 'leave' | 'beat'; position: number; rate: number; at: number; memberId: string; name: string; avatarSeed: string; playing: boolean }
  // A chat message. Carries its own id (dedupes re-delivery across multiple wires)
  // and the sender's identity so peers can render it without a member lookup.
  // `pub` is the sender's Ed25519 public key (PEM) and `sig` an Ed25519 signature
  // over the immutable fields — proves authorship, so no keyholder can post under
  // another member's id (anti-spoofing on top of the room-key confidentiality).
  | { t: 'chat'; id: string; memberId: string; name: string; avatarSeed: string; text: string; at: number; pub: string; sig: string };

interface Wire { id: number; peer: any; memberId?: string; }

interface Room {
  roomId: string;
  name: string;
  code: string;
  folder: string;
  key: Buffer;
  topic: string;
  peerId: string;
  iceServers: any[];
  tracker: any;
  started: boolean;
  self: { memberId: string; name: string; avatarSeed: string; pub: string; priv: string };
  ownerId: string;                       // memberId of the owner ('' until learned)
  e2e: boolean;                          // end-to-end encryption (ciphertext on the wire)
  secret: string;                        // E2E content key (32-byte hex; '' until learned)
  cacheDir: string;                      // where ciphertext copies live (outside the room folder)
  wires: Map<number, Wire>;
  members: Map<string, RoomMember>;      // by memberId (excludes self)
  files: Map<string, RoomFile>;          // by fileId
  transfers: Map<string, RoomTransfer>;  // by fileId
  tombstones: Set<string>;               // deleted fileIds — never re-add them
  mutes: Set<string>;                    // locally-muted memberIds (per install)
  history: RoomEvent[];                  // activity log, newest last (capped)
  chat: RoomChatMessage[];               // chat messages, newest last (capped)
  identities: Map<string, string>;       // memberId → Ed25519 public key (PEM), TOFU-bound
  seenGids: Set<string>;                 // relay dedup — gossip ids already processed
  seenGidOrder: string[];                // FIFO order for capping seenGids
  kicked: boolean;                       // the owner removed us (session-only)
  kickedBy: string;                      // who removed us (display name)
  snapshotTimer: any;
  lastSnapshot: number;
}

let client: any = null;                  // shared WebTorrent client for transfers
const rooms = new Map<string, Room>();
let wireSeq = 0;

function ensureClient(iceServers: any[]): any {
  if (!client) {
    client = new WebTorrent({
      utp: false,
      dht: false,
      tracker: { wrtc: nativeWrtc, rtcConfig: { iceServers } },
    } as any);
    client.on('error', (e: any) => log('wt client error: ' + (e?.message || e)));
    log('WebTorrent client ready (Chromium WebRTC)');
  }
  return client;
}

// ── Snapshot / state push ──────────────────────────────────────────────────
function buildState(room: Room): RoomState {
  const now = Date.now();
  const roleOf = (memberId: string): 'owner' | 'member' =>
    (room.ownerId && memberId === room.ownerId) ? 'owner' : 'member';
  const self: RoomMember = {
    memberId: room.self.memberId,
    name: room.self.name || 'You',
    avatarSeed: room.self.avatarSeed,
    online: true,
    isSelf: true,
    lastSeen: now,
    have: Array.from(room.files.values())
      .filter((f) => room.transfers.get(f.fileId)?.haveLocally)
      .map((f) => f.fileId),
    role: roleOf(room.self.memberId),
  };
  // A member is reached "directly" if some live wire is bound to their id;
  // otherwise we only hear them through another member forwarding (relayed).
  const directIds = new Set<string>();
  for (const w of room.wires.values()) if (w.memberId) directIds.add(w.memberId);
  const members: RoomMember[] = [self];
  for (const m of room.members.values()) {
    if (m.memberId === room.self.memberId) continue; // never show self as a remote member (self-loop guard)
    const online = now - m.lastSeen < OFFLINE_AFTER;
    members.push({ ...m, online, isSelf: false, role: roleOf(m.memberId), muted: room.mutes.has(m.memberId), relayed: online && !directIds.has(m.memberId) });
  }
  const transfers: Record<string, RoomTransfer> = {};
  for (const [k, v] of room.transfers) transfers[k] = v;
  // Count distinct *members* that are online, not raw WebRTC wires — multiple
  // trackers each broker a wire to the same peer, so wires.size over-counts.
  const onlinePeers = members.filter((m) => !m.isSelf && m.online).length;
  return {
    roomId: room.roomId,
    name: room.name,
    code: room.code,
    folder: room.folder,
    topicHash: room.topic,
    createdAt: 0,
    ownerId: room.ownerId,
    canManage: !!room.ownerId && room.ownerId === room.self.memberId,
    e2e: room.e2e,
    members,
    files: Array.from(room.files.values()).sort((a, b) => a.addedAt - b.addedAt),
    transfers,
    history: room.history.slice(-100),
    chat: room.chat.slice(-100),
    connected: room.started,
    peerCount: onlinePeers,
    kicked: room.kicked,
    ...(room.kicked ? { kickedBy: room.kickedBy } : {}),
  };
}

function pushState(room: Room, immediate = false): void {
  const send = () => {
    room.lastSnapshot = Date.now();
    room.snapshotTimer = null;
    try { ipcRenderer.send('room-update', buildState(room)); } catch { /* ignore */ }
  };
  if (immediate) { if (room.snapshotTimer) { clearTimeout(room.snapshotTimer); } send(); return; }
  if (room.snapshotTimer) return;
  const wait = Math.max(0, SNAPSHOT_THROTTLE - (Date.now() - room.lastSnapshot));
  room.snapshotTimer = setTimeout(send, wait);
}

// ── Gossip ──────────────────────────────────────────────────────────────────
function sendTo(room: Room, wire: Wire, msg: Msg): void {
  try {
    if (wire.peer && wire.peer.connected) wire.peer.send(encrypt(room.key, msg));
  } catch (e) { log('send failed: ' + String(e)); }
}

/** Remember a gossip id so we neither reprocess nor re-relay it (FIFO-capped). */
function markSeen(room: Room, gid: string): void {
  if (!gid || room.seenGids.has(gid)) return;
  room.seenGids.add(gid);
  room.seenGidOrder.push(gid);
  if (room.seenGidOrder.length > SEEN_GID_CAP) {
    const old = room.seenGidOrder.shift();
    if (old) room.seenGids.delete(old);
  }
}

/** Re-broadcast a relayed gossip message to every wire except where it came from. */
function forwardRelay(room: Room, msg: any, fromWireId: number): void {
  if (typeof msg._t !== 'number' || msg._t <= 1) return;
  const fwd = { ...msg, _t: msg._t - 1 };
  for (const wire of room.wires.values()) {
    if (wire.id === fromWireId) continue;
    sendTo(room, wire, fwd as Msg);
  }
}

function broadcast(room: Room, msg: Msg): void {
  // Tag relayable messages so any member connected to two others forwards them on
  // (peer-relay). We record our own id first so the flood echoing back is ignored.
  const m = msg as any;
  if (RELAYABLE.has(msg.t) && !m._g) {
    m._g = crypto.randomBytes(6).toString('hex');
    m._t = RELAY_TTL;
    markSeen(room, m._g);
  }
  for (const wire of room.wires.values()) sendTo(room, wire, msg);
}

function helloMsg(room: Room): Msg {
  return {
    t: 'hello',
    memberId: room.self.memberId,
    name: room.self.name || 'You',
    avatarSeed: room.self.avatarSeed,
    have: buildState(room).members[0].have,
    files: Array.from(room.files.values()),
    tombs: Array.from(room.tombstones), // share deletions so peers converge
    roomName: room.name, // so a joiner (who only knows the code) learns the name
    ownerId: room.ownerId, // so joiners learn who the owner is
    e2e: room.e2e, // E2E mode + content key ride the encrypted gossip channel
    secret: room.secret,
  };
}

/** Learn the room's E2E mode + content secret from a peer (HELLO). The secret is
 *  separate from the rotating gossip key, so it survives kicks. */
function maybeAdoptE2E(room: Room, e2e?: boolean, secret?: string): void {
  let changed = false;
  if (typeof e2e === 'boolean' && e2e !== room.e2e) { room.e2e = e2e; changed = true; }
  if (secret && secret !== room.secret) { room.secret = secret; changed = true; }
  if (changed) {
    try { ipcRenderer.send('room-e2e', { roomId: room.roomId, e2e: room.e2e, secret: room.secret }); } catch { /* ignore */ }
    // A just-learned secret may unblock ciphertext we already downloaded.
    if (room.secret) void decryptPending(room);
  }
}

/** Decrypt one E2E file's cached ciphertext into the room folder (plaintext). */
async function decryptOne(room: Room, file: RoomFile, cipherPath: string): Promise<void> {
  if (!room.secret) return;
  const plain = path.join(room.folder, file.name);
  try {
    await decryptFile(cipherPath, plain, room.secret);
    setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true, localPath: plain, cipherPath });
    persistManifest(room, file, plain, cipherPath);
    broadcast(room, { t: 'have', memberId: room.self.memberId, fileId: file.fileId });
    pushState(room, true);
  } catch (e) {
    setTransfer(room, file.fileId, { status: 'error', cipherPath });
    log('e2e decrypt failed: ' + String(e));
  }
}

/** Decrypt any downloaded-but-still-encrypted files now that we have the secret. */
async function decryptPending(room: Room): Promise<void> {
  if (!room.e2e || !room.secret) return;
  for (const [fileId, tr] of room.transfers) {
    const file = room.files.get(fileId);
    if (!file || !file.enc || !tr.cipherPath) continue;
    const plain = path.join(room.folder, file.name);
    if (tr.haveLocally && fs.existsSync(plain)) continue;
    if (!fs.existsSync(tr.cipherPath)) continue;
    await decryptOne(room, file, tr.cipherPath);
  }
}

/** Append an activity-log event (in memory + persisted) and refresh the UI. */
function logEvent(room: Room, ev: Omit<RoomEvent, 'id' | 'at'>): void {
  const full: RoomEvent = { id: crypto.randomBytes(8).toString('hex'), at: Date.now(), ...ev };
  room.history.push(full);
  if (room.history.length > 200) room.history = room.history.slice(-200);
  try { ipcRenderer.send('room-history-add', { roomId: room.roomId, event: full }); } catch { /* ignore */ }
  pushState(room);
}

/**
 * Record a chat message (in memory + persisted) and refresh the UI immediately.
 * Idempotent on message id so re-delivery across multiple wires is harmless.
 */
function addChat(room: Room, msg: RoomChatMessage): void {
  if (room.chat.some((m) => m.id === msg.id)) return;
  room.chat.push(msg);
  if (room.chat.length > 200) room.chat = room.chat.slice(-200);
  try { ipcRenderer.send('room-chat-add', { roomId: room.roomId, message: msg }); } catch { /* ignore */ }
  pushState(room, true);
}

// ── Chat authorship (Ed25519) ────────────────────────────────────────────────
// The room key already gates WHO can read/write (you need the code). Signing adds
// WHICH member wrote each message: the signature covers the immutable fields plus
// the room topic (so a signed message can't be replayed into another room), and
// each memberId is trust-on-first-use bound to one public key — so a keyholder
// cannot post under someone else's identity.

/** Stable bytes to sign/verify for a chat message. */
function chatCanonical(topic: string, m: { id: string; at: number; memberId: string; text: string }): Buffer {
  return Buffer.from(JSON.stringify([topic, m.id, m.at, m.memberId, m.text]), 'utf8');
}

function signChat(room: Room, m: { id: string; at: number; memberId: string; text: string }): string {
  try {
    return crypto.sign(null, chatCanonical(room.topic, m), crypto.createPrivateKey(room.self.priv)).toString('base64');
  } catch (e) { log('chat sign failed: ' + String(e)); return ''; }
}

/**
 * Verify a chat message's signature and enforce the memberId→pubkey binding.
 * Returns true only if the signature is valid AND the sender's pubkey matches the
 * one already bound to that memberId (binding it on first sight). Drops on any
 * mismatch — that's an impersonation attempt.
 */
function verifyChat(room: Room, msg: { id: string; at: number; memberId: string; text: string; pub: string; sig: string }): boolean {
  if (!msg.pub || !msg.sig) return false;
  const bound = room.identities.get(msg.memberId);
  if (bound && bound !== msg.pub) { log('chat identity mismatch for ' + msg.memberId + ' — dropped'); return false; }
  let ok = false;
  try { ok = crypto.verify(null, chatCanonical(room.topic, msg), crypto.createPublicKey(msg.pub), Buffer.from(msg.sig, 'base64')); }
  catch (e) { log('chat verify error: ' + String(e)); return false; }
  if (!ok) { log('chat bad signature from ' + msg.memberId + ' — dropped'); return false; }
  if (!bound) { room.identities.set(msg.memberId, msg.pub); try { ipcRenderer.send('room-identity-add', { roomId: room.roomId, memberId: msg.memberId, pub: msg.pub }); } catch { /* ignore */ } }
  return true;
}

/** Learn who the room owner is from a peer (joiners start not knowing). First
 *  claim wins; persisted so the role survives restart. */
function maybeAdoptOwner(room: Room, incoming?: string): void {
  if (!incoming || room.ownerId) return;
  room.ownerId = incoming;
  try { ipcRenderer.send('room-owner', { roomId: room.roomId, ownerId: incoming }); } catch { /* ignore */ }
}

/**
 * Adopt a friendlier room name a peer advertised. A joiner starts with its name
 * set to the invite code (it has nothing better); the creator broadcasts the
 * real name in HELLO/PING. Only adopt when ours is still the code placeholder
 * and the incoming name is a real one — and tell the main process to persist it.
 */
function maybeAdoptRoomName(room: Room, incoming?: string): void {
  if (!incoming || incoming === room.code) return;   // empty or still a placeholder
  if (room.name && room.name !== room.code) return;   // we already have a real name
  room.name = incoming;
  try { ipcRenderer.send('room-name', { roomId: room.roomId, name: incoming }); } catch { /* ignore */ }
}

function touchMember(room: Room, memberId: string, name: string, avatarSeed: string): RoomMember {
  let m = room.members.get(memberId);
  if (!m) {
    m = { memberId, name, avatarSeed, online: true, isSelf: false, lastSeen: Date.now(), have: [], role: 'member' };
    room.members.set(memberId, m);
  } else {
    m.name = name || m.name;
    m.avatarSeed = avatarSeed || m.avatarSeed;
    m.lastSeen = Date.now();
  }
  return m;
}

/**
 * Tear down a wire that turned out to be a loopback to ourselves. The rendezvous
 * tracker can pair us with our own announce (common on a single machine and
 * across multiple trackers); such a wire delivers our OWN gossip, which — if
 * adopted — adds us as a phantom "second" member that flickers online/offline as
 * the loop sporadically delivers, and can't be kicked (you can't kick yourself).
 */
function dropSelfWire(room: Room, wire: Wire): void {
  try { wire.peer?.destroy(); } catch { /* ignore */ }
  room.wires.delete(wire.id);
  // Clean up any phantom self-entry an earlier loop message may have created.
  if (room.members.delete(room.self.memberId)) pushState(room, true);
}

function clampStr(v: any, n: number): string {
  return typeof v === 'string' ? v.slice(0, n) : '';
}

/** Coerce a peer-supplied file entry to a sane shape, or null if unusable. */
function clampFile(f: any): RoomFile | null {
  if (!f || typeof f !== 'object') return null;
  const fileId = clampStr(f.fileId, MAX_STR);
  const magnetURI = clampStr(f.magnetURI, MAX_MAGNET);
  if (!fileId || !magnetURI) return null;
  return {
    fileId,
    name: clampStr(f.name, MAX_STR),
    size: Number.isFinite(f.size) ? f.size : 0,
    magnetURI,
    addedBy: clampStr(f.addedBy, MAX_STR),
    addedAt: Number.isFinite(f.addedAt) ? f.addedAt : Date.now(),
    ...(f.enc ? { enc: true } : {}),
  } as RoomFile;
}

/** Bound a decoded gossip message's strings/arrays in place (anti-DoS). */
function clampGossip(msg: any): void {
  if ('memberId' in msg) msg.memberId = clampStr(msg.memberId, MAX_STR);
  if ('name' in msg) msg.name = clampStr(msg.name, MAX_STR);
  if ('roomName' in msg) msg.roomName = clampStr(msg.roomName, MAX_STR);
  if ('avatarSeed' in msg) msg.avatarSeed = clampStr(msg.avatarSeed, MAX_STR);
  if ('ownerId' in msg) msg.ownerId = clampStr(msg.ownerId, MAX_STR);
  if ('fileId' in msg) msg.fileId = clampStr(msg.fileId, MAX_STR);
  if ('secret' in msg) msg.secret = clampStr(msg.secret, MAX_SECRET);
  if ('text' in msg) msg.text = clampStr(msg.text, MAX_TEXT);
  if ('pub' in msg) msg.pub = clampStr(msg.pub, MAX_STR * 2);
  if ('sig' in msg) msg.sig = clampStr(msg.sig, MAX_STR);
  if (Array.isArray(msg.have)) msg.have = msg.have.slice(0, MAX_ARRAY).map((x: any) => clampStr(x, MAX_STR));
  if (Array.isArray(msg.tombs)) msg.tombs = msg.tombs.slice(0, MAX_ARRAY).map((x: any) => clampStr(x, MAX_STR));
  if (Array.isArray(msg.files)) msg.files = msg.files.slice(0, MAX_ARRAY).map(clampFile).filter(Boolean);
  if ('file' in msg) msg.file = clampFile(msg.file);
}

function onMessage(room: Room, wire: Wire, raw: any): void {
  let msg: Msg;
  try {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    if (text.length > MAX_FRAME_CHARS) { log('oversized gossip frame dropped (' + text.length + ' chars)'); return; }
    msg = decrypt<Msg>(room.key, text);
  } catch {
    // Wrong key / not a member / corrupt — ignore silently.
    return;
  }
  clampGossip(msg);
  const meta = msg as any;
  // `direct` = arrived straight from its author (undecremented hop count), vs a
  // relayed copy forwarded by another member. Only direct messages identify the
  // wire's peer; relayed ones must not mislabel the relaying wire.
  const direct = typeof meta._t !== 'number' || meta._t >= RELAY_TTL;

  // Self-connection guard: our OWN message arriving DIRECTLY came from a tracker
  // loopback wire (paired us with ourselves) — drop that wire. A relayed echo of
  // our own message is not a loopback; it's caught by the dedup below instead.
  if (meta.memberId && meta.memberId === room.self.memberId) {
    if (direct) dropSelfWire(room, wire);
    return;
  }

  // Peer-relay: drop anything we've already handled (incl. our own flooded echo),
  // otherwise remember it and forward it onward before processing locally.
  const gid: string = meta._g || '';
  if (gid) {
    if (room.seenGids.has(gid)) return;
    markSeen(room, gid);
    forwardRelay(room, meta, wire.id);
  }

  switch (msg.t) {
    case 'hello': {
      if (direct) wire.memberId = msg.memberId;
      const isNew = !room.members.has(msg.memberId);
      const m = touchMember(room, msg.memberId, msg.name, msg.avatarSeed);
      m.have = Array.from(new Set(msg.have || []));
      maybeAdoptRoomName(room, msg.roomName);
      maybeAdoptOwner(room, msg.ownerId);
      maybeAdoptE2E(room, msg.e2e, msg.secret);
      if (isNew) logEvent(room, { type: 'joined', actorId: msg.memberId, actorName: msg.name || '?' });
      // Apply peer deletions first so their HELLO file list can't re-add them.
      for (const id of msg.tombs || []) applyTombstone(room, id);
      for (const f of msg.files || []) mergeFile(room, f);
      pushState(room);
      break;
    }
    case 'ping': {
      if (direct) wire.memberId = msg.memberId;
      const isNew = !room.members.has(msg.memberId);
      const m = touchMember(room, msg.memberId, msg.name, msg.avatarSeed);
      m.have = Array.from(new Set(msg.have || []));
      maybeAdoptRoomName(room, msg.roomName);
      maybeAdoptOwner(room, msg.ownerId);
      if (isNew) logEvent(room, { type: 'joined', actorId: msg.memberId, actorName: msg.name || '?' });
      pushState(room);
      break;
    }
    case 'add': {
      if (!msg.file) break; // clampGossip rejected a malformed file entry
      mergeFile(room, msg.file);
      pushState(room);
      break;
    }
    case 'have': {
      const m = room.members.get(msg.memberId);
      if (m && !m.have.includes(msg.fileId)) { m.have.push(msg.fileId); m.lastSeen = Date.now(); }
      pushState(room);
      break;
    }
    case 'del': {
      if (room.mutes.has(msg.memberId)) break; // ignore deletes from a muted member
      const actor = room.members.get(msg.memberId);
      applyTombstone(room, msg.fileId, { id: msg.memberId, name: actor?.name || '?' });
      try { ipcRenderer.send('room-tomb', { roomId: room.roomId, fileId: msg.fileId }); } catch { /* ignore */ }
      pushState(room, true);
      break;
    }
    case 'rekey': {
      // Decryption already succeeded, so this came in under the CURRENT key.
      if (msg.kickedId === room.self.memberId) break; // we're the one being kicked — never adopt
      if (room.code === msg.newCode) break;            // already applied
      const oldKey = room.key;
      // Relay to our other peers (still under the old key) so multi-hop rooms converge.
      sendRekey(room, oldKey, msg, msg.kickedId, wire.id);
      applyLocalRekey(room, msg.newCode, msg.kickedId, msg.kickedName);
      break;
    }
    case 'kicked': {
      // The owner removed us. Decryption already succeeded, so it's authentic
      // (came in under the room key we still hold). Only act if WE are the target.
      if (msg.targetId !== room.self.memberId) break;
      markKicked(room, msg.byName || '?');
      break;
    }
    case 'bye': {
      // A member left voluntarily — drop them immediately (no offline ghost).
      const m = room.members.get(msg.memberId);
      if (m) {
        room.members.delete(msg.memberId);
        logEvent(room, { type: 'left', actorId: msg.memberId, actorName: m.name || '?' });
      }
      for (const w of Array.from(room.wires.values())) {
        if (w.memberId === msg.memberId) { try { w.peer.destroy(); } catch { /* ignore */ } room.wires.delete(w.id); }
      }
      pushState(room, true);
      break;
    }
    case 'sync': {
      // Relay watch-together control + presence to the main process → renderer.
      try {
        ipcRenderer.send('room-sync', {
          roomId: room.roomId, fileId: msg.fileId, action: msg.action,
          position: msg.position, rate: msg.rate, at: msg.at,
          memberId: msg.memberId, name: msg.name, avatarSeed: msg.avatarSeed, playing: msg.playing,
        });
      } catch { /* ignore */ }
      break;
    }
    case 'chat': {
      if (room.mutes.has(msg.memberId)) break; // a muted member's messages stay hidden
      const text = String(msg.text || '').slice(0, 2000);
      if (!text) break;
      // Reject unsigned, badly-signed, or impersonating messages outright.
      if (!verifyChat(room, { id: String(msg.id), at: Number(msg.at) || 0, memberId: msg.memberId, text, pub: msg.pub, sig: msg.sig })) break;
      // Keep the sender fresh in the member list so a chatter never looks offline.
      const m = room.members.get(msg.memberId);
      if (m) m.lastSeen = Date.now();
      addChat(room, { id: String(msg.id), at: Number(msg.at) || Date.now(), memberId: msg.memberId, name: msg.name || '?', avatarSeed: msg.avatarSeed || msg.memberId, text });
      break;
    }
  }
}

/**
 * Drop a file from this room and never accept it again. Removes it from the
 * manifest/transfers, stops the torrent, and deletes the on-disk copy only when
 * it lives inside the room folder (never the original a member shared from).
 */
function applyTombstone(room: Room, fileId: string, by?: { id: string; name: string }): void {
  room.tombstones.add(fileId);
  // Drop it from the persisted manifest too so it isn't re-seeded next launch.
  try { ipcRenderer.send('room-manifest-del', { roomId: room.roomId, fileId }); } catch { /* ignore */ }
  const existed = room.files.get(fileId);
  if (existed) logEvent(room, { type: 'file-removed', actorId: by?.id || '', actorName: by?.name || '?', fileName: existed.name });
  const tr = room.transfers.get(fileId);
  if (client) { const t = client.get(fileId); if (t) { try { client.remove(t); } catch { /* ignore */ } } }
  room.files.delete(fileId);
  room.transfers.delete(fileId);
  for (const m of room.members.values()) m.have = m.have.filter((id) => id !== fileId);
  // Delete the downloaded copy (only if it's inside the room folder).
  try {
    const lp = tr?.localPath;
    if (lp && path.resolve(lp).startsWith(path.resolve(room.folder) + path.sep) && fs.existsSync(lp)) {
      fs.unlinkSync(lp);
    }
  } catch (e) { log('tombstone unlink failed: ' + String(e)); }
  // E2E: also drop the ciphertext copy we kept for seeding.
  try {
    const cp = tr?.cipherPath;
    if (cp && fs.existsSync(cp)) fs.unlinkSync(cp);
  } catch (e) { log('tombstone cipher unlink failed: ' + String(e)); }
}

function attachWire(room: Room, peer: any): void {
  const wire: Wire = { id: ++wireSeq, peer };
  room.wires.set(wire.id, wire);
  const greet = () => sendTo(room, wire, helloMsg(room));
  if (peer.connected) greet(); else peer.once('connect', greet);
  peer.on('data', (d: any) => onMessage(room, wire, d));
  peer.on('close', () => { room.wires.delete(wire.id); pushState(room); });
  peer.on('error', () => { /* transient WebRTC noise */ });
  pushState(room);
}

// ── File manifest + transfers ────────────────────────────────────────────────
function mergeFile(room: Room, file: RoomFile): void {
  if (!file || !file.fileId) return;
  if (room.tombstones.has(file.fileId)) return; // deleted — don't let a peer resurrect it
  if (room.mutes.has(file.addedBy)) return;     // muted member — ignore their shares locally
  if (!room.files.has(file.fileId)) {
    room.files.set(file.fileId, file);
    persistManifest(room, file); // localPath filled in once the download lands
    logEvent(room, { type: 'file-added', actorId: file.addedBy, actorName: file.addedByName || '?', fileName: file.name });
    ensureLocal(room, file);
  }
}

function setTransfer(room: Room, fileId: string, patch: Partial<RoomTransfer>): void {
  const prev = room.transfers.get(fileId) || { fileId, progress: 0, status: 'queued' as const, downSpeed: 0, peers: 0, haveLocally: false };
  room.transfers.set(fileId, { ...prev, ...patch, fileId });
}

/** Persist a manifest entry to the main process so the room resumes its file
 *  list — and re-seeds — on the next launch. localPath lets us re-seed a file
 *  shared from its original location (outside the room folder). */
function persistManifest(room: Room, file: RoomFile, localPath?: string, cipherPath?: string): void {
  const entry: PersistedRoomFile = { ...file, ...(localPath ? { localPath } : {}), ...(cipherPath ? { cipherPath } : {}) };
  try { ipcRenderer.send('room-manifest-add', { roomId: room.roomId, file: entry }); } catch { /* ignore */ }
}

/** Seed a local file the user added, returning a RoomFile manifest entry. In an
 *  E2E room we encrypt the file into the cache first and seed THAT ciphertext;
 *  the swarm never sees plaintext. localPath still points at the original so the
 *  sharer can watch/open it directly. */
function seedLocal(room: Room, filePath: string): Promise<RoomFile> {
  const c = ensureClient(room.iceServers);
  const name = path.basename(filePath);
  return new Promise<RoomFile>((resolve, reject) => {
    if (!fs.existsSync(filePath)) return reject(new Error('File not found: ' + filePath));

    const plainSize = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();

    const doSeed = (seedPath: string, seedName: string, cipherPath?: string) => {
      let settled = false;
      const onErr = (e: any) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); } };
      c.once('error', onErr);
      try {
        c.seed(seedPath, { announce: ROOM_TRACKERS, name: seedName } as any, (torrent: any) => {
          if (settled) return; settled = true;
          c.removeListener('error', onErr);
          const file: RoomFile = {
            fileId: torrent.infoHash,
            name,
            size: room.e2e ? plainSize : (torrent.length || 0),
            infoHash: torrent.infoHash,
            magnetURI: torrent.magnetURI,
            addedBy: room.self.memberId,
            addedByName: room.self.name || 'You',
            addedAt: Date.now(),
            ...(room.e2e ? { enc: true } : {}),
          };
          setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true, localPath: filePath, ...(cipherPath ? { cipherPath } : {}) });
          wireTorrentStats(room, torrent);
          resolve(file);
        });
      } catch (e) { onErr(e); }
    };

    if (room.e2e) {
      if (!room.secret) { reject(new Error('Room encryption key not available yet')); return; }
      try { fs.mkdirSync(room.cacheDir, { recursive: true }); } catch { /* ignore */ }
      const cipherPath = path.join(room.cacheDir, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${name}.enc`);
      encryptFile(filePath, cipherPath, room.secret)
        .then(() => doSeed(cipherPath, `${name}.enc`, cipherPath))
        .catch((e) => reject(e instanceof Error ? e : new Error(String(e))));
    } else {
      doSeed(filePath, name);
    }
  });
}

/** Make sure a manifest file exists locally — seed it if already on disk,
 *  otherwise download it into the room folder over the WebTorrent swarm. */
function ensureLocal(room: Room, file: RoomFile): void {
  if (room.tombstones.has(file.fileId)) return; // deleted — don't fetch it again
  const c = ensureClient(room.iceServers);
  if (c.get(file.infoHash)) return; // already adding/seeding

  // E2E: the swarm carries ciphertext. Download it into the cache (never the
  // room folder), then decrypt the plaintext into the folder for watch/open.
  if (room.e2e) {
    try { fs.mkdirSync(room.cacheDir, { recursive: true }); } catch { /* ignore */ }
    const plain = path.join(room.folder, file.name);
    const cipherName = `${file.name}.enc`;
    const cachedCipher = path.join(room.cacheDir, cipherName);
    if (fs.existsSync(cachedCipher)) {
      // Already have the ciphertext — re-seed it and (re)derive the plaintext.
      const havePlain = fs.existsSync(plain);
      setTransfer(room, file.fileId, { status: 'seeding', progress: 1, haveLocally: havePlain, ...(havePlain ? { localPath: plain } : {}), cipherPath: cachedCipher });
      try { c.seed(cachedCipher, { announce: ROOM_TRACKERS, name: cipherName } as any, (t: any) => wireTorrentStats(room, t)); }
      catch (e) { log('e2e reseed failed: ' + String(e)); }
      if (room.secret && !havePlain) void decryptOne(room, file, cachedCipher);
      return;
    }
    setTransfer(room, file.fileId, { status: 'downloading', progress: 0, cipherPath: cachedCipher });
    try {
      c.add(file.magnetURI, { path: room.cacheDir, announce: ROOM_TRACKERS } as any, (torrent: any) => {
        wireTorrentStats(room, torrent);
        torrent.on('done', () => {
          const landedCipher = path.join(room.cacheDir, torrent.name || cipherName);
          setTransfer(room, file.fileId, { progress: 1, downSpeed: 0, cipherPath: landedCipher });
          if (room.secret) void decryptOne(room, file, landedCipher);
          else { persistManifest(room, file, undefined, landedCipher); log('e2e: ciphertext ready, awaiting room key for ' + file.name); pushState(room, true); }
        });
      });
    } catch (e) { setTransfer(room, file.fileId, { status: 'error' }); log('e2e download add failed: ' + String(e)); }
    return;
  }

  const onDisk = path.join(room.folder, file.name);
  if (fs.existsSync(onDisk)) {
    setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true, localPath: onDisk });
    persistManifest(room, file, onDisk);
    try {
      c.seed(onDisk, { announce: ROOM_TRACKERS, name: file.name } as any, (t: any) => wireTorrentStats(room, t));
    } catch (e) { log('reseed failed: ' + String(e)); }
    return;
  }

  setTransfer(room, file.fileId, { status: 'downloading', progress: 0 });
  try {
    c.add(file.magnetURI, { path: room.folder, announce: ROOM_TRACKERS } as any, (torrent: any) => {
      wireTorrentStats(room, torrent);
      torrent.on('done', () => {
        const landed = path.join(room.folder, file.name);
        setTransfer(room, file.fileId, { progress: 1, status: 'seeding', downSpeed: 0, haveLocally: true, localPath: landed });
        persistManifest(room, file, landed); // record where it landed so we re-seed it next launch
        broadcast(room, { t: 'have', memberId: room.self.memberId, fileId: file.fileId });
        pushState(room, true);
      });
    });
  } catch (e) {
    setTransfer(room, file.fileId, { status: 'error' });
    log('download add failed: ' + String(e));
  }
}

/**
 * Resume one persisted manifest file on startup: register it in the manifest,
 * then re-seed from its known on-disk path if present (covers a file shared from
 * its ORIGINAL location, outside the room folder). Otherwise fall back to the
 * normal seed-from-folder / download path.
 */
function restoreManifestFile(room: Room, pf: PersistedRoomFile): void {
  if (room.tombstones.has(pf.fileId)) return;
  if (room.files.has(pf.fileId)) return;
  const file: RoomFile = {
    fileId: pf.fileId, name: pf.name, size: pf.size, infoHash: pf.infoHash,
    magnetURI: pf.magnetURI, addedBy: pf.addedBy, addedByName: pf.addedByName, addedAt: pf.addedAt,
    ...(pf.enc ? { enc: true } : {}),
  };
  room.files.set(file.fileId, file);
  const c = ensureClient(room.iceServers);
  if (c.get(file.infoHash)) return; // already seeding/adding

  // E2E: re-seed the cached CIPHERTEXT (never the plaintext) and make sure the
  // plaintext exists in the folder for watch/open.
  if (room.e2e) {
    const plain = path.join(room.folder, file.name);
    if (pf.cipherPath && fs.existsSync(pf.cipherPath)) {
      const havePlain = fs.existsSync(plain);
      setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: havePlain, ...(havePlain ? { localPath: plain } : {}), cipherPath: pf.cipherPath });
      try { c.seed(pf.cipherPath, { announce: ROOM_TRACKERS, name: `${file.name}.enc` } as any, (t: any) => wireTorrentStats(room, t)); }
      catch (e) { log('e2e manifest reseed failed: ' + String(e)); }
      if (room.secret && !havePlain) void decryptOne(room, file, pf.cipherPath);
      return;
    }
    ensureLocal(room, file); // no cached ciphertext — re-download it
    return;
  }

  if (pf.localPath && fs.existsSync(pf.localPath)) {
    setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true, localPath: pf.localPath });
    try { c.seed(pf.localPath, { announce: ROOM_TRACKERS, name: file.name } as any, (t: any) => wireTorrentStats(room, t)); }
    catch (e) { log('manifest reseed failed: ' + String(e)); }
    return;
  }
  ensureLocal(room, file); // not at the known path — seed-from-folder or re-download
}

function wireTorrentStats(room: Room, torrent: any): void {
  const fileId = torrent.infoHash;
  const update = () => {
    const done = torrent.progress >= 1 || torrent.done;
    setTransfer(room, fileId, {
      progress: torrent.progress || (done ? 1 : 0),
      status: done ? 'seeding' : 'downloading',
      downSpeed: torrent.downloadSpeed || 0,
      peers: torrent.numPeers || 0,
      haveLocally: done || (room.transfers.get(fileId)?.haveLocally ?? false),
    });
    pushState(room);
  };
  torrent.on('download', update);
  torrent.on('upload', update);
  torrent.on('wire', update);
  torrent.on('error', () => setTransfer(room, fileId, { status: 'error' }));
  update();
}

// ── Rendezvous tracker (recreated when the room is rekeyed) ──────────────────
function attachTracker(room: Room): void {
  try {
    const tracker = new TrackerClient({
      infoHash: room.topic,
      peerId: room.peerId,
      announce: ROOM_TRACKERS,
      port: 6881,
      rtcConfig: { iceServers: room.iceServers },
      wrtc: nativeWrtc,
    });
    room.tracker = tracker;
    tracker.on('peer', (peer: any) => attachWire(room, peer));
    tracker.on('warning', () => { /* tracker noise */ });
    tracker.on('error', (e: any) => log('tracker error: ' + (e?.message || e)));
    tracker.on('update', () => { room.started = true; });
    tracker.start();
    room.started = true;
    log('Tracker announced: ' + room.name + ' (' + room.topic.slice(0, 8) + ')');
  } catch (e) {
    log('tracker start failed: ' + String(e));
  }
}

function restartTracker(room: Room): void {
  try { room.tracker?.stop(); room.tracker?.destroy(); } catch { /* ignore */ }
  room.tracker = null;
  attachTracker(room);
}

// ── Kick = key rotation ──────────────────────────────────────────────────────
// A serverless room has no membership authority, so a real kick means rotating
// the secret: the owner mints a new code and hands it to everyone EXCEPT the
// kicked member. The kicked member stays stranded on the old topicHash; everyone
// else re-announces on the new one.

/** Send a rekey to all known, non-kicked wires using the OLD key (so they can
 *  still read it). Never sent to the kicked member — that's the whole point. */
function sendRekey(room: Room, oldKey: Buffer, msg: Msg, kickedId: string, exceptWireId?: number): void {
  for (const wire of room.wires.values()) {
    if (exceptWireId !== undefined && wire.id === exceptWireId) continue;
    if (!wire.memberId || wire.memberId === kickedId) continue; // never leak the new code to the kicked member
    try { if (wire.peer && wire.peer.connected) wire.peer.send(encrypt(oldKey, msg)); } catch { /* ignore */ }
  }
}

/** Switch this room onto a new code: drop the kicked member, re-key, re-announce. */
function applyLocalRekey(room: Room, newCode: string, kickedId: string, kickedName: string): void {
  if (room.code === newCode) return; // already applied (dedupe)
  room.members.delete(kickedId);
  for (const wire of Array.from(room.wires.values())) {
    if (wire.memberId === kickedId) { try { wire.peer.destroy(); } catch { /* ignore */ } room.wires.delete(wire.id); }
  }
  room.code = newCode;
  room.key = deriveKey(newCode);
  room.topic = topicHash(newCode);
  try { ipcRenderer.send('room-rekey', { roomId: room.roomId, code: newCode }); } catch { /* ignore */ }
  restartTracker(room);
  const ownerName = room.ownerId === room.self.memberId
    ? (room.self.name || 'You')
    : (room.members.get(room.ownerId)?.name || '?');
  logEvent(room, { type: 'kicked', actorId: room.ownerId, actorName: ownerName, targetName: kickedName });
  // Re-greet remaining peers under the NEW key so presence reconverges.
  broadcast(room, helloMsg(room));
  pushState(room, true);
}

/** We were removed by the owner: surface it in the UI, stop announcing, and drop
 *  every wire so we don't linger in the swarm the room just rotated away from. */
function markKicked(room: Room, byName: string): void {
  if (room.kicked) return;
  room.kicked = true;
  room.kickedBy = byName;
  logEvent(room, { type: 'kicked', actorId: room.ownerId, actorName: byName, targetName: room.self.name || 'You' });
  try { room.tracker?.stop(); room.tracker?.destroy(); } catch { /* ignore */ }
  room.tracker = null;
  for (const wire of room.wires.values()) { try { wire.peer.destroy(); } catch { /* ignore */ } }
  room.wires.clear();
  room.started = false;
  pushState(room, true);
}

/** Owner-only: remove a member by rotating the room code away from them. */
function kickMember(room: Room, memberId: string): void {
  if (room.ownerId !== room.self.memberId) throw new Error('Only the room owner can remove members');
  if (memberId === room.self.memberId) throw new Error('You cannot remove yourself');
  const kickedName = room.members.get(memberId)?.name || '?';
  // 1. Tell the kicked member explicitly, under the CURRENT key they can still
  //    read, on every wire we have to them — so they get a clear notice.
  const notice: Msg = { t: 'kicked', targetId: memberId, by: room.self.memberId, byName: room.self.name || 'You' };
  for (const wire of room.wires.values()) {
    if (wire.memberId === memberId) sendTo(room, wire, notice);
  }
  // 2. Rotate the room away from them. Deferred briefly so the notice flushes on
  //    the data channel before applyLocalRekey tears that wire down.
  const newCode = generateRoomCode();
  const oldKey = room.key;
  const rekey: Msg = { t: 'rekey', newCode, kickedId: memberId, kickedName, by: room.self.memberId };
  setTimeout(() => {
    if (!rooms.get(room.roomId)) return; // room was left/destroyed meanwhile
    sendRekey(room, oldKey, rekey, memberId);
    applyLocalRekey(room, newCode, memberId, kickedName);
  }, 300);
}

// ── Room lifecycle ───────────────────────────────────────────────────────────
function startRoom(p: { roomId: string; name: string; code: string; folder: string;
  self: { memberId: string; name: string; avatarSeed: string; pub: string; priv: string }; useTurn: boolean; turnServers?: any[]; tombstones?: string[]; manifest?: PersistedRoomFile[]; ownerId?: string; mutes?: string[]; history?: RoomEvent[]; chat?: RoomChatMessage[]; identities?: Record<string, string>; e2e?: boolean; secret?: string; cacheDir?: string }): RoomState {
  let room = rooms.get(p.roomId);
  if (room) return buildState(room);

  try { fs.mkdirSync(p.folder, { recursive: true }); } catch { /* ignore */ }

  const iceServers = p.useTurn && p.turnServers && p.turnServers.length
    ? STUN_SERVERS.concat(p.turnServers)
    : STUN_SERVERS.slice();

  room = {
    roomId: p.roomId,
    name: p.name,
    code: p.code,
    folder: p.folder,
    key: deriveKey(p.code),
    topic: topicHash(p.code),
    peerId: randomPeerId(),
    iceServers,
    tracker: null,
    started: false,
    self: p.self,
    ownerId: p.ownerId || '',
    e2e: p.e2e || false,
    secret: p.secret || '',
    cacheDir: p.cacheDir || '',
    wires: new Map(),
    members: new Map(),
    files: new Map(),
    transfers: new Map(),
    tombstones: new Set(p.tombstones || []),
    mutes: new Set(p.mutes || []),
    history: (p.history || []).slice(-200),
    chat: (p.chat || []).slice(-200),
    identities: new Map(Object.entries(p.identities || {})),
    seenGids: new Set(),
    seenGidOrder: [],
    kicked: false,
    kickedBy: '',
    snapshotTimer: null,
    lastSnapshot: 0,
  };
  rooms.set(p.roomId, room);

  // The owner logs the room's creation once (its history starts empty).
  if (room.ownerId && room.ownerId === room.self.memberId && room.history.length === 0) {
    logEvent(room, { type: 'created', actorId: room.self.memberId, actorName: room.self.name || 'You' });
  }

  // Resume the persisted manifest first so the room shows — and re-seeds — its
  // files immediately, before any peer reconnects. Covers files shared from
  // outside the room folder (which the folder scan below would miss).
  for (const pf of p.manifest || []) restoreManifestFile(room, pf);

  // Adopt any files sitting in the room folder that the manifest didn't already
  // cover (re-share on restart). Skipped for E2E rooms — loose plaintext in the
  // folder must NOT be seeded as-is (it would leak); E2E files are restored from
  // the manifest's ciphertext above.
  if (!room.e2e) {
    try {
      const known = new Set(Array.from(room.files.values()).map((f) => f.name));
      for (const entry of fs.readdirSync(room.folder)) {
        if (known.has(entry)) continue;
        const full = path.join(room.folder, entry);
        if (fs.statSync(full).isFile()) {
          seedLocal(room, full).then((f) => { mergeFileLocal(room!, f, full); }).catch(() => { /* ignore */ });
        }
      }
    } catch { /* folder may be empty */ }
  }

  // Rendezvous tracker (announces the current topicHash; recreated on rekey).
  attachTracker(room);

  // Heartbeat.
  const beat = setInterval(() => {
    const r = rooms.get(p.roomId);
    if (!r) { clearInterval(beat); return; }
    broadcast(r, { t: 'ping', memberId: r.self.memberId, name: r.self.name || 'You', avatarSeed: r.self.avatarSeed, have: buildState(r).members[0].have, roomName: r.name, ownerId: r.ownerId });
    pushState(r);
  }, PING_INTERVAL);

  pushState(room, true);
  return buildState(room);
}

/** A locally-seeded file: register in manifest + announce to peers. */
function mergeFileLocal(room: Room, file: RoomFile, localPath?: string): void {
  if (room.tombstones.has(file.fileId)) return;
  if (!room.files.has(file.fileId)) {
    room.files.set(file.fileId, file);
    setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true, ...(localPath ? { localPath } : {}) });
    const cipherPath = room.transfers.get(file.fileId)?.cipherPath; // set by seedLocal in E2E rooms
    persistManifest(room, file, localPath, cipherPath);
    logEvent(room, { type: 'file-added', actorId: file.addedBy, actorName: file.addedByName || 'You', fileName: file.name });
    broadcast(room, { t: 'add', file });
    pushState(room, true);
  }
}

async function addFiles(roomId: string, paths: string[]): Promise<RoomState> {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  for (const p of paths) {
    try {
      const file = await seedLocal(room, p);
      mergeFileLocal(room, file, p);
    } catch (e) { log('addFile failed: ' + String(e)); }
  }
  return buildState(room);
}

function leaveRoom(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  // Tell peers we're leaving so they drop us at once (no 45s offline ghost).
  broadcast(room, { t: 'bye', memberId: room.self.memberId });
  rooms.delete(roomId);
  const teardown = (): void => {
    try { room.tracker?.stop(); room.tracker?.destroy(); } catch { /* ignore */ }
    for (const wire of room.wires.values()) { try { wire.peer.destroy(); } catch { /* ignore */ } }
    // Stop transferring this room's torrents (only if no other room uses them).
    if (client) {
      for (const fileId of room.files.keys()) {
        const stillUsed = Array.from(rooms.values()).some((r) => r.files.has(fileId));
        if (!stillUsed) { const t = client.get(fileId); if (t) { try { client.remove(t); } catch { /* ignore */ } } }
      }
    }
  };
  // Defer the teardown briefly so the 'bye' flushes on the data channels first.
  setTimeout(teardown, 200);
}

/**
 * Stop seeding a file so Windows releases the on-disk handle (lets the user open
 * or extract an archive). The file stays on disk and in the manifest — we just
 * remove the torrent from the WebTorrent client. Other members keep it.
 */
function releaseFile(roomId: string, fileId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  // Only drop the torrent if no other active room still shares this file.
  const stillUsedElsewhere = Array.from(rooms.values()).some((r) => r !== room && r.files.has(fileId));
  if (client && !stillUsedElsewhere) {
    const t = client.get(fileId);
    if (t) { try { client.remove(t); } catch (e) { log('release failed: ' + String(e)); } }
  }
  const tr = room.transfers.get(fileId);
  if (tr) { tr.status = 'done'; tr.released = true; tr.downSpeed = 0; tr.peers = 0; }
  pushState(room, true);
}

/** Broadcast a chat message to the room and record it locally (so we see our own). */
function sendChat(roomId: string, rawText: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  const text = String(rawText || '').trim().slice(0, 2000);
  if (!text) return;
  const msg: RoomChatMessage = {
    id: crypto.randomBytes(8).toString('hex'),
    at: Date.now(),
    memberId: room.self.memberId,
    name: room.self.name || 'You',
    avatarSeed: room.self.avatarSeed,
    text,
  };
  const sig = signChat(room, msg);
  // Bind our own identity locally too, so the roster is complete on our side.
  if (!room.identities.has(room.self.memberId)) room.identities.set(room.self.memberId, room.self.pub);
  broadcast(room, { t: 'chat', ...msg, pub: room.self.pub, sig });
  addChat(room, msg);
}

/** Apply a profile change (name/avatar) to every active room and tell peers. */
function updateProfile(p: { name?: string; avatarSeed?: string }): void {
  for (const room of rooms.values()) {
    if (typeof p.name === 'string') room.self.name = p.name;
    if (typeof p.avatarSeed === 'string' && p.avatarSeed) room.self.avatarSeed = p.avatarSeed;
    broadcast(room, { t: 'ping', memberId: room.self.memberId, name: room.self.name || 'You', avatarSeed: room.self.avatarSeed, have: buildState(room).members[0].have, roomName: room.name, ownerId: room.ownerId });
    pushState(room, true);
  }
}

// ── IPC command router ───────────────────────────────────────────────────────
ipcRenderer.on('room-cmd', async (_e, msg: any) => {
  const { type, reqId } = msg;
  try {
    let data: any;
    if (type === 'join') data = startRoom(msg.payload);
    else if (type === 'addFiles') data = await addFiles(msg.roomId, msg.paths);
    else if (type === 'leave') { leaveRoom(msg.roomId); data = { ok: true }; }
    else if (type === 'profile') { updateProfile(msg.payload || {}); data = { ok: true }; }
    else if (type === 'releaseFile') { releaseFile(msg.roomId, msg.fileId); data = { ok: true }; }
    else if (type === 'removeFile') {
      const r = rooms.get(msg.roomId);
      if (r) {
        applyTombstone(r, msg.fileId, { id: r.self.memberId, name: r.self.name || 'You' });
        broadcast(r, { t: 'del', fileId: msg.fileId, memberId: r.self.memberId });
        pushState(r, true);
      }
      data = { ok: true };
    }
    else if (type === 'kick') {
      const r = rooms.get(msg.roomId);
      if (!r) throw new Error('Room not active');
      kickMember(r, String(msg.memberId || ''));
      data = { ok: true };
    }
    else if (type === 'mute') {
      // Locally hide a member on THIS install (never broadcast, fully reversible).
      // Future shares from them are ignored (see mergeFile); already-downloaded
      // files are left alone, and unmute lets their shares back in via gossip.
      const r = rooms.get(msg.roomId);
      if (r) {
        const targetId = String(msg.memberId || '');
        if (msg.muted) r.mutes.add(targetId); else r.mutes.delete(targetId);
        pushState(r, true);
      }
      data = { ok: true };
    }
    else if (type === 'sync') {
      const r = rooms.get(msg.roomId);
      const p = msg.payload || {};
      if (r) broadcast(r, {
        t: 'sync', fileId: String(p.fileId || ''), action: p.action || 'state',
        position: Number(p.position) || 0, rate: Number(p.rate) || 1, at: Date.now(),
        memberId: r.self.memberId, name: r.self.name || 'You',
        avatarSeed: r.self.avatarSeed, playing: !!p.playing,
      });
      data = { ok: true };
    }
    else if (type === 'chat') { sendChat(msg.roomId, String((msg.payload || {}).text || '')); data = { ok: true }; }
    else if (type === 'snapshot') { const r = rooms.get(msg.roomId); data = r ? buildState(r) : null; }
    else throw new Error('Unknown room command: ' + type);
    ipcRenderer.send('room-res', { reqId, ok: true, data });
  } catch (e: any) {
    ipcRenderer.send('room-res', { reqId, ok: false, error: e?.message || String(e) });
  }
});

ipcRenderer.send('room-ready');
