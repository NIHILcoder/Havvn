import { PendingServerCommands, validCommandRequest, commandCanonical, commandReplyCanonical, type ServerCommandRequest, type ServerCommandReply } from '../../shared/server-command';
import { historyDays, retainLocalHistory } from '../../shared/room-local-data';
import { managedCopy, deleteManagedCopy, roomTreeBytes, type RoomCopy } from './room-copy-storage';
import type { RoomDiskUsage } from '../../shared/room-local-data';
import { WatchHostState, watchPolicyCanonical, type WatchPolicy } from '../../shared/room-watch-host';
import { roomHelloParts, RoomHelloAssembly, RoomHelloOutbox, ROOM_FILE_LIMIT, ROOM_FOLDER_LIMIT, ROOM_FOLDER_TOMB_LIMIT, ROOM_HELLO_ENTRIES, roomChannelHasCapacity, roomManifestCanFit, storeRoomManifestFile, type ManifestPart } from '../../shared/room-manifest-sync';
import { useChromiumWebRTC as configureChromiumWebRTC } from './chromium-webrtc';
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
import { ROOM_BAN_LIMIT, validBanSnapshot, banSnapshotCanonical, banSnapshotAdvances, copyBanSnapshot, type RoomBanSnapshot } from '../../shared/room-bans';
import { ROOM_KEY_LIMIT, type RoomE2ECfg, type RoomKeyPage } from '../../shared/room-keyring';
import { contentKeyEpoch, mergeContentKeys, mintKeyPages, verifyKeyMetadata, verifyKeyPage, completeKeyPages, completeContentKeys } from './room-keyring';
import { assertCompatibleOwnerPin } from '../../shared/room-owner-pin';
import { RoomTrafficBudget } from './room-traffic-budget';
import { type RoomResourcePolicy } from '../../shared/room-resources';
import { RoomConnectionMonitor, selectedRoomChannelPath, type RoomConnectionEvent, type RoomChannelPath } from '../../shared/room-diagnostics';
import { normalizeRoomRate } from '../../shared/room-chat-delivery';
import { roomFileName, orderedTransferPrefix, ownerChainAnchored, ownerChainsCompatible, canDeleteRoomFile, canReviveRoomFile, currentRoomDeletion, transferCanonical as sharedTransferCanonical } from '../../shared/room-authority';
import { ROOM_PROTOCOL_VERSION, DESKTOP_ROOM_CAPABILITIES, readRoomCapabilities } from '../../shared/room-capabilities';
import { chatContextCanonical, voiceStateV2Canonical } from '../../shared/room-canonicals';
import { ROOM_CHAT_LIMIT, chatEnvelope, chatBackfillPages, retainRoomChat, upgradeChat, validChatTime } from '../../shared/room-chat-history';
import fs from 'fs';
import path from 'path';
import type WebTorrentType from 'webtorrent';
import { createTorrentStreamServer } from '../torrent/stream-server';
let WebTorrent: typeof WebTorrentType;
import { deriveKey, topicHash, rendezvousId, randomPeerId, encrypt, decrypt, generateRoomCode, codeIsE2E, deriveMemberId, buildInvite } from './room-crypto';
import { encryptFile, decryptFile, generateRoomSecret } from './room-e2e';
import { validateGossip, RoomIngressBudget, ROOM_MEMBER_LIMIT, ROOM_IDENTITY_LIMIT, ROOM_RELAY_TYPES, ROOM_WIRE_LIMIT } from '../../shared/room-protocol';
import { gossipProofs, currentHelloProofs } from '../../shared/room-message-auth';
import { WatchSender, WatchReceiver, watchCanonical, watchHostCanonical, type WatchMessage } from '../../shared/room-watch-sync';
import { RoomReceiveQueue } from './room-receive-queue';
import { RoomDiskBudget } from './room-disk-budget';
import { roomDiskName, newRoomFilePath, isManagedRoomPath, roomTorrentMetadata, verifyRoomFile, migrateRoomFile, roomFileStamp, matchingRoomPlaintext } from './room-file-storage';
import { RoomFile, RoomFileError, RoomFolder, RoomMember, RoomState, RoomTransfer, PersistedRoomFile, RoomEvent, RoomChatMessage, RoomChatAck, VoiceSettings, VoiceDeviceInfo } from '../../shared/types';
import { mergeFolderUpsert, applyFolderDelete, applyAssignment, sanitizeFolderIcon, wantAutoFetch } from '../../shared/room-folders';
import { PROFILE_STATUS_MAX, PROFILE_COLOR_RE, PROFILE_IMG_MAX_CHARS, sanitizeProfileStatus, sanitizeProfileImg } from '../../shared/profile';
import { safeDirSegment } from '../../shared/path-safety';
import { CHAT_REACT_EMOJIS } from '../../shared/reactions';
import crypto from 'crypto';
import type { ServerMirrorState } from '../../shared/gameserver-types';
import { parseMirrorBody } from '../gameserver/server-mirror';

let TrackerClient: any;
let RoomChunkStore: any;
let networkingModules: Promise<void> | undefined;
async function loadNetworkingModules(): Promise<void> {
  configureChromiumWebRTC();
  networkingModules ??= Promise.all([import('webtorrent'), import('bittorrent-tracker'), import('fs-chunk-store')]).then(([wt, tracker, store]) => {
    WebTorrent = wt.default;
    TrackerClient = tracker.default;
    RoomChunkStore = store.default;
  }).catch(error => { networkingModules = undefined; throw error; });
  await networkingModules;
}

const pendingRoomTorrents = new WeakMap<object, Map<string, any>>();
function rememberRoomTorrent(client: any, hash: string, torrent: any): any {
  if (!torrent) return torrent;
  let pending = pendingRoomTorrents.get(client);
  if (!pending) { pending = new Map(); pendingRoomTorrents.set(client, pending); }
  pending.set(hash, torrent);
  torrent.once?.('close', () => { if (pending?.get(hash) === torrent) pending.delete(hash); });
  return torrent;
}
function addKnownTorrent(client: any, hash: string, source: any, options: any, callback: any): any {
  return rememberRoomTorrent(client, hash, client.add(source, options, callback));
}
function findTorrent(client: any, hash: string): any {
  const pending = pendingRoomTorrents.get(client)?.get(hash);
  if (pending && !pending.destroyed) return pending;
  // WebTorrent 3 get() is async; room event handlers need a synchronous guard.
  return Array.isArray(client.torrents)
    ? client.torrents.find((t: any) => t.infoHash === hash)
    : client.get(hash);
}

import { STUN_SERVERS, RENDEZVOUS_TRACKERS } from './ice-servers';
import { VoiceSession, VoiceAdapter, SignalKind, LoopbackKind, MicTester, defaultVoiceSettings, sanitizeVoiceSettings } from './room-voice';
// ── Virtual-LAN (Havvn LAN) — transport + signed gossip. The LanSession routing
//    brain lives in room-lan.ts; canonical builders are pure (shared/lan-protocol);
//    the pipe client bridges the elevated Wintun helper. RTCPeerConnection is only
//    touched inside LanSession's class bodies, so importing here is import-safe.
import { LanSession, LanAdapter, LanSignalKind } from './room-lan';
import { lanGenesisCanonical, lanStateCanonical, lanSignalCanonical, lanAdmitCanonical, lanEvictCanonical, lanReachCanonical, normalizeReachList } from '../../shared/lan-protocol';
import { verifyVipClaim } from '../../shared/lan-ip';
import type { LanStateClaim } from '../../shared/lan-session-core';
import { sessionHostPrefix } from '../../shared/lan-session-core';
import type { LanGenesisMsg, LanStateMsg, LanSignalMsg, LanAdmitMsg, LanEvictMsg, LanReachMsg, LanControlMsg, LanHelperFacts } from '../../shared/lan-types';
import type { LanDiagInput } from '../../shared/lan-quality';
import { LanPipeClient, validateGameExePath } from '../lan/pipe-bridge';

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
const CHAT_REACTION_EMOJI: string[] = [...CHAT_REACT_EMOJIS]; // chat-message reactions (whitelist)
const CHAT_REACTION_SET = new Set(CHAT_REACTION_EMOJI);
const MAX_REACT_MSGS = 200;       // chat-reaction map ceiling per room (kept + helloed)
const MAX_REACT_FILES = 200;      // reaction map ceiling per room (kept + helloed)

// ── Peer-relay (gossip flooding) ──────────────────────────────────────────────
// Two members who can't form a direct WebRTC wire (NAT) still converge if some
// reachable member is connected to both: every node re-broadcasts gossip it hasn't
// seen to its OTHER wires (deduped by a per-message id, bounded by a hop count),
// so any node with ≥2 wires implicitly relays. Free, no servers — the "relay" is
// just another member. Targeted/keyed messages (rekey, kicked) are NOT flooded.
const RELAY_TTL = 4;                 // max hops a gossip message travels
const SEEN_GID_CAP = 4096;           // dedup memory per room (FIFO)
// Per-member srv-cmd replay floors. A hostile keyholder minting identities must
// not grow this map unbounded, but evicting a floor REOPENS that member's replay
// window — so strangers (ids not in the roster) go first, and their commands are
// refused by the host's operator check regardless of any floor.
const SRV_CMD_FLOOR_CAP = 512;
// Distinct members whose server mirrors we hold. A room where this many people
// are each running game servers does not exist; the cap is only there so a
// keyholder minting identities cannot grow the map.
const SRV_MIRROR_HOST_CAP = 32;
const RELAYABLE = ROOM_RELAY_TYPES;

// ── Gossip input hardening ────────────────────────────────────────────────────
// Decryption already proves a peer holds the room code, but a *malicious member*
// could still send oversized/malformed gossip to exhaust memory — and peer-relay
// would re-flood it. So every inbound frame is size-capped before we even decrypt,
// and the decoded message is validated against shared schemas. Signed bytes
// are checked unchanged BEFORE relay; legacy display sanitizers run afterwards.
const MAX_FRAME_CHARS = 1_000_000;   // reject an encrypted frame larger than ~1 MB
const MAX_ARRAY = ROOM_FILE_LIMIT;              // have / files / tombs entries
const MAX_TOMBSIGS = 500;            // signed tombstones per received legacy frame; outgoing snapshots are paged
const MAX_CHAT_LOG = ROOM_CHAT_LIMIT; // accept legacy frames; new senders use pages of 50
const MAX_STR = 1024;                // ids, names, seeds
const MAX_MAGNET = 4096;             // a magnet URI
const MAX_TEXT = 2000;               // a chat message body
const MAX_SECRET = 256;              // E2E content key (hex)

function log(msg: string): void { try { ipcRenderer.send('room-log', msg); } catch { /* ignore */ } }

// A deletion proof: the tombstone's timestamp plus the author/owner Ed25519
// signature over delCanonical, so it re-verifies wherever it gossips.
type TombProof = { at: number; by: string; pub: string; sig: string };

// One applied ownership transfer: the then-current owner's Ed25519 signature
// over transferCanonical. The ordered list of these (transferChain) lets anyone
// holding only the ORIGINAL invite pin walk hop-by-hop to the current owner.
type TransferLink = { newOwnerId: string; at: number; by: string; pub: string; sig: string };

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
  | RoomKeyPage
  | { t: 'e2e-key-request'; memberId: string; root: string; page: number }
  | { t: 'hello'; manifestFull?: boolean; manifestPart?: ManifestPart; manifestRequest?: boolean; memberId: string; name: string; avatarSeed: string; pub?: string; have: string[]; files: RoomFile[]; tombs: string[]; tombsAt?: Record<string, number>; tombSigs?: Record<string, TombProof>; roomName: string; nameAt?: number; topicMsg?: { text: string; at: number; by: string; pub: string; sig: string }; ownerId: string; e2e: boolean; secret: string; cfg?: E2ECfg; fileReacts?: Record<string, Record<string, string[]>>; chatReacts?: Record<string, Record<string, string[]>>; chatEdits?: Record<string, { text: string; at: number; by: string; pub: string; sig: string }>; folders?: RoomFolder[]; folderTombs?: Record<string, number>; chatAt?: number; chatSync?: number; watchSync?: number; chatIds?: string[]; transferChain?: TransferLink[]; banState?: RoomBanSnapshot; watchPolicy?: WatchPolicy; guest?: boolean; protocolVersion?: number; capabilities?: string[] }
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
  | { t: 'ping'; memberId: string; name: string; avatarSeed: string; have: string[]; roomName: string; ownerId: string; guest?: boolean; protocolVersion?: number; capabilities?: string[]; watchSync?: number }
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
  // The owner hands the room to another member. Signed by the CURRENT owner,
  // LWW by `at` (same future-clock cutoff as rename/topic). Every applied
  // transfer joins room.transferChain, which full HELLOs re-serve so a joiner
  // holding an OLD invite can walk pin → transfer#1 → … → current owner.
  | { t: 'transfer'; banState?: RoomBanSnapshot; newOwnerId: string; at: number; by: string; pub: string; sig: string }
  // Sent when a member leaves voluntarily so peers drop them at once instead of
  // keeping a 45s offline ghost in the list.
  | { t: 'bye'; memberId: string }
  // Watch-together: relayed verbatim to peers; the renderers keep playback in sync
  // and show who's in the session ('join'/'leave'/'beat' presence).
  | WatchPolicy
  | WatchMessage
  | { t: 'sync'; fileId: string; action: 'play' | 'pause' | 'seek' | 'state' | 'join' | 'leave' | 'beat' | 'react'; position: number; rate: number; at: number; memberId: string; name: string; avatarSeed: string; playing: boolean; together?: boolean; emoji?: string }
  // A chat message. Carries its own id (dedupes re-delivery across multiple wires)
  // and the sender's identity so peers can render it without a member lookup.
  // `pub` is the sender's Ed25519 public key (PEM) and `sig` an Ed25519 signature
  // over the immutable fields — proves authorship, so no keyholder can post under
  // another member's id (anti-spoofing on top of the room-key confidentiality).
  // Legacy sig authenticates the body; v2 contextSig also authenticates the reply.
  | { t: 'chat'; chatV?: 2; contextSig?: string; id: string; memberId: string; name: string; avatarSeed: string; text: string; at: number; pub: string; sig: string; replyTo?: string; replyName?: string; replyText?: string }
  // Author edits their own message. A SEPARATE signed type (NOT a mutation of the
  // 'chat' message — that would break dedupe-by-id and older peers) over a domain-
  // tagged editCanonical; receivers enforce memberId === the target's author. LWW
  // by `at`. Applied as an overlay (room.chatEdits) so the original stays intact
  // for backfill self-verification.
  | { t: 'chat-edit'; msgId: string; memberId: string; text: string; at: number; pub: string; sig: string }
  // Backfill: a UNICAST reply to a peer whose HELLO said it was behind — the
  // messages it missed while offline, each carrying its own pub/sig so they
  // re-verify independently of who re-served them. Never broadcast/relayed.
  | { t: 'chat-log'; msgs: RoomChatMessage[] }
  // Owner renamed the room. OWNER-SIGNED + last-writer-wins by `at`, so it can
  // actually change an already-set name (the plain HELLO roomName only bootstraps
  // a placeholder). Relayed verbatim; peers verify `by === ownerId`.
  | { t: 'rename'; name: string; at: number; by: string; pub: string; sig: string }
  | { t: 'topic'; text: string; at: number; by: string; pub: string; sig: string }
  // Liveness: the sender is composing a chat message. Renderer-triggered, never
  // persisted; receivers stamp it and let a ~4s TTL fade it out on their own.
  | { t: 'typing'; memberId: string }
  // Toggle an emoji reaction on a shared file (REACTION_EMOJI whitelist only).
  | { t: 'react-file'; memberId: string; fileId: string; emoji: string; on: boolean }
  | { t: 'react-chat'; memberId: string; msgId: string; emoji: string; on: boolean }
  // Coarse download progress (0-100, PROG_STEP granularity) so peers see a
  // member's transfer move; completion is signalled by the normal 'have'.
  | { t: 'prog'; memberId: string; fileId: string; pct: number }
  // Voice presence: the sender joined/left the room's voice channel or toggled
  // mute. SIGNED so a member can't fake another's presence; relayed so late/relay-
  // only members learn who is talking.
  | { t: 'voice-state'; memberId: string; inVoice: boolean; muted: boolean; deafened?: boolean; at: number; pub: string; sig: string; voiceV?: 2; stateSig?: string }
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
  | { t: 'voice-share'; memberId: string; sharing: boolean; streamId: string; at: number; pub: string; sig: string }
  // ── Virtual-LAN signed gossip (5 arms, plan §3). The DURABLE authority triple
  // (lan-genesis/lan-admit/lan-evict) binds sessionId (rekey-stable); the TRANSIENT
  // pair (lan-state/lan-signal) binds room.topic like voice. Genesis pins the host
  // (first-writer-wins); admit/evict verify `by === pinned hostId`; every lan-state
  // vIP is re-derived (verifyVipClaim); lan-signal from a non-admitted member is
  // dropped BEFORE the mesh. Each carries its OWN per-type anti-replay floor (never
  // shared) inside the LanSessionCore. All 5 are RELAYABLE + clamped in-place.
  | LanGenesisMsg
  | LanStateMsg
  | LanSignalMsg
  | LanAdmitMsg
  | LanEvictMsg
  // Phase 2B: the 6th arm. TRANSIENT (topic-bound like lan-state), presence-class
  // — it grants nothing, so it needs no rekey-stable anchor; it carries sessionId
  // INSIDE the canonical and has its OWN monotonic floor (inside LanReachTable),
  // never shared with lan-state's.
  | LanReachMsg
  // Game-server mirror: host-signed compact instance state for remote viewers.
  | { t: 'srv-mirror'; hostId: string; at: number; body: string; pub: string; sig: string }
  // Operator console command relayed to the host.
  | { t: 'srv-cmd'; by: string; instanceId: string; command: string; at: number; pub: string; sig: string }
  | (ServerCommandRequest & { t: 'srv-cmd-v2'; pub: string; sig: string })
  | (ServerCommandReply & { t: 'srv-result-v2'; pub: string; sig: string });

interface Wire { id: number; peer: any; path?: RoomChannelPath; statsPending?: boolean; manifestReceived?: boolean; manifestRequestedAt?: number; memberId?: string; greetedFull?: boolean; legacyChatSent?: boolean; }

/**
 * The room's E2E config as a self-contained, owner-signed claim: `sig` is an
 * Ed25519 signature by `pub` (the OWNER's identity key) over the topic, ownerId,
 * flag and secret — so no other keyholder can mint or alter one, and a blob from
 * another room/topic never verifies here. Members store the blob and re-serve it
 * in their HELLOs, so a joiner can authenticate the secret even while the owner
 * is offline. Binding to the CURRENT topic means the owner re-signs on rekey.
 */
type E2ECfg = RoomE2ECfg;

interface Room {
  roomId: string;
  name: string;
  nameAt: number;                        // last-writer-wins clock for the room name (owner rename)
  topicText: string;                     // owner-set room topic ('' = none)
  topicAt: number;                       // last-writer-wins clock for the topic
  topicMsg: { text: string; at: number; by: string; pub: string; sig: string } | null; // the SIGNED topic (re-served in HELLOs)
  code: string;
  folder: string;
  key: Buffer;
  topic: string;                         // internal signature domain separator (never announced)
  rendezvous: string;                    // public tracker rendezvous id (slow-derived from key)
  peerId: string;
  iceServers: any[];
  trackers: string[];                    // rendezvous trackers this room announces to (settings-resolved)
  tracker: any;
  started: boolean;
  self: { memberId: string; name: string; avatarSeed: string; color: string; status: string; avatarImg: string; pub: string; priv: string };
  ownerId: string;                       // memberId of the owner ('' until learned)
  ownerPin: string;                      // owner memberId pinned from the invite ('' = TOFU); only this identity may be adopted as owner
  transferChain: TransferLink[];         // applied ownership transfers, in order — each verified when it applied; re-served in full HELLOs + persisted
  transferAt: number;                    // `at` of the last applied transfer (the chain's LWW clock)
  e2e: boolean;                          // end-to-end encryption (ciphertext on the wire)
  secret: string;                        // E2E content key (32-byte hex; '' until learned)
  e2eCfg: E2ECfg | null;                 // owner-signed E2E config we hold + re-serve to joiners
  prevSecrets: string[];                 // retained decrypt-only keys, including legacy epochs
  keyPages: RoomKeyPage[];                // current signed paged history for offline-owner joins
  keyRequestedAt: Map<number, number>;
  keySentAt: Map<number, number>;
  banState: RoomBanSnapshot | null;
  bans: Set<string>;                     // memberIds cut by an owner-signed rekey — their gossip is dropped
  e2eSigned: boolean;                    // e2e/secret/owner were established by a VERIFIED owner signature
  cacheDir: string;                      // where ciphertext copies live (outside the room folder)
  wires: Map<number, Wire>;
  members: Map<string, RoomMember>;      // by memberId (excludes self)
  files: Map<string, RoomFile>;
  manifestLimited?: boolean;          // by fileId
  folders: Map<string, RoomFolder>;      // by folderId — optional sections overlay (LWW)
  folderTombstones: Map<string, number>; // deleted folderId → deletedAt; a newer upsert revives it
  transfers: Map<string, RoomTransfer>;  // by fileId
  tombstones: Map<string, number>;       // deleted fileId → deletedAt; only a newer re-share revives it
  tombSigs: Map<string, { by: string; pub: string; sig: string }>; // deletion proofs (author/owner-signed) so a tombstone re-verifies as it gossips
  pendingTombs: Map<string, TombProof>;  // signed author-deletions for files we don't hold yet — applied if/when that file arrives (session-only, capped)
  revives: Map<string, number>;          // fileId → revAt of a VERIFIED revive we accepted; guards the revived file from re-deletion by an equal/older re-gossiped tombstone (session-only)
  autoFetch: boolean;                    // auto-download peers' files; false = wait for an explicit fetchFile
  folderFetch: Record<string, boolean>;  // per-folder auto-fetch override (local pref; absent key = inherit autoFetch)
  upKbps: number;                        // per-room upload ceiling, KB/s (0 = shared room budget)
  downKbps: number;                      // per-room download ceiling, KB/s (0 = shared room budget)
  mutes: Set<string>;                    // locally-muted memberIds (per install)
  history: RoomEvent[];                  // activity log, newest last (capped)
  chat: RoomChatMessage[];               // chat messages, newest last (capped)
  typing: Record<string, number>;        // memberId → last 'typing' gossip stamp (session-only)
  lastTypingSent: number;                // rate-limit for OUR outgoing typing broadcasts
  fileReacts: Map<string, Map<string, Set<string>>>; // fileId → emoji → reacting memberIds (persisted)
  chatReacts: Map<string, Map<string, Set<string>>>; // chat msgId → emoji → reacting memberIds (persisted)
  chatEdits: Map<string, { text: string; at: number; by: string; pub: string; sig: string }>; // chat msgId → author's latest signed edit (LWW by at, persisted)
  pendingEdits: Map<string, { text: string; at: number; by: string; pub: string; sig: string }>; // VERIFIED edits whose target message we don't hold yet — flushed by addChat when it arrives (session-only, capped)
  memberProg: Map<string, Map<string, number>>;      // memberId → fileId → coarse download % (session-only)
  progSent: Map<string, number>;         // fileId → last PROG_STEP % WE gossiped (throttle)
  identities: Map<string, string>;       // memberId → Ed25519 public key (PEM), TOFU-bound
  voice: VoiceSession;                    // serverless mesh voice channel (session-only)
  lan?: LanSession;                       // virtual-LAN session (session-only; created on lanStart, undefined until then)
  lanPipe?: LanPipeClient;                // named-pipe client to the elevated Wintun helper (session-only)
  lanEgress?: (frame: Buffer) => void;    // TUN-egress router the LanSession adapter registered via onPacket
  lanReq?: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: any }>; // in-flight correlated helper requests (diag / allow-app), cleared by teardownLan
  lanReqSeq?: number;                     // uint32 correlation counter for lanReq
  lanSession?: string;                    // the virtual-LAN session this room re-enters (persisted by main; its id is what keeps vIPs stable)
  lanFloor?: number;                       // persisted admit/evict anti-replay watermark for lanSession — seeds every core we build for it
  lanReady?: boolean;                     // the helper sent {t:'ready'} — its adapter/IP/routes/firewall are up
  lanReadyWaiters?: Array<(ok: boolean) => void>; // settled true by 'ready', false by teardown/timeout (see lanHelperReady)
  profiles: Map<string, { name: string; avatarSeed: string; color: string; status: string; img: string; at: number }>; // VERIFIED rich profiles; entry.at doubles as the anti-replay floor (session-only, FIFO-capped)
  profileSentTo: Set<string>;            // memberIds whose hello we've already answered with our profile broadcast
  profileAnnounce: any;                  // pending coalesced profile broadcast timer (join waves = one flood)
  profileAt: number;                     // our own last announced profile `at` (monotonic vs clock steps)
  /** hostId → that member's last verified game-server mirror (session-only,
   *  capped). Keyed by publisher: any member may host, and the entry's own `at`
   *  IS that host's replay floor — a shared floor let the host with the faster
   *  clock silently bury everyone else's servers. */
  srvMirrors: Map<string, ServerMirrorState>;
  pendingServerCommands: PendingServerCommands;
  srvCmdAt: Map<string, number>;         // memberId → last srv-cmd `at` accepted from them (our OWN id: last we SENT, so two commands in one millisecond still advance); the anti-replay floor for operator commands (session-only, capped)
  seenGids: Set<string>;                 // relay dedup — gossip ids already processed
  seenGidOrder: string[];                // FIFO order for capping seenGids
  kicked: boolean;                       // the owner removed us (session-only)
  kickedBy: string;                      // who removed us (display name)
  snapshotTimer: any;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  lastSnapshot: number;
}

// One WebTorrent client PER ROOM: webtorrent throttles only at the client
// level, so per-room clients are what make per-room speed limits real (and
// two rooms sharing identical content stop colliding on one infoHash).
const clients = new Map<string, any>();  // roomId → WebTorrent client
const rooms = new Map<string, Room>();
const connectionMonitors = new WeakMap<Room, RoomConnectionMonitor>();
function connectionMonitor(room: Room): RoomConnectionMonitor {
  let monitor = connectionMonitors.get(room);
  if (!monitor) { monitor = new RoomConnectionMonitor(room.trackers.length); connectionMonitors.set(room, monitor); }
  return monitor;
}
function observeConnection(room: Room, event: RoomConnectionEvent): void { connectionMonitor(room).observe(event); pushState(room); }
function connectionSnapshot(room: Room) {
  const channels = { pending: 0, open: 0, identified: 0, syncing: 0, direct: 0, turn: 0, unknown: 0 };
  for (const wire of room.wires.values()) {
    if (wire.peer.destroyed) continue;
    if (!wire.peer.connected) { channels.pending++; continue; }
    channels.open++; channels[wire.path ?? 'unknown']++;
    if (wire.memberId && wire.memberId !== room.self.memberId && !room.bans.has(wire.memberId)) {
      channels.identified++;
      if (wire.manifestReceived === false) channels.syncing++;
    }
  }
  return connectionMonitor(room).snapshot(channels, room.e2e && !room.secret, room.kicked);
}
async function sampleChannelPath(room: Room, wire: Wire): Promise<void> {
  if (wire.statsPending || typeof wire.peer._pc?.getStats !== 'function') return;
  wire.statsPending = true;
  try {
    const stats = await wire.peer._pc.getStats();
    if (rooms.get(room.roomId) !== room || room.wires.get(wire.id) !== wire || !wire.peer.connected || wire.peer.destroyed) return;
    const path = selectedRoomChannelPath(typeof stats.values === 'function' ? stats.values() : stats);
    if (wire.path !== path) { wire.path = path; pushState(room); }
  } catch { /* unmeasured paths remain unknown */ }
  finally { wire.statsPending = false; }
}
const trafficBudget = new RoomTrafficBudget((id) => {
  const client = clients.get(id); clients.delete(id);
  try { client?.destroy(); } catch { /* fail closed */ }
  log('Room file client stopped after limiter failure: ' + id);
});
function refreshFileBudget(): boolean {
  const before = trafficBudget.isVoicePriorityActive();
  try { trafficBudget.setVoiceActive([...rooms.values()].some(r => r.voice?.isActive())); }
  catch (error) { log('Room voice priority could not be applied: ' + String(error)); }
  return before !== trafficBudget.isVoicePriorityActive();
}
function removeFileClient(id: string): void {
  try { trafficBudget.remove(id); } catch (error) { log('Room budget reallocation failed: ' + String(error)); }
}
function pushResourceStates(): void { for (const r of rooms.values()) pushState(r, true); }
function applyResourcePolicy(value: unknown): void {
  trafficBudget.configure(value);
  for (const r of rooms.values()) r.voice.setScreenBitrate(trafficBudget.getPolicy().screenBitrateKbps);
  pushResourceStates();
}
// Watch-while-downloading: WebTorrent's own per-torrent HTTP stream server, one
// per watched file, keyed `${roomId}:${fileId}`. It serves Range requests over
// the live torrent — blocking on and prioritizing not-yet-downloaded pieces — so
// a directly-playable file plays before it finishes. Bound to 127.0.0.1 (no
// firewall prompt); closed on room teardown. E2E rooms never use it (the swarm
// carries ciphertext — there is no plaintext to stream until decrypt).
const streamServers = new Map<string, { server: any; port: number }>();
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
// Phase 2B: is THIS install willing to forward another pair's LAN frames? Global
// (the cost is one uplink, not one room), session-only here — the persisted
// AppSetting is the source of truth and main re-asserts it on the 'lanStart'
// payload AND on a 'lanSettings' push (see room-manager.readied). Absent ⇒ true.
let lanRelayEnabled = true;
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
// Network recovery is limited to calls already active; a kill-switch never auto-joins.
globalThis.addEventListener?.('online', () => {
  if (netSuspended) return;
  for (const r of rooms.values()) if (!r.kicked) r.voice.onNetworkChanged();
});

