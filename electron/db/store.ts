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
import { Download, AppSettings, SourceType, Category, SchedulerConfig, UserReputation, ReputationTransaction, PrivacyConfig, RSSFeed, RSSItem, SearchProvider, IPBlocklist, RoomProfile, PersistedRoomFile, RoomEvent, RoomChatMessage, NetworkProfile } from '../../shared/types';
import { v4 as uuidv4 } from 'uuid';
import { app } from 'electron';
import path from 'path';
import crypto from 'crypto';
import { encryptSecret, decryptSecret } from './secrets';

// === Per-file store schemas ===

interface ConfigSchema {
  settings: AppSettings;
  categories: Category[];
  scheduler: SchedulerConfig;
  privacyConfig: PrivacyConfig;
  windowBounds: WindowBounds | null;
  defaultsSeeded: boolean;               // First-run seeding marker
  suggestedFeedSeeded: boolean;          // One-time seeding/migration of the working FOSS Torrents feed
  collaborativeSeedingEnabled: boolean;  // Collaborative Seeding Network opt-in (persisted)
  trayHintShown?: boolean;               // One-time "running in tray" hint (set from main.ts)
  splitStoresMigrated?: boolean;         // One-time migration marker (see migrateToSplitStores)
  networkProfiles?: NetworkProfile[];    // Smart per-network settings overlays
}

interface DownloadsSchema {
  downloads: Record<string, Download>;
}

interface RssSchema {
  rssFeeds: RSSFeed[];
  rssItems: RSSItem[];
}

interface BlocklistSchema {
  ipBlocklists: IPBlocklist[];
  blocklistData: Record<string, string>; // id -> packed IP ranges as CSV
}

interface SearchSchema {
  searchProviders: SearchProvider[];
}

interface RoomsSchema {
  rooms: Record<string, PersistedRoom>;      // Friend swarms / private rooms (Phase 3)
  roomProfile: RoomProfile | null;           // This install's identity in rooms
  roomTombstones: Record<string, string[]>;  // roomId → deleted fileIds (stop resurrection)
  roomManifests: Record<string, PersistedRoomFile[]>; // roomId → known files (resume on restart)
  roomHistory: Record<string, RoomEvent[]>;  // roomId → activity log (capped)
  roomMutes: Record<string, string[]>;       // roomId → locally-muted memberIds
  roomChats: Record<string, RoomChatMessage[]>; // roomId → chat log (capped, text encrypted at rest)
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
  e2e?: boolean;     // end-to-end encryption mode (set at creation; learned via gossip)
  secret?: string;   // E2E content key (32-byte hex); distributed over encrypted gossip
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
      defaultDownloadDir: path.join(app.getPath('downloads'), 'TorrentHunt'),
      maxDownKbps: 0,
      maxUpKbps: 0,
      altSpeedEnabled: false,
      altDownKbps: 0,
      altUpKbps: 0,
      maxActiveDownloads: 3,
      minimizeToTray: true,
      closeToTray: true,
      autoLaunch: false,
      autoUpdate: false,
      // Advanced
      enableDHT: true,
      enablePEX: true,
      enableLSD: true,
      // µTP experimental: default on except Windows (historic utp-native crash).
      enableUtp: process.platform !== 'win32',
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
    },
    windowBounds: null,
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
  defaults: { rssFeeds: [], rssItems: [] },
});

const blocklistStore = new Store<BlocklistSchema>({
  name: 'blocklists',
  defaults: { ipBlocklists: [], blocklistData: {} },
});

const searchStore = new Store<SearchSchema>({
  name: 'search',
  defaults: { searchProviders: [] },
});

