// Shared types for TorrentHunt application

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

export type FilePriority = 'skip' | 'low' | 'normal' | 'high';

export interface TrackerInfo {
  url: string;
  status: 'connected' | 'disconnected' | 'error';
  peers: number;
  lastAnnounce?: string;
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

export interface AppSettings {
  id: number;
  defaultDownloadDir: string;
  maxDownKbps: number;
  maxUpKbps: number;
  maxActiveDownloads: number;
  minimizeToTray: boolean;
  closeToTray: boolean;
  autoLaunch: boolean;
  autoUpdate: boolean;
  // Advanced network settings
  enableDHT: boolean;
  enablePEX: boolean;
  enableLSD: boolean;
  maxConnections: number;
  portMin: number;
  portMax: number;
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

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  magnetUri: string;
  size: string;
  category: string;
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
  url: string;                  // Jackett base URL or custom API URL
  apiKey?: string;
  enabled: boolean;
  type: 'jackett' | 'torznab' | 'custom' | 'archive';
  builtIn?: boolean;            // Pre-seeded provider (e.g. Internet Archive) — not user-removable
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
  getDownloads: () => Promise<Download[]>;
  getTorrentFiles: (id: string) => Promise<TorrentFile[]>;
  getStreamUrl: (id: string, fileIndex: number, opts?: { transcode?: boolean }) => Promise<{ url: string; name: string; kind: 'video' | 'audio' | 'other'; transcoded: boolean }>;
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
  setTorrentSpeedLimits: (id: string, downKbps: number, upKbps: number) => Promise<void>;
  setSeedRatioLimit: (id: string, ratio: number) => Promise<void>;
  setSeedTimeLimit: (id: string, minutes: number) => Promise<void>;
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

  // Catalog
  getCatalog: () => Promise<CatalogEntry[]>;

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
  checkVPN: () => Promise<VPNDetectionResult>;
  isEncryptionAvailable: () => Promise<boolean>;
  clearAllData: () => Promise<{ success: boolean }>;

  // App events
  onOpenTorrent: (callback: (torrentUri: string) => void) => () => void;
  // Renderer announces its IPC listeners are attached (flushes buffered OS opens)
  notifyReady: () => void;
  // Resolve the absolute path of a dropped/selected File (webUtils.getPathForFile)
  getPathForFile: (file: File) => string;
  // Tray events from main
  onPauseAll: (callback: () => void) => () => void;
  onResumeAll: (callback: () => void) => () => void;
  onVpnDropped: (callback: (info: { paused: number; publicIP?: string }) => void) => () => void;
  onVpnRestored: (callback: () => void) => () => void;
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
  };

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