/** Enumerate audio devices IN THIS window (deviceId is salted per-origin, so the
 *  ids the capture pipeline needs must come from here, not the main renderer).
 *  Labels can be blank until the user explicitly joins/tests voice. Enumeration
 *  must never open a microphone merely to discover those labels. */
async function listVoiceDevices(): Promise<VoiceDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devs = await navigator.mediaDevices.enumerateDevices();
  const audio = (d: MediaDeviceInfo) => d.kind === 'audioinput' || d.kind === 'audiooutput';
  return devs.filter(audio).map((d) => ({ deviceId: d.deviceId, kind: d.kind as VoiceDeviceInfo['kind'], label: d.label || '' }));
}
// Debug handles for the hidden window's console/CDP — rooms and clients are
// module-scoped and otherwise unreachable when diagnosing a live install.
(globalThis as any).__rooms = rooms;
(globalThis as any).__clients = clients;

function ensureClient(room: Room): any {
  // Kill-switch chokepoint: NEVER construct a WebTorrent client while suspended,
  // or for a room already torn down. An async command that yielded before
  // netSuspend ran (e.g. an in-flight addFiles loop) still holds a live `room`
  // reference; without this, its next seed would build a fresh client keyed to a
  // deleted roomId — one that suspendAllNetworking can never find to tear down,
  // leaking on the real IP for the whole outage.
  if (netSuspended || rooms.get(room.roomId) !== room) throw new Error('Room networking is suspended (VPN kill-switch)');
  let c = clients.get(room.roomId);
  if (!c) {
    c = new WebTorrent({
      natUpnp: false, natPmp: false,
      utp: false,
      dht: false,
      enableWebSeeds: false,
      uploadLimit: 0,
      downloadLimit: 0,
      tracker: { wrtc: nativeWrtc, rtcConfig: { iceServers: room.iceServers } },
    } as any);
    c.on('error', (e: any) => log('wt client error: ' + (e?.message || e)));
    clients.set(room.roomId, c);
    trafficBudget.register(room.roomId, c, room.upKbps, room.downKbps);
    pushResourceStates();
    log('WebTorrent client ready (Chromium WebRTC) for room ' + room.roomId);
  }
  return c;
}

// ── Liveness: typing / file reactions / coarse progress ─────────────────────

/** Serialize the reaction map (capped, whitelist order) for buildState, HELLOs
 *  and persistence. */
function reactsMapToRecord(map: Map<string, Map<string, Set<string>>>, emojiList: string[], cap: number): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  let n = 0;
  for (const [id, byEmoji] of map) {
    if (n >= cap) break;
    const rec: Record<string, string[]> = {};
    for (const emoji of emojiList) {
      const set = byEmoji.get(emoji);
      if (set && set.size) rec[emoji] = Array.from(set);
    }
    if (Object.keys(rec).length) { out[id] = rec; n++; }
  }
  return out;
}
function reactsToRecord(room: Room): Record<string, Record<string, string[]>> {
  return reactsMapToRecord(room.fileReacts, REACTION_EMOJI, MAX_REACT_FILES);
}
function chatReactsToRecord(room: Room): Record<string, Record<string, string[]>> {
  return reactsMapToRecord(room.chatReacts, CHAT_REACTION_EMOJI, MAX_REACT_MSGS);
}

/** Bound a reaction summary (peer-supplied or persisted): ≤MAX_REACT_FILES
 *  files, whitelisted emoji only, member lists deduped + capped. */
function clampReactsRecordIn(rec: any, emojiList: string[], cap: number): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return out;
  for (const [rawId, byEmoji] of Object.entries(rec).slice(0, cap)) {
    const fileId = clampStr(rawId, MAX_STR);
    if (!fileId || !byEmoji || typeof byEmoji !== 'object' || Array.isArray(byEmoji)) continue;
    const inner: Record<string, string[]> = {};
    for (const emoji of emojiList) {
      const members = (byEmoji as any)[emoji];
      if (!Array.isArray(members)) continue;
      const list = Array.from(new Set(members.slice(0, MAX_ARRAY).map((m: any) => clampStr(m, MAX_STR)).filter(Boolean))) as string[];
      if (list.length) inner[emoji] = list;
    }
    if (Object.keys(inner).length) out[fileId] = inner;
  }
  return out;
}
function clampReactsRecord(rec: any): Record<string, Record<string, string[]>> {
  return clampReactsRecordIn(rec, REACTION_EMOJI, MAX_REACT_FILES);
}

/** Rehydrate a persisted (or clamped inbound) reaction record into live maps. */
function reactsFromRecordIn(rec: Record<string, Record<string, string[]>> | undefined, emojiList: string[], cap: number): Map<string, Map<string, Set<string>>> {
  const map = new Map<string, Map<string, Set<string>>>();
  for (const [id, byEmoji] of Object.entries(clampReactsRecordIn(rec, emojiList, cap))) {
    const inner = new Map<string, Set<string>>();
    for (const [emoji, members] of Object.entries(byEmoji)) inner.set(emoji, new Set(members));
    map.set(id, inner);
  }
  return map;
}
function reactsFromRecord(rec?: Record<string, Record<string, string[]>>): Map<string, Map<string, Set<string>>> {
  return reactsFromRecordIn(rec, REACTION_EMOJI, MAX_REACT_FILES);
}

/** Persist the room's reaction map via the main process (mirrors history/chat). */
function persistReacts(room: Room): void {
  try { ipcRenderer.send('room-reacts', { roomId: room.roomId, reacts: reactsToRecord(room) }); } catch { /* ignore */ }
}
function persistChatReacts(room: Room): void {
  try { ipcRenderer.send('room-chat-reacts', { roomId: room.roomId, reacts: chatReactsToRecord(room) }); } catch { /* ignore */ }
}

/** Toggle one member's emoji reaction on a file. Non-whitelisted emoji and
 *  over-cap growth are ignored. Returns true when anything actually changed —
 *  callers persist + push state on change. */
