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
import { deriveKey, topicHash, rendezvousId, randomPeerId, encrypt, decrypt, generateRoomCode, codeIsE2E, deriveMemberId, buildInvite } from './room-crypto';
import { encryptFile, decryptFile } from './room-e2e';
import { RoomFile, RoomFolder, RoomMember, RoomState, RoomTransfer, PersistedRoomFile, RoomEvent, RoomChatMessage, VoiceSettings, VoiceDeviceInfo } from '../../shared/types';
import { mergeFolderUpsert, applyFolderDelete, applyAssignment, sanitizeFolderIcon, wantAutoFetch } from '../../shared/room-folders';
import { PROFILE_STATUS_MAX, PROFILE_COLOR_RE, PROFILE_IMG_MAX_CHARS, sanitizeProfileStatus, sanitizeProfileImg } from '../../shared/profile';
import { safeBaseName, safeDirSegment } from '../../shared/path-safety';
import crypto from 'crypto';

import TrackerClient from 'bittorrent-tracker';

import { STUN_SERVERS, RENDEZVOUS_TRACKERS } from './ice-servers';
import { VoiceSession, VoiceAdapter, SignalKind, LoopbackKind, MicTester, defaultVoiceSettings, sanitizeVoiceSettings } from './room-voice';

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
const RELAYABLE = new Set(['hello', 'ping', 'add', 'have', 'del', 'chat', 'sync', 'bye', 'typing', 'react-file', 'prog', 'folder', 'assign', 'rename', 'voice-state', 'voice-signal', 'voice-share', 'profile']);

// ── Gossip input hardening ────────────────────────────────────────────────────
// Decryption already proves a peer holds the room code, but a *malicious member*
// could still send oversized/malformed gossip to exhaust memory — and peer-relay
// would re-flood it. So every inbound frame is size-capped before we even decrypt,
// and the decoded message's strings/arrays are clamped to sane bounds (in place,
// so the relayed copy is bounded too). Limits are far above any legitimate use.
const MAX_FRAME_CHARS = 1_000_000;   // reject an encrypted frame larger than ~1 MB
const MAX_ARRAY = 5000;              // have / files / tombs entries
const MAX_TOMBSIGS = 500;            // signed tombstones per hello — each costs an Ed25519 verify, and the store caps at 500 anyway
const MAX_CHAT_LOG = 200;            // backfilled chat messages per frame (matches the persisted chat cap; each costs a verify)
const MAX_STR = 1024;                // ids, names, seeds
const MAX_MAGNET = 4096;             // a magnet URI
const MAX_TEXT = 2000;               // a chat message body
const MAX_SECRET = 256;              // E2E content key (hex)

function log(msg: string): void { try { ipcRenderer.send('room-log', msg); } catch { /* ignore */ } }

// A deletion proof: the tombstone's timestamp plus the author/owner Ed25519
// signature over delCanonical, so it re-verifies wherever it gossips.
type TombProof = { at: number; by: string; pub: string; sig: string };

// ── Gossip message shapes (post-decrypt) ───────────────────────────────────
type Msg =
  // `tombs` lists deleted fileIds (legacy shape, kept so older peers converge);
  // `tombsAt` adds each deletion's timestamp so a LATER explicit re-share wins
  // (revive) while anything older stays dead. `tombSigs` upgrades those to
  // AUTHENTICATED tombstones — each carries the author/owner signature so a
  // receiver re-verifies authority instead of trusting a bare fileId (an
  // unsigned tomb is otherwise a free "delete anyone's file" via the greet).
  // `cfg` is the room owner's SIGNED E2E config (see E2ECfg) — the authenticated
  // way to learn the flag+secret; the bare e2e/secret fields remain for rooms
  // whose owner runs an older build that doesn't sign.
  // `fileReacts` is a clamped summary of this member's reaction view (fileId →
  // emoji → memberIds) so late joiners converge by unioning member sets.
  | { t: 'hello'; memberId: string; name: string; avatarSeed: string; pub?: string; have: string[]; files: RoomFile[]; tombs: string[]; tombsAt?: Record<string, number>; tombSigs?: Record<string, TombProof>; roomName: string; nameAt?: number; ownerId: string; e2e: boolean; secret: string; cfg?: E2ECfg; fileReacts?: Record<string, Record<string, string[]>>; folders?: RoomFolder[]; folderTombs?: Record<string, number>; chatAt?: number }
  | { t: 'add'; file: RoomFile }
  // A folder/section was created, renamed/recolored (upsert) or deleted (del).
  // Last-writer-wins by `at`; unknown to older peers, who ignore it and keep
  // showing the flat list. Files carry their folderId; reassignment is 'assign'.
  // parentId nests the folder under a top-level section ('' / absent = root).
  // Absent-vs-present matters: an upsert WITHOUT the property (pre-2.23 client
  // editing) preserves the receiver's current placement in mergeFolderUpsert.
  | { t: 'folder'; op: 'upsert' | 'del'; id: string; name?: string; icon?: string; color?: string; parentId?: string; at: number; memberId: string }
  // A file moved between folders (or to Uncategorized when folderId is ''). LWW
  // by `at`; kept separate from 'add' because mergeFile is add-only.
  | { t: 'assign'; fileId: string; folderId: string; at: number; memberId: string }
  | { t: 'have'; memberId: string; fileId: string }
  | { t: 'ping'; memberId: string; name: string; avatarSeed: string; have: string[]; roomName: string; ownerId: string }
  // Rich profile (custom avatar image / name color / status line). A SEPARATE
  // rarely-sent Msg — never on the 15s ping (the image is ~tens of KB) — and
  // SIGNED with a per-member monotonic `at` floor, unlike hello/ping's display
  // fields: a keyholder must not be able to wear someone else's face. Unknown
  // to ≤2.22 peers, who ignore it (no default switch arm) but still relay it.
  | { t: 'profile'; memberId: string; at: number; name: string; avatarSeed: string; color: string; status: string; img: string; pub: string; sig: string }
  // Remove a shared file from the room. Signed by the actor; peers apply it only
  // when the signer is the file's author or the owner (see 'del' handler).
  | { t: 'del'; fileId: string; memberId: string; at: number; pub: string; sig: string }
  // Owner kicked a member: rotate the room to a new code. OWNER-SIGNED (peers
  // verify `by === ownerId` before rotating); relayed verbatim so multi-hop peers
  // still verify the owner, not the relayer.
  | { t: 'rekey'; newCode: string; kickedId: string; kickedName: string; by: string; pub: string; sig: string }
  // Explicit notice to the member being removed, OWNER-SIGNED so it can't be
  // spoofed to make a member think they were kicked.
  | { t: 'kicked'; targetId: string; by: string; byName: string; pub: string; sig: string }
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
  // Backfill: a UNICAST reply to a peer whose HELLO said it was behind — the
  // messages it missed while offline, each carrying its own pub/sig so they
  // re-verify independently of who re-served them. Never broadcast/relayed.
  | { t: 'chat-log'; msgs: Array<{ id: string; memberId: string; name: string; avatarSeed: string; text: string; at: number; pub: string; sig: string }> }
  // Owner renamed the room. OWNER-SIGNED + last-writer-wins by `at`, so it can
  // actually change an already-set name (the plain HELLO roomName only bootstraps
  // a placeholder). Relayed verbatim; peers verify `by === ownerId`.
  | { t: 'rename'; name: string; at: number; by: string; pub: string; sig: string }
  // Liveness: the sender is composing a chat message. Renderer-triggered, never
  // persisted; receivers stamp it and let a ~4s TTL fade it out on their own.
  | { t: 'typing'; memberId: string }
  // Toggle an emoji reaction on a shared file (REACTION_EMOJI whitelist only).
  | { t: 'react-file'; memberId: string; fileId: string; emoji: string; on: boolean }
  // Coarse download progress (0-100, PROG_STEP granularity) so peers see a
  // member's transfer move; completion is signalled by the normal 'have'.
  | { t: 'prog'; memberId: string; fileId: string; pct: number }
  // Voice presence: the sender joined/left the room's voice channel or toggled
  // mute. SIGNED so a member can't fake another's presence; relayed so late/relay-
  // only members learn who is talking.
  | { t: 'voice-state'; memberId: string; inVoice: boolean; muted: boolean; at: number; pub: string; sig: string }
  // Voice signaling (WebRTC offer/answer/ICE) from `memberId` to `to`. SIGNED so
  // signaling can't be spoofed; relayed+targeted so it reaches a peer we can only
  // reach through another member. The media itself is DTLS-SRTP peer-to-peer.
  | { t: 'voice-signal'; memberId: string; to: string; kind: 'offer' | 'answer' | 'ice'; data: any; pub: string; sig: string }
  // Screenshare presence: the sender started/stopped sharing their screen over the
  // voice mesh. A SEPARATE Msg (not a voice-state field) so the voice-state
  // canonical stays byte-identical to 2.18 — extending it would break signature
  // verification against older clients, while an unknown type is ignored (and
  // still relayed) by them. `streamId` identifies the share's MediaStream (msid)
  // for future multi-kind video; v1 receivers key on track.kind anyway.
  | { t: 'voice-share'; memberId: string; sharing: boolean; streamId: string; at: number; pub: string; sig: string };

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
  nameAt: number;                        // last-writer-wins clock for the room name (owner rename)
  code: string;
  folder: string;
  key: Buffer;
  topic: string;                         // internal signature domain separator (never announced)
  rendezvous: string;                    // public tracker rendezvous id (slow-derived from key)
  peerId: string;
  iceServers: any[];
  tracker: any;
  started: boolean;
  self: { memberId: string; name: string; avatarSeed: string; color: string; status: string; avatarImg: string; pub: string; priv: string };
  ownerId: string;                       // memberId of the owner ('' until learned)
  ownerPin: string;                      // owner memberId pinned from the invite ('' = TOFU); only this identity may be adopted as owner
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
  tombSigs: Map<string, { by: string; pub: string; sig: string }>; // deletion proofs (author/owner-signed) so a tombstone re-verifies as it gossips
  pendingTombs: Map<string, TombProof>;  // signed author-deletions for files we don't hold yet — applied if/when that file arrives (session-only, capped)
  revives: Map<string, number>;          // fileId → revAt of a VERIFIED revive we accepted; guards the revived file from re-deletion by an equal/older re-gossiped tombstone (session-only)
  autoFetch: boolean;                    // auto-download peers' files; false = wait for an explicit fetchFile
  folderFetch: Record<string, boolean>;  // per-folder auto-fetch override (local pref; absent key = inherit autoFetch)
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
  voice: VoiceSession;                    // serverless mesh voice channel (session-only)
  profiles: Map<string, { name: string; avatarSeed: string; color: string; status: string; img: string; at: number }>; // VERIFIED rich profiles; entry.at doubles as the anti-replay floor (session-only, FIFO-capped)
  profileSentTo: Set<string>;            // memberIds whose hello we've already answered with our profile broadcast
  profileAnnounce: any;                  // pending coalesced profile broadcast timer (join waves = one flood)
  profileAt: number;                     // our own last announced profile `at` (monotonic vs clock steps)
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
// VPN kill-switch: while true, NO room may bring up networking. This is the
// authoritative gate — the manager's flag is only a fast-fail hint and is
// race-prone (a 'join' can reach us AFTER 'netSuspend' via an await interleave
// or the engine-window boot ordering). The engine processes room-cmd messages
// serially, so once this is set, every later 'join' is refused until 'netResume'.
let netSuspended = false;
let wireSeq = 0;
// Global (all-rooms) voice hardware settings. The renderer owns the source of
// truth (localStorage) and re-sends on every change AND after an engine respawn
// (the manager re-asserts its cache in readied()) — this store is session-only.
let voiceSettings: VoiceSettings = defaultVoiceSettings();
// Mic level meter for the settings UI (independent of any call).
const micTester = new MicTester();
// Tell the UI to refresh its device lists when hardware comes/goes.
try {
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    try { ipcRenderer.send('room-voice-devices'); } catch { /* ignore */ }
    // A device returning lets an active call retry its preferred (previously absent) mic.
    for (const r of rooms.values()) { try { r.voice.onDevicesChanged(); } catch { /* ignore */ } }
  });
} catch { /* no mediaDevices (insecure context) — device pickers just stay empty */ }

/** Enumerate audio devices IN THIS window (deviceId is salted per-origin, so the
 *  ids the capture pipeline needs must come from here, not the main renderer).
 *  Labels can be blank until a media grant in this context — a momentary capture
 *  unlocks them. */
async function listVoiceDevices(): Promise<VoiceDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  let devs = await navigator.mediaDevices.enumerateDevices();
  const audio = (d: MediaDeviceInfo) => d.kind === 'audioinput' || d.kind === 'audiooutput';
  if (!devs.some((d) => audio(d) && d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devs = await navigator.mediaDevices.enumerateDevices();
    } catch { /* mic denied — return unlabeled ids, the UI shows generic names */ }
  }
  return devs.filter(audio).map((d) => ({ deviceId: d.deviceId, kind: d.kind as VoiceDeviceInfo['kind'], label: d.label || '' }));
}
// Debug handles for the hidden window's console/CDP — rooms and clients are
// module-scoped and otherwise unreachable when diagnosing a live install.
(globalThis as any).__rooms = rooms;
(globalThis as any).__clients = clients;

/** Room KB/s (0 = unlimited) → webtorrent limit (bytes/s, -1 = unlimited). */
function kbpsToLimit(kbps: number): number {
  return kbps > 0 ? kbps * 1024 : -1;
}

