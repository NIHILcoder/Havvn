/**
 * Simple JSON-based storage using electron-store
 * Replaces PostgreSQL for simplicity
 */

import Store from 'electron-store';
import { Download, AppSettings, SourceType, Category, SchedulerConfig, UserReputation, ReputationTransaction, PrivacyConfig, RSSFeed, RSSItem, SearchProvider, IPBlocklist, RoomProfile } from '../../shared/types';
import { v4 as uuidv4 } from 'uuid';
import { app } from 'electron';
import path from 'path';
import crypto from 'crypto';
import { encryptSecret, decryptSecret } from './secrets';

interface StoreSchema {
  downloads: Record<string, Download>;
  settings: AppSettings;
  categories: Category[];
  scheduler: SchedulerConfig;
  reputation: Record<string, UserReputation>;
  transactions: Record<string, ReputationTransaction[]>;
  privacyConfig: PrivacyConfig;
  rssFeeds: RSSFeed[];
  rssItems: RSSItem[];
  searchProviders: SearchProvider[];
  ipBlocklists: IPBlocklist[];
  blocklistData: Record<string, string>; // id -> packed IP ranges as CSV
  defaultsSeeded: boolean;               // First-run seeding marker
  suggestedFeedSeeded: boolean;          // One-time seeding/migration of the working FOSS Torrents feed
  collaborativeSeedingEnabled: boolean;  // Collaborative Seeding Network opt-in (persisted)
  rooms: Record<string, PersistedRoom>;  // Friend swarms / private rooms (Phase 3)
  roomProfile: RoomProfile | null;       // This install's identity in rooms
  roomTombstones: Record<string, string[]>; // roomId → deleted fileIds (stop resurrection)
  windowBounds: WindowBounds | null;     // Last main-window size/position
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
}

const defaultCategories: Category[] = [
  { id: 'movies', name: 'Movies', icon: 'film', color: '#ef4444' },
  { id: 'games', name: 'Games', icon: 'gamepad-2', color: '#8b5cf6' },
  { id: 'software', name: 'Software', icon: 'package', color: '#3b82f6' },
  { id: 'music', name: 'Music', icon: 'music', color: '#22c55e' },
  { id: 'other', name: 'Other', icon: 'folder', color: '#6b7280' },
];

const store = new Store<StoreSchema>({
  defaults: {
    downloads: {},
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
      maxConnections: 100,
      portMin: 6881,
      portMax: 6889,
      portForwarding: true,
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
    reputation: {},
    transactions: {},
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
    rssFeeds: [],
    rssItems: [],
    searchProviders: [],
    ipBlocklists: [],
    blocklistData: {},
    defaultsSeeded: false,
    suggestedFeedSeeded: false,
    collaborativeSeedingEnabled: false,
    rooms: {},
    roomProfile: null,
    roomTombstones: {},
    windowBounds: null,
  },
});

// === Room tombstones (deleted shared files — keep them from reappearing) ===

export function getRoomTombstones(roomId: string): string[] {
  return (store.get('roomTombstones') ?? {})[roomId] ?? [];
}

export function addRoomTombstone(roomId: string, fileId: string): void {
  const all = store.get('roomTombstones') ?? {};
  const set = new Set(all[roomId] ?? []);
  set.add(fileId);
  all[roomId] = Array.from(set).slice(-500); // cap
  store.set('roomTombstones', all);
}

export function clearRoomTombstones(roomId: string): void {
  const all = store.get('roomTombstones') ?? {};
  delete all[roomId];
  store.set('roomTombstones', all);
}

// === Web remote token (lazily generated, persisted) ===

export async function getOrCreateWebRemoteToken(): Promise<string> {
  const s = store.get('settings');
  if (s.webRemoteToken && s.webRemoteToken.length >= 32) return s.webRemoteToken;
  const token = crypto.randomBytes(24).toString('hex');
  store.set('settings', { ...s, webRemoteToken: token });
  return token;
}

export async function regenerateWebRemoteToken(): Promise<string> {
  const s = store.get('settings');
  const token = crypto.randomBytes(24).toString('hex');
  store.set('settings', { ...s, webRemoteToken: token });
  return token;
}

// === Window bounds ===

export function getWindowBounds(): WindowBounds | null {
  return store.get('windowBounds') ?? null;
}

