// Shared types for Havvn application

// On-completion action (one-shot "when downloads finish → sleep/shutdown/quit").
// Logic lives in shared/completion-action.ts; re-exported here so IPC surfaces
// (preload, renderer) keep importing every wire type from one hub.
import type { CompletionAction, CompletionPending, CompletionActionState } from './completion-action';
export type { CompletionAction, CompletionPending, CompletionActionState } from './completion-action';
import type { Theme } from './theme';
export type { Theme, ThemeBase, ValidateResult } from './theme';

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'seeding'
  | 'error'
  | 'removed';

export type SourceType = 'magnet' | 'torrent_file' | 'catalog';

export interface Download {
  id: string;
  name: string;
  sourceType: SourceType;
  sourceUri: string;
  torrentFilePath: string | null;
  // Lowercase hex infoHash, persisted on first add. The native engine keys
  // everything on it (transmission's integer ids don't survive restarts).
  infoHash?: string;
  savePath: string;
  status: DownloadStatus;
  progress: number;
  downloadedBytes: number;
  uploadedBytes: number;
  downSpeedBps: number;
  upSpeedBps: number;
  etaSeconds: number | null;
  peers: number;
  seeds: number;
  totalSize: number;
  priority: number; // 0 = low, 1 = normal, 2 = high
  category: string | null;
  selectedFiles?: number[];
  // Source files to seed directly from disk (set for torrents created with
  // "start seeding"). When present the engine seeds these paths instead of
  // trying to download by name — so a custom torrent name can't break it.
  seedPaths?: string[];
  // Priority 1 new fields
  sequentialDownload?: boolean;
  seedRatioLimit?: number;           // Stop seeding at this ratio (0 = unlimited)
  seedTimeLimitMinutes?: number;     // Stop seeding after N minutes (0 = unlimited)
  seedingStartedAt?: number;         // Unix timestamp when seeding began
  maxDownloadSpeed?: number;         // Per-torrent KB/s (0 = unlimited)
  maxUploadSpeed?: number;           // Per-torrent KB/s (0 = unlimited)
  filePriorities?: FilePriority[];   // Per-file priorities, indexed by file index
  customTrackers?: string[];         // User-added trackers, merged into the announce list on (re)start
  removedTrackers?: string[];        // User-removed trackers, pruned from the live tracker client after start
  createdAt: Date;
  updatedAt: Date;
  lastError: string | null;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
}

export interface TorrentFile {
  name: string;
  path: string;
  length: number;
  downloaded: number;
  progress: number;
  index?: number;
  priority?: FilePriority;
}

/** An active "share link" — a download re-seeded for browser download over WebRTC. */
export interface ShareInfo {
  downloadId: string;
  name: string;
  infoHash: string;
  magnetURI: string;
  link: string;
  createdAt: number;
}

// ── Friend swarms / private rooms (Phase 3) ────────────────────────────────
// A "room" is a serverless private group: members share an invite code, derive
// a shared key from it, find each other via a tracker rendezvous id derived
// from that key, gossip an add-only file manifest over encrypted WebRTC data
// channels, and
// auto-distribute the files P2P (same WebTorrent swarm infra as share links).

/** One file in a room's shared, add-only manifest. Keyed by infoHash. */
export interface RoomFile {
  fileId: string;        // == infoHash (lowercase hex); the dedupe key
  name: string;
  size: number;
  infoHash: string;
  magnetURI: string;
  addedBy: string;       // memberId of the member who first shared it
  addedByName: string;
  addedAt: number;
  enc?: boolean;         // E2E rooms: the seeded torrent is ciphertext (decrypt after download)
  // Folder/section this file sits in. Absent, '', or an id that resolves to no
  // live folder all mean "Uncategorized" — so a peer on an older build that
  // strips the field just shows the file in the flat list, never breaks.
  folderId?: string;
  folderAt?: number;     // last-writer-wins clock for the folder assignment (independent of addedAt)
  // Revive authorization: present only when this add lifts an AUTHENTICATED
  // tombstone (a file the owner/author had deleted). Signed by the owner or the
  // original deleter; a peer that still holds the tombstone accepts the
  // resurrection only if this verifies — so a member can't un-delete someone's
  // file by re-adding it. `revAt` is the deletion timestamp this revive undoes,
  // so the revive is self-describing (ordering doesn't depend on a receiver's
  // clock or which deletion it happens to hold): a revive supersedes any tombstone
  // whose `at` is <= revAt, and is stale against a newer one.
  revBy?: string;        // memberId that authorized the revive (owner or original deleter)
  revPub?: string;       // revBy's Ed25519 public key (PEM)
  revAt?: number;        // the tombstone `at` this revive lifts
  revSig?: string;       // signature over reviveCanonical(topic, {fileId, revAt, revBy})
}

/**
 * A named folder/section for organizing a room's shared files. Optional overlay
 * on the flat manifest: a room with no folders renders exactly as before. `at`
 * is the last-edit clock (ms) used for last-writer-wins convergence across peers.
 */
export interface RoomFolder {
  id: string;
  name: string;
  icon: string;
  color: string;
  at: number;
}

/** A room folder as persisted to disk (same shape; re-served on restart). */
export type PersistedRoomFolder = RoomFolder;

/**
 * A manifest entry persisted to disk so a room shows — and re-seeds — its files
 * immediately on restart, before any peer reconnects. Carries the on-disk path
 * so a file shared from its ORIGINAL location (outside the room folder) can be
 * re-seeded without the original sharer having to re-add it.
 */
export interface PersistedRoomFile extends RoomFile {
  localPath?: string;   // plaintext on disk (original for shared, room folder for downloaded)
  cipherPath?: string;  // E2E rooms only: the ciphertext we actually seed
}

/** A member of a room (including yourself). */
export interface RoomMember {
  memberId: string;      // stable per-install identity
  name: string;
  avatarSeed: string;    // deterministic seed for the identicon (defaults to memberId)
  online: boolean;
  isSelf: boolean;
  lastSeen: number;
  have: string[];        // fileIds this member reports holding complete
  role: 'owner' | 'member';  // owner = room creator; can kick + rekey
  muted?: boolean;       // locally hidden/ignored on THIS install (not broadcast)
  relayed?: boolean;     // online but reached only via another member (no direct wire)
}

