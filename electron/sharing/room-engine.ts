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
import { deriveKey, topicHash, randomPeerId, encrypt, decrypt, generateRoomCode, codeIsE2E } from './room-crypto';
import { encryptFile, decryptFile } from './room-e2e';
import { RoomFile, RoomFolder, RoomMember, RoomState, RoomTransfer, PersistedRoomFile, RoomEvent, RoomChatMessage } from '../../shared/types';
import { mergeFolderUpsert, applyFolderDelete, applyAssignment } from '../../shared/room-folders';
import { safeBaseName } from '../../shared/path-safety';
import crypto from 'crypto';

import TrackerClient from 'bittorrent-tracker';

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

// ── Liveness (typing / file reactions / coarse progress) ─────────────────────
const TYPING_TTL = 4000;          // a member's typing indicator counts as live this long
const TYPING_MIN_INTERVAL = 2000; // min ms between OUR outgoing typing broadcasts per room
const PROG_STEP = 10;             // coarse progress granularity (%) — gossip only on crossing a step
const REACTION_EMOJI = ['🔥', '👍', '❤️', '😂']; // the only file reactions accepted (whitelist)
const REACTION_SET = new Set(REACTION_EMOJI);
const MAX_REACT_FILES = 200;      // reaction map ceiling per room (kept + helloed)

// ── Peer-relay (gossip flooding) ──────────────────────────────────────────────
// Two members who can't form a direct WebRTC wire (NAT) still converge if some
// reachable member is connected to both: every node re-broadcasts gossip it hasn't
// seen to its OTHER wires (deduped by a per-message id, bounded by a hop count),
// so any node with ≥2 wires implicitly relays. Free, no servers — the "relay" is
// just another member. Targeted/keyed messages (rekey, kicked) are NOT flooded.
const RELAY_TTL = 4;                 // max hops a gossip message travels
const SEEN_GID_CAP = 4096;           // dedup memory per room (FIFO)
const RELAYABLE = new Set(['hello', 'ping', 'add', 'have', 'del', 'chat', 'sync', 'bye', 'typing', 'react-file', 'prog', 'folder', 'assign']);

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
  // `tombs` lists deleted fileIds (legacy shape, kept so older peers converge);
  // `tombsAt` adds each deletion's timestamp so a LATER explicit re-share wins
  // (revive) while anything older stays dead.
  // `cfg` is the room owner's SIGNED E2E config (see E2ECfg) — the authenticated
  // way to learn the flag+secret; the bare e2e/secret fields remain for rooms
  // whose owner runs an older build that doesn't sign.
  // `fileReacts` is a clamped summary of this member's reaction view (fileId →
  // emoji → memberIds) so late joiners converge by unioning member sets.
  | { t: 'hello'; memberId: string; name: string; avatarSeed: string; have: string[]; files: RoomFile[]; tombs: string[]; tombsAt?: Record<string, number>; roomName: string; ownerId: string; e2e: boolean; secret: string; cfg?: E2ECfg; fileReacts?: Record<string, Record<string, string[]>>; folders?: RoomFolder[]; folderTombs?: Record<string, number> }
  | { t: 'add'; file: RoomFile }
  // A folder/section was created, renamed/recolored (upsert) or deleted (del).
  // Last-writer-wins by `at`; unknown to older peers, who ignore it and keep
  // showing the flat list. Files carry their folderId; reassignment is 'assign'.
  | { t: 'folder'; op: 'upsert' | 'del'; id: string; name?: string; icon?: string; color?: string; at: number }
  // A file moved between folders (or to Uncategorized when folderId is ''). LWW
  // by `at`; kept separate from 'add' because mergeFile is add-only.
  | { t: 'assign'; fileId: string; folderId: string; at: number; memberId: string }
  | { t: 'have'; memberId: string; fileId: string }
  | { t: 'ping'; memberId: string; name: string; avatarSeed: string; have: string[]; roomName: string; ownerId: string }
  // Remove a shared file from the room (everyone drops it; the timestamped
  // tombstone prevents resurrection until an explicitly newer re-share).
  | { t: 'del'; fileId: string; memberId: string; at?: number }
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
  | { t: 'sync'; fileId: string; action: 'play' | 'pause' | 'seek' | 'state' | 'join' | 'leave' | 'beat' | 'react'; position: number; rate: number; at: number; memberId: string; name: string; avatarSeed: string; playing: boolean; together?: boolean; emoji?: string }
  // A chat message. Carries its own id (dedupes re-delivery across multiple wires)
  // and the sender's identity so peers can render it without a member lookup.
  // `pub` is the sender's Ed25519 public key (PEM) and `sig` an Ed25519 signature
  // over the immutable fields — proves authorship, so no keyholder can post under
  // another member's id (anti-spoofing on top of the room-key confidentiality).
  | { t: 'chat'; id: string; memberId: string; name: string; avatarSeed: string; text: string; at: number; pub: string; sig: string }
  // Liveness: the sender is composing a chat message. Renderer-triggered, never
  // persisted; receivers stamp it and let a ~4s TTL fade it out on their own.
  | { t: 'typing'; memberId: string }
  // Toggle an emoji reaction on a shared file (REACTION_EMOJI whitelist only).
  | { t: 'react-file'; memberId: string; fileId: string; emoji: string; on: boolean }
  // Coarse download progress (0-100, PROG_STEP granularity) so peers see a
  // member's transfer move; completion is signalled by the normal 'have'.
  | { t: 'prog'; memberId: string; fileId: string; pct: number };

interface Wire { id: number; peer: any; memberId?: string; }

/**
 * The room's E2E config as a self-contained, owner-signed claim: `sig` is an
 * Ed25519 signature by `pub` (the OWNER's identity key) over the topic, ownerId,
 * flag and secret — so no other keyholder can mint or alter one, and a blob from
 * another room/topic never verifies here. Members store the blob and re-serve it
 * in their HELLOs, so a joiner can authenticate the secret even while the owner
 * is offline. Binding to the CURRENT topic means the owner re-signs on rekey.
 */
interface E2ECfg { ownerId: string; e2e: boolean; secret: string; pub: string; sig: string; }

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
  e2eCfg: E2ECfg | null;                 // owner-signed E2E config we hold + re-serve to joiners
  e2eSigned: boolean;                    // e2e/secret/owner were established by a VERIFIED owner signature
  cacheDir: string;                      // where ciphertext copies live (outside the room folder)
  wires: Map<number, Wire>;
  members: Map<string, RoomMember>;      // by memberId (excludes self)
  files: Map<string, RoomFile>;          // by fileId
  folders: Map<string, RoomFolder>;      // by folderId — optional sections overlay (LWW)
  folderTombstones: Map<string, number>; // deleted folderId → deletedAt; a newer upsert revives it
  transfers: Map<string, RoomTransfer>;  // by fileId
  tombstones: Map<string, number>;       // deleted fileId → deletedAt; only a newer re-share revives it
  autoFetch: boolean;                    // auto-download peers' files; false = wait for an explicit fetchFile
  upKbps: number;                        // per-room upload ceiling, KB/s (0 = unlimited)
  downKbps: number;                      // per-room download ceiling, KB/s (0 = unlimited)
  mutes: Set<string>;                    // locally-muted memberIds (per install)
  history: RoomEvent[];                  // activity log, newest last (capped)
  chat: RoomChatMessage[];               // chat messages, newest last (capped)
  typing: Record<string, number>;        // memberId → last 'typing' gossip stamp (session-only)
  lastTypingSent: number;                // rate-limit for OUR outgoing typing broadcasts
  fileReacts: Map<string, Map<string, Set<string>>>; // fileId → emoji → reacting memberIds (persisted)
  memberProg: Map<string, Map<string, number>>;      // memberId → fileId → coarse download % (session-only)
  progSent: Map<string, number>;         // fileId → last PROG_STEP % WE gossiped (throttle)
  identities: Map<string, string>;       // memberId → Ed25519 public key (PEM), TOFU-bound
  seenGids: Set<string>;                 // relay dedup — gossip ids already processed
  seenGidOrder: string[];                // FIFO order for capping seenGids
  kicked: boolean;                       // the owner removed us (session-only)
  kickedBy: string;                      // who removed us (display name)
  snapshotTimer: any;
  lastSnapshot: number;
}

