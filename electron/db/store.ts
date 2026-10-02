import { historyDays, retainLocalHistory, localHistoryPage, type RoomHistoryDays, type RoomHistoryPage } from '../../shared/room-local-data';
import { ROOM_FILE_LIMIT, ROOM_FOLDER_LIMIT, ROOM_FOLDER_TOMB_LIMIT } from '../../shared/room-manifest-sync';
import type { RoomBanSnapshot } from '../../shared/room-bans';
/**
 * JSON-based storage using electron-store, split across several files by concern
 * so the on-disk data is easy to inspect/edit and the hot path is cheap to write.
 *
 * electron-store rewrites a file in full on every `set()`. Keeping everything in
 * one file meant the 5-second download-progress persist also rewrote the (often
 * multi-MB) IP blocklist and up to 5000 RSS items each tick. The data now lives
 * in dedicated files:
 *   config.json      — settings, categories, scheduler, privacy, window, flags
 *   downloads.json   — downloads (the hot, frequently-written one)
 *   rss.json         — RSS feeds + items
 *   blocklists.json  — IP blocklists + packed range data
 *   search.json      — search providers
 *   rooms.json       — friend-swarm rooms, profile, tombstones
 *   reputation.json  — collaborative-seeding reputation + transactions
 *
 * Existing installs are migrated once from the old monolithic config.json (see
 * migrateToSplitStores).
 */

import Store from 'electron-store';
import { sealRoom, openRoom, lockedRoom, type StoredRoom, type RoomStorageError } from './room-secrets';
import { isEncryptionAvailable } from './secrets';
import type { RoomE2ECfg, RoomKeyPage } from '../../shared/room-keyring';
import { DEFAULT_MAX_UP_KBPS } from '../../shared/upload-limits';
import { Download, AppSettings, SourceType, Category, SchedulerConfig, UserReputation, ReputationTransaction, PrivacyConfig, RSSFeed, RSSItem, RSSRule, SearchProvider, IPBlocklist, RoomProfile, PersistedRoomFile, PersistedRoomFolder, RoomEvent, RoomChatMessage, RoomChatDraft, NetworkProfile } from '../../shared/types';
import { normalizeRoomChatDraft } from '../../shared/room-chat-delivery';
import { ROOM_CHAT_LIMIT, retainRoomChat, upgradeChat } from '../../shared/room-chat-history';
import { v4 as uuidv4 } from 'uuid';
import { app } from 'electron';
import path from 'path';
import crypto from 'crypto';
import { normalizeLanPrefs, EMPTY_LAN_PREFS, type LanRoomPrefs } from '../../shared/lan-prefs';
import { encryptSecret, decryptSecret } from './secrets';
import { deriveMemberId } from '../sharing/room-crypto';
import { sanitizeProfileColor, sanitizeProfileStatus, sanitizeProfileImg } from '../../shared/profile';
import { searchDownloadHistory } from '../services/search-download-history';

// === Per-file store schemas ===

interface ConfigSchema {
  appearanceAcrylic?: boolean;
  settings: AppSettings;
  categories: Category[];
  scheduler: SchedulerConfig;
  privacyConfig: PrivacyConfig;
  windowBounds: WindowBounds | null;
  popoutBounds: Record<string, WindowBounds> | null; // per-frameName pop-out window bounds
  defaultsSeeded: boolean;               // First-run seeding marker
  suggestedFeedSeeded: boolean;          // One-time seeding/migration of the working FOSS Torrents feed
  collaborativeSeedingEnabled: boolean;  // Collaborative Seeding Network opt-in (persisted)
  trayHintShown?: boolean;               // One-time "running in tray" hint (set from main.ts)
  vpnWarningDismissed?: boolean;         // "Don't show again" on the startup VPN warning dialog
  splitStoresMigrated?: boolean;         // One-time migration marker (see migrateToSplitStores)
  utpDefaultOnMigrated?: boolean;        // One-time flip of µTP on for existing installs (see migrateUtpDefaultOn)
  networkProfiles?: NetworkProfile[];    // Smart per-network settings overlays
  uiLanguage?: 'en' | 'ru';              // Mirror of the renderer's language, so main can localize tray/dialogs/notifications
}

interface DownloadsSchema {
  downloads: Record<string, Download>;
}

interface RssSchema {
  rssFeeds: RSSFeed[];
  rssItems: RSSItem[];
  rssRules: RSSRule[];
  /** Set once the per-feed `filter` fields have been turned into rules. */
  rssRulesMigrated?: boolean;
}

interface BlocklistSchema {
  ipBlocklists: IPBlocklist[];
  blocklistData: Record<string, string>; // id -> packed IP ranges as CSV
  /** Per-IP bans from the Peers tab; IPv4 dotted-quad. Session-only bans live in memory. */
  manualBans: string[];
}

interface SearchSchema {
  searchProviders: SearchProvider[];
}

interface RoomsSchema {
  rooms: Record<string, StoredRoom>;      // Friend swarms / private rooms (Phase 3)
  roomProfile: RoomProfile | null;           // This install's identity in rooms
  roomTombstones: Record<string, Record<string, number>>; // roomId → (deleted fileId → deletedAt ms); a later explicit re-share revives it
  roomTombstoneProofs: Record<string, Record<string, { by: string; pub: string; sig: string }>>; // roomId → (fileId → author/owner deletion signature), so a tombstone re-verifies as it gossips
  roomRevives: Record<string, Record<string, number>>; // roomId → (fileId → revAt of a VERIFIED revive); persisted so the re-deletion guard survives restart
  roomLastRead: Record<string, number>; // roomId → last time the user viewed the room (ms); chat newer than this is unread
  roomManifests: Record<string, PersistedRoomFile[]>; // roomId → known files (resume on restart)
  roomFolders: Record<string, PersistedRoomFolder[]>; // roomId → folders/sections (resume on restart)
  roomFolderTombstones: Record<string, Record<string, number>>; // roomId → (deleted folderId → deletedAt ms)
  roomHistory: Record<string, RoomEvent[]>;  // roomId → activity log (capped)
  roomMutes: Record<string, string[]>;       // roomId → locally-muted memberIds
  roomLan: Record<string, LanRoomPrefs>;     // roomId → remembered virtual-LAN setup (picked players, game .exes granted a firewall rule); local convenience, never an authority — see shared/lan-prefs.ts
  roomFolderFetch: Record<string, Record<string, boolean>>; // roomId → (folderId → auto-fetch override; absent = inherit room autoFetch)
  roomChats: Record<string, RoomChatMessage[]>; // roomId → chat log (capped, text encrypted at rest)
  roomChatArchive?: Record<string, RoomChatMessage[]>;
  roomEventArchive?: Record<string, RoomEvent[]>;
  roomArchiveEdits?: Record<string, Record<string, { text: string; at: number; by: string; pub: string; sig: string }>>;
  roomHistoryRetention?: Record<string, RoomHistoryDays>;
  roomChatReceipts?: Record<string, Array<{ id: string; digest: string }>>; // 1000 recent local sends; encrypted digest, no retained message bodies
  roomChatDrafts?: Record<string, string>; // entire draft encrypted at rest
  roomReacts: Record<string, Record<string, Record<string, string[]>>>; // roomId → fileId → emoji → memberIds (capped)
  roomChatReacts: Record<string, Record<string, Record<string, string[]>>>; // roomId → chat msgId → emoji → memberIds (capped)
  roomChatEdits: Record<string, Record<string, { text: string; at: number; by: string; pub: string; sig: string }>>; // roomId → msgId → author's signed edit (text encrypted at rest)
  roomIdentity: { pub: string; priv: string } | null; // this install's Ed25519 signing keypair (priv encrypted)
  roomIdentities: Record<string, Record<string, string>>; // roomId → (memberId → pubKey), TOFU binding
}

interface ReputationSchema {
  reputation: Record<string, UserReputation>;
  transactions: Record<string, ReputationTransaction[]>;
}

/** Persisted main-window geometry, restored on next launch. */
export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

/** Minimal persisted room record — re-joined on startup. */
export interface PersistedRoom {
  roomId: string;
  name: string;
  code: string;
  folder: string;
  createdAt: number;
  ownerId?: string;  // memberId of the room owner (creator); learned via gossip for joiners
  ownerPin?: string; // owner memberId pinned from the invite — only this identity may be adopted as owner (absent = trust-on-first-use)
  nameAt?: number;   // last-writer-wins clock for the room name (owner rename); absent/0 = never renamed
  topic?: string;    // owner-set room topic ('' / absent = none)
  topicAt?: number;  // last-writer-wins clock for the topic
  topicBy?: string;  // signer (owner) memberId — re-served in HELLOs, re-verified by receivers
  topicPub?: string;
  topicSig?: string;
  e2e?: boolean;     // end-to-end encryption mode (set at creation; learned via gossip)
  secret?: string;   // E2E content key (32-byte hex); distributed over encrypted gossip
  prevSecrets?: string[]; // retained decrypt-only content keys; never silently evicted
  keyPages?: RoomKeyPage[]; // current owner-signed paged history (protected at rest)
  storageError?: RoomStorageError; // read-only recovery status, never stored
  banState?: RoomBanSnapshot; // current owner-signed ban proof, protected at rest and re-verified by the engine
  bans?: string[];   // memberIds cut by an owner-signed rekey — their gossip is dropped
  // Owner-signed E2E config blob (Ed25519 over topic+ownerId+e2e+secret). Kept so
  // the engine can re-verify the secret's provenance and re-serve it to joiners
  // after a restart; the engine always re-verifies before trusting it.
  e2eCfg?: RoomE2ECfg;
  // Ownership-transfer chain: every applied owner handover in order, each signed
  // by the then-current owner (Ed25519 over th-room-transfer:v1). The engine
  // re-verifies the whole chain from the invite pin / TOFU root on every
  // restart — never trusted raw — and re-serves it to joiners in HELLOs.
  transferChain?: Array<{ newOwnerId: string; at: number; by: string; pub: string; sig: string }>;
  autoFetch?: boolean; // auto-download files peers share (absent = true, the historical behavior)
  upKbps?: number;     // per-room upload ceiling, KB/s (0 = shared room budget)
  downKbps?: number;   // per-room download ceiling, KB/s (0 = shared room budget)
  notifyMuted?: boolean; // OS notifications silenced for this room (absent = notify)
}

const defaultCategories: Category[] = [
  { id: 'movies', name: 'Movies', icon: 'film', color: '#ef4444' },
  { id: 'games', name: 'Games', icon: 'gamepad-2', color: '#8b5cf6' },
  { id: 'software', name: 'Software', icon: 'package', color: '#3b82f6' },
  { id: 'music', name: 'Music', icon: 'music', color: '#22c55e' },
  { id: 'other', name: 'Other', icon: 'folder', color: '#6b7280' },
];

// === Store instances (one file each) ===
// 'config' is electron-store's default name, so configStore reuses the existing
// config.json — settings/categories/etc. stay put with no migration needed.