function applyReactIn(map: Map<string, Map<string, Set<string>>>, id: string, emoji: string, memberId: string, on: boolean, emojiSet: Set<string>, cap: number): boolean {
  if (!id || !memberId || !emojiSet.has(emoji)) return false;
  let byEmoji = map.get(id);
  if (on) {
    if (!byEmoji) {
      if (map.size >= cap) return false; // cap: no new entries past the ceiling
      byEmoji = new Map();
      map.set(id, byEmoji);
    }
    let set = byEmoji.get(emoji);
    if (!set) { set = new Set(); byEmoji.set(emoji, set); }
    if (set.has(memberId) || set.size >= ROOM_MEMBER_LIMIT) return false;
    set.add(memberId);
  } else {
    const set = byEmoji?.get(emoji);
    if (!set || !set.delete(memberId)) return false;
    if (set.size === 0) byEmoji!.delete(emoji);
    if (byEmoji && byEmoji.size === 0) map.delete(id);
  }
  return true;
}
function applyFileReact(room: Room, fileId: string, emoji: string, memberId: string, on: boolean): boolean {
  return applyReactIn(room.fileReacts, fileId, emoji, memberId, on, REACTION_SET, MAX_REACT_FILES);
}
function applyChatReact(room: Room, msgId: string, emoji: string, memberId: string, on: boolean): boolean {
  return applyReactIn(room.chatReacts, msgId, emoji, memberId, on, CHAT_REACTION_SET, MAX_REACT_MSGS);
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

/** Union a peer's HELLO chat-reaction summary into ours (same union-only rule).
 *  Filtered to messages we hold — unknown/pruned ids must not squat the cap. */
function mergeChatReacts(room: Room, rec?: Record<string, Record<string, string[]>>): boolean {
  let changed = false;
  const known = new Set(room.chat.map((c) => c.id));
  for (const [msgId, byEmoji] of Object.entries(clampReactsRecordIn(rec, CHAT_REACTION_EMOJI, MAX_REACT_MSGS))) {
    if (!known.has(msgId)) continue;
    for (const [emoji, members] of Object.entries(byEmoji)) {
      for (const m of members) if (applyChatReact(room, msgId, emoji, m, true)) changed = true;
    }
  }
  return changed;
}

/** Drop reactions of messages that left the capped chat window (they render
 *  nowhere and would otherwise permanently squat the reaction-map ceiling). */
function pruneChatReacts(room: Room): boolean {
  if (!room.chatReacts.size) return false;
  const known = new Set(room.chat.map((c) => c.id));
  let changed = false;
  for (const id of Array.from(room.chatReacts.keys())) {
    if (!known.has(id)) { room.chatReacts.delete(id); changed = true; }
  }
  return changed;
}

// ── Chat edits (author-signed overlay on the chat log) ───────────────────────
// An edit never mutates the stored message (that would break dedupe-by-id and
// backfill self-verification) — it rides a separate map, LWW by `at`, applied
// only to messages we hold and only by the message's own author.

/** Apply a (already verified) edit: LWW by `at`, author-only, capped. Returns
 *  true when it changed the overlay so callers persist + push state. */
function applyChatEdit(room: Room, msgId: string, edit: { text: string; at: number; by: string; pub: string; sig: string }): boolean {
  const target = room.chat.find((c) => c.id === msgId);
  if (!target) return false;                        // only messages we hold (cap discipline)
  if (edit.by !== target.memberId) return false;    // authorship: only the author edits their message
  const cur = room.chatEdits.get(msgId);
  // LWW by `at`, with a DETERMINISTIC signature tiebreak on equal `at` so every
  // peer converges even if a modified client signs two edits with the same clock.
  if (cur && (cur.at > edit.at || (cur.at === edit.at && cur.sig >= edit.sig))) return false;
  if (!cur && room.chatEdits.size >= MAX_REACT_MSGS) return false; // cap new entries at the ceiling
  room.chatEdits.set(msgId, edit);
  return true;
}

/** Buffer a VERIFIED edit whose target message we don't hold yet, so it can be
 *  applied the moment the message arrives (via addChat) — covers a late joiner
 *  whose HELLO edits precede the chat-log backfill, and live relay reordering.
 *  Keeps only the highest-`at` per msgId; FIFO-capped so it can't grow unbounded. */
function bufferPendingEdit(room: Room, msgId: string, edit: { text: string; at: number; by: string; pub: string; sig: string }): void {
  const cur = room.pendingEdits.get(msgId);
  if (cur && (cur.at > edit.at || (cur.at === edit.at && cur.sig >= edit.sig))) return;
  if (!cur && room.pendingEdits.size >= MAX_REACT_MSGS) {
    const oldest = room.pendingEdits.keys().next().value; // FIFO eviction (insertion-ordered Map)
    if (oldest !== undefined) room.pendingEdits.delete(oldest);
  }
  room.pendingEdits.set(msgId, edit);
}

/** Serialize the edit overlay for HELLO + persistence (carries pub/sig so a
 *  peer/reload can re-verify). */
function chatEditsToRecord(room: Room): Record<string, { text: string; at: number; by: string; pub: string; sig: string }> {
  const out: Record<string, { text: string; at: number; by: string; pub: string; sig: string }> = {};
  for (const [msgId, e] of room.chatEdits) out[msgId] = { text: e.text, at: e.at, by: e.by, pub: e.pub, sig: e.sig };
  return out;
}

/** The renderer-facing view: just the edited text + clock (no pub/sig). */
function chatEditsToState(room: Room): Record<string, { text: string; at: number }> {
  const out: Record<string, { text: string; at: number }> = {};
  for (const [msgId, e] of room.chatEdits) out[msgId] = { text: e.text, at: e.at };
  return out;
}

/** Union a peer's HELLO edit overlay into ours — each edit RE-VERIFIED against
 *  the target's author (so a keyholder can't rewrite others' messages via HELLO),
 *  filtered to messages we hold, LWW by `at`. */
function mergeChatEdits(room: Room, rec?: Record<string, { text: string; at: number; by: string; pub: string; sig: string }>): boolean {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  let changed = false;
  const known = new Set(room.chat.map((c) => c.id));
  for (const [rawId, raw] of Object.entries(rec).slice(0, MAX_REACT_MSGS)) {
    const msgId = clampStr(rawId, MAX_STR);
    if (!msgId || !raw || typeof raw !== 'object') continue;
    const edit = {
      text: clampStr((raw as any).text, MAX_TEXT), at: Number((raw as any).at) || 0,
      by: clampStr((raw as any).by, MAX_STR), pub: clampStr((raw as any).pub, MAX_STR * 2), sig: clampStr((raw as any).sig, MAX_STR),
    };
    if (!edit.text || !validChatTime(edit.at)) continue;
    if (room.mutes.has(edit.by)) continue;    // a muted member's edits stay hidden (mirror the live/backfill paths)
    if (!verifyEdit(room, { msgId, memberId: edit.by, at: edit.at, text: edit.text, pub: edit.pub, sig: edit.sig })) continue;
    // Target not held yet (fresh joiner merges HELLO edits BEFORE the chat-log
    // backfill delivers the messages) → buffer, don't drop; addChat flushes it.
    if (!known.has(msgId)) { bufferPendingEdit(room, msgId, edit); continue; }
    if (applyChatEdit(room, msgId, edit)) changed = true;
  }
  return changed;
}

/** Rehydrate the persisted edit overlay (OUR disk — trusted, not re-verified,
 *  same as persisted chat isn't). Bounds every field defensively anyway. */
function chatEditsFromRecord(rec?: Record<string, { text: string; at: number; by: string; pub: string; sig: string }>): Map<string, { text: string; at: number; by: string; pub: string; sig: string }> {
  const map = new Map<string, { text: string; at: number; by: string; pub: string; sig: string }>();
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return map;
  for (const [rawId, raw] of Object.entries(rec).slice(0, MAX_REACT_MSGS)) {
    const msgId = clampStr(rawId, MAX_STR);
    const text = clampStr((raw as any)?.text, MAX_TEXT);
    const at = Number((raw as any)?.at) || 0;
    if (!msgId || !text || !at) continue;
    map.set(msgId, { text, at, by: clampStr((raw as any).by, MAX_STR), pub: clampStr((raw as any).pub, MAX_STR * 2), sig: clampStr((raw as any).sig, MAX_STR) });
  }
  return map;
}

function persistChatEdits(room: Room): void {
  try { ipcRenderer.send('room-chat-edits', { roomId: room.roomId, edits: chatEditsToRecord(room) }); } catch { /* ignore */ }
}

/** Drop edits whose message aged out of the capped chat window (mirrors
 *  pruneChatReacts — they render nowhere and would squat the cap). */
function pruneChatEdits(room: Room): boolean {
  if (!room.chatEdits.size) return false;
  const known = new Set(room.chat.map((c) => c.id));
  let changed = false;
  for (const id of Array.from(room.chatEdits.keys())) {
    if (!known.has(id)) { room.chatEdits.delete(id); changed = true; }
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
    protocolVersion: ROOM_PROTOCOL_VERSION, capabilities: [...DESKTOP_ROOM_CAPABILITIES], watchSync: true,
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
  const queuedReceives = receiveQueue.positions(room);
  const transfers: Record<string, RoomTransfer> = {};
  for (const [k, v] of room.transfers) transfers[k] = { ...v, queuePosition: queuedReceives.get(k) };
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
  // Server mirrors from members who are still here. Presence is the expiry
  // rather than a TTL: an idle host publishes only when something changes, so a
  // clock-based cutoff would quietly hide a perfectly good stopped server, while
  // a member who has gone offline cannot be reached anyway. Our own mirror is
  // never among these — local instances come from the ServerManager direct.
  const srvMirrors: ServerMirrorState[] = [];
  for (const [hostId, mirror] of room.srvMirrors) {
    if (hostId === room.self.memberId) continue;
    if (!mirror.instances.length) continue;   // "I have none" — kept in memory as
    const m = room.members.get(hostId);       // that host's replay floor, but it
    if (!m || now - m.lastSeen >= OFFLINE_AFTER) continue;  // is nothing to show.
    srvMirrors.push(mirror);
  }
  return {
    roomId: room.roomId,
    connection: connectionSnapshot(room),
    name: room.name,
    ...(room.topicText ? { topic: room.topicText } : {}),
    code: room.code,
    // The shareable invite pins the owner (when known) so joiners can't be tricked
    // into adopting an impostor owner; the bare `code` stays the speakable fallback.
    invite: buildInvite(room.code, room.ownerId || room.ownerPin),
    folder: room.folder,
    topicHash: room.topic,
    createdAt: 0,
    ownerId: room.ownerId,
    watchPolicy: watchState(room).host.current(room.ownerId, room.transferAt),
    canManage: !!room.ownerId && room.ownerId === room.self.memberId,
    e2e: room.e2e,
    members,
    manifestLimited: room.manifestLimited,
    files: Array.from(room.files.values()).sort((a, b) => a.addedAt - b.addedAt),
    // Folders sorted by name (natural), then by id as a deterministic tiebreaker
    // so two same-named folders render in the SAME order on every peer (Map
    // insertion order differs per peer). The renderer groups files under them.
    folders: Array.from(room.folders.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id)),
    transfers,
    receiveQueue: { ...receiveQueue.counts(room), concurrency: 2,
      waitingBytes: Array.from(room.files.values()).filter(f => queuedReceives.has(f.fileId)).reduce((sum, f) => sum + f.size, 0) },
    history: room.history.slice(-100),
    chat: room.chat.slice(-ROOM_CHAT_LIMIT),
    connected: room.started,
    peerCount: onlinePeers,
    autoFetch: room.autoFetch,
    folderFetch: { ...room.folderFetch },
    upKbps: room.upKbps,
    downKbps: room.downKbps,
    resources: { policy: trafficBudget.getPolicy(), voicePriorityActive: trafficBudget.isVoicePriorityActive(),
      fileUpBps: trafficBudget.rates(room.roomId)?.[0] ?? 0,
      fileDownBps: trafficBudget.rates(room.roomId)?.[1] ?? 0 },
    kicked: room.kicked,
    ...(room.kicked ? { kickedBy: room.kickedBy } : {}),
    typingMemberIds,
    fileReacts: reactsToRecord(room),
    chatReacts: chatReactsToRecord(room),
    ...(room.chatEdits.size ? { chatEdits: chatEditsToState(room) } : {}),
    memberProg,
    voice: room.voice.getState(),
    lan: room.lan ? room.lan.getState() : idleLanState(),
    ...(srvMirrors.length ? { srvMirrors } : {}),
  };
}

/** Default RoomLanState when no LAN session is running in this room (mirrors how
 *  voice always emits a state). `available` reflects only the platform gate here —
 *  the main-process LanManager owns the koffi/wintun availability check and greys
 *  Start out via `blocked` when another room holds the single global session. */
function idleLanState(): RoomState['lan'] {
  return { available: process.platform === 'win32', active: false, isHost: false, participants: [] };
}

function pushState(room: Room, immediate = false): void {
  const send = () => {
    if (rooms.get(room.roomId) !== room) return;
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
const helloAssemblies = new WeakMap<object, RoomHelloAssembly>();
const helloPages = new WeakMap<object, ReturnType<typeof roomHelloParts>>();
const helloOutboxes = new WeakMap<Room, RoomHelloOutbox>();
const helloClocks = new WeakMap<Room, number>();
function helloAssembly(target: object, limit = 256): RoomHelloAssembly {
  let assembly = helloAssemblies.get(target);
  if (!assembly) { assembly = new RoomHelloAssembly(limit); helloAssemblies.set(target, assembly); }
  return assembly;
}
function resetHelloSync(room: Room): void {
  helloOutboxes.get(room)?.stop(); helloOutboxes.delete(room); helloAssemblies.delete(room);
}
function sendTo(room: Room, wire: Wire, msg: Msg): void {
  if (msg.t === 'hello' && msg.manifestFull === true && !msg.manifestPart) {
    const at = Math.max(Date.now(), (helloClocks.get(room) || 0) + 1); helloClocks.set(room, at);
    try {
      let pages = helloPages.get(msg);
      if (!pages) { pages = roomHelloParts(msg, crypto.randomBytes(12).toString('hex'), at); helloPages.set(msg, pages); }
      if (pages.length > 1) {
        for (const page of pages) if (page._g) markSeen(room, page._g);
        let outbox = helloOutboxes.get(room);
        if (!outbox) { outbox = new RoomHelloOutbox(); helloOutboxes.set(room, outbox); }
        const key = room.key;
        outbox.enqueue(wire, pages, page => sendTo(room, wire, page as Msg), () => {
          if (rooms.get(room.roomId) !== room || room.key !== key || netSuspended || room.kicked
            || room.wires.get(wire.id) !== wire || !wire.peer?.connected) return null;
          return roomChannelHasCapacity(wire.peer);
        });
        return;
      }
    } catch (error) { log('HELLO paging failed: ' + String(error)); return; }
  }
  if (msg.t === 'hello' && msg.manifestPart && (msg as Msg & { _t?: number })._t! < 4) {
    let outbox = helloOutboxes.get(room);
    if (!outbox) { outbox = new RoomHelloOutbox(); helloOutboxes.set(room, outbox); }
    const key = room.key;
    outbox.relay(msg, page => {
      try { wire.peer.send(encrypt(key, page)); } catch { /* closed channel */ }
    }, () => {
      if (rooms.get(room.roomId) !== room || room.key !== key || netSuspended || room.kicked
        || room.wires.get(wire.id) !== wire || !wire.peer?.connected || room.bans.has(wire.memberId || '')) return null;
      return (wire.peer?._channel?.bufferedAmount || 0) < 512 * 1024;
    });
    return;
  }
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
    if (!wire.memberId || room.bans.has(wire.memberId)) continue; // same gate as broadcast
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
  for (const wire of room.wires.values()) {
    // Nothing beyond the slim greet flows to a wire that hasn't identified
    // itself, or that identified as a banned member.
    if (!wire.memberId || room.bans.has(wire.memberId)) continue;
    sendTo(room, wire, msg);
  }
}

function persistBanState(room: Room): void {
  try { ipcRenderer.send('room-bans', { roomId: room.roomId, bans: [...room.bans], banState: room.banState }); } catch { /* ignore */ }
}
function mintBanState(room: Room): void {
  if (room.ownerId !== room.self.memberId) return;
  const bans = [...room.bans].sort();
  if (room.banState?.ownerId === room.ownerId && JSON.stringify(room.banState.bans) === JSON.stringify(bans)) return;
  const proof: RoomBanSnapshot = { v: 1, ownerId: room.ownerId, revision: room.banState?.ownerId === room.ownerId ? room.banState.revision + 1 : 1, bans, pub: room.self.pub, sig: '' };
  proof.sig = signBytes(room, Buffer.from(banSnapshotCanonical(room.topic, proof)));
  if (validBanSnapshot(proof)) { room.banState = proof; persistBanState(room); }
}
function dropBannedMember(room: Room, id: string): void {
  room.members.delete(id); room.memberProg.delete(id); delete room.typing[id];
  room.voice.onMemberGone(id); room.lan?.onMemberGone(id);
  for (const wire of [...room.wires.values()]) if (wire.memberId === id) {
    try { wire.peer.destroy(); } catch { /* ignore */ } room.wires.delete(wire.id);
  }
}
function adoptBanState(room: Room, proof: RoomBanSnapshot): boolean {
  if (!validBanSnapshot(proof) || !banSnapshotAdvances(proof, room.ownerId, room.banState, room.bans)
    || !verifySignedBy(room, proof.ownerId, proof.pub, proof.sig, Buffer.from(banSnapshotCanonical(room.topic, proof)))) return false;
  if (room.banState?.sig === proof.sig) return true;
  room.banState = copyBanSnapshot(proof);
  for (const id of proof.bans) { room.bans.add(id); dropBannedMember(room, id); }
  persistBanState(room);
  if (room.bans.has(room.self.memberId)) markKicked(room, room.members.get(room.ownerId)?.name || '?');
  else { broadcast(room, helloMsg(room)); pushState(room, true); }
  return true;
}

function helloMsg(room: Room, full = true): Msg {
  const watch = watchState(room);
  let policy = watch.host.current(room.ownerId, room.transferAt);
  if (policy && watch.policyTopic !== room.topic && room.ownerId === room.self.memberId) {
    policy = { ...policy, at: Math.max(Date.now(), policy.at + 1), sig: '' };
    policy.sig = signBytes(room, Buffer.from(watchPolicyCanonical(room.topic, policy)));
    if (watch.host.accept(policy, room.ownerId, Date.now(), room.transferAt)) watch.policyTopic = room.topic;
    else policy = undefined;
  }
  const m: any = {
    t: 'hello', manifestFull: full,
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
    ...(room.topicMsg ? { topicMsg: room.topicMsg } : {}), // the SIGNED topic — receivers re-verify
    ownerId: room.ownerId, // so joiners learn who the owner is
    e2e: room.e2e, // E2E mode + content key ride the encrypted gossip channel
    secret: room.secret,
    ...(room.e2eCfg ? { cfg: room.e2eCfg } : {}), // owner-signed config, re-served for joiners
    ...(room.banState?.ownerId === room.ownerId ? { banState: room.banState } : {}),
    ...(policy && watch.policyTopic === room.topic ? { watchPolicy: policy } : {}),
    ...(room.transferChain.length ? { transferChain: room.transferChain } : {}), // ownership-transfer chain — lets a joiner walk pin → current owner
    ...(room.fileReacts.size ? { fileReacts: reactsToRecord(room) } : {}), // late joiners union this in
    ...(room.chatReacts.size ? { chatReacts: chatReactsToRecord(room) } : {}),
    ...(room.chatEdits.size ? { chatEdits: chatEditsToRecord(room) } : {}), // author-signed edits — receivers re-verify
    ...(room.folders.size ? { folders: Array.from(room.folders.values()) } : {}), // section overlay
    ...(room.folderTombstones.size ? { folderTombs: Object.fromEntries(room.folderTombstones) } : {}), // deleted sections
    // Legacy clock retained only for older clients; v2 reconciles by ID.
    chatSync: 2, watchSync: 2, protocolVersion: ROOM_PROTOCOL_VERSION, capabilities: [...DESKTOP_ROOM_CAPABILITIES],
    chatIds: room.chat.filter(m => m.chatV === 2).map(m => m.id),
    ...(room.chat.length ? { chatAt: room.chat[room.chat.length - 1].at } : {}),
  };
  if (!full) {
    // Slim greet for a wire we haven't identified yet: NO content secret,
    // keyring, manifest, tombstones or reactions until the peer's hello proves
    // a known, non-banned identity (a kicked member on a leaked code must not
    // receive the rotated secret just by connecting). The full hello follows
    // as a reply once the peer identifies (see case 'hello').
    m.secret = ''; m.files = []; m.have = []; m.tombs = [];
    delete m.tombsAt; delete m.tombSigs; delete m.cfg; delete m.fileReacts;
    delete m.chatReacts; delete m.chatEdits; delete m.folders; delete m.folderTombs; delete m.chatAt; delete m.chatIds;
    // Public owner/ban proofs may be sent before identification so an excluded
    // profile can learn its status without receiving secrets or file metadata.
    if (!m.banState) delete m.transferChain;
  }
  return currentHelloProofs(m, room.topic, room.transferChain[0]?.by || room.ownerPin || room.ownerId, p => {
    if (room.bans.has(p.memberId) && !p.chainLink || deriveMemberId(p.pub) !== p.memberId) return false;
    try { return crypto.verify(null, p.bytes, crypto.createPublicKey(p.pub), Buffer.from(p.sig, 'base64')); }
    catch { return false; }
  }) as Msg;
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

/** Bytes the owner signs over the keyring (separate from the v1 canonical —
 *  extending THAT would fail verification on <=2.24 peers and lose them the
 *  current secret too). */
function e2ePrevCanonical(topic: string, ownerId: string, prevSecrets: string[]): Buffer {
  return Buffer.from(JSON.stringify(['th-room-e2e-prev:v1', topic, ownerId, prevSecrets]), 'utf8');
}

const LEGACY_PREV_SECRETS = 8;

/** Owner only: mint the signed E2E config for the room's CURRENT topic. */
function signE2ECfg(room: Room): E2ECfg | null {
  const body = { ownerId: room.self.memberId, e2e: room.e2e, secret: room.secret };
  try {
    const key = crypto.createPrivateKey(room.self.priv);
    const sig = crypto.sign(null, e2eCanonical(room.topic, body), key).toString('base64');
    const cfg: E2ECfg = { ...body, pub: room.self.pub, sig };
    if (room.prevSecrets.length) {
      const prev = room.prevSecrets.slice(0, LEGACY_PREV_SECRETS);
      cfg.prevSecrets = prev;
      cfg.prevSig = crypto.sign(null, e2ePrevCanonical(room.topic, room.self.memberId, prev), key).toString('base64');
    }
    room.keyPages = mintKeyPages(room.topic, cfg, room.prevSecrets, room.self.priv);
    room.keyRequestedAt.clear(); room.keySentAt.clear();
    return cfg;
  } catch (e) { log('e2e cfg sign failed: ' + String(e)); return null; }
}

/** Validate a cfg's OPTIONAL keyring part; [] when absent or unverifiable. */
function verifiedPrevSecrets(room: Room, cfg: E2ECfg): string[] {
  if (!Array.isArray(cfg.prevSecrets) || !cfg.prevSecrets.length || typeof cfg.prevSig !== 'string') return [];
  const prev = cfg.prevSecrets.slice(0, LEGACY_PREV_SECRETS).map((x) => clampStr(x, MAX_SECRET)).filter(Boolean);
  if (!prev.length) return [];
  try {
    const ok = crypto.verify(null, e2ePrevCanonical(room.topic, cfg.ownerId, prev), crypto.createPublicKey(cfg.pub), Buffer.from(cfg.prevSig, 'base64'));
    if (!ok) { log('e2e keyring bad signature — ignored (current secret still adopted)'); return []; }
  } catch { return []; }
  return prev;
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
  if (cfg.keys && !verifyKeyMetadata(room.topic, cfg)) return false;
  if (!cfg.ownerId || !cfg.pub || !cfg.sig || typeof cfg.e2e !== 'boolean' || typeof cfg.secret !== 'string') return false;
  // A past owner is a recovery source until the current owner establishes cfg.
  // It cannot replace a current owner's history or change an already verified key.
  if (room.e2eSigned && room.ownerId && cfg.ownerId !== room.ownerId
    && (room.e2eCfg?.ownerId === room.ownerId || room.secret && cfg.secret !== room.secret)) {
    log('past-owner E2E config cannot replace the current authenticated state'); return false;
  }
  // Same crypto anchor as every other signed command: the ownerId must be the
  // hash of the signing key, so a forged cfg can't poison the owner's binding
  // (which would then reject the REAL owner's config and rekeys).
  if (!idMatchesPub(cfg.ownerId, cfg.pub)) { log('e2e cfg id not derived from pub — dropped'); return false; }
  // With an invite owner pin, ONLY the pinned owner's config counts — otherwise a
  // hostile member reaching a fresh joiner first could plant a wrong E2E secret
  // (a decrypt-DoS) even though the pin blocks it from being adopted as owner.
  // A PAST owner on the verified transfer chain also counts: the content secret
  // never rotates on transfer, so a previous owner's signed config still
  // authenticates it — the recovery path that lets a new owner (or a joiner)
  // learn the secret before the new owner re-mints its own config. Ownership is
  // not rolled back to a past owner (maybeAdoptE2E gates that on ownerPinAllows).
  if (!ownerChainAllows(room, cfg.ownerId)) { log('e2e cfg owner neither pinned nor a chain owner — dropped'); return false; }
  // If a signed config already established the CURRENT owner, only that same owner
  // counts — but a past chain owner's config still passes above for the secret.
  if (room.e2eSigned && room.ownerId && cfg.ownerId !== room.ownerId && !room.transferChain.some((l) => l.by === cfg.ownerId || l.newOwnerId === cfg.ownerId)) {
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
  try { ipcRenderer.send('room-e2e', { roomId: room.roomId, e2e: room.e2e, secret: room.secret, prevSecrets: room.prevSecrets, keyPages: room.keyPages, cfg: room.e2eCfg }); } catch { /* ignore */ }
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
      if (room.secret) {
        log('e2e secret corrected by owner-signed config');
        // Keep the secret we legitimately held: the cfg's keyring rides outside
        // the v1 signature and can be stripped in transit (or by an old relay's
        // clamp) — a key we already trusted needs no signature to stay usable.
        room.prevSecrets = mergeContentKeys(cfg.secret, [room.secret], room.prevSecrets);
      }
      room.secret = cfg.secret;
      changed = true;
    }
    // Merge the separately verified compatibility list with locally held keys.
    // A stripped list cannot discard old keys that we already trusted.
    const prev = verifiedPrevSecrets(room, cfg);
    if (prev.length) {
      // Verified list first (owner order), then any locally-held keys it lacks.
      const merged = mergeContentKeys(room.secret, prev, room.prevSecrets);
      if (JSON.stringify(merged) !== JSON.stringify(room.prevSecrets)) {
        room.prevSecrets = merged;
        changed = true;
      }
    }
    if (!room.e2eSigned || room.e2eCfg?.sig !== cfg.sig || cfg.keys && room.e2eCfg?.keys?.root !== cfg.keys.root) {
      if (cfg.keys && !verifyKeyMetadata(room.topic, cfg)) return;
      // A stripped extension cannot discard an authenticated history we already hold.
      if (!(room.e2eCfg?.keys && !cfg.keys && room.e2eCfg.sig === cfg.sig)) {
        const keep = room.keyPages.filter(p => verifyKeyPage(room.topic, cfg, p));
        room.e2eCfg = cfg; room.keyPages = keep; room.keyRequestedAt.clear(); room.keySentAt.clear();
      }
      room.e2eSigned = true; changed = true;
    }
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
  // Late E2E-config mint for a new owner: an ownership transfer can make us the
  // owner while we still lack the secret (a member never synced in an -e2e room),
  // so adoptChain's mint was skipped. Once we DO hold the secret (learned just
  // above from a PAST owner's still-valid config), mint our OWN config and
  // re-greet so peers converge onto it — otherwise no one ever serves a config
  // that names the current owner and future joiners can't authenticate the secret.
  let remintOwner = false;
  if (room.ownerId === room.self.memberId && room.e2e && room.secret &&
      (!room.e2eCfg || room.e2eCfg.ownerId !== room.self.memberId) && completeContentKeys(room.e2eCfg, room.secret, room.prevSecrets)) {
    const mine = signE2ECfg(room);
    if (mine) { room.e2eCfg = mine; room.e2eSigned = true; changed = true; remintOwner = true; }
  }
  if (changed) {
    persistE2E(room);
    // A just-learned (or corrected) secret may unblock ciphertext we already hold.
    if (room.secret) void decryptPending(room);
    pushState(room);
  }
  if (remintOwner) broadcast(room, helloMsg(room));
  requestKeyPages(room);
}

function requestKeyPages(room: Room): void {
  const keys = room.e2eCfg?.keys;
  if (!keys || !room.wires.size || room.e2eCfg?.ownerId === room.self.memberId) return;
  for (let page = 0; page < keys.pages; page++) {
    if (room.keyPages.some(p => p.page === page)) continue;
    if (Date.now() - (room.keyRequestedAt.get(page) ?? -Infinity) < 10_000) continue;
    room.keyRequestedAt.set(page, Date.now());
    broadcast(room, { t: 'e2e-key-request', memberId: room.self.memberId, root: keys.root, page });
  }
}
function adoptKeyPage(room: Room, page: RoomKeyPage): void {
  const cfg = room.e2eCfg;
  if (!cfg || !verifyKeyPage(room.topic, cfg, page) || room.keyPages.some(p => p.page === page.page)) return;
  const clean: RoomKeyPage = { t: 'e2e-keys', ownerId: page.ownerId, epoch: page.epoch, root: page.root, page: page.page, total: page.total, entries: page.entries.map(e => ({ epoch: e.epoch, secret: e.secret })), pub: page.pub, sig: page.sig };
  const pages = [...room.keyPages, clean];
  // Every page has an owner signature; the complete list must also match its signed root.
  if (pages.length === cfg.keys!.pages && !completeKeyPages(cfg, pages)) return;
  const prev = mergeContentKeys(room.secret, page.entries.map(e => e.secret), room.prevSecrets);
  room.keyPages = pages; room.prevSecrets = prev;
  if (room.ownerId === room.self.memberId && completeContentKeys(cfg, room.secret, room.prevSecrets)) {
    const mine = signE2ECfg(room);
    if (mine) { room.e2eCfg = mine; room.e2eSigned = true; broadcast(room, helloMsg(room)); }
  }
  persistE2E(room); void decryptPending(room); pushState(room);
}

// Storage bookkeeping belongs to the room session and is never sent to peers.
type ReceiveLease = { release: () => void; holding: boolean; disk?: () => void; timer?: ReturnType<typeof setTimeout> };
let queuePushPending = false;
const receiveQueue = new RoomReceiveQueue(2, 512, () => {
  if (queuePushPending) return;
  queuePushPending = true;
  queueMicrotask(() => { queuePushPending = false; for (const room of rooms.values()) pushState(room, true); });
});
const diskBudget = new RoomDiskBudget();
type FileStorageState = {
  receives: Map<string, ReceiveLease>;
  stopping: Map<string, Promise<void>>;
  metadata: Map<string, Buffer>; originals: Set<string>;
  proofs: Map<string, { path: string; stamp: string }>;
  pending: Map<string, Promise<void>>; decrypting: Map<string, Promise<void>>;
  epochs: Map<string, number>;
  partialPaths: Map<string, string>;
  decryptKeys: Map<string, string>; // digest of the last attempted keyring, local only
};
const roomStorage = new WeakMap<Room, FileStorageState>();
function storageFor(room: Room): FileStorageState {
  let state = roomStorage.get(room);
  if (!state) {
    state = { receives: new Map(), stopping: new Map(), metadata: new Map(), originals: new Set(), proofs: new Map(), pending: new Map(), decrypting: new Map(), epochs: new Map(), partialPaths: new Map(), decryptKeys: new Map() };
    roomStorage.set(room, state);
  }
  return state;
}
function currentFile(room: Room, file: RoomFile, epoch = storageFor(room).epochs.get(file.fileId) ?? 0, localOnly = false): boolean {
  return rooms.get(room.roomId) === room && room.files.get(file.fileId) === file
    && !room.kicked && (localOnly || (!netSuspended && !room.transfers.get(file.fileId)?.released))
    && (storageFor(room).epochs.get(file.fileId) ?? 0) === epoch
    && !isTombstonedAt(room, file.fileId, file.addedAt);
}
function releaseReceive(room: Room, fileId: string): void { storageFor(room).receives.get(fileId)?.release(); }
function cancelReceives(room: Room): void {
  for (const id of [...storageFor(room).receives.keys()]) releaseReceive(room, id);
  receiveQueue.cancel(room);
}
function cancelFileOperation(room: Room, fileId: string, holdReceive = false): void {
  if (holdReceive) receiveQueue.cancelWaiting(room, fileId);
  else { releaseReceive(room, fileId); receiveQueue.cancel(room, fileId); }
  const state = storageFor(room);
  state.epochs.set(fileId, (state.epochs.get(fileId) ?? 0) + 1);
  state.pending.delete(fileId); state.decrypting.delete(fileId);
}
function rememberPlaintext(room: Room, fileId: string, localPath: string, expectedStamp = roomFileStamp(localPath)): void {
  const stamp = roomFileStamp(localPath);
  if (!stamp || stamp !== expectedStamp) throw new Error('Room file no longer exists or changed after verification');
  storageFor(room).proofs.set(fileId, { path: localPath, stamp });
  setTransfer(room, fileId, { localStamp: stamp });
}
function fileFailure(room: Room, file: RoomFile, stage: RoomFileError['stage'], cause: unknown, patch: Partial<RoomTransfer> = {}): void {
  const err = cause as { code?: string; message?: string };
  const message = String(err?.message || cause).slice(0, 1000);
  const code: RoomFileError['code'] = err?.code === 'ENOSPC' ? 'disk-full'
    : err?.code === 'ENOENT' ? 'missing-file'
    : ['EACCES', 'EPERM'].includes(err?.code || '') ? 'permission'
    : stage === 'decryption' && /authenticate|bad decrypt|matching room key/i.test(message) ? 'authentication'
    : stage === 'local-file' || /changed|does not match|unexpected size|length mismatch/i.test(message) ? 'changed-file' : 'failed';
  storageFor(room).proofs.delete(file.fileId);
  closeStreamServers(room.roomId, file.fileId);
  setTransfer(room, file.fileId, { ...patch, status: 'error', phase: 'error', haveLocally: false, localStamp: undefined,
    error: { stage, code, message } });
  persistManifest(room, file);
  pushState(room, true);
}
function verifiedLocalFile(roomId: string, fileId: string): string {
  const room = rooms.get(roomId);
  const tr = room?.transfers.get(fileId);
  const proof = room && storageFor(room).proofs.get(fileId);
  if (room && tr?.haveLocally && proof && proof.path === tr.localPath && roomFileStamp(proof.path) === proof.stamp) return proof.path;
  if (room && tr?.haveLocally) {
    const file = room.files.get(fileId);
    if (file) fileFailure(room, file, 'local-file', new Error('This file has changed or is missing on disk'));
    const t = clients.get(roomId) && findTorrent(clients.get(roomId), fileId);
    if (t) void Promise.resolve(clients.get(roomId)?.remove(t)).catch(e => log('changed file release failed: ' + String(e)));
    pushState(room, true);
  }
  throw new Error('This file is not verified or has changed on disk. Fetch or share it again.');
}
function decryptKeyStamp(room: Room): string {
  return crypto.createHash('sha256').update([room.secret, ...room.prevSecrets].filter(Boolean).join(':')).digest('hex');
}

/** Authenticate into a fresh fileId slot. Parallel requests share one operation. */
function decryptOne(room: Room, file: RoomFile, cipherPath: string, checked?: { metadata: Buffer; stamp: string }): Promise<void> {
  const state = storageFor(room);
  const pending = state.decrypting.get(file.fileId);
  if (pending) return pending;
  const epoch = state.epochs.get(file.fileId) ?? 0;
  const isCurrent = () => currentFile(room, file, epoch, true);
  let attemptedKeys: string[] = [];
  const job = (async () => {
    if (!isCurrent()) return;
    setTransfer(room, file.fileId, { phase: 'verifying', status: 'done', haveLocally: false, error: undefined, downSpeed: 0 });
    pushState(room, true);
    let plain: string | undefined;
    let stage: RoomFileError['stage'] = 'verification';
    let cipherStamp: string | undefined;
    let releaseDisk: (() => void) | undefined;
    try {
      cipherStamp = roomFileStamp(cipherPath);
      // The download completion path just streamed the hashes. Reuse that
      // proof only while the exact filesystem identity is unchanged; manual
      // retry always checks the cached bytes afresh.
      if (checked && checked.stamp !== cipherStamp) throw new Error('Encrypted copy changed after verification');
      const metadata = checked?.metadata ?? await verifyRoomFile(cipherPath, file, state.metadata.get(file.fileId));
      if (!isCurrent()) return;
      if (!cipherStamp || roomFileStamp(cipherPath) !== cipherStamp) throw new Error('Encrypted copy changed during verification');
      state.metadata.set(file.fileId, metadata);
      setTransfer(room, file.fileId, { progress: 1, cipherReady: true, cipherPath, phase: 'ciphertext-ready' });
      // Snapshot keys for this operation: config/key rotation can arrive while
      // the disk pipeline runs. A later config update can retry with new keys.
      const secrets = [room.secret, ...room.prevSecrets].filter((s): s is string => !!s && (!file.keyEpoch || contentKeyEpoch(s) === file.keyEpoch));
      attemptedKeys = secrets;
      state.decryptKeys.set(file.fileId, decryptKeyStamp(room));
      if (!secrets.length) {
        setTransfer(room, file.fileId, { phase: 'waiting-key' });
        persistManifest(room, file); pushState(room, true); return;
      }
      stage = 'decryption';
      setTransfer(room, file.fileId, { phase: 'decrypting' });
      persistManifest(room, file); pushState(room, true);
      if (!state.receives.has(file.fileId)) {
        fs.mkdirSync(room.folder, { recursive: true });
        releaseDisk = diskBudget.reserve([{ root: room.folder, bytes: file.size }]);
      }
      plain = newRoomFilePath(room.folder, file.fileId, roomDiskName({ name: file.name }));
      let done = false, lastErr: unknown;
      for (const secret of secrets) {
        try { await decryptFile(cipherPath, plain, secret, { isCurrent, expectedSize: file.size }); done = true; if (!file.keyEpoch) file.keyEpoch = contentKeyEpoch(secret); break; }
        catch (error) {
          lastErr = error;
          if (!isCurrent() || !/authenticate|bad decrypt/i.test(String(error))) throw error;
        }
      }
      if (!done) throw lastErr ?? new Error('No matching room key');
      if (!isCurrent()) { await fs.promises.rm(plain, { force: true }); return; }
      if (roomFileStamp(cipherPath) !== cipherStamp) { stage = 'verification'; throw new Error('Encrypted copy changed during decryption'); }
      let selected = plain, stamp = roomFileStamp(plain);
      const prior = room.transfers.get(file.fileId)?.localPath;
      if (prior && (state.originals.has(file.fileId) || isManagedRoomPath(room.folder, file.fileId, prior))) {
        const matching = await matchingRoomPlaintext(prior, plain).catch(() => undefined);
        if (!isCurrent()) { await fs.promises.rm(plain, { force: true }); return; }
        if (matching) {
          await fs.promises.rm(plain, { force: true });
          selected = prior; stamp = matching;
        }
      }
      if (!isCurrent()) { await fs.promises.rm(plain, { force: true }); return; }
      if (roomFileStamp(cipherPath) !== cipherStamp) { stage = 'verification'; throw new Error('Encrypted copy changed before publication'); }
      rememberPlaintext(room, file.fileId, selected, stamp);
      if (selected !== prior) state.originals.delete(file.fileId);
      setTransfer(room, file.fileId, { progress: 1, phase: 'ready', status: room.transfers.get(file.fileId)?.released ? 'done' : 'seeding', haveLocally: true, error: undefined, localPath: selected, cipherPath });
      persistManifest(room, file, selected, cipherPath);
      broadcast(room, { t: 'have', memberId: room.self.memberId, fileId: file.fileId });
      pushState(room, true);
    } catch (error) {
      if (plain) await fs.promises.rm(plain, { force: true }).catch(() => {});
      if (!isCurrent()) return;
      const changedCipher = stage === 'decryption' && roomFileStamp(cipherPath) !== cipherStamp;
      if (changedCipher) stage = 'verification';
      const failure = changedCipher ? new Error('Encrypted copy changed or is missing during decryption') : error;
      state.proofs.delete(file.fileId);
      fileFailure(room, file, stage, failure, { cipherPath, ...(stage === 'verification' ? { cipherReady: false } : {}) });
      if (stage === 'verification') {
        const c = clients.get(room.roomId), t = c && findTorrent(c, file.infoHash);
        if (t) void Promise.resolve(c.remove(t)).catch(e => log('invalid ciphertext release failed: ' + String(e)));
      }
      log('e2e decrypt failed: ' + String(failure));
    } finally { releaseDisk?.(); }
  })();
  state.decrypting.set(file.fileId, job);
  void job.finally(() => {
    if (state.decrypting.get(file.fileId) !== job) return;
    state.decrypting.delete(file.fileId);
    // A config update that arrived mid-pipeline joined this job. Try once with
    // newly available keys after it finishes, rather than losing that update.
    if (isCurrent() && (room.transfers.get(file.fileId)?.error?.code === 'authentication' || room.transfers.get(file.fileId)?.phase === 'waiting-key')
      && [room.secret, ...room.prevSecrets].some(key => key && !attemptedKeys.includes(key))) void decryptOne(room, file, cipherPath);
  });
  return job;
}
/** Retry only the cached bytes; never start a client or re-add a torrent. */
function retryDecrypt(roomId: string, fileId: string): void {
  const room = rooms.get(roomId), file = room?.files.get(fileId);
  if (!room || !file || room.kicked) throw new Error('File not available in this room');
  const tr = room.transfers.get(fileId);
  if (!file.enc || !tr?.cipherReady || !tr.cipherPath) throw new Error('Download the encrypted file before retrying decryption');
  if (tr.haveLocally) { verifiedLocalFile(roomId, fileId); return; }
  void decryptOne(room, file, tr.cipherPath);
}
async function decryptPending(room: Room): Promise<void> {
  if (!room.e2e || !room.secret) return;
  for (const [fileId, tr] of room.transfers) {
    const file = room.files.get(fileId);
    if (!file?.enc || !tr.cipherReady || !tr.cipherPath || !fs.existsSync(tr.cipherPath)) continue;
    try { verifiedLocalFile(room.roomId, fileId); continue; } catch { /* not ready */ }
    if (tr.phase !== 'waiting-key' && !(tr.error?.code === 'authentication'
      && storageFor(room).decryptKeys.get(fileId) !== decryptKeyStamp(room))) continue;
    await decryptOne(room, file, tr.cipherPath);
  }
}

/** Append an activity-log event (in memory + persisted) and refresh the UI. A
 *  caller may pass `at` to stamp the event with its real time (e.g. a transfer
 *  caught up from a chain days later) instead of now. */
function logEvent(room: Room, ev: Omit<RoomEvent, 'id' | 'at'> & { at?: number }): void {
  const { at, ...rest } = ev;
  const full: RoomEvent = { id: crypto.randomBytes(8).toString('hex'), at: at ?? Date.now(), ...rest };
  room.history.push(full);
  if (room.history.length > 200) room.history = room.history.slice(-200);
  const batch = manifestBatches.get(room);
  if (batch) batch.events.push(full);
  else try { ipcRenderer.send('room-history-add', { roomId: room.roomId, event: full }); } catch { /* ignore */ }
  pushState(room);
}

/**
 * Record a chat message (in memory + persisted) and refresh the UI immediately.
 * Idempotent on message id so re-delivery across multiple wires is harmless.
 */
function addChat(room: Room, msg: RoomChatMessage, backfill = false, persisted = false): void {
  const index = room.chat.findIndex(m => m.id === msg.id);
  if (index >= 0) {
    const upgrade = upgradeChat(room.chat[index], msg);
    if (!upgrade) return;
    room.chat[index] = upgrade;
    try { ipcRenderer.send('room-chat-add', { roomId: room.roomId, message: upgrade, backfill: true }); } catch { /* ignore */ }
    pushState(room, true);
    return;
  }
  if (!persisted) msg = { ...msg, receivedAt: Date.now() };
  room.chat.push(msg);
  // A verified edit that arrived before this message (fresh-joiner HELLO ahead of
  // the backfill, or relay reorder) was buffered — apply it now that its target
  // exists. applyChatEdit re-checks authorship against the real message.
  const pending = room.pendingEdits.get(msg.id);
  if (pending) {
    room.pendingEdits.delete(msg.id);
    if (applyChatEdit(room, msg.id, pending)) persistChatEdits(room);
  }
  if (room.chat.length > ROOM_CHAT_LIMIT) {
    room.chat = room.chat.slice(-ROOM_CHAT_LIMIT);
    if (pruneChatReacts(room)) persistChatReacts(room); // aged-out msgs free their cap slots
    if (pruneChatEdits(room)) persistChatEdits(room);   // and their edit overlay
  }
  // `backfill` = historical catch-up (not live) — the main process persists + badges
  // it but does NOT fire an OS notification, so a reconnect can't detonate a toast storm.
  if (!persisted) { try { ipcRenderer.send('room-chat-add', { roomId: room.roomId, message: msg, backfill }); } catch { /* ignore */ } }
  pushState(room, true);
}

/** Clock-independent catch-up, at most four unicast pages. Slim v2 HELLO waits
 * for the full inventory. Older peers receive the retained window once/wire. */
function sendChatBackfill(room: Room, wire: Wire, hello: { chatSync?: number; chatIds?: string[] }): void {
  if (hello.chatSync === 2 && !Array.isArray(hello.chatIds)) return;
  if (hello.chatSync !== 2 && wire.legacyChatSent) return;
  const pages = chatBackfillPages(room.chat, hello.chatSync === 2 ? hello.chatIds : undefined);
  const work = pages.reduce((sum, page) => sum + page.length * 2, 0);
  if (!ingressBudget(ingressByWire, wire).take(0, work) || !ingressBudget(ingressByRoom, room).take(0, work)) return;
  if (hello.chatSync !== 2) wire.legacyChatSent = true;
  for (const page of pages) {
    const msgs = page.filter(m => !room.bans.has(m.memberId) && verifyChat(room, m));
    if (msgs.length) sendTo(room, wire, { t: 'chat-log', msgs });
  }
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
  if (!memberId || !pub || room.identities.has(memberId) || room.identities.size >= ROOM_IDENTITY_LIMIT) return;
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
  if (!memberId || !pub || !sig || (!room.identities.has(memberId) && room.identities.size >= ROOM_IDENTITY_LIMIT)) return false;
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
function verifyChat(room: Room, msg: RoomChatMessage): boolean {
  return verifySignedBy(room, msg.memberId, msg.pub!, msg.sig!, chatCanonical(room.topic, msg))
    && (msg.chatV !== 2 || verifySignedBy(room, msg.memberId, msg.pub!, msg.contextSig!, Buffer.from(chatContextCanonical(room.topic, msg))));
}

/** Stable bytes for a chat EDIT. Domain-tagged ('chat-edit') so an edit signature
 *  can never be replayed as a plain chat/other command. Bound to the target msgId,
 *  the author, the new text, and the edit clock (LWW). */
function editCanonical(topic: string, m: { msgId: string; memberId: string; at: number; text: string }): Buffer {
  return Buffer.from(JSON.stringify(['chat-edit', topic, m.msgId, m.memberId, m.at, m.text]), 'utf8');
}
function verifyEdit(room: Room, msg: { msgId: string; memberId: string; at: number; text: string; pub: string; sig: string }): boolean {
  return verifySignedBy(room, msg.memberId, msg.pub, msg.sig, editCanonical(room.topic, msg));
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

/** Bytes the CURRENT owner signs to hand the room to `newOwnerId`. The chain of
 *  these is what a joiner walks from the invite's pinned FIRST owner to the
 *  current one, so the canonical binds the signer (`by`) explicitly.
 *
 *  The domain is `rootOwnerId` (the chain's GENESIS owner id) — NOT the rotating
 *  `topic`: a kick rotates the code/topic (applyLocalRekey), and unlike e2eCfg /
 *  tombSigs the new owner CANNOT re-mint historical links (they bear previous
 *  owners' keys). A code-derived domain would therefore make the whole persisted
 *  chain unverifiable after any post-transfer kick, permanently orphaning the
 *  room on restart. The genesis owner id is stable for the room's whole life and
 *  every walker knows it (it is the chain root / the pin). Cross-room replay is
 *  bounded: a link only re-applies in another room whose GENESIS owner is the
 *  same identity AND where `by` is currently owner — a same-person-owns-both edge
 *  with no privilege gain (they already control both rooms). See the design doc. */
function transferCanonical(rootOwnerId: string, m: { by: string; newOwnerId: string; at: number }): Buffer {
  return Buffer.from(sharedTransferCanonical(rootOwnerId, m));
}

/** Bytes the owner signs over a topic change (same discipline as rename). */
function topicCanonical(topic: string, m: { text: string; at: number; by: string }): Buffer {
  return Buffer.from(JSON.stringify(['topic', topic, m.text, m.at, m.by]), 'utf8');
}

/** Verify + apply a signed topic (live gossip or a HELLO re-serve). The HELLO
 *  path runs the EXACT same checks — an unsigned bootstrap would let any
 *  member plant an owner-labeled topic on rooms whose owner never set one. */
function applySignedTopic(room: Room, m: { text?: unknown; at?: unknown; by?: unknown; pub?: unknown; sig?: unknown }): boolean {
  const at = Number(m.at) || 0;
  const text = String(m.text ?? '').slice(0, MAX_TOPIC).trim();
  const by = clampStr(m.by, MAX_STR);
  const pub = clampStr(m.pub, MAX_STR * 2);
  const sig = clampStr(m.sig, MAX_STR * 2);
  if (at <= room.topicAt) return false;                        // not newer — ignore
  if (at > Date.now() + 60_000) return false;                  // no future-dated clock wedge
  if (!room.ownerId || by !== room.ownerId) return false;      // only the owner sets the topic
  if (!verifySignedBy(room, by, pub, sig, topicCanonical(room.topic, { text, at, by }))) return false;
  room.topicText = text;
  room.topicAt = at;
  room.topicMsg = { text, at, by, pub, sig };
  try { ipcRenderer.send('room-topic', { roomId: room.roomId, text, at, by, pub, sig }); } catch { /* ignore */ }
  return true;
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
function srvMirrorCanonical(topic: string, m: { hostId: string; at: number; body: string }): Buffer {
  return Buffer.from(JSON.stringify(['srv-mirror', topic, m.hostId, m.at, m.body]), 'utf8');
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
    announce(inVoice: boolean, muted: boolean, at: number, deafened?: boolean): void {
      const sig = signBytes(room, voiceStateCanonical(room.topic, { memberId: room.self.memberId, inVoice, muted, at }));
      // `deafened` rides OUTSIDE the canonical on purpose: adding it to the
      // signed bytes would fail verification on ≤2.24 peers (who'd then drop
      // the whole presence). It's cosmetic — a replayed frame could at worst
      // show a stale headphone glyph, never affect audio or authorization.
      const stateSig = signBytes(room, Buffer.from(voiceStateV2Canonical(room.topic, { memberId: room.self.memberId, inVoice, muted, deafened: deafened === true, at })));
      broadcast(room, { t: 'voice-state', memberId: room.self.memberId, inVoice, muted, deafened: deafened === true, at, pub: room.self.pub, sig, voiceV: 2, stateSig });
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
    onChange(): void { if (refreshFileBudget()) pushResourceStates(); else pushState(room, true); },
    log,
  };
  const session = new VoiceSession(adapter, undefined, () => voiceSettings);
  session.setScreenBitrate(trafficBudget.getPolicy().screenBitrateKbps);
  return session;
}

/** Wire a room's LanSession to the signed, encrypted gossip + the elevated Wintun
 *  helper's named pipe. Genesis/admit/evict are DURABLE (bound to sessionId,
 *  host-signed); state/signal are TRANSIENT (bound to room.topic, survive rekey via
 *  reannounce) — the same split as voice. The LanSession is the routing brain; the
 *  helper stays a dumb ring↔pipe shovel. */
function createLanSession(room: Room, sessionId: string, isHost: boolean): LanSession {
  // Seed the anti-replay watermark ONLY for the exact session this room remembers.
  // A different id (a rotated session, or another host's) has no grants of ours to
  // replay, so it correctly starts from a clean floor.
  const floorSeed = room.lanSession === sessionId ? (room.lanFloor ?? 0) : 0;
  const adapter: LanAdapter = {
    selfId: room.self.memberId,
    iceServers: room.iceServers as RTCIceServer[],
    sessionId,
    isHost,
    sendSignal(to: string, kind: LanSignalKind, data: unknown): void {
      const sig = signBytes(room, lanSignalCanonical(room.topic, { memberId: room.self.memberId, to, kind, data }));
      broadcast(room, { t: 'lan-signal', memberId: room.self.memberId, to, kind, data, pub: room.self.pub, sig });
    },
    announce(vip: number, gen: number, at: number): void {
      const sig = signBytes(room, lanStateCanonical(room.topic, { memberId: room.self.memberId, sessionId, vip, gen, at }));
      broadcast(room, { t: 'lan-state', memberId: room.self.memberId, sessionId, vip, gen, at, pub: room.self.pub, sig });
    },
    admit(member: string, at: number): void {
      const sig = signBytes(room, lanAdmitCanonical(sessionId, { by: room.self.memberId, member, at }));
      broadcast(room, { t: 'lan-admit', sessionId, by: room.self.memberId, member, at, pub: room.self.pub, sig });
    },
    evict(member: string, at: number): void {
      const sig = signBytes(room, lanEvictCanonical(sessionId, { by: room.self.memberId, member, at }));
      broadcast(room, { t: 'lan-evict', sessionId, by: room.self.memberId, member, at, pub: room.self.pub, sig });
    },
    genesis(): void {
      const at = Date.now();
      const sig = signBytes(room, lanGenesisCanonical(sessionId, { by: room.self.memberId, at }));
      broadcast(room, { t: 'lan-genesis', sessionId, by: room.self.memberId, at, pub: room.self.pub, sig });
    },
    reach(peers: string[], relay: boolean, at: number): void {
      // Phase 2B reachability advert. TRANSIENT like lan-state → bound to
      // room.topic (survives rekey by being re-announced from reannounce(), never
      // re-signed), with sessionId carried INSIDE the canonical so a cross-session
      // advert can never poison relay selection. `peers` is already in canonical
      // wire form (LanSession calls normalizeReachList before emitting) — the
      // receiver's clampLanReach NORMALISES, so any other representation would
      // yield bytes the verifier cannot reproduce and the signature would fail.
      const m = { memberId: room.self.memberId, sessionId, at, relay, reach: peers };
      const sig = signBytes(room, lanReachCanonical(room.topic, m));
      broadcast(room, { t: 'lan-reach', ...m, pub: room.self.pub, sig });
    },
    reip(vip: number, gen: number): void {
      // Collision loss → flap our Wintun adapter to the new vip via the helper
      // (must-fix #6). The helper's applyReip re-assigns the address; without it
      // the loser's tunnel black-holes.
      try { room.lanPipe?.sendControl({ t: 'reip', vip: vip >>> 0, gen: gen & 0xffff }); } catch { /* ignore */ }
    },
    persistFloor(at: number): void {
      // Keep the in-process copy in step FIRST: a session re-created later in this
      // same run (Stop → Start, or a passive session superseded by a real one)
      // reads room.lanFloor, and main's write is asynchronous. Same adopt-or-raise
      // rule main applies (shared/lan-prefs noteSessionFloor), so the two copies
      // cannot disagree: adopt when this room tracks no session, raise when it is
      // ours, ignore another session entirely.
      if (!room.lanSession) { room.lanSession = sessionId; room.lanFloor = at; }
      else if (room.lanSession === sessionId && at > (room.lanFloor ?? 0)) room.lanFloor = at;
      try { ipcRenderer.send('room-lan-floor', { roomId: room.roomId, sessionId, at }); } catch { /* ignore */ }
    },
    sendPacket(frame: Buffer): void { room.lanPipe?.send(frame); },   // inbound peer→us → helper → Wintun ring
    onPacket(handler: (frame: Buffer) => void): void { room.lanEgress = handler; }, // TUN-egress router
    onChange(): void { pushState(room, true); },
    warn(msg: string): void { try { ipcRenderer.send('room-lan-warn', { msg }); } catch { /* ignore */ } },
    log,
  };
  return new LanSession(adapter, Date.now, floorSeed);
}

/** Return room.lan, lazily creating a PASSIVE joiner session (no helper/pipe, not
 *  started) for `sessionId` so an incoming host-signed lan-genesis/lan-admit is
 *  tracked BEFORE the user accepts — otherwise the joiner drops that gossip and
 *  can never learn the session to join. A different sessionId supersedes (beta =
 *  one session per install). The reused pipe/start happen later in lanStart. */
function ensureLanSession(room: Room, sessionId: string, isHost = false): LanSession {
  if (room.lan && room.lan.sessionId() === sessionId) return room.lan;
  if (room.lan) teardownLan(room);
  room.lan = createLanSession(room, sessionId, isHost);
  return room.lan;
}

/** Cooperative + defensive LAN teardown: stop the session and close the helper pipe
 *  (asks the helper to revert its adapter/route/firewall via the shutdown verb). */
function teardownLan(room: Room): void {
  // Reject anything still waiting on the helper FIRST — a Stop during a diagnose
  // would otherwise leave the renderer's reply hanging until RoomManager's own
  // timeout (the pipe is about to close and no answer can arrive).
  if (room.lanReq) {
    for (const p of room.lanReq.values()) {
      clearTimeout(p.timer);
      try { p.reject(new Error('The LAN session ended')); } catch { /* ignore */ }
    }
    room.lanReq.clear();
  }
  if (room.lan) { try { room.lan.suspend(); } catch { /* ignore */ } room.lan = undefined; }
  if (room.lanPipe) {
    try { room.lanPipe.sendControl({ t: 'shutdown' }); } catch { /* ignore */ }
    try { room.lanPipe.close(); } catch { /* ignore */ }
    room.lanPipe = undefined;
  }
  room.lanEgress = undefined;
  settleLanReady(room, false); // nobody may wait on a helper that is going away
  room.lanReady = undefined;
}

/**
 * Settle everyone waiting on helper readiness. Called with `true` from the 'ready'
 * control frame and with `false` from teardown, so a waiter can never outlive the
 * session it is waiting for (a hung await here would hold an IPC reply open until
 * RoomManager's own timeout fired, which reads to the user as a frozen action).
 */
function settleLanReady(room: Room, ok: boolean): void {
  if (ok) room.lanReady = true;
  const waiters = room.lanReadyWaiters;
  if (!waiters || waiters.length === 0) return;
  room.lanReadyWaiters = [];
  for (const w of waiters) { try { w(ok); } catch { /* ignore */ } }
}

/**
 * How long a helper request may wait for the elevated setup to finish. Sized
 * against the helper's own PowerShell setup pass (adapter + IP + MTU + routes +
 * firewall), not against the UAC prompt — the prompt is already over by the time
 * a pipe exists to wait on. A setup that FAILS does not burn this budget: the
 * helper's {t:'error'} tears down, and teardown settles every waiter at once.
 *
 * It is deliberately small enough that this wait PLUS the 20 s helper request
 * stays inside RoomManager's own call timeouts — otherwise a caller would give up
 * on a request that then succeeds, and the user would see an error for a rule
 * that in fact exists.
 */
const LAN_READY_WAIT_MS = 10_000;

/**
 * Resolve once the elevated helper has actually finished its setup — NOT merely
 * once the pipe is connected.
 *
 * LanPipeClient.connect() resolves as soon as the socket is up and hello is
 * written, which is BEFORE the helper has created the adapter, assigned the IP and
 * installed the routes/firewall. Anything that asks the helper to mutate the
 * network in that window is answered 'session not ready' — which is exactly the
 * window in which the remembered per-game firewall rules are re-applied right
 * after a Start. Returns false on timeout / teardown rather than throwing: the
 * caller turns that into an honest ok:false, never into a helper error (that arm
 * tears the tunnel down).
 */
function lanHelperReady(room: Room, timeoutMs: number): Promise<boolean> {
  if (room.lanReady) return Promise.resolve(true);
  if (!room.lanPipe) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const settle = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
    (room.lanReadyWaiters ??= []).push(settle);
    setTimeout(() => settle(false), timeoutMs);
  });
}

/** Control-plane frames from the helper (ready / error / ping + the Phase-2A
 *  correlated results). */
function onLanControl(room: Room, m: LanControlMsg): void {
  if (m.t === 'error') {
    try { ipcRenderer.send('room-lan-warn', { msg: m.message || ('LAN helper error: ' + m.code) }); } catch { /* ignore */ }
    teardownLan(room);
    pushState(room, true);
  } else if (m.t === 'ready') {
    log('lan helper ready: adapter=' + m.adapter + ' vip=' + m.vip);
    settleLanReady(room, true);
  } else if (m.t === 'ping') {
    try { room.lanPipe?.sendControl({ t: 'pong' }); } catch { /* ignore */ }
  } else if (m.t === 'diag-result') {
    settleLanRequest(room, m.id, m.facts);
  } else if (m.t === 'allow-app-result') {
    settleLanRequest(room, m.id, m);
  }
}

/** Phase-2A correlated request over the helper control channel. The Phase-1 verbs
 *  are fire-and-forget; 'diag' / 'allow-app' carry a uint32 id the helper echoes
 *  on its result frame. LanPipeClient.sendControl is void and swallows errors, so
 *  the missing-pipe case is rejected here rather than waiting out the timeout. */
function lanRequest<T>(room: Room, make: (id: number) => LanControlMsg, timeoutMs: number): Promise<T> {
  const pipe = room.lanPipe;
  if (!pipe) return Promise.reject(new Error('The LAN helper is not connected'));
  const pending = room.lanReq ?? (room.lanReq = new Map());
  const id = (((room.lanReqSeq ?? 0) + 1) >>> 0) || 1;
  room.lanReqSeq = id;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The LAN helper did not answer'));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    try {
      pipe.sendControl(make(id));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(String(e)));
    }
  });
}

/** Resolve the pending request `id` (unknown/late ids are ignored, not fatal). */
function settleLanRequest(room: Room, id: number, value: unknown): void {
  const p = room.lanReq?.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  room.lanReq?.delete(id);
  p.resolve(value);
}

/** Engine half of the connectivity report (Phase 2A item C): session + per-peer
 *  facts read from the LAST stats poll, plus whatever only the elevated helper can
 *  see (adapter/vIP/MTU/firewall). Main merges its own facts (driver probe, helper
 *  liveness) and runs the pure evaluator — nothing here judges anything. A helper
 *  that does not answer degrades the report to 'unknown' rows, never to an error. */
async function lanDiagnose(roomId: string): Promise<Partial<LanDiagInput>> {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  const st = room.lan ? room.lan.getState() : undefined;
  const out: Partial<LanDiagInput> = {
    active: st?.active === true,
    blocked: netSuspended,
    peers: room.lan ? room.lan.peerDiagnostics() : [],
    ...(st?.selfVip ? { selfVip: st.selfVip } : {}),
    ...(st?.subnet ? { subnet: st.subnet } : {}),
    ...(typeof st?.turnConfigured === 'boolean' ? { turnConfigured: st.turnConfigured } : {}),
  };
  if (room.lanPipe) {
    try {
      const f = await lanRequest<LanHelperFacts>(room, (id) => ({ t: 'diag', id }), 8000);
      out.adapterName = f.adapterName || undefined;
      out.adapterPresent = f.adapterPresent;
      out.adapterUp = f.adapterUp;
      out.expectedVip = f.expectedVip || undefined;
      out.mtu = f.mtu || undefined;
      out.firewallRuleCount = Array.isArray(f.firewallRules) ? f.firewallRules.length : undefined;
      if (!out.subnet && f.subnet) out.subnet = f.subnet;
    } catch (e) {
      log('lan diag: helper query failed: ' + String(e)); // leaves those rows 'unknown'
    }
  }
  return out;
}

/** Engine half of the firewall troubleshooter (Phase 2A item D). The path was
 *  chosen by a MAIN-process picker — or replayed from this room's remembered game
 *  list right after a Start — and re-validating it here is defence in depth: the
 *  elevated helper validates it again before it reaches PowerShell. A refusal
 *  comes back as ok:false, NEVER as a helper {t:'error'} (that arm tears the
 *  tunnel down).
 *
 *  The helper's error CODE is passed through untouched because main uses it to
 *  decide whether a remembered game should be FORGOTTEN: 'bad-app-path' means the
 *  .exe is gone or was rejected and will fail identically forever, while every
 *  other code ('firewall', a not-ready session, a PowerShell hiccup) is transient
 *  and must not cost the user their saved rule. */
async function lanAllowApp(roomId: string, exePath: string): Promise<{ ok: boolean; exe?: string; rule?: string; code?: string; error?: string }> {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  if (!room.lanPipe) throw new Error('The LAN session is not running');
  const v = validateGameExePath(exePath);
  if (!v.ok) return { ok: false, exe: exePath, code: 'bad-app-path', error: 'Rejected executable path (' + v.reason + ')' };
  // A rule asked for in the window between "pipe connected" and "helper finished
  // its elevated setup" is answered 'session not ready'; wait that window out.
  if (!(await lanHelperReady(room, LAN_READY_WAIT_MS))) {
    return { ok: false, exe: v.path, error: 'The LAN helper is not ready yet' };
  }
  if (!room.lanPipe) throw new Error('The LAN session is not running'); // torn down while waiting
  const r = await lanRequest<{ ok: boolean; rule?: string; code?: string; message?: string }>(
    room, (id) => ({ t: 'allow-app', id, exe: v.path }), 20000,
  );
  return r.ok
    ? { ok: true, exe: v.path, rule: r.rule }
    : { ok: false, exe: v.path, ...(r.code ? { code: r.code } : {}), error: r.message || 'The firewall rule was refused' };
}

/** Handle a 'lanStart' room-cmd: build the LanSession, dial the helper pipe, then
 *  (host) pin genesis + admit picks or (joiner) begin participating. Re-checks the
 *  VPN kill-switch after the connect await — the UAC prompt is an unbounded window
 *  (mirrors voiceJoin's re-check-and-undo). */
async function lanStart(roomId: string, opts: { sessionId: string; pipeName: string; token: string; subnet?: string; admit?: string[]; isHost?: boolean; relayEnabled?: boolean; floor?: number }): Promise<{ ok: boolean; sessionId: string }> {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  if (netSuspended) throw new Error('Rooms are paused: the VPN is down (kill-switch)');
  const isHost = opts.isHost === true;
  const sid = String(opts.sessionId || '');
  // Main is authoritative about which session this room re-enters and what its
  // watermark is — it read both from disk moments ago, and either may have moved
  // since the join payload was built (a Start reuses an id, an evict rotates it).
  // Adopt them BEFORE any session is created, since createLanSession seeds from
  // these fields. Never LOWER a floor the running engine already advanced past.
  const floor = Number(opts.floor);
  if (room.lanSession !== sid) { room.lanSession = sid; room.lanFloor = 0; }
  if (Number.isSafeInteger(floor) && floor > (room.lanFloor ?? 0)) room.lanFloor = floor;
  // Phase 2B willingness travels ON the start payload (main reads the persisted
  // AppSetting) rather than relying on a separate push, so a session can never
  // come up relaying when the user has switched it off — including on the reused
  // passive joiner session below, which was constructed before the toggle existed.
  if (typeof opts.relayEnabled === 'boolean') lanRelayEnabled = opts.relayEnabled;
  // Joiner: REUSE the passive session already bootstrapped from the host's gossip
  // (it holds the pinned host + admittedSet — tearing it down would lose them and
  // the mesh could never come up). Host or a different session → fresh.
  let session: LanSession;
  if (!isHost && room.lan && room.lan.sessionId() === sid) {
    session = room.lan;
  } else {
    teardownLan(room); // single active session per install (beta) — replace any prior
    session = createLanSession(room, sid, isHost);
    room.lan = session;
  }
  // Arm the readiness latch BEFORE the pipe exists, and after any teardown above
  // (which clears it) — the joiner-reuse branch does not tear down, so a stale
  // `true` from an earlier start would otherwise let a request through early.
  room.lanReady = false;
  room.lanReadyWaiters = [];
  const client = new LanPipeClient({
    pipeName: String(opts.pipeName || ''),
    token: String(opts.token || ''),
    onData: (frame) => { if (rooms.get(roomId) !== room || room.lanPipe !== client) return; try { room.lanEgress?.(frame); } catch (e) { log('lan egress error: ' + String(e)); } },
    onControl: (m) => { if (rooms.get(roomId) === room && room.lanPipe === client) onLanControl(room, m); },
    onClose: () => { if (rooms.get(roomId) !== room || room.lanPipe !== client) return; try { room.lan?.suspend(); } catch { /* ignore */ } },
  });
  room.lanPipe = client;
  try {
    await client.connect();
  } catch (e) {
    teardownLan(room);
    throw new Error('LAN helper connection failed: ' + String(e));
  }
  if (netSuspended || rooms.get(roomId) !== room || room.lanPipe !== client) {
    client.close();
    if (room.lanPipe === client) teardownLan(room);
    throw new Error('LAN start was cancelled by a room or network change');
  }
  // Apply BEFORE start(): the first advert we emit must already carry the honest
  // willingness bit, or peers would briefly hold us as a candidate we then refuse.
  session.setRelayEnabled(lanRelayEnabled);
  if (isHost) session.startAsHost(Array.isArray(opts.admit) ? opts.admit.map(String) : []);
  else session.start();
  pushState(room, true);
  return { ok: true, sessionId: String(opts.sessionId || '') };
}

/** Capture a screen/window in THIS (hidden, secure-context) window via the legacy
 *  chromeMediaSource path — unlike getDisplayMedia it needs NO user gesture, so it
 *  works from the engine window; the permission handlers already allow 'media'.
 *  `sourceId` comes from desktopCapturer.getSources in the main process. */
async function captureScreen(sourceId: string, withAudio = false): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Screen capture unavailable (the room engine is not a secure context).');
  }
  const video = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: String(sourceId),
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 15,
    },
  };
  // M20: system audio is OPT-IN (the picker's "share audio" checkbox). When off,
  // share video only — the safe default, since a system-audio loopback carries
  // everything playing and the call echo canceller is best-effort. When on, grab
  // the desktop loopback; the share pipeline echo-cancels the voice-call playback
  // out of it (VoiceSession.startShareAudio) before sending. Loopback is Windows-
  // only in Chromium — elsewhere getUserMedia rejects, so fall back to video-only.
  if (!withAudio) return await navigator.mediaDevices.getUserMedia({ audio: false, video } as any);
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video } as any);
  } catch (e) {
    log('screen system-audio capture unavailable — sharing video only: ' + String(e));
    return await navigator.mediaDevices.getUserMedia({ audio: false, video } as any);
  }
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
 *  owner — so a member can't self-declare owner to a fresh joiner. No pin → TOFU.
 *  Once an ownership-transfer chain applied, the CHAIN-proven owner supersedes
 *  the pin: every link was verified back to the pin/TOFU root when it applied,
 *  and anything else (incl. a stale claim by a PREVIOUS owner) is refused. */