// One WebTorrent client PER ROOM: webtorrent throttles only at the client
// level, so per-room clients are what make per-room speed limits real (and
// two rooms sharing identical content stop colliding on one infoHash).
const clients = new Map<string, any>();  // roomId → WebTorrent client
const rooms = new Map<string, Room>();
let wireSeq = 0;
// Debug handles for the hidden window's console/CDP — rooms and clients are
// module-scoped and otherwise unreachable when diagnosing a live install.
(globalThis as any).__rooms = rooms;
(globalThis as any).__clients = clients;

/** Room KB/s (0 = unlimited) → webtorrent limit (bytes/s, -1 = unlimited). */
function kbpsToLimit(kbps: number): number {
  return kbps > 0 ? kbps * 1024 : -1;
}

function ensureClient(room: Room): any {
  let c = clients.get(room.roomId);
  if (!c) {
    c = new WebTorrent({
      utp: false,
      dht: false,
      uploadLimit: kbpsToLimit(room.upKbps),
      downloadLimit: kbpsToLimit(room.downKbps),
      tracker: { wrtc: nativeWrtc, rtcConfig: { iceServers: room.iceServers } },
    } as any);
    c.on('error', (e: any) => log('wt client error: ' + (e?.message || e)));
    clients.set(room.roomId, c);
    log('WebTorrent client ready (Chromium WebRTC) for room ' + room.roomId);
  }
  return c;
}

// ── Liveness: typing / file reactions / coarse progress ─────────────────────

/** Serialize the reaction map (capped, whitelist order) for buildState, HELLOs
 *  and persistence. */
function reactsToRecord(room: Room): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  let files = 0;
  for (const [fileId, byEmoji] of room.fileReacts) {
    if (files >= MAX_REACT_FILES) break;
    const rec: Record<string, string[]> = {};
    for (const emoji of REACTION_EMOJI) {
      const set = byEmoji.get(emoji);
      if (set && set.size) rec[emoji] = Array.from(set);
    }
    if (Object.keys(rec).length) { out[fileId] = rec; files++; }
  }
  return out;
}

/** Bound a reaction summary (peer-supplied or persisted): ≤MAX_REACT_FILES
 *  files, whitelisted emoji only, member lists deduped + capped. */
function clampReactsRecord(rec: any): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return out;
  for (const [rawId, byEmoji] of Object.entries(rec).slice(0, MAX_REACT_FILES)) {
    const fileId = clampStr(rawId, MAX_STR);
    if (!fileId || !byEmoji || typeof byEmoji !== 'object' || Array.isArray(byEmoji)) continue;
    const inner: Record<string, string[]> = {};
    for (const emoji of REACTION_EMOJI) {
      const members = (byEmoji as any)[emoji];
      if (!Array.isArray(members)) continue;
      const list = Array.from(new Set(members.slice(0, MAX_ARRAY).map((m: any) => clampStr(m, MAX_STR)).filter(Boolean))) as string[];
      if (list.length) inner[emoji] = list;
    }
    if (Object.keys(inner).length) out[fileId] = inner;
  }
  return out;
}

/** Rehydrate a persisted (or clamped inbound) reaction record into live maps. */
function reactsFromRecord(rec?: Record<string, Record<string, string[]>>): Map<string, Map<string, Set<string>>> {
  const map = new Map<string, Map<string, Set<string>>>();
  for (const [fileId, byEmoji] of Object.entries(clampReactsRecord(rec))) {
    const inner = new Map<string, Set<string>>();
    for (const [emoji, members] of Object.entries(byEmoji)) inner.set(emoji, new Set(members));
    map.set(fileId, inner);
  }
  return map;
}

/** Persist the room's reaction map via the main process (mirrors history/chat). */
function persistReacts(room: Room): void {
  try { ipcRenderer.send('room-reacts', { roomId: room.roomId, reacts: reactsToRecord(room) }); } catch { /* ignore */ }
}

/** Toggle one member's emoji reaction on a file. Non-whitelisted emoji and
 *  over-cap growth are ignored. Returns true when anything actually changed —
 *  callers persist + push state on change. */
function applyFileReact(room: Room, fileId: string, emoji: string, memberId: string, on: boolean): boolean {
  if (!fileId || !memberId || !REACTION_SET.has(emoji)) return false;
  let byEmoji = room.fileReacts.get(fileId);
  if (on) {
    if (!byEmoji) {
      if (room.fileReacts.size >= MAX_REACT_FILES) return false; // cap: no new files past the ceiling
      byEmoji = new Map();
      room.fileReacts.set(fileId, byEmoji);
    }
    let set = byEmoji.get(emoji);
    if (!set) { set = new Set(); byEmoji.set(emoji, set); }
    if (set.has(memberId) || set.size >= MAX_ARRAY) return false;
    set.add(memberId);
  } else {
    const set = byEmoji?.get(emoji);
    if (!set || !set.delete(memberId)) return false;
    if (set.size === 0) byEmoji!.delete(emoji);
    if (byEmoji && byEmoji.size === 0) room.fileReacts.delete(fileId);
  }
  return true;
}

/** Union a peer's HELLO reaction summary into ours (late-join convergence).
 *  Union-only: an un-react while we were apart still converges via the live
 *  'react-file' toggle, not the HELLO. Returns true when anything changed. */
function mergeReacts(room: Room, rec?: Record<string, Record<string, string[]>>): boolean {
  let changed = false;
  for (const [fileId, byEmoji] of Object.entries(clampReactsRecord(rec))) {
    for (const [emoji, members] of Object.entries(byEmoji)) {
      for (const m of members) if (applyFileReact(room, fileId, emoji, m, true)) changed = true;
    }
  }
  return changed;
}

/** Gossip OUR coarse download progress: only while downloading, and only when a
 *  new PROG_STEP boundary is crossed per file (completion rides 'have'). */