/** A chat message in a room (gossiped between members; capped + persisted locally). */
export interface RoomChatMessage {
  id: string;            // stable id (dedupes re-delivery across wires)
  at: number;            // sender's clock (ms)
  memberId: string;      // who sent it
  name: string;          // sender display name at send time
  avatarSeed: string;    // sender avatar at send time
  text: string;          // message body (already trimmed + length-capped)
  // The sender's Ed25519 signature over the message, kept so a message re-served
  // as backfill to a peer that was offline still self-authenticates (verifyChat).
  pub?: string;
  sig?: string;
}

/** An entry in a room's activity log (locally observed; capped + persisted). */
export interface RoomEvent {
  id: string;
  at: number;
  type: 'created' | 'joined' | 'left' | 'file-added' | 'file-removed' | 'kicked' | 'rekeyed';
  actorId: string;       // who did it (memberId), '' if unknown
  actorName: string;
  fileName?: string;     // for file-added / file-removed
  targetName?: string;   // for kicked (the removed member's name)
}

/** Local transfer status of one room file on this machine. */
export interface RoomTransfer {
  fileId: string;
  progress: number;      // 0..1
  status: 'seeding' | 'downloading' | 'queued' | 'done' | 'error';
  downSpeed: number;     // bytes/s
  peers: number;
  haveLocally: boolean;
  released?: boolean;    // user stopped seeding this file to unlock it on disk
  localPath?: string;    // real on-disk path (original for shared, room folder for downloaded)
  cipherPath?: string;   // E2E rooms only: the ciphertext we seed for this file
}

/** Full live state of one room, pushed to the renderer. */
export interface RoomState {
  roomId: string;        // local uuid
  name: string;
  code: string;          // the secret invite code (speakable; unpinned = trust-on-first-use owner)
  invite: string;        // shareable invite that also PINS the owner ("<code>~<ownerId>") when known — prefer this for sharing
  folder: string;        // local shared folder path
  topicHash: string;     // internal signature domain separator, sha1(code) — NOT the tracker rendezvous (that is key-derived and never sent here)
  createdAt: number;
  ownerId: string;       // memberId of the room owner ('' until learned)
  canManage: boolean;    // this install is the owner (may kick/rekey)
  e2e: boolean;          // end-to-end encryption: file bytes seeded as ciphertext
  members: RoomMember[];
  files: RoomFile[];
  folders?: RoomFolder[];   // room sections (absent/empty = flat list, legacy behaviour)
  transfers: Record<string, RoomTransfer>;
  history: RoomEvent[];  // recent activity, newest last
  chat: RoomChatMessage[];  // recent chat messages, newest last
  connected: boolean;    // tracker rendezvous connected
  peerCount: number;     // live gossip peers right now
  autoFetch: boolean;    // auto-download files peers share; false = fetch manually per file
  upKbps: number;        // per-room upload ceiling, KB/s (0 = unlimited)
  downKbps: number;      // per-room download ceiling, KB/s (0 = unlimited)
  kicked?: boolean;      // the owner removed us from this room (session-only)
  kickedBy?: string;     // display name of who removed us
  typingMemberIds?: string[]; // members composing a chat message right now (self excluded, ~4s TTL)
  fileReacts?: Record<string, Record<string, string[]>>; // fileId → emoji → reacting memberIds
  memberProg?: Record<string, Record<string, number>>;   // memberId → fileId → coarse download % (0-100; a member's 'have' implies 100)
  voice: RoomVoiceState; // serverless mesh voice channel state (who's in the call, who's talking)
}

/** A participant currently in a room's voice channel. */
export interface RoomVoiceParticipant {
  memberId: string;
  muted: boolean;
  speaking: boolean;
}

/** The room's voice channel as this install sees it. `inVoice`/`muted` are OUR own
 *  state; `participants` includes self (when in voice) plus every peer we've heard
 *  announce voice presence. Session-only — never persisted. */
/** Mic transmit mode: always open, gated by voice activity (auto-mute on silence),
 *  or push-to-talk. */
export type VoiceInputMode = 'always' | 'vad' | 'ptt';

export interface RoomVoiceState {
  inVoice: boolean;
  muted: boolean;
  deafened: boolean;
  transmitting: boolean;  // mic is live right now (for the mic-live indicator)
  inputMode: VoiceInputMode;
  participants: RoomVoiceParticipant[];
}

/** Lightweight room listing entry. */
export interface RoomSummary {
  roomId: string;
  name: string;
  code: string;
  folder: string;
  memberCount: number;
  onlineCount: number;
  fileCount: number;
  createdAt: number;
  /** End-to-end encrypted room — sharing makes an encrypted on-disk copy. */
  e2e?: boolean;
  /** Networking torn down by the VPN kill-switch (VPN dropped) — nothing is
   *  seeding or announcing until the VPN returns. */
  suspended?: boolean;
  /** Unread chat messages from others since the room was last viewed. */
  unread?: number;
}

/** This install's identity in rooms. */
export interface RoomProfile {
  memberId: string;
  name: string;
  avatarSeed: string;
}

export type FilePriority = 'skip' | 'low' | 'normal' | 'high';

export interface TrackerInfo {
  url: string;
  // connected = announced OK and re-announce scheduled; updating = added but no
  // successful announce yet; error = the tracker connection was torn down.
  status: 'connected' | 'updating' | 'disconnected' | 'error';
  peers: number;
  lastAnnounce?: number; // epoch ms of the last announce (formatted/localized in the UI)
}