function ensureClient(room: Room): any {
  // Kill-switch chokepoint: NEVER construct a WebTorrent client while suspended,
  // or for a room already torn down. An async command that yielded before
  // netSuspend ran (e.g. an in-flight addFiles loop) still holds a live `room`
  // reference; without this, its next seed would build a fresh client keyed to a
  // deleted roomId — one that suspendAllNetworking can never find to tear down,
  // leaking on the real IP for the whole outage.
  if (netSuspended || !rooms.has(room.roomId)) throw new Error('Room networking is suspended (VPN kill-switch)');
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
    ...(room.self.color ? { color: room.self.color } : {}),
    ...(room.self.status ? { status: room.self.status } : {}),
    ...(room.self.avatarImg ? { avatarImg: room.self.avatarImg } : {}),
  };
  // A member is reached "directly" if some live wire is bound to their id;
  // otherwise we only hear them through another member forwarding (relayed).
  const directIds = new Set<string>();
  for (const w of room.wires.values()) if (w.memberId) directIds.add(w.memberId);
  const members: RoomMember[] = [self];
  for (const m of room.members.values()) {
    if (m.memberId === room.self.memberId) continue; // never show self as a remote member (self-loop guard)
    const online = now - m.lastSeen < OFFLINE_AFTER;
    // A VERIFIED rich profile ratchets over the unsigned hello/ping display
    // fields — a keyholder can spoof a ping, but not the signed profile.
    const p = room.profiles.get(m.memberId);
    members.push({
      ...m, online, isSelf: false, role: roleOf(m.memberId), muted: room.mutes.has(m.memberId), relayed: online && !directIds.has(m.memberId),
      ...(p ? {
        name: p.name || m.name,
        avatarSeed: p.avatarSeed || m.avatarSeed,
        ...(p.color ? { color: p.color } : {}),
        ...(p.status ? { status: p.status } : {}),
        ...(p.img ? { avatarImg: p.img } : {}),
      } : {}),
    });
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
    // The shareable invite pins the owner (when known) so joiners can't be tricked
    // into adopting an impostor owner; the bare `code` stays the speakable fallback.
    invite: buildInvite(room.code, room.ownerId),
    folder: room.folder,
    topicHash: room.topic,
    createdAt: 0,
    ownerId: room.ownerId,
    canManage: !!room.ownerId && room.ownerId === room.self.memberId,
    e2e: room.e2e,
    members,
    files: Array.from(room.files.values()).sort((a, b) => a.addedAt - b.addedAt),
    // Folders sorted by name (natural), then by id as a deterministic tiebreaker
    // so two same-named folders render in the SAME order on every peer (Map
    // insertion order differs per peer). The renderer groups files under them.
    folders: Array.from(room.folders.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id)),
    transfers,
    history: room.history.slice(-100),
    chat: room.chat.slice(-100),
    connected: room.started,
    peerCount: onlinePeers,
    autoFetch: room.autoFetch,
    folderFetch: { ...room.folderFetch },
    upKbps: room.upKbps,
    downKbps: room.downKbps,
    kicked: room.kicked,
    ...(room.kicked ? { kickedBy: room.kickedBy } : {}),
    typingMemberIds,
    fileReacts: reactsToRecord(room),
    memberProg,
    voice: room.voice.getState(),
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
    pub: room.self.pub, // our identity key — TOFU-bound by peers so they can verify our signed commands

    have: buildState(room).members[0].have,
    files: Array.from(room.files.values()),
    tombs: Array.from(room.tombstones.keys()), // legacy: bare deletions so ≤2.15 peers converge
    tombsAt: Object.fromEntries(room.tombstones), // legacy: timestamps let a newer re-share revive
    ...(room.tombSigs.size ? { tombSigs: tombSigsToRecord(room) } : {}), // authenticated deletions (peers verify authority before applying)
    roomName: room.name, // so a joiner (who only knows the code) learns the name
    ...(room.nameAt ? { nameAt: room.nameAt } : {}), // the name's LWW clock, so a joiner won't later reject a newer rename
    ownerId: room.ownerId, // so joiners learn who the owner is
    e2e: room.e2e, // E2E mode + content key ride the encrypted gossip channel
    secret: room.secret,
    ...(room.e2eCfg ? { cfg: room.e2eCfg } : {}), // owner-signed config, re-served for joiners
    ...(room.fileReacts.size ? { fileReacts: reactsToRecord(room) } : {}), // late joiners union this in
    ...(room.folders.size ? { folders: Array.from(room.folders.values()) } : {}), // section overlay
    ...(room.folderTombstones.size ? { folderTombs: Object.fromEntries(room.folderTombstones) } : {}), // deleted sections
    // How caught-up our chat is — a reconnecting peer replies with a chat-log of
    // anything newer that it holds, so messages said while we were offline arrive.
    ...(room.chat.length ? { chatAt: room.chat[room.chat.length - 1].at } : {}),
  };
}

/** Persist a folder create/edit to main so it (and the grouping) survives restart. */
function persistFolder(room: Room, folder: RoomFolder): void {
  try { ipcRenderer.send('room-folder-upsert', { roomId: room.roomId, folder }); } catch { /* ignore */ }
}

/** Persist a folder deletion. `removed` = the folder was actually dropped from
 *  the live set (vs. an edit-after-delete that kept it): only then may the store
 *  drop it, so a kept folder doesn't vanish on the next restart. */
function persistFolderDelete(room: Room, id: string, at: number, removed: boolean): void {
  try { ipcRenderer.send('room-folder-del', { roomId: room.roomId, id, at, removed }); } catch { /* ignore */ }
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
  // Same crypto anchor as every other signed command: the ownerId must be the
  // hash of the signing key, so a forged cfg can't poison the owner's binding
  // (which would then reject the REAL owner's config and rekeys).
  if (!idMatchesPub(cfg.ownerId, cfg.pub)) { log('e2e cfg id not derived from pub — dropped'); return false; }
  // With an invite owner pin, ONLY the pinned owner's config counts — otherwise a
  // hostile member reaching a fresh joiner first could plant a wrong E2E secret
  // (a decrypt-DoS) even though the pin blocks it from being adopted as owner.
  if (!ownerPinAllows(room, cfg.ownerId)) { log('e2e cfg owner not the pinned one — dropped'); return false; }
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
  bindIdentity(room, cfg.ownerId, cfg.pub);
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
    if (room.ownerId !== cfg.ownerId && (!room.ownerId || !room.e2eSigned) && ownerPinAllows(room, cfg.ownerId)) {
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

/**
 * Where a room file's plaintext lands on disk: <roomDir>/<folder name>/ when the
 * file is assigned to a known folder (its name reduced to one safe path segment),
 * else the room root — so the on-disk layout mirrors the folder grouping shown in
 * the UI. Creates the directory (falls back to the room root if that fails).
 * Keyed on the folder NAME for a human-readable layout; renaming a folder does
 * not move already-landed files (that reconcile is out of scope here).
 */
function folderDirFor(room: Room, file: RoomFile): string {
  const fid = file.folderId;
  if (typeof fid === 'string' && fid) {
    const folder = room.folders.get(fid);
    const seg = folder ? safeDirSegment(folder.name) : '';
    if (seg) {
      const dir = path.join(room.folder, seg);
      try { fs.mkdirSync(dir, { recursive: true }); return dir; }
      catch { /* fall through to the room root */ }
    }
  }
  return room.folder;
}

/** Decrypt one E2E file's cached ciphertext into the room folder (plaintext). */
async function decryptOne(room: Room, file: RoomFile, cipherPath: string): Promise<void> {
  if (!room.secret) return;
  const plain = path.join(folderDirFor(room, file), file.name);
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
    const plain = path.join(folderDirFor(room, file), file.name);
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
function addChat(room: Room, msg: RoomChatMessage, backfill = false): void {
  if (room.chat.some((m) => m.id === msg.id)) return;
  room.chat.push(msg);
  if (room.chat.length > 200) room.chat = room.chat.slice(-200);
  // `backfill` = historical catch-up (not live) — the main process persists + badges
  // it but does NOT fire an OS notification, so a reconnect can't detonate a toast storm.
  try { ipcRenderer.send('room-chat-add', { roomId: room.roomId, message: msg, backfill }); } catch { /* ignore */ }
  pushState(room, true);
}

/** Reply to a peer's HELLO with the chat messages it missed while offline: those
 *  newer than its `since` that we can re-serve WITH a signature (so they verify on
 *  its side). Unicast — never broadcast — so backfill goes only to who needs it. */
function sendChatBackfill(room: Room, wire: Wire, since: number): void {
  const msgs = room.chat
    .filter((m) => m.at > since && m.pub && m.sig)
    .slice(-100)
    .map((m) => ({ id: m.id, memberId: m.memberId, name: m.name, avatarSeed: m.avatarSeed, text: m.text, at: m.at, pub: m.pub as string, sig: m.sig as string }));
  if (msgs.length) sendTo(room, wire, { t: 'chat-log', msgs });
}

// ── Chat authorship (Ed25519) ────────────────────────────────────────────────
// The room key already gates WHO can read/write (you need the code). Signing adds
// WHICH member wrote each message: the signature covers the immutable fields plus
// the room topic (so a signed message can't be replayed into another room), and
// each memberId is trust-on-first-use bound to one public key — so a keyholder
// cannot post under someone else's identity.

/* ── Authenticated commands (chat + the authority commands del/rekey/kicked) ──
 * Every one is Ed25519-signed by its actor's identity key and bound to the room
 * (via `topic`) and its type, so a signature can't be replayed into another room
 * or as another command. Encryption proves only MEMBERSHIP (everyone holds the
 * key) — these signatures prove AUTHORSHIP, which is what authority checks need.
 */

/** Sign canonical bytes with OUR identity key (base64), or '' on failure. */
function signBytes(room: Room, canonical: Buffer): string {
  try { return crypto.sign(null, canonical, crypto.createPrivateKey(room.self.priv)).toString('base64'); }
  catch (e) { log('sign failed: ' + String(e)); return ''; }
}

/** Bind memberId→pub, but ONLY if the id is the hash of that pub (deriveMemberId).
 *  This is the anchor of the whole authority model: a member cannot bind (and so
 *  cannot later verify as) any id except the one its own key hashes to — so it can
 *  neither impersonate the owner nor poison another member's binding. First
 *  binding wins; a later mismatch is rejected at verify time. */
function bindIdentity(room: Room, memberId: string, pub?: string): void {
  if (!memberId || !pub || room.identities.has(memberId)) return;
  if (deriveMemberId(pub) !== memberId) { log('id/pub mismatch for ' + memberId + ' — not bound'); return; }
  room.identities.set(memberId, pub);
  try { ipcRenderer.send('room-identity-add', { roomId: room.roomId, memberId, pub }); } catch { /* ignore */ }
}

/** True when `pub` is the key `memberId` was derived from — the cryptographic
 *  proof that whoever holds this key legitimately owns this id. */
function idMatchesPub(memberId: string, pub: string): boolean {
  return !!memberId && !!pub && deriveMemberId(pub) === memberId;
}

/**
 * Verify `sig` over `canonical` as coming from `memberId`, enforcing the
 * memberId→pubkey TOFU binding: valid only if the signature checks out AND `pub`
 * matches the one already bound to that memberId (binding it on first sight).
 * Any mismatch is an impersonation attempt and is dropped.
 */
function verifySignedBy(room: Room, memberId: string, pub: string, sig: string, canonical: Buffer): boolean {
  if (!memberId || !pub || !sig) return false;
  if (!idMatchesPub(memberId, pub)) { log('id not derived from pub for ' + memberId + ' — dropped'); return false; } // the crypto anchor: pub must hash to the claimed id
  const bound = room.identities.get(memberId);
  if (bound && bound !== pub) { log('identity mismatch for ' + memberId + ' — dropped'); return false; }
  let ok = false;
  try { ok = crypto.verify(null, canonical, crypto.createPublicKey(pub), Buffer.from(sig, 'base64')); }
  catch (e) { log('verify error: ' + String(e)); return false; }
  if (!ok) { log('bad signature from ' + memberId + ' — dropped'); return false; }
  bindIdentity(room, memberId, pub);
  return true;
}

/** Stable bytes to sign/verify for a chat message. */
function chatCanonical(topic: string, m: { id: string; at: number; memberId: string; text: string }): Buffer {
  return Buffer.from(JSON.stringify([topic, m.id, m.at, m.memberId, m.text]), 'utf8');
}
function signChat(room: Room, m: { id: string; at: number; memberId: string; text: string }): string {
  return signBytes(room, chatCanonical(room.topic, m));
}
function verifyChat(room: Room, msg: { id: string; at: number; memberId: string; text: string; pub: string; sig: string }): boolean {
  return verifySignedBy(room, msg.memberId, msg.pub, msg.sig, chatCanonical(room.topic, msg));
}

/* Authority commands — the type tag in each canonical is domain separation so a
 * signature for one can never be replayed as another. */
function delCanonical(topic: string, m: { fileId: string; memberId: string; at: number }): Buffer {
  return Buffer.from(JSON.stringify(['del', topic, m.fileId, m.memberId, m.at]), 'utf8');
}
function rekeyCanonical(topic: string, m: { newCode: string; kickedId: string; by: string }): Buffer {
  return Buffer.from(JSON.stringify(['rekey', topic, m.newCode, m.kickedId, m.by]), 'utf8');
}
function kickedCanonical(topic: string, m: { targetId: string; by: string }): Buffer {
  return Buffer.from(JSON.stringify(['kicked', topic, m.targetId, m.by]), 'utf8');
}
/** Bytes the owner signs to rename the room (owner-gated + last-writer-wins). */
function renameCanonical(topic: string, m: { name: string; at: number; by: string }): Buffer {
  return Buffer.from(JSON.stringify(['rename', topic, m.name, m.at, m.by]), 'utf8');
}
/** Bytes a member signs over a voice presence announcement. `at` is bound in so a
 *  replayed (older) presence can't resurrect a departed member or flip their mute. */
function voiceStateCanonical(topic: string, m: { memberId: string; inVoice: boolean; muted: boolean; at: number }): Buffer {
  return Buffer.from(JSON.stringify(['voice-state', topic, m.memberId, m.at, m.inVoice, m.muted]), 'utf8');
}
/** Bytes a member signs over a voice signaling blob (offer/answer/ice). */
function voiceSignalCanonical(topic: string, m: { memberId: string; to: string; kind: string; data: unknown }): Buffer {
  return Buffer.from(JSON.stringify(['voice-signal', topic, m.memberId, m.to, m.kind, m.data]), 'utf8');
}
/** Bytes a member signs over a screenshare presence announcement (same `at`
 *  anti-replay discipline as voice-state; field order mirrors it). */
function voiceShareCanonical(topic: string, m: { memberId: string; sharing: boolean; streamId: string; at: number }): Buffer {
  return Buffer.from(JSON.stringify(['voice-share', topic, m.memberId, m.at, m.sharing, m.streamId]), 'utf8');
}
/** Bytes a member signs over their rich profile (avatar image / color / status).
 *  The image is included directly — Ed25519 signs arbitrary length, and binding
 *  it here means nobody can graft their status onto someone else's face. */
function profileCanonical(topic: string, m: { memberId: string; at: number; name: string; avatarSeed: string; color: string; status: string; img: string }): Buffer {
  return Buffer.from(JSON.stringify(['profile', topic, m.memberId, m.at, m.name, m.avatarSeed, m.color, m.status, m.img]), 'utf8');
}

/** Our signed rich-profile announcement. An EMPTY profile still announces —
 *  a peer whose session cache holds our old avatar/status must be able to
 *  learn we cleared it (the frame is ~300 bytes then, cheap). `at` is
 *  monotonic against our own previous announcement so a backward clock step
 *  can't make every later update invisible to the peers' floor. */
function selfProfileMsg(room: Room): Msg | null {
  const s = room.self;
  const at = Math.max(Date.now(), room.profileAt + 1);
  room.profileAt = at;
  // Keep the signed fields inside the receiver-side gossip clamps (MAX_STR):
  // a longer value would be truncated there and the signature would die.
  // img is always '' — custom avatar images were removed; only the identicon
  // seed / color / status ride the profile now.
  const body = { memberId: s.memberId, at, name: (s.name || 'You').slice(0, 1024), avatarSeed: s.avatarSeed.slice(0, 1024), color: s.color, status: s.status, img: '' };
  const sig = signBytes(room, profileCanonical(room.topic, body));
  if (!sig) return null;
  return { t: 'profile', ...body, pub: s.pub, sig };
}

/** Coalesced profile broadcast: a join wave produces ONE flood ~3s later, not
 *  one ~45KB frame per received hello. */
function scheduleProfileAnnounce(room: Room): void {
  if (room.profileAnnounce) return;
  room.profileAnnounce = setTimeout(() => {
    room.profileAnnounce = null;
    const pm = selfProfileMsg(room);
    if (pm) broadcast(room, pm);
  }, 3000);
}

/** Wire a room's VoiceSession to the room's signed, encrypted gossip. Presence and
 *  signaling are Ed25519-signed (so a member can't spoof another's voice), ride the
 *  relay flood (so relay-only members are reachable), and any voice change re-pushes
 *  room state to the UI. */
function createVoiceSession(room: Room): VoiceSession {
  const adapter: VoiceAdapter = {
    selfId: room.self.memberId,
    iceServers: room.iceServers as RTCIceServer[],
    sendSignal(to: string, kind: SignalKind, data: unknown): void {
      const sig = signBytes(room, voiceSignalCanonical(room.topic, { memberId: room.self.memberId, to, kind, data }));
      broadcast(room, { t: 'voice-signal', memberId: room.self.memberId, to, kind, data, pub: room.self.pub, sig });
    },
    announce(inVoice: boolean, muted: boolean, at: number): void {
      const sig = signBytes(room, voiceStateCanonical(room.topic, { memberId: room.self.memberId, inVoice, muted, at }));
      broadcast(room, { t: 'voice-state', memberId: room.self.memberId, inVoice, muted, at, pub: room.self.pub, sig });
    },
    announceShare(sharing: boolean, streamId: string, at: number): void {
      const sig = signBytes(room, voiceShareCanonical(room.topic, { memberId: room.self.memberId, sharing, streamId, at }));
      broadcast(room, { t: 'voice-share', memberId: room.self.memberId, sharing, streamId, at, pub: room.self.pub, sig });
    },
    sendLoopback(memberId: string, kind: LoopbackKind, data?: unknown): void {
      // Screen-watch loopback signaling → main process → visible renderer.
      try { ipcRenderer.send('room-screen-signal', { roomId: room.roomId, memberId, kind, data }); } catch { /* ignore */ }
    },
    warn(msg: string): void {
      // Transient user-facing warning (e.g. a mid-call mic fallback) → renderer toast.
      try { ipcRenderer.send('room-voice-warn', { msg }); } catch { /* ignore */ }
    },
    onChange(): void { pushState(room, true); },
    log,
  };
  return new VoiceSession(adapter, undefined, () => voiceSettings);
}

/** Capture a screen/window in THIS (hidden, secure-context) window via the legacy
 *  chromeMediaSource path — unlike getDisplayMedia it needs NO user gesture, so it
 *  works from the engine window; the permission handlers already allow 'media'.
 *  `sourceId` comes from desktopCapturer.getSources in the main process. */
async function captureScreen(sourceId: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Screen capture unavailable (the room engine is not a secure context).');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false, // v1 is video-only (system-audio loopback would echo the call back)
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: String(sourceId),
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 15,
      },
    },
  } as any);
}