function maybeBroadcastProg(room: Room, fileId: string, progress: number, done: boolean): void {
  if (done) { room.progSent.delete(fileId); return; }
  const pct = Math.max(0, Math.min(100, Math.floor((Number(progress) || 0) * 100)));
  const step = pct - (pct % PROG_STEP);
  const last = room.progSent.get(fileId) ?? 0; // 0% is where every download starts — not news
  if (step <= last) return;
  room.progSent.set(fileId, step);
  broadcast(room, { t: 'prog', memberId: room.self.memberId, fileId, pct: step });
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
  // Liveness extras. Typing: known members with a fresh stamp (never self —
  // the renderer applies its own TTL fade, we just report who's live now).
  const typingMemberIds = Object.entries(room.typing)
    .filter(([id, at]) => id !== room.self.memberId && now - at < TYPING_TTL && room.members.has(id))
    .map(([id]) => id);
  // Coarse progress: offline members drop off; a file in a member's 'have' is
  // omitted (100% is implicit there).
  const memberProg: Record<string, Record<string, number>> = {};
  for (const [mid, byFile] of room.memberProg) {
    const m = room.members.get(mid);
    if (!m || now - m.lastSeen >= OFFLINE_AFTER) continue;
    const rec: Record<string, number> = {};
    for (const [fid, pct] of byFile) {
      if (m.have.includes(fid)) continue;
      rec[fid] = pct;
    }
    if (Object.keys(rec).length) memberProg[mid] = rec;
  }
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
    // Folders sorted by name (natural) for a stable order that doesn't jump when
    // one is renamed/recolored; the renderer groups files under them.
    folders: Array.from(room.folders.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })),
    transfers,
    history: room.history.slice(-100),
    chat: room.chat.slice(-100),
    connected: room.started,
    peerCount: onlinePeers,
    autoFetch: room.autoFetch,
    upKbps: room.upKbps,
    downKbps: room.downKbps,
    kicked: room.kicked,
    ...(room.kicked ? { kickedBy: room.kickedBy } : {}),
    typingMemberIds,
    fileReacts: reactsToRecord(room),
    memberProg,
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
    tombs: Array.from(room.tombstones.keys()), // share deletions so peers converge
    tombsAt: Object.fromEntries(room.tombstones), // timestamps let a newer re-share revive
    roomName: room.name, // so a joiner (who only knows the code) learns the name
    ownerId: room.ownerId, // so joiners learn who the owner is
    e2e: room.e2e, // E2E mode + content key ride the encrypted gossip channel
    secret: room.secret,
    ...(room.e2eCfg ? { cfg: room.e2eCfg } : {}), // owner-signed config, re-served for joiners
    ...(room.fileReacts.size ? { fileReacts: reactsToRecord(room) } : {}), // late joiners union this in
    ...(room.folders.size ? { folders: Array.from(room.folders.values()) } : {}), // section overlay
    ...(room.folderTombstones.size ? { folderTombs: Object.fromEntries(room.folderTombstones) } : {}), // deleted sections
  };
}

/** Persist a folder create/edit to main so it (and the grouping) survives restart. */
function persistFolder(room: Room, folder: RoomFolder): void {
  try { ipcRenderer.send('room-folder-upsert', { roomId: room.roomId, folder }); } catch { /* ignore */ }
}

/** Persist a folder deletion (tombstone + drop from the set). */
function persistFolderDelete(room: Room, id: string, at: number): void {
  try { ipcRenderer.send('room-folder-del', { roomId: room.roomId, id, at }); } catch { /* ignore */ }
}

// ── E2E config authenticity (Ed25519, same identity keys as chat) ────────────
// Holding the room code lets ANY member speak on the gossip channel, so the
// E2E flag+secret must not be trusted just because they arrived in a HELLO: a
// hostile member could otherwise plant a wrong secret on a fresh joiner (who
// would persist it and never decrypt anything). The owner therefore SIGNS the
// config; members verify before adopting, bind the owner's key TOFU like chat,
// and re-serve the signed blob so it propagates without the owner online.

/** Stable bytes the owner signs / members verify for an E2E config. The topic
 *  scopes it to this room's current key epoch (no cross-room/pre-rekey replay);
 *  the leading tag keeps it disjoint from chat's canonical form. */
function e2eCanonical(topic: string, cfg: { ownerId: string; e2e: boolean; secret: string }): Buffer {
  return Buffer.from(JSON.stringify(['th-room-e2e:v1', topic, cfg.ownerId, cfg.e2e, cfg.secret]), 'utf8');
}

/** Owner only: mint the signed E2E config for the room's CURRENT topic. */
function signE2ECfg(room: Room): E2ECfg | null {
  const body = { ownerId: room.self.memberId, e2e: room.e2e, secret: room.secret };
  try {
    const sig = crypto.sign(null, e2eCanonical(room.topic, body), crypto.createPrivateKey(room.self.priv)).toString('base64');
    return { ...body, pub: room.self.pub, sig };
  } catch (e) { log('e2e cfg sign failed: ' + String(e)); return null; }
}

/**
 * Verify an incoming signed E2E config: the signature must be valid over this
 * room's CURRENT topic, and the signing key must match the identity already
 * bound to the claimed ownerId (binding it on first sight, exactly like chat).
 * A verified config is the strongest E2E claim we have — but the first-sight
 * binding is still TOFU: a hostile member who reaches a fresh joiner before
 * anyone else can pose as the owner outright. What it removes is the ability
 * to tamper with the REAL owner's config or replay one across rooms/epochs.
 */
function verifyE2ECfg(room: Room, cfg: any): cfg is E2ECfg {
  if (!cfg || typeof cfg !== 'object') return false;
  if (!cfg.ownerId || !cfg.pub || !cfg.sig || typeof cfg.e2e !== 'boolean' || typeof cfg.secret !== 'string') return false;
  // If a signed config already established the owner, only that same owner counts.
  if (room.e2eSigned && room.ownerId && cfg.ownerId !== room.ownerId) {
    log('e2e cfg from a different claimed owner — dropped'); return false;
  }
  const bound = room.identities.get(cfg.ownerId);
  if (bound && bound !== cfg.pub) { log('e2e cfg owner key mismatch for ' + cfg.ownerId + ' — dropped'); return false; }
  let ok = false;
  try { ok = crypto.verify(null, e2eCanonical(room.topic, cfg), crypto.createPublicKey(cfg.pub), Buffer.from(cfg.sig, 'base64')); }
  catch (e) { log('e2e cfg verify error: ' + String(e)); return false; }
  if (!ok) { log('e2e cfg bad signature — dropped'); return false; }
  if (!bound) { room.identities.set(cfg.ownerId, cfg.pub); try { ipcRenderer.send('room-identity-add', { roomId: room.roomId, memberId: cfg.ownerId, pub: cfg.pub }); } catch { /* ignore */ } }
  return true;
}

/** Persist the current E2E view (flag, secret, signed blob) via the main process. */
function persistE2E(room: Room): void {
  try { ipcRenderer.send('room-e2e', { roomId: room.roomId, e2e: room.e2e, secret: room.secret, cfg: room.e2eCfg }); } catch { /* ignore */ }
}