/** A single connected peer, surfaced in the per-torrent Peers tab. */
export interface PeerInfo {
  address: string;                 // ip:port
  client?: string;                 // decoded client name + version
  connType: 'tcp-in' | 'tcp-out' | 'utp-in' | 'utp-out' | 'webrtc' | 'web-seed' | 'other';
  downSpeed: number;               // bytes/sec from this peer
  upSpeed: number;                 // bytes/sec to this peer
  downloaded: number;              // bytes received from this peer (session)
  uploaded: number;                // bytes sent to this peer (session)
  progress: number;                // 0..1 — how much of the torrent the peer has
  flags: {
    interested: boolean;           // we are interested in the peer
    choking: boolean;              // we are choking the peer
    peerInterested: boolean;       // the peer is interested in us
    peerChoking: boolean;          // the peer is choking us
  };
}

export interface DownloadStats {
  id: string;
  progress: number;
  downloadedBytes: number;
  uploadedBytes: number;
  downSpeedBps: number;
  upSpeedBps: number;
  etaSeconds: number | null;
  peers: number;
  seeds: number;
  status: DownloadStatus;
}

/** A DNS-over-HTTPS resolver the engine can route tracker/peer lookups through.
 *  `url` is a DoH JSON endpoint (RFC 8484 JSON, i.e. accepts `?name=&type=` and
 *  returns `{ Answer: [...] }`). Built-in presets use literal-IP endpoints so they
 *  work even when the system resolver itself is down. */
export interface DohTemplate {
  id: string;
  name: string;
  url: string;
  builtIn?: boolean;
}

/** Built-in DoH resolvers. IP-based endpoints so resolving them needs no DNS
 *  (avoids a bootstrap loop and survives a broken router resolver). */
export const BUILTIN_DOH_TEMPLATES: DohTemplate[] = [
  { id: 'cloudflare',          name: 'Cloudflare (1.1.1.1)',           url: 'https://1.1.1.1/dns-query', builtIn: true },
  { id: 'cloudflare-security', name: 'Cloudflare — block malware (1.1.1.2)', url: 'https://1.1.1.2/dns-query', builtIn: true },
  { id: 'google',              name: 'Google (8.8.8.8)',               url: 'https://8.8.8.8/resolve',   builtIn: true },
];

/** Resolve the active DoH endpoint URL from settings + custom templates. Pure so
 *  both the main process and the torrent host can compute it identically.
 *  Returns '' when DoH is off or the selected template no longer exists. */
export function resolveActiveDohUrl(
  s: { dohEnabled: boolean; dohTemplateId: string },
  custom: DohTemplate[],
): string {
  if (!s.dohEnabled) return '';
  const all = [...BUILTIN_DOH_TEMPLATES, ...(custom || [])];
  return all.find((t) => t.id === s.dohTemplateId)?.url || '';
}

/** A per-network settings overlay. Only the fields set here override the user's
 *  base settings while the matching network is active; everything else falls back
 *  to the base. All overrides apply live (no restart). */
export interface NetworkProfileOverrides {
  maxDownKbps?: number;            // 0 = unlimited
  maxUpKbps?: number;              // 0 = unlimited
  maxConnectionsGlobal?: number;
  adaptiveUpload?: boolean;
  dohEnabled?: boolean;
}

/** A named network profile. Matched to a network by `networkKey` (the default
 *  gateway's MAC — stable across reconnects, works wired + wireless). */
export interface NetworkProfile {
  id: string;
  name: string;
  networkKey: string;              // normalized gateway MAC; '' = not bound to a network yet
  networkLabel?: string;           // friendly last-seen name (SSID / connection name)
  overrides: NetworkProfileOverrides;
}

/** The network the machine is currently on. */
export interface NetworkInfo {
  key: string;                     // normalized gateway MAC ('' when undetectable)
  label: string;                   // SSID / connection name / interface
  gatewayIp?: string;
  ssid?: string;
  iface?: string;
}

export interface AppSettings {
  id: number;
  // Which download engine the torrent host runs. 'native' = the bundled
  // transmission-daemon sidecar (default); 'webtorrent' = the legacy in-process
  // engine, kept as a fallback until feature parity. Restart-only.
  // Dev override: HAVVN_ENGINE=native|webtorrent.
  engine?: 'native' | 'webtorrent';
  defaultDownloadDir: string;
  maxDownKbps: number;
  maxUpKbps: number;
  // Alternative ("turbo"/turtle) speed limits — a second set you flip to with
  // one click. When altSpeedEnabled, these replace the normal limits live.
  altSpeedEnabled: boolean;
  altDownKbps: number;             // 0 = unlimited
  altUpKbps: number;               // 0 = unlimited
  maxActiveDownloads: number;
  minimizeToTray: boolean;
  closeToTray: boolean;
  autoLaunch: boolean;
  autoUpdate: boolean;
  /** Update feed channel: 'beta' opts into GitHub prereleases; default 'stable'. */
  updateChannel?: 'stable' | 'beta';
  // Advanced network settings
  enableDHT: boolean;
  enablePEX: boolean;
  enableLSD: boolean;
  // µTP transport (experimental). Reaches µTP-only peers TCP misses. Default is
  // platform-based (off on Windows, on elsewhere) due to a historic native-module
  // crash on Windows; takes effect after a restart (set at engine creation).
  enableUtp: boolean;
  maxConnections: number;          // per-torrent connection ceiling
  // Global connection budget across ALL torrents. The effective per-torrent limit
  // is scaled down as more torrents run so the total never exceeds this — prevents
  // saturating the router's NAT table / exhausting OS sockets (which can drop the
  // whole machine's connectivity and crash the engine under load).
  maxConnectionsGlobal: number;
  portMin: number;
  portMax: number;
  portForwarding: boolean;         // Forward the listening port via UPnP (default true)
  // Adaptive upload throttle ("bufferbloat protection"). When on, the engine
  // watches WAN latency and auto-lowers the upload rate so seeding never chokes
  // the rest of the connection — no manual KB/s tuning needed. Opt-in because it
  // makes periodic lightweight latency probes to a public host (default false).
  adaptiveUpload: boolean;
  // DNS-over-HTTPS for the torrent engine. When on, tracker/peer hostnames are
  // resolved through an encrypted DoH resolver instead of the OS/router DNS —
  // bypasses a broken or censoring router resolver and hides which trackers you
  // contact from the ISP. Opt-in (default false). dohTemplateId selects the
  // active resolver from the built-in + custom template list.
  dohEnabled: boolean;
  dohTemplateId: string;
  dohCustomTemplates: DohTemplate[];
  // Smart network profiles: auto-apply a settings overlay (limits / adaptive /
  // DoH) based on which network you're on, keyed by the gateway MAC. Off by
  // default; the profile list lives in networkProfiles (a separate store key).
  networkProfilesEnabled: boolean;
  // Proxy settings
  proxyEnabled: boolean;
  proxyType: 'http' | 'https' | 'socks5';
  proxyHost: string;
  proxyPort: number;
  proxyUsername: string;
  proxyPassword: string;
  // Watch folder
  watchFolderEnabled: boolean;
  watchFolderPath: string;
  watchFolderDeleteAfterAdd: boolean;
  // Clipboard magnet watcher (main-process 2s poll; opt-in, default OFF).
  // Optional: absent on installs that predate 2.11 — treat as false.
  clipboardWatchEnabled?: boolean;
  // Move completed downloads to another folder, then keep seeding from there
  autoMoveEnabled: boolean;
  autoMovePath: string;
  // Mobile web remote (LAN control + streaming from a phone browser)
  webRemoteEnabled: boolean;
  webRemotePort: number;
  webRemoteToken: string;          // random; carried in the pairing URL/QR
  // Default seeding limits
  defaultSeedRatioLimit: number;     // 0 = unlimited
  defaultSeedTimeLimitMinutes: number; // 0 = unlimited
  // Notifications
  enableNotifications: boolean;
  enableSounds: boolean;
  notifyOnComplete: boolean;
  notifyOnError: boolean;
  // Disk-space guard
  diskGuardEnabled: boolean;       // Auto-pause all torrents when free space is low
  diskGuardMinFreeMB: number;      // Threshold in MB (default 2048)
  // Sharing
  shareUseTurn?: boolean;          // Use TURN relays for share links (default true).
                                   // Off = more private (no third-party relay) but
                                   // won't connect through symmetric NAT.
  // Optional user-supplied TURN relay (zero-cost ladder, last resort). Covers the
  // rare both-symmetric-NAT case that peer-relay can't, and relays file bytes too.
  // One side configuring it is enough: that member's relay address is publicly
  // reachable. Credential is encrypted at rest.
  customTurnUrl?: string;          // e.g. "turn:relay.example.com:3478" ('' = none)
  customTurnUsername?: string;
  customTurnCredential?: string;
  updatedAt: Date;
}