const configStore = new Store<ConfigSchema>({
  name: 'config',
  defaults: {
    settings: {
      id: 1,
      // The transmission-daemon sidecar is the default download engine ("2.0");
      // 'webtorrent' keeps the legacy in-process engine as a fallback until
      // feature parity (docs/engine-swap-plan.md). Restart-only.
      engine: 'native' as const,
      // Fresh installs download to <Downloads>/Havvn; migrated profiles keep
      // whatever defaultDownloadDir they had persisted (often .../TorrentHunt).
      defaultDownloadDir: path.join(app.getPath('downloads'), 'Havvn'),
      maxDownKbps: 0,
      maxUpKbps: DEFAULT_MAX_UP_KBPS,
      altSpeedEnabled: false,
      altDownKbps: 0,
      altUpKbps: 0,
      maxActiveDownloads: 3,
      // Default to NOT hiding in the tray: closing quits, minimizing minimizes.
      // Tray mode is opt-in (Settings → System); the reopen path is reliable
      // when enabled, but a surprise background process is the worse default.
      minimizeToTray: false,
      closeToTray: false,
      autoLaunch: false,
      autoUpdate: false,
      updateChannel: 'stable',
      // Advanced
      enableDHT: true,
      enablePEX: true,
      enableLSD: true,
      // µTP on by default on ALL platforms now: utp-native ships an ABI-stable
      // N-API prebuild that loads under Electron, the WSAENOBUFS socket flood is
      // bounded by connection slow-start, and a µTP failure falls back to TCP
      // per-peer (WebTorrent) / is swallowed transiently by the host. Being
      // TCP-only on Windows was a major cause of peer scarcity. Toggle in
      // Settings → Advanced (enableUtp) to force TCP-only.
      enableUtp: true,
      encryption: 'preferred' as const,
      maxConnections: 100,
      maxConnectionsGlobal: 300,
      portMin: 6881,
      portMax: 6889,
      portForwarding: true,
      adaptiveUpload: false,
      dohEnabled: false,
      dohTemplateId: 'cloudflare',
      dohCustomTemplates: [],
      networkProfilesEnabled: false,
      // Proxy
      proxyEnabled: false,
      proxyType: 'http' as const,
      proxyHost: '',
      proxyPort: 8080,
      proxyUsername: '',
      proxyPassword: '',
      // Watch folder
      watchFolderEnabled: false,
      watchFolderPath: '',
      watchFolderDeleteAfterAdd: false,
      // Clipboard magnet watcher (opt-in)
      clipboardWatchEnabled: false,
      // Auto-move completed
      autoMoveEnabled: false,
      autoMovePath: '',
      // Mobile web remote (off by default; token lazily generated)
      webRemoteEnabled: false,
      webRemotePort: 8788,
      webRemoteToken: '',
      // Seeding limits
      defaultSeedRatioLimit: 0,
      defaultSeedTimeLimitMinutes: 0,
      // Notifications
      enableNotifications: true,
      enableSounds: true,
      notifyOnComplete: true,
      notifyOnError: true,
      // Disk-space guard
      diskGuardEnabled: true,
      diskGuardMinFreeMB: 2048,
      // Sharing
      roomResources: { maxUpKbps: 256, maxDownKbps: 0, voicePriority: true, screenBitrateKbps: 2500 },
    shareUseTurn: true,
      updatedAt: new Date(),
    },
    categories: defaultCategories,
    scheduler: {
      enabled: false,
      schedules: [],
    },
    privacyConfig: {
      anonymousMode: true,
      encryptStorage: true,
      disableLogs: false,
      vpnCheck: true,
      clearDataOnExit: false,
      ephemeralPeerId: true,
      sanitizeLogs: true,
      vpnKillSwitch: false,
      vpnBindEngine: false,
    },
    windowBounds: null,
    popoutBounds: null,
    defaultsSeeded: false,
    suggestedFeedSeeded: false,
    collaborativeSeedingEnabled: false,
  },
});

const downloadsStore = new Store<DownloadsSchema>({
  name: 'downloads',
  defaults: { downloads: {} },
});

const rssStore = new Store<RssSchema>({
  name: 'rss',
  defaults: { rssFeeds: [], rssItems: [], rssRules: [] },
});

const blocklistStore = new Store<BlocklistSchema>({
  name: 'blocklists',
  defaults: { ipBlocklists: [], blocklistData: {}, manualBans: [] },
});

const searchStore = new Store<SearchSchema>({
  name: 'search',
  defaults: { searchProviders: [] },
});

const roomsStore = new Store<RoomsSchema>({
  name: 'rooms',
  defaults: { rooms: {}, roomProfile: null, roomTombstones: {}, roomTombstoneProofs: {}, roomRevives: {}, roomLastRead: {}, roomManifests: {}, roomFolders: {}, roomFolderTombstones: {}, roomHistory: {}, roomMutes: {}, roomLan: {}, roomFolderFetch: {}, roomChats: {}, roomReacts: {}, roomChatReacts: {}, roomChatEdits: {}, roomIdentity: null, roomIdentities: {} },
});

const reputationStore = new Store<ReputationSchema>({
  name: 'reputation',
  defaults: { reputation: {}, transactions: {} },
});

/**
 * One-time migration from the old single-file layout. Older versions kept
 * everything in config.json; move the relocated keys into their dedicated files
 * and drop them from config. Idempotent: already-moved keys are gone from the
 * legacy store, so re-running (e.g. after a crash mid-migration) is safe.
 */
function migrateToSplitStores(): void {
  if (configStore.get('splitStoresMigrated')) return;

  const legacy = configStore as unknown as {
    has(key: string): boolean;
    get(key: string): unknown;
    delete(key: string): void;
  };

  const move = (key: string, target: Store<any>): void => {
    if (legacy.has(key)) {
      target.set(key, legacy.get(key));
      legacy.delete(key);
    }
  };

  move('downloads', downloadsStore);
  move('rssFeeds', rssStore);
  move('rssItems', rssStore);
  move('ipBlocklists', blocklistStore);
  move('blocklistData', blocklistStore);
  move('searchProviders', searchStore);
  move('rooms', roomsStore);
  move('roomProfile', roomsStore);
  move('roomTombstones', roomsStore);
  move('reputation', reputationStore);
  move('transactions', reputationStore);

  configStore.set('splitStoresMigrated', true);
}

migrateToSplitStores();

/**
 * One-time flip of µTP on for existing installs. Older Windows builds persisted
 * enableUtp:false (TCP-only was a major cause of peer scarcity); µTP is now safe
 * on by default. Flip it on once for anyone currently at false, then never touch
 * it again — a user who deliberately toggles it back off keeps that choice.
 */
function migrateUtpDefaultOn(): void {
  if (configStore.get('utpDefaultOnMigrated')) return;
  const s = configStore.get('settings') as (AppSettings | undefined);
  if (s && s.enableUtp === false) {
    configStore.set('settings', { ...s, enableUtp: true });
  }
  configStore.set('utpDefaultOnMigrated', true);
}

migrateUtpDefaultOn();

// === Room tombstones (deleted shared files — keep them from reappearing) ===
//
// Each tombstone carries the deletion time so removals and re-shares resolve
// last-writer-wins: a file whose addedAt is newer than the tombstone is a
// deliberate revive and comes back; anything older stays dead.

/**
 * One-time upgrade of the persisted tombstone shape: plain fileId arrays →
 * (fileId → deletedAt) maps. Legacy entries are stamped with the migration time
 * so they keep suppressing what they already deleted, while any explicit
 * re-share made afterwards beats them.
 */
function migrateTombstoneTimestamps(): void {
  const all = roomsStore.get('roomTombstones') as unknown as Record<string, unknown> | undefined;
  if (!all) return;
  let changed = false;
  const now = Date.now();
  const out: Record<string, Record<string, number>> = {};
  for (const [roomId, v] of Object.entries(all)) {
    if (Array.isArray(v)) {
      changed = true;
      const map: Record<string, number> = {};
      for (const id of v) if (typeof id === 'string') map[id] = now;
      out[roomId] = map;
    } else if (v && typeof v === 'object') {
      out[roomId] = v as Record<string, number>;
    }
  }
  if (changed) roomsStore.set('roomTombstones', out);
}

migrateTombstoneTimestamps();

/**
 * One-time upgrade of this install's memberId from a random UUID to the
 * key-derived form deriveMemberId(pub), which cryptographically binds identity so
 * a member can no longer forge the owner's (or anyone's) id. This is a DELIBERATE
 * compatibility break: our id changes, so we re-own the rooms we owned (local
 * ownership preserved) and drop the stale TOFU bindings (they map old-format ids
 * and would reject our own re-key otherwise; peers re-bind, now validated, on the
 * next hello). Peers on the old id format can no longer authenticate to us —
 * mixed old/new rooms must be re-created, which is the point of the break.
 *
 * Called from initializeApp AFTER app.whenReady(), NOT at module load: it may
 * generate the signing keypair via getRoomIdentity(), and safeStorage (which
 * encrypts the private key at rest) is unavailable until 'ready' — running it
 * earlier could persist the key in plaintext on platforms without DPAPI.
 */
export function migrateMemberIdToKeyDerived(): void {
  const profile = roomsStore.get('roomProfile');
  if (!profile || !profile.memberId) return; // fresh install: getRoomProfile derives it directly
  const { pub } = getRoomIdentity(); // ensure the keypair exists so we can derive
  const derived = deriveMemberId(pub);
  if (profile.memberId === derived) return; // already key-derived
  const old = profile.memberId;
  const rooms = roomsStore.get('rooms') ?? {};
  let changed = false;
  for (const r of Object.values(rooms)) {
    if (r && r.ownerId === old) { r.ownerId = derived; changed = true; }
    if (r && r.ownerPin === old) { r.ownerPin = derived; changed = true; }
  }
  if (changed) roomsStore.set('rooms', rooms);
  // Re-attribute OUR OWN files in every manifest (addedBy = our old id → derived),
  // so a file we shared before the upgrade still authorizes our own author-delete
  // locally. (Peers' ids and other members' files are untouched — foreign authorship
  // can't be re-proven; those legacy files stay owner-delete-only room-wide.)
  const manifests = roomsStore.get('roomManifests') ?? {};
  let mChanged = false;
  for (const files of Object.values(manifests)) {
    if (!Array.isArray(files)) continue;
    for (const f of files) if (f && f.addedBy === old) { f.addedBy = derived; mChanged = true; }
  }
  if (mChanged) roomsStore.set('roomManifests', manifests);
  roomsStore.set('roomIdentities', {}); // stale bindings → re-TOFU (now validated) on next hello
  roomsStore.set('roomProfile', { ...profile, memberId: derived, avatarSeed: profile.avatarSeed === old ? derived : profile.avatarSeed });
}

export function getRoomTombstones(roomId: string): Record<string, number> {
  return (roomsStore.get('roomTombstones') ?? {})[roomId] ?? {};
}

export function addRoomTombstone(roomId: string, fileId: string, at: number = Date.now()): void {
  const all = roomsStore.get('roomTombstones') ?? {};
  const map = { ...(all[roomId] ?? {}) };
  if (!(fileId in map) && Object.keys(map).length >= ROOM_FILE_LIMIT) return;
  map[fileId] = Math.max(at, map[fileId] ?? 0);
  all[roomId] = map;
  roomsStore.set('roomTombstones', all);
}

/** Lift one tombstone (the user explicitly re-shared the file into the room). */
export function removeRoomTombstone(roomId: string, fileId: string): void {
  const all = roomsStore.get('roomTombstones') ?? {};
  const map = all[roomId];
  if (!map || !(fileId in map)) return;
  const rest = { ...map };
  delete rest[fileId];
  all[roomId] = rest;
  roomsStore.set('roomTombstones', all);
}

export function clearRoomTombstones(roomId: string): void {
  const all = roomsStore.get('roomTombstones') ?? {};
  delete all[roomId];
  roomsStore.set('roomTombstones', all);
}

// Deletion proofs (parallel to roomTombstones, keyed identically). Stored apart
// so the tombstone timestamp map keeps its shape; a tombstone without a proof
// here is a legacy/local one that gossips only as a bare (unauthenticated) tomb.

export function getRoomTombstoneProofs(roomId: string): Record<string, { by: string; pub: string; sig: string }> {
  return (roomsStore.get('roomTombstoneProofs') ?? {})[roomId] ?? {};
}

export function addRoomTombstoneProof(roomId: string, fileId: string, proof: { by: string; pub: string; sig: string }): void {
  const all = roomsStore.get('roomTombstoneProofs') ?? {};
  const map = { ...(all[roomId] ?? {}) };
  if (!(fileId in map) && Object.keys(map).length >= ROOM_FILE_LIMIT) return;
  map[fileId] = proof;
  // Proofs share the bounded, non-evicting deletion budget.
  all[roomId] = map;
  roomsStore.set('roomTombstoneProofs', all);
}

/** Drop proofs for tombstones that were evicted, so proofs stay a subset. */
export function pruneRoomTombstoneProofs(roomId: string, fileIds: string[]): void {
  const all = roomsStore.get('roomTombstoneProofs') ?? {};
  const map = all[roomId];
  if (!map) return;
  let changed = false;
  for (const id of fileIds) if (id in map) { delete map[id]; changed = true; }
  if (changed) { all[roomId] = map; roomsStore.set('roomTombstoneProofs', all); }
}

export function removeRoomTombstoneProof(roomId: string, fileId: string): void {
  const all = roomsStore.get('roomTombstoneProofs') ?? {};
  const map = all[roomId];
  if (!map || !(fileId in map)) return;
  const rest = { ...map };
  delete rest[fileId];
  all[roomId] = rest;
  roomsStore.set('roomTombstoneProofs', all);
}

export function clearRoomTombstoneProofs(roomId: string): void {
  const all = roomsStore.get('roomTombstoneProofs') ?? {};
  delete all[roomId];
  roomsStore.set('roomTombstoneProofs', all);
}

// Verified revives (fileId → revAt). Persisted so the re-deletion guard (a revived
// file can't be re-deleted by an equal/older tombstone) survives restart. Only the
// engine's verified-revive sites write here; a stale entry can at worst block a
// deletion at-or-older than revAt, which is exactly what a revive is meant to do.