function ownerPinAllows(room: Room, id?: string): boolean {
  if (room.transferChain.length) return id === room.ownerId;
  return !room.ownerPin || id === room.ownerPin;
}

/** True when `id` is (or WAS) a legitimate owner of this room: the current owner,
 *  or any signer/recipient on the verified transfer chain. Used to keep accepting
 *  a PAST owner's signed E2E config after a transfer — the content secret does not
 *  rotate on transfer, so a previous owner's cfg still authenticates it, which is
 *  what lets a new owner (or a fresh joiner) still learn the secret before the new
 *  owner has re-minted its own cfg. Ownership itself is never rolled back to a past
 *  owner (maybeAdoptE2E still gates that on ownerPinAllows). */
function ownerChainAllows(room: Room, id?: string): boolean {
  if (!id) return false;
  if (ownerPinAllows(room, id)) return true;
  return room.transferChain.some((l) => l.by === id || l.newOwnerId === id);
}

// ── Ownership transfer (M8 — docs/rooms-ownership-transfer.md) ───────────────
// ownerId is otherwise fixed at creation (TOFU + optional invite pin). A signed
// transfer moves it: the CURRENT owner signs over the new owner's id, everyone
// verifies the WHOLE chain and adopts the final owner, and the full chain is
// re-served in HELLOs so a joiner who only trusts the ORIGINAL pin (or a MID-
// chain pin from a newer invite) can always walk to the current owner. Every
// member stores and re-serves the COMPLETE chain — never a suffix — so no
// ownership history is lost as membership churns.

const MAX_TRANSFER_CHAIN = 8; // documented cap — a room changes hands at most 8 times

/** Coerce a peer-supplied/persisted transfer link to a sane shape, or null. */
function clampTransferLink(l: any): TransferLink | null {
  if (!l || typeof l !== 'object') return null;
  const newOwnerId = clampStr(l.newOwnerId, MAX_STR);
  const by = clampStr(l.by, MAX_STR);
  const at = Number(l.at);
  const pub = clampStr(l.pub, MAX_STR * 2);
  const sig = clampStr(l.sig, MAX_STR);
  if (!newOwnerId || !by || !pub || !sig || !Number.isFinite(at)) return null;
  return { newOwnerId, at, by, pub, sig };
}

/**
 * Verify a transfer chain and return its longest valid genesis-rooted PREFIX
 * (capped at MAX_TRANSFER_CHAIN — the tail past the cap is dropped identically on
 * every peer, so the cap fires consistently). Each link must hand off from the
 * previous (`by` = the prior `newOwnerId`), be no self-transfer, carry a strictly
 * increasing non-future `at`, and be signed by `by` over the STABLE genesis-root
 * domain. On the FIRST malformed/forged/non-contiguous link the walk stops and
 * the valid prefix so far is returned — so a broken or forged link leaves the
 * owner at the last verified hop (per the design doc) rather than voiding the
 * whole chain. Trust anchoring (does this chain belong to OUR room?) is the
 * caller's job. Returns null when not even the first link verifies.
 */
function verifyChainLinks(room: Room, links: unknown): TransferLink[] | null {
  if (!Array.isArray(links) || !links.length) return null;
  const out: TransferLink[] = [];
  let root = '';
  let prevNewOwner = '';
  let prevAt = 0;
  for (const raw of orderedTransferPrefix(links)) {
    const l = clampTransferLink(raw);
    if (!l) break;                                              // malformed — keep the valid prefix
    if (l.newOwnerId === l.by) break;                           // self-transfer
    if (out.length === 0) root = l.by;                          // genesis owner = first signer (the signature domain)
    else if (l.by !== prevNewOwner) break;                      // not a contiguous hand-off
    if (l.at <= prevAt) break;                                  // `at` must strictly increase along the chain
    if (l.at > Date.now() + 60_000) break;                      // no future-dated clock wedge
    if (!verifySignedBy(room, l.by, l.pub, l.sig, transferCanonical(root, l))) break;
    out.push(l);
    prevNewOwner = l.newOwnerId;
    prevAt = l.at;
  }
  return out.length ? out : null;
}

/** Does this verified chain belong to OUR room's ownership line — i.e. can WE
 *  trust it to name the owner? Pinned: our pin must appear in it (as the root or
 *  a later recipient — we may have joined mid-chain via a newer invite). No pin
 *  (TOFU): trust it if we hold no chain yet (first-seen), or it extends the same
 *  genesis root / passes through our current owner. */
function chainAnchored(room: Room, chain: TransferLink[]): boolean {
  return ownerChainAnchored(room, chain);
}

/**
 * Verify + adopt a full transfer chain (a HELLO re-serve, a live single-link
 * transfer appended to ours, or a persisted chain on restart). Adopts the chain
 * only when it is authentic (verifyChainLinks), belongs to our room (chainAnchored),
 * and advances ownership (its final `at` is newer than ours, or it is a strictly
 * longer/equal history at the same clock). Stores the COMPLETE chain and sets the
 * owner to its final recipient.
 * `quiet` = restoring from disk: state applies but nothing is re-persisted,
 * logged, re-minted or broadcast (startRoom's own owner-mint block runs after).
 */
function adoptChain(room: Room, links: unknown, quiet = false): boolean {
  const chain = verifyChainLinks(room, links);
  if (!chain) return false;
  if (!chainAnchored(room, chain)) return false;
  const finalOwner = chain[chain.length - 1].newOwnerId;
  const finalAt = chain[chain.length - 1].at;
  // LWW on ownership, with chain LENGTH as the tiebreaker so a more complete
  // history (same final clock) still replaces a suffix we may be holding.
  if (finalAt < room.transferAt) return false;
  if (finalAt === room.transferAt && chain.length <= room.transferChain.length) return false;
  if (!quiet && room.bans.has(finalOwner)) return false; // never hand a live room to a rekey victim
  const changedOwner = room.ownerId !== finalOwner;
  const oldOwnerId = room.ownerId || chain[chain.length - 1].by;
  room.ownerId = finalOwner;
  room.transferAt = finalAt;
  room.transferChain = chain;
  if (quiet) return true;
  try { ipcRenderer.send('room-owner', { roomId: room.roomId, ownerId: finalOwner }); } catch { /* ignore */ }
  try { ipcRenderer.send('room-transfer', { roomId: room.roomId, chain: room.transferChain }); } catch { /* ignore */ }
  if (changedOwner) {
    const nameOf = (id: string) => id === room.self.memberId ? (room.self.name || 'You') : (room.members.get(id)?.name || '?');
    // Stamp the event with the transfer's OWN clock (finalAt), not now — a fresh
    // joiner catching the chain days later must not show it as "just happened".
    logEvent(room, { type: 'ownership-transferred', actorId: oldOwnerId, actorName: nameOf(oldOwnerId), targetName: nameOf(finalOwner), at: Math.min(finalAt, Date.now()) });
  }
  if (finalOwner === room.self.memberId) {
    // WE are the new owner: re-mint everything owner-signed under OUR key (the
    // same re-mint set as applyLocalRekey). The E2E secret and topic do not
    // rotate on transfer — only the signing authority — so new joiners would
    // otherwise reject the previous owner's E2E config, tombstones and topic.
    if (room.e2e && room.secret && completeContentKeys(room.e2eCfg, room.secret, room.prevSecrets)) {
      room.e2eCfg = signE2ECfg(room);
      room.e2eSigned = !!room.e2eCfg;
      persistE2E(room);
    }
    const by = room.self.memberId;
    for (const [fileId, at] of room.tombstones) {
      const sig = signBytes(room, delCanonical(room.topic, { fileId, memberId: by, at }));
      room.tombSigs.set(fileId, { by, pub: room.self.pub, sig });
      try { ipcRenderer.send('room-tomb', { roomId: room.roomId, fileId, at, by, pub: room.self.pub, sig }); } catch { /* ignore */ }
    }
    // Re-sign the room topic (if any) so post-transfer joiners don't reject it
    // (applySignedTopic gates on `by === current owner`). Bump topicAt so the
    // re-mint wins LWW; keep the text.
    if (room.topicText) {
      const at = Math.max(Date.now(), room.topicAt + 1);
      const sig = signBytes(room, topicCanonical(room.topic, { text: room.topicText, at, by }));
      room.topicAt = at;
      room.topicMsg = { text: room.topicText, at, by, pub: room.self.pub, sig };
      try { ipcRenderer.send('room-topic', { roomId: room.roomId, text: room.topicText, at, by, pub: room.self.pub, sig }); } catch { /* ignore */ }
    }
    mintBanState(room);
    // Re-greet so peers pick up the fresh cfg/tombSigs/topic/chain at once.
    broadcast(room, helloMsg(room));
  }
  pushState(room, true);
  return true;
}

/** Apply a single LIVE transfer link: append it to the chain we already hold and
 *  adopt the extended chain (so the full-chain checks run over the whole history,
 *  not just the one link). */