export function saveWindowBounds(bounds: WindowBounds): void {
  store.set('windowBounds', bounds);
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

  const downloads = store.get('downloads');
  downloads[id] = download;
  store.set('downloads', downloads);

  return download;
}

export async function getAllDownloads(): Promise<Download[]> {
  const downloads = store.get('downloads');
  return Object.values(downloads);
}

export async function getDownloadById(id: string): Promise<Download | null> {
  const downloads = store.get('downloads');
  return downloads[id] || null;
}

export async function getDownloadsByStatus(status: Download['status']): Promise<Download[]> {
  const downloads = store.get('downloads');
  return Object.values(downloads).filter(d => d.status === status);
}

export async function updateDownloadStatus(
  id: string,
  status: Download['status'],
  lastError: string | null = null
): Promise<void> {
  const downloads = store.get('downloads');
  const download = downloads[id];

  if (!download) {
    throw new Error(`Download not found: ${id}`);
  }

  download.status = status;
  download.lastError = lastError;
  download.updatedAt = new Date();

  downloads[id] = download;
  store.set('downloads', downloads);
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
  const downloads = store.get('downloads');
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
  store.set('downloads', downloads);
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

  const downloads = store.get('downloads');
  let changed = false;

  for (const data of updates) {
    const download = downloads[data.id];
    if (!download) continue;

    download.progress = data.progress;
    download.downloadedBytes = data.downloadedBytes;
    download.uploadedBytes = data.uploadedBytes;
    download.downSpeedBps = data.downSpeedBps;
    download.upSpeedBps = data.upSpeedBps;
    download.etaSeconds = data.etaSeconds;
    download.peers = data.peers;
    download.seeds = data.seeds;
    download.updatedAt = new Date();

    if (data.name) download.name = data.name;
    if (data.totalSize !== undefined && data.totalSize > 0) {
      download.totalSize = data.totalSize;
    }

    downloads[data.id] = download;
    changed = true;
  }

  if (changed) store.set('downloads', downloads);
}

export async function markDownloadRemoved(id: string): Promise<void> {
  const downloads = store.get('downloads');
  const download = downloads[id];

  if (!download) {
    throw new Error(`Download not found: ${id}`);
  }

  download.status = 'removed';
  download.updatedAt = new Date();

  downloads[id] = download;
  store.set('downloads', downloads);
}

export async function deleteDownload(id: string): Promise<void> {
  const downloads = store.get('downloads');
  delete downloads[id];
  store.set('downloads', downloads);
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
  const downloads = store.get('downloads');
  const download = downloads[id];
  if (!download) throw new Error(`Download not found: ${id}`);
  (download as any)[field] = value;
  download.updatedAt = new Date();
  downloads[id] = download;
  store.set('downloads', downloads);
}

/**
 * Bulk-update multiple fields on one download.
 */
export async function updateDownloadFields(
  id: string,
  fields: Partial<Download>
): Promise<void> {
  const downloads = store.get('downloads');
  const download = downloads[id];
  if (!download) throw new Error(`Download not found: ${id}`);
  Object.assign(download, fields);
  download.updatedAt = new Date();
  downloads[id] = download;
  store.set('downloads', downloads);
}


// === Settings ===

export async function getSettings(): Promise<AppSettings> {
  const s = store.get('settings');
  // Decrypt secrets transparently so callers always see plaintext
  return { ...s, proxyPassword: decryptSecret(s.proxyPassword) };
}

export async function updateSettings(
  settings: Partial<AppSettings>
): Promise<AppSettings> {
  const current = store.get('settings');
  const updated = { ...current, ...settings };
  // Encrypt the proxy password at rest (only re-encrypt when it actually changed)
  if (settings.proxyPassword !== undefined) {
    updated.proxyPassword = encryptSecret(settings.proxyPassword);
  }
  store.set('settings', updated);
  // Return plaintext view to the caller
  return { ...updated, proxyPassword: decryptSecret(updated.proxyPassword) };
}

// === Cleanup ===

export async function cleanupOldDownloads(daysOld: number = 30): Promise<number> {
  const downloads = store.get('downloads');
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
    store.set('downloads', downloads);
  }

  return removed;
}

// === Categories ===

export async function getCategories(): Promise<Category[]> {
  return store.get('categories');
}