// Privacy Settings types
export interface PrivacyConfig {
  anonymousMode: boolean;
  encryptStorage: boolean;
  disableLogs: boolean;
  vpnCheck: boolean;
  clearDataOnExit: boolean;
  ephemeralPeerId: boolean;
  sanitizeLogs: boolean;
  vpnKillSwitch: boolean;   // Auto-pause all torrents if the VPN drops
  vpnBindEngine?: boolean;  // Bind the native engine's peer sockets to the VPN
                            // adapter (fail-closed; applied at engine start).
                            // Optional: absent on installs that predate 2.11.
}

/**
 * What the RUNNING native engine is bound to. Null status = feature off or the
 * webtorrent engine (which cannot bind). `fallback` means the engine started
 * with no VPN present and was bound to loopback — working, but peerless until
 * the VPN connects and the guard re-binds it.
 */
export interface VpnBindStatus {
  enabled: boolean;
  boundIp: string | null;  // null while in the loopback fallback
  iface: string | null;
  fallback: boolean;
}

/** privacy:getVpnBindStatus reply: live engine state + the persisted toggle. */
export interface VpnBindReport {
  running: VpnBindStatus | null; // null: webtorrent engine or mirror not yet fed
  configured: boolean;
}

/** app:vpnBindStatus push payload (guard → renderer). */
export interface VpnBindEvent {
  kind: 'lost' | 'rebound' | 'restored';
  boundIp?: string;
}

export interface VPNDetectionResult {
  isVPNActive: boolean;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  indicators: {
    vpnInterface: boolean;
    ipMismatch: boolean;
    vpnDNS: boolean;
    vpnRoutes: boolean;
  };
  details: {
    detectedInterfaces: string[];
    publicIP?: string;
    localIP?: string;
    vpnProvider?: string;
  };
}

/** UPnP port-forwarding status surfaced in Advanced settings. */
export type PortForwardState = 'disabled' | 'mapping' | 'mapped' | 'unsupported' | 'failed';
export interface PortForwardStatus {
  state: PortForwardState;
  port: number | null;
  method: 'upnp' | null;
  externalIp?: string;
  error?: string;
  updatedAt: number;
}

/** One-call privacy snapshot for the dashboard (VPN + geo/ISP of public IP). */
export interface IpInfo {
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
  org?: string;            // ISP / hosting org, e.g. "AS9009 M247 Europe SRL"
  vpnActive: boolean;
  vpnProvider?: string;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  interfaces: string[];
  exposedIsp: boolean;     // true ⇒ no VPN and IP looks like a consumer ISP (likely leak)
  fetchedAt: number;
}

// One country's aggregated presence in the live swarm map. Peers are grouped by
// country (resolved offline via a country-level IP DB) — never by exact address,
// so no peer IP leaves the machine and none is shown in the UI.
export interface SwarmGeoPoint {
  country: string;   // ISO 3166-1 alpha-2, uppercase
  count: number;     // connected peer-connections resolved to this country
  downBps: number;   // aggregate download speed from these peers
  upBps: number;     // aggregate upload speed to these peers
  seeds: number;     // of `count`, how many are complete (seeders)
}

/** Transport mix of the connections behind a SwarmGeo snapshot. */
export interface SwarmTransport {
  total: number;     // connections with a known transport
  utp: number;
  tcp: number;
  webrtc: number;    // webtorrent engine only
  encrypted: number; // protocol-encrypted connections (webrtc counts — DTLS)
}