const roomsStore = new Store<RoomsSchema>({
  name: 'rooms',
  defaults: { rooms: {}, roomProfile: null, roomTombstones: {}, roomManifests: {}, roomHistory: {}, roomMutes: {}, roomChats: {}, roomIdentity: null, roomIdentities: {} },
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

// === Room tombstones (deleted shared files — keep them from reappearing) ===

export function getRoomTombstones(roomId: string): string[] {
  return (roomsStore.get('roomTombstones') ?? {})[roomId] ?? [];
}

export function addRoomTombstone(roomId: string, fileId: string): void {
  const all = roomsStore.get('roomTombstones') ?? {};
  const set = new Set(all[roomId] ?? []);
  set.add(fileId);
  all[roomId] = Array.from(set).slice(-500); // cap
  roomsStore.set('roomTombstones', all);
}

export function clearRoomTombstones(roomId: string): void {
  const all = roomsStore.get('roomTombstones') ?? {};
  delete all[roomId];
  roomsStore.set('roomTombstones', all);
}

// === Room manifest (known files — resume a room's file list/seeding on restart) ===

export function getRoomManifest(roomId: string): PersistedRoomFile[] {
  return (roomsStore.get('roomManifests') ?? {})[roomId] ?? [];
}

/** Add or update one file in a room's persisted manifest (keyed by fileId). */
export function upsertRoomManifestFile(roomId: string, file: PersistedRoomFile): void {
  if (!file?.fileId) return;
  const all = roomsStore.get('roomManifests') ?? {};
  const list = (all[roomId] ?? []).filter((f) => f.fileId !== file.fileId);
  list.push(file);
  all[roomId] = list.slice(-1000); // cap
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

// === Room activity history (locally-observed event log) ===

export function getRoomHistory(roomId: string): RoomEvent[] {
  return (roomsStore.get('roomHistory') ?? {})[roomId] ?? [];
}

export function appendRoomEvents(roomId: string, events: RoomEvent[]): void {
  if (!events.length) return;
  const all = roomsStore.get('roomHistory') ?? {};
  const list = (all[roomId] ?? []).concat(events).slice(-200); // cap
  all[roomId] = list;
  roomsStore.set('roomHistory', all);
}

export function clearRoomHistory(roomId: string): void {
  const all = roomsStore.get('roomHistory') ?? {};
  delete all[roomId];
  roomsStore.set('roomHistory', all);
}

// === Room chat (gossiped messages, persisted locally + capped) ===
// Message text is encrypted at rest (safeStorage/DPAPI) so the on-disk log is
// not readable plaintext; metadata (id/at/sender) stays clear for indexing.

export function getRoomChats(roomId: string): RoomChatMessage[] {
  const list = (roomsStore.get('roomChats') ?? {})[roomId] ?? [];
  return list.map((m) => ({ ...m, text: decryptSecret(m.text) }));
}

export function appendRoomChats(roomId: string, messages: RoomChatMessage[]): void {
  if (!messages.length) return;
  const all = roomsStore.get('roomChats') ?? {};
  const seen = new Set((all[roomId] ?? []).map((m) => m.id));
  const fresh = messages
    .filter((m) => m.id && !seen.has(m.id))
    .map((m) => ({ ...m, text: encryptSecret(m.text) }));
  if (!fresh.length) return;
  all[roomId] = (all[roomId] ?? []).concat(fresh).slice(-200); // cap
  roomsStore.set('roomChats', all);
}

export function clearRoomChats(roomId: string): void {
  const all = roomsStore.get('roomChats') ?? {};
  delete all[roomId];
  roomsStore.set('roomChats', all);
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

// === Window bounds ===

export function getWindowBounds(): WindowBounds | null {
  return configStore.get('windowBounds') ?? null;
}

export function saveWindowBounds(bounds: WindowBounds): void {
  configStore.set('windowBounds', bounds);
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
    category: null,
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
  const downloads = downloadsStore.get('downloads');
  const download = downloads[id];

  if (!download) {
    throw new Error(`Download not found: ${id}`);
  }

  download.status = 'removed';
  download.updatedAt = new Date();

  downloads[id] = download;
  downloadsStore.set('downloads', downloads);
}

export async function deleteDownload(id: string): Promise<void> {
  const downloads = downloadsStore.get('downloads');
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
  const merged = [...existing, ...newItems];
  // Keep last 5000 items total
  const trimmed = merged.slice(-5000);
  rssStore.set('rssItems', trimmed);
  return newItems;
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
  const items: RSSItem[] = rssStore.get('rssItems') ?? [];
  const idx = items.findIndex(i => i.guid === guid);
  if (idx !== -1) {
    items[idx].downloaded = true;
    rssStore.set('rssItems', items);
  }
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

// === Friend swarms / private rooms (Phase 3) ===

export function getPersistedRooms(): PersistedRoom[] {
  const rooms = roomsStore.get('rooms') ?? {};
  return Object.values(rooms).sort((a, b) => b.createdAt - a.createdAt);
}

export function savePersistedRoom(room: PersistedRoom): void {
  const rooms = roomsStore.get('rooms') ?? {};
  rooms[room.roomId] = room;
  roomsStore.set('rooms', rooms);
}

export function deletePersistedRoom(roomId: string): void {
  const rooms = roomsStore.get('rooms') ?? {};
  delete rooms[roomId];
  roomsStore.set('rooms', rooms);
}

/** This install's room identity, lazily created and persisted on first use. */
export function getRoomProfile(): RoomProfile {
  let profile = roomsStore.get('roomProfile');
  if (!profile) {
    const memberId = uuidv4().replace(/-/g, '');
    profile = { memberId, name: '', avatarSeed: memberId };
    roomsStore.set('roomProfile', profile);
  }
  return profile;
}

export function updateRoomProfile(updates: Partial<Pick<RoomProfile, 'name' | 'avatarSeed'>>): RoomProfile {
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
