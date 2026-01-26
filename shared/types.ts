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
  totalSize: number; // Total size in bytes
  priority: number; // 0 = low, 1 = normal, 2 = high
  category: string | null; // Category ID
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
  updatedAt: Date;
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
  savePath?: string; // Override default download directory
  name?: string;
  selectedFiles?: number[]; // Indices of files to download (for selective download)
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
  getTorrentInfo: (params: { torrentPath?: string; magnetUri?: string }) => Promise<TorrentInfo>;
  setDownloadCategory: (id: string, category: string | null) => Promise<void>;

  // Settings
  getSettings: () => Promise<AppSettings>;
  updateSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;

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

  // Collaborative Seeding Network
  getReputation: () => Promise<UserReputation>;
  getSeedingPriorities: () => Promise<Map<string, SeedingPriority>>;
  getSeedingRecommendations: (maxSlots: number) => Promise<SeedingPlan>;
  getRecentTransactions: (limit?: number) => Promise<ReputationTransaction[]>;
  getBadges: () => Promise<Badge[]>;
  enableCollaborativeSeeding: (enabled: boolean) => Promise<void>;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