// Live snapshot for the swarm world map (polled by the renderer).
export interface SwarmGeo {
  points: SwarmGeoPoint[];
  totalConns: number; // total peer-connections considered (incl. unresolved/IPv6)
  resolved: number;   // connections resolved to a country
  torrents: number;   // active torrents contributing peers
  transport?: SwarmTransport;
  dht?: boolean;      // whether peer discovery via DHT is enabled
}

// Live network-health snapshot for the adaptive-throttle indicator.
export interface NetworkHealth {
  adaptive: {
    active: boolean;          // throttle enabled AND its probe loop is running
    latencyMs: number | null; // last measured WAN round-trip
    baselineMs: number | null;// unloaded baseline it compares against
    capKbps: number;          // current adaptive upload ceiling, -1 = unlimited
    congested: boolean;       // last sample exceeded the congestion threshold
  };
  uploadBps: number;          // current aggregate upload throughput (bytes/sec)
}

// Scheduler types
export interface ScheduleEntry {
  id: string;
  days: number[];      // 0-6 (Sun-Sat)
  startTime: string;   // "HH:MM"
  endTime: string;     // "HH:MM"
  speedLimit?: number; // Optional speed limit in KB/s
}

export interface SchedulerConfig {
  enabled: boolean;
  schedules: ScheduleEntry[];
}

// Create Torrent types
export interface CreateTorrentOptions {
  name?: string;
  comment?: string;
  createdBy?: string;
  announceList: string[][];
  urlList?: string[];
  private?: boolean;
  pieceLength?: number; // in bytes, must be power of 2
  source?: string;
}

export interface CreateTorrentRequest {
  sourcePaths: string[]; // Files or folders to include
  outputPath: string; // Where to save .torrent file
  options: CreateTorrentOptions;
  startSeeding?: boolean; // Auto-start seeding after creation
  excludePaths?: string[]; // Absolute file paths to exclude from the torrent
}

// A node in the real (recursive) file tree returned by fs:getFileTree
export interface FsFileNode {
  path: string;        // absolute path
  name: string;
  size: number;
  isDirectory: boolean;
  children?: FsFileNode[];
}

export interface CreateTorrentResult {
  torrentFilePath: string;
  infoHash: string;
  magnetUri: string;
  totalSize: number;
  pieceCount: number;
  pieceLength: number;
}

export interface CreateTorrentProgress {
  stage: 'hashing' | 'writing' | 'complete';
  progress: number; // 0-1
  message: string;
}

// Collaborative Seeding Network types
export interface SeederInfo {
  peerId: string;          // Anonymous peer ID (hash)
  lastSeen: number;        // Timestamp
  uploadSpeed: number;     // Current upload speed in bytes/s
  reputation: number;      // Reputation score (0-100)
  seedingTime: number;     // How long seeding this torrent (seconds)
}

export interface SeedingPriority {
  infoHash: string;
  rarity: number;          // 0-100 (100 = very rare, few seeders)
  demand: number;          // 0-100 (how many people want to download)
  importance: number;      // 0-100 (importance for ecosystem)
  bounty: number;          // Points reward for seeding this torrent
}

export interface UserReputation {
  userId: string;          // Anonymous user ID
  points: number;          // Accumulated points
  uploadedTotal: number;   // Total uploaded bytes
  downloadedTotal: number; // Total downloaded bytes
  ratio: number;           // Upload/Download ratio
  rareTorrentsSeeded: number; // How many rare torrents seeded
  level: number;           // Level (1-10)
  badges: string[];        // ["FirstSeeder", "RareCollector", "SpeedDemon"]
  createdAt: Date;
  updatedAt: Date;
}

export interface SeedingRecommendation {
  downloadId: string;
  torrentName: string;
  allocatedBandwidth: number; // KB/s
  expectedBounty: number;
  reason: string;
  priority: SeedingPriority;
}

export interface SeedingPlan {
  torrents: SeedingRecommendation[];
  totalExpectedBounty: number;
}

export interface ReputationTransaction {
  id: string;
  type: 'earn' | 'spend' | 'bonus';
  amount: number;
  reason: string;
  timestamp: number;
  metadata?: {
    infoHash?: string;
    downloadId?: string;
    badge?: string;
  };
}

export interface Badge {
  id: string;
  name: string;
  description: string;
  icon: string;
  earnedAt: Date | null;
}

// IPC API types
export interface AddDownloadRequest {
  sourceType: SourceType;
  sourceUri: string;
  savePath?: string;
  name?: string;
  selectedFiles?: number[];
}

export interface TorrentInfo {
  name: string;
  files: {
    path: string;
    size: number;
    index: number;
  }[];
  totalSize: number;
}

// RSS types
export interface RSSFeed {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  autoDownload: boolean;
  filter?: string;              // Regex filter for item names
  lastChecked?: string;         // ISO date string
  intervalMinutes: number;      // Check interval
  savePath?: string;            // Override default save path
}

export interface RSSItem {
  guid: string;
  title: string;
  link: string;                 // Magnet or torrent URL
  pubDate?: string;
  downloaded: boolean;
  size?: number;
  feedId: string;
}

// Search types
export interface SearchProvider {
  id: string;
  name: string;
  url: string;                  // Jackett base URL or custom API URL (for 'script': absolute script path)
  apiKey?: string;
  // Optional login for auth'd indexers (e.g. a RuTracker script plugin). Stored
  // encrypted at rest like apiKey; passed to script providers as TH_USERNAME /
  // TH_PASSWORD env vars so the scraping stays in the (userland) plugin.
  username?: string;
  password?: string;
  enabled: boolean;
  type: 'jackett' | 'torznab' | 'custom' | 'archive' | 'script';
  builtIn?: boolean;            // Pre-seeded provider (e.g. Internet Archive) — not user-removable
}

// Result of probing the host for a usable Python interpreter (for 'script' providers)
export interface PythonStatus {
  found: boolean;
  path?: string;                // Resolved interpreter (e.g. "python3", "C:\\Python\\python.exe")
  version?: string;             // e.g. "Python 3.12.1"
}

export interface SearchResult {
  title: string;
  magnetUri?: string;
  torrentUrl?: string;
  size: number;
  seeds: number;
  leechers: number;
  provider: string;
  publishDate?: string;
  category?: string;
  infoHash?: string;
}