export function getRoomRevives(roomId: string): Record<string, number> {
  return (roomsStore.get('roomRevives') ?? {})[roomId] ?? {};
}

export function addRoomRevive(roomId: string, fileId: string, revAt: number): void {
  const all = roomsStore.get('roomRevives') ?? {};
  const map = { ...(all[roomId] ?? {}) };
  if (!(fileId in map) && Object.keys(map).length >= ROOM_FILE_LIMIT) return;
  map[fileId] = Math.max(revAt, map[fileId] ?? 0); // a newer revive always wins
  const entries = Object.entries(map);
  all[roomId] = Object.fromEntries(entries);
  roomsStore.set('roomRevives', all);
}

export function removeRoomRevive(roomId: string, fileId: string): void {
  const all = roomsStore.get('roomRevives') ?? {};
  const map = all[roomId];
  if (!map || !(fileId in map)) return;
  const rest = { ...map };
  delete rest[fileId];
  all[roomId] = rest;
  roomsStore.set('roomRevives', all);
}

export function clearRoomRevives(roomId: string): void {
  const all = roomsStore.get('roomRevives') ?? {};
  delete all[roomId];
  roomsStore.set('roomRevives', all);
}

// === Room manifest (known files — resume a room's file list/seeding on restart) ===

export function getRoomManifest(roomId: string): PersistedRoomFile[] {
  return (roomsStore.get('roomManifests') ?? {})[roomId] ?? [];
}

/** Add or update one file in a room's persisted manifest (keyed by fileId). */
export function upsertRoomManifestFile(roomId: string, file: PersistedRoomFile): void {
  upsertRoomManifestFiles(roomId, [file]);
}

/** A page is one store write. Existing entries stay intact when the room is full. */
export function upsertRoomManifestFiles(roomId: string, files: PersistedRoomFile[]): void {
  const all = roomsStore.get('roomManifests') ?? {};
  const entries = new Map((all[roomId] ?? []).map(f => [f.fileId, f]));
  for (const file of files) {
    if (!file?.fileId || !entries.has(file.fileId) && entries.size >= ROOM_FILE_LIMIT) continue;
    entries.set(file.fileId, file);
  }
  all[roomId] = [...entries.values()];
  roomsStore.set('roomManifests', all);
}

export function removeRoomManifestFile(roomId: string, fileId: string): void {
  const all = roomsStore.get('roomManifests') ?? {};
  if (!all[roomId]) return;
  all[roomId] = all[roomId].filter((f) => f.fileId !== fileId);
  roomsStore.set('roomManifests', all);
}

export function clearRoomManifest(roomId: string): void {
  const all = roomsStore.get('roomManifests') ?? {};
  delete all[roomId];
  roomsStore.set('roomManifests', all);
}

// === Room folders (sections — resume a room's folder set on restart) ===

export function getRoomFolders(roomId: string): PersistedRoomFolder[] {
  return (roomsStore.get('roomFolders') ?? {})[roomId] ?? [];
}

/** Add or update one folder in a room's persisted set (keyed by id). */
export function upsertRoomFolder(roomId: string, folder: PersistedRoomFolder): void {
  if (!folder?.id) return;
  const all = roomsStore.get('roomFolders') ?? {};
  const list = (all[roomId] ?? []).filter((f) => f.id !== folder.id);
  if (!(all[roomId] ?? []).some(f => f.id === folder.id) && list.length >= ROOM_FOLDER_LIMIT) return;
  list.push(folder);
  all[roomId] = list;
  roomsStore.set('roomFolders', all);
}

export function removeRoomFolder(roomId: string, folderId: string): void {
  const all = roomsStore.get('roomFolders') ?? {};
  if (!all[roomId]) return;
  all[roomId] = all[roomId].filter((f) => f.id !== folderId);
  roomsStore.set('roomFolders', all);
}

export function getRoomFolderTombstones(roomId: string): Record<string, number> {
  return (roomsStore.get('roomFolderTombstones') ?? {})[roomId] ?? {};
}

export function addRoomFolderTombstone(roomId: string, folderId: string, at: number = Date.now()): void {
  const all = roomsStore.get('roomFolderTombstones') ?? {};
  const map = { ...(all[roomId] ?? {}) };
  if (!(folderId in map) && Object.keys(map).length >= ROOM_FOLDER_TOMB_LIMIT) return;
  map[folderId] = Math.max(at, map[folderId] ?? 0); // a newer deletion always wins
  const entries = Object.entries(map);

  all[roomId] = Object.fromEntries(entries);
  roomsStore.set('roomFolderTombstones', all);
}

export function clearRoomFolders(roomId: string): void {
  for (const key of ['roomFolders', 'roomFolderTombstones'] as const) {
    const all = roomsStore.get(key) ?? {};
    delete (all as Record<string, unknown>)[roomId];
    roomsStore.set(key, all as never);
  }
}

// === Room activity history (locally-observed event log) ===

export function getRoomHistory(roomId: string): RoomEvent[] {
  return retainLocalHistory((roomsStore.get('roomHistory') ?? {})[roomId] ?? [], getRoomHistoryRetention(roomId), ev => ev.at);
}

export function appendRoomEvents(roomId: string, events: RoomEvent[]): void {
  if (!events.length) return;
  const all = roomsStore.get('roomHistory') ?? {};
  const list = retainLocalHistory((all[roomId] ?? []).concat(events), getRoomHistoryRetention(roomId), ev => ev.at).slice(-200);
  all[roomId] = list;
  const archive = roomsStore.get('roomEventArchive') ?? {};
  const byId = new Map((archive[roomId] ?? (all[roomId] ?? [])).concat(events).map(ev => [ev.id, ev]));
  roomsStore.set({ roomHistory: all, roomEventArchive: { ...archive, [roomId]: retainLocalHistory([...byId.values()], getRoomHistoryRetention(roomId), ev => ev.at) } });
}

export function clearRoomHistory(roomId: string): void {
  const all = roomsStore.get('roomHistory') ?? {};
  delete all[roomId];
  const archive = roomsStore.get('roomEventArchive') ?? {}; delete archive[roomId];
  roomsStore.set({ roomHistory: all, roomEventArchive: archive });
}

// === Room chat (gossiped messages, persisted locally + capped) ===
// Message text is encrypted at rest (safeStorage/DPAPI) so the on-disk log is
// not readable plaintext; metadata (id/at/sender) stays clear for indexing.

export function getRoomChats(roomId: string): RoomChatMessage[] {
  const list = (roomsStore.get('roomChats') ?? {})[roomId] ?? [];
  // `replyText` is a snapshot of the PARENT message's body — content, so it's
  // encrypted at rest like `text` (metadata id/at/sender/replyName stay clear).
  return retainRoomChat(retainLocalHistory(list, getRoomHistoryRetention(roomId), m => m.receivedAt ?? m.at).map((m) => ({ ...m, text: decryptSecret(m.text), ...(m.replyText ? { replyText: decryptSecret(m.replyText) } : {}) })));
}

/** Returns true if at least one message was new (not a re-delivery/backfill dup). */
export function appendRoomChats(roomId: string, messages: RoomChatMessage[]): boolean {
  if (!messages.length) return false;
  const all = roomsStore.get('roomChats') ?? {};
  const byId = new Map(getRoomChats(roomId).map(m => [m.id, m]));
  let isNew = false, changed = false;
  for (const message of messages) {
    if (!message.id) continue;
    const prior = byId.get(message.id) ?? archivedRoomChat(roomId, message.id);
    if (!prior) { byId.set(message.id, { ...message, receivedAt: Date.now() }); isNew = changed = true; }
    else {
      const upgrade = upgradeChat(prior, message);
      if (upgrade) { byId.set(message.id, upgrade); changed = true; }
    }
  }
  if (!changed) return false;
  all[roomId] = retainRoomChat([...byId.values()]).map(m => ({ ...m, text: encryptSecret(m.text, false), ...(m.replyText ? { replyText: encryptSecret(m.replyText, false) } : {}) }));
  roomsStore.set({ roomChats: all, roomChatArchive: archiveRoomChats(roomId, all[roomId]) });
  return isNew;
}

export function clearRoomChats(roomId: string): void {
  const all = roomsStore.get('roomChats') ?? {};
  const receipts = roomsStore.get('roomChatReceipts') ?? {}, drafts = roomsStore.get('roomChatDrafts') ?? {};
  delete all[roomId];
  delete receipts[roomId]; delete drafts[roomId];
  const archive = roomsStore.get('roomChatArchive') ?? {}, edits = roomsStore.get('roomArchiveEdits') ?? {}, retention = roomsStore.get('roomHistoryRetention') ?? {};
  delete archive[roomId]; delete edits[roomId]; delete retention[roomId];
  roomsStore.set({ roomChats: all, roomChatReceipts: receipts, roomChatDrafts: drafts, roomChatArchive: archive, roomArchiveEdits: edits, roomHistoryRetention: retention });
}

/** Commit message + retry receipt in ONE atomic store write, before gossip. */
export function commitRoomChat(roomId: string, message: RoomChatMessage): { duplicate: boolean; message?: RoomChatMessage } {
  const digest = (m: RoomChatMessage) => crypto.createHash('sha256').update(JSON.stringify([m.id, m.memberId, m.text, m.replyTo || ''])).digest('hex');
  const fingerprint = digest(message);
  const chats = roomsStore.get('roomChats') ?? {}, receipts = roomsStore.get('roomChatReceipts') ?? {};
  const receipt = receipts[roomId]?.find(r => r.id === message.id);
  const existing = getRoomChats(roomId).find(m => m.id === message.id) ?? (!receipt ? archivedRoomChat(roomId, message.id) : undefined);
  if (receipt || existing) {
    if ((receipt ? decryptSecret(receipt.digest) : digest(existing!)) !== fingerprint) throw new Error('Message ID already belongs to different content');
    return { duplicate: true, message: existing };
  }
  const saved = { ...message, receivedAt: Date.now() };
  const encoded = { ...saved, text: encryptSecret(message.text, false), ...(message.replyText ? { replyText: encryptSecret(message.replyText, false) } : {}) };
  roomsStore.set({
    roomChats: { ...chats, [roomId]: [...(chats[roomId] ?? []), encoded].slice(-ROOM_CHAT_LIMIT) },
    roomChatArchive: archiveRoomChats(roomId, [...(chats[roomId] ?? []), encoded]),
    roomChatReceipts: { ...receipts, [roomId]: [...(receipts[roomId] ?? []), { id: message.id, digest: encryptSecret(fingerprint) }].slice(-1000) },
  });
  return { duplicate: false, message: saved };
}

export function getRoomChatDraft(roomId: string): RoomChatDraft {
  const encoded = (roomsStore.get('roomChatDrafts') ?? {})[roomId];
  return encoded ? normalizeRoomChatDraft(JSON.parse(decryptSecret(encoded))) : { text: '' };
}
export function setRoomChatDraft(roomId: string, draft: RoomChatDraft): void {
  const drafts = roomsStore.get('roomChatDrafts') ?? {}, clean = normalizeRoomChatDraft(draft);
  if (!clean.text && !clean.reply && !clean.editId && !clean.compose) delete drafts[roomId];
  else drafts[roomId] = encryptSecret(JSON.stringify(clean));
  roomsStore.set('roomChatDrafts', drafts);
}