/** Bytes an owner/deleter signs to authorize lifting an authenticated tombstone.
 *  Bound to `tombAt` — the deletion timestamp being lifted, a value every peer
 *  agrees on (it rode the signed `del`) — NOT the reviving add's addedAt, which
 *  each receiver clamps to its own clock and so can't be signed over reliably. */
function reviveCanonical(topic: string, m: { fileId: string; tombAt: number; by: string }): Buffer {
  return Buffer.from(JSON.stringify(['revive', topic, m.fileId, m.tombAt, m.by]), 'utf8');
}

/** Serialize our held deletion proofs (fileId → {at, by, pub, sig}) for a hello,
 *  pairing each proof with its winning timestamp from the tombstone map. */
function tombSigsToRecord(room: Room): Record<string, TombProof> {
  const out: Record<string, TombProof> = {};
  for (const [fileId, p] of room.tombSigs) {
    const at = room.tombstones.get(fileId);
    if (at === undefined) continue; // proof without a live tombstone (revived) — skip
    out[fileId] = { at, by: p.by, pub: p.pub, sig: p.sig };
  }
  return out;
}

/** With an owner PIN from the invite, ONLY the pinned identity may be adopted as
 *  owner — so a member can't self-declare owner to a fresh joiner. No pin → TOFU. */
function ownerPinAllows(room: Room, id?: string): boolean {
  return !room.ownerPin || id === room.ownerPin;
}

/** Learn who the room owner is from a peer (joiners start not knowing). First
 *  claim wins (gated by the invite's owner pin, if any); persisted so the role
 *  survives restart. */
function maybeAdoptOwner(room: Room, incoming?: string): void {
  if (!incoming || room.ownerId || !ownerPinAllows(room, incoming)) return;
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
  // fileId is an infoHash by construction — reject anything with whitespace or
  // control chars (a crafted id with an embedded newline would corrupt multi-id
  // encodings like the renderer's drag payload).
  if (!/^\S+$/.test(fileId)) return null;
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
    // Never from the future: a hostile far-future addedAt would otherwise outrank
    // (and permanently defeat) every later deletion. Falls back to now if absent.
    addedAt: Math.min(Number.isFinite(f.addedAt) ? f.addedAt : Date.now(), Date.now()),
    ...(f.enc ? { enc: true } : {}),
    // Revive authorization (only on an add that lifts an authenticated tombstone).
    ...(f.revBy && f.revPub && f.revSig && Number.isFinite(f.revAt) ? { revBy: clampStr(f.revBy, MAX_STR), revPub: clampStr(f.revPub, MAX_STR * 2), revAt: Number(f.revAt), revSig: clampStr(f.revSig, MAX_STR) } : {}),
    // Folder assignment MUST be copied explicitly or it is silently stripped on
    // receive — the same trap the enc/infoHash fields document above. folderAt is
    // clamped so a future timestamp can't lock the assignment (see clampAt).
    ...(typeof f.folderId === 'string' && f.folderId ? { folderId: clampStr(f.folderId, MAX_STR) } : {}),
    ...(clampAt(f.folderAt) ? { folderAt: clampAt(f.folderAt) } : {}),
  } as RoomFile;
}

/** A wall-clock `at` from a peer, never accepted from the future (a skewed or
 *  hostile clock would otherwise pin a folder/assignment forever — LWW can't
 *  beat a timestamp past `now`). Clamps to this receiver's clock. */
function clampAt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(n, Date.now()) : 0;
}

/** Coerce a peer-supplied folder entry to a sane shape, or null if unusable. */
function clampFolder(f: any): RoomFolder | null {
  if (!f || typeof f !== 'object') return null;
  const id = clampStr(f.id, MAX_STR);
  if (!id || !Number.isFinite(Number(f.at))) return null;
  // Icon is validated against the known set — an unknown name would crash <Icon>
  // on the recipient. Name falls back so an empty one still renders.
  const out: RoomFolder = { id, name: clampStr(f.name, MAX_STR) || 'Folder', icon: sanitizeFolderIcon(f.icon), color: clampStr(f.color, 64), at: clampAt(f.at) };
  // parentId is carried ONLY when the sender had the property — absent means
  // "hierarchy-unaware author" and mergeFolderUpsert preserves the current
  // placement. Assigning unconditionally would create the own-property and turn
  // every legacy entry into an explicit move-to-root. '' (explicit root) is
  // kept as '' so it survives every JSON boundary.
  if (Object.prototype.hasOwnProperty.call(f, 'parentId')) out.parentId = typeof f.parentId === 'string' ? clampStr(f.parentId, MAX_STR) : '';
  return out;
}