// IP Blocklist types
export interface IPBlocklist {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  lastUpdated?: string;         // ISO date string
  entryCount?: number;
}


export interface IpcApi {
  // Downloads
  addDownload: (request: AddDownloadRequest) => Promise<Download>;
  pauseDownload: (id: string) => Promise<void>;
  resumeDownload: (id: string) => Promise<void>;
  removeDownload: (id: string, deleteFiles: boolean) => Promise<void>;
  stopSeeding: (id: string) => Promise<void>;
  retryDownload: (id: string) => Promise<void>;
  recheckDownload: (id: string) => Promise<void>;
  getDownloads: () => Promise<Download[]>;
  getTorrentFiles: (id: string) => Promise<TorrentFile[]>;
  getStreamUrl: (id: string, fileIndex: number, opts?: { transcode?: boolean; audioTrack?: number }) => Promise<{ url: string; name: string; kind: 'video' | 'audio' | 'other'; transcoded: boolean }>;
  stopStream: (id: string, fileIndex?: number) => Promise<void>;
  shareStart: (downloadId: string) => Promise<ShareInfo>;
  shareStop: (downloadId: string) => Promise<{ ok: boolean }>;
  shareGet: (downloadId: string) => Promise<(ShareInfo & { peers: number }) | null>;
  shareList: () => Promise<ShareInfo[]>;
  getTorrentInfo: (params: { torrentPath?: string; magnetUri?: string }) => Promise<TorrentInfo>;
  setDownloadCategory: (id: string, category: string | null) => Promise<void>;
  getAppStats: () => Promise<{
    totalDownloads: number;
    totalUploaded: string;
    totalDownloaded: string;
    diskUsage: string;
    activeDownloads: number;
    completedDownloads: number;
  }>;
  // Priority 1: new torrent controls
  setSequentialDownload: (id: string, enabled: boolean) => Promise<void>;
  setFilePriority: (id: string, fileIndex: number, priority: FilePriority) => Promise<void>;
  setSeedRatioLimit: (id: string, ratio: number) => Promise<void>;
  setSeedTimeLimit: (id: string, minutes: number) => Promise<void>;
  // Peers
  getPeers: (id: string) => Promise<PeerInfo[]>;
  // Live swarm world map: peers across all active torrents, grouped by country.
  getSwarmGeo: () => Promise<SwarmGeo>;
  // Tracker management
  getTrackers: (id: string) => Promise<TrackerInfo[]>;
  addTracker: (id: string, url: string) => Promise<void>;
  removeTracker: (id: string, url: string) => Promise<void>;

  // Settings
  getSettings: () => Promise<AppSettings>;
  updateSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  exportSettings: () => Promise<{ success: boolean; path?: string }>;
  importSettings: () => Promise<{ success: boolean }>;
  // Watch folder
  getWatchFolderStatus: () => Promise<{ active: boolean; path: string }>;
  setWatchFolder: (path: string, enabled: boolean, deleteAfterAdd: boolean) => Promise<void>;

  // System
  getAutoLaunch: () => Promise<boolean>;
  setAutoLaunch: (enabled: boolean) => Promise<{ success: boolean }>;
  setCloseToTray: (enabled: boolean) => Promise<{ success: boolean }>;
  setMinimizeToTray: (enabled: boolean) => Promise<{ success: boolean }>;
  // Auto-update
  checkForUpdates: () => Promise<{ ok: boolean; reason?: string }>;
  quitAndInstallUpdate: () => Promise<{ ok: boolean }>;
  onUpdateStatus: (callback: (status: { kind: string; [k: string]: unknown }) => void) => () => void;
  getAppVersion: () => Promise<string>;
  relaunchApp: () => Promise<{ ok: boolean }>;
  getRunningEngine: () => Promise<'native' | 'webtorrent'>;
  isDefaultClient: () => Promise<boolean>;
  setDefaultClient: () => Promise<{ success: boolean }>;

  // Categories
  getCategories: () => Promise<Category[]>;
  addCategory: (category: Omit<Category, 'id'>) => Promise<Category>;
  updateCategory: (id: string, category: Partial<Category>) => Promise<Category>;
  deleteCategory: (id: string) => Promise<void>;

  // Scheduler
  getScheduler: () => Promise<SchedulerConfig>;
  updateScheduler: (config: Partial<SchedulerConfig>) => Promise<SchedulerConfig>;

  // File dialogs
  selectDirectory: () => Promise<string | null>;
  selectTorrentFile: () => Promise<{ path: string; content: string } | null>;
  selectFilesForTorrent: () => Promise<string[] | null>;
  selectFolderForTorrent: () => Promise<string | null>;
  selectSaveTorrentPath: (defaultName: string) => Promise<string | null>;
  
  // File system operations
  getPathInfo: (path: string) => Promise<{
    isDirectory: boolean;
    size: number;
    fileCount: number;
    name: string;
  }>;
  getFileTree: (sourcePaths: string[]) => Promise<FsFileNode[]>;

  // Shell operations
  openPath: (path: string) => Promise<void>;
  showItemInFolder: (path: string) => Promise<void>;

  // Cache management
  clearCache: () => Promise<{ success: boolean }>;

  // Create torrent
  createTorrent: (request: CreateTorrentRequest) => Promise<CreateTorrentResult>;
  getDefaultTrackers: () => Promise<string[][]>;

  // Stats subscription
  onDownloadStats: (callback: (stats: DownloadStats[]) => void) => () => void;
  onCreateTorrentProgress: (callback: (progress: CreateTorrentProgress) => void) => () => void;