function applyTransferMsg(room: Room, raw: unknown): boolean {
  const l = clampTransferLink(raw);
  if (!l) return false;
  return adoptChain(room, [...room.transferChain, l]);
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
 *  file.name is reduced to a traversal-free basename (roomFileName) because every
 *  write site does path.join(room.folder, file.name) — see shared/path-safety. */
function clampFile(f: any): RoomFile | null {
  if (!f || typeof f !== 'object') return null;
  const fileId = clampStr(f.fileId, MAX_STR);
  const magnetURI = clampStr(f.magnetURI, MAX_MAGNET);
  const name = roomFileName(clampStr(f.name, MAX_STR));
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
    // which voided every findTorrent(c, file.infoHash) re-entry guard for remote files.
    infoHash: fileId,
    magnetURI,
    addedBy: clampStr(f.addedBy, MAX_STR),
    addedByName: clampStr(f.addedByName, MAX_STR),
    // Never from the future: a hostile far-future addedAt would otherwise outrank
    // (and permanently defeat) every later deletion. Falls back to now if absent.
    addedAt: Math.min(Number.isFinite(f.addedAt) ? f.addedAt : Date.now(), Date.now()),
    ...(f.enc ? { enc: true, ...(f.keyEpoch ? { keyEpoch: f.keyEpoch } : {}) } : {}),
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
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
  if ('memberId' in msg) msg.memberId = clampStr(msg.memberId, MAX_STR);
  if ('name' in msg) msg.name = clampStr(msg.name, MAX_STR);
  if ('roomName' in msg) msg.roomName = clampStr(msg.roomName, MAX_STR);
  if ('avatarSeed' in msg) msg.avatarSeed = clampStr(msg.avatarSeed, MAX_STR);
  if ('ownerId' in msg) msg.ownerId = clampStr(msg.ownerId, MAX_STR);
  if ('by' in msg) msg.by = clampStr(msg.by, MAX_STR);                   // actor id on signed commands (del/rekey/rename/topic/transfer)
  if ('newOwnerId' in msg) msg.newOwnerId = clampStr(msg.newOwnerId, MAX_STR); // transfer target
  if ('to' in msg) msg.to = clampStr(msg.to, MAX_STR);       // voice-signal target
  if ('kind' in msg) msg.kind = clampStr(msg.kind, 16);      // voice-signal kind (offer/answer/ice)
  if ('streamId' in msg) msg.streamId = clampStr(msg.streamId, MAX_STR); // voice-share stream id (msid)
  // Virtual-LAN fields (anti-DoS bounds — the clamp bounds the RELAYED copy too;
  // an out-of-range value simply breaks the sender's signature and dies at verify).
  // `at` is left raw (each handler enforces a future-cutoff + per-type floor) and
  // lan-signal.data is left raw (structured SDP/ICE, bounded by MAX_FRAME_CHARS).
  if ('sessionId' in msg) msg.sessionId = clampStr(msg.sessionId, MAX_STR);   // lan-* session id
  if ('member' in msg) msg.member = clampStr(msg.member, MAX_STR);            // lan-admit / lan-evict target
  if ('vip' in msg) msg.vip = (Number(msg.vip) || 0) >>> 0;                    // lan-state claimed vIP (uint32)
  if ('gen' in msg) { const g = Number(msg.gen); msg.gen = Number.isFinite(g) ? Math.min(0xffff, Math.max(0, Math.round(g))) : 0; } // lan-state arbitration gen (16-bit)
  // lan-reach (Phase 2B). NOTE these two clamps are keyed on FIELD NAME and are
  // therefore shared with every other arm — `relay` and `reach` were checked to be
  // collision-free today, so any future message reusing either name silently
  // inherits this reshaping (and would break its own signature). Pick other names.
  if ('relay' in msg) msg.relay = msg.relay === true;                        // strict boolean: "true" must not slip through
  if ('reach' in msg) msg.reach = normalizeReachList(msg.reach);             // NORMALISING clamp — see lanReachCanonical
  if ('sharing' in msg) msg.sharing = msg.sharing === true;
  if ('fileId' in msg) msg.fileId = clampStr(msg.fileId, MAX_STR);
  if ('msgId' in msg) msg.msgId = clampStr(msg.msgId, MAX_STR);
  if ('replyTo' in msg) msg.replyTo = clampStr(msg.replyTo, MAX_STR);      // v2 includes this pointer in contextSig
  if ('replyName' in msg) msg.replyName = clampStr(msg.replyName, MAX_STR); // reply quote author snapshot
  if ('replyText' in msg) msg.replyText = clampStr(msg.replyText, MAX_TEXT); // reply quote body snapshot
  if ('secret' in msg) msg.secret = clampStr(msg.secret, MAX_SECRET);
  if ('text' in msg) msg.text = clampStr(msg.text, MAX_TEXT);
  if ('emoji' in msg) msg.emoji = clampStr(msg.emoji, 16);
  if ('pub' in msg) msg.pub = clampStr(msg.pub, MAX_STR * 2);
  if ('sig' in msg) msg.sig = clampStr(msg.sig, MAX_STR);
  if ('cfg' in msg) {
    const c = msg.cfg;
    msg.cfg = (c && typeof c === 'object' && !Array.isArray(c))
      ? {
          ownerId: clampStr(c.ownerId, MAX_STR), e2e: c.e2e === true, secret: clampStr(c.secret, MAX_SECRET), pub: clampStr(c.pub, MAX_STR * 2), sig: clampStr(c.sig, MAX_STR),
          ...(c.keys ? { keys: { v: c.keys.v, epoch: c.keys.epoch, root: c.keys.root, total: c.keys.total, pages: c.keys.pages, sig: c.keys.sig } } : {}),
          // The optional signed keyring rides along (verified separately).
          ...(Array.isArray(c.prevSecrets) && typeof c.prevSig === 'string'
            ? { prevSecrets: c.prevSecrets.slice(0, LEGACY_PREV_SECRETS).map((x: any) => clampStr(x, MAX_SECRET)).filter(Boolean), prevSig: clampStr(c.prevSig, MAX_STR) }
            : {}),
        }
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
  if (msg.t === 'hello' || msg.t === 'ping') msg.guest = msg.guest === true;
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
  if ('transferChain' in msg) {
    msg.transferChain = Array.isArray(msg.transferChain)
      ? msg.transferChain.slice(0, MAX_TRANSFER_CHAIN).map(clampTransferLink).filter(Boolean)
      : [];
  }
  if ('pct' in msg) {
    const p = Math.round(Number(msg.pct));
    msg.pct = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
  }
  if ('on' in msg) msg.on = msg.on === true;
  if ('fileReacts' in msg) msg.fileReacts = clampReactsRecord(msg.fileReacts);
}

const voiceV2Rooms = new WeakMap<Room, Set<string>>();
function voiceV2Peers(room: Room): Set<string> {
  let peers = voiceV2Rooms.get(room);
  if (!peers) { peers = new Set(); voiceV2Rooms.set(room, peers); }
  return peers;
}

// Session state is keyed by the Room object: leaving releases it, rekey retains replay floors.
const ingressByWire = new WeakMap<Wire, RoomIngressBudget>();
const ingressByRoom = new WeakMap<Room, RoomIngressBudget>();
const watchByRoom = new WeakMap<Room, { sender: WatchSender; receiver: WatchReceiver; host: WatchHostState; policyTopic?: string }>();
function watchState(room: Room) {
  let state = watchByRoom.get(room);
  if (!state) { state = { sender: new WatchSender(), receiver: new WatchReceiver(), host: new WatchHostState() }; watchByRoom.set(room, state); }
  return state;
}
function ingressBudget(map: WeakMap<object, RoomIngressBudget>, key: object): RoomIngressBudget {
  let budget = map.get(key);
  if (!budget) { budget = new RoomIngressBudget(); map.set(key, budget); }
  return budget;
}
function authenticateGossip(room: Room, msg: any, wire: Wire): boolean {
  const proofs = gossipProofs(msg, room.topic, room.transferChain[0]?.by || room.ownerPin || room.ownerId);
  // Handlers re-verify before applying authority; account for that work as well.
  // Key pages additionally verify their authenticated descriptor and page in
  // both the relay gate and adoption path (five verifications including preflight).
  const proofCost = proofs.length * (msg.t === 'e2e-keys' ? 5 : 2);
  if (!ingressBudget(ingressByWire, wire).take(0, proofCost)
    || !ingressBudget(ingressByRoom, room).take(0, proofCost)) { observeConnection(room, 'rate-limited'); return false; }
  const identities = new Set(room.identities.keys());
  for (const p of proofs) {
    if (room.bans.has(p.memberId) && !p.chainLink || deriveMemberId(p.pub) !== p.memberId) { observeConnection(room, 'identity-rejected'); return false; }
    const bound = room.identities.get(p.memberId);
    if (bound && bound !== p.pub) { observeConnection(room, 'identity-rejected'); return false; }
    identities.add(p.memberId);
    if (identities.size > ROOM_IDENTITY_LIMIT) { observeConnection(room, 'identity-rejected'); return false; }
    try { if (!crypto.verify(null, p.bytes, crypto.createPublicKey(p.pub), Buffer.from(p.sig, 'base64'))) { observeConnection(room, 'identity-rejected'); return false; } }
    catch { observeConnection(room, 'identity-rejected'); return false; }
  }
  if ((msg.t === 'hello' || msg.t === 'ping') && msg.pub) {
    if (deriveMemberId(msg.pub) !== msg.memberId || (room.identities.has(msg.memberId) && room.identities.get(msg.memberId) !== msg.pub)) { observeConnection(room, 'identity-rejected'); return false; }
    if (!room.identities.has(msg.memberId) && identities.size >= ROOM_IDENTITY_LIMIT) { observeConnection(room, 'identity-rejected'); return false; }
  }
  return true;
}
function onMessage(room: Room, wire: Wire, raw: any): void {
  if (room.kicked) return;
  let msg: Msg;
  try {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    if (text.length > MAX_FRAME_CHARS) { observeConnection(room, 'rate-limited'); log('oversized gossip frame dropped (' + text.length + ' chars)'); return; }
    if (!ingressBudget(ingressByWire, wire).take(Buffer.byteLength(text))
      || !ingressBudget(ingressByRoom, room).take(Buffer.byteLength(text))) { observeConnection(room, 'rate-limited'); return; }
    const decoded = validateGossip(decrypt<unknown>(room.key, text));
    if (!decoded) { observeConnection(room, 'message-rejected'); return; }
    msg = decoded as Msg;
  } catch {
    // Decryption/JSON failure is an observation, not proof of a wrong invite.
    observeConnection(room, 'frame-unreadable'); return;
  }
  const meta = msg as any;
  if (meta._g && room.seenGids.has(meta._g)) return;
  if (!authenticateGossip(room, msg, wire)) return;
  // Banned identities (owner-signed rekey victims) are dead to this room: drop
  // every frame that NAMES one — as sender (memberId), actor (`by`) or file
  // author ('add' carries only file.addedBy). A DIRECT frame also identifies
  // the wire's peer as the banned member: cut the wire so our broadcasts stop
  // reaching them too.
  if (room.bans.size > 0 && (
    (meta.memberId && room.bans.has(meta.memberId)) ||
    (meta.by && room.bans.has(meta.by)) ||
    (meta.file && meta.file.addedBy && room.bans.has(meta.file.addedBy))
  )) {
    if (typeof meta._t !== 'number' || meta._t >= RELAY_TTL) {
      try { wire.peer.destroy(); } catch { /* ignore */ }
      room.wires.delete(wire.id);
    }
    return;
  }
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

  // Apply bans before full reply, relay, manifest and backfill from this hello.
  if (msg.t === 'hello') {
    if (msg.transferChain && !ownerChainsCompatible(room.transferChain, msg.transferChain)) return;
    const proof = msg.banState;
    adoptChain(room, msg.transferChain);
    maybeAdoptOwner(room, msg.ownerId);
    if (proof && (proof.ownerId !== room.ownerId || !adoptBanState(room, proof))) delete msg.banState;
    if (room.kicked) return;
    if (room.bans.has(msg.memberId)) {
      if (direct) { try { wire.peer.destroy(); } catch { /* ignore */ } room.wires.delete(wire.id); }
      return;
    }
  }

  // Peer-relay: drop anything we've already handled (incl. our own flooded echo),
  // otherwise authenticate and check watch replay floors BEFORE forwarding.
  const gid: string = meta._g || '';
  if (gid) {
    if (room.seenGids.has(gid)) return;
  }
  if ((msg.t === 'hello' || msg.t === 'ping') && !room.members.has(msg.memberId) && room.members.size >= ROOM_MEMBER_LIMIT) return;
  if (msg.t === 'e2e-keys' && (!room.e2eCfg || !verifyKeyPage(room.topic, room.e2eCfg, msg))) return;
  if (['have', 'bye', 'typing', 'react-file', 'react-chat', 'prog', 'e2e-key-request'].includes(msg.t) && !room.members.has(meta.memberId)) return;
  if (msg.t === 'transfer' && !room.ownerId) maybeAdoptOwner(room, msg.by);
  if (msg.t === 'transfer' && room.ownerId && msg.by !== room.ownerId) return;
  if (msg.t === 'transfer' && msg.banState && (msg.banState.ownerId !== msg.by || msg.banState.bans.includes(msg.newOwnerId) || !adoptBanState(room, msg.banState))) return;
  if (room.kicked) return;
  if (['rename', 'topic', 'rekey', 'kicked'].includes(msg.t) && (!room.ownerId || meta.by !== room.ownerId)) return;
  if (msg.t === 'del') {
    const file = room.files.get(msg.fileId);
    if (file && !canDeleteRoomFile(room.ownerId, file.addedBy, msg.memberId)) return;
  }
  if (['voice-state', 'voice-signal', 'voice-share'].includes(msg.t) && !room.members.has(meta.memberId)) return;
  if (['voice-state', 'voice-share'].includes(msg.t) && meta.at > Date.now() + 60_000) return;
  if (msg.t === 'voice-state') {
    const versions = voiceV2Peers(room);
    if (versions.has(msg.memberId) && msg.voiceV !== 2) return;
    if (msg.voiceV === 2) versions.add(msg.memberId);
  }
  if (msg.t === 'hello' && msg.watchPolicy) {
    if (watchState(room).host.accept(msg.watchPolicy, room.ownerId, Date.now(), room.transferAt)) { watchState(room).policyTopic = room.topic; pushState(room, true); }
    else if (msg.watchPolicy.by !== room.ownerId) delete msg.watchPolicy;
  }
  if (msg.t === 'watch-policy-v1') {
    if (!watchState(room).host.accept(msg, room.ownerId, Date.now(), room.transferAt)) return;
    watchState(room).policyTopic = room.topic;
  }
  if (msg.t === 'sync-v2') {
    if (!room.members.has(msg.memberId) || room.identities.get(msg.memberId) !== msg.pub || !room.files.has(msg.fileId)) return;
    if (!watchState(room).host.allows(msg, room.ownerId, room.transferAt) || !watchState(room).receiver.accept(msg)) return;
  }
  if (gid) {
    markSeen(room, gid);
    forwardRelay(room, meta, wire.id);
  }

  clampGossip(msg);
  switch (msg.t) {
    case 'hello': {
      const sync = helloAssembly(direct ? wire : room, direct ? 1 : 256).accept(msg);
      if (!sync.accepted) break;
      // A direct hello on a wire not yet bound to a member = a fresh connection
      // (their FIRST greet this link) — they may have restarted and lost their
      // session-only profile cache, so the announce gate below must not skip them.
      const freshWire = direct && !wire.memberId;
      if (direct) {
        wire.memberId = msg.memberId;
        if (freshWire) connectionMonitor(room).identified();
        if (sync.complete) wire.manifestReceived = true;
        else if (wire.manifestReceived !== true && (msg.manifestPart || msg.manifestFull === false)) wire.manifestReceived = false;
        void sampleChannelPath(room, wire);
      }
      // The peer just identified (and passed the ban gate above) — hand it the
      // FULL hello the slim greet withheld (secret/cfg/manifest). Once per wire.
      if (direct && (!wire.greetedFull || msg.manifestRequest === true && Date.now() - (wire.manifestRequestedAt || 0) >= 10_000)) {
        wire.manifestRequestedAt = Date.now();
        wire.greetedFull = true;
        sendTo(room, wire, helloMsg(room));
      }
      bindIdentity(room, msg.memberId, msg.pub); // TOFU their identity key from the greet, so we can verify their signed commands
      const isNew = !room.members.has(msg.memberId);
      const m = touchMember(room, msg.memberId, msg.name, msg.avatarSeed);
      if (msg.guest === true) m.guest = true;
      m.watchSync = msg.watchSync === 2;
      Object.assign(m, readRoomCapabilities(msg));

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
      // Topic re-serve: the SIGNED topic rides HELLOs and is verified exactly
      // like the live 'topic' gossip (owner + LWW + clock) — never adopted on
      // trust, so a member can't plant an owner-labeled topic.
      // Applied below, after adopting the verified ownership chain.
      // Ownership-transfer chain BEFORE the bare ownerId claim: a joiner on an
      // old invite walks pin → current owner here, instead of rejecting the new
      // owner's id against the pin below (and E2E cfg verification right after
      // depends on the post-walk owner).
      adoptChain(room, msg.transferChain);
      maybeAdoptOwner(room, msg.ownerId);
      if (msg.topicMsg) applySignedTopic(room, msg.topicMsg);
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
      if (sync.first) room.voice.reannounce();
      // Same solicit for the virtual-LAN session: presence (lan-state) is transient
      // and survives rekey by re-flooding on hello, exactly like voice-state.
      if (sync.first) room.lan?.reannounce();
      // Merge the peer's files first so an authenticated tombstone below can check
      // authorship (addedBy) against the file, then re-suppress it. `tombSigs` are
      // AUTHENTICATED deletions — each re-verifies (owner/author + signature)
      // before it applies. Bare `tombs`/`tombsAt` from ≤2.15 peers are NOT trusted
      // here (an unsigned tomb would be a free "delete anyone's file" over hello);
      // they still ride our own hello outward so old peers keep converging.
      mergeHelloFiles(room, msg.files || []);
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
      if (mergeChatReacts(room, msg.chatReacts)) persistChatReacts(room);
      if (mergeChatEdits(room, msg.chatEdits)) persistChatEdits(room);
      // Chat backfill: if this peer is behind our chat (or hasn't said how caught-up
      // it is), UNICAST it the messages it's missing — only ones we can re-serve with
      // a signature, so they self-authenticate on its side. Only on a DIRECT hello,
      // so `wire` really is that peer (relayed hellos don't identify the wire).
      m.have = Array.from(new Set((sync.have ?? msg.have ?? []).map(id => room.files.get(id)?.fileId).filter((id): id is string => !!id)));
      if (direct && (!msg.manifestPart || sync.complete)) { sendChatBackfill(room, wire, msg); if (sync.complete) connectionMonitor(room).synced(); }
      pushState(room);
      break;
    }
    case 'e2e-keys': adoptKeyPage(room, msg); break;
    case 'e2e-key-request': {
      const page = room.keyPages.find(p => p.root === msg.root && p.page === msg.page);
      if (!page || Date.now() - (room.keySentAt.get(msg.page) ?? -Infinity) < 10_000) break;
      room.keySentAt.set(msg.page, Date.now());
      const reply = { ...page, _g: crypto.randomBytes(6).toString('hex'), _t: RELAY_TTL };
      markSeen(room, reply._g); sendTo(room, wire, reply);
      break;
    }
    case 'chat-log': {
      // Backfilled messages a peer re-served us. Each self-authenticates (verifyChat
      // over its own pub/sig), and addChat dedupes by id — so overlapping backfill
      // from multiple peers is harmless. Capped, and dedup/future/mute checks run
      // BEFORE the expensive verify so a stuffed frame can't force N signature checks.
      const list = Array.isArray(msg.msgs) ? msg.msgs.slice(0, MAX_CHAT_LOG) : [];
      for (const c of list) {
        const cm = chatEnvelope(c);
        if (!cm || room.mutes.has(cm.memberId) || room.bans.has(cm.memberId)) continue;
        const prior = room.chat.find(m => m.id === cm.id);
        if (prior && !upgradeChat(prior, cm)) continue;
        if (!verifyChat(room, cm)) continue;
        addChat(room, cm, true /* backfill — no toast */);
      }
      break;
    }
    case 'ping': {
      if (direct) wire.memberId = msg.memberId;
      const isNew = !room.members.has(msg.memberId);
      const m = touchMember(room, msg.memberId, msg.name, msg.avatarSeed);
      if (msg.guest === true) m.guest = true;
      Object.assign(m, readRoomCapabilities(msg));
      if (msg.watchSync === 2) m.watchSync = true;
      m.have = Array.from(new Set((msg.have || []).map(id => room.files.get(id)?.fileId).filter((id): id is string => !!id)));
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
    case 'transfer': {
      // Ownership handover, CURRENT-OWNER-signed (all rules in applyTransferMsg).
      // Relayed verbatim, so multi-hop members verify the owner, not the relayer.
      applyTransferMsg(room, msg);
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
    case 'topic': {
      // Same rules as rename; an EMPTY text is legal (clears the topic).
      if (applySignedTopic(room, msg)) pushState(room, true);
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
      room.lan?.onMemberGone(msg.memberId); // release their vIP/route + close the LAN leg
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
      room.voice.onPeerState(msg.memberId, !!msg.inVoice, !!msg.muted, at, msg.voiceV === 2 && msg.deafened === true);
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
    // ── Virtual-LAN signed gossip (plan §3). Each verifies with verifySignedBy over
    // its OWN domain-tagged canonical; the per-type monotonic anti-replay floor,
    // host-authority (by === pinned genesis host), terminal-evict and the admission
    // gate all live in the LanSessionCore the LanSession owns — so these arms only
    // gate signature + shape and feed the session. A lan-* frame that arrives before
    // this install has a local LAN session is simply dropped (beta).
    case 'lan-genesis': {
      const sid = String(msg.sessionId || '');
      const at = Number(msg.at);
      if (!Number.isFinite(at) || at > Date.now() + 60_000) break; // future-cutoff (pin is immutable, no floor)
      // Only the host the sessionId commits to (`${host}.${rand}`) may bootstrap a
      // session here — blocks attacker-induced passive-session churn (must-fix #7).
      if (msg.by !== sessionHostPrefix(sid)) break;
      if (!verifySignedBy(room, msg.by, msg.pub, msg.sig, lanGenesisCanonical(msg.sessionId, { by: msg.by, at }))) break;
      ensureLanSession(room, sid).onGenesis(msg.by, msg.sessionId, at); // lazily create a passive joiner session, then pin
      break;
    }
    case 'lan-admit': {
      const sid = String(msg.sessionId || '');
      const at = Number(msg.at);
      if (!Number.isFinite(at) || at > Date.now() + 60_000) break;
      if (msg.by !== sessionHostPrefix(sid)) break; // admits only from the committed host
      if (!verifySignedBy(room, msg.by, msg.pub, msg.sig, lanAdmitCanonical(msg.sessionId, { by: msg.by, member: msg.member, at }))) break;
      ensureLanSession(room, sid).onAdmit(msg.by, msg.member, at, msg.sessionId); // core enforces this-session + by === pinned host + own floor + terminal-evict
      break;
    }
    case 'lan-evict': {
      if (!room.lan) break;
      const at = Number(msg.at);
      if (!Number.isFinite(at) || at > Date.now() + 60_000) break;
      if (!verifySignedBy(room, msg.by, msg.pub, msg.sig, lanEvictCanonical(msg.sessionId, { by: msg.by, member: msg.member, at }))) break;
      room.lan.onEvict(msg.by, msg.member, at, msg.sessionId); // core enforces this-session + by === pinned host + own (sticky) floor
      break;
    }
    case 'lan-state': {
      if (!room.lan) break;
      const at = Number(msg.at);
      if (!Number.isFinite(at) || at > Date.now() + 60_000) break;
      if (!verifySignedBy(room, msg.memberId, msg.pub, msg.sig, lanStateCanonical(room.topic, { memberId: msg.memberId, sessionId: msg.sessionId, vip: msg.vip, gen: msg.gen, at }))) break;
      // Every vIP is a CLAIM — re-derive it (must-fix #6) before it can route.
      if (!verifyVipClaim(msg.sessionId, msg.memberId, msg.gen, msg.vip)) break;
      const claim: LanStateClaim = { memberId: msg.memberId, sessionId: msg.sessionId, vip: msg.vip, gen: msg.gen, at };
      room.lan.onPeerState(claim); // core re-verifies + admission-gates for the routing table
      break;
    }
    case 'lan-signal': {
      if (!room.lan) break;
      if (msg.to !== room.self.memberId) break; // not addressed to us (already relayed above)
      if (msg.kind !== 'offer' && msg.kind !== 'answer' && msg.kind !== 'ice' && msg.kind !== 'retry') break;
      if (!verifySignedBy(room, msg.memberId, msg.pub, msg.sig, lanSignalCanonical(room.topic, { memberId: msg.memberId, to: msg.to, kind: msg.kind, data: msg.data }))) break;
      room.lan.onSignal(msg.memberId, msg.kind as LanSignalKind, msg.data); // the ADMISSION GATE (must-fix #1) is INSIDE onSignal
      break;
    }
    case 'lan-reach': {
      // Phase 2B reachability advert. Mirrors lan-state exactly: no
      // ensureLanSession (an advert must never bootstrap a session — it is
      // presence, not authority), future-cutoff, then verify over the TRANSIENT
      // topic-bound canonical. The session gate, the OWN monotonic floor and the
      // admission filter all live below this line, in LanSession/LanReachTable.
      if (!room.lan) break;
      const at = Number(msg.at);
      if (!Number.isFinite(at) || at > Date.now() + 60_000) break;
      const relay = msg.relay === true;
      const reach = Array.isArray(msg.reach) ? msg.reach : [];
      if (!verifySignedBy(room, msg.memberId, msg.pub, msg.sig, lanReachCanonical(room.topic, { memberId: msg.memberId, sessionId: msg.sessionId, at, relay, reach }))) break;
      room.lan.onPeerReach({ memberId: msg.memberId, sessionId: msg.sessionId, at, relay, peers: reach });
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
    case 'srv-mirror': {
      const at = Number(msg.at);
      if (!Number.isFinite(at) || at > Date.now() + 60_000) break;
      // PER-HOST floor, taken from that host's own stored entry. Sharing one
      // floor across publishers meant the first mirror to arrive with a fast
      // clock rejected every other member's forever.
      const prev = room.srvMirrors.get(msg.hostId);
      if (prev && prev.at >= at) break;
      const body = String(msg.body || '').slice(0, 200_000);
      if (!verifySignedBy(room, msg.hostId, msg.pub, msg.sig, srvMirrorCanonical(room.topic, { hostId: msg.hostId, at, body }))) break;
      const parsed = parseMirrorBody(body);
      if (!parsed || parsed.hostId !== msg.hostId) break;
      if (!prev && room.srvMirrors.size >= SRV_MIRROR_HOST_CAP) {
        let evict: string | undefined;
        for (const id of room.srvMirrors.keys()) { if (!room.members.has(id)) { evict = id; break; } }
        evict = evict ?? room.srvMirrors.keys().next().value;
        if (evict !== undefined) room.srvMirrors.delete(evict);
      }
      // An empty instance list is a real update, not a no-op: it is how a host
      // says "my last server is gone". Storing it replaces the stale entry that
      // used to linger as a ghost server on every peer.
      room.srvMirrors.set(msg.hostId, { ...parsed, at });
      pushState(room);
      break;
    }
    // Legacy packets cannot report host acceptance and are deliberately refused.
    case 'srv-cmd': break;
    case 'srv-cmd-v2': {
      if (netSuspended || room.kicked || msg.hostId !== room.self.memberId || !room.members.has(msg.by) || !validCommandRequest(msg)) break;
      if (!verifySignedBy(room, msg.by, msg.pub, msg.sig, Buffer.from(commandCanonical(room.topic, msg)))) break;
      const prevAt = room.srvCmdAt.get(msg.by);
      if (prevAt !== undefined && prevAt >= msg.at) break;
      if (prevAt === undefined && room.srvCmdAt.size >= SRV_CMD_FLOOR_CAP) break;
      room.srvCmdAt.set(msg.by, msg.at);
      // Main rechecks the instance's room, current grant and deduplicates IDs.
      void ipcRenderer.invoke('srv-remote-cmd', { roomId: room.roomId, request: msg }).then(result => {
        if (rooms.get(room.roomId) !== room || netSuspended || room.kicked || !room.members.has(msg.by)) return;
        const reply: ServerCommandReply = { commandId: msg.commandId, hostId: room.self.memberId, to: msg.by,
          instanceId: msg.instanceId, ok: result?.ok === true, ...(result?.ok !== true ? { reason: String(result?.reason || 'command-unknown').slice(0, 64) } : {}), at: Date.now() };
        broadcast(room, { t: 'srv-result-v2', ...reply, pub: room.self.pub, sig: signBytes(room, Buffer.from(commandReplyCanonical(room.topic, reply))) });
      }).catch(() => { /* sender gets an unknown-outcome timeout */ });
      break;
    }
    case 'srv-result-v2': {
      if (netSuspended || room.kicked || msg.to !== room.self.memberId || !room.members.has(msg.hostId)) break;
      if (!verifySignedBy(room, msg.hostId, msg.pub, msg.sig, Buffer.from(commandReplyCanonical(room.topic, msg)))) break;
      room.pendingServerCommands.accept(msg);
      break;
    }
    case 'watch-policy-v1': pushState(room, true); break;
    case 'sync-v2': {
      // Relay watch-together control + presence to the main process → renderer.
      try {
        ipcRenderer.send('room-sync', {
          roomId: room.roomId, fileId: msg.fileId, action: msg.action,
          position: msg.position, rate: msg.rate, at: msg.at,
          ...(msg.v === 3 ? { v: 3, readiness: msg.readiness, requested: msg.requested, policyBy: msg.policyBy, policyAt: msg.policyAt, policyOwnerAt: msg.policyOwnerAt, hostSig: msg.hostSig } : {}),
          sessionId: msg.sessionId, startedAt: msg.startedAt, seq: msg.seq,
          memberId: msg.memberId, name: room.members.get(msg.memberId)!.name, avatarSeed: room.members.get(msg.memberId)!.avatarSeed, playing: msg.playing, together: msg.together, emoji: msg.emoji,
        });
      } catch { /* ignore */ }
      break;
    }
    case 'chat': {
      if (room.mutes.has(msg.memberId)) break; // a muted member's messages stay hidden
      const cm = chatEnvelope(msg);
      if (!cm) break;
      // Reject unsigned, badly-signed, or impersonating messages outright.
      if (!verifyChat(room, cm)) break;
      // Keep the sender fresh in the member list so a chatter never looks offline.
      const m = room.members.get(msg.memberId);
      if (m) m.lastSeen = Date.now();
      addChat(room, cm);
      break;
    }
    case 'chat-edit': {
      if (room.mutes.has(msg.memberId)) break;             // a muted member's edits stay hidden
      const text = String(msg.text || '').slice(0, 2000);
      if (!text) break;
      const at = Number(msg.at) || 0;
      if (!validChatTime(at)) break;
      const msgId = String(msg.msgId || '');
      if (!verifyEdit(room, { msgId, memberId: msg.memberId, at, text, pub: msg.pub, sig: msg.sig })) break;
      const edit = { text, at, by: msg.memberId, pub: msg.pub, sig: msg.sig };
      const target = room.chat.find((c) => c.id === msgId);
      // Message not here yet (relay reorder / edit raced its target) → buffer it;
      // addChat applies it (with the authorship check) when the message arrives.
      if (!target) { bufferPendingEdit(room, msgId, edit); break; }
      if (msg.memberId !== target.memberId) break;          // authorship: only the author may edit their message
      if (applyChatEdit(room, msgId, edit)) {
        persistChatEdits(room);
        pushState(room);
      }
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
    case 'react-chat': {
      if (room.mutes.has(msg.memberId)) break; // a muted member's reactions stay hidden
      // Only for messages we actually hold: fabricated (or long-pruned) msgIds
      // would squat the 200-entry cap forever. A race-lost react (the reaction
      // beating its message through the flood) converges via the next HELLO.
      if (!room.chat.some((c) => c.id === msg.msgId)) break;
      if (applyChatReact(room, msg.msgId, msg.emoji, msg.memberId, msg.on === true)) {
        persistChatReacts(room);
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
  if (!room.revives.has(fileId) && room.revives.size >= ROOM_FILE_LIMIT) return;
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
  if (!room.tombstones.has(fileId) && room.tombstones.size >= ROOM_FILE_LIMIT) return;
  const current = room.files.get(fileId);
  if (!currentRoomDeletion(at, current?.addedAt, room.revives.get(fileId))) return;
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
  if (c) { const t = findTorrent(c, fileId); if (t) { try { c.remove(t); } catch { /* ignore */ } } }
  cancelFileOperation(room, fileId);
  storageFor(room).proofs.delete(fileId);
  storageFor(room).decryptKeys.delete(fileId);
  room.files.delete(fileId); room.manifestLimited = false;
  room.transfers.delete(fileId);
  for (const m of room.members.values()) m.have = m.have.filter((id) => id !== fileId);
  // Delete the downloaded copy (only if it's inside the room folder).
  try {
    const lp = tr?.localPath;
    if (lp && !storageFor(room).originals.has(fileId) && isManagedRoomPath(room.folder, fileId, lp) && fs.existsSync(lp)) {
      fs.unlinkSync(lp);
    }
  } catch (e) { log('tombstone unlink failed: ' + String(e)); }
  // E2E: also drop the ciphertext copy we kept for seeding. Each share's cipher
  // lives in its own directory under the cache — sweep the empty dir with it.
  try {
    const cp = tr?.cipherPath;
    const owned = cp && (isManagedRoomPath(room.cacheDir, fileId, cp)
      || (path.resolve(path.dirname(path.dirname(cp))) === path.resolve(room.cacheDir) && path.basename(path.dirname(cp)).startsWith('share-')));
    if (cp && owned && fs.existsSync(cp)) fs.unlinkSync(cp);
    if (cp && owned && room.cacheDir) {
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
  const authorized = canDeleteRoomFile(room.ownerId, file?.addedBy, by);
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
  if (!canDeleteRoomFile(room.ownerId, file.addedBy, p.by)) return false;
  // A revive on the arriving file that lifts a deletion at-or-after the pending one
  // SUPERSEDES it — the pending proof is stale (a replayed, already-undone
  // deletion). Only a valid owner/deleter-signed revive counts, so a member can't
  // use this to force-revive someone else's deletion.
  if (Number.isFinite(file.revAt) && (file.revAt as number) >= p.at && (file.revAt as number) <= Date.now() + 60_000 && file.revBy && file.revPub && file.revSig) {
    const rby = file.revBy;
    const revAuthorized = canReviveRoomFile(room.ownerId, p.by, rby);
    if (revAuthorized && verifySignedBy(room, rby, file.revPub, file.revSig, reviveCanonical(room.topic, { fileId: file.fileId, tombAt: file.revAt as number, by: rby }))) {
      room.pendingTombs.delete(file.fileId);
      recordRevive(room, file.fileId, file.revAt as number); // VERIFIED revive — guards against re-deletion by the replayed tombstone
      return false; // revive wins — let the add proceed
    }
  }
  const authorized = canDeleteRoomFile(room.ownerId, file.addedBy, p.by);
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
  if (rooms.get(room.roomId) !== room || room.kicked || netSuspended || room.wires.size >= ROOM_WIRE_LIMIT) { try { peer.destroy(); } catch { /* already closed */ } return; }
  const wire: Wire = { id: ++wireSeq, peer };
  room.wires.set(wire.id, wire); observeConnection(room, 'peer-found');
  const current = () => rooms.get(room.roomId) === room && room.wires.get(wire.id) === wire;
  const greet = () => {
    if (!current()) return;
    observeConnection(room, 'channel-open'); void sampleChannelPath(room, wire);
    sendTo(room, wire, helloMsg(room, false));
  };
  if (peer.connected) greet(); else peer.once('connect', greet);
  peer.on('data', (d: any) => { if (current()) onMessage(room, wire, d); });
  peer.on('close', () => { if (!current()) return; room.wires.delete(wire.id); observeConnection(room, 'peer-closed'); });
  peer.on('error', () => { if (current()) observeConnection(room, 'peer-connect-failed'); });
  pushState(room);
}

/**
 * Verify an add's revive authorization against an authenticated tombstone: the
 * signature must check out as `revBy`, and `revBy` must be the OWNER or the
 * member who signed the deletion (the original deleter). On success it lifts the
 * tombstone; on failure the tombstone stands and the resurrection is refused.
 */
function acceptRevive(room: Room, file: RoomFile): boolean {
  if (!room.revives.has(file.fileId) && room.revives.size >= ROOM_FILE_LIMIT) return false;
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
  const authorized = canReviveRoomFile(room.ownerId, proof?.by, by);
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
  if (!room.files.has(file.fileId) && !roomManifestCanFit(room.files, file)) { room.manifestLimited = true; return; }
  if (room.mutes.has(file.addedBy) || room.bans.has(file.addedBy)) return; // muted locally / banned by rekey
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
    if (room.files.size >= ROOM_FILE_LIMIT) { log("Room manifest full: " + room.roomId); return; }
    if (!storeRoomManifestFile(room.files, file)) { room.manifestLimited = true; return; }
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
  if (!room.transfers.has(fileId) && room.transfers.size >= ROOM_FILE_LIMIT) return;
  const prev = room.transfers.get(fileId) || { fileId, progress: 0, phase: 'queued' as const, status: 'queued' as const, downSpeed: 0, peers: 0, haveLocally: false };
  const next = { ...prev, ...patch, fileId };
  if (patch.haveLocally === true) { next.phase = 'ready'; next.error = undefined; }
  else if (patch.status === 'error') next.phase = 'error';
  room.transfers.set(fileId, next);
}

/** Persist a manifest entry to the main process so the room resumes its file
 *  list — and re-seeds — on the next launch. localPath lets us re-seed a file
 *  shared from its original location (outside the room folder). */
const manifestBatches = new WeakMap<Room, { files: Map<string, PersistedRoomFile>; events: RoomEvent[] }>();
function mergeHelloFiles(room: Room, files: RoomFile[]): void {
  if (files.length < 2) { for (const file of files) mergeFile(room, file); return; }
  // Legacy peers still send a whole manifest in one HELLO. Keep persistence
  // bounded independently of their transport format so the manager accepts it.
  for (let offset = 0; offset < files.length; offset += ROOM_HELLO_ENTRIES) {
    const batch = { files: new Map<string, PersistedRoomFile>(), events: [] as RoomEvent[] };
    manifestBatches.set(room, batch);
    try { for (const file of files.slice(offset, offset + ROOM_HELLO_ENTRIES)) mergeFile(room, file); }
    finally {
      manifestBatches.delete(room);
      if (batch.files.size || batch.events.length) ipcRenderer.send('room-manifest-batch', {
        roomId: room.roomId, files: [...batch.files.values()], events: batch.events,
      });
    }
  }
}
function persistManifest(room: Room, file: RoomFile, localPath?: string, cipherPath?: string): void {
  const tr = room.transfers.get(file.fileId);
  const entry: PersistedRoomFile = { ...file, localPath: localPath ?? tr?.localPath, cipherPath: cipherPath ?? tr?.cipherPath,
    localError: tr?.error, torrentFile: storageFor(room).metadata.get(file.fileId)?.toString('base64'), localOriginal: storageFor(room).originals.has(file.fileId), partialDownload: storageFor(room).partialPaths.has(file.fileId), receivePaused: tr?.receivePaused };
  const batch = manifestBatches.get(room);
  if (batch) { batch.files.set(file.fileId, entry); return; }
  try { ipcRenderer.send('room-manifest-add', { roomId: room.roomId, file: entry }); } catch { /* ignore */ }
}

/** Seed a local file the user added, returning a RoomFile manifest entry. In an
 *  E2E room we encrypt the file into the cache first and seed THAT ciphertext;
 *  the swarm never sees plaintext. localPath still points at the original so the
 *  sharer can watch/open it directly. */
function seedLocal(room: Room, filePath: string): Promise<RoomFile> {
  if (room.files.size >= ROOM_FILE_LIMIT) return Promise.reject(new Error("Room file limit reached (5000). Remove files before adding more."));
  const c = ensureClient(room);
  const name = path.basename(filePath);
  const seedSecret = room.secret;
  const seedEpoch = room.e2e && seedSecret ? contentKeyEpoch(seedSecret) : undefined;
  roomDiskName({ name, enc: room.e2e });
  return new Promise<RoomFile>((resolve, reject) => {
    if (!fs.existsSync(filePath)) return reject(new Error('File not found: ' + filePath));

    const originalStamp = roomFileStamp(filePath);
    const plainSize = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();

    const doSeed = (seedPath: string, seedName: string, cipherPath?: string) => {
      let settled = false;
      const onErr = (e: any) => { c.removeListener('error', onErr); if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); } };
      c.once('error', onErr);
      try {
        c.seed(seedPath, { announce: room.trackers, name: seedName } as any, (torrent: any) => {
          if (settled) return;
          void (async () => {
          const file: RoomFile = {
            fileId: torrent.infoHash,
            name,
            size: room.e2e ? plainSize : (torrent.length || 0),
            infoHash: torrent.infoHash,
            magnetURI: torrent.magnetURI,
            addedBy: room.self.memberId,
            addedByName: room.self.name || 'You',
            addedAt: Date.now(),
            ...(room.e2e ? { enc: true, keyEpoch: seedEpoch } : {}),
          };
          const metadata = await verifyRoomFile(seedPath, file, torrent.torrentFile);
          if (roomFileStamp(filePath) !== originalStamp || rooms.get(room.roomId) !== room || netSuspended || room.kicked) {
            void Promise.resolve(c.remove(torrent)).catch(() => {});
            throw new Error('Room session ended or source changed while sharing');
          }
          if (settled) return;
          settled = true; c.removeListener('error', onErr);
          storageFor(room).metadata.set(file.fileId, metadata);
          storageFor(room).originals.add(file.fileId);
          rememberPlaintext(room, file.fileId, filePath, originalStamp);
          setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true, localPath: filePath, ...(cipherPath ? { cipherPath, cipherReady: true } : {}) });
          wireTorrentStats(room, torrent);
          resolve(file);
          })().catch(error => {
            void Promise.resolve(c.remove(torrent)).catch(() => {});
            onErr(error);
          });
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
      fs.mkdirSync(room.cacheDir, { recursive: true });
      const cipherDir = fs.mkdtempSync(path.join(room.cacheDir, 'share-'));
      const cipherPath = path.join(cipherDir, `${name}.enc`);
      const release = diskBudget.reserve([{ root: room.cacheDir, bytes: plainSize + 28 }]);
      encryptFile(filePath, cipherPath, seedSecret)
        .finally(release)
        .then(() => doSeed(cipherPath, `${name}.enc`, cipherPath))
        .catch((e) => reject(e instanceof Error ? e : new Error(String(e))));
    } else {
      doSeed(filePath, name);
    }
  });
}

/** Make sure a manifest file exists locally — seed it if already on disk,
 *  otherwise download it into the room folder over the WebTorrent swarm. */
function ensureLocal(room: Room, file: RoomFile, allowDownload = true): Promise<void> {
  const state = storageFor(room);
  const pending = state.pending.get(file.fileId);
  if (room.transfers.get(file.fileId)?.receivePaused) return Promise.resolve();
  if (pending) return pending;
  if (state.receives.has(file.fileId)) return Promise.resolve();
  const tr = room.transfers.get(file.fileId);
  const client = clients.get(room.roomId);
  if (client && findTorrent(client, file.infoHash) && !tr?.error && (tr?.haveLocally || (!file.enc && tr?.status !== 'error'))) return Promise.resolve();
  const epoch = state.epochs.get(file.fileId) ?? 0;
  setTransfer(room, file.fileId, { status: 'queued', phase: 'queued', downSpeed: 0, haveLocally: false }); pushState(room, true);
  const job = (async () => {
    const slot = await receiveQueue.acquire(room, file.fileId);
    if (!currentFile(room, file, epoch)) { slot(); return; }
    const lease: ReceiveLease = { holding: false, release: () => {
      if (lease.timer) clearTimeout(lease.timer); lease.disk?.(); lease.disk = undefined;
      if (state.receives.get(file.fileId) === lease) state.receives.delete(file.fileId);
      slot();
    } };
    state.receives.set(file.fileId, lease);
    try { await prepareLocal(room, file, () => currentFile(room, file, epoch), allowDownload); }
    catch (error) { lease.release(); throw error; }
    if (!lease.holding) lease.release();
  })().catch(error => {
    if (!currentFile(room, file, epoch)) return;
    fileFailure(room, file, 'transfer', error);
    log('room file preparation failed: ' + String(error));
  });
  state.pending.set(file.fileId, job);
  void job.finally(() => { if (state.pending.get(file.fileId) === job) state.pending.delete(file.fileId); });
  return job;
}

async function prepareLocal(room: Room, file: RoomFile, isCurrent: () => boolean, allowDownload: boolean): Promise<void> {
  if (!isCurrent()) return;
  const c = ensureClient(room), state = storageFor(room);
  const existing = findTorrent(c, file.infoHash);
  if (existing) {
    const tr = room.transfers.get(file.fileId);
    if (file.enc && tr?.cipherReady && !tr.haveLocally && tr.cipherPath) { await decryptOne(room, file, tr.cipherPath); return; }
    if (tr?.status !== 'error' && !tr?.error) return;
    await new Promise<void>((resolve, reject) => {
      try { void Promise.resolve(c.remove(existing, (e?: Error) => e ? reject(e) : resolve())).catch(reject); }
      catch (error) { reject(error); }
    });
    if (!isCurrent()) return;
  }
  if (room.e2e && !file.enc) throw new Error('An encrypted room cannot transfer a plaintext torrent');
  roomDiskName(file); // reject unsupported names before allocating a download
  const known = room.transfers.get(file.fileId);
  let candidate = file.enc ? known?.cipherPath : known?.localPath;
  // Legacy plaintext is a candidate for hash verification, never proof of readiness.
  if (!candidate && !file.enc) {
    const folder = file.folderId && room.folders.get(file.folderId);
    const segment = folder ? safeDirSegment(folder.name) : '';
    candidate = path.join(room.folder, segment || '', file.name);
  }
  let verified: string | undefined;
  if (candidate && fs.existsSync(candidate)) {
    setTransfer(room, file.fileId, { phase: 'verifying', status: 'queued', haveLocally: false }); pushState(room, true);
    try {
      const metadata = await verifyRoomFile(candidate, file, state.metadata.get(file.fileId));
      if (!isCurrent()) return;
      state.metadata.set(file.fileId, metadata);
      const root = file.enc ? room.cacheDir : room.folder;
      // Original author paths stay exactly where the user selected them.
      verified = !file.enc && state.originals.has(file.fileId) ? candidate
        : isManagedRoomPath(root, file.fileId, candidate) && path.basename(candidate) === roomDiskName(file) ? candidate
        : await (async () => {
          fs.mkdirSync(root, { recursive: true });
          const release = diskBudget.reserve([{ root, bytes: file.size + (file.enc ? 28 : 0) }]);
          try { return await migrateRoomFile(candidate!, root, file, metadata, isCurrent); }
          finally { release(); }
        })();
      if (!isCurrent()) return;
    } catch (error) {
      if (!isCurrent()) return;
      log('room local copy rejected (kept on disk): ' + String(error));
      state.originals.delete(file.fileId); state.proofs.delete(file.fileId);
    }
  }
  if (!isCurrent()) return;
  if (!verified && !allowDownload) {
    setTransfer(room, file.fileId, { phase: known?.error ? 'error' : 'queued', status: known?.error ? 'error' : 'queued', progress: 0, cipherReady: false, haveLocally: false }); pushState(room, true); return;
  }
  const root = file.enc ? room.cacheDir : room.folder;
  const partial = state.partialPaths.get(file.fileId);
  const canResume = partial && isManagedRoomPath(root, file.fileId, partial) && path.basename(partial) === roomDiskName(file);
  if (!verified) {
    fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(room.folder, { recursive: true });
    const lease = state.receives.get(file.fileId);
    if (lease) lease.disk = diskBudget.reserve([{ root, bytes: file.size + (file.enc ? 28 : 0) }, ...(file.enc ? [{ root: room.folder, bytes: file.size }] : [])]);
  }
  const target = verified ?? (canResume ? partial : newRoomFilePath(root, file.fileId, roomDiskName(file)));
  if (verified) state.partialPaths.delete(file.fileId);
  else state.partialPaths.set(file.fileId, target);
  setTransfer(room, file.fileId, { phase: verified ? 'verifying' : 'downloading', status: 'downloading', progress: 0, haveLocally: false, cipherReady: false, error: undefined,
    ...(file.enc ? { cipherPath: target, localPath: known?.localPath } : { localPath: target }) });
  persistManifest(room, file, file.enc ? undefined : target, file.enc ? target : undefined);
  const source = state.metadata.get(file.fileId) ?? file.magnetURI;
  const lease = state.receives.get(file.fileId);
  let completing: Promise<void> | undefined;
  const finish = (torrent: any) => {
    if (completing) return;
    completing = (async () => {
      if (!isCurrent()) return;
      setTransfer(room, file.fileId, { phase: 'verifying', downSpeed: 0 }); pushState(room, true);
      const raw = roomTorrentMetadata(file, torrent.torrentFile);
      const verifiedStamp = roomFileStamp(target);
      await verifyRoomFile(target, file, raw);
      if (!isCurrent()) return;
      if (!verifiedStamp || roomFileStamp(target) !== verifiedStamp) throw new Error('Room file changed after verification');
      state.metadata.set(file.fileId, raw);
      state.partialPaths.delete(file.fileId);
      if (file.enc) {
        setTransfer(room, file.fileId, { progress: 1, status: 'done', phase: 'ciphertext-ready', cipherReady: true, downSpeed: 0, cipherPath: target });
        persistManifest(room, file, undefined, target);
        if (known?.error?.stage === 'decryption') {
          // A persisted failure stays reviewable after restart; an explicit
          // retry or newly received key can clear it using these same bytes.
          setTransfer(room, file.fileId, { status: 'error', phase: 'error', error: known.error });
          persistManifest(room, file); pushState(room, true);
        } else await decryptOne(room, file, target, { metadata: raw, stamp: verifiedStamp });
      } else {
        rememberPlaintext(room, file.fileId, target, verifiedStamp);
        setTransfer(room, file.fileId, { progress: 1, status: 'seeding', downSpeed: 0, haveLocally: true, localPath: target });
        persistManifest(room, file, target);
        broadcast(room, { t: 'have', memberId: room.self.memberId, fileId: file.fileId });
        pushState(room, true);
      }
    })().catch(error => {
      if (!isCurrent()) return;
      state.proofs.delete(file.fileId);
      fileFailure(room, file, 'verification', error, { cipherReady: false });
      void Promise.resolve(c.remove(torrent)).catch(() => {});
      log('room file verification failed: ' + String(error)); pushState(room, true);
    }).finally(() => lease?.release());
  };
  if (lease) lease.holding = true;
  const torrent = addKnownTorrent(c, file.infoHash, source,
    { path: path.dirname(target), announce: room.trackers, skipVerify: false,
      store: class {
        constructor(chunkLength: number, options: any) {
          try {
            if (!isCurrent()) throw new Error('Room file operation canceled');
            const raw = roomTorrentMetadata(file, options.torrent.torrentFile);
            state.metadata.set(file.fileId, raw);
            const store = new RoomChunkStore(chunkLength, options);
            if (verified) store.put = (_index: number, _data: unknown, cb: (error: Error) => void) => cb(new Error('Verified room source changed; refusing to overwrite it'));
            else {
              const put = store.put.bind(store); let checkedAt = 0;
              store.put = (index: number, data: unknown, cb: (error?: Error) => void) => {
                try {
                  if (!isCurrent()) throw new Error('Room file operation canceled');
                  if (Date.now() - checkedAt >= 1000) { diskBudget.assertAvailable(root); checkedAt = Date.now(); }
                } catch (error) { queueMicrotask(() => cb(error as Error)); return; }
                put(index, data, cb);
              };
            }
            return store;
          } catch (error) {
            // Refuse the store before filesystem access. WebTorrent expects a
            // chunk store, so fail reads/writes via callbacks rather than throw
            // from its asynchronous metadata handler.
            const fail = (...args: any[]) => queueMicrotask(() => args[args.length - 1](error));
            const close = (cb: () => void) => queueMicrotask(cb);
            return { get: fail, put: fail, close, destroy: close };
          }
        }
      } }, (t: any) => {
      if (!isCurrent()) return;
      try { roomTorrentMetadata(file, t.torrentFile); }
      catch (error) {
        fileFailure(room, file, 'verification', error, { cipherReady: false });
        void Promise.resolve(c.remove(t)).catch(() => {});
        cancelFileOperation(room, file.fileId);
        log('room torrent metadata rejected: ' + String(error)); lease?.release(); pushState(room, true); return;
      }
      wireTorrentStats(room, t);
      persistManifest(room, file, file.enc ? undefined : target, file.enc ? target : undefined);
      t.once('done', () => finish(t));
      if (t.done || t.progress >= 1) finish(t);
    });
  torrent.on?.('error', (error: unknown) => {
    if (!isCurrent()) return;
    // Ciphertext seeding errors must not interrupt a local decrypt pipeline or
    // overwrite its result/reason. Network failures matter while fetching.
    if (room.transfers.get(file.fileId)?.cipherReady || room.transfers.get(file.fileId)?.haveLocally) return;
    fileFailure(room, file, 'transfer', error);
    cancelFileOperation(room, file.fileId); void Promise.resolve(c.remove(torrent)).catch(() => {});
    log('room torrent failed: ' + String(error)); pushState(room, true);
  });
  const arm = (ms: number) => {
    if (!lease || state.receives.get(file.fileId) !== lease) return;
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = setTimeout(() => {
      if (!isCurrent() || completing) return;
      fileFailure(room, file, 'transfer', new Error('Room file transfer stalled. Check peers and retry.'));
      cancelFileOperation(room, file.fileId); void Promise.resolve(c.remove(torrent)).catch(() => {});
    }, ms);
  };
  arm(torrent.torrentFile ? 180_000 : 60_000);
  torrent.on?.('metadata', () => arm(180_000));
  torrent.on?.('download', () => arm(180_000));
}

/** Restored paths are candidates until their original torrent hashes agree. */
function restoreManifestFile(room: Room, pf: PersistedRoomFile): void {
  if (isTombstonedAt(room, pf.fileId, pf.addedAt) || room.files.has(pf.fileId)) return;
  const file: RoomFile = {
    fileId: pf.fileId, name: pf.name, size: pf.size, infoHash: pf.infoHash,
    magnetURI: pf.magnetURI, addedBy: pf.addedBy, addedByName: pf.addedByName, addedAt: pf.addedAt,
    ...(pf.enc ? { enc: true, ...(pf.keyEpoch ? { keyEpoch: pf.keyEpoch } : {}) } : {}),
    ...(pf.folderId ? { folderId: pf.folderId } : {}),
    ...(Number.isFinite(pf.folderAt) ? { folderAt: pf.folderAt } : {}),
  };
  if (room.files.size >= ROOM_FILE_LIMIT) throw new Error("Room manifest exceeds 5000 files");
  if (!storeRoomManifestFile(room.files, file)) throw new Error("Saved room manifest exceeds its metadata budget");
  const state = storageFor(room);
  const pendingPath = file.enc ? pf.cipherPath : pf.localPath;
  if (pf.partialDownload && pendingPath && isManagedRoomPath(file.enc ? room.cacheDir : room.folder, file.fileId, pendingPath)
    && path.basename(pendingPath) === roomDiskName(file)) state.partialPaths.set(file.fileId, pendingPath);
  if (pf.torrentFile) {
    try { state.metadata.set(file.fileId, roomTorrentMetadata(file, Buffer.from(pf.torrentFile, 'base64'))); }
    catch (error) { log('room persisted metadata rejected: ' + String(error)); }
  }
  if (pf.localPath && (pf.localOriginal === true
    || (pf.localOriginal === undefined && pf.addedBy === room.self.memberId && !isManagedRoomPath(room.folder, file.fileId, pf.localPath)))) {
    state.originals.add(file.fileId);
  }
  setTransfer(room, file.fileId, { phase: pf.receivePaused ? 'paused' : pf.localError ? 'error' : 'queued', status: pf.localError ? 'error' : 'queued', error: pf.localError, receivePaused: pf.receivePaused === true,
    haveLocally: false, cipherReady: false, localPath: pf.localPath, cipherPath: pf.cipherPath });
  if ((file.enc ? pf.cipherPath : pf.localPath) || effectiveAutoFetch(room, file.folderId)) void ensureLocal(room, file, effectiveAutoFetch(room, file.folderId));
}

function wireTorrentStats(room: Room, torrent: any): void {
  const fileId = torrent.infoHash;
  const epoch = storageFor(room).epochs.get(fileId) ?? 0;
  let lastDiskCheck = 0;
  const update = () => {
    if (torrent.destroyed || rooms.get(room.roomId) !== room || !room.files.has(fileId) || room.transfers.get(fileId)?.released
      || (storageFor(room).epochs.get(fileId) ?? 0) !== epoch) return;
    const done = torrent.progress >= 1 || torrent.done;
    const prior = room.transfers.get(fileId);
    if (prior?.haveLocally && Date.now() - lastDiskCheck > 1000) {
      lastDiskCheck = Date.now();
      try { verifiedLocalFile(room.roomId, fileId); } catch { return; }
    }
    setTransfer(room, fileId, {
      progress: torrent.progress || (done ? 1 : 0),
      status: prior?.status === 'error' ? 'error' : prior?.haveLocally ? 'seeding' : prior?.cipherReady ? 'done' : 'downloading',
      phase: prior?.phase && prior.phase !== 'queued' ? prior.phase : 'downloading',
      downSpeed: torrent.downloadSpeed || 0,
      peers: torrent.numPeers || 0,
      haveLocally: prior?.haveLocally ?? false,
    });
    // Let peers see our download move (10%-step throttled; 'have' covers 100%).
    maybeBroadcastProg(room, fileId, torrent.progress || 0, !!prior?.haveLocally);
    pushState(room);
  };
  torrent.on('download', update);
  torrent.on('upload', update);
  torrent.on('wire', update);
  torrent.on('error', (e: any) => {
    const file = room.files.get(fileId), tr = room.transfers.get(fileId);
    if (torrent.destroyed || rooms.get(room.roomId) !== room || !file || tr?.released || (storageFor(room).epochs.get(fileId) ?? 0) !== epoch) return;
    if (!tr?.cipherReady && !tr?.haveLocally) fileFailure(room, file, 'transfer', e);
    log(`torrent ${fileId.slice(0, 8)} error: ${e?.message || e}`);
  });
  // Surface swarm distress that otherwise dies silently — piece-verification
  // failures arrive as 'warning' and look like an endless 0%-download without this.
  torrent.on('warning', (e: any) => log(`torrent ${fileId.slice(0, 8)} warning: ${e?.message || e}`));
  torrent.once('metadata', () => log(`torrent ${fileId.slice(0, 8)} metadata: length=${torrent.length} pieces=${torrent.pieces?.length}`));
  update();
}

// ── Rendezvous tracker (recreated when the room is rekeyed) ──────────────────
function attachTracker(room: Room, strict = false): void {
  try {
    const tracker = new TrackerClient({
      infoHash: room.rendezvous,
      peerId: room.peerId,
      announce: room.trackers,
      port: 6881,
      rtcConfig: { iceServers: room.iceServers },
      wrtc: nativeWrtc,
    });
    room.tracker = tracker;
    connectionMonitor(room).resetTrackers(room.trackers.length);
    const current = () => room.tracker === tracker && rooms.get(room.roomId) === room && !room.kicked && !netSuspended;
    tracker.on('peer', (peer: any) => { if (current()) attachWire(room, peer); else try { peer.destroy(); } catch { /* stale tracker */ } });
    tracker.on('warning', () => { if (current()) observeConnection(room, 'tracker-unavailable'); });
    tracker.on('error', (e: any) => { if (current()) { observeConnection(room, 'tracker-unavailable'); log('tracker error: ' + (e?.message || e)); } });
    tracker.on('update', (data: { announce?: string }) => { if (current()) { room.started = true; connectionMonitor(room).trackerAck(room.trackers.indexOf(data?.announce ?? '')); pushState(room); } });
    tracker.start();
    room.started = true;
    log('Tracker announced: ' + room.name + ' (' + room.rendezvous.slice(0, 8) + ')');
  } catch (e) {
    try { room.tracker?.stop(); room.tracker?.destroy(); } catch { /* partial start */ }
    room.tracker = null; room.started = false; observeConnection(room, 'tracker-unavailable');
    log('tracker start failed: ' + String(e));
    if (strict) throw e;
  }
}

function restartTracker(room: Room, strict = false): void {
  try { room.tracker?.stop(); room.tracker?.destroy(); } catch { /* ignore */ }
  room.tracker = null;
  attachTracker(room, strict);
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
  resetHelloSync(room);
  room.members.delete(kickedId);
  room.memberProg.delete(kickedId);
  delete room.typing[kickedId];
  // Drop the kicked member from voice too: the media PC is DTLS-SRTP direct and
  // survives the code rotation, so without this a kicked (or malicious) member
  // keeps hearing/speaking on the established connection. Enforce it on our side.
  room.voice.onMemberGone(kickedId);
  // Same for the virtual-LAN leg: free the kicked member's vIP/route and stop
  // forwarding to them (else their address is squatted / traffic black-holes).
  room.lan?.onMemberGone(kickedId);
  for (const wire of Array.from(room.wires.values())) {
    if (wire.memberId === kickedId) { try { wire.peer.destroy(); } catch { /* ignore */ } room.wires.delete(wire.id); }
  }
  // Re-mint every live host-granted lan-admit so admitted players aren't silently
  // dropped at a late-joiner/reconnect after the topic rotation (must-fix #2). This
  // no-ops unless we are the session host with an active session; lan-admit binds
  // sessionId (not topic) so the re-flood is belt-and-suspenders for convergence.
  room.lan?.remintAdmits();
  room.code = newCode;
  room.key = deriveKey(newCode);
  room.topic = topicHash(newCode);
  room.rendezvous = rendezvousId(room.key);
  try { ipcRenderer.send('room-rekey', { roomId: room.roomId, code: newCode }); } catch { /* ignore */ }
  // The signed E2E config binds the topic, which just rotated: the owner mints a
  // fresh one (broadcast in the re-greet below); members drop the now-stale blob
  // and pick the owner's new one from its HELLO. Flag/secret themselves persist
  // (that's the point of the secret being separate from the code).
  if (room.e2e && room.ownerId === room.self.memberId) {
    // Rotate the CONTENT key too: files shared after the kick use a secret the
    // kicked member never receives. The outgoing secret joins the decrypt-only
    // keyring (old files stay readable; they were already in their hands).
    room.prevSecrets = mergeContentKeys('', [room.secret], room.prevSecrets);
    room.secret = generateRoomSecret();
  }
  room.keyPages = []; room.keyRequestedAt.clear(); room.keySentAt.clear();
  if (room.e2e) {
    room.e2eCfg = room.ownerId === room.self.memberId ? signE2ECfg(room) : null;
    persistE2E(room);
  }
  // Ban the kicked identity: the rekey we just verified is owner-signed, so
  // every member independently records it. Their gossip is dropped from now
  // on — a leaked new code alone no longer readmits them.
  if (kickedId) {
    room.bans.add(kickedId);
    try { ipcRenderer.send('room-rekey', { roomId: room.roomId, code: newCode, banId: kickedId }); } catch { /* ignore */ }
  }
  room.banState = null;
  mintBanState(room); persistBanState(room);
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
    room.pendingServerCommands.cancel();
    try { room.voice.suspend(); } catch { /* ignore */ } // voice leaks the real IP too — tear it down
    teardownLan(room); // the LAN adapter holds a real interface too — revert it with the rest
    try { room.tracker?.stop(); room.tracker?.destroy(); } catch { /* ignore */ }
    room.tracker = null;
    for (const wire of room.wires.values()) { try { wire.peer.destroy(); } catch { /* ignore */ } }
    room.wires.clear();
    closeStreamServers(room.roomId); // a live stream server keeps the real IP off loopback, but stop it with the rest
    const c = clients.get(room.roomId);
    clients.delete(room.roomId);
    try { c?.destroy(); } catch { /* ignore */ }
    removeFileClient(room.roomId);
    cancelReceives(room);
    room.started = false;
    if (room.snapshotTimer) clearTimeout(room.snapshotTimer);
    if (room.heartbeatTimer) clearInterval(room.heartbeatTimer);
    if (room.profileAnnounce) clearTimeout(room.profileAnnounce);
    room.snapshotTimer = null; room.heartbeatTimer = null; room.profileAnnounce = null;
    rooms.delete(room.roomId);
    n++;
  }
  log('VPN kill-switch: suspended networking for ' + n + ' room(s)');
}

/** We were removed by the owner: surface it in the UI, stop announcing, and drop
 *  every wire so we don't linger in the swarm the room just rotated away from. */
function markKicked(room: Room, byName: string): void {
  if (room.kicked) return;
  room.kicked = true; cancelReceives(room);
  room.kickedBy = byName;
  logEvent(room, { type: 'kicked', actorId: room.ownerId, actorName: byName, targetName: room.self.name || 'You' });
  try { room.voice.suspend(); } catch { /* ignore */ }
  teardownLan(room); // being kicked also tears down our LAN adapter for this room
  try { room.tracker?.stop(); room.tracker?.destroy(); } catch { /* ignore */ }
  room.tracker = null;
  for (const wire of room.wires.values()) { try { wire.peer.destroy(); } catch { /* ignore */ } }
  room.wires.clear();
  closeStreamServers(room.roomId);
  const client = clients.get(room.roomId); clients.delete(room.roomId);
  try { client?.destroy(); } catch { /* ignore */ }
  removeFileClient(room.roomId);
  room.started = false;
  pushState(room, true);
}

const pendingRoomRekeys = new WeakSet<Room>();

/** Owner-only: remove a member by rotating the room code away from them. */
function kickMember(room: Room, memberId: string): void {
  if (!room.bans.has(memberId) && room.bans.size >= ROOM_BAN_LIMIT) throw new Error('Room ban history is full; create a new room to remove more profiles');
  if (pendingRoomRekeys.has(room)) throw new Error('A room key rotation is already in progress');
  if (room.e2e && !completeContentKeys(room.e2eCfg, room.secret, room.prevSecrets)) throw new Error('Wait for room key history to finish syncing before rotating keys');
  if (room.e2e && new Set([room.secret, ...room.prevSecrets].filter(Boolean)).size >= ROOM_KEY_LIMIT) {
    throw new Error('Room key history is full; create a new room and share the active files there');
  }
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
  pendingRoomRekeys.add(room);
  setTimeout(() => {
    try {
      if (rooms.get(room.roomId) !== room) return;
      sendRekey(room, oldKey, rekey, memberId);
      applyLocalRekey(room, newCode, memberId, kickedName);
    } finally { pendingRoomRekeys.delete(room); }
  }, 300);
}

/** Owner-only: hand the room to another member. Signs a transfer every member
 *  (and every future joiner, via the re-served chain) can verify, applies it
 *  locally — we become a regular member — then gossips it. */
function transferOwnership(roomId: string, memberId: string): RoomState {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  if (pendingRoomRekeys.has(room)) throw new Error('A room key rotation is already in progress');
  if (room.ownerId !== room.self.memberId) throw new Error('Only the room owner can transfer ownership');
  const newOwnerId = String(memberId || '');
  if (!newOwnerId || newOwnerId === room.self.memberId) throw new Error('Pick another member to transfer ownership to');
  if (!room.members.has(newOwnerId)) throw new Error('That member is not in this room');
  if (room.bans.has(newOwnerId)) throw new Error('That member was removed from this room');
  const recipient = room.members.get(newOwnerId)!;
  if (recipient.guest || recipient.capabilities && !recipient.capabilities.includes('owner-manage')) throw new Error('Ownership requires a desktop client with room management support');
  if (room.transferChain.length >= MAX_TRANSFER_CHAIN) throw new Error('This room has already changed hands the maximum number of times');
  const by = room.self.memberId;
  const at = Math.max(Date.now(), room.transferAt + 1); // strictly newer, never in the past
  // The signature domain is the chain's GENESIS owner (stable across rekeys) —
  // ours if we are the first to transfer (empty chain = we are the genesis owner).
  const root = room.transferChain.length ? room.transferChain[0].by : by;
  const sig = signBytes(room, transferCanonical(root, { by, newOwnerId, at }));
  mintBanState(room);
  const msg: Msg = { t: 'transfer', newOwnerId, at, by, pub: room.self.pub, sig, ...(room.banState ? { banState: room.banState } : {}) };
  if (!applyTransferMsg(room, msg)) throw new Error('Ownership transfer failed');
  broadcast(room, msg);
  return buildState(room);
}

// ── Room lifecycle ───────────────────────────────────────────────────────────
function startRoom(p: { roomId: string; name: string; code: string; folder: string;
  self: { memberId: string; name: string; avatarSeed: string; color?: string; status?: string; avatarImg?: string; pub: string; priv: string }; useTurn: boolean; turnServers?: any[]; trackers?: string[]; tombstones?: Record<string, number>; tombSigs?: Record<string, { by: string; pub: string; sig: string }>; revives?: Record<string, number>; manifest?: PersistedRoomFile[]; folders?: RoomFolder[]; folderTombs?: Record<string, number>; ownerId?: string; ownerPin?: string; transferChain?: TransferLink[]; nameAt?: number; topicText?: string; topicAt?: number; topicMsg?: { text: string; at: number; by: string; pub: string; sig: string } | null; mutes?: string[]; history?: RoomEvent[]; chat?: RoomChatMessage[]; reacts?: Record<string, Record<string, string[]>>; chatReacts?: Record<string, Record<string, string[]>>; chatEdits?: Record<string, { text: string; at: number; by: string; pub: string; sig: string }>; identities?: Record<string, string>; e2e?: boolean; secret?: string; prevSecrets?: string[]; bans?: string[]; banState?: RoomBanSnapshot; e2eCfg?: E2ECfg | null; keyPages?: RoomKeyPage[]; cacheDir?: string; autoFetch?: boolean; folderFetch?: Record<string, boolean>; upKbps?: number; downKbps?: number; lanSession?: string; lanFloor?: number; resources?: RoomResourcePolicy }): RoomState {
  // Authoritative kill-switch gate: refuse to bring up ANY room networking while
  // the VPN is down, no matter how this join raced past the manager's flag. The
  // manager clears this via 'netResume' before it re-joins on VPN restore.
  if (netSuspended) throw new Error('Rooms are paused: the VPN is down (kill-switch)');
  if (p.resources) applyResourcePolicy(p.resources);
  let room = rooms.get(p.roomId);
  if (room) { pinRoomOwner(room, p.ownerPin || ''); return buildState(room); }

  if ((p.manifest?.length || 0) > ROOM_FILE_LIMIT || (p.folders?.length || 0) > ROOM_FOLDER_LIMIT
    || Object.keys(p.identities || {}).length > ROOM_IDENTITY_LIMIT
    || Object.keys(p.folderTombs || {}).length > ROOM_FOLDER_TOMB_LIMIT
    || Object.keys(p.tombstones || {}).length > ROOM_FILE_LIMIT || Object.keys(p.revives || {}).length > ROOM_FILE_LIMIT) throw new Error("Saved room exceeds its manifest or identity limit");
  fs.mkdirSync(p.folder, { recursive: true });

  const iceServers = p.useTurn && p.turnServers && p.turnServers.length
    ? STUN_SERVERS.concat(p.turnServers)
    : STUN_SERVERS.slice();

  const key = deriveKey(p.code); // one PBKDF2; feeds both the gossip key and the rendezvous id
  room = {
    roomId: p.roomId,
    name: p.name,
    nameAt: Number(p.nameAt) || 0,
    topicText: String(p.topicText || '').slice(0, 300),
    topicAt: Number(p.topicAt) || 0,
    topicMsg: p.topicMsg && typeof p.topicMsg === 'object' ? p.topicMsg : null,
    code: p.code,
    folder: p.folder,
    key,
    topic: topicHash(p.code),
    rendezvous: rendezvousId(key),
    peerId: randomPeerId(),
    iceServers,
    // Resolved by the manager from settings; fall back to the public set so an
    // older payload without the field behaves exactly as before.
    trackers: Array.isArray(p.trackers) && p.trackers.length ? p.trackers : RENDEZVOUS_TRACKERS,
    tracker: null,
    started: false,
    self: { ...p.self, color: p.self.color || '', status: p.self.status || '', avatarImg: p.self.avatarImg || '' },
    // Honor the invite's owner pin: never trust a persisted ownerId that doesn't
    // match it (it'd be a pre-pin or tampered value) — re-learn under the pin.
    ownerId: (p.ownerPin && p.ownerId && p.ownerId !== p.ownerPin) ? '' : (p.ownerId || ''),
    ownerPin: p.ownerPin || '',
    transferChain: [],
    transferAt: 0,
    // The invite code is the E2E source of truth for new-format rooms: even if
    // the persisted flag is missing/stale, a "-e2e" code must never run plaintext.
    e2e: p.e2e || codeIsE2E(p.code),
    secret: p.secret || '',
    prevSecrets: mergeContentKeys(p.secret || '', Array.isArray(p.prevSecrets) ? p.prevSecrets.filter(x => typeof x === 'string' && /^[a-f0-9]{64}$/i.test(x)) : []),
    keyPages: [], keyRequestedAt: new Map(), keySentAt: new Map(),
    banState: null,
    bans: new Set(Array.isArray(p.bans) ? p.bans.map((x) => clampStr(x, MAX_STR)).filter(Boolean) : []),
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
    // The LAN session this room re-enters + its anti-replay watermark. Needed AT
    // JOIN, not at lanStart: a joiner builds a PASSIVE session straight from the
    // host's gossip (ensureLanSession), long before it accepts — and that core
    // must already refuse grants replayed from an earlier run of the same session.
    lanSession: p.lanSession ? String(p.lanSession) : undefined,
    lanFloor: Number.isSafeInteger(p.lanFloor) && (p.lanFloor as number) > 0 ? Number(p.lanFloor) : 0,
    upKbps: Math.max(0, Number(p.upKbps) || 0),
    downKbps: Math.max(0, Number(p.downKbps) || 0),
    mutes: new Set(p.mutes || []),
    history: (p.history || []).slice(-200),
    chat: retainRoomChat(p.chat || []),
    typing: {},
    lastTypingSent: 0,
    fileReacts: reactsFromRecord(p.reacts),
    chatReacts: reactsFromRecordIn(p.chatReacts, CHAT_REACTION_EMOJI, MAX_REACT_MSGS),
    chatEdits: chatEditsFromRecord(p.chatEdits),
    pendingEdits: new Map(),
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
    srvMirrors: new Map(),
    pendingServerCommands: new PendingServerCommands(),
    srvCmdAt: new Map(),
    seenGids: new Set(),
    seenGidOrder: [],
    kicked: false,
    kickedBy: '',
    snapshotTimer: null,
    heartbeatTimer: null,
    lastSnapshot: 0,
  };
  rooms.set(p.roomId, room);
  try {
    room.voice = createVoiceSession(room);

    // Ownership-transfer chain: re-verify the persisted chain from the pin/TOFU
    // root (the store may have been tampered with — same discipline as identities
    // and e2eCfg) and let IT, not the bare persisted ownerId, decide the owner.
    // Runs BEFORE the E2E block below so the owner-mint check sees the final id.
    if (Array.isArray(p.transferChain) && p.transferChain.length) {
      const fallbackOwner = room.ownerId;
      room.ownerId = ''; // the chain roots at the pin (or its own root under TOFU)
      if (!adoptChain(room, p.transferChain, true)) room.ownerId = fallbackOwner; // rejected wholesale — fall back
    }

    if (room.bans.size > ROOM_BAN_LIMIT) throw new Error('Room ban history exceeds the supported limit');
    if (p.banState) adoptBanState(room, p.banState);
    mintBanState(room);
    if (room.bans.has(room.self.memberId)) { markKicked(room, '?'); return buildState(room); }

    // E2E authenticity: the owner mints the signed config fresh (it holds the
    // private key, so no persistence is needed); everyone else restores the
    // owner's persisted blob — re-verified, since the topic may have rotated or
    // the store been tampered with — and re-serves it to joiners.
    if (p.e2eCfg && verifyE2ECfg(room, p.e2eCfg)) {
      room.e2eCfg = p.e2eCfg; room.e2eSigned = true;
      for (const page of p.keyPages || []) adoptKeyPage(room, page);
    }
    if (room.e2e && room.secret && room.ownerId === room.self.memberId && completeContentKeys(room.e2eCfg, room.secret, room.prevSecrets)) {
      room.e2eCfg = signE2ECfg(room); room.e2eSigned = !!room.e2eCfg;
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
        const scanRoom = room;
        const entries = fs.readdirSync(room.folder).filter(entry => !known.has(entry)).slice(0, Math.max(0, ROOM_FILE_LIMIT - room.files.size));
        void (async () => {
          for (const entry of entries) {
            if (rooms.get(p.roomId) !== scanRoom || netSuspended || scanRoom.kicked) return;
            const full = path.join(scanRoom.folder, entry);
            try {
              if (fs.statSync(full).isFile()) {
                const file = await seedLocal(scanRoom, full);
                if (rooms.get(p.roomId) === scanRoom && !netSuspended && !scanRoom.kicked) mergeFileLocal(scanRoom, file, full);
              }
            } catch { /* unreadable files do not stop the room */ }
            await new Promise<void>(resolve => setTimeout(resolve, 20));
          }
        })();
      } catch { /* folder may be empty */ }
    }

    // Rendezvous tracker (announces the current topicHash; recreated on rekey).
    attachTracker(room, true);

    // Heartbeat.
    const beat = setInterval(() => {
      const r = rooms.get(p.roomId);
      if (r !== room) { clearInterval(beat); return; }
      broadcast(r, { t: 'ping', memberId: r.self.memberId, name: r.self.name || 'You', avatarSeed: r.self.avatarSeed, have: buildState(r).members[0].have, roomName: r.name, ownerId: r.ownerId, protocolVersion: ROOM_PROTOCOL_VERSION, capabilities: [...DESKTOP_ROOM_CAPABILITIES], watchSync: 2 });
      // Voice-roster liveness: a member who dropped offline (crash/sleep — no 'bye',
      // no voice-state) would otherwise linger in the voice panel with a stale mute
      // badge, and their MediaPeer would never be reclaimed. onMemberGone is a cheap
      // no-op for members with no voice footprint.
      const cutoff = Date.now() - OFFLINE_AFTER;
      for (const m of r.members.values()) {
        if (m.lastSeen < cutoff) r.voice.onMemberGone(m.memberId);
      }
      for (const wire of r.wires.values()) if (wire.peer.connected) void sampleChannelPath(r, wire);
      // Forget the profile announce for members gone offline (crash — no 'bye'):
      // their session-only profile cache died with them, so their next greeting
      // must trigger a fresh announce even when it arrives via a relay.
      for (const id of r.profileSentTo) {
        const m = r.members.get(id);
        if (!m || m.lastSeen < cutoff) r.profileSentTo.delete(id);
      }
      pushState(r);
      requestKeyPages(room);
    }, PING_INTERVAL);
    room.heartbeatTimer = beat;

    pushState(room, true);
    return buildState(room);
  } catch (e) {
    void closeRoom(room, false).catch((error) => log('setup cleanup failed: ' + String(error)));
    throw e;
  }
}

/** A locally-seeded file: register in manifest + announce to peers.
 *  ANY tombstone blocks this path, regardless of timestamps: the startup folder
 *  scan feeds it, and a deleted file still sitting on disk must not silently
 *  revive itself. Only the explicit addFiles path lifts a tombstone. */
function mergeFileLocal(room: Room, file: RoomFile, localPath?: string): void {
  if (room.tombstones.has(file.fileId)) return;
  if (!room.files.has(file.fileId)) {
    if (!storeRoomManifestFile(room.files, file)) { room.manifestLimited = true; return; }
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
  if (room.folders.size >= ROOM_FOLDER_LIMIT) throw new Error("Room folder limit reached (512)");
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
  if (!room.folderTombstones.has(folderId) && room.folderTombstones.size >= ROOM_FOLDER_TOMB_LIMIT) throw new Error("Room folder deletion limit reached");
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

const closingRooms = new Map<string, Promise<void>>();

async function disposeRoom(room: Room, graceful: boolean): Promise<void> {
  const roomId = room.roomId; receiveQueue.cancelWaiting(room);
  resetHelloSync(room);
  try { room.voice?.suspend(); } catch { /* release pending capture too */ }
  try { teardownLan(room); } catch { /* continue closing other resources */ }
  if (room.profileAnnounce) clearTimeout(room.profileAnnounce);
  if (room.snapshotTimer) clearTimeout(room.snapshotTimer);
  if (room.heartbeatTimer) clearInterval(room.heartbeatTimer);
  room.profileAnnounce = null; room.snapshotTimer = null; room.heartbeatTimer = null;
  if (graceful) { try { broadcast(room, { t: 'bye', memberId: room.self.memberId }); } catch { /* peer already gone */ } }
  if (rooms.get(roomId) === room) rooms.delete(roomId);
  const client = clients.get(roomId);
  clients.delete(roomId);
  closeStreamServers(roomId);
  if (graceful) await new Promise<void>((resolve) => setTimeout(resolve, 200));
  try { room.tracker?.stop(); room.tracker?.destroy(); } catch { /* ignore */ }
  room.tracker = null; room.started = false;
  for (const wire of room.wires.values()) { try { wire.peer.destroy(); } catch { /* ignore */ } }
  room.wires.clear();
  // WebTorrent's callback runs after stores/handles close, not merely after the
  // destroy method returns. Main may delete the download folder after this ack.
  try {
    if (client) await new Promise<void>((resolve, reject) => {
      try { client.destroy((error?: Error | null) => error ? reject(error) : resolve()); }
      catch (error) { reject(error); }
    });
  } finally { removeFileClient(roomId); refreshFileBudget(); cancelReceives(room); pushResourceStates(); }
}

async function closeRoom(room: Room, graceful: boolean): Promise<void> {
  room.pendingServerCommands.cancel();
  const roomId = room.roomId;
  const closing = closingRooms.get(roomId);
  if (closing) return closing;
  const operation = disposeRoom(room, graceful);
  closingRooms.set(roomId, operation);
  try { await operation; }
  finally { if (closingRooms.get(roomId) === operation) closingRooms.delete(roomId); }
}

async function leaveRoom(roomId: string): Promise<void> {
  const closing = closingRooms.get(roomId);
  if (closing) return closing;
  const room = rooms.get(roomId);
  if (room) await closeRoom(room, true);
}

function pinRoomOwner(room: Room, pin: string): void {
  if (!pin) return;
  if (!/^[a-f0-9]{32}$/.test(pin)) throw new Error('Invalid invite owner pin');
  assertCompatibleOwnerPin(room, pin); // room.transferChain has been verified
  if (!room.ownerPin) room.ownerPin = pin;
  pushState(room, true);
}

/**
 * Stop seeding a file so Windows releases the on-disk handle (lets the user open
 * or extract an archive). The file stays on disk and in the manifest — we just
 * remove the torrent from the WebTorrent client. Other members keep it.
 */
async function releaseFile(roomId: string, fileId: string): Promise<void> {
  const room = rooms.get(roomId);
  if (!room) return;
  cancelFileOperation(room, fileId);
  const tr = room.transfers.get(fileId);
  if (tr) { tr.status = 'done'; tr.released = true; tr.downSpeed = 0; tr.peers = 0; }
  const c = clients.get(roomId), t = c && findTorrent(c, fileId);
  if (t) {
    await new Promise<void>((resolve, reject) => {
      try {
        const result = c.remove(t, (error?: Error) => error ? reject(error) : resolve());
        void Promise.resolve(result).catch(reject);
      } catch (error) { reject(error); }
    });
  }
  if (rooms.get(roomId) === room) pushState(room, true);
}

const cleanupPreviews = new WeakMap<Room, { id: string; at: number; copies: RoomCopy[] }>();
async function diskUsage(roomId: string): Promise<RoomDiskUsage> {
  const room = rooms.get(roomId); if (!room) throw new Error('Room not active');
  const copies: RoomCopy[] = [], files: RoomDiskUsage['files'] = [], seenOriginals = new Set<string>();
  let originals = 0, skipped = 0, protectedCiphertext = 0;
  for (const file of room.files.values()) {
    const tr = room.transfers.get(file.fileId), original = storageFor(room).originals.has(file.fileId);
    const plain = original ? undefined : managedCopy(room.folder, file.fileId, tr?.localPath, 'plaintext');
    const cipher = managedCopy(room.cacheDir, file.fileId, tr?.cipherPath, 'ciphertext');
    if (original && tr?.localPath) { try { const stat = fs.lstatSync(tr.localPath); if (stat.isFile() && !stat.isSymbolicLink() && !seenOriginals.has(path.resolve(tr.localPath))) { originals += stat.size; seenOriginals.add(path.resolve(tr.localPath)); } } catch { skipped++; } }
    if (!original && tr?.localPath && fs.existsSync(tr.localPath) && !plain || tr?.cipherPath && fs.existsSync(tr.cipherPath) && !cipher) skipped++;
    if (plain) copies.push(plain); if (cipher && !original) copies.push(cipher);
    if (cipher && original) protectedCiphertext += cipher.bytes;
    if (plain || cipher || original) files.push({ fileId: file.fileId, name: file.name, plaintext: plain?.bytes ?? 0, ciphertext: cipher?.bytes ?? 0, removable: (plain?.bytes ?? 0) + (original ? 0 : cipher?.bytes ?? 0), original });
  }
  const [plainTree, cipherTree] = await Promise.all([roomTreeBytes(path.join(room.folder, '.havvn-files')), roomTreeBytes(room.cacheDir)]);
  if (rooms.get(roomId) !== room) throw new Error('Room session ended');
  const previewId = crypto.randomBytes(16).toString('hex');
  cleanupPreviews.set(room, { id: previewId, at: Date.now(), copies });
  const plaintext = copies.filter(c => c.kind === 'plaintext').reduce((n,c)=>n+c.bytes,0);
  const ciphertext = copies.filter(c => c.kind === 'ciphertext').reduce((n,c)=>n+c.bytes,0);
  return { previewId, plaintext: plainTree.bytes, ciphertext: cipherTree.bytes, originals, protectedCiphertext, untrackedBytes: Math.max(0, plainTree.bytes - plaintext) + Math.max(0, cipherTree.bytes - ciphertext - protectedCiphertext), removable: plaintext + ciphertext, files, skipped: skipped + plainTree.skipped + cipherTree.skipped };
}
async function cleanupCopies(roomId: string, previewId: string, fileIds: unknown): Promise<{ bytes: number; files: number }> {
  const room = rooms.get(roomId), preview = room && cleanupPreviews.get(room);
  if (!room || !preview || preview.id !== previewId || Date.now() - preview.at > 300000) throw new Error('Disk preview expired; refresh before cleaning');
  if (!Array.isArray(fileIds) || !fileIds.length || fileIds.length > ROOM_FILE_LIMIT || fileIds.some(id => typeof id !== 'string' || id.length > 128)) throw new Error('Invalid cleanup selection');
  const ids = new Set<string>(fileIds), copies = preview.copies.filter(c => ids.has(c.fileId));
  if ([...ids].some(id => !copies.some(c => c.fileId === id))) throw new Error('No managed local copy in the selection');
  cleanupPreviews.delete(room); // one-use preview; simultaneous commands cannot reuse it
  // Validate EVERY target before changing transfers or removing any bytes.
  for (const copy of copies) if (managedCopy(copy.root, copy.fileId, copy.path, copy.kind)?.stamp !== copy.stamp) throw new Error('Local copy changed; refresh disk usage');
  let bytes = 0;
  for (const id of ids) {
    const state = storageFor(room), file = room.files.get(id);
    if (!file || state.stopping.has(id)) throw new Error('File is busy; refresh and retry');
    const jobs = [state.pending.get(id), state.decrypting.get(id)].filter(Boolean);
    let stopped!: () => void;
    const barrier = new Promise<void>(resolve => { stopped = resolve; });
    state.stopping.set(id, barrier);
    try {
    closeStreamServers(roomId, id);
    // Persist a local hold before stopping writers. Auto-fetch stays stopped after restart.
    setTransfer(room, id, { receivePaused: true }); persistManifest(room, file);
    await releaseFile(roomId, id);
    await Promise.allSettled(jobs);
    if (rooms.get(roomId) !== room || room.files.get(id) !== file) throw new Error('Room file session ended');
    const selected = copies.filter(c => c.fileId === id);
    try {
      for (const copy of selected) {
        bytes += deleteManagedCopy(copy);
        if (copy.kind === 'plaintext') { state.proofs.delete(id); state.partialPaths.delete(id); setTransfer(room,id,{ localPath: undefined, localStamp: undefined, haveLocally: false }); }
        else { state.decryptKeys.delete(id); setTransfer(room,id,{ cipherPath: undefined, cipherReady: false }); }
      }
    } finally {
      setTransfer(room,id,{ status: 'queued', phase: 'paused', released: false, progress: state.originals.has(id) ? 1 : 0, downSpeed: 0, peers: 0 });
      persistManifest(room,file); pushState(room,true);
    }
    } finally { if (state.stopping.get(id) === barrier) state.stopping.delete(id); stopped(); }
  }
  return { bytes, files: ids.size };
}

/** Resume seeding a released file (the row's "Seed again"). */
function reseedFile(roomId: string, fileId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  const file = room.files.get(fileId);
  if (!file) return;
  const tr = room.transfers.get(fileId);
  if (storageFor(room).stopping.has(fileId)) throw new Error('File cleanup is in progress');
  if (tr) { tr.released = false; tr.receivePaused = false; }
  persistManifest(room, file);
  ensureLocal(room, file); // idempotent — re-seeds from disk or re-downloads
  pushState(room, true);
}

/**
 * Watch-while-downloading: start (or reuse) WebTorrent's own HTTP stream server
 * for one non-E2E room file and hand the renderer a 127.0.0.1 URL to play. The
 * server serves Range requests straight off the live torrent — it blocks on and
 * prioritizes the not-yet-downloaded pieces the player asks for — so a directly-
 * playable file plays before the download finishes. Auto-starts the download if
 * the file isn't being fetched yet (manual mode), and waits for metadata so the
 * torrent's file index actually resolves. Refused for E2E rooms: the swarm
 * carries ciphertext, so there is no plaintext to stream until decrypt.
 */
async function watchStream(roomId: string, fileId: string): Promise<{ port: number; index: number }> {
  const startedAt = Date.now();
  if (netSuspended) throw new Error('Rooms are paused: the VPN is down (kill-switch)');
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  if (room.e2e) throw new Error('Encrypted room files can only be watched once fully downloaded');
  const file = room.files.get(fileId);
  if (!file) throw new Error('File not found in this room');
  const key = `${roomId}:${fileId}`;
  const existing = streamServers.get(key);
  if (existing) return { port: existing.port, index: 0 };
  const c = ensureClient(room);
  let t = findTorrent(c, file.infoHash);
  if (!t) {
    if (room.transfers.get(fileId)?.receivePaused) throw new Error('Receiving is paused. Resume this file before starting playback.');
    const job = ensureLocal(room, file);
    receiveQueue.prioritize(room, fileId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([job, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('This file is waiting in the receive queue. Pause another receive or try playback later.')), 5000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    t = findTorrent(c, file.infoHash);
  }
  if (!t) throw new Error('Could not start streaming this file');
  // Serving /0 needs the torrent's file list, which arrives with metadata (a
  // magnet download fetches it from peers first). Wait, bounded, for a sleeping room.
  if (!t.ready) {
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('Timed out waiting for file info from peers — is anyone online with this file?')), Math.max(1, 25000 - (Date.now() - startedAt)));
      const done = () => { clearTimeout(to); resolve(); };
      t.once('ready', done);
      t.once('metadata', done);
    });
  }
  // A room started/torn down while we awaited metadata — don't leak a server.
  if (netSuspended || rooms.get(roomId) !== room) throw new Error('The room session ended');
  const server = createTorrentStreamServer(t);
  await new Promise<void>((resolve, reject) => {
    try { server.listen(0, '127.0.0.1', () => resolve()); server.on('error', reject); }
    catch (e) { reject(e); }
  });
  const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Stream server did not bind TCP');
      const port = address.port;
  streamServers.set(key, { server, port });
  log('room stream server started for ' + file.name + ' on 127.0.0.1:' + port);
  return { port, index: 0 };
}

/** Close every stream server a room opened (leave / kick / VPN suspend). */
function closeStreamServers(roomId: string, fileId?: string): void {
  for (const [key, s] of Array.from(streamServers)) {
    if (fileId ? key === `${roomId}:${fileId}` : key === roomId || key.startsWith(roomId + ':')) {
      try { s.server.close(); } catch { /* ignore */ }
      streamServers.delete(key);
    }
  }
}

const chatSends = new WeakMap<Room, Map<string, { text: string; replyTo?: string; promise: Promise<RoomChatAck> }>>();
/** Acknowledge only a signed, durable LOCAL copy. Remote delivery is best effort. */
function sendChat(roomId: string, rawText: string, replyToId?: string, messageId = crypto.randomBytes(16).toString('hex')): Promise<RoomChatAck> {
  const room = rooms.get(roomId);
  if (!room || room.kicked || netSuspended) throw new Error('Room not active');
  const text = String(rawText || '').trim();
  if (!text || text.length > 2000 || !/^[a-f0-9]{32}$/.test(messageId)) throw new Error('Invalid chat message');
  if (replyToId !== undefined && !/^[\w-]{1,128}$/.test(replyToId)) throw new Error('Invalid chat reply');
  let sends = chatSends.get(room);
  if (!sends) { sends = new Map(); chatSends.set(room, sends); }
  const pending = sends.get(messageId);
  if (pending) {
    if (pending.text !== text || pending.replyTo !== replyToId) throw new Error('Message ID already belongs to different content');
    return pending.promise;
  }
  const promise = (async (): Promise<RoomChatAck> => {
  const prior = room.chat.find(m => m.id === messageId);
  if (prior && (prior.memberId !== room.self.memberId || prior.text !== text || (prior.replyTo || undefined) !== replyToId)) throw new Error('Message ID already belongs to different content');
  const msg: RoomChatMessage = {
    id: messageId,
    at: Date.now(),
    memberId: room.self.memberId,
    name: room.self.name || 'You',
    avatarSeed: room.self.avatarSeed,
    text,
  };
  // v2 signs the reply pointer and quote snapshot in addition to the legacy body.
  // Snapshot the parent's CURRENT text (edited if edited) so the quote is stable
  // even if the parent later scrolls out of the capped window.
  const parent = replyToId ? room.chat.find((c) => c.id === replyToId) : undefined;
  if (replyToId) msg.replyTo = replyToId;
  if (parent) {
    msg.replyTo = parent.id;
    msg.replyName = parent.name.slice(0, 256);
    msg.replyText = (room.chatEdits.get(parent.id)?.text ?? parent.text).slice(0, 140);
  }
  const sig = prior?.sig || signChat(room, msg);
  if (!sig) throw new Error('Could not sign this chat message');
  const contextSig = prior?.contextSig || signBytes(room, Buffer.from(chatContextCanonical(room.topic, msg)));
  if (!contextSig) throw new Error('Could not sign this chat reply');
  const result: { duplicate: boolean; message?: RoomChatMessage } = await ipcRenderer.invoke('room-persist-chat', { roomId, message: prior ?? { ...msg, pub: room.self.pub, sig, chatV: 2, contextSig } });
  if (rooms.get(roomId) !== room || room.kicked || netSuspended) throw new Error('Room session ended while saving the message');
  // Bind our own identity locally too, so the roster is complete on our side.
  if (!room.identities.has(room.self.memberId)) room.identities.set(room.self.memberId, room.self.pub);
  if (result.message) {
    addChat(room, result.message, false, true);
    try { broadcast(room, { t: 'chat', ...chatEnvelope(result.message)!, pub: result.message.pub!, sig: result.message.sig! }); }
    catch (error) { log('Locally saved chat will be available through backfill: ' + String(error)); }
  }
  return { ok: true, id: messageId, state: 'saved-locally' };
  })();
  sends.set(messageId, { text, replyTo: replyToId, promise });
  void promise.finally(() => { if (sends?.get(messageId)?.promise === promise) sends.delete(messageId); }).catch(() => {});
  return promise;
}

/** Edit one of OUR OWN chat messages: sign the new text over editCanonical, apply
 *  the overlay locally, and gossip a 'chat-edit'. Refuses to edit others' messages
 *  (the network enforces this too via the authorship check on receive). */
async function editChat(roomId: string, msgId: string, rawText: string): Promise<void> {
  const room = rooms.get(roomId);
  if (!room || room.kicked || netSuspended) throw new Error('Room not active');
  const text = String(rawText || '').trim();
  if (!text || text.length > 2000) throw new Error('Invalid chat edit');
  const target = room.chat.find((c) => c.id === msgId);
  if (!target) throw new Error('Message not found in this room');
  if (target.memberId !== room.self.memberId) throw new Error('You can only edit your own messages');
  // Strictly newer than the message and any prior edit, so LWW always accepts ours.
  const at = Math.max(Date.now(), (room.chatEdits.get(msgId)?.at ?? target.at) + 1);
  const existing = room.chatEdits.get(msgId);
  const sig = signBytes(room, editCanonical(room.topic, { msgId, memberId: room.self.memberId, at, text }));
  if (!sig) throw new Error('Could not sign this chat edit');
  const proposed = existing?.text === text ? existing : { text, at, by: room.self.memberId, pub: room.self.pub, sig };
  const edit = await ipcRenderer.invoke('room-persist-chat-edit', { roomId, msgId, edit: proposed });
  if (rooms.get(roomId) !== room || room.kicked || netSuspended) throw new Error('Room session ended while saving the edit');
  if (applyChatEdit(room, msgId, edit)) {
    try { broadcast(room, { t: 'chat-edit', msgId, memberId: room.self.memberId, text: edit.text, at: edit.at, pub: edit.pub, sig: edit.sig }); }
    catch (error) { log('Locally saved chat edit could not be broadcast: ' + String(error)); }
    pushState(room, true);
  }
}

/** Delete one file: sign a tombstone, apply it locally, and gossip it. Records the
 *  authenticated proof only when WE may delete it for everyone (owner or author);
 *  otherwise it degrades to a local hide (peers drop the unauthorized del). */
function broadcastDelete(r: Room, fileId: string, at: number): void {
  if (!r.tombstones.has(fileId) && r.tombstones.size >= ROOM_FILE_LIMIT) throw new Error("Room file deletion limit reached");
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

/** Owner-only: set (or clear, with '') the room topic — signed, LWW by `at`. */
const MAX_TOPIC = 300;
function setRoomTopic(roomId: string, rawText: string): RoomState {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  if (room.ownerId !== room.self.memberId) throw new Error('Only the room owner can set the topic');
  const text = String(rawText || '').slice(0, MAX_TOPIC).trim();
  const at = Math.max(Date.now(), room.topicAt + 1); // strictly newer, never in the past
  const by = room.self.memberId;
  const sig = signBytes(room, topicCanonical(room.topic, { text, at, by }));
  room.topicText = text;
  room.topicAt = at;
  room.topicMsg = { text, at, by, pub: room.self.pub, sig };
  try { ipcRenderer.send('room-topic', { roomId: room.roomId, text, at, by, pub: room.self.pub, sig }); } catch { /* ignore */ }
  broadcast(room, { t: 'topic', text, at, by, pub: room.self.pub, sig });
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
    broadcast(room, { t: 'ping', memberId: room.self.memberId, name: room.self.name || 'You', avatarSeed: room.self.avatarSeed, have: buildState(room).members[0].have, roomName: room.name, ownerId: room.ownerId, protocolVersion: ROOM_PROTOCOL_VERSION, capabilities: [...DESKTOP_ROOM_CAPABILITIES], watchSync: 2 });
    const pm = selfProfileMsg(room);
    if (pm) broadcast(room, pm);
    pushState(room, true);
  }
}

const pendingJoinEpochs = new Map<string, number>();
const pendingScreenEpochs = new Map<string, number>();
function cancelScreenCapture(roomId: string): void { pendingScreenEpochs.set(roomId, (pendingScreenEpochs.get(roomId) ?? 0) + 1); }
let joinNetworkEpoch = 0;

// ── IPC command router ───────────────────────────────────────────────────────
ipcRenderer.on('room-cmd', async (_e, msg: any) => {
  const { type, reqId } = msg;
  try {
    let data: any;
    if (type === 'join') {
      const id = msg.payload.roomId;
      const epoch = pendingJoinEpochs.get(id) ?? 0;
      const networkEpoch = joinNetworkEpoch;
      await loadNetworkingModules();
      await closingRooms.get(id);
      if ((pendingJoinEpochs.get(id) ?? 0) !== epoch || networkEpoch !== joinNetworkEpoch) throw new Error('Room join was cancelled');
      data = startRoom(msg.payload);
    }
    else if (type === 'addFiles') data = await addFiles(msg.roomId, msg.paths, msg.opts);
    else if (type === 'createFolder') data = createFolder(msg.roomId, msg.name, msg.icon, msg.color, msg.parentId ? String(msg.parentId) : undefined);
    else if (type === 'updateFolder') data = updateFolder(msg.roomId, msg.folderId, msg.patch || {});
    else if (type === 'rename') data = renameRoom(msg.roomId, msg.name);
    else if (type === 'setTopic') data = setRoomTopic(msg.roomId, msg.text);
    else if (type === 'deleteFolder') data = deleteFolder(msg.roomId, msg.folderId);
    else if (type === 'assignFile') data = assignFile(msg.roomId, msg.fileId, msg.folderId ?? null);
    else if (type === 'leave') { pendingJoinEpochs.set(msg.roomId, (pendingJoinEpochs.get(msg.roomId) ?? 0) + 1); cancelScreenCapture(msg.roomId); await leaveRoom(msg.roomId); data = { ok: true }; }
    else if (type === 'pinOwner') { const r = rooms.get(msg.roomId); if (!r) throw new Error('Room not active'); pinRoomOwner(r, String(msg.ownerPin || '')); data = { ok: true }; }
    else if (type === 'netSuspend') { joinNetworkEpoch++; netSuspended = true; suspendAllNetworking(); data = { ok: true }; }
    else if (type === 'netResume') { netSuspended = false; data = { ok: true }; }
    else if (type === 'profile') { updateProfile(msg.payload || {}); data = { ok: true }; }
    else if (type === 'historyTrim') {
      const room = rooms.get(msg.roomId); if (!room) throw new Error('Room not active');
      const days = historyDays(msg.days);
      room.chat = retainLocalHistory(room.chat, days, m => m.receivedAt ?? m.at);
      room.history = retainLocalHistory(room.history, days, ev => ev.at);
      const ids = new Set(room.chat.map(m=>m.id));
      for (const id of room.chatEdits.keys()) if (!ids.has(id)) room.chatEdits.delete(id);
      for (const id of room.chatReacts.keys()) if (!ids.has(id)) room.chatReacts.delete(id);
      pushState(room,true); data = { ok: true };
    }
    else if (type === 'diskUsage') { data = await diskUsage(msg.roomId); }
    else if (type === 'cleanupCopies') { data = await cleanupCopies(msg.roomId, msg.previewId, msg.fileIds); }
    else if (type === 'releaseFile') { await releaseFile(msg.roomId, msg.fileId); data = { ok: true }; }
    else if (type === 'reseedFile') { reseedFile(msg.roomId, msg.fileId); data = { ok: true }; }
    else if (type === 'verifiedFile') data = verifiedLocalFile(msg.roomId, msg.fileId);
    else if (type === 'watchStream') data = await watchStream(msg.roomId, String(msg.fileId || ''));
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
    else if (type === 'transferOwner') data = transferOwnership(msg.roomId, String(msg.memberId || ''));
    else if (type === 'mute') {
      // Locally hide a member on THIS install (never broadcast, fully reversible).
      // Future shares from them are ignored (see mergeFile); already-downloaded
      // files are left alone, and unmute lets their shares back in via gossip.
      const r = rooms.get(msg.roomId);
      if (!r) throw new Error('Room not active');
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
      data = buildState(r);
    }
    else if (type === 'watchPolicy') {
      const r = rooms.get(msg.roomId);
      if (!r || !r.ownerId || r.ownerId !== r.self.memberId) throw new Error('Only the room owner can choose the watch host');
      const hostId = msg.hostId;
      if (typeof hostId !== 'string' || hostId.length > 1024 || hostId && (r.bans.has(hostId) || !buildState(r).members.some(m => m.memberId === hostId && m.online && m.capabilities?.includes('watch-host-v1')))) throw new Error('Watch host is unavailable or needs an update');
      const state = watchState(r);
      const p: WatchPolicy = { t: 'watch-policy-v1', by: r.ownerId, ownerAt: r.transferAt, hostId, at: Math.max(Date.now(), (state.host.current(r.ownerId, r.transferAt)?.at || 0) + 1), pub: r.self.pub, sig: '' };
      p.sig = signBytes(r, Buffer.from(watchPolicyCanonical(r.topic, p)));
      if (!p.sig || !state.host.accept(p, r.ownerId, Date.now(), r.transferAt)) throw new Error('Watch policy signing failed');
      state.policyTopic = r.topic;
      broadcast(r, p); pushState(r, true); data = buildState(r);
    }
    else if (type === 'sync') {
      const r = rooms.get(msg.roomId);
      const p = msg.payload || {};
      if (!r) throw new Error('Room is not connected');
      if (!r.files.has(p.fileId)) throw new Error('Unknown watch file');
      const state = watchState(r);
      const body = state.sender.next({ ...p, ...state.host.stamp(r.ownerId, r.transferAt) }, r.self.memberId, () => crypto.randomBytes(16).toString('hex'), Date.now(), 3);
      if (!body) throw new Error('Invalid watch command');
      const sig = signBytes(r, Buffer.from(watchCanonical(r.topic, body)));
      if (!sig) throw new Error('Watch signing failed');
      const hostSig = signBytes(r, Buffer.from(watchHostCanonical(r.topic, body)));
      const frame: WatchMessage = { ...body, pub: r.self.pub, sig, hostSig };
      if (!hostSig || !state.host.allows(frame, r.ownerId, r.transferAt)) throw new Error('Only the watch host controls shared playback');
      broadcast(r, frame);
      data = { ok: true };
    }
    else if (type === 'srvMirror') {
      const r = rooms.get(msg.roomId);
      if (r) {
        const at = Number(msg.at) || Date.now();
        const body = String(msg.body || '').slice(0, 200_000);
        const sig = signBytes(r, srvMirrorCanonical(r.topic, { hostId: r.self.memberId, at, body }));
        broadcast(r, { t: 'srv-mirror', hostId: r.self.memberId, at, body, pub: r.self.pub, sig });
        // We do NOT store our own mirror: buildState omits it anyway (a member's
        // own instances come from the local ServerManager, not from gossip), and
        // keeping it only risked our copy being mistaken for a peer's.
        //
        // Throttled, not immediate. This fires on every probe tick of every
        // running instance, and forcing a full RoomState snapshot through at
        // that cadence re-rendered the whole room list every 15 seconds for a
        // payload the renderer already had.
        pushState(r);
      }
      data = { ok: true };
    }
    else if (type === 'srvCmd') {
      const r = rooms.get(msg.roomId);
      const request: ServerCommandRequest = msg.request;
      if (!r || netSuspended || r.kicked || request?.by !== r.self.memberId || !r.members.has(request.hostId) || !validCommandRequest(request)) data = { ok: false, reason: 'room-unavailable' };
      else {
        const at = Math.max(Date.now(), (r.srvCmdAt.get(r.self.memberId) ?? 0) + 1);
        const outgoing = { ...request, at };
        if (!validCommandRequest(outgoing)) data = { ok: false, reason: 'command-expired' };
        else {
          r.srvCmdAt.set(r.self.memberId, at);
          const result = r.pendingServerCommands.wait(outgoing);
          broadcast(r, { t: 'srv-cmd-v2', ...outgoing, pub: r.self.pub, sig: signBytes(r, Buffer.from(commandCanonical(r.topic, outgoing))) });
          data = await result;
        }
      }
    }
    else if (type === 'chat') { data = await sendChat(msg.roomId, String((msg.payload || {}).text || ''), (msg.payload || {}).replyTo ? String((msg.payload || {}).replyTo) : undefined, msg.payload?.id); }
    else if (type === 'editChat') { await editChat(msg.roomId, String((msg.payload || {}).msgId || ''), String((msg.payload || {}).text || '')); data = { ok: true }; }
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
    else if (type === 'reactChat') {
      const r = rooms.get(msg.roomId);
      if (!r) throw new Error('Room not active');
      const msgId = String(msg.msgId || '');
      const emoji = String(msg.emoji || '').slice(0, 16);
      if (!CHAT_REACTION_SET.has(emoji)) throw new Error('Unsupported reaction');
      if (!r.chat.some((c) => c.id === msgId)) throw new Error('Message not found in this room');
      // Toggle from OUR current view; gossip the explicit on/off so peers
      // converge without needing to know our previous state.
      const on = !r.chatReacts.get(msgId)?.get(emoji)?.has(r.self.memberId);
      if (applyChatReact(r, msgId, emoji, r.self.memberId, on)) {
        persistChatReacts(r);
        broadcast(r, { t: 'react-chat', memberId: r.self.memberId, msgId, emoji, on });
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
        if (otherId !== msg.roomId) { cancelScreenCapture(otherId); other.voice.leave(); }
      }
      const warning = await r.voice.join(); // getUserMedia — rejects (→ toast) if the mic is denied
      // The kill-switch may have tripped DURING getUserMedia (suspend can't tear
      // down a session that wasn't active yet) — re-check and undo, or the mic +
      // real-IP ICE would stay live for the whole outage.
      if (netSuspended) { r.voice.leave(); throw new Error('Rooms are paused: the VPN is down (kill-switch)'); }
      if (rooms.get(msg.roomId) !== r) { r.voice.leave(); throw new Error('The room session ended.'); }
      // Solicit peers so a (re)joiner learns who is already in voice AND who is
      // sharing a screen (presence/share are only gossiped on change — a hello makes
      // everyone reannounce both). Fixes a missing LIVE badge after leave+rejoin.
      broadcast(r, helloMsg(r));
      ipcRenderer.send('room-voice-devices');
      data = { ok: true, ...(warning ? { warning } : {}) };
    }
    else if (type === 'voiceReconnect') {
      const r = rooms.get(msg.roomId);
      if (netSuspended) throw new Error('Rooms are paused: the VPN is down (kill-switch)');
      if (!r || r.kicked || !r.voice.isActive()) throw new Error('Voice not active');
      r.voice.reconnect(); broadcast(r, helloMsg(r)); data = { ok: true };
    }
    else if (type === 'voiceLeave') { cancelScreenCapture(msg.roomId); rooms.get(msg.roomId)?.voice.leave(); data = { ok: true }; }
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
      ipcRenderer.send('room-voice-devices');
      data = { ok: true };
    }
    else if (type === 'voiceMicTestStop') { micTester.stop(); data = { ok: true }; }
    else if (type === 'screenShareStart') {
      const r = rooms.get(msg.roomId);
      if (!r) throw new Error('Room not active');
      if (netSuspended) throw new Error('Rooms are paused: the VPN is down (kill-switch)');
      if (!r.voice.isActive()) throw new Error('Join the voice channel before sharing your screen.');
      cancelScreenCapture(msg.roomId);
      const epoch = pendingScreenEpochs.get(msg.roomId), networkEpoch = joinNetworkEpoch;
      const stream = await captureScreen(String(msg.sourceId || ''), !!msg.withAudio);
      if (epoch !== pendingScreenEpochs.get(msg.roomId) || networkEpoch !== joinNetworkEpoch) {
        stream.getTracks().forEach((t) => t.stop()); throw new Error('Screen sharing was cancelled');
      }
      // The kill-switch (or a leave/kick) may have tripped DURING capture — same
      // re-check-and-undo pattern as voiceJoin, or the capture would leak.
      if (netSuspended) { stream.getTracks().forEach((t) => t.stop()); throw new Error('Rooms are paused: the VPN is down (kill-switch)'); }
      if (rooms.get(msg.roomId) !== r || !r.voice.isActive()) { stream.getTracks().forEach((t) => t.stop()); throw new Error('The voice session ended.'); }
      r.voice.startShare(stream);
      data = { ok: true };
    }
    else if (type === 'screenShareStop') { cancelScreenCapture(msg.roomId); rooms.get(msg.roomId)?.voice.stopShare(); data = { ok: true }; }
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
    // ── Virtual-LAN: the three core engine-facing commands. lanStart builds the
    // session + dials the helper pipe (payload from the main-process LanManager);
    // lanStop tears it down; lanSignal funnels invite/accept/evict via a kind
    // discriminator (mirrors screenSignal) — the host mints, the joiner accepts.
    else if (type === 'lanStart') {
      data = await lanStart(msg.roomId, {
        sessionId: String(msg.sessionId || ''),
        pipeName: String(msg.pipeName || ''),
        token: String(msg.token || ''),
        subnet: msg.subnet ? String(msg.subnet) : undefined,
        admit: Array.isArray(msg.admit) ? msg.admit.map(String) : [],
        isHost: msg.isHost === true,
        // Phase 2B relay willingness rides the start payload (main reads the
        // persisted setting) — omitted by an older caller ⇒ keep the current value.
        relayEnabled: typeof msg.relayEnabled === 'boolean' ? msg.relayEnabled : undefined,
        // Persisted anti-replay watermark for this sessionId (0 / absent for a
        // session this install has never run).
        floor: typeof msg.floor === 'number' ? msg.floor : 0,
      });
    }
    else if (type === 'lanStop') { const r = rooms.get(msg.roomId); if (r) teardownLan(r); data = { ok: true }; }
    else if (type === 'lanSignal') {
      rooms.get(msg.roomId)?.lan?.control(String(msg.kind || ''), msg.memberId ? String(msg.memberId) : undefined);
      data = { ok: true };
    }
    // Phase 2B: the relay-willingness toggle. GLOBAL, not per-room — the cost is
    // this install's uplink — so it updates the module store and every live
    // session, and is re-asserted on a respawned engine window (readied()). The
    // session reads `relayEnabled` LIVE on the forward path, so switching it off
    // stops forwarding on the very next packet, not at the next advert.
    else if (type === 'lanSettings') {
      lanRelayEnabled = msg.relayEnabled !== false;
      for (const r of rooms.values()) r.lan?.setRelayEnabled(lanRelayEnabled);
      data = { ok: true };
    }
    // Phase 2A: the connectivity report (facts only — main evaluates) and the
    // scoped per-game firewall rule (already-elevated helper, so no new UAC).
    else if (type === 'lanDiagnose') { data = await lanDiagnose(String(msg.roomId || '')); }
    else if (type === 'lanAllowApp') { data = await lanAllowApp(String(msg.roomId || ''), String(msg.exePath || '')); }
    else if (type === 'retryConnection') {
      const r = rooms.get(msg.roomId);
      if (!r || r.kicked || netSuspended) throw new Error('Room connection is not available');
      observeConnection(r, 'discovery-retry');
      restartTracker(r, true);
      for (const wire of r.wires.values()) if (wire.memberId && !r.bans.has(wire.memberId)) {
        sendTo(r, wire, { ...helloMsg(r, false), manifestRequest: true } as Msg);
      }
      pushState(r, true); data = buildState(r);
    }
    else if (type === 'snapshot') { const r = rooms.get(msg.roomId); data = r ? buildState(r) : null; }
    else if (type === 'setAutoFetch') {
      const r = rooms.get(msg.roomId);
      if (!r) throw new Error('Room not active');
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
      data = buildState(r);
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
      await storageFor(r).stopping.get(f.fileId);
      if (rooms.get(r.roomId) !== r || r.files.get(f.fileId) !== f) throw new Error('Room file session ended');
      setTransfer(r, f.fileId, { receivePaused: false }); persistManifest(r, f);
      ensureLocal(r, f);
      pushState(r, true);
      data = buildState(r);
    }
    else if (type === 'pauseReceive') {
      const r = rooms.get(msg.roomId), f = r?.files.get(String(msg.fileId || ''));
      if (!r || !f) throw new Error('File not found in an active room');
      const state = storageFor(r);
      let stop = state.stopping.get(f.fileId);
      if (!stop) {
        const tr = r.transfers.get(f.fileId);
        if (tr?.haveLocally || tr?.cipherReady || tr?.phase === 'verifying' || tr?.phase === 'decrypting') throw new Error('This file is no longer receiving network data');
        const lease = state.receives.get(f.fileId);
        closeStreamServers(r.roomId, f.fileId);
        cancelFileOperation(r, f.fileId, true);
        setTransfer(r, f.fileId, { receivePaused: true, phase: 'paused', status: 'queued', error: undefined, downSpeed: 0, peers: 0 });
        persistManifest(r, f);
        const c = clients.get(r.roomId), torrent = c && findTorrent(c, f.infoHash);
        stop = (torrent ? new Promise<void>((resolve, reject) => {
          try { void Promise.resolve(c.remove(torrent, (error?: Error) => error ? reject(error) : resolve())).catch(reject); }
          catch (error) { reject(error); }
        }) : Promise.resolve()).finally(() => lease?.release());
        state.stopping.set(f.fileId, stop);
      }
      try { await stop; }
      catch (error) {
        if (rooms.get(r.roomId) === r && r.files.get(f.fileId) === f) fileFailure(r, f, 'transfer', error, { receivePaused: true });
        throw error;
      }
      finally { if (state.stopping.get(f.fileId) === stop) state.stopping.delete(f.fileId); }
      if (rooms.get(r.roomId) !== r) throw new Error('Room session ended');
      pushState(r, true); data = buildState(r);
    }
    else if (type === 'prioritizeReceive') {
      const r = rooms.get(msg.roomId);
      if (!r || !r.files.has(String(msg.fileId || ''))) throw new Error('File not found in an active room');
      receiveQueue.prioritize(r, String(msg.fileId)); data = buildState(r);
    }
    else if (type === 'retryDecrypt') {
      retryDecrypt(msg.roomId, String(msg.fileId || ''));
      data = { ok: true }; // accepted; completion is published in room-update
    }
    else if (type === 'resourceSettings') {
      applyResourcePolicy(msg.policy); data = { ok: true };
    }
    else if (type === 'setLimits') {
      const r = rooms.get(msg.roomId);
      if (!r) throw new Error('Room not active');
      {
        const up = normalizeRoomRate(msg.upKbps), down = normalizeRoomRate(msg.downKbps);
        trafficBudget.setLimits(r.roomId, up, down);
        r.upKbps = up; r.downKbps = down;
        pushResourceStates();
      }
      data = buildState(r);
    }
    else throw new Error('Unknown room command: ' + type);
    ipcRenderer.send('room-res', { reqId, ok: true, data });
  } catch (e: any) {
    ipcRenderer.send('room-res', { reqId, ok: false, error: e?.message || String(e) });
  }
});

ipcRenderer.send('room-ready');