// The local archive is independent from the 200-message wire/rejoin window.
export function getRoomHistoryRetention(roomId: string): RoomHistoryDays {
  const saved = (roomsStore.get('roomHistoryRetention') ?? {})[roomId];
  // Existing installations had no expiry. Do not destroy their history on upgrade.
  return saved ?? ((roomsStore.get('rooms') ?? {})[roomId] ? 0 : 30);
}
function archivedRoomChat(roomId: string, id: string): RoomChatMessage | undefined {
  const value = ((roomsStore.get('roomChatArchive') ?? {})[roomId] ?? []).find(m => m.id === id);
  return value ? { ...value, text: decryptSecret(value.text), ...(value.replyText ? { replyText: decryptSecret(value.replyText) } : {}) } : undefined;
}
function archiveRoomChats(roomId: string, encoded: RoomChatMessage[]): Record<string, RoomChatMessage[]> {
  const archive = roomsStore.get('roomChatArchive') ?? {};
  const entries = new Map((archive[roomId] ?? []).map(m => [m.id, m]));
  for (const m of encoded) entries.set(m.id, m);
  return { ...archive, [roomId]: retainLocalHistory([...entries.values()], getRoomHistoryRetention(roomId), m => m.receivedAt ?? m.at) };
}
export function setRoomHistoryRetention(roomId: string, value: unknown): RoomHistoryDays {
  const days = historyDays(value), chats = roomsStore.get('roomChatArchive') ?? {}, events = roomsStore.get('roomEventArchive') ?? {};
  const chat = retainLocalHistory(chats[roomId] ?? (roomsStore.get('roomChats') ?? {})[roomId] ?? [], days, m => m.receivedAt ?? m.at);
  const activity = retainLocalHistory(events[roomId] ?? getRoomHistory(roomId), days, ev => ev.at);
  const overlays = roomsStore.get('roomArchiveEdits') ?? {}, ids = new Set(chat.map(m => m.id));
  roomsStore.set({ roomHistoryRetention: { ...(roomsStore.get('roomHistoryRetention') ?? {}), [roomId]: days },
    roomChatArchive: { ...chats, [roomId]: chat }, roomEventArchive: { ...events, [roomId]: activity },
    roomChats: { ...(roomsStore.get('roomChats') ?? {}), [roomId]: chat.slice(-ROOM_CHAT_LIMIT) },
    roomHistory: { ...(roomsStore.get('roomHistory') ?? {}), [roomId]: activity.slice(-200) },
    roomChatEdits: { ...(roomsStore.get('roomChatEdits') ?? {}), [roomId]: Object.fromEntries(Object.entries((roomsStore.get('roomChatEdits') ?? {})[roomId] ?? {}).filter(([id])=>ids.has(id))) },
    roomArchiveEdits: { ...overlays, [roomId]: Object.fromEntries(Object.entries(overlays[roomId] ?? {}).filter(([id])=>ids.has(id))) } });
  return days;
}
/** Remove expired ciphertext too, even when a room receives no new messages. One atomic write. */
export function pruneRoomLocalHistory(): string[] {
  const keys = ['roomChats', 'roomChatArchive', 'roomHistory', 'roomEventArchive', 'roomChatEdits', 'roomArchiveEdits'] as const;
  const patch: Partial<RoomsSchema> = Object.fromEntries(keys.map(key => [key, roomsStore.get(key) ?? {}]));
  const ids = new Set<string>(keys.flatMap(key => Object.keys(patch[key] ?? {}))), changed: string[] = [];
  for (const roomId of ids) {
    const days = getRoomHistoryRetention(roomId); let modified = false;
    for (const key of ['roomChats', 'roomChatArchive'] as const) {
      const all = patch[key]!, old = all[roomId] ?? [], next = retainLocalHistory(old, days, m => m.receivedAt ?? m.at);
      if (old.length !== next.length) { all[roomId] = next; modified = true; }
    }
    for (const key of ['roomHistory', 'roomEventArchive'] as const) {
      const all = patch[key]!, old = all[roomId] ?? [], next = retainLocalHistory(old, days, ev => ev.at);
      if (old.length !== next.length) { all[roomId] = next; modified = true; }
    }
    const messages = new Set([...(patch.roomChats?.[roomId] ?? []), ...(patch.roomChatArchive?.[roomId] ?? [])].map(m => m.id));
    for (const key of ['roomChatEdits', 'roomArchiveEdits'] as const) {
      const all = patch[key]!, old = all[roomId] ?? {}, next = Object.fromEntries(Object.entries(old).filter(([id])=>messages.has(id)));
      if (Object.keys(next).length !== Object.keys(old).length) { all[roomId] = next; modified = true; }
    }
    if (modified) changed.push(roomId);
  }
  if (changed.length) roomsStore.set(patch);
  return changed;
}
export function getRoomLocalHistoryPage(roomId: string, kind: unknown, before?: string): RoomHistoryPage {
  if (kind !== 'chat' && kind !== 'event') throw new Error('Invalid room history kind');
  const retentionDays = getRoomHistoryRetention(roomId);
  if (kind === 'event') {
    const events = retainLocalHistory((roomsStore.get('roomEventArchive') ?? {})[roomId] ?? getRoomHistory(roomId), retentionDays, ev => ev.at);
    const page = localHistoryPage(events, before);
    return { ...page, retentionDays, items: page.items.map(event => ({ kind: 'event', event })) };
  }
  const list = retainLocalHistory((roomsStore.get('roomChatArchive') ?? {})[roomId] ?? (roomsStore.get('roomChats') ?? {})[roomId] ?? [], retentionDays, m => m.receivedAt ?? m.at);
  const page = localHistoryPage(list, before), edits = (roomsStore.get('roomArchiveEdits') ?? {})[roomId] ?? {};
  return { ...page, retentionDays, items: page.items.map(m => ({ kind: 'chat', message: { ...m, text: decryptSecret(edits[m.id]?.text ?? m.text), ...(m.replyText ? { replyText: decryptSecret(m.replyText) } : {}) } })) };
}

// === Room unread (last time the user viewed a room; chat after it is unread) ===

export function getRoomLastRead(roomId: string): number {
  return (roomsStore.get('roomLastRead') ?? {})[roomId] ?? 0;
}

export function setRoomLastRead(roomId: string, at: number = Date.now()): void {
  const all = roomsStore.get('roomLastRead') ?? {};
  all[roomId] = Math.max(at, all[roomId] ?? 0);
  roomsStore.set('roomLastRead', all);
}

export function clearRoomLastRead(roomId: string): void {
  const all = roomsStore.get('roomLastRead') ?? {};
  delete all[roomId];
  roomsStore.set('roomLastRead', all);
}

// === Room file reactions (gossiped emoji toggles, persisted locally + capped) ===

const MAX_REACT_FILES = 200; // per room — matches the engine's hello-summary cap

export function getRoomReacts(roomId: string): Record<string, Record<string, string[]>> {
  return (roomsStore.get('roomReacts') ?? {})[roomId] ?? {};
}

/** Replace a room's reaction map (toggles don't append well, so it's set-style). */
export function setRoomReacts(roomId: string, reacts: Record<string, Record<string, string[]>>): void {
  const all = roomsStore.get('roomReacts') ?? {};
  const capped: Record<string, Record<string, string[]>> = {};
  for (const [fileId, byEmoji] of Object.entries(reacts ?? {}).slice(0, MAX_REACT_FILES)) capped[fileId] = byEmoji;
  all[roomId] = capped;
  roomsStore.set('roomReacts', all);
}

export function getRoomChatReacts(roomId: string): Record<string, Record<string, string[]>> {
  return (roomsStore.get('roomChatReacts') ?? {})[roomId] ?? {};
}

/** Replace a room's chat-reaction map (same set-style rule as file reacts). */
export function setRoomChatReacts(roomId: string, reacts: Record<string, Record<string, string[]>>): void {
  const all = roomsStore.get('roomChatReacts') ?? {};
  const capped: Record<string, Record<string, string[]>> = {};
  for (const [msgId, byEmoji] of Object.entries(reacts ?? {}).slice(0, MAX_REACT_FILES)) capped[msgId] = byEmoji;
  all[roomId] = capped;
  roomsStore.set('roomChatReacts', all);
}

export function clearRoomReacts(roomId: string): void {
  const all = roomsStore.get('roomReacts') ?? {};
  delete all[roomId];
  roomsStore.set('roomReacts', all);
}

export function clearRoomChatReacts(roomId: string): void {
  const all = roomsStore.get('roomChatReacts') ?? {};
  delete all[roomId];
  roomsStore.set('roomChatReacts', all);
}

// === Room chat edits (author-signed message edits, overlay on the chat log) ===
// Edited text is encrypted at rest like the chat log itself; the signature +
// author id stay clear so a peer's HELLO edit can re-verify against the author.

export function getRoomChatEdits(roomId: string): Record<string, { text: string; at: number; by: string; pub: string; sig: string }> {
  const rec = (roomsStore.get('roomChatEdits') ?? {})[roomId] ?? {};
  const out: Record<string, { text: string; at: number; by: string; pub: string; sig: string }> = {};
  for (const [msgId, e] of Object.entries(rec)) out[msgId] = { ...e, text: decryptSecret(e.text) };
  return out;
}

/** Replace a room's chat-edit overlay (set-style, like reactions; text encrypted). */
export function setRoomChatEdits(roomId: string, edits: Record<string, { text: string; at: number; by: string; pub: string; sig: string }>): void {
  const all = roomsStore.get('roomChatEdits') ?? {};
  const capped: Record<string, { text: string; at: number; by: string; pub: string; sig: string }> = {};
  for (const [msgId, e] of Object.entries(edits ?? {}).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_REACT_FILES)) capped[msgId] = { ...e, text: encryptSecret(e.text, false) };
  all[roomId] = capped;
  const archive = roomsStore.get('roomArchiveEdits') ?? {};
  const ids = new Set(((roomsStore.get('roomChatArchive') ?? {})[roomId] ?? []).map(m => m.id));
  const retained = { ...archive[roomId], ...capped };
  for (const id of Object.keys(retained)) if (!ids.has(id)) delete retained[id];
  roomsStore.set({ roomChatEdits: all, roomArchiveEdits: { ...archive, [roomId]: retained } });
}

export function clearRoomChatEdits(roomId: string): void {
  const all = roomsStore.get('roomChatEdits') ?? {};
  delete all[roomId];
  roomsStore.set('roomChatEdits', all);
}

// === Room identity (Ed25519 signing keypair + per-room TOFU pubkey roster) ===

/**
 * This install's long-term Ed25519 signing keypair, lazily created. The private
 * key is encrypted at rest (safeStorage). Returned with the private key in PEM
 * so the room engine can sign chat messages; the public key proves authorship to
 * peers. NOT exposed to the renderer.
 */
export function getRoomIdentity(): { pub: string; priv: string } {
  let id = roomsStore.get('roomIdentity');
  if (!id || !id.pub || !id.priv) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    id = { pub, priv: encryptSecret(priv) };
    roomsStore.set('roomIdentity', id);
  }
  return { pub: id.pub, priv: decryptSecret(id.priv) };
}

/**
 * Portable backup of everything that makes this install "you" in rooms:
 * the Ed25519 signing keypair, the room profile, and the joined-rooms list.
 * The private key is DECRYPTED here — the bundle leaves the machine, so the
 * This is an INTERNAL in-memory bundle; IPC must encrypt it before writing.
 */
export interface RoomIdentityBundle {
  version: 1;
  exportedAt: string;
  profile: RoomProfile;
  identity: { pub: string; priv: string }; // priv in plaintext PEM (see above)
  rooms: PersistedRoom[];
  recovery?: Record<string, RoomRecoveryRecord>;
}
interface RoomRecoveryRecord {
  manifest: PersistedRoomFile[];
  folders: PersistedRoomFolder[];
  tombstones: Record<string, number>;
  tombstoneProofs: Record<string, { by: string; pub: string; sig: string }>;
  revives: Record<string, number>;
  folderTombstones: Record<string, number>;
  identities: Record<string, string>;
}

export function exportRoomIdentityBundle(): RoomIdentityBundle {
  const rooms = getPersistedRooms();
  if (rooms.some(room => room.storageError)) throw new Error('Cannot export locked room secrets; restore system storage access and retry');
  const identity = getRoomIdentity();
  if (!identity.priv) throw new Error('Cannot unlock the room identity for export');
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: getRoomProfile(),
    identity, // internal only — sealed by the password backup before file export
    rooms,
  };
}