  // Privacy & Security
  getPrivacyConfig: () => Promise<PrivacyConfig>;
  updatePrivacyConfig: (updates: Partial<PrivacyConfig>) => Promise<PrivacyConfig>;
  getVpnBindStatus: () => Promise<VpnBindReport>;
  checkVPN: () => Promise<VPNDetectionResult>;
  getIpInfo: () => Promise<IpInfo>;
  getNetworkHealth: () => Promise<NetworkHealth>;
  // DNS-over-HTTPS resolver management
  getDohTemplates: () => Promise<DohTemplate[]>;                       // built-in + custom
  addDohTemplate: (name: string, url: string) => Promise<DohTemplate>; // add a custom resolver
  deleteDohTemplate: (id: string) => Promise<{ ok: boolean }>;         // remove a custom resolver
  testDohResolver: (url: string) => Promise<{ ok: boolean; ms?: number; ip?: string; error?: string }>;
  // Smart network profiles
  getCurrentNetwork: () => Promise<NetworkInfo>;
  getNetworkProfiles: () => Promise<{ profiles: NetworkProfile[]; activeId: string | null; current: NetworkInfo }>;
  saveNetworkProfile: (profile: NetworkProfile) => Promise<NetworkProfile>;
  deleteNetworkProfile: (id: string) => Promise<{ ok: boolean }>;
  onNetworkProfile: (callback: (payload: { current: NetworkInfo; activeId: string | null }) => void) => () => void;
  isEncryptionAvailable: () => Promise<boolean>;
  clearAllData: () => Promise<{ success: boolean }>;
  openLogsFolder: () => Promise<{ ok: boolean }>;
  clearLogs: () => Promise<{ removed: number }>;
  getPortForwardStatus: () => Promise<PortForwardStatus>;

  // App events
  onOpenTorrent: (callback: (torrentUri: string) => void) => () => void;
  // Renderer announces its IPC listeners are attached (flushes buffered OS opens)
  notifyReady: () => void;
  // Mirror the renderer's UI language to main (localizes tray/dialogs/notifications)
  setLanguage: (lang: string) => void;
  // UI scale via webFrame zoom (scales viewport too, unlike CSS zoom)
  setZoomFactor: (factor: number) => void;
  // Resolve the absolute path of a dropped/selected File (webUtils.getPathForFile)
  getPathForFile: (file: File) => string;
  // Bulk torrent actions (the tray menu calls the manager directly)
  pauseAll: () => Promise<{ paused: number }>;
  resumeAll: () => Promise<{ resumed: number }>;
  // Alternative ("turbo"/turtle) speed-limit quick toggle
  setAltSpeed: (enabled: boolean) => Promise<{ altSpeedEnabled: boolean }>;
  getAltSpeed: () => Promise<{ altSpeedEnabled: boolean }>;
  // Mobile web remote
  webRemote: {
    getInfo: () => Promise<{ enabled: boolean; running: boolean; url: string | null; port: number }>;
    setEnabled: (enabled: boolean) => Promise<{ enabled: boolean; running: boolean; url: string | null; port: number }>;
    regenToken: () => Promise<{ enabled: boolean; running: boolean; url: string | null; port: number }>;
  };
  onVpnDropped: (callback: (info: { paused: number; rooms?: boolean; publicIP?: string }) => void) => () => void;
  onVpnRestored: (callback: () => void) => () => void;
  // Engine VPN-bind lifecycle: lost = bound address vanished (sockets dead),
  // rebound = engine restarted onto a new VPN IP, restored = same IP came back.
  onVpnBindStatus: (callback: (info: VpnBindEvent) => void) => () => void;
  // On-completion action (one-shot; state lives in main, renderer mirrors it)
  getCompletionAction: () => Promise<CompletionActionState>;
  setCompletionAction: (action: CompletionAction) => Promise<{ ok: boolean }>;
  onCompletionActionChanged: (callback: (action: CompletionAction) => void) => () => void;
  onCompletionActionPending: (callback: (pending: CompletionPending | null) => void) => () => void;
  // Startup "VPN not detected" advisory + its "Don't show again" opt-out
  onVpnWarning: (callback: (info: { publicIP?: string }) => void) => () => void;
  vpnWarningDismissed: () => void;
  onDiskLow: (callback: (info: { paused: number; freeBytes: number; thresholdBytes: number }) => void) => () => void;
  onDiskRecovered: (callback: () => void) => () => void;

  // RSS
  rss: {
    getFeeds: () => Promise<RSSFeed[]>;
    addFeed: (feed: Omit<RSSFeed, 'id'>) => Promise<RSSFeed>;
    updateFeed: (id: string, updates: Partial<RSSFeed>) => Promise<RSSFeed>;
    removeFeed: (id: string) => Promise<void>;
    checkFeed: (id: string) => Promise<RSSItem[]>;
    checkAll: () => Promise<void>;
    getItems: (feedId: string) => Promise<RSSItem[]>;
    markDownloaded: (guid: string) => Promise<void>;
    clearItems: (feedId?: string, onlyDownloaded?: boolean) => Promise<{ removed: number }>;
  };

  // Search
  search: {
    query: (query: string, category?: string) => Promise<SearchResult[]>;
    getProviders: () => Promise<SearchProvider[]>;
    addProvider: (provider: Omit<SearchProvider, 'id'>) => Promise<SearchProvider>;
    updateProvider: (id: string, updates: Partial<SearchProvider>) => Promise<SearchProvider>;
    removeProvider: (id: string) => Promise<void>;
    testProvider: (id: string) => Promise<{ success: boolean; message: string }>;
    checkPython: (force?: boolean) => Promise<PythonStatus>;
  };

  // Cast to a device on the LAN (HLS transcode / direct, with seeking)
  cast: {
    start: (id: string, fileIndex: number) => Promise<{ url: string; lan: string; port: number } | null>;
    stop: (id: string, fileIndex: number) => Promise<{ ok: boolean }>;
    // Remote streaming over WebRTC (watch on a device outside your network)
    remoteStart: (id: string, fileIndex: number) => Promise<{ url: string; sessionId: string }>;
    remoteStop: (sessionId: string) => Promise<{ ok: boolean }>;
    // Cast to TV (Chromecast / Android TV)
    tvList: () => Promise<Array<{ name: string; host: string }>>;
    tvRefresh: () => Promise<Array<{ name: string; host: string }>>;
    tvPlay: (id: string, fileIndex: number, host: string) => Promise<{ ok: boolean }>;
    tvControl: (host: string, action: 'pause' | 'resume' | 'stop') => Promise<{ ok: boolean }>;
  };

