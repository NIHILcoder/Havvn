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
  createdAt: Date;
  updatedAt: Date;
  lastError: string | null;
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

  // Settings
  getSettings: () => Promise<AppSettings>;
  updateSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;

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