/** Bound a decoded gossip message's strings/arrays in place (anti-DoS). */
function clampGossip(msg: any): void {
  if ('memberId' in msg) msg.memberId = clampStr(msg.memberId, MAX_STR);
  if ('name' in msg) msg.name = clampStr(msg.name, MAX_STR);
  if ('roomName' in msg) msg.roomName = clampStr(msg.roomName, MAX_STR);
  if ('avatarSeed' in msg) msg.avatarSeed = clampStr(msg.avatarSeed, MAX_STR);
  if ('ownerId' in msg) msg.ownerId = clampStr(msg.ownerId, MAX_STR);
  if ('to' in msg) msg.to = clampStr(msg.to, MAX_STR);       // voice-signal target
  if ('kind' in msg) msg.kind = clampStr(msg.kind, 16);      // voice-signal kind (offer/answer/ice)
  if ('streamId' in msg) msg.streamId = clampStr(msg.streamId, MAX_STR); // voice-share stream id (msid)
  if ('sharing' in msg) msg.sharing = msg.sharing === true;
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
  if ('tombSigs' in msg) {
    const out: Record<string, TombProof> = {};
    if (msg.tombSigs && typeof msg.tombSigs === 'object' && !Array.isArray(msg.tombSigs)) {
      for (const [k, v] of Object.entries(msg.tombSigs).slice(0, MAX_TOMBSIGS)) {
        const p = v as any;
        const at = Number(p?.at);
        if (p && typeof p === 'object' && Number.isFinite(at)) {
          out[clampStr(k, MAX_STR)] = { at, by: clampStr(p.by, MAX_STR), pub: clampStr(p.pub, MAX_STR * 2), sig: clampStr(p.sig, MAX_STR) };
        }
      }
    }
    msg.tombSigs = out;
  }
  if (Array.isArray(msg.files)) {
    // Dedupe by fileId: a hello never needs the same file twice, and duplicates
    // would let one frame trigger repeated per-file work (e.g. revive verifies).
    const seen = new Set<string>();
    msg.files = msg.files.slice(0, MAX_ARRAY).map(clampFile).filter((f: RoomFile | null) => {
      if (!f || seen.has(f.fileId)) return false;
      seen.add(f.fileId);
      return true;
    });
  }
  if ('file' in msg) msg.file = clampFile(msg.file);
  // Folder gossip fields (folder/assign messages + folders/folderTombs in hello).
  if ('id' in msg) msg.id = clampStr(msg.id, MAX_STR);
  if ('op' in msg) msg.op = msg.op === 'del' ? 'del' : 'upsert';
  if ('icon' in msg) msg.icon = sanitizeFolderIcon(msg.icon);
  if ('color' in msg) msg.color = clampStr(msg.color, 64);
  if ('folderId' in msg) msg.folderId = clampStr(msg.folderId, MAX_STR);
  if ('parentId' in msg) msg.parentId = clampStr(msg.parentId, MAX_STR);
  // Rich-profile fields (anti-DoS bounds; scoped to the type so the keys can't
  // collide with other messages). An out-of-bounds value breaks the sender's
  // signature and the message dies at verify — exactly like oversized chat text;
  // legit senders stay in range (the IPC boundary enforces the same limits).
  if (msg.t === 'profile') {
    msg.status = clampStr(msg.status, PROFILE_STATUS_MAX);
    msg.color = typeof msg.color === 'string' && (msg.color === '' || PROFILE_COLOR_RE.test(msg.color)) ? msg.color : '';
    // Full shared validation incl. container-header dimension sniffing — a
    // pixel-bomb PNG dies here (and its now-mangled signature at verify).
    msg.img = sanitizeProfileImg(msg.img) ?? '';
  }
  // 'at' on folder/assign messages: never accept a future timestamp (see clampAt).
  if (msg.t === 'folder' || msg.t === 'assign') msg.at = clampAt(msg.at);
  if (Array.isArray(msg.folders)) msg.folders = msg.folders.slice(0, MAX_ARRAY).map(clampFolder).filter(Boolean);
  if ('folderTombs' in msg) {
    const out: Record<string, number> = {};
    if (msg.folderTombs && typeof msg.folderTombs === 'object' && !Array.isArray(msg.folderTombs)) {
      for (const [k, v] of Object.entries(msg.folderTombs).slice(0, MAX_ARRAY)) {
        const at = clampAt(v);
        if (at) out[clampStr(k, MAX_STR)] = at;
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
      // A direct hello on a wire not yet bound to a member = a fresh connection
      // (their FIRST greet this link) — they may have restarted and lost their
      // session-only profile cache, so the announce gate below must not skip them.
      const freshWire = direct && !wire.memberId;
      if (direct) wire.memberId = msg.memberId;
      bindIdentity(room, msg.memberId, msg.pub); // TOFU their identity key from the greet, so we can verify their signed commands
      const isNew = !room.members.has(msg.memberId);
      const m = touchMember(room, msg.memberId, msg.name, msg.avatarSeed);
      m.have = Array.from(new Set(msg.have || []));
      maybeAdoptRoomName(room, msg.roomName);
      // Track the name's LWW clock once we're in sync on the name, so a later
      // owner rename (at > nameAt) is accepted and a stale one is rejected. HELLO
      // is UNSIGNED, so clamp to our clock — an unbounded nameAt (e.g. 2^53) would
      // otherwise wedge the LWW: the owner's `nameAt + 1` stops incrementing at
      // that float magnitude and every signed rename is then rejected as not-newer.
      if (room.name === msg.roomName) {
        const incoming = Math.min(Number(msg.nameAt) || 0, Date.now());
        if (incoming > room.nameAt) room.nameAt = incoming;
      }
      maybeAdoptOwner(room, msg.ownerId);
      maybeAdoptE2E(room, msg.e2e, msg.secret, msg.cfg);
      if (isNew) logEvent(room, { type: 'joined', actorId: msg.memberId, actorName: msg.name || '?' });
      // A greeting from someone we haven't announced our rich profile to yet —
      // or a known member greeting over a FRESH wire (likely restarted, cache
      // gone): schedule ONE coalesced broadcast (floods, so relay-only joiners
      // get it too).
      if (freshWire || !room.profileSentTo.has(msg.memberId)) {
        room.profileSentTo.add(msg.memberId);
        scheduleProfileAnnounce(room);
      }
      // Re-announce voice presence on EVERY hello (not just a new member's): a
      // hello doubles as a "who's in voice?" solicit — e.g. a peer that just
      // un-muted us locally greets to re-learn the voice state it was dropping.
      room.voice.reannounce();
      // Merge the peer's files first so an authenticated tombstone below can check
      // authorship (addedBy) against the file, then re-suppress it. `tombSigs` are
      // AUTHENTICATED deletions — each re-verifies (owner/author + signature)
      // before it applies. Bare `tombs`/`tombsAt` from ≤2.15 peers are NOT trusted
      // here (an unsigned tomb would be a free "delete anyone's file" over hello);
      // they still ride our own hello outward so old peers keep converging.
      for (const f of msg.files || []) mergeFile(room, f);
      for (const [id, p] of Object.entries(msg.tombSigs || {})) acceptRemoteTomb(room, id, Number(p?.at), String(p?.by || ''), String(p?.pub || ''), String(p?.sig || ''));
      // Reconcile the folder ASSIGNMENT of files we ALREADY hold: mergeFile is
      // add-only, so a reassignment made while we were offline rides the peer's
      // HELLO files but would otherwise be dropped. LWW by folderAt.
      for (const f of msg.files || []) {
        if (f.folderAt === undefined) continue;
        const existing = room.files.get(f.fileId);
        if (existing && existing !== f && applyAssignment(existing, f.folderId, f.folderAt)) {
          const tr = room.transfers.get(f.fileId);
          persistManifest(room, existing, tr?.localPath, tr?.cipherPath);
        }
      }
      // Folder overlay convergence: apply the peer's deletions first (so a stale
      // folder in their list can't override our newer delete), then their upserts.
      let folderPlaneChanged = false;
      for (const [id, at] of Object.entries(msg.folderTombs || {})) {
        if (applyFolderDelete(room.folders, room.folderTombstones, id, Number(at) || 0)) {
          persistFolderDelete(room, id, Number(at) || 0, !room.folders.has(id));
          // Same as the live 'folder' del path: a lingering per-folder override
          // would silently keep gating the (now-dangling) files — and, via the
          // section hop, whole subtrees — forever.
          dropFolderFetch(room, id);
          folderPlaneChanged = true;
        }
      }
      for (const f of msg.folders || []) {
        if (mergeFolderUpsert(room.folders, room.folderTombstones, f)) {
          // Persist what the merge STORED — preserve-on-absent means it can
          // differ from the incoming record (the live 'folder' handler does the
          // same); persisting `f` would drop a preserved parentId on disk.
          persistFolder(room, room.folders.get(f.id) ?? f);
          folderPlaneChanged = true;
        }
      }
      // The hello merged files BEFORE folders (tombstone authorship needs the
      // files first), so any file gated at merge time by a then-unknown folder
      // — or flipped by a delete/reparent above — re-checks now.
      if (folderPlaneChanged) recheckAutoFetch(room);
      // Union the peer's reaction view into ours (late-join convergence).
      if (mergeReacts(room, msg.fileReacts)) persistReacts(room);
      // Chat backfill: if this peer is behind our chat (or hasn't said how caught-up
      // it is), UNICAST it the messages it's missing — only ones we can re-serve with
      // a signature, so they self-authenticate on its side. Only on a DIRECT hello,
      // so `wire` really is that peer (relayed hellos don't identify the wire).
      if (direct) sendChatBackfill(room, wire, Number(msg.chatAt) || 0);
      pushState(room);
      break;
    }
    case 'chat-log': {
      // Backfilled messages a peer re-served us. Each self-authenticates (verifyChat
      // over its own pub/sig), and addChat dedupes by id — so overlapping backfill
      // from multiple peers is harmless. Capped, and dedup/future/mute checks run
      // BEFORE the expensive verify so a stuffed frame can't force N signature checks.
      const list = Array.isArray(msg.msgs) ? msg.msgs.slice(0, MAX_CHAT_LOG) : [];
      for (const c of list) {
        const text = String(c?.text || '').slice(0, 2000);
        const memberId = String(c?.memberId || '');
        const id = String(c?.id || '');
        const at = Number(c?.at) || 0;
        if (!id || !text || !memberId || room.mutes.has(memberId)) continue;
        if (at > Date.now() + 60_000) continue;             // no future-dated chat (would sit unread forever)
        if (room.chat.some((m) => m.id === id)) continue;   // already have it — skip the verify
        const cm = { id, at, memberId, text, pub: String(c.pub || ''), sig: String(c.sig || '') };
        if (!verifyChat(room, cm)) continue;
        addChat(room, { id, at: at || Date.now(), memberId, name: String(c.name || '?'), avatarSeed: String(c.avatarSeed || memberId), text, pub: cm.pub, sig: cm.sig }, true /* backfill — no toast */);
      }
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
      if (room.mutes.has(msg.memberId)) break; // a muted member can't reshape our folders
      if (msg.op === 'del') {
        if (applyFolderDelete(room.folders, room.folderTombstones, msg.id, msg.at)) {
          persistFolderDelete(room, msg.id, msg.at, !room.folders.has(msg.id));
          // Its files fall back to Uncategorized — a lingering per-folder
          // auto-fetch override would silently keep gating them forever.
          dropFolderFetch(room, msg.id);
          // Files that fell out of the deleted folder/section (or its children)
          // now resolve against the room toggle — pull newly effective-ON ones.
          recheckAutoFetch(room);
          pushState(room);
        }
      } else {
        // clampGossip already sanitized name/icon/color/parentId/at.
        const folder: RoomFolder = { id: msg.id, name: msg.name || 'Folder', icon: msg.icon || 'folder', color: msg.color || '', at: msg.at };
        if (Object.prototype.hasOwnProperty.call(msg, 'parentId')) folder.parentId = msg.parentId || '';
        if (mergeFolderUpsert(room.folders, room.folderTombstones, folder)) {
          // Persist what the merge actually stored — preserve-absent semantics
          // mean it can differ from our local rebuild (parentId kept from the
          // previous record when a hierarchy-unaware peer edited the folder).
          const merged = room.folders.get(msg.id);
          persistFolder(room, merged ?? folder);
          // A folder record arriving late (files referenced it before it
          // existed) or a reparent under/out of an overridden section can flip
          // its files' EFFECTIVE auto-fetch — catch up the ones that turned on.
          recheckAutoFetch(room, (f) => f.folderId === msg.id);
          pushState(room);
        }
      }
      break;
    }
    case 'assign': {
      if (room.mutes.has(msg.memberId)) break; // muted member can't move our files
      const file = room.files.get(msg.fileId);
      if (file && applyAssignment(file, msg.folderId, msg.at)) {
        const tr = room.transfers.get(msg.fileId);
        persistManifest(room, file, tr?.localPath, tr?.cipherPath); // re-persist the whole file with its new folderId
        // A live 'add' races its 'assign' (the folderId lands here, after the merge
        // decided against fetching) — re-check the per-folder override now that the
        // file's real folder is known. Landing in an auto-ON folder starts the pull.
        if (!tr?.haveLocally && effectiveAutoFetch(room, file.folderId) && (!tr || tr.status === 'queued' || !tr.status)) {
          ensureLocal(room, file);
        }
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
      // Authenticate + authorize (owner or the file's author) before applying;
      // an unsigned/old-format or unauthorized del is dropped, not a local hide.
      if (acceptRemoteTomb(room, msg.fileId, Number(msg.at), msg.memberId, msg.pub, msg.sig)) pushState(room, true);
      break;
    }
    case 'rekey': {
      if (msg.kickedId === room.self.memberId) break; // we're the one being kicked — never adopt
      if (room.code === msg.newCode) break;            // already applied
      // Authority: ONLY the owner may rotate the room. Encryption proves only that
      // the sender holds the key (every member does) — verify the OWNER's actual
      // signature, or a member could rotate the room onto a code they chose.
      if (!room.ownerId || msg.by !== room.ownerId) { log('rekey from non-owner ' + msg.by + ' — dropped'); break; }
      if (!verifySignedBy(room, msg.by, msg.pub, msg.sig, rekeyCanonical(room.topic, { newCode: msg.newCode, kickedId: msg.kickedId, by: msg.by }))) break;
      const oldKey = room.key;
      // Relay verbatim (still under the old key) so multi-hop rooms converge; the
      // owner's signature rides along so downstream peers verify the owner too.
      sendRekey(room, oldKey, msg, msg.kickedId, wire.id);
      applyLocalRekey(room, msg.newCode, msg.kickedId, msg.kickedName);
      break;
    }
    case 'kicked': {
      // Only act if WE are the target AND it is genuinely OWNER-signed — a mere
      // room member could otherwise spoof a "you were removed" notice.
      if (msg.targetId !== room.self.memberId) break;
      if (!room.ownerId || msg.by !== room.ownerId) break;
      if (!verifySignedBy(room, msg.by, msg.pub, msg.sig, kickedCanonical(room.topic, { targetId: msg.targetId, by: msg.by }))) break;
      markKicked(room, msg.byName || '?');
      break;
    }
    case 'rename': {
      // Owner-only, last-writer-wins by `at`. Encryption proves only membership, so
      // an unsigned rename would be a free "rename anyone's room" — verify the owner.
      const at = Number(msg.at) || 0;
      const name = String(msg.name || '').slice(0, MAX_STR).trim();
      if (!name || at <= room.nameAt) break;                       // empty or not newer — ignore
      if (at > Date.now() + 60_000) break;                         // no future-dated rename (would wedge the LWW clock)
      if (!room.ownerId || msg.by !== room.ownerId) break;         // only the owner renames
      if (!verifySignedBy(room, msg.by, msg.pub, msg.sig, renameCanonical(room.topic, { name, at, by: msg.by }))) break;
      room.name = name;
      room.nameAt = at;
      try { ipcRenderer.send('room-name', { roomId: room.roomId, name, at }); } catch { /* ignore */ }
      pushState(room, true);
      break;
    }
    case 'bye': {
      // A member left voluntarily — drop them immediately (no offline ghost).
      const m = room.members.get(msg.memberId);
      if (m) {
        room.members.delete(msg.memberId);
        logEvent(room, { type: 'left', actorId: msg.memberId, actorName: m.name || '?' });
      }
      // Their session-only liveness goes with them. Forget that we announced
      // our rich profile too — their cache is session-only, so a rejoin must
      // get a fresh announce or they'd see us profileless until we change it.
      room.profileSentTo.delete(msg.memberId);
      room.memberProg.delete(msg.memberId);
      delete room.typing[msg.memberId];
      room.voice.onMemberGone(msg.memberId); // tear down any voice connection to them
      for (const w of Array.from(room.wires.values())) {
        if (w.memberId === msg.memberId) { try { w.peer.destroy(); } catch { /* ignore */ } room.wires.delete(w.id); }
      }
      pushState(room, true);
      break;
    }
    case 'voice-state': {
      if (room.mutes.has(msg.memberId)) break; // locally-muted member — ignore their voice too
      const at = Number(msg.at);
      if (!Number.isFinite(at) || at > Date.now() + 60_000) break; // reject unstamped / far-future presence
      if (!verifySignedBy(room, msg.memberId, msg.pub, msg.sig, voiceStateCanonical(room.topic, { memberId: msg.memberId, inVoice: msg.inVoice, muted: msg.muted, at }))) break;
      room.voice.onPeerState(msg.memberId, !!msg.inVoice, !!msg.muted, at);
      break;
    }
    case 'voice-signal': {
      if (msg.to !== room.self.memberId) break; // not addressed to us (already relayed above)
      if (room.mutes.has(msg.memberId)) break;
      if (msg.kind !== 'offer' && msg.kind !== 'answer' && msg.kind !== 'ice') break;
      if (!verifySignedBy(room, msg.memberId, msg.pub, msg.sig, voiceSignalCanonical(room.topic, { memberId: msg.memberId, to: msg.to, kind: msg.kind, data: msg.data }))) break;
      room.voice.onSignal(msg.memberId, msg.kind as SignalKind, msg.data);
      break;
    }
    case 'voice-share': {
      if (room.mutes.has(msg.memberId)) break; // locally-muted member — ignore their share too
      const at = Number(msg.at);
      if (!Number.isFinite(at) || at > Date.now() + 60_000) break; // reject unstamped / far-future
      if (!verifySignedBy(room, msg.memberId, msg.pub, msg.sig, voiceShareCanonical(room.topic, { memberId: msg.memberId, sharing: msg.sharing, streamId: msg.streamId, at }))) break;
      room.voice.onPeerShare(msg.memberId, !!msg.sharing, String(msg.streamId || ''), at);
      break;
    }
    case 'profile': {
      if (room.mutes.has(msg.memberId)) break; // a muted member's face/status stays hidden too
      const at = Number(msg.at);
      if (!Number.isFinite(at) || at > Date.now() + 60_000) break; // unstamped / far-future
      // The stored entry's `at` IS the per-member monotonic floor (own map — the
      // voice-share lesson: never share another message type's floor).
      const prev = room.profiles.get(msg.memberId);
      if (prev && prev.at >= at) break;
      const body = { memberId: msg.memberId, at, name: String(msg.name || ''), avatarSeed: String(msg.avatarSeed || ''), color: String(msg.color || ''), status: String(msg.status || ''), img: String(msg.img || '') };
      if (!verifySignedBy(room, msg.memberId, msg.pub, msg.sig, profileCanonical(room.topic, body))) break;
      // Cap: a hostile keyholder minting identities must not grow this map of
      // ~45KB entries unbounded. Evict a STRANGER (id not in the roster) first
      // so a minted-identity flood can't wipe real members' cached profiles —
      // only if every entry belongs to a rostered member does the oldest one go.
      if (!prev && room.profiles.size >= 128) {
        let evict: string | undefined;
        for (const id of room.profiles.keys()) { if (!room.members.has(id)) { evict = id; break; } }
        evict = evict ?? room.profiles.keys().next().value;
        if (evict !== undefined) room.profiles.delete(evict);
      }
      // The signature covers the RAW fields; what we STORE is display-sanitized
      // (control chars / bidi overrides stripped from the status) so a hostile
      // member can't smuggle render-order tricks past the verified envelope.
      // img is dropped unconditionally — custom avatar images were removed, so
      // even a valid one from an older-build peer never renders (and never grows
      // the profiles map).
      room.profiles.set(msg.memberId, { name: body.name, avatarSeed: body.avatarSeed, color: body.color, status: sanitizeProfileStatus(body.status), img: '', at });
      touchMember(room, msg.memberId, body.name, body.avatarSeed);
      pushState(room);
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
      if ((Number(msg.at) || 0) > Date.now() + 60_000) break; // no future-dated chat (would sit unread forever + skew ordering)
      // Reject unsigned, badly-signed, or impersonating messages outright.
      if (!verifyChat(room, { id: String(msg.id), at: Number(msg.at) || 0, memberId: msg.memberId, text, pub: msg.pub, sig: msg.sig })) break;
      // Keep the sender fresh in the member list so a chatter never looks offline.
      const m = room.members.get(msg.memberId);
      if (m) m.lastSeen = Date.now();
      // Keep pub/sig so this message can be re-served as backfill and still verify.
      addChat(room, { id: String(msg.id), at: Number(msg.at) || Date.now(), memberId: msg.memberId, name: msg.name || '?', avatarSeed: msg.avatarSeed || msg.memberId, text, pub: msg.pub, sig: msg.sig });
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

/** Record a VERIFIED revive (in memory + persisted) so its re-deletion guard
 *  survives restart. newest-revAt wins. */
function recordRevive(room: Room, fileId: string, revAt: number): void {
  revAt = Math.min(revAt, Date.now() + 60_000); // defense in depth: the guard must never hold a future value (would block real deletions)
  const cur = room.revives.get(fileId);
  if (cur !== undefined && cur >= revAt) return;
  room.revives.set(fileId, revAt);
  try { ipcRenderer.send('room-revive', { roomId: room.roomId, fileId, revAt }); } catch { /* ignore */ }
}

/** Lift a tombstone here and in the persisted store (the file was revived). */
function clearTombstone(room: Room, fileId: string): void {
  const had = room.tombstones.delete(fileId);
  room.tombSigs.delete(fileId); // the deletion proof is stale once revived
  if (!had) return;
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
  // A revive we VERIFIED (room.revives, never the file's untrusted revAt field)
  // that lifts a deletion at-or-after this one outranks it, independent of clock
  // skew on addedAt — so a re-gossiped old tombstone can't silently re-delete a
  // legitimately revived file. A strictly-newer deletion supersedes the revive.
  const revAt = room.revives.get(fileId);
  if (revAt !== undefined && revAt >= at) return;
  if (room.revives.delete(fileId)) { try { ipcRenderer.send('room-revive-del', { roomId: room.roomId, fileId }); } catch { /* ignore */ } } // superseded by a newer deletion
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

/**
 * Accept a deletion that arrived over the wire (a `del` message or a `tombSigs`
 * entry in a hello) ONLY if it is authenticated and authorized:
 *   - the signature verifies as `by` under its TOFU-bound identity key, AND
 *   - `by` is the room OWNER, or the file's AUTHOR (`addedBy`).
 * On success it applies the tombstone and records the proof so we can re-gossip
 * it verifiably. Returns true iff the deletion was accepted room-wide. A rejected
 * deletion is simply not applied (it never becomes a local hide for a bystander).
 */
function acceptRemoteTomb(room: Room, fileId: string, at: number, by: string, pub: string, sig: string): boolean {
  if (!fileId || !by || !pub || !sig || !Number.isFinite(at)) return false;
  if (at > Date.now() + 60_000) return false; // no future-dated tombstones (would suppress every later re-share)
  // Idempotency: we already hold this deletion (with a proof) at least this new —
  // nothing to do, and no need to pay for crypto. Defangs a flood of tombs we know.
  const have = room.tombstones.get(fileId);
  if (have !== undefined && have >= at && room.tombSigs.has(fileId)) return true;
  // Cheap authority gate BEFORE the expensive signature verify: a tomb from a
  // non-owner for a file we don't hold (or whose author isn't the signer) is
  // dropped without running crypto.verify — resists a hello stuffed with forged
  // tombSigs turning into thousands of Ed25519 verifications.
  const file = room.files.get(fileId);
  const authorized = (!!room.ownerId && by === room.ownerId) || (!!file && file.addedBy === by);
  if (!authorized) {
    // We can't authorize this yet — but a non-owner deletion of a file we simply
    // DON'T HOLD may be a valid AUTHOR deletion we can't check without the file
    // (authorship is only knowable from a held RoomFile). Keep the signed proof
    // PENDING so that if that file later arrives (from a straggler still seeding
    // it) we can verify + suppress it, instead of resurrecting a deleted file on
    // a late joiner. Unverified + capped, so a flood is bounded; it's promoted
    // (and only then trusted/gossiped) lazily in mergeFile.
    if (!file && by !== room.ownerId) rememberPendingTomb(room, fileId, { at, by, pub, sig });
    return false;
  }
  if (!verifySignedBy(room, by, pub, sig, delCanonical(room.topic, { fileId, memberId: by, at }))) return false;
  const actor = room.members.get(by);
  applyTombstone(room, fileId, at, { id: by, name: actor?.name || '?' });
  // Keep the proof paired with whichever timestamp actually won, so our re-gossip
  // verifies. (applyTombstone no-ops if the file was revived strictly later.)
  if (room.tombstones.get(fileId) === at) {
    room.tombSigs.set(fileId, { by, pub, sig });
    try { ipcRenderer.send('room-tomb', { roomId: room.roomId, fileId, at, by, pub, sig }); } catch { /* ignore */ }
  }
  room.pendingTombs.delete(fileId); // superseded — it's a live tombstone now
  return true;
}

const MAX_PENDING_TOMBS = 500; // cap so an attacker can't grow the map unbounded

/** Stash a signed deletion for a file we don't hold, newest-`at` wins, capped. */
function rememberPendingTomb(room: Room, fileId: string, p: TombProof): void {
  const cur = room.pendingTombs.get(fileId);
  if (cur && cur.at >= p.at) return;
  room.pendingTombs.set(fileId, p);
  if (room.pendingTombs.size > MAX_PENDING_TOMBS) {
    const oldest = room.pendingTombs.keys().next().value; // Map preserves insertion order
    if (oldest !== undefined) room.pendingTombs.delete(oldest);
  }
}

/** When a file is about to be added, apply any PENDING author-deletion for it: a
 *  straggler may be re-seeding a file its author already deleted, and a late
 *  joiner only learns the (author-signed) tombstone through this deferred check.
 *  We can authorize now because the arriving `file` reveals its addedBy. Returns
 *  true if the file was suppressed (deletion applied), so mergeFile drops the add. */
function applyPendingTomb(room: Room, file: RoomFile): boolean {
  const p = room.pendingTombs.get(file.fileId);
  if (!p) return false;
  // A revive on the arriving file that lifts a deletion at-or-after the pending one
  // SUPERSEDES it — the pending proof is stale (a replayed, already-undone
  // deletion). Only a valid owner/deleter-signed revive counts, so a member can't
  // use this to force-revive someone else's deletion.
  if (Number.isFinite(file.revAt) && (file.revAt as number) >= p.at && (file.revAt as number) <= Date.now() + 60_000 && file.revBy && file.revPub && file.revSig) {
    const rby = file.revBy;
    const revAuthorized = (!!room.ownerId && rby === room.ownerId) || rby === p.by;
    if (revAuthorized && verifySignedBy(room, rby, file.revPub, file.revSig, reviveCanonical(room.topic, { fileId: file.fileId, tombAt: file.revAt as number, by: rby }))) {
      room.pendingTombs.delete(file.fileId);
      recordRevive(room, file.fileId, file.revAt as number); // VERIFIED revive — guards against re-deletion by the replayed tombstone
      return false; // revive wins — let the add proceed
    }
  }
  const authorized = (!!room.ownerId && p.by === room.ownerId) || p.by === file.addedBy;
  if (!authorized) return false; // not the author/owner — keep it pending for a different candidate
  room.pendingTombs.delete(file.fileId);
  // Verify only now, on a real authorship match — bounds crypto to genuine candidates.
  if (!verifySignedBy(room, p.by, p.pub, p.sig, delCanonical(room.topic, { fileId: file.fileId, memberId: p.by, at: p.at }))) return false;
  const actor = room.members.get(p.by);
  applyTombstone(room, file.fileId, p.at, { id: p.by, name: actor?.name || '?' });
  if (room.tombstones.get(file.fileId) === p.at) {
    room.tombSigs.set(file.fileId, { by: p.by, pub: p.pub, sig: p.sig });
    try { ipcRenderer.send('room-tomb', { roomId: room.roomId, fileId: file.fileId, at: p.at, by: p.by, pub: p.pub, sig: p.sig }); } catch { /* ignore */ }
  }
  return true;
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

/**
 * Verify an add's revive authorization against an authenticated tombstone: the
 * signature must check out as `revBy`, and `revBy` must be the OWNER or the
 * member who signed the deletion (the original deleter). On success it lifts the
 * tombstone; on failure the tombstone stands and the resurrection is refused.
 */
function acceptRevive(room: Room, file: RoomFile): boolean {
  const by = file.revBy, pub = file.revPub, sig = file.revSig, revAt = file.revAt;
  if (!by || !pub || !sig || !Number.isFinite(revAt)) return false;
  // A revive can only lift a deletion that could actually exist. Deletions are
  // bounded to now+60s (acceptRemoteTomb), so a future-dated revAt is bogus —
  // reject it, or it would enter room.revives and permanently outrank every real
  // future deletion (the owner could never moderate the file again).
  if ((revAt as number) > Date.now() + 60_000) { log('future-dated revive for ' + file.fileId.slice(0, 8) + ' — dropped'); return false; }
  const tombAt = room.tombstones.get(file.fileId);
  if (tombAt === undefined) return true;        // nothing to lift (already revived/absent)
  if ((revAt as number) < tombAt) return false; // stale revive — it undoes an OLDER deletion than the one we hold
  // Authorize BEFORE the expensive verify (same DoS guard as acceptRemoteTomb): a
  // hello stuffed with revive-bearing files whose revBy is neither the owner nor
  // the deleter is rejected without ever running crypto.verify.
  const proof = room.tombSigs.get(file.fileId);
  const authorized = (!!room.ownerId && by === room.ownerId) || (!!proof && proof.by === by);
  if (!authorized) return false;
  // The revive is self-describing: it is signed over the deletion it lifts (revAt),
  // not over our locally-held tombAt, so it verifies regardless of clock skew.
  if (!verifySignedBy(room, by, pub, sig, reviveCanonical(room.topic, { fileId: file.fileId, tombAt: revAt as number, by }))) return false;
  clearTombstone(room, file.fileId);
  recordRevive(room, file.fileId, revAt as number); // VERIFIED — guards against re-deletion by an equal/older tombstone
  return true;
}

// ── File manifest + transfers ────────────────────────────────────────────────
function mergeFile(room: Room, file: RoomFile): void {
  if (!file || !file.fileId) return;
  if (room.mutes.has(file.addedBy)) return;     // muted member — ignore their shares locally
  const tombAt = room.tombstones.get(file.fileId);
  if (tombAt !== undefined) {
    if (room.tombSigs.has(file.fileId)) {
      // AUTHENTICATED deletion: lifted ONLY by a signed, authorized revive (owner
      // or the deleter), regardless of addedAt — so neither a bumped addedAt can
      // resurrect it unauthorized, NOR can clock skew (a receiver clamping addedAt
      // below tombAt) block a legitimate revive. Non-revive adds are suppressed.
      if (!acceptRevive(room, file)) return;
    } else if (file.addedAt <= tombAt) {
      return;                                   // legacy tombstone, older add — stays deleted
    } else {
      clearTombstone(room, file.fileId);        // legacy tombstone, newer add — any-newer-wins
    }
  } else if (applyPendingTomb(room, file)) {
    return; // a pending author-deletion for this file just resolved — drop the re-seed
  }
  if (!room.files.has(file.fileId)) {
    room.files.set(file.fileId, file);
    persistManifest(room, file); // localPath filled in once the download lands
    logEvent(room, { type: 'file-added', actorId: file.addedBy, actorName: file.addedByName || room.members.get(file.addedBy)?.name || '?', fileName: file.name });
    // Manual mode: list the file but don't fetch — the user pulls it with an
    // explicit fetchFile. (Our OWN shares go through mergeFileLocal instead.)
    // Per-folder overrides apply when the folderId is known at merge time (hello
    // backfill / restore); a live add races its 'assign', which re-checks below.
    if (effectiveAutoFetch(room, file.folderId)) ensureLocal(room, file);
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
  // The transfer may already know where the bytes live (a file shared from its
  // ORIGINAL location, or a sharer's ciphertext in a non-canonical cache dir) —
  // prefer those paths over the canonical slots so a reseed never re-downloads
  // what is already on disk.
  const known = room.transfers.get(file.fileId);

  // E2E: the swarm carries ciphertext. Download it into the cache (never the
  // room folder), then decrypt the plaintext into the folder for watch/open.
  if (room.e2e) {
    const plain = path.join(folderDirFor(room, file), file.name);
    const cipherName = `${file.name}.enc`;
    // The cache slot is keyed by fileId, NOT display name: two same-named files
    // are different ciphertexts, and a name-keyed slot would adopt (or truncate)
    // the wrong one. fileId is the cipher torrent's infoHash, so a hit at this
    // path is the right bytes by construction. Non-hex ids (hostile gossip)
    // fall back to their hash so they can't traverse out of the cache dir.
    const idDir = /^[0-9a-f]{40}$/i.test(file.fileId) ? file.fileId : crypto.createHash('sha1').update(file.fileId).digest('hex');
    const cipherDir = path.join(room.cacheDir, idDir);
    // A transfer-known ciphertext (the sharer's own, in a timestamp-keyed cache
    // dir) beats the fileId-keyed slot — same bytes, different location.
    const knownCipher = known?.cipherPath && fs.existsSync(known.cipherPath) ? known.cipherPath : null;
    const cachedCipher = knownCipher ?? path.join(cipherDir, cipherName);
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

  // Land the file in its folder's subdirectory (or the room root if unassigned),
  // mirroring the UI grouping. The same dir is used for the seed-from-disk check
  // and the download target so a reseed finds what a prior download left.
  const dir = folderDirFor(room, file);
  // A transfer-known path (a share seeded from its original location) beats
  // the room-folder slot.
  const knownPlain = known?.localPath && fs.existsSync(known.localPath) ? known.localPath : null;
  const onDisk = knownPlain ?? path.join(dir, file.name);
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
    c.add(file.magnetURI, { path: dir, announce: ROOM_TRACKERS } as any, (torrent: any) => {
      wireTorrentStats(room, torrent);
      torrent.on('done', () => {
        const landed = path.join(dir, file.name);
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
    const plain = path.join(folderDirFor(room, file), file.name);
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
    if (effectiveAutoFetch(room, file.folderId)) ensureLocal(room, file); // no cached ciphertext — re-download it
    return;
  }

  if (pf.localPath && fs.existsSync(pf.localPath)) {
    setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true, localPath: pf.localPath });
    try { c.seed(pf.localPath, { announce: ROOM_TRACKERS, name: file.name } as any, (t: any) => wireTorrentStats(room, t)); }
    catch (e) { log('manifest reseed failed: ' + String(e)); }
    return;
  }
  if (effectiveAutoFetch(room, file.folderId)) ensureLocal(room, file); // not at the known path — seed-from-folder or re-download
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
      infoHash: room.rendezvous,
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
    log('Tracker announced: ' + room.name + ' (' + room.rendezvous.slice(0, 8) + ')');
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
  // Drop the kicked member from voice too: the media PC is DTLS-SRTP direct and
  // survives the code rotation, so without this a kicked (or malicious) member
  // keeps hearing/speaking on the established connection. Enforce it on our side.
  room.voice.onMemberGone(kickedId);
  for (const wire of Array.from(room.wires.values())) {
    if (wire.memberId === kickedId) { try { wire.peer.destroy(); } catch { /* ignore */ } room.wires.delete(wire.id); }
  }
  room.code = newCode;
  room.key = deriveKey(newCode);
  room.topic = topicHash(newCode);
  room.rendezvous = rendezvousId(room.key);
  try { ipcRenderer.send('room-rekey', { roomId: room.roomId, code: newCode }); } catch { /* ignore */ }
  // The signed E2E config binds the topic, which just rotated: the owner mints a
  // fresh one (broadcast in the re-greet below); members drop the now-stale blob
  // and pick the owner's new one from its HELLO. Flag/secret themselves persist
  // (that's the point of the secret being separate from the code).
  if (room.e2e) {
    room.e2eCfg = room.ownerId === room.self.memberId ? signE2ECfg(room) : null;
    persistE2E(room);
  }
  // Tombstone proofs are bound to the topic, which just rotated — the OLD-topic
  // signatures no longer verify, so a member joining on the new code couldn't
  // converge pre-rekey deletions (they'd resurrect). The owner re-mints every
  // live tombstone under the new topic (owner authority covers any file); other
  // members self-heal by adopting these from the owner's re-greet below. Same
  // reasoning as the e2eCfg re-mint above; the topic is never transmitted, so
  // this leaks nothing.
  if (room.ownerId === room.self.memberId) {
    const by = room.self.memberId;
    for (const [fileId, at] of room.tombstones) {
      const sig = signBytes(room, delCanonical(room.topic, { fileId, memberId: by, at }));
      room.tombSigs.set(fileId, { by, pub: room.self.pub, sig });
      try { ipcRenderer.send('room-tomb', { roomId: room.roomId, fileId, at, by, pub: room.self.pub, sig }); } catch { /* ignore */ }
    }
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

/**
 * VPN kill-switch: the VPN dropped, so tear down ALL room networking at once —
 * every per-room WebTorrent client (stops seeding + tracker announces), every
 * rendezvous tracker, every peer wire — so nothing keeps exposing the real IP to
 * a swarm. Rooms are dropped from memory; the manager revives them from the
 * persisted state (the same path as startup) once the VPN is back. Immediate and
 * synchronous (no deferred 'bye' like leaveRoom — the network is already gone).
 */
function suspendAllNetworking(): void {
  let n = 0;
  for (const room of Array.from(rooms.values())) {
    try { room.voice.suspend(); } catch { /* ignore */ } // voice leaks the real IP too — tear it down
    try { room.tracker?.stop(); room.tracker?.destroy(); } catch { /* ignore */ }
    room.tracker = null;
    for (const wire of room.wires.values()) { try { wire.peer.destroy(); } catch { /* ignore */ } }
    room.wires.clear();
    const c = clients.get(room.roomId);
    clients.delete(room.roomId);
    try { c?.destroy(); } catch { /* ignore */ }
    room.started = false;
    rooms.delete(room.roomId);
    n++;
  }
  log('VPN kill-switch: suspended networking for ' + n + ' room(s)');
}

/** We were removed by the owner: surface it in the UI, stop announcing, and drop
 *  every wire so we don't linger in the swarm the room just rotated away from. */
function markKicked(room: Room, byName: string): void {
  if (room.kicked) return;
  room.kicked = true;
  room.kickedBy = byName;
  logEvent(room, { type: 'kicked', actorId: room.ownerId, actorName: byName, targetName: room.self.name || 'You' });
  try { room.voice.suspend(); } catch { /* ignore */ }
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
  const by = room.self.memberId;
  // 1. Tell the kicked member explicitly, under the CURRENT key they can still
  //    read, on every wire we have to them — so they get a clear notice. Signed
  //    with our (the owner's) key so it can't be spoofed. Both signatures bind
  //    the CURRENT topic (the room hasn't rotated yet).
  const notice: Msg = {
    t: 'kicked', targetId: memberId, by, byName: room.self.name || 'You',
    pub: room.self.pub, sig: signBytes(room, kickedCanonical(room.topic, { targetId: memberId, by })),
  };
  for (const wire of room.wires.values()) {
    if (wire.memberId === memberId) sendTo(room, wire, notice);
  }
  // 2. Rotate the room away from them. Deferred briefly so the notice flushes on
  //    the data channel before applyLocalRekey tears that wire down.
  //    An E2E room's replacement code keeps the -e2e marker (joiners of the new
  //    code must still know not to seed plaintext).
  const newCode = generateRoomCode(room.e2e);
  const oldKey = room.key;
  const rekey: Msg = {
    t: 'rekey', newCode, kickedId: memberId, kickedName, by,
    pub: room.self.pub, sig: signBytes(room, rekeyCanonical(room.topic, { newCode, kickedId: memberId, by })),
  };
  setTimeout(() => {
    if (!rooms.get(room.roomId)) return; // room was left/destroyed meanwhile
    sendRekey(room, oldKey, rekey, memberId);
    applyLocalRekey(room, newCode, memberId, kickedName);
  }, 300);
}

// ── Room lifecycle ───────────────────────────────────────────────────────────
function startRoom(p: { roomId: string; name: string; code: string; folder: string;
  self: { memberId: string; name: string; avatarSeed: string; color?: string; status?: string; avatarImg?: string; pub: string; priv: string }; useTurn: boolean; turnServers?: any[]; tombstones?: Record<string, number>; tombSigs?: Record<string, { by: string; pub: string; sig: string }>; revives?: Record<string, number>; manifest?: PersistedRoomFile[]; folders?: RoomFolder[]; folderTombs?: Record<string, number>; ownerId?: string; ownerPin?: string; nameAt?: number; mutes?: string[]; history?: RoomEvent[]; chat?: RoomChatMessage[]; reacts?: Record<string, Record<string, string[]>>; identities?: Record<string, string>; e2e?: boolean; secret?: string; e2eCfg?: E2ECfg | null; cacheDir?: string; autoFetch?: boolean; folderFetch?: Record<string, boolean>; upKbps?: number; downKbps?: number }): RoomState {
  // Authoritative kill-switch gate: refuse to bring up ANY room networking while
  // the VPN is down, no matter how this join raced past the manager's flag. The
  // manager clears this via 'netResume' before it re-joins on VPN restore.
  if (netSuspended) throw new Error('Rooms are paused: the VPN is down (kill-switch)');
  let room = rooms.get(p.roomId);
  if (room) return buildState(room);

  try { fs.mkdirSync(p.folder, { recursive: true }); } catch { /* ignore */ }

  const iceServers = p.useTurn && p.turnServers && p.turnServers.length
    ? STUN_SERVERS.concat(p.turnServers)
    : STUN_SERVERS.slice();

  const key = deriveKey(p.code); // one PBKDF2; feeds both the gossip key and the rendezvous id
  room = {
    roomId: p.roomId,
    name: p.name,
    nameAt: Number(p.nameAt) || 0,
    code: p.code,
    folder: p.folder,
    key,
    topic: topicHash(p.code),
    rendezvous: rendezvousId(key),
    peerId: randomPeerId(),
    iceServers,
    tracker: null,
    started: false,
    self: { ...p.self, color: p.self.color || '', status: p.self.status || '', avatarImg: p.self.avatarImg || '' },
    // Honor the invite's owner pin: never trust a persisted ownerId that doesn't
    // match it (it'd be a pre-pin or tampered value) — re-learn under the pin.
    ownerId: (p.ownerPin && p.ownerId && p.ownerId !== p.ownerPin) ? '' : (p.ownerId || ''),
    ownerPin: p.ownerPin || '',
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
    // Only keep proofs whose tombstone is still live (defensive resync against any
    // store drift): a proof without a tombstone is dead weight.
    tombSigs: new Map(Object.entries(p.tombSigs || {}).filter(([fileId]) => p.tombstones && fileId in p.tombstones)),
    pendingTombs: new Map(),
    // A verified revive's guard must survive restart even though its tombstone was
    // already lifted (that's the point — it blocks a re-gossiped OLD tombstone from
    // re-deleting the file). Kept until a strictly-newer deletion supersedes it.
    // Clamped to not-future so no persisted value can outrank a real later deletion.
    revives: new Map(Object.entries(p.revives || {}).map(([k, v]) => [k, Math.min(Number(v) || 0, Date.now() + 60_000)])),
    autoFetch: p.autoFetch !== false, // absent = true (historical behavior)
    folderFetch: (p.folderFetch && typeof p.folderFetch === 'object') ? { ...p.folderFetch } : {},
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
    // Only load bindings whose id is the hash of its key — drops any stale/legacy
    // entry that predates the key-derived id, so a poisoned binding can't survive.
    identities: new Map(Object.entries(p.identities || {}).filter(([id, pub]) => idMatchesPub(id, pub as string))),
    voice: undefined as unknown as VoiceSession, // set right after (its adapter closes over `room`)
    profiles: new Map(),
    profileSentTo: new Set(),
    profileAnnounce: null,
    profileAt: 0,
    seenGids: new Set(),
    seenGidOrder: [],
    kicked: false,
    kickedBy: '',
    snapshotTimer: null,
    lastSnapshot: 0,
  };
  rooms.set(p.roomId, room);
  room.voice = createVoiceSession(room);

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
    // Voice-roster liveness: a member who dropped offline (crash/sleep — no 'bye',
    // no voice-state) would otherwise linger in the voice panel with a stale mute
    // badge, and their MediaPeer would never be reclaimed. onMemberGone is a cheap
    // no-op for members with no voice footprint.
    const cutoff = Date.now() - OFFLINE_AFTER;
    for (const m of r.members.values()) {
      if (m.lastSeen < cutoff) r.voice.onMemberGone(m.memberId);
    }
    // Forget the profile announce for members gone offline (crash — no 'bye'):
    // their session-only profile cache died with them, so their next greeting
    // must trigger a fresh announce even when it arrives via a relay.
    for (const id of r.profileSentTo) {
      const m = r.members.get(id);
      if (!m || m.lastSeen < cutoff) r.profileSentTo.delete(id);
    }
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

async function addFiles(roomId: string, paths: string[], opts?: { folderId?: string; folderName?: string }): Promise<RoomState> {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  // Track per-file outcomes: resolving with a state while NOTHING was shared
  // used to read as success upstream ("Shared to <room>" with an empty room).
  let added = 0;
  let firstError: string | null = null;
  const addedIds: string[] = [];
  // Resolve the target folder BEFORE seeding so each broadcast 'add' already
  // carries its folderId — receivers with a per-folder auto-fetch override need
  // the folder known at merge time (the separate 'assign' below is a late
  // belt-and-braces for reordered deliveries, not the primary signal).
  let targetId = opts?.folderId;
  if (!targetId && opts?.folderName && paths.length > 0) {
    const existing = Array.from(room.folders.values()).find((f) => f.name === opts.folderName);
    targetId = (existing ?? makeFolder(room, opts.folderName, 'folder', '')).id;
  }
  if (targetId && !room.folders.has(targetId)) targetId = undefined;
  for (const p of paths) {
    try {
      const file = await seedLocal(room, p);
      if (targetId) applyAssignment(file, targetId, nextAt(file.folderAt ?? 0));
      // Re-sharing previously deleted content is an explicit revive: lift the
      // tombstone and stamp the add strictly after the deletion, so the 'add'
      // we broadcast (and our HELLOs) beat every peer's stored tombstone —
      // including peers currently offline, once they reconnect.
      const tombAt = room.tombstones.get(file.fileId);
      if (tombAt !== undefined) {
        // Stamp strictly after the deletion so the revive ranks ahead of it, but
        // never in the future (peers clamp addedAt to now). The revive SIGNATURE is
        // over tombAt, not addedAt, so it stays valid regardless of this clamp.
        file.addedAt = Math.min(Math.max(file.addedAt, tombAt + 1), Date.now());
        const proof = room.tombSigs.get(file.fileId);
        if (proof) {
          // Authenticated deletion: only the owner or the member who deleted it may
          // bring it back, and they sign the revive so peers accept the resurrection.
          const by = room.self.memberId;
          const authorized = (!!room.ownerId && by === room.ownerId) || proof.by === by;
          if (!authorized) throw new Error('This file was removed and can only be restored by the room owner or whoever removed it.');
          file.revBy = by;
          file.revPub = room.self.pub;
          file.revAt = tombAt; // the deletion this revive lifts — makes it self-describing
          file.revSig = signBytes(room, reviveCanonical(room.topic, { fileId: file.fileId, tombAt, by }));
          recordRevive(room, file.fileId, tombAt); // our own signed revive — trusted, guards re-deletion
        }
        clearTombstone(room, file.fileId);
      }
      mergeFileLocal(room, file, p);
      // Already present (same content shared before) counts as success too.
      if (room.files.has(file.fileId)) { added++; addedIds.push(file.fileId); }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!firstError) firstError = msg;
      log('addFile failed: ' + msg);
    }
  }
  if (paths.length > 0 && added === 0) {
    throw new Error(firstError || 'No files could be shared');
  }
  // The files were stamped with their folder BEFORE the 'add' broadcast (above).
  // Re-broadcast the assignment separately as well: an already-shared re-add whose
  // 'add' was deduped by receivers still needs the (possibly new) folder to land.
  if (addedIds.length > 0 && targetId) {
    for (const fid of addedIds) {
      const file = room.files.get(fid);
      // A re-added file that predates this share keeps its own assignment history —
      // move it to the target explicitly (applyAssignment no-ops when already there).
      if (file && file.folderId !== targetId) applyAssignment(file, targetId, nextAt(file.folderAt ?? 0));
      if (file && file.folderId === targetId && file.folderAt) {
        const tr = room.transfers.get(fid);
        persistManifest(room, file, tr?.localPath, tr?.cipherPath);
        broadcast(room, { t: 'assign', fileId: fid, folderId: targetId, at: file.folderAt, memberId: room.self.memberId });
      }
    }
    pushState(room, true);
  }
  return buildState(room);
}

// ── Folders / sections (local commands) ───────────────────────────────────────
// A local edit must always beat what we currently hold, even if that value was
// stamped by a peer whose clock ran ahead of ours — so `at` is max(now, cur+1),
// never a bare Date.now() that a fast-clock peer's value would silently reject.
function nextAt(prev: number): number { return Math.max(Date.now(), prev + 1); }

/** Does this folder RENDER as a top-level section? Mirrors the renderer's
 *  sectionIdOf exactly: absent/empty/self/dangling parent → top-level, and a
 *  folder whose parent is itself (validly) nested flattens to the top too. */
function rendersTopLevel(room: Room, f: RoomFolder): boolean {
  const pid = f.parentId;
  if (!pid || pid === f.id) return true;
  const parent = room.folders.get(pid);
  if (!parent) return true;                        // dangling → renders at root
  const grand = parent.parentId;
  return !!(grand && grand !== pid && room.folders.has(grand)); // parent itself nested → we flatten to root
}

/** Create/register a folder in this room + broadcast + persist (no pushState). */
function makeFolder(room: Room, name: string, icon: string, color: string, parentId?: string): RoomFolder {
  // Only nest under a folder that RENDERS top-level (same rule the UI uses to
  // offer targets) — one level, no chains from us. '' = explicit root.
  const parent = parentId ? room.folders.get(parentId) : undefined;
  const validParent = parent && parent.id !== undefined && rendersTopLevel(room, parent) ? parent.id : '';
  const folder: RoomFolder = {
    id: crypto.randomBytes(8).toString('hex'),
    name: String(name || '').trim().slice(0, 200) || 'Folder',
    icon: sanitizeFolderIcon(icon),
    color: String(color || '').slice(0, 64),
    at: Date.now(),
    parentId: validParent,
  };
  room.folders.set(folder.id, folder);
  persistFolder(room, folder);
  // parentId is ALWAYS present on our upserts ('' = explicit root) so receivers
  // treat the placement as authoritative rather than preserve-on-absent.
  broadcast(room, { t: 'folder', op: 'upsert', id: folder.id, name: folder.name, icon: folder.icon, color: folder.color, parentId: folder.parentId ?? '', at: folder.at, memberId: room.self.memberId });
  return folder;
}

function createFolder(roomId: string, name: string, icon: string, color: string, parentId?: string): RoomState {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  makeFolder(room, name, icon, color, parentId);
  pushState(room, true);
  return buildState(room);
}

function updateFolder(roomId: string, folderId: string, patch: { name?: string; icon?: string; color?: string; parentId?: string | null }): RoomState {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  const cur = room.folders.get(folderId);
  if (!cur) return buildState(room);
  // Reparent rules: target must render as a top-level section (same rule the
  // UI uses), not self, and a folder that has children cannot become a child
  // itself (one level only). '' = explicit move to root — kept as '' (not
  // undefined) so JSON round-trips preserve the placement.
  let reparent: { parentId?: string } | Record<string, never> = {};
  if (patch && 'parentId' in patch) {
    const pid = typeof patch.parentId === 'string' ? patch.parentId : '';
    const parent = pid ? room.folders.get(pid) : undefined;
    const hasChildren = Array.from(room.folders.values()).some((f) => f.parentId === folderId);
    const valid = pid === '' || (!!parent && rendersTopLevel(room, parent) && pid !== folderId && !hasChildren);
    if (valid) reparent = { parentId: pid };
  }
  const next: RoomFolder = {
    ...cur,
    ...(typeof patch?.name === 'string' ? { name: patch.name.trim().slice(0, 200) || cur.name } : {}),
    ...(typeof patch?.icon === 'string' ? { icon: sanitizeFolderIcon(patch.icon) } : {}),
    ...(typeof patch?.color === 'string' ? { color: patch.color.slice(0, 64) } : {}),
    ...reparent,
    at: nextAt(cur.at),
  };
  room.folders.set(folderId, next);
  persistFolder(room, next);
  // Include parentId ONLY when we actually know this folder's placement (own
  // property) — asserting '' for a hierarchy-unknown folder would explicitly
  // re-root it on peers that DO know where it lives.
  broadcast(room, { t: 'folder', op: 'upsert', id: next.id, name: next.name, icon: next.icon, color: next.color, ...(Object.prototype.hasOwnProperty.call(next, 'parentId') ? { parentId: next.parentId ?? '' } : {}), at: next.at, memberId: room.self.memberId });
  // A reparent under/out of an overridden section can flip the folder's files'
  // effective auto-fetch — pull the ones that just turned on.
  recheckAutoFetch(room, (f) => f.folderId === next.id);
  pushState(room, true);
  return buildState(room);
}

function deleteFolder(roomId: string, folderId: string): RoomState {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  const at = nextAt(room.folders.get(folderId)?.at ?? room.folderTombstones.get(folderId) ?? 0);
  // Files keep their (now-dangling) folderId → they render Uncategorized via
  // groupFilesByFolder; child folders' dangling parentId renders them at root.
  // No per-file reassignment gossip needed.
  if (applyFolderDelete(room.folders, room.folderTombstones, folderId, at)) {
    persistFolderDelete(room, folderId, at, !room.folders.has(folderId));
    dropFolderFetch(room, folderId); // a lingering override would gate Uncategorized files forever
    broadcast(room, { t: 'folder', op: 'del', id: folderId, at, memberId: room.self.memberId });
    // Dropping a section's override re-parents its (and its children's) files
    // onto the room toggle — catch up anything that just became effective-ON.
    recheckAutoFetch(room);
    pushState(room, true);
  }
  return buildState(room);
}

/** Remove a deleted folder's auto-fetch override (engine + persisted copy). */
function dropFolderFetch(room: Room, folderId: string): void {
  if (!(folderId in room.folderFetch)) return;
  delete room.folderFetch[folderId];
  try { ipcRenderer.send('room-folder-fetch-del', { roomId: room.roomId, folderId }); } catch { /* ignore */ }
}

/** wantAutoFetch with this room's one-hop folder→section resolver. */
function effectiveAutoFetch(room: Room, folderId: string | null | undefined): boolean {
  return wantAutoFetch(room.autoFetch, room.folderFetch, folderId, (id) => room.folders.get(id)?.parentId);
}

/**
 * Re-run the auto-fetch gate over (a subset of) the manifest after anything
 * that can flip a file's EFFECTIVE state without touching the file itself: a
 * folder reparent, a late-arriving folder record, a section override change, a
 * folder/section delete. Pull-only and idempotent — ensureLocal no-ops on an
 * already-tracked transfer, and cancelled/errored files are left alone (same
 * status guard as the assign re-check).
 */
function recheckAutoFetch(room: Room, only?: (f: RoomFile) => boolean): void {
  for (const f of room.files.values()) {
    if (only && !only(f)) continue;
    const tr = room.transfers.get(f.fileId);
    if (!tr?.haveLocally && effectiveAutoFetch(room, f.folderId) && (!tr || tr.status === 'queued' || !tr.status)) {
      ensureLocal(room, f);
    }
  }
}

function assignFile(roomId: string, fileId: string, folderId: string | null): RoomState {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  const file = room.files.get(fileId);
  if (file && (file.folderId ?? null) === (folderId || null)) return buildState(room); // already there
  if (!file) return buildState(room);
  const at = nextAt(file.folderAt ?? 0);
  if (applyAssignment(file, folderId, at)) {
    const tr = room.transfers.get(fileId);
    persistManifest(room, file, tr?.localPath, tr?.cipherPath);
    broadcast(room, { t: 'assign', fileId, folderId: folderId || '', at, memberId: room.self.memberId });
    // Moving a not-yet-fetched file into an auto-ON folder starts the pull.
    if (!tr?.haveLocally && effectiveAutoFetch(room, file.folderId) && (!tr || tr.status === 'queued' || !tr.status)) {
      ensureLocal(room, file);
    }
    pushState(room, true);
  }
  return buildState(room);
}

function leaveRoom(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  // Tell peers we're leaving so they drop us at once (no 45s offline ghost).
  try { room.voice.suspend(); } catch { /* ignore */ } // release the mic + close voice PCs
  if (room.profileAnnounce) { clearTimeout(room.profileAnnounce); room.profileAnnounce = null; }
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

/** Resume seeding a released file (the row's "Seed again"). */
function reseedFile(roomId: string, fileId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  const file = room.files.get(fileId);
  if (!file) return;
  const tr = room.transfers.get(fileId);
  if (tr) tr.released = false;
  ensureLocal(room, file); // idempotent — re-seeds from disk or re-downloads
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
  addChat(room, { ...msg, pub: room.self.pub, sig }); // keep our sig so we can re-serve this as backfill
}

/** Delete one file: sign a tombstone, apply it locally, and gossip it. Records the
 *  authenticated proof only when WE may delete it for everyone (owner or author);
 *  otherwise it degrades to a local hide (peers drop the unauthorized del). */
function broadcastDelete(r: Room, fileId: string, at: number): void {
  const file = r.files.get(fileId);
  const authorized = (!!r.ownerId && r.self.memberId === r.ownerId) || (!!file && file.addedBy === r.self.memberId);
  const sig = signBytes(r, delCanonical(r.topic, { fileId, memberId: r.self.memberId, at }));
  applyTombstone(r, fileId, at, { id: r.self.memberId, name: r.self.name || 'You' });
  if (authorized && r.tombstones.get(fileId) === at) {
    r.tombSigs.set(fileId, { by: r.self.memberId, pub: r.self.pub, sig });
    try { ipcRenderer.send('room-tomb', { roomId: r.roomId, fileId, at, by: r.self.memberId, pub: r.self.pub, sig }); } catch { /* ignore */ }
  }
  broadcast(r, { t: 'del', fileId, memberId: r.self.memberId, at, pub: r.self.pub, sig });
}

/** Owner-only: rename the room, sign it, and gossip the change (LWW by `at`). A
 *  non-owner call is refused (encryption proves membership, not authority). */
function renameRoom(roomId: string, rawName: string): RoomState {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  if (room.ownerId !== room.self.memberId) throw new Error('Only the room owner can rename the room');
  const name = String(rawName || '').slice(0, MAX_STR).trim();
  if (!name) throw new Error('Room name cannot be empty');
  const at = Math.max(Date.now(), room.nameAt + 1); // strictly newer, never in the past
  const by = room.self.memberId;
  const sig = signBytes(room, renameCanonical(room.topic, { name, at, by }));
  room.name = name;
  room.nameAt = at;
  try { ipcRenderer.send('room-name', { roomId: room.roomId, name, at }); } catch { /* ignore */ }
  broadcast(room, { t: 'rename', name, at, by, pub: room.self.pub, sig });
  pushState(room, true);
  return buildState(room);
}

/** Apply a profile change (name/avatar/color/status/image) to every active room
 *  and tell peers: the legacy ping keeps ≤2.22 clients current on name/seed,
 *  and the signed 'profile' broadcast carries the rich fields. */
function updateProfile(p: { name?: string; avatarSeed?: string; color?: string; status?: string; avatarImg?: string }): void {
  for (const room of rooms.values()) {
    if (typeof p.name === 'string') room.self.name = p.name;
    if (typeof p.avatarSeed === 'string' && p.avatarSeed) room.self.avatarSeed = p.avatarSeed;
    if (typeof p.color === 'string') room.self.color = p.color;
    if (typeof p.status === 'string') room.self.status = p.status;
    if (typeof p.avatarImg === 'string') room.self.avatarImg = p.avatarImg;
    broadcast(room, { t: 'ping', memberId: room.self.memberId, name: room.self.name || 'You', avatarSeed: room.self.avatarSeed, have: buildState(room).members[0].have, roomName: room.name, ownerId: room.ownerId });
    const pm = selfProfileMsg(room);
    if (pm) broadcast(room, pm);
    pushState(room, true);
  }
}

// ── IPC command router ───────────────────────────────────────────────────────
ipcRenderer.on('room-cmd', async (_e, msg: any) => {
  const { type, reqId } = msg;
  try {
    let data: any;
    if (type === 'join') data = startRoom(msg.payload);
    else if (type === 'addFiles') data = await addFiles(msg.roomId, msg.paths, msg.opts);
    else if (type === 'createFolder') data = createFolder(msg.roomId, msg.name, msg.icon, msg.color, msg.parentId ? String(msg.parentId) : undefined);
    else if (type === 'updateFolder') data = updateFolder(msg.roomId, msg.folderId, msg.patch || {});
    else if (type === 'rename') data = renameRoom(msg.roomId, msg.name);
    else if (type === 'deleteFolder') data = deleteFolder(msg.roomId, msg.folderId);
    else if (type === 'assignFile') data = assignFile(msg.roomId, msg.fileId, msg.folderId ?? null);
    else if (type === 'leave') { leaveRoom(msg.roomId); data = { ok: true }; }
    else if (type === 'netSuspend') { netSuspended = true; suspendAllNetworking(); data = { ok: true }; }
    else if (type === 'netResume') { netSuspended = false; data = { ok: true }; }
    else if (type === 'profile') { updateProfile(msg.payload || {}); data = { ok: true }; }
    else if (type === 'releaseFile') { releaseFile(msg.roomId, msg.fileId); data = { ok: true }; }
    else if (type === 'reseedFile') { reseedFile(msg.roomId, msg.fileId); data = { ok: true }; }
    else if (type === 'removeFile') {
      const r = rooms.get(msg.roomId);
      if (r) { broadcastDelete(r, msg.fileId, Number(msg.at) || Date.now()); pushState(r, true); }
      data = { ok: true };
    }
    else if (type === 'removeFiles') {
      const r = rooms.get(msg.roomId);
      if (r) {
        const at = Number(msg.at) || Date.now();
        for (const fileId of (Array.isArray(msg.fileIds) ? msg.fileIds : [])) if (fileId) broadcastDelete(r, String(fileId), at);
        pushState(r, true); // one refresh for the whole batch
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
        // The gossip handlers drop a muted member's voice-state/signal, but a live
        // MediaPeer keeps playing their audio — so cut/restore their OUTPUT on our
        // side WITHOUT tearing the peer connection down (a teardown can't be
        // re-negotiated against the peer's surviving half). Reversible instantly.
        r.voice.setLocallyMuted(r.mutes);
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
    else if (type === 'voiceJoin') {
      const r = rooms.get(msg.roomId);
      if (!r) throw new Error('Room not active');
      if (netSuspended) throw new Error('Rooms are paused: the VPN is down (kill-switch)');
      // One call at a time: joining here hangs up any other room's voice. The
      // shell-level call surface (StatusBar cluster, mute/deafen hotkeys)
      // binds to THE active call — two live mics would make it ambiguous.
      for (const [otherId, other] of rooms) {
        if (otherId !== msg.roomId && other.voice.getState().inVoice) other.voice.leave();
      }
      const warning = await r.voice.join(); // getUserMedia — rejects (→ toast) if the mic is denied
      // The kill-switch may have tripped DURING getUserMedia (suspend can't tear
      // down a session that wasn't active yet) — re-check and undo, or the mic +
      // real-IP ICE would stay live for the whole outage.
      if (netSuspended) { r.voice.leave(); throw new Error('Rooms are paused: the VPN is down (kill-switch)'); }
      if (!rooms.has(msg.roomId)) { r.voice.leave(); throw new Error('The room session ended.'); }
      // Solicit peers so a (re)joiner learns who is already in voice AND who is
      // sharing a screen (presence/share are only gossiped on change — a hello makes
      // everyone reannounce both). Fixes a missing LIVE badge after leave+rejoin.
      broadcast(r, helloMsg(r));
      data = { ok: true, ...(warning ? { warning } : {}) };
    }
    else if (type === 'voiceLeave') { rooms.get(msg.roomId)?.voice.leave(); data = { ok: true }; }
    else if (type === 'voiceMute') { rooms.get(msg.roomId)?.voice.setMuted(!!msg.muted); data = { ok: true }; }
    else if (type === 'voiceDeafen') { rooms.get(msg.roomId)?.voice.setDeafened(!!msg.deafened); data = { ok: true }; }
    else if (type === 'voiceVolume') { rooms.get(msg.roomId)?.voice.setVolume(String(msg.memberId || ''), Number(msg.volume)); data = { ok: true }; }
    else if (type === 'voiceInputMode') { rooms.get(msg.roomId)?.voice.setInputMode(msg.mode); data = { ok: true }; }
    else if (type === 'voicePtt') { rooms.get(msg.roomId)?.voice.setPtt(!!msg.active); data = { ok: true }; }
    else if (type === 'voiceSettings') {
      // Global (all-rooms): the renderer's voice prefs changed. Live knobs apply
      // instantly; capture-affecting ones hot-swap the pipeline source per room.
      voiceSettings = sanitizeVoiceSettings(msg.settings);
      for (const r of rooms.values()) r.voice.applySettings();
      data = { ok: true };
    }
    else if (type === 'voiceDevices') { data = await listVoiceDevices(); }
    else if (type === 'voiceMicTestStart') {
      // Meter with the settings the renderer sends explicitly — the module-level
      // voiceSettings is debounced 200ms, so it would lag a just-made device change.
      const s = msg.settings ? sanitizeVoiceSettings(msg.settings) : voiceSettings;
      await micTester.start(
        s,
        (level) => { try { ipcRenderer.send('room-mic-level', { level }); } catch { /* ignore */ } },
        () => { try { ipcRenderer.send('room-mic-level', { level: -1 }); } catch { /* ignore */ } }, // -1 = auto-stopped (60s)
        msg.monitor === true, // play the processed mic back so the user can hear the NS mode
      );
      data = { ok: true };
    }
    else if (type === 'voiceMicTestStop') { micTester.stop(); data = { ok: true }; }
    else if (type === 'screenShareStart') {
      const r = rooms.get(msg.roomId);
      if (!r) throw new Error('Room not active');
      if (netSuspended) throw new Error('Rooms are paused: the VPN is down (kill-switch)');
      if (!r.voice.isActive()) throw new Error('Join the voice channel before sharing your screen.');
      const stream = await captureScreen(String(msg.sourceId || ''));
      // The kill-switch (or a leave/kick) may have tripped DURING capture — same
      // re-check-and-undo pattern as voiceJoin, or the capture would leak.
      if (netSuspended) { stream.getTracks().forEach((t) => t.stop()); throw new Error('Rooms are paused: the VPN is down (kill-switch)'); }
      if (!rooms.has(msg.roomId) || !r.voice.isActive()) { stream.getTracks().forEach((t) => t.stop()); throw new Error('The voice session ended.'); }
      r.voice.startShare(stream);
      data = { ok: true };
    }
    else if (type === 'screenShareStop') { rooms.get(msg.roomId)?.voice.stopShare(); data = { ok: true }; }
    else if (type === 'screenWatchStart') {
      const r = rooms.get(msg.roomId);
      if (!r) throw new Error('Room not active');
      r.voice.watchStart(String(msg.memberId || ''));
      data = { ok: true };
    }
    else if (type === 'screenWatchStop') { rooms.get(msg.roomId)?.voice.watchStop(String(msg.memberId || '')); data = { ok: true }; }
    else if (type === 'screenSignal') {
      rooms.get(msg.roomId)?.voice.onLoopbackSignal(String(msg.memberId || ''), String(msg.kind || ''), msg.data);
      data = { ok: true };
    }
    else if (type === 'snapshot') { const r = rooms.get(msg.roomId); data = r ? buildState(r) : null; }
    else if (type === 'setAutoFetch') {
      const r = rooms.get(msg.roomId);
      if (r) {
        r.autoFetch = msg.autoFetch !== false;
        // Turning auto back ON pulls everything that was left unfetched — except
        // files in folders whose per-folder override forces fetching OFF.
        if (r.autoFetch) {
          for (const f of r.files.values()) {
            if (!r.transfers.get(f.fileId)?.haveLocally && effectiveAutoFetch(r, f.folderId)) ensureLocal(r, f);
          }
        }
        pushState(r, true);
      }
      data = { ok: true };
    }
    else if (type === 'setFolderAutoFetch') {
      // Local per-folder override: true/false forces, null inherits the room
      // toggle again. Newly effective ON pulls the folder's unfetched files.
      const r = rooms.get(msg.roomId);
      if (!r) throw new Error('Room not active');
      const folderId = String(msg.folderId || '');
      if (folderId) {
        // Liveness guard: the manager persists the override BEFORE this cmd, so
        // a folder delete racing in between would otherwise resurrect a dead-id
        // override that silently gates dangling files (and, via the section
        // hop, subtrees). A dead id always means inherit — and undo the db copy.
        if (!r.folders.has(folderId)) {
          delete r.folderFetch[folderId];
          try { ipcRenderer.send('room-folder-fetch-del', { roomId: r.roomId, folderId }); } catch { /* ignore */ }
        } else if (msg.mode === true || msg.mode === false) r.folderFetch[folderId] = msg.mode;
        else delete r.folderFetch[folderId];
        // Catch up everything whose EFFECTIVE state may have flipped: the
        // folder's own files plus — when it's a section — files in child
        // folders that inherit from it (their own override, if any, wins
        // inside effectiveAutoFetch).
        recheckAutoFetch(r, (f) => {
          const fid = f.folderId;
          if (!fid) return false;
          return fid === folderId || r.folders.get(fid)?.parentId === folderId;
        });
        pushState(r, true);
      }
      data = buildState(r);
    }
    else if (type === 'assignFiles') {
      // Batched multi-file move (the drop of a multi-selection): one cmd, one
      // refresh. Mirrors removeFiles; per-file it follows assignFile exactly.
      const r = rooms.get(msg.roomId);
      if (!r) throw new Error('Room not active');
      const folderId: string | null = msg.folderId ?? null;
      for (const rawId of (Array.isArray(msg.fileIds) ? msg.fileIds : [])) {
        const fileId = String(rawId || '');
        const file = fileId ? r.files.get(fileId) : undefined;
        if (!file) continue;
        if ((file.folderId ?? null) === (folderId || null)) continue; // already there — no broadcast/LWW bump
        const at = nextAt(file.folderAt ?? 0);
        if (applyAssignment(file, folderId, at)) {
          const tr = r.transfers.get(fileId);
          persistManifest(r, file, tr?.localPath, tr?.cipherPath);
          broadcast(r, { t: 'assign', fileId, folderId: folderId || '', at, memberId: r.self.memberId });
          if (!tr?.haveLocally && effectiveAutoFetch(r, file.folderId) && (!tr || tr.status === 'queued' || !tr.status)) {
            ensureLocal(r, file);
          }
        }
      }
      pushState(r, true);
      data = buildState(r);
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