  // Audio tracks for the player (multi-audio MKV; switching restarts the transcode)
  audioTracks: {
    list: (id: string, fileIndex: number) => Promise<Array<{ index: number; label: string; lang?: string; isDefault?: boolean }>>;
  };

  // Subtitles for the player (embedded text tracks + sidecar files → WebVTT)
  subtitles: {
    list: (id: string, fileIndex: number) => Promise<Array<{ key: string; label: string; lang?: string; source: 'embedded' | 'external' }>>;
    get: (id: string, fileIndex: number, key: string) => Promise<string>;
  };

  // Friend swarms / private rooms (Phase 3)
  rooms: {
    getProfile: () => Promise<RoomProfile>;
    setProfile: (updates: Partial<Pick<RoomProfile, 'name' | 'avatarSeed'>>) => Promise<RoomProfile>;
    create: (name: string, e2e?: boolean) => Promise<RoomState>;
    join: (code: string) => Promise<RoomState>;
    leave: (roomId: string, deleteFiles?: boolean) => Promise<{ ok: boolean }>;
    list: () => Promise<RoomSummary[]>;
    get: (roomId: string) => Promise<RoomState | null>;
    addFiles: (roomId: string, paths: string[], folderId?: string) => Promise<RoomState>;
    pickAndAddFiles: (roomId: string, folderId?: string) => Promise<RoomState | null>;
    shareDownload: (roomId: string, downloadId: string, selectedPaths?: string[], folderName?: string) => Promise<RoomState>;
    listShareableFiles: (downloadId: string) => Promise<{ files: Array<{ path: string; name: string; size: number }>; truncated: boolean; maxShare: number }>;
    openFolder: (roomId: string) => Promise<void>;
    openFile: (roomId: string, fileId: string) => Promise<void>;
    watchFile: (roomId: string, fileId: string) => Promise<{ directUrl: string; hlsUrl: string; playerUrl: string; coverUrl?: string; direct: boolean; kind: string; name: string }>;
    broadcastSync: (roomId: string, payload: { fileId: string; action: string; position: number; rate?: number; playing?: boolean; together?: boolean; emoji?: string }) => Promise<{ ok: boolean }>;
    removeFile: (roomId: string, fileId: string) => Promise<{ ok: boolean }>;
    removeFiles: (roomId: string, fileIds: string[]) => Promise<{ ok: boolean }>;
    rename: (roomId: string, name: string) => Promise<RoomState>;
    requestFile: (roomId: string, text: string) => Promise<{ ok: boolean }>;
    markRead: (roomId: string) => Promise<{ ok: boolean }>;
    setActiveRoom: (roomId: string | null) => Promise<{ ok: boolean }>;
    // Folders/sections (any member may manage; convergence is last-writer-wins)
    createFolder: (roomId: string, name: string, icon: string, color: string) => Promise<RoomState>;
    updateFolder: (roomId: string, folderId: string, patch: { name?: string; icon?: string; color?: string }) => Promise<RoomState>;
    deleteFolder: (roomId: string, folderId: string) => Promise<RoomState>;
    assignFile: (roomId: string, fileId: string, folderId: string | null) => Promise<RoomState>;
    setMuted: (roomId: string, memberId: string, muted: boolean) => Promise<{ ok: boolean }>;
    setAutoFetch: (roomId: string, autoFetch: boolean) => Promise<{ ok: boolean }>;
    fetchFile: (roomId: string, fileId: string) => Promise<RoomState>;
    setLimits: (roomId: string, upKbps: number, downKbps: number) => Promise<{ ok: boolean }>;
    kick: (roomId: string, memberId: string) => Promise<{ ok: boolean }>;
    sendChat: (roomId: string, text: string) => Promise<{ ok: boolean }>;
    typing: (roomId: string) => void;
    reactFile: (roomId: string, fileId: string, emoji: string) => Promise<void>;
    // Serverless mesh voice channel.
    voice: {
      join: (roomId: string) => Promise<{ ok: boolean }>;
      leave: (roomId: string) => Promise<{ ok: boolean }>;
      mute: (roomId: string, muted: boolean) => Promise<{ ok: boolean }>;
      deafen: (roomId: string, deafened: boolean) => Promise<{ ok: boolean }>;
      volume: (roomId: string, memberId: string, volume: number) => Promise<{ ok: boolean }>;
      inputMode: (roomId: string, mode: VoiceInputMode) => Promise<{ ok: boolean }>;
      ptt: (roomId: string, active: boolean) => Promise<{ ok: boolean }>;
    };
    exportIdentity: () => Promise<{ success: boolean; path?: string }>;
    importIdentity: () => Promise<{ success: boolean; rooms?: number }>;
  };
  // Custom theme sharing (import/export as a JSON file). Imported `data` is
  // untrusted raw JSON — the renderer runs validateTheme() before using it.
  themes: {
    export: (theme: Theme, suggestedName?: string) => Promise<{ success: boolean; path?: string }>;
    import: () => Promise<{ success: boolean; data?: unknown; error?: string }>;
  };
  onRoomUpdate: (callback: (state: RoomState) => void) => () => void;
  onRoomSync: (callback: (msg: { roomId: string; fileId: string; action: string; position: number; rate: number; at: number; memberId: string; name: string; avatarSeed?: string; playing?: boolean; together?: boolean; emoji?: string }) => void) => () => void;
  onRoomOpen: (callback: (roomId: string) => void) => () => void;

  // IP Blocklist
  blocklist: {
    getAll: () => Promise<IPBlocklist[]>;
    add: (name: string, url: string) => Promise<IPBlocklist>;
    remove: (id: string) => Promise<void>;
    update: (id: string) => Promise<{ entryCount: number }>;
    setEnabled: (id: string, enabled: boolean) => Promise<void>;
  };

  // Dialog API
  dialog: {
    showOpenDialog: (options: {
      properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => Promise<{ canceled: boolean; filePaths: string[] }>;
    showSaveDialog: (options: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => Promise<{ canceled: boolean; filePath?: string }>;
  };
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