export async function addCategory(category: Omit<Category, 'id'>): Promise<Category> {
  const categories = store.get('categories');
  const newCategory: Category = {
    id: uuidv4(),
    ...category,
  };
  categories.push(newCategory);
  store.set('categories', categories);
  return newCategory;
}

export async function updateCategory(id: string, updates: Partial<Category>): Promise<Category> {
  const categories = store.get('categories');
  const index = categories.findIndex(c => c.id === id);
  if (index === -1) {
    throw new Error(`Category not found: ${id}`);
  }
  categories[index] = { ...categories[index], ...updates };
  store.set('categories', categories);
  return categories[index];
}

export async function deleteCategory(id: string): Promise<void> {
  const categories = store.get('categories');
  const filtered = categories.filter(c => c.id !== id);
  store.set('categories', filtered);

  // Also update downloads that had this category
  const downloads = store.get('downloads');
  for (const download of Object.values(downloads)) {
    if (download.category === id) {
      download.category = null;
    }
  }
  store.set('downloads', downloads);
}

export async function setDownloadCategory(id: string, category: string | null): Promise<void> {
  const downloads = store.get('downloads');
  const download = downloads[id];
  if (!download) {
    throw new Error(`Download not found: ${id}`);
  }
  download.category = category;
  download.updatedAt = new Date();
  downloads[id] = download;
  store.set('downloads', downloads);
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
  const downloads = store.get('downloads');
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
  return store.get('scheduler');
}

export async function updateScheduler(config: Partial<SchedulerConfig>): Promise<SchedulerConfig> {
  const current = store.get('scheduler');
  const updated = { ...current, ...config };
  store.set('scheduler', updated);
  return updated;
}

// === Collaborative Seeding - Reputation ===

export async function getReputation(userId: string): Promise<UserReputation | null> {
  const reputations = store.get('reputation');
  return reputations[userId] || null;
}

export async function saveReputation(reputation: UserReputation): Promise<void> {
  const reputations = store.get('reputation');
  reputations[reputation.userId] = reputation;
  store.set('reputation', reputations);
}

export async function saveReputationTransaction(userId: string, transaction: ReputationTransaction): Promise<void> {
  const transactions = store.get('transactions');
  if (!transactions[userId]) {
    transactions[userId] = [];
  }
  transactions[userId].push(transaction);

  // Keep only last 1000 transactions per user
  if (transactions[userId].length > 1000) {
    transactions[userId] = transactions[userId].slice(-1000);
  }

  store.set('transactions', transactions);
}

export async function getReputationTransactions(userId: string, limit: number = 20): Promise<ReputationTransaction[]> {
  const transactions = store.get('transactions');
  const userTransactions = transactions[userId] || [];

  // Return last N transactions (most recent first)
  return userTransactions.slice(-limit).reverse();
}

// === Privacy Settings ===

export async function getPrivacyConfig(): Promise<PrivacyConfig> {
  return store.get('privacyConfig');
}

export async function updatePrivacyConfig(updates: Partial<PrivacyConfig>): Promise<PrivacyConfig> {
  const current = store.get('privacyConfig');
  const updated = { ...current, ...updates };
  store.set('privacyConfig', updated);
  return updated;
}

export async function clearAllData(): Promise<void> {
  store.clear();
  store.set('categories', defaultCategories);
  store.set('rssFeeds', []);
  store.set('rssItems', []);
  store.set('searchProviders', []);
  store.set('ipBlocklists', []);
  store.set('blocklistData', {});
}

// === RSS Feeds ===

export async function getRSSFeeds(): Promise<RSSFeed[]> {
  return store.get('rssFeeds') ?? [];
}

export async function addRSSFeed(feed: Omit<RSSFeed, 'id'>): Promise<RSSFeed> {
  const feeds = store.get('rssFeeds') ?? [];
  const newFeed: RSSFeed = { ...feed, id: uuidv4() };
  feeds.push(newFeed);
  store.set('rssFeeds', feeds);
  return newFeed;
}

export async function updateRSSFeed(id: string, updates: Partial<RSSFeed>): Promise<RSSFeed> {
  const feeds = store.get('rssFeeds') ?? [];
  const idx = feeds.findIndex(f => f.id === id);
  if (idx === -1) throw new Error(`RSS feed not found: ${id}`);
  feeds[idx] = { ...feeds[idx], ...updates };
  store.set('rssFeeds', feeds);
  return feeds[idx];
}