function portableRoomFile(file: PersistedRoomFile): PersistedRoomFile {
  const copy = { ...file };
  for (const key of ['localPath', 'cipherPath', 'localOriginal', 'partialDownload', 'torrentFile', 'localError'] as const) delete copy[key];
  return { ...copy, receivePaused: true };
}
/** Portable recovery never contains paths, executables, or local file privileges. */
export function exportRoomRecoveryBundle(roomId?: string): RoomIdentityBundle {
  const bundle = exportRoomIdentityBundle();
  if (roomId !== undefined) {
    bundle.rooms = bundle.rooms.filter(room => room.roomId === roomId);
    if (!bundle.rooms.length) throw new Error('Room not found');
  }
  bundle.rooms = bundle.rooms.map(room => ({ ...room, folder: '', autoFetch: false }));
  bundle.recovery = Object.fromEntries(bundle.rooms.map(room => [room.roomId, {
    manifest: getRoomManifest(room.roomId).map(file => {
      return portableRoomFile(file);
    }),
    folders: getRoomFolders(room.roomId), tombstones: getRoomTombstones(room.roomId), tombstoneProofs: getRoomTombstoneProofs(room.roomId),
    revives: getRoomRevives(room.roomId), folderTombstones: getRoomFolderTombstones(room.roomId), identities: getRoomIdentities(room.roomId),
  }]));
  return bundle;
}
/** Public import: bounded schema, empty joined-room list, and fresh local folders. */
export function importRoomRecoveryBundle(input: unknown, base: string): { rooms: number } {
  if (getPersistedRooms().length) throw new Error('Restore into a profile with no joined rooms. Leave the current rooms first or use a fresh profile.');
  const b = structuredClone(input) as RoomIdentityBundle;
  if (!b || b.version !== 1 || !Array.isArray(b.rooms) || b.rooms.length > 100 || !b.recovery || typeof b.recovery !== 'object' || Array.isArray(b.recovery)) throw new Error('Invalid room recovery bundle');
  const seen = new Set<string>();
  const check = (value: unknown, depth = 0): void => {
    if (depth > 20) throw new Error('Room backup nesting is too deep');
    if (typeof value === 'string' && value.length > 2 * 1024 * 1024) throw new Error('Room backup field is too large');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid backup number');
    if (value && typeof value === 'object') {
      if (Object.keys(value).length > 5000) throw new Error('Room backup record is too large');
      for (const [key, item] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid backup field');
        check(item, depth + 1);
      }
    }
  };
  check(b);
  if (typeof b.identity?.pub !== 'string' || typeof b.identity?.priv !== 'string'
    || crypto.createPrivateKey(b.identity.priv).asymmetricKeyType !== 'ed25519'
    || crypto.createPublicKey(b.identity.pub).asymmetricKeyType !== 'ed25519') throw new Error('Invalid room signing key type');
  if (b.profile?.memberId !== deriveMemberId(b.identity.pub)) throw new Error('Room backup profile does not match its signing key');
  const rooms = b.rooms.map(room => {
    if (!room || !/^[a-f0-9-]{36}$/i.test(room.roomId) || seen.has(room.roomId) || typeof room.name !== 'string' || room.name.length > 200
      || typeof room.code !== 'string' || room.code.length > 256 || typeof room.createdAt !== 'number' || !Number.isSafeInteger(room.createdAt) || room.createdAt < 0) throw new Error('Invalid room backup record');
    seen.add(room.roomId);
    const data = b.recovery![room.roomId];
    if (!data || !Array.isArray(data.manifest) || data.manifest.length > ROOM_FILE_LIMIT || !Array.isArray(data.folders) || data.folders.length > ROOM_FOLDER_LIMIT) throw new Error('Invalid room recovery manifest');
    for (const field of ['tombstones', 'tombstoneProofs', 'revives', 'folderTombstones', 'identities'] as const) {
      if (!data[field] || typeof data[field] !== 'object' || Array.isArray(data[field])) throw new Error('Invalid recovery proof map');
    }
    for (const field of ['tombstones', 'revives', 'folderTombstones'] as const) {
      for (const [id, time] of Object.entries(data[field])) if (id.length > 128 || !Number.isSafeInteger(time) || time < 0) throw new Error('Invalid recovery clock');
    }
    for (const [id, pub] of Object.entries(data.identities)) if (id.length > 128 || typeof pub !== 'string' || pub.length > 2048) throw new Error('Invalid recovery identity');
    for (const [id, proof] of Object.entries(data.tombstoneProofs)) if (id.length > 128 || !proof || typeof proof.by !== 'string' || typeof proof.pub !== 'string' || proof.pub.length > 2048 || typeof proof.sig !== 'string' || proof.sig.length > 1024) throw new Error('Invalid recovery deletion proof');
    for (const folder of data.folders) if (!folder || typeof folder.id !== 'string' || folder.id.length > 128 || typeof folder.name !== 'string' || folder.name.length > 200) throw new Error('Invalid recovery folder');
    if (room.transferChain !== undefined && (!Array.isArray(room.transferChain) || room.transferChain.length > 5000)) throw new Error('Invalid recovery ownership chain');
    // The engine re-verifies signed records on rejoin. Imported local privilege flags are always discarded.
    data.manifest = data.manifest.map(file => {
      if (!file || typeof file.fileId !== 'string' || file.fileId.length > 128 || typeof file.infoHash !== 'string' || !/^[a-f0-9]{40}$/i.test(file.infoHash) || typeof file.name !== 'string' || file.name.length > 240 || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid backup file');
      return portableRoomFile(file);
    });
    return { ...room, storageError: undefined, folder: path.join(base, room.roomId), autoFetch: false };
  });
  if (Object.keys(b.recovery).some(id => !seen.has(id))) throw new Error('Unknown room recovery record');
  return importRoomIdentityBundle({ ...b, rooms });
}

/** Loose PEM shape check — enough to reject non-key garbage early. */
function looksLikePem(s: unknown, label: string): s is string {
  return typeof s === 'string' && s.includes(`-----BEGIN ${label}-----`) && s.includes(`-----END ${label}-----`);
}

/**
 * Restore a bundle produced by exportRoomIdentityBundle(). Overwrites the
 * identity keypair (re-encrypting the private key at rest, mirroring
 * getRoomIdentity) and the profile; MERGES rooms by roomId with imported
 * entries winning. Rooms rejoin on next launch — no live rejoin here.
 */
export function importRoomIdentityBundle(bundle: unknown): { rooms: number } {
  const b = bundle as Partial<RoomIdentityBundle> | null;
  if (!b || typeof b !== 'object' || b.version !== 1) {
    throw new Error('Invalid room identity file format');
  }
  const id = b.identity;
  if (!id || !looksLikePem(id.pub, 'PUBLIC KEY') || !looksLikePem(id.priv, 'PRIVATE KEY')) {
    throw new Error('Room identity file has no valid keypair');
  }
  const profile = b.profile;
  if (!profile || typeof profile.memberId !== 'string' || !profile.memberId) {
    throw new Error('Room identity file has no valid profile');
  }

  // The memberId is ALWAYS the hash of the imported signing key (the same anchor
  // getRoomProfile/migration enforce) — never the value stored in the bundle,
  // which an old export may carry in the pre-derivation UUID form. Re-own the
  // bundle's rooms under the derived id so imported ownership survives the switch.
  const memberId = deriveMemberId(id.pub);
  const pub = crypto.createPublicKey(id.priv).export({ type: 'spki', format: 'pem' }).toString();
  if (pub !== crypto.createPublicKey(id.pub).export({ type: 'spki', format: 'pem' }).toString()) throw new Error('Room identity keys do not match');
  const identity = { pub: id.pub, priv: encryptSecret(id.priv) };
  const nextProfile = {
    memberId,
    name: typeof profile.name === 'string' ? profile.name : '',
    avatarSeed: typeof profile.avatarSeed === 'string' && profile.avatarSeed ? profile.avatarSeed : memberId,
    color: sanitizeProfileColor((profile as RoomProfile).color) ?? '',
    status: sanitizeProfileStatus((profile as RoomProfile).status),
    avatarImg: sanitizeProfileImg((profile as RoomProfile).avatarImg) ?? '',
  };
  const existing = roomsStore.get('rooms') ?? {};
  // Prepare every protected record before writing any identity/profile change.
  for (const [roomId, room] of Object.entries(existing)) if (!room.secrets) existing[roomId] = sealRoom(openRoom(room));
  let count = 0;
  for (const raw of Array.isArray(b.rooms) ? b.rooms : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.roomId !== 'string' || !raw.roomId || typeof raw.code !== 'string' || !raw.code) continue;
    const room = structuredClone(raw);
    if (room.ownerId === profile.memberId) room.ownerId = memberId;
    if (room.ownerPin === profile.memberId) room.ownerPin = memberId;
    existing[room.roomId] = sealRoom(room);
    count++;
  }
  const patch: Partial<RoomsSchema> = { roomIdentity: identity, roomProfile: nextProfile, rooms: existing };
  if (b.recovery) {
    patch.roomHistoryRetention = { ...(roomsStore.get('roomHistoryRetention') ?? {}), ...Object.fromEntries((b.rooms ?? []).map(room => [room.roomId, 30 as const])) };
    const mapping = { manifest: 'roomManifests', folders: 'roomFolders', tombstones: 'roomTombstones', tombstoneProofs: 'roomTombstoneProofs', revives: 'roomRevives', folderTombstones: 'roomFolderTombstones', identities: 'roomIdentities' } as const;
    for (const [field, key] of Object.entries(mapping)) {
      const all = { ...(roomsStore.get(key) ?? {}) };
      for (const [roomId, record] of Object.entries(b.recovery)) all[roomId] = structuredClone(record[field as keyof RoomRecoveryRecord]) as never;
      Object.assign(patch, { [key]: all });
    }
  }
  roomsStore.set(patch);
  return { rooms: count };
}

/** Known (TOFU-bound) memberId → public key map for a room. */
export function getRoomIdentities(roomId: string): Record<string, string> {
  return (roomsStore.get('roomIdentities') ?? {})[roomId] ?? {};
}

/** Bind a memberId to a public key the first time we see it (trust on first use). */
export function addRoomIdentity(roomId: string, memberId: string, pub: string): void {
  if (!memberId || !pub) return;
  const all = roomsStore.get('roomIdentities') ?? {};
  const roomMap = all[roomId] ?? {};
  if (roomMap[memberId] === pub) return;
  roomMap[memberId] = pub;
  all[roomId] = roomMap;
  roomsStore.set('roomIdentities', all);
}

export function clearRoomIdentities(roomId: string): void {
  const all = roomsStore.get('roomIdentities') ?? {};
  delete all[roomId];
  roomsStore.set('roomIdentities', all);
}

// === Room mutes (locally-hidden members — per install, never broadcast) ===

export function getRoomMutes(roomId: string): string[] {
  return (roomsStore.get('roomMutes') ?? {})[roomId] ?? [];
}

export function setRoomMute(roomId: string, memberId: string, muted: boolean): void {
  const all = roomsStore.get('roomMutes') ?? {};
  const set = new Set(all[roomId] ?? []);
  if (muted) set.add(memberId); else set.delete(memberId);
  all[roomId] = Array.from(set);
  roomsStore.set('roomMutes', all);
}

export function clearRoomMutes(roomId: string): void {
  const all = roomsStore.get('roomMutes') ?? {};
  delete all[roomId];
  roomsStore.set('roomMutes', all);
}

// === Remembered virtual-LAN setup (per install, never broadcast) ===
// roomId → the players the host last admitted + the game .exes that were granted
// a scoped firewall rule. Read on every LAN start, so it is normalised on the way
// OUT: this file is user-editable and a previous version may have written another
// shape. It is a convenience, not an authority — see shared/lan-prefs.ts.

export function getRoomLanPrefs(roomId: string): LanRoomPrefs {
  return normalizeLanPrefs((roomsStore.get('roomLan') ?? {})[roomId]);
}

/** Persist a value the caller derived from getRoomLanPrefs via the pure helpers.
 *  Normalised again on the way IN so a bug upstream cannot grow the entry past
 *  its caps. An empty value deletes the key rather than storing `{[],[]}`. */
export function setRoomLanPrefs(roomId: string, prefs: LanRoomPrefs): void {
  const all = roomsStore.get('roomLan') ?? {};
  const next = normalizeLanPrefs(prefs);
  if (next === EMPTY_LAN_PREFS) delete all[roomId];
  else all[roomId] = next;
  roomsStore.set('roomLan', all);
}

export function clearRoomLanPrefs(roomId: string): void {
  const all = roomsStore.get('roomLan') ?? {};
  delete all[roomId];
  roomsStore.set('roomLan', all);
}

// === Per-folder auto-fetch overrides (per install, never broadcast) ===
// folderId → forced on/off; a folder with no entry inherits the room's autoFetch.

export function getRoomFolderFetch(roomId: string): Record<string, boolean> {
  return (roomsStore.get('roomFolderFetch') ?? {})[roomId] ?? {};
}

/** mode === null clears the override (folder inherits the room toggle again). */
export function setRoomFolderFetch(roomId: string, folderId: string, mode: boolean | null): void {
  const all = roomsStore.get('roomFolderFetch') ?? {};
  const map = { ...(all[roomId] ?? {}) };
  if (mode === null) delete map[folderId]; else map[folderId] = mode;
  all[roomId] = map;
  roomsStore.set('roomFolderFetch', all);
}

export function clearRoomFolderFetch(roomId: string): void {
  const all = roomsStore.get('roomFolderFetch') ?? {};
  delete all[roomId];
  roomsStore.set('roomFolderFetch', all);
}

// === Web remote token (lazily generated, persisted) ===

