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

  // Shell operations
  openPath: (path: string) => Promise<void>;
  showItemInFolder: (path: string) => Promise<void>;

  // Cache management
  clearCache: () => Promise<{ success: boolean }>;

  // Stats subscription
  onDownloadStats: (callback: (stats: DownloadStats[]) => void) => () => void;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