export async function removeRSSFeed(id: string): Promise<void> {
  const feeds = (store.get('rssFeeds') ?? []).filter((f: RSSFeed) => f.id !== id);
  store.set('rssFeeds', feeds);
  // Remove associated items
  const items = (store.get('rssItems') ?? []).filter((i: RSSItem) => i.feedId !== id);
  store.set('rssItems', items);
}

export async function getRSSItems(feedId?: string): Promise<RSSItem[]> {
  const items: RSSItem[] = store.get('rssItems') ?? [];
  return feedId ? items.filter(i => i.feedId === feedId) : items;
}

/**
 * Merge fetched items into the store (deduped by guid).
 * Returns only the items that were actually new — callers use this to
 * auto-download just the fresh entries instead of the whole feed history.
 */
export async function saveRSSItems(items: RSSItem[]): Promise<RSSItem[]> {
  const existing: RSSItem[] = store.get('rssItems') ?? [];
  // Merge: only add new items (by guid)
  const existingGuids = new Set(existing.map(i => i.guid));
  const newItems = items.filter(i => !existingGuids.has(i.guid));
  const merged = [...existing, ...newItems];
  // Keep last 5000 items total
  const trimmed = merged.slice(-5000);
  store.set('rssItems', trimmed);
  return newItems;
}

/**
 * Remove stored RSS items to keep the list from piling up.
 * - feedId omitted → applies across all feeds; provided → only that feed.
 * - onlyDownloaded true → keep undownloaded items, drop the already-grabbed ones.
 * Returns how many items were removed.
 */
export async function clearRSSItems(feedId?: string, onlyDownloaded = false): Promise<number> {
  const items: RSSItem[] = store.get('rssItems') ?? [];
  const kept = items.filter(i => {
    const inScope = feedId ? i.feedId === feedId : true;
    if (!inScope) return true;                  // out of scope → keep
    if (onlyDownloaded) return !i.downloaded;   // scoped + only-downloaded → drop downloaded
    return false;                               // scoped, clear everything → drop
  });
  const removed = items.length - kept.length;
  if (removed > 0) store.set('rssItems', kept);
  return removed;
}

export async function markRSSItemDownloaded(guid: string): Promise<void> {
  const items: RSSItem[] = store.get('rssItems') ?? [];
  const idx = items.findIndex(i => i.guid === guid);
  if (idx !== -1) {
    items[idx].downloaded = true;
    store.set('rssItems', items);
  }
}

// === Search Providers ===

export async function getSearchProviders(): Promise<SearchProvider[]> {
  const providers = store.get('searchProviders') ?? [];
  // Decrypt API keys transparently for callers (search service, UI)
  return providers.map(p => ({ ...p, apiKey: p.apiKey ? decryptSecret(p.apiKey) : p.apiKey }));
}

export async function addSearchProvider(provider: Omit<SearchProvider, 'id'>): Promise<SearchProvider> {
  const providers = store.get('searchProviders') ?? [];
  const newProvider: SearchProvider = { ...provider, id: uuidv4() };
  // Encrypt the API key at rest
  const stored = { ...newProvider, apiKey: encryptSecret(newProvider.apiKey) };
  providers.push(stored);
  store.set('searchProviders', providers);
  return newProvider; // return plaintext view
}

export async function updateSearchProvider(id: string, updates: Partial<SearchProvider>): Promise<SearchProvider> {
  const providers = store.get('searchProviders') ?? [];
  const idx = providers.findIndex((p: SearchProvider) => p.id === id);
  if (idx === -1) throw new Error(`Search provider not found: ${id}`);
  const merged = { ...providers[idx], ...updates };
  if (updates.apiKey !== undefined) {
    merged.apiKey = encryptSecret(updates.apiKey);
  }
  providers[idx] = merged;
  store.set('searchProviders', providers);
  return { ...merged, apiKey: merged.apiKey ? decryptSecret(merged.apiKey) : merged.apiKey };
}