export async function getOrCreateWebRemoteToken(): Promise<string> {
  const s = configStore.get('settings');
  if (s.webRemoteToken && s.webRemoteToken.length >= 32) return s.webRemoteToken;
  const token = crypto.randomBytes(24).toString('hex');
  configStore.set('settings', { ...s, webRemoteToken: token });
  return token;
}

export async function regenerateWebRemoteToken(): Promise<string> {
  const s = configStore.get('settings');
  const token = crypto.randomBytes(24).toString('hex');
  configStore.set('settings', { ...s, webRemoteToken: token });
  return token;
}

// === UI language (mirrored from the renderer for main-process i18n) ===

export function getUiLanguage(): 'en' | 'ru' {
  return configStore.get('uiLanguage') === 'ru' ? 'ru' : 'en';
}

export function setUiLanguage(lang: 'en' | 'ru'): void {
  configStore.set('uiLanguage', lang === 'ru' ? 'ru' : 'en');
}

// === Startup VPN warning ("Don't show again") ===

export function getVpnWarningDismissed(): boolean {
  return !!configStore.get('vpnWarningDismissed');
}

export function setVpnWarningDismissed(): void {
  configStore.set('vpnWarningDismissed', true);
}

// === Window bounds ===

export function getWindowBounds(): WindowBounds | null {
  return configStore.get('windowBounds') ?? null;
}

export function saveWindowBounds(bounds: WindowBounds): void {
  configStore.set('windowBounds', bounds);
}

/** Saved bounds of a pop-out window (chat / voice settings / theme editor). */
export function getPopoutBounds(frameName: string): WindowBounds | null {
  const all = configStore.get('popoutBounds') ?? null;
  return all?.[frameName] ?? null;
}

export function savePopoutBounds(frameName: string, bounds: WindowBounds): void {
  const all = configStore.get('popoutBounds') ?? {};
  configStore.set('popoutBounds', { ...all, [frameName]: bounds });
}


// === Downloads ===

export async function createDownload(data: {
  name: string;
  sourceType: SourceType;
  sourceUri: string;
  torrentFilePath?: string;
  savePath: string;
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'seeding' | 'error' | 'removed';
  selectedFiles?: number[];
  seedPaths?: string[];
  category?: string | null;
}): Promise<Download> {
  const id = uuidv4();
  const now = new Date();

  const download: Download = {
    id,
    name: data.name,
    sourceType: data.sourceType,
    sourceUri: data.sourceUri,
    torrentFilePath: data.torrentFilePath || null,
    savePath: data.savePath,
    status: data.status,
    progress: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    totalSize: 0,
    downSpeedBps: 0,
    upSpeedBps: 0,
    etaSeconds: null,
    peers: 0,
    seeds: 0,
    priority: 0,
    category: data.category ?? null,
    selectedFiles: data.selectedFiles,
    seedPaths: data.seedPaths,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };

  const downloads = downloadsStore.get('downloads');
  downloads[id] = download;
  downloadsStore.set('downloads', downloads);

  return download;
}

export async function getAllDownloads(): Promise<Download[]> {
  const downloads = downloadsStore.get('downloads');
  return Object.values(downloads);
}

export async function getDownloadById(id: string): Promise<Download | null> {
  const downloads = downloadsStore.get('downloads');
  return downloads[id] || null;
}

export async function getDownloadsByStatus(status: Download['status']): Promise<Download[]> {
  const downloads = downloadsStore.get('downloads');
  return Object.values(downloads).filter(d => d.status === status);
}

export async function updateDownloadStatus(
  id: string,
  status: Download['status'],
  lastError: string | null = null
): Promise<void> {
  const downloads = downloadsStore.get('downloads');
  const download = downloads[id];

  if (!download) {
    throw new Error(`Download not found: ${id}`);
  }

  download.status = status;
  download.lastError = lastError;
  download.updatedAt = new Date();

  downloads[id] = download;
  downloadsStore.set('downloads', downloads);
  if (status === 'removed') searchDownloadHistory.remember(download, [], true);
}

export async function updateDownloadProgress(
  id: string,
  data: {
    progress: number;
    downloadedBytes: number;
    uploadedBytes: number;
    downSpeedBps: number;
    upSpeedBps: number;
    etaSeconds: number | null;
    peers: number;
    seeds: number;
    name?: string;
    totalSize?: number;
  }
): Promise<void> {
  const downloads = downloadsStore.get('downloads');
  const download = downloads[id];

  if (!download) {
    throw new Error(`Download not found: ${id}`);
  }

  download.progress = data.progress;
  download.downloadedBytes = data.downloadedBytes;
  download.uploadedBytes = data.uploadedBytes;
  download.downSpeedBps = data.downSpeedBps;
  download.upSpeedBps = data.upSpeedBps;
  download.etaSeconds = data.etaSeconds;
  download.peers = data.peers;
  download.seeds = data.seeds;
  download.updatedAt = new Date();

  if (data.name) {
    download.name = data.name;
  }
  if (data.totalSize !== undefined && data.totalSize > 0) {
    download.totalSize = data.totalSize;
  }

  downloads[id] = download;
  downloadsStore.set('downloads', downloads);
}

export interface DownloadProgressUpdate {
  id: string;
  progress: number;
  downloadedBytes: number;
  uploadedBytes: number;
  downSpeedBps: number;
  upSpeedBps: number;
  etaSeconds: number | null;
  peers: number;
  seeds: number;
  name?: string;
  totalSize?: number;
}

/**
 * Persist progress for many downloads with a SINGLE disk write.
 *
 * The stats loop runs several times per second; calling updateDownloadProgress()
 * per download would serialize the entire store to disk N times per tick. This
 * batches all updates into one store.set() so the file is written only once.
 * Unknown ids are skipped silently (a torrent may have been removed mid-tick).
 */
export async function updateDownloadsProgressBatch(
  updates: DownloadProgressUpdate[]
): Promise<void> {
  if (updates.length === 0) return;

  const downloads = downloadsStore.get('downloads');
  let changed = false;

  for (const data of updates) {
    const download = downloads[data.id];
    if (!download) continue;

    // Speeds/eta/peers/seeds are TRANSIENT — 0 on load and re-derived live from
    // the stats broadcast — so keep them in the in-memory copy but never let them
    // trigger a disk write. Otherwise the whole downloads store was rewritten
    // every 5s forever (even at total idle: idle seeders, all speeds 0), churning
    // the SSD and waking a laptop for nothing.
    download.downSpeedBps = data.downSpeedBps;
    download.upSpeedBps = data.upSpeedBps;
    download.etaSeconds = data.etaSeconds;
    download.peers = data.peers;
    download.seeds = data.seeds;

    // Only a DURABLE change (progress/bytes/name/size) justifies persisting.
    const durableChanged =
      download.progress !== data.progress ||
      download.downloadedBytes !== data.downloadedBytes ||
      download.uploadedBytes !== data.uploadedBytes ||
      (!!data.name && download.name !== data.name) ||
      (data.totalSize !== undefined && data.totalSize > 0 && download.totalSize !== data.totalSize);
    if (!durableChanged) continue;

    download.progress = data.progress;
    download.downloadedBytes = data.downloadedBytes;
    download.uploadedBytes = data.uploadedBytes;
    download.updatedAt = new Date();
    if (data.name) download.name = data.name;
    if (data.totalSize !== undefined && data.totalSize > 0) {
      download.totalSize = data.totalSize;
    }

    downloads[data.id] = download;
    changed = true;
  }

  if (changed) downloadsStore.set('downloads', downloads);
}

export async function markDownloadRemoved(id: string): Promise<void> {
  return updateDownloadStatus(id, 'removed');
}

export async function deleteDownload(id: string, rememberRemoval = false): Promise<void> {
  const downloads = downloadsStore.get('downloads');
  // Explicit removal only: rollback of a failed add and boot tombstone cleanup
  // must not create history or bring back history the user cleared.
  if (rememberRemoval && downloads[id]) searchDownloadHistory.remember(downloads[id], [], true);
  delete downloads[id];
  downloadsStore.set('downloads', downloads);
}

/**
 * Generic field updater for a single download field.
 * Used by Priority 1 features (sequential, speed limits, etc.)
 */
export async function updateDownloadField<K extends keyof Download>(
  id: string,
  field: K,
  value: Download[K]
): Promise<void> {
  const downloads = downloadsStore.get('downloads');
  const download = downloads[id];
  if (!download) throw new Error(`Download not found: ${id}`);
  (download as any)[field] = value;
  download.updatedAt = new Date();
  downloads[id] = download;
  downloadsStore.set('downloads', downloads);
}

/**
 * Bulk-update multiple fields on one download.
 */
export async function updateDownloadFields(
  id: string,
  fields: Partial<Download>
): Promise<void> {
  const downloads = downloadsStore.get('downloads');
  const download = downloads[id];
  if (!download) throw new Error(`Download not found: ${id}`);
  Object.assign(download, fields);
  download.updatedAt = new Date();
  downloads[id] = download;
  downloadsStore.set('downloads', downloads);
}


// === Settings ===

export async function getSettings(): Promise<AppSettings> {
  const s = configStore.get('settings');
  // Decrypt secrets transparently so callers always see plaintext
  return { ...s, proxyPassword: decryptSecret(s.proxyPassword), customTurnCredential: decryptSecret(s.customTurnCredential) };
}

/**
 * Which download engine the torrent host should run. SYNCHRONOUS — read on the
 * main-process spawn path (host env), before any async settings round-trip is
 * possible. HAVVN_ENGINE overrides for dev/testing.
 */
export function getEngineChoice(): 'native' | 'webtorrent' {
  const override = process.env.HAVVN_ENGINE;
  if (override === 'native' || override === 'webtorrent') return override;
  return configStore.get('settings').engine === 'webtorrent' ? 'webtorrent' : 'native';
}

export async function updateSettings(
  settings: Partial<AppSettings>
): Promise<AppSettings> {
  const current = configStore.get('settings');
  const updated = { ...current, ...settings };
  // Encrypt secrets at rest (only re-encrypt when they actually changed)
  if (settings.proxyPassword !== undefined) {
    updated.proxyPassword = encryptSecret(settings.proxyPassword);
  }
  if (settings.customTurnCredential !== undefined) {
    updated.customTurnCredential = encryptSecret(settings.customTurnCredential);
  }
  configStore.set('settings', updated);
  // Return plaintext view to the caller
  return { ...updated, proxyPassword: decryptSecret(updated.proxyPassword), customTurnCredential: decryptSecret(updated.customTurnCredential) };
}

// === Cleanup ===

export async function cleanupOldDownloads(daysOld: number = 30): Promise<number> {
  const downloads = downloadsStore.get('downloads');
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  let removed = 0;
  for (const [id, download] of Object.entries(downloads)) {
    if (download.status === 'removed' && new Date(download.updatedAt) < cutoffDate) {
      delete downloads[id];
      removed++;
    }
  }

  if (removed > 0) {
    downloadsStore.set('downloads', downloads);
  }

  return removed;
}

// === Categories ===

export async function getCategories(): Promise<Category[]> {
  return configStore.get('categories');
}

export async function addCategory(category: Omit<Category, 'id'>): Promise<Category> {
  const categories = configStore.get('categories');
  const newCategory: Category = {
    id: uuidv4(),
    ...category,
  };
  categories.push(newCategory);
  configStore.set('categories', categories);
  return newCategory;
}

export async function updateCategory(id: string, updates: Partial<Category>): Promise<Category> {
  const categories = configStore.get('categories');
  const index = categories.findIndex(c => c.id === id);
  if (index === -1) {
    throw new Error(`Category not found: ${id}`);
  }
  categories[index] = { ...categories[index], ...updates };
  configStore.set('categories', categories);
  return categories[index];
}

export async function deleteCategory(id: string): Promise<void> {
  const categories = configStore.get('categories');
  const filtered = categories.filter(c => c.id !== id);
  configStore.set('categories', filtered);

  // Also update downloads that had this category
  const downloads = downloadsStore.get('downloads');
  let changed = false;
  for (const download of Object.values(downloads)) {
    if (download.category === id) {
      download.category = null;
      changed = true;
    }
  }
  if (changed) downloadsStore.set('downloads', downloads);
}

export async function setDownloadCategory(id: string, category: string | null): Promise<void> {
  const downloads = downloadsStore.get('downloads');
  const download = downloads[id];
  if (!download) {
    throw new Error(`Download not found: ${id}`);
  }
  download.category = category;
  download.updatedAt = new Date();
  downloads[id] = download;
  downloadsStore.set('downloads', downloads);
}

// === App Statistics (computed from real data) ===