/**
 * Learn the room's E2E mode + content secret from a peer's HELLO. The secret is
 * separate from the rotating gossip key, so it survives kicks.
 *
 * Trust rules (the code alone makes every member a valid gossip speaker, so the
 * config needs its own authenticity):
 *   • A VERIFIED owner-signed `cfg` is authoritative: it sets flag+secret, may
 *     correct an unsigned owner claim, and OVERRIDES a secret that was adopted
 *     unsigned — the recovery path for a member a hostile peer got to first.
 *   • Unsigned e2e/secret are the legacy fallback (owner on an older build):
 *     the flag is monotonic (false→true only; a "downgrade to plaintext" is
 *     ignored) and the secret adopts once — a conflicting later value is logged,
 *     never obeyed. Rooms whose invite code carries the -e2e marker never accept
 *     unsigned values at all: their owner provably signs.
 *   • Once a verified config established the state, unsigned input is ignored.
 * Any change is persisted (room-e2e IPC → db) and may unblock queued ciphertext.
 */
function maybeAdoptE2E(room: Room, e2e?: boolean, secret?: string, cfg?: E2ECfg): void {
  let changed = false;
  if (cfg && verifyE2ECfg(room, cfg)) {
    // The signed claim also proves ownership — adopt/correct an ownerId that was
    // never backed by a signature (a bare HELLO field is just a claim).
    if (room.ownerId !== cfg.ownerId && (!room.ownerId || !room.e2eSigned)) {
      room.ownerId = cfg.ownerId;
      try { ipcRenderer.send('room-owner', { roomId: room.roomId, ownerId: cfg.ownerId }); } catch { /* ignore */ }
      changed = true;
    }
    if (cfg.e2e && !room.e2e) { room.e2e = true; changed = true; }
    if (cfg.secret && cfg.secret !== room.secret) {
      if (room.secret) log('e2e secret corrected by owner-signed config');
      room.secret = cfg.secret;
      changed = true;
    }
    if (!room.e2eSigned || room.e2eCfg?.sig !== cfg.sig) { room.e2eCfg = cfg; room.e2eSigned = true; changed = true; }
  } else if (!room.e2eSigned) {
    if (codeIsE2E(room.code)) {
      // New-format room: the owner always signs, so an unsigned secret can only
      // be a plant — refuse it outright (no first-claimant race to win).
      if (secret && secret !== room.secret) log('unsigned e2e secret in a signed room — ignored');
    } else {
      if (e2e === true && !room.e2e) { room.e2e = true; changed = true; }
      else if (e2e === false && room.e2e) log('unsigned e2e downgrade — ignored');
      if (secret && !room.secret) { room.secret = secret; changed = true; }
      else if (secret && secret !== room.secret) log('conflicting unsigned e2e secret — ignored');
    }
  }
  if (changed) {
    persistE2E(room);
    // A just-learned (or corrected) secret may unblock ciphertext we already hold.
    if (room.secret) void decryptPending(room);
    pushState(room);
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

/** Coerce a peer-supplied file entry to a sane shape, or null if unusable.
 *  file.name is reduced to a traversal-free basename (safeBaseName) because every
 *  write site does path.join(room.folder, file.name) — see shared/path-safety. */
function clampFile(f: any): RoomFile | null {
  if (!f || typeof f !== 'object') return null;
  const fileId = clampStr(f.fileId, MAX_STR);
  const magnetURI = clampStr(f.magnetURI, MAX_MAGNET);
  const name = safeBaseName(clampStr(f.name, MAX_STR));
  // A file with no usable (traversal-free) name can't be safely stored — drop it.
  if (!fileId || !magnetURI || !name) return null;
  return {
    fileId,
    name,
    size: Number.isFinite(f.size) ? f.size : 0,
    // fileId IS the infoHash by construction; clamping used to drop this field,
    // which voided every c.get(file.infoHash) re-entry guard for remote files.
    infoHash: fileId,
    magnetURI,
    addedBy: clampStr(f.addedBy, MAX_STR),
    addedByName: clampStr(f.addedByName, MAX_STR),
    addedAt: Number.isFinite(f.addedAt) ? f.addedAt : Date.now(),
    ...(f.enc ? { enc: true } : {}),
    // Folder assignment MUST be copied explicitly or it is silently stripped on
    // receive — the same trap the enc/infoHash fields document above.
    ...(typeof f.folderId === 'string' && f.folderId ? { folderId: clampStr(f.folderId, MAX_STR) } : {}),
    ...(Number.isFinite(f.folderAt) ? { folderAt: f.folderAt } : {}),
  } as RoomFile;
}

/** Coerce a peer-supplied folder entry to a sane shape, or null if unusable. */
function clampFolder(f: any): RoomFolder | null {
  if (!f || typeof f !== 'object') return null;
  const id = clampStr(f.id, MAX_STR);
  const at = Number(f.at);
  if (!id || !Number.isFinite(at)) return null;
  return { id, name: clampStr(f.name, MAX_STR), icon: clampStr(f.icon, 64), color: clampStr(f.color, 64), at };
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
  if ('emoji' in msg) msg.emoji = clampStr(msg.emoji, 16);
  if ('pub' in msg) msg.pub = clampStr(msg.pub, MAX_STR * 2);
  if ('sig' in msg) msg.sig = clampStr(msg.sig, MAX_STR);
  if ('cfg' in msg) {
    const c = msg.cfg;
    msg.cfg = (c && typeof c === 'object' && !Array.isArray(c))
      ? { ownerId: clampStr(c.ownerId, MAX_STR), e2e: c.e2e === true, secret: clampStr(c.secret, MAX_SECRET), pub: clampStr(c.pub, MAX_STR * 2), sig: clampStr(c.sig, MAX_STR) }
      : undefined;
  }
  if (Array.isArray(msg.have)) msg.have = msg.have.slice(0, MAX_ARRAY).map((x: any) => clampStr(x, MAX_STR));
  if (Array.isArray(msg.tombs)) msg.tombs = msg.tombs.slice(0, MAX_ARRAY).map((x: any) => clampStr(x, MAX_STR));
  if ('tombsAt' in msg) {
    const out: Record<string, number> = {};
    if (msg.tombsAt && typeof msg.tombsAt === 'object' && !Array.isArray(msg.tombsAt)) {
      for (const [k, v] of Object.entries(msg.tombsAt).slice(0, MAX_ARRAY)) {
        const at = Number(v);
        if (Number.isFinite(at)) out[clampStr(k, MAX_STR)] = at;
      }
    }
    msg.tombsAt = out;
  }
  if (Array.isArray(msg.files)) msg.files = msg.files.slice(0, MAX_ARRAY).map(clampFile).filter(Boolean);
  if ('file' in msg) msg.file = clampFile(msg.file);
  // Folder gossip fields (folder/assign messages + folders/folderTombs in hello).
  if ('id' in msg) msg.id = clampStr(msg.id, MAX_STR);
  if ('op' in msg) msg.op = msg.op === 'del' ? 'del' : 'upsert';
  if ('icon' in msg) msg.icon = clampStr(msg.icon, 64);
  if ('color' in msg) msg.color = clampStr(msg.color, 64);
  if ('folderId' in msg) msg.folderId = clampStr(msg.folderId, MAX_STR);
  if (Array.isArray(msg.folders)) msg.folders = msg.folders.slice(0, MAX_ARRAY).map(clampFolder).filter(Boolean);
  if ('folderTombs' in msg) {
    const out: Record<string, number> = {};
    if (msg.folderTombs && typeof msg.folderTombs === 'object' && !Array.isArray(msg.folderTombs)) {
      for (const [k, v] of Object.entries(msg.folderTombs).slice(0, MAX_ARRAY)) {
        const at = Number(v);
        if (Number.isFinite(at)) out[clampStr(k, MAX_STR)] = at;
      }
    }
    msg.folderTombs = out;
  }
  if ('pct' in msg) {
    const p = Math.round(Number(msg.pct));
    msg.pct = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
  }
  if ('on' in msg) msg.on = msg.on === true;
  if ('fileReacts' in msg) msg.fileReacts = clampReactsRecord(msg.fileReacts);
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
      maybeAdoptE2E(room, msg.e2e, msg.secret, msg.cfg);
      if (isNew) logEvent(room, { type: 'joined', actorId: msg.memberId, actorName: msg.name || '?' });
      // Apply peer deletions first so their HELLO file list can't re-add them.
      // A tombstone without a timestamp came from an older build that can't
      // express revives — treat it as fresh so its deletion still sticks.
      for (const id of msg.tombs || []) applyTombstone(room, id, msg.tombsAt?.[id] ?? Date.now());
      for (const f of msg.files || []) mergeFile(room, f);
      // Folder overlay convergence: apply the peer's deletions first (so a stale
      // folder in their list can't override our newer delete), then their upserts.
      for (const [id, at] of Object.entries(msg.folderTombs || {})) {
        if (applyFolderDelete(room.folders, room.folderTombstones, id, Number(at) || 0)) persistFolderDelete(room, id, Number(at) || 0);
      }
      for (const f of msg.folders || []) {
        if (mergeFolderUpsert(room.folders, room.folderTombstones, f)) persistFolder(room, f);
      }
      // Union the peer's reaction view into ours (late-join convergence).
      if (mergeReacts(room, msg.fileReacts)) persistReacts(room);
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
    case 'folder': {
      if (msg.op === 'del') {
        if (applyFolderDelete(room.folders, room.folderTombstones, msg.id, Number(msg.at) || 0)) {
          persistFolderDelete(room, msg.id, Number(msg.at) || 0);
          pushState(room);
        }
      } else {
        const folder: RoomFolder = { id: msg.id, name: msg.name || 'Folder', icon: msg.icon || 'folder', color: msg.color || '', at: Number(msg.at) || 0 };
        if (mergeFolderUpsert(room.folders, room.folderTombstones, folder)) {
          persistFolder(room, folder);
          pushState(room);
        }
      }
      break;
    }
    case 'assign': {
      const file = room.files.get(msg.fileId);
      if (file && applyAssignment(file, msg.folderId, Number(msg.at) || 0)) {
        const tr = room.transfers.get(msg.fileId);
        persistManifest(room, file, tr?.localPath, tr?.cipherPath); // re-persist the whole file with its new folderId
        pushState(room);
      }
      break;
    }
    case 'have': {
      const m = room.members.get(msg.memberId);
      if (m && !m.have.includes(msg.fileId)) { m.have.push(msg.fileId); m.lastSeen = Date.now(); }
      // They have the whole file now — the coarse-progress entry is obsolete
      // ('have' implies 100%).
      room.memberProg.get(msg.memberId)?.delete(msg.fileId);
      pushState(room);
      break;
    }
    case 'del': {
      if (room.mutes.has(msg.memberId)) break; // ignore deletes from a muted member
      const actor = room.members.get(msg.memberId);
      const at = Number(msg.at) || Date.now(); // older builds don't stamp deletions
      applyTombstone(room, msg.fileId, at, { id: msg.memberId, name: actor?.name || '?' });
      try { ipcRenderer.send('room-tomb', { roomId: room.roomId, fileId: msg.fileId, at }); } catch { /* ignore */ }
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
      // Their session-only liveness goes with them.
      room.memberProg.delete(msg.memberId);
      delete room.typing[msg.memberId];
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
          memberId: msg.memberId, name: msg.name, avatarSeed: msg.avatarSeed, playing: msg.playing, together: msg.together, emoji: msg.emoji,
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
    case 'typing': {
      // Only KNOWN, unmuted members get a stamp — that bounds the map by the
      // roster (hostile gossip can't spray phantom ids into it).
      const m = room.members.get(msg.memberId);
      if (!m || room.mutes.has(msg.memberId)) break;
      const now = Date.now();
      m.lastSeen = now; // a typer is definitionally alive
      room.typing[msg.memberId] = now;
      // Sweep long-expired stamps so the map never outgrows the roster.
      for (const [id, at] of Object.entries(room.typing)) if (now - at > TYPING_TTL * 2) delete room.typing[id];
      pushState(room); // the renderer fades on its own TTL — just report the stamps
      break;
    }
    case 'react-file': {
      if (room.mutes.has(msg.memberId)) break; // a muted member's reactions stay hidden
      // applyFileReact enforces the emoji whitelist + caps; anything else is a no-op.
      if (applyFileReact(room, msg.fileId, msg.emoji, msg.memberId, msg.on === true)) {
        persistReacts(room);
        pushState(room);
      }
      break;
    }
    case 'prog': {
      const m = room.members.get(msg.memberId);
      if (!m || !msg.fileId) break;           // unknown member — ignore (bounds the map)
      if (m.have.includes(msg.fileId)) break; // they already have it — 'have' wins
      let byFile = room.memberProg.get(msg.memberId);
      if (!byFile) { byFile = new Map(); room.memberProg.set(msg.memberId, byFile); }
      if (!byFile.has(msg.fileId) && byFile.size >= MAX_ARRAY) break;
      byFile.set(msg.fileId, msg.pct); // clampGossip bounded pct to an int 0-100
      m.lastSeen = Date.now();
      pushState(room);
      break;
    }
  }
}

/** True when a tombstone still outranks this file (deletion is as new or newer
 *  than the add). Ties go to the deletion. */
function isTombstonedAt(room: Room, fileId: string, addedAt: number): boolean {
  const tombAt = room.tombstones.get(fileId);
  return tombAt !== undefined && addedAt <= tombAt;
}

/** Lift a tombstone here and in the persisted store (the file was revived). */
function clearTombstone(room: Room, fileId: string): void {
  if (!room.tombstones.delete(fileId)) return;
  try { ipcRenderer.send('room-tomb-del', { roomId: room.roomId, fileId }); } catch { /* ignore */ }
}

/**
 * Drop a file from this room and keep it out until an explicitly newer re-share.
 * Removes it from the manifest/transfers, stops the torrent, and deletes the
 * on-disk copy only when it lives inside the room folder (never the original a
 * member shared from). `at` is the deletion time: if the local copy was added
 * AFTER it (someone revived the file), the stale tombstone is ignored outright.
 */
function applyTombstone(room: Room, fileId: string, at: number, by?: { id: string; name: string }): void {
  const current = room.files.get(fileId);
  if (current && current.addedAt > at) return; // revived later — the newer add wins
  room.tombstones.set(fileId, Math.max(at, room.tombstones.get(fileId) ?? 0));
  // Drop it from the persisted manifest too so it isn't re-seeded next launch.
  try { ipcRenderer.send('room-manifest-del', { roomId: room.roomId, fileId }); } catch { /* ignore */ }
  const existed = room.files.get(fileId);
  if (existed) logEvent(room, { type: 'file-removed', actorId: by?.id || '', actorName: by?.name || '?', fileName: existed.name });
  const tr = room.transfers.get(fileId);
  const c = clients.get(room.roomId);
  if (c) { const t = c.get(fileId); if (t) { try { c.remove(t); } catch { /* ignore */ } } }
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
  // E2E: also drop the ciphertext copy we kept for seeding. Each share's cipher
  // lives in its own directory under the cache — sweep the empty dir with it.
  try {
    const cp = tr?.cipherPath;
    if (cp && fs.existsSync(cp)) fs.unlinkSync(cp);
    if (cp && room.cacheDir) {
      const d = path.dirname(cp);
      if (path.resolve(d).startsWith(path.resolve(room.cacheDir) + path.sep)) fs.rmdirSync(d); // throws if non-empty — fine
    }
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
  if (isTombstonedAt(room, file.fileId, file.addedAt)) return; // deleted — don't let a stale copy resurrect it
  if (room.mutes.has(file.addedBy)) return;     // muted member — ignore their shares locally
  // An add newer than our tombstone means a member explicitly re-shared the
  // file after its deletion — lift the tombstone and let it back in.
  clearTombstone(room, file.fileId);
  if (!room.files.has(file.fileId)) {
    room.files.set(file.fileId, file);
    persistManifest(room, file); // localPath filled in once the download lands
    logEvent(room, { type: 'file-added', actorId: file.addedBy, actorName: file.addedByName || room.members.get(file.addedBy)?.name || '?', fileName: file.name });
    // Manual mode: list the file but don't fetch — the user pulls it with an
    // explicit fetchFile. (Our OWN shares go through mergeFileLocal instead.)
    if (room.autoFetch) ensureLocal(room, file);
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
  const c = ensureClient(room);
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
      // The cipher's on-disk basename MUST equal the torrent name: webtorrent
      // resolves a seed's read-back store from the METADATA name, so a name
      // override over a differently-named file yields a seed that hashes fine
      // but errors 'Not opened' on every piece read — a seeder that serves
      // nothing. (Same bug class as the native engine's custom-name seed.)
      // Uniqueness therefore lives in the DIRECTORY: encryption is IV-fresh per
      // share, so a same-named re-share writing to a fixed path would truncate
      // the ciphertext backing the still-registered previous seed.
      const cipherDir = path.join(room.cacheDir, `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`);
      try { fs.mkdirSync(cipherDir, { recursive: true }); } catch { /* ignore */ }
      const cipherPath = path.join(cipherDir, `${name}.enc`);
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
  if (isTombstonedAt(room, file.fileId, file.addedAt)) return; // deleted — don't fetch it again
  const c = ensureClient(room);
  if (c.get(file.infoHash)) return; // already adding/seeding

  // E2E: the swarm carries ciphertext. Download it into the cache (never the
  // room folder), then decrypt the plaintext into the folder for watch/open.
  if (room.e2e) {
    const plain = path.join(room.folder, file.name);
    const cipherName = `${file.name}.enc`;
    // The cache slot is keyed by fileId, NOT display name: two same-named files
    // are different ciphertexts, and a name-keyed slot would adopt (or truncate)
    // the wrong one. fileId is the cipher torrent's infoHash, so a hit at this
    // path is the right bytes by construction. Non-hex ids (hostile gossip)
    // fall back to their hash so they can't traverse out of the cache dir.
    const idDir = /^[0-9a-f]{40}$/i.test(file.fileId) ? file.fileId : crypto.createHash('sha1').update(file.fileId).digest('hex');
    const cipherDir = path.join(room.cacheDir, idDir);
    const cachedCipher = path.join(cipherDir, cipherName);
    try { fs.mkdirSync(cipherDir, { recursive: true }); } catch { /* ignore */ }
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
      c.add(file.magnetURI, { path: cipherDir, announce: ROOM_TRACKERS } as any, (torrent: any) => {
        wireTorrentStats(room, torrent);
        torrent.on('done', () => {
          const landedCipher = path.join(cipherDir, safeBaseName(torrent.name) || cipherName);
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
  if (isTombstonedAt(room, pf.fileId, pf.addedAt)) return;
  if (room.files.has(pf.fileId)) return;
  const file: RoomFile = {
    fileId: pf.fileId, name: pf.name, size: pf.size, infoHash: pf.infoHash,
    magnetURI: pf.magnetURI, addedBy: pf.addedBy, addedByName: pf.addedByName, addedAt: pf.addedAt,
    ...(pf.enc ? { enc: true } : {}),
    // Preserve the folder assignment across restart (same field-list trap as clampFile).
    ...(pf.folderId ? { folderId: pf.folderId } : {}),
    ...(Number.isFinite(pf.folderAt) ? { folderAt: pf.folderAt } : {}),
  };
  room.files.set(file.fileId, file);
  const c = ensureClient(room);
  if (c.get(file.infoHash)) return; // already seeding/adding

  // E2E: re-seed the cached CIPHERTEXT (never the plaintext) and make sure the
  // plaintext exists in the folder for watch/open.
  if (room.e2e) {
    const plain = path.join(room.folder, file.name);
    if (pf.cipherPath && fs.existsSync(pf.cipherPath)) {
      const cipherName = `${file.name}.enc`;
      let cipherPath = pf.cipherPath;
      // Legacy cache entries (<ts>_<rand>_<name>.enc) predate the disk-name ==
      // torrent-name rule; seeding one under the canonical name would recreate
      // the unreadable-store seeder this layout exists to prevent. Move the file
      // into the modern per-share directory — same bytes + same torrent name →
      // same infoHash, so the manifest fileId still holds.
      if (path.basename(cipherPath) !== cipherName) {
        try {
          const idDir = /^[0-9a-f]{40}$/i.test(file.fileId) ? file.fileId : crypto.createHash('sha1').update(file.fileId).digest('hex');
          const dir = path.join(room.cacheDir, idDir);
          fs.mkdirSync(dir, { recursive: true });
          const dst = path.join(dir, cipherName);
          fs.renameSync(cipherPath, dst);
          cipherPath = dst;
          persistManifest(room, file, pf.localPath, dst);
          log('e2e cipher migrated to per-share layout: ' + file.name);
        } catch (e) { log('e2e cipher migrate failed: ' + String(e)); }
      }
      const havePlain = fs.existsSync(plain);
      setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: havePlain, ...(havePlain ? { localPath: plain } : {}), cipherPath });
      try { c.seed(cipherPath, { announce: ROOM_TRACKERS, name: cipherName } as any, (t: any) => wireTorrentStats(room, t)); }
      catch (e) { log('e2e manifest reseed failed: ' + String(e)); }
      if (room.secret && !havePlain) void decryptOne(room, file, cipherPath);
      return;
    }
    if (room.autoFetch) ensureLocal(room, file); // no cached ciphertext — re-download it
    return;
  }

  if (pf.localPath && fs.existsSync(pf.localPath)) {
    setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true, localPath: pf.localPath });
    try { c.seed(pf.localPath, { announce: ROOM_TRACKERS, name: file.name } as any, (t: any) => wireTorrentStats(room, t)); }
    catch (e) { log('manifest reseed failed: ' + String(e)); }
    return;
  }
  if (room.autoFetch) ensureLocal(room, file); // not at the known path — seed-from-folder or re-download
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
    // Let peers see our download move (10%-step throttled; 'have' covers 100%).
    maybeBroadcastProg(room, fileId, torrent.progress || 0, done);
    pushState(room);
  };
  torrent.on('download', update);
  torrent.on('upload', update);
  torrent.on('wire', update);
  torrent.on('error', (e: any) => { setTransfer(room, fileId, { status: 'error' }); log(`torrent ${fileId.slice(0, 8)} error: ${e?.message || e}`); });
  // Surface swarm distress that otherwise dies silently — piece-verification
  // failures arrive as 'warning' and look like an endless 0%-download without this.
  torrent.on('warning', (e: any) => log(`torrent ${fileId.slice(0, 8)} warning: ${e?.message || e}`));
  torrent.once('metadata', () => log(`torrent ${fileId.slice(0, 8)} metadata: length=${torrent.length} pieces=${torrent.pieces?.length}`));
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
  room.memberProg.delete(kickedId);
  delete room.typing[kickedId];
  for (const wire of Array.from(room.wires.values())) {
    if (wire.memberId === kickedId) { try { wire.peer.destroy(); } catch { /* ignore */ } room.wires.delete(wire.id); }
  }
  room.code = newCode;
  room.key = deriveKey(newCode);
  room.topic = topicHash(newCode);
  try { ipcRenderer.send('room-rekey', { roomId: room.roomId, code: newCode }); } catch { /* ignore */ }
  // The signed E2E config binds the topic, which just rotated: the owner mints a
  // fresh one (broadcast in the re-greet below); members drop the now-stale blob
  // and pick the owner's new one from its HELLO. Flag/secret themselves persist
  // (that's the point of the secret being separate from the code).
  if (room.e2e) {
    room.e2eCfg = room.ownerId === room.self.memberId ? signE2ECfg(room) : null;
    persistE2E(room);
  }
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
  //    An E2E room's replacement code keeps the -e2e marker (joiners of the new
  //    code must still know not to seed plaintext).
  const newCode = generateRoomCode(room.e2e);
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
  self: { memberId: string; name: string; avatarSeed: string; pub: string; priv: string }; useTurn: boolean; turnServers?: any[]; tombstones?: Record<string, number>; manifest?: PersistedRoomFile[]; folders?: RoomFolder[]; folderTombs?: Record<string, number>; ownerId?: string; mutes?: string[]; history?: RoomEvent[]; chat?: RoomChatMessage[]; reacts?: Record<string, Record<string, string[]>>; identities?: Record<string, string>; e2e?: boolean; secret?: string; e2eCfg?: E2ECfg | null; cacheDir?: string; autoFetch?: boolean; upKbps?: number; downKbps?: number }): RoomState {
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
    // The invite code is the E2E source of truth for new-format rooms: even if
    // the persisted flag is missing/stale, a "-e2e" code must never run plaintext.
    e2e: p.e2e || codeIsE2E(p.code),
    secret: p.secret || '',
    e2eCfg: null,
    e2eSigned: false,
    cacheDir: p.cacheDir || '',
    wires: new Map(),
    members: new Map(),
    files: new Map(),
    folders: new Map((p.folders || []).map((f: RoomFolder) => [f.id, f])),
    folderTombstones: new Map(Object.entries(p.folderTombs || {}).map(([k, v]) => [k, Number(v) || 0])),
    transfers: new Map(),
    tombstones: new Map(Object.entries(p.tombstones || {})),
    autoFetch: p.autoFetch !== false, // absent = true (historical behavior)
    upKbps: Math.max(0, Number(p.upKbps) || 0),
    downKbps: Math.max(0, Number(p.downKbps) || 0),
    mutes: new Set(p.mutes || []),
    history: (p.history || []).slice(-200),
    chat: (p.chat || []).slice(-200),
    typing: {},
    lastTypingSent: 0,
    fileReacts: reactsFromRecord(p.reacts),
    memberProg: new Map(),
    progSent: new Map(),
    identities: new Map(Object.entries(p.identities || {})),
    seenGids: new Set(),
    seenGidOrder: [],
    kicked: false,
    kickedBy: '',
    snapshotTimer: null,
    lastSnapshot: 0,
  };
  rooms.set(p.roomId, room);

  // E2E authenticity: the owner mints the signed config fresh (it holds the
  // private key, so no persistence is needed); everyone else restores the
  // owner's persisted blob — re-verified, since the topic may have rotated or
  // the store been tampered with — and re-serves it to joiners.
  if (room.e2e && room.secret && room.ownerId === room.self.memberId) {
    room.e2eCfg = signE2ECfg(room);
    room.e2eSigned = !!room.e2eCfg;
  } else if (p.e2eCfg && verifyE2ECfg(room, p.e2eCfg)) {
    room.e2eCfg = p.e2eCfg;
    room.e2eSigned = true;
  }

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

/** A locally-seeded file: register in manifest + announce to peers.
 *  ANY tombstone blocks this path, regardless of timestamps: the startup folder
 *  scan feeds it, and a deleted file still sitting on disk must not silently
 *  revive itself. Only the explicit addFiles path lifts a tombstone. */
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
  // Track per-file outcomes: resolving with a state while NOTHING was shared
  // used to read as success upstream ("Shared to <room>" with an empty room).
  let added = 0;
  let firstError: string | null = null;
  for (const p of paths) {
    try {
      const file = await seedLocal(room, p);
      // Re-sharing previously deleted content is an explicit revive: lift the
      // tombstone and stamp the add strictly after the deletion, so the 'add'
      // we broadcast (and our HELLOs) beat every peer's stored tombstone —
      // including peers currently offline, once they reconnect.
      const tombAt = room.tombstones.get(file.fileId);
      if (tombAt !== undefined) {
        file.addedAt = Math.max(file.addedAt, tombAt + 1);
        clearTombstone(room, file.fileId);
      }
      mergeFileLocal(room, file, p);
      // Already present (same content shared before) counts as success too.
      if (room.files.has(file.fileId)) added++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!firstError) firstError = msg;
      log('addFile failed: ' + msg);
    }
  }
  if (paths.length > 0 && added === 0) {
    throw new Error(firstError || 'No files could be shared');
  }
  return buildState(room);
}

// ── Folders / sections (local commands) ───────────────────────────────────────
function createFolder(roomId: string, name: string, icon: string, color: string): RoomState {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  const folder: RoomFolder = {
    id: crypto.randomBytes(8).toString('hex'),
    name: String(name || '').trim().slice(0, 200) || 'Folder',
    icon: String(icon || 'folder').slice(0, 64),
    color: String(color || '').slice(0, 64),
    at: Date.now(),
  };
  room.folders.set(folder.id, folder);
  persistFolder(room, folder);
  broadcast(room, { t: 'folder', op: 'upsert', id: folder.id, name: folder.name, icon: folder.icon, color: folder.color, at: folder.at });
  pushState(room, true);
  return buildState(room);
}

function updateFolder(roomId: string, folderId: string, patch: { name?: string; icon?: string; color?: string }): RoomState {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  const cur = room.folders.get(folderId);
  if (!cur) return buildState(room);
  const next: RoomFolder = {
    ...cur,
    ...(typeof patch?.name === 'string' ? { name: patch.name.trim().slice(0, 200) || cur.name } : {}),
    ...(typeof patch?.icon === 'string' ? { icon: patch.icon.slice(0, 64) } : {}),
    ...(typeof patch?.color === 'string' ? { color: patch.color.slice(0, 64) } : {}),
    at: Date.now(),
  };
  room.folders.set(folderId, next);
  persistFolder(room, next);
  broadcast(room, { t: 'folder', op: 'upsert', id: next.id, name: next.name, icon: next.icon, color: next.color, at: next.at });
  pushState(room, true);
  return buildState(room);
}

function deleteFolder(roomId: string, folderId: string): RoomState {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  const at = Date.now();
  // Files keep their (now-dangling) folderId → they render Uncategorized via
  // groupFilesByFolder. No per-file reassignment gossip needed.
  if (applyFolderDelete(room.folders, room.folderTombstones, folderId, at)) {
    persistFolderDelete(room, folderId, at);
    broadcast(room, { t: 'folder', op: 'del', id: folderId, at });
    pushState(room, true);
  }
  return buildState(room);
}

function assignFile(roomId: string, fileId: string, folderId: string | null): RoomState {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  const file = room.files.get(fileId);
  if (!file) return buildState(room);
  const at = Date.now();
  if (applyAssignment(file, folderId, at)) {
    const tr = room.transfers.get(fileId);
    persistManifest(room, file, tr?.localPath, tr?.cipherPath);
    broadcast(room, { t: 'assign', fileId, folderId: folderId || '', at, memberId: room.self.memberId });
    pushState(room, true);
  }
  return buildState(room);
}

function leaveRoom(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  // Tell peers we're leaving so they drop us at once (no 45s offline ghost).
  broadcast(room, { t: 'bye', memberId: room.self.memberId });
  rooms.delete(roomId);
  const c = clients.get(roomId);
  clients.delete(roomId);
  const teardown = (): void => {
    try { room.tracker?.stop(); room.tracker?.destroy(); } catch { /* ignore */ }
    for (const wire of room.wires.values()) { try { wire.peer.destroy(); } catch { /* ignore */ } }
    // The client is the room's own — tearing it down stops all its transfers.
    try { c?.destroy(); } catch { /* ignore */ }
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
  // Per-room clients: dropping the torrent here can't affect other rooms.
  const c = clients.get(roomId);
  if (c) {
    const t = c.get(fileId);
    if (t) { try { c.remove(t); } catch (e) { log('release failed: ' + String(e)); } }
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
    else if (type === 'createFolder') data = createFolder(msg.roomId, msg.name, msg.icon, msg.color);
    else if (type === 'updateFolder') data = updateFolder(msg.roomId, msg.folderId, msg.patch || {});
    else if (type === 'deleteFolder') data = deleteFolder(msg.roomId, msg.folderId);
    else if (type === 'assignFile') data = assignFile(msg.roomId, msg.fileId, msg.folderId ?? null);
    else if (type === 'leave') { leaveRoom(msg.roomId); data = { ok: true }; }
    else if (type === 'profile') { updateProfile(msg.payload || {}); data = { ok: true }; }
    else if (type === 'releaseFile') { releaseFile(msg.roomId, msg.fileId); data = { ok: true }; }
    else if (type === 'removeFile') {
      const r = rooms.get(msg.roomId);
      if (r) {
        // Reuse the manager's timestamp so the persisted tombstone and the
        // gossiped one agree on when the deletion happened.
        const at = Number(msg.at) || Date.now();
        applyTombstone(r, msg.fileId, at, { id: r.self.memberId, name: r.self.name || 'You' });
        broadcast(r, { t: 'del', fileId: msg.fileId, memberId: r.self.memberId, at });
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
        avatarSeed: r.self.avatarSeed, playing: !!p.playing, together: !!p.together, emoji: String(p.emoji || '').slice(0, 16),
      });
      data = { ok: true };
    }
    else if (type === 'chat') { sendChat(msg.roomId, String((msg.payload || {}).text || '')); data = { ok: true }; }
    else if (type === 'typing') {
      // Fire-and-forget liveness: tell peers we're composing. Rate-limited so a
      // keystroke-driven renderer can call this freely. Never persisted.
      const r = rooms.get(msg.roomId);
      if (r && Date.now() - r.lastTypingSent >= TYPING_MIN_INTERVAL) {
        r.lastTypingSent = Date.now();
        broadcast(r, { t: 'typing', memberId: r.self.memberId });
      }
      data = { ok: true };
    }
    else if (type === 'reactFile') {
      const r = rooms.get(msg.roomId);
      if (!r) throw new Error('Room not active');
      const fileId = String(msg.fileId || '');
      const emoji = String(msg.emoji || '').slice(0, 16);
      if (!REACTION_SET.has(emoji)) throw new Error('Unsupported reaction');
      if (!r.files.has(fileId)) throw new Error('File not found in this room');
      // Toggle from OUR current view; gossip the explicit on/off so peers
      // converge without needing to know our previous state.
      const on = !r.fileReacts.get(fileId)?.get(emoji)?.has(r.self.memberId);
      if (applyFileReact(r, fileId, emoji, r.self.memberId, on)) {
        persistReacts(r);
        broadcast(r, { t: 'react-file', memberId: r.self.memberId, fileId, emoji, on });
        pushState(r, true);
      }
      data = { ok: true };
    }
    else if (type === 'snapshot') { const r = rooms.get(msg.roomId); data = r ? buildState(r) : null; }
    else if (type === 'setAutoFetch') {
      const r = rooms.get(msg.roomId);
      if (r) {
        r.autoFetch = msg.autoFetch !== false;
        // Turning auto back ON pulls everything that was left unfetched.
        if (r.autoFetch) {
          for (const f of r.files.values()) {
            if (!r.transfers.get(f.fileId)?.haveLocally) ensureLocal(r, f);
          }
        }
        pushState(r, true);
      }
      data = { ok: true };
    }
    else if (type === 'fetchFile') {
      const r = rooms.get(msg.roomId);
      if (!r) throw new Error('Room not active');
      const f = r.files.get(String(msg.fileId || ''));
      if (!f) throw new Error('File not found in this room');
      ensureLocal(r, f);
      pushState(r, true);
      data = buildState(r);
    }
    else if (type === 'setLimits') {
      const r = rooms.get(msg.roomId);
      if (r) {
        r.upKbps = Math.max(0, Number(msg.upKbps) || 0);
        r.downKbps = Math.max(0, Number(msg.downKbps) || 0);
        // Throttle the room's live client; a not-yet-created client picks the
        // limits up at construction (ensureClient reads them from the room).
        const c = clients.get(r.roomId);
        if (c) {
          try { c.throttleUpload(kbpsToLimit(r.upKbps)); } catch (e) { log('throttleUpload failed: ' + String(e)); }
          try { c.throttleDownload(kbpsToLimit(r.downKbps)); } catch (e) { log('throttleDownload failed: ' + String(e)); }
        }
        pushState(r, true);
      }
      data = { ok: true };
    }
    else throw new Error('Unknown room command: ' + type);
    ipcRenderer.send('room-res', { reqId, ok: true, data });
  } catch (e: any) {
    ipcRenderer.send('room-res', { reqId, ok: false, error: e?.message || String(e) });
  }
});

ipcRenderer.send('room-ready');