export async function removeSearchProvider(id: string): Promise<void> {
  const providers = (store.get('searchProviders') ?? []).filter((p: SearchProvider) => p.id !== id);
  store.set('searchProviders', providers);
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
  const providers = store.get('searchProviders') ?? [];
  const cleanedProviders = providers.filter((p: SearchProvider) => !(p.builtIn && p.type === 'archive'));
  if (cleanedProviders.length !== providers.length) {
    store.set('searchProviders', cleanedProviders);
  }

  // Migration: remove the broken news feeds (only if the user left them disabled)
  const feeds = store.get('rssFeeds') ?? [];
  const cleanedFeeds = feeds.filter((f: RSSFeed) => !(DEPRECATED_FEED_URLS.has(f.url) && !f.enabled));
  let feedsChanged = cleanedFeeds.length !== feeds.length;

  // Seed the working feed exactly once — on a true first run, or as a one-time
  // migration for installs that previously got the broken feeds. A dedicated
  // flag keeps it idempotent and lets the user delete it for good afterwards.
  const firstRun = !store.get('defaultsSeeded');
  if (firstRun) store.set('defaultsSeeded', true);

  if (!store.get('suggestedFeedSeeded')) {
    store.set('suggestedFeedSeeded', true);
    const hasSuggested = cleanedFeeds.some((f: RSSFeed) =>
      SUGGESTED_RSS_FEEDS.some(s => s.url === f.url));
    if (!hasSuggested) {
      cleanedFeeds.push(...SUGGESTED_RSS_FEEDS.map(f => ({ ...f, id: uuidv4() })));
      feedsChanged = true;
    }
  }

  if (feedsChanged) {
    store.set('rssFeeds', cleanedFeeds);
  }
}

// === IP Blocklists ===

export async function getIPBlocklists(): Promise<IPBlocklist[]> {
  return store.get('ipBlocklists') ?? [];
}

export async function addIPBlocklist(name: string, url: string): Promise<IPBlocklist> {
  const lists = store.get('ipBlocklists') ?? [];
  const newList: IPBlocklist = { id: uuidv4(), name, url, enabled: true };
  lists.push(newList);
  store.set('ipBlocklists', lists);
  return newList;
}

export async function removeIPBlocklist(id: string): Promise<void> {
  const lists = (store.get('ipBlocklists') ?? []).filter((l: IPBlocklist) => l.id !== id);
  store.set('ipBlocklists', lists);
  const data = store.get('blocklistData') ?? {};
  delete data[id];
  store.set('blocklistData', data);
}

export async function updateIPBlocklist(id: string, updates: Partial<IPBlocklist>): Promise<void> {
  const lists = store.get('ipBlocklists') ?? [];
  const idx = lists.findIndex((l: IPBlocklist) => l.id === id);
  if (idx !== -1) {
    lists[idx] = { ...lists[idx], ...updates };
    store.set('ipBlocklists', lists);
  }
}

export async function saveBlocklistData(id: string, data: string): Promise<void> {
  const blocklistData = store.get('blocklistData') ?? {};
  blocklistData[id] = data;
  store.set('blocklistData', blocklistData);
}

export async function getBlocklistData(id: string): Promise<string | null> {
  const blocklistData = store.get('blocklistData') ?? {};
  return blocklistData[id] ?? null;
}

// === Friend swarms / private rooms (Phase 3) ===

export function getPersistedRooms(): PersistedRoom[] {
  const rooms = store.get('rooms') ?? {};
  return Object.values(rooms).sort((a, b) => b.createdAt - a.createdAt);
}

export function savePersistedRoom(room: PersistedRoom): void {
  const rooms = store.get('rooms') ?? {};
  rooms[room.roomId] = room;
  store.set('rooms', rooms);
}

export function deletePersistedRoom(roomId: string): void {
  const rooms = store.get('rooms') ?? {};
  delete rooms[roomId];
  store.set('rooms', rooms);
}

/** This install's room identity, lazily created and persisted on first use. */
export function getRoomProfile(): RoomProfile {
  let profile = store.get('roomProfile');
  if (!profile) {
    const memberId = uuidv4().replace(/-/g, '');
    profile = { memberId, name: '', avatarSeed: memberId };
    store.set('roomProfile', profile);
  }
  return profile;
}

export function updateRoomProfile(updates: Partial<Pick<RoomProfile, 'name' | 'avatarSeed'>>): RoomProfile {
  const profile = getRoomProfile();
  const next: RoomProfile = { ...profile, ...updates };
  store.set('roomProfile', next);
  return next;
}

// Export store for testing/debugging
export { store };