function formatBytesForStats(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

export async function getAppStatistics(): Promise<{
  totalDownloads: number;
  totalUploaded: string;
  totalDownloaded: string;
  diskUsage: string;
  activeDownloads: number;
  completedDownloads: number;
}> {
  const downloads = downloadsStore.get('downloads');
  const all = Object.values(downloads);

  let totalUploadedBytes = 0;
  let totalDownloadedBytes = 0;
  let diskUsageBytes = 0;
  let activeCount = 0;
  let completedCount = 0;

  for (const d of all) {
    totalUploadedBytes += d.uploadedBytes || 0;
    totalDownloadedBytes += d.downloadedBytes || 0;
    if (d.status === 'completed' || d.status === 'seeding') {
      diskUsageBytes += d.totalSize || 0;
      completedCount++;
    }
    if (d.status === 'downloading') {
      activeCount++;
    }
  }

  return {
    totalDownloads: all.length,
    totalUploaded: formatBytesForStats(totalUploadedBytes),
    totalDownloaded: formatBytesForStats(totalDownloadedBytes),
    diskUsage: formatBytesForStats(diskUsageBytes),
    activeDownloads: activeCount,
    completedDownloads: completedCount,
  };
}

// === Scheduler ===

export async function getScheduler(): Promise<SchedulerConfig> {
  return configStore.get('scheduler');
}

export async function updateScheduler(config: Partial<SchedulerConfig>): Promise<SchedulerConfig> {
  const current = configStore.get('scheduler');
  const updated = { ...current, ...config };
  configStore.set('scheduler', updated);
  return updated;
}

// === Collaborative Seeding - Reputation ===

export async function getReputation(userId: string): Promise<UserReputation | null> {
  const reputations = reputationStore.get('reputation');
  return reputations[userId] || null;
}

export async function saveReputation(reputation: UserReputation): Promise<void> {
  const reputations = reputationStore.get('reputation');
  reputations[reputation.userId] = reputation;
  reputationStore.set('reputation', reputations);
}

export async function saveReputationTransaction(userId: string, transaction: ReputationTransaction): Promise<void> {
  const transactions = reputationStore.get('transactions');
  if (!transactions[userId]) {
    transactions[userId] = [];
  }
  transactions[userId].push(transaction);

  // Keep only last 1000 transactions per user
  if (transactions[userId].length > 1000) {
    transactions[userId] = transactions[userId].slice(-1000);
  }

  reputationStore.set('transactions', transactions);
}

export async function getReputationTransactions(userId: string, limit: number = 20): Promise<ReputationTransaction[]> {
  const transactions = reputationStore.get('transactions');
  const userTransactions = transactions[userId] || [];

  // Return last N transactions (most recent first)
  return userTransactions.slice(-limit).reverse();
}

// === Privacy Settings ===

export async function getPrivacyConfig(): Promise<PrivacyConfig> {
  return configStore.get('privacyConfig');
}

export async function updatePrivacyConfig(updates: Partial<PrivacyConfig>): Promise<PrivacyConfig> {
  const current = configStore.get('privacyConfig');
  const updated = { ...current, ...updates };
  configStore.set('privacyConfig', updated);
  return updated;
}

export async function clearAllData(): Promise<void> {
  // .clear() resets each store to its defaults.
  const { clearSearchNetworkSettings } = await import('../services/provider-network-store.js');
  const { providerNetwork } = await import('../services/provider-network.js');
  for (const provider of await getSearchProviders()) await providerNetwork.reset(provider.id, true);
  clearSearchNetworkSettings();
  configStore.clear();
  downloadsStore.clear();
  rssStore.clear();
  blocklistStore.clear();
  searchStore.clear();
  roomsStore.clear();
  reputationStore.clear();
  // Keep the migration marker set so wiping data doesn't re-trigger migration.
  configStore.set('splitStoresMigrated', true);
  configStore.set('categories', defaultCategories);
}

// === RSS Feeds ===

export async function getRSSFeeds(): Promise<RSSFeed[]> {
  return rssStore.get('rssFeeds') ?? [];
}

export async function addRSSFeed(feed: Omit<RSSFeed, 'id'>): Promise<RSSFeed> {
  const feeds = rssStore.get('rssFeeds') ?? [];
  const newFeed: RSSFeed = { ...feed, id: uuidv4() };
  feeds.push(newFeed);
  rssStore.set('rssFeeds', feeds);
  return newFeed;
}

export async function updateRSSFeed(id: string, updates: Partial<RSSFeed>): Promise<RSSFeed> {
  const feeds = rssStore.get('rssFeeds') ?? [];
  const idx = feeds.findIndex(f => f.id === id);
  if (idx === -1) throw new Error(`RSS feed not found: ${id}`);
  feeds[idx] = { ...feeds[idx], ...updates };
  rssStore.set('rssFeeds', feeds);
  return feeds[idx];
}

export async function removeRSSFeed(id: string): Promise<void> {
  const feeds = (rssStore.get('rssFeeds') ?? []).filter((f: RSSFeed) => f.id !== id);
  rssStore.set('rssFeeds', feeds);
  // Remove associated items
  const items = (rssStore.get('rssItems') ?? []).filter((i: RSSItem) => i.feedId !== id);
  rssStore.set('rssItems', items);
}

export async function getRSSItems(feedId?: string): Promise<RSSItem[]> {
  const items: RSSItem[] = rssStore.get('rssItems') ?? [];
  return feedId ? items.filter(i => i.feedId === feedId) : items;
}

/** Items kept per feed, and how long anything is kept at all. */
const MAX_ITEMS_PER_FEED = 1000;
const ITEM_RETENTION_DAYS = 30;

/**
 * Merge fetched items into the store (deduped by guid).
 * Returns only the items that were actually new — callers use this to
 * auto-download just the fresh entries instead of the whole feed history.
 */
export async function saveRSSItems(items: RSSItem[]): Promise<RSSItem[]> {
  const existing: RSSItem[] = rssStore.get('rssItems') ?? [];
  // Merge: only add new items (by guid)
  const existingGuids = new Set(existing.map(i => i.guid));
  const newItems = items.filter(i => !existingGuids.has(i.guid));
  rssStore.set('rssItems', pruneItems([...existing, ...newItems]));
  return newItems;
}

/**
 * Trim stored items by age and per-feed count.
 *
 * The old rule was a single `slice(-5000)` across every feed, so one busy feed
 * pushed a quiet feed's history out entirely. Budgets are per feed now, and
 * anything older than the retention window goes regardless — except items still
 * worth acting on (undownloaded and not dismissed), which survive the age sweep
 * so a feed checked rarely doesn't lose its backlog.
 */
function pruneItems(items: RSSItem[]): RSSItem[] {
  const cutoff = Date.now() - ITEM_RETENTION_DAYS * 86400000;

  const byAge = items.filter(item => {
    if (!item.pubDate) return true; // undated — only the per-feed cap applies
    const published = Date.parse(item.pubDate);
    if (!Number.isFinite(published)) return true;
    if (published >= cutoff) return true;
    return !item.downloaded && !item.ignored;
  });

  // Keep insertion order within a feed and drop from the front (oldest first).
  const counts = new Map<string, number>();
  for (const item of byAge) counts.set(item.feedId, (counts.get(item.feedId) || 0) + 1);

  const overflow = new Map<string, number>();
  for (const [feedId, count] of counts) {
    if (count > MAX_ITEMS_PER_FEED) overflow.set(feedId, count - MAX_ITEMS_PER_FEED);
  }
  if (overflow.size === 0) return byAge;

  return byAge.filter(item => {
    const toDrop = overflow.get(item.feedId);
    if (!toDrop) return true;
    overflow.set(item.feedId, toDrop - 1);
    return false;
  });
}

// === RSS Rules ===

export async function getRSSRules(): Promise<RSSRule[]> {
  return rssStore.get('rssRules') ?? [];
}

export async function addRSSRule(rule: Omit<RSSRule, 'id'>): Promise<RSSRule> {
  const rules = rssStore.get('rssRules') ?? [];
  const newRule: RSSRule = { ...rule, id: uuidv4() };
  rules.push(newRule);
  rssStore.set('rssRules', rules);
  return newRule;
}

export async function updateRSSRule(id: string, updates: Partial<RSSRule>): Promise<RSSRule> {
  const rules = rssStore.get('rssRules') ?? [];
  const idx = rules.findIndex((r: RSSRule) => r.id === id);
  if (idx === -1) throw new Error(`RSS rule not found: ${id}`);
  rules[idx] = { ...rules[idx], ...updates, id };
  rssStore.set('rssRules', rules);
  return rules[idx];
}

export async function removeRSSRule(id: string): Promise<void> {
  const rules = (rssStore.get('rssRules') ?? []).filter((r: RSSRule) => r.id !== id);
  rssStore.set('rssRules', rules);
}

/**
 * Turn each feed's legacy `filter` into an equivalent rule, once.
 *
 * Auto-download used to be a per-feed regex; without this, upgrading would
 * silently stop every working subscription. The feed's own `filter`,
 * `autoDownload`, `savePath`, `categoryId` and `addPaused` become one rule
 * scoped to that feed, which is exactly what it did before.
 */
export async function migrateRSSFiltersToRules(): Promise<number> {
  if (rssStore.get('rssRulesMigrated')) return 0;

  const feeds: RSSFeed[] = rssStore.get('rssFeeds') ?? [];
  const rules: RSSRule[] = rssStore.get('rssRules') ?? [];

  let created = 0;
  for (const feed of feeds) {
    // Only feeds that actually auto-downloaded had behaviour worth preserving.
    if (!feed.autoDownload) continue;
    if (rules.some(r => r.feedIds.length === 1 && r.feedIds[0] === feed.id)) continue;

    rules.push({
      id: uuidv4(),
      name: feed.name,
      enabled: true,
      feedIds: [feed.id],
      // The old filter was always a regex, so the migrated rule must be too —
      // reinterpreting it as wildcards would change what it matches.
      mode: 'regex',
      include: feed.filter || '',
      savePath: feed.savePath,
      categoryId: feed.categoryId,
      addPaused: feed.addPaused,
    });
    created++;
  }

  rssStore.set('rssRules', rules);
  rssStore.set('rssRulesMigrated', true);
  return created;
}

/**
 * Remove stored RSS items to keep the list from piling up.
 * - feedId omitted → applies across all feeds; provided → only that feed.
 * - onlyDownloaded true → keep undownloaded items, drop the already-grabbed ones.
 * Returns how many items were removed.
 */
export async function clearRSSItems(feedId?: string, onlyDownloaded = false): Promise<number> {
  const items: RSSItem[] = rssStore.get('rssItems') ?? [];
  const kept = items.filter(i => {
    const inScope = feedId ? i.feedId === feedId : true;
    if (!inScope) return true;                  // out of scope → keep
    if (onlyDownloaded) return !i.downloaded;   // scoped + only-downloaded → drop downloaded
    return false;                               // scoped, clear everything → drop
  });
  const removed = items.length - kept.length;
  if (removed > 0) rssStore.set('rssItems', kept);
  return removed;
}

export async function markRSSItemDownloaded(guid: string): Promise<void> {
  return markRSSItemsDownloaded([guid]);
}

/**
 * Flag several items in one write.
 *
 * Auto-download marks every grabbed item, and doing that one guid at a time
 * rewrote the whole (up to 5000-entry) array to disk per item — a feed that
 * brought 40 new torrents cost 40 full serializations.
 */
export async function markRSSItemsDownloaded(guids: string[]): Promise<void> {
  return setRSSItemFlag(guids, 'downloaded', true);
}

/** Mark items read (or unread) — drives the unread badge. */
export async function markRSSItemsRead(guids: string[], read = true): Promise<void> {
  return setRSSItemFlag(guids, 'read', read);
}

/** Dismiss items: kept in the store so they can't come back, hidden from the list. */
export async function markRSSItemsIgnored(guids: string[], ignored = true): Promise<void> {
  return setRSSItemFlag(guids, 'ignored', ignored);
}

/** Mark every stored item of a feed (or of all feeds) as read. */
export async function markFeedRead(feedId?: string): Promise<number> {
  const items: RSSItem[] = rssStore.get('rssItems') ?? [];
  let changed = 0;
  for (const item of items) {
    if (feedId && item.feedId !== feedId) continue;
    if (!item.read) {
      item.read = true;
      changed++;
    }
  }
  if (changed > 0) rssStore.set('rssItems', items);
  return changed;
}

function setRSSItemFlag(
  guids: string[],
  flag: 'downloaded' | 'read' | 'ignored',
  value: boolean
): Promise<void> {
  if (guids.length === 0) return Promise.resolve();
  const wanted = new Set(guids);
  const items: RSSItem[] = rssStore.get('rssItems') ?? [];

  let changed = false;
  for (const item of items) {
    if (wanted.has(item.guid) && item[flag] !== value) {
      item[flag] = value;
      changed = true;
    }
  }

  if (changed) rssStore.set('rssItems', items);
  return Promise.resolve();
}

// === Search Providers ===

export async function getSearchProviders(): Promise<SearchProvider[]> {
  const providers = searchStore.get('searchProviders') ?? [];
  // Decrypt secrets (API key + login password) transparently for callers.
  return providers.map(p => ({
    ...p,
    apiKey: p.apiKey ? decryptSecret(p.apiKey) : p.apiKey,
    password: p.password ? decryptSecret(p.password) : p.password,
  }));
}

export async function addSearchProvider(provider: Omit<SearchProvider, 'id'>): Promise<SearchProvider> {
  const providers = searchStore.get('searchProviders') ?? [];
  const newProvider: SearchProvider = { ...provider, id: uuidv4() };
  // Encrypt secrets at rest (API key + login password).
  const stored = { ...newProvider, apiKey: encryptSecret(newProvider.apiKey), password: encryptSecret(newProvider.password) };
  providers.push(stored);
  searchStore.set('searchProviders', providers);
  return newProvider; // return plaintext view
}

export async function updateSearchProvider(id: string, updates: Partial<SearchProvider>): Promise<SearchProvider> {
  const providers = searchStore.get('searchProviders') ?? [];
  const idx = providers.findIndex((p: SearchProvider) => p.id === id);
  if (idx === -1) throw new Error(`Search provider not found: ${id}`);
  const merged = { ...providers[idx], ...updates };
  if (updates.apiKey !== undefined) merged.apiKey = encryptSecret(updates.apiKey);
  if (updates.password !== undefined) merged.password = encryptSecret(updates.password);
  providers[idx] = merged;
  searchStore.set('searchProviders', providers);
  return {
    ...merged,
    apiKey: merged.apiKey ? decryptSecret(merged.apiKey) : merged.apiKey,
    password: merged.password ? decryptSecret(merged.password) : merged.password,
  };
}

export async function removeSearchProvider(id: string): Promise<void> {
  const providers = (searchStore.get('searchProviders') ?? []).filter((p: SearchProvider) => p.id !== id);
  searchStore.set('searchProviders', providers);
}

// === First-run defaults ===

/**
 * Curated, fully-legal suggested RSS feed (FOSS Torrents — Linux distros,
 * open-source games & software). Seeded DISABLED so nothing touches the network
 * until the user explicitly enables it or hits "Check".
 *
 * NOTE: must be the `torrents.xml` feed — its <item><link> points at an actual
 * .torrent file. The per-category feeds (distribution/game/software.xml) are
 * news feeds whose <link> is an HTML page, which can't be downloaded.
 */
const SUGGESTED_RSS_FEEDS: Omit<RSSFeed, 'id'>[] = [
  {
    name: 'FOSS Torrents (Linux, open-source games & software)',
    url: 'https://fosstorrents.com/feed/torrents.xml',
    enabled: false,
    autoDownload: false,
    intervalMinutes: 360,
  },
];

/** Old per-category news feeds seeded by mistake — their <link> is an HTML page. */
const DEPRECATED_FEED_URLS = new Set<string>([
  'https://fosstorrents.com/feed/distribution.xml',
  'https://fosstorrents.com/feed/game.xml',
  'https://fosstorrents.com/feed/software.xml',
]);

/**
 * Seed first-run defaults and run lightweight migrations.
 *
 * Migrations (every launch):
 *   - Remove the old built-in Internet Archive provider. archive.org serves its
 *     generated .torrent files unreliably (intermittent HTTP 401/403), so it
 *     can't be a dependable default.
 *   - Replace the wrongly-seeded FOSS Torrents news feeds (distribution/game/
 *     software.xml — their <link> is an HTML page, not a .torrent) with the
 *     correct torrents.xml feed. Only feeds the user never enabled are touched.
 *
 * First-run only (guarded by a persistent flag): seed the suggested RSS feed
 * DISABLED — opt-in, zero background traffic until the user enables it.
 */
export async function seedDefaultsIfNeeded(): Promise<void> {
  // Migration: drop the dead built-in Internet Archive provider if present
  const providers = searchStore.get('searchProviders') ?? [];
  const cleanedProviders = providers.filter((p: SearchProvider) => !(p.builtIn && p.type === 'archive'));
  if (cleanedProviders.length !== providers.length) {
    searchStore.set('searchProviders', cleanedProviders);
  }

  // Migration: remove the broken news feeds (only if the user left them disabled)
  const feeds = rssStore.get('rssFeeds') ?? [];
  const cleanedFeeds = feeds.filter((f: RSSFeed) => !(DEPRECATED_FEED_URLS.has(f.url) && !f.enabled));
  let feedsChanged = cleanedFeeds.length !== feeds.length;

  // Seed the working feed exactly once — on a true first run, or as a one-time
  // migration for installs that previously got the broken feeds. A dedicated
  // flag keeps it idempotent and lets the user delete it for good afterwards.
  const firstRun = !configStore.get('defaultsSeeded');
  if (firstRun) configStore.set('defaultsSeeded', true);

  if (!configStore.get('suggestedFeedSeeded')) {
    configStore.set('suggestedFeedSeeded', true);
    const hasSuggested = cleanedFeeds.some((f: RSSFeed) =>
      SUGGESTED_RSS_FEEDS.some(s => s.url === f.url));
    if (!hasSuggested) {
      cleanedFeeds.push(...SUGGESTED_RSS_FEEDS.map(f => ({ ...f, id: uuidv4() })));
      feedsChanged = true;
    }
  }

  if (feedsChanged) {
    rssStore.set('rssFeeds', cleanedFeeds);
  }
}

// === IP Blocklists ===

export async function getIPBlocklists(): Promise<IPBlocklist[]> {
  return blocklistStore.get('ipBlocklists') ?? [];
}

export async function addIPBlocklist(name: string, url: string): Promise<IPBlocklist> {
  const lists = blocklistStore.get('ipBlocklists') ?? [];
  const newList: IPBlocklist = { id: uuidv4(), name, url, enabled: true };
  lists.push(newList);
  blocklistStore.set('ipBlocklists', lists);
  return newList;
}

export async function removeIPBlocklist(id: string): Promise<void> {
  const lists = (blocklistStore.get('ipBlocklists') ?? []).filter((l: IPBlocklist) => l.id !== id);
  blocklistStore.set('ipBlocklists', lists);
  const data = blocklistStore.get('blocklistData') ?? {};
  delete data[id];
  blocklistStore.set('blocklistData', data);
}

export async function updateIPBlocklist(id: string, updates: Partial<IPBlocklist>): Promise<void> {
  const lists = blocklistStore.get('ipBlocklists') ?? [];
  const idx = lists.findIndex((l: IPBlocklist) => l.id === id);
  if (idx !== -1) {
    lists[idx] = { ...lists[idx], ...updates };
    blocklistStore.set('ipBlocklists', lists);
  }
}

export async function saveBlocklistData(id: string, data: string): Promise<void> {
  const blocklistData = blocklistStore.get('blocklistData') ?? {};
  blocklistData[id] = data;
  blocklistStore.set('blocklistData', blocklistData);
}

export async function getBlocklistData(id: string): Promise<string | null> {
  const blocklistData = blocklistStore.get('blocklistData') ?? {};
  return blocklistData[id] ?? null;
}

export function getManualPeerBans(): string[] {
  return blocklistStore.get('manualBans') ?? [];
}

export function setManualPeerBans(ips: string[]): void {
  blocklistStore.set('manualBans', ips);
}

// === Friend swarms / private rooms (Phase 3) ===

export function getPersistedRooms(): PersistedRoom[] {
  const raw = roomsStore.get('rooms') ?? {};
  const migrated = { ...raw };
  const result: PersistedRoom[] = [];
  const legacy: string[] = [];
  for (const record of Object.values(raw)) {
    try {
      if (!isEncryptionAvailable()) { result.push(lockedRoom(record, 'unavailable')); continue; }
      const room = openRoom(record);
      if (!record.secrets || record.banState !== undefined) { migrated[room.roomId] = sealRoom(room); legacy.push(room.roomId); }
      result.push(room);
    } catch {
      result.push(lockedRoom(record, record.secrets ? record.secrets.version !== 1 ? 'unsupported' : 'decrypt-failed' : 'migration-failed'));
    }
  }
  if (legacy.length) {
    try { roomsStore.set('rooms', migrated); }
    catch {
      for (let i = 0; i < result.length; i++) if (legacy.includes(result[i].roomId)) result[i] = lockedRoom(raw[result[i].roomId], 'migration-failed');
    }
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
}

export function savePersistedRoom(room: PersistedRoom): void {
  const protectedRoom = sealRoom(room); // prepare everything before the atomic store write
  const rooms = roomsStore.get('rooms') ?? {};
  if (rooms[room.roomId]?.secrets) openRoom(rooms[room.roomId]); // never replace inaccessible secrets
  const fresh = !rooms[room.roomId];
  rooms[room.roomId] = protectedRoom;
  if (fresh) roomsStore.set({ rooms, roomHistoryRetention: { ...(roomsStore.get('roomHistoryRetention') ?? {}), [room.roomId]: 30 } });
  else roomsStore.set('rooms', rooms);
}

export function deletePersistedRoom(roomId: string): void {
  const rooms = roomsStore.get('rooms') ?? {};
  delete rooms[roomId];
  roomsStore.set('rooms', rooms);
}

/** Per-room auto-download preference (absent = true, the historical behavior). */
export function setRoomAutoFetch(roomId: string, autoFetch: boolean): void {
  const rooms = roomsStore.get('rooms') ?? {};
  const room = rooms[roomId];
  if (!room) return;
  rooms[roomId] = { ...room, autoFetch };
  roomsStore.set('rooms', rooms);
}

/** Per-room OS-notification mute (absent = notify). */
export function setRoomNotifyMuted(roomId: string, notifyMuted: boolean): void {
  const rooms = roomsStore.get('rooms') ?? {};
  const room = rooms[roomId];
  if (!room) return;
  rooms[roomId] = { ...room, notifyMuted };
  roomsStore.set('rooms', rooms);
}

/** Per-room speed ceilings in KB/s (0 = shared room budget). */
export function setRoomLimits(roomId: string, upKbps: number, downKbps: number): void {
  const rooms = roomsStore.get('rooms') ?? {};
  const room = rooms[roomId];
  if (!room) return;
  rooms[roomId] = { ...room, upKbps: Math.max(0, upKbps || 0), downKbps: Math.max(0, downKbps || 0) };
  roomsStore.set('rooms', rooms);
}

/** This install's room identity, lazily created and persisted on first use. Our
 *  memberId is the hash of our signing pubkey (see deriveMemberId) so it can't be
 *  claimed by anyone else's key. */
export function getRoomProfile(): RoomProfile {
  let profile = roomsStore.get('roomProfile');
  if (!profile || !profile.memberId) {
    const { pub } = getRoomIdentity(); // ensure the keypair exists, then bind id to it
    const memberId = deriveMemberId(pub);
    profile = { memberId, name: '', avatarSeed: memberId };
    roomsStore.set('roomProfile', profile);
  }
  return profile;
}

export function updateRoomProfile(updates: Partial<Pick<RoomProfile, 'name' | 'avatarSeed' | 'color' | 'status' | 'avatarImg'>>): RoomProfile {
  const profile = getRoomProfile();
  const next: RoomProfile = { ...profile, ...updates };
  roomsStore.set('roomProfile', next);
  return next;
}

// === Smart network profiles ===
export function getNetworkProfiles(): NetworkProfile[] {
  return configStore.get('networkProfiles') ?? [];
}
export function saveNetworkProfile(profile: NetworkProfile): NetworkProfile {
  const list = getNetworkProfiles();
  const idx = list.findIndex((p) => p.id === profile.id);
  if (idx >= 0) list[idx] = profile; else list.push(profile);
  configStore.set('networkProfiles', list);
  return profile;
}
export function deleteNetworkProfile(id: string): void {
  configStore.set('networkProfiles', getNetworkProfiles().filter((p) => p.id !== id));
}

// Export the config store as `store` for the few main-process callers that read
// settings/privacyConfig/trayHintShown directly.
export { configStore as store };
