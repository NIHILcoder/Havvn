import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  AddDownloadRequest,
  Download,
  DownloadStats,
  AppSettings,
  CatalogEntry,
  Category,
  SchedulerConfig,
  IpcApi,
  CreateTorrentRequest,
  CreateTorrentResult,
  CreateTorrentProgress,
} from '../shared/types';

const api: IpcApi = {
  // Downloads
  addDownload: (request: AddDownloadRequest): Promise<Download> => {
    return ipcRenderer.invoke('downloads:add', request);
  },

  pauseDownload: (id: string): Promise<void> => {
    return ipcRenderer.invoke('downloads:pause', id);
  },

  resumeDownload: (id: string): Promise<void> => {
    return ipcRenderer.invoke('downloads:resume', id);
  },

  removeDownload: (id: string, deleteFiles: boolean): Promise<void> => {
    return ipcRenderer.invoke('downloads:remove', id, deleteFiles);
  },

  stopSeeding: (id: string): Promise<void> => {
    return ipcRenderer.invoke('downloads:stopSeeding', id);
  },

  retryDownload: (id: string): Promise<void> => {
    return ipcRenderer.invoke('downloads:retry', id);
  },

  getDownloads: (): Promise<Download[]> => {
    return ipcRenderer.invoke('downloads:getAll');
  },

  getTorrentFiles: (id: string): Promise<any[]> => {
    return ipcRenderer.invoke('downloads:getFiles', id);
  },

  getTorrentInfo: (params: { torrentPath?: string; magnetUri?: string }): Promise<any> => {
    return ipcRenderer.invoke('downloads:getTorrentInfo', params);
  },

  setDownloadCategory: (id: string, category: string | null): Promise<void> => {
    return ipcRenderer.invoke('downloads:setCategory', id, category);
  },

  // Settings
  getSettings: (): Promise<AppSettings> => {
    return ipcRenderer.invoke('settings:get');
  },

  updateSettings: (settings: Partial<AppSettings>): Promise<AppSettings> => {
    return ipcRenderer.invoke('settings:update', settings);
  },

  // Categories
  getCategories: (): Promise<Category[]> => {
    return ipcRenderer.invoke('categories:get');
  },

  addCategory: (category: Omit<Category, 'id'>): Promise<Category> => {
    return ipcRenderer.invoke('categories:add', category);
  },

  updateCategory: (id: string, updates: Partial<Category>): Promise<Category> => {
    return ipcRenderer.invoke('categories:update', id, updates);
  },

  deleteCategory: (id: string): Promise<void> => {
    return ipcRenderer.invoke('categories:delete', id);
  },

  // Scheduler
  getScheduler: (): Promise<SchedulerConfig> => {
    return ipcRenderer.invoke('scheduler:get');
  },

  updateScheduler: (config: Partial<SchedulerConfig>): Promise<SchedulerConfig> => {
    return ipcRenderer.invoke('scheduler:update', config);
  },

  // Catalog
  getCatalog: (): Promise<CatalogEntry[]> => {
    return ipcRenderer.invoke('catalog:get');
  },

  // File dialogs
  selectDirectory: (): Promise<string | null> => {
    return ipcRenderer.invoke('dialog:selectDirectory');
  },

  selectTorrentFile: (): Promise<{ path: string; content: string } | null> => {
    return ipcRenderer.invoke('dialog:selectTorrentFile');
  },

  selectFilesForTorrent: (): Promise<string[] | null> => {
    return ipcRenderer.invoke('dialog:selectFilesForTorrent');
  },

  selectFolderForTorrent: (): Promise<string | null> => {
    return ipcRenderer.invoke('dialog:selectFolderForTorrent');
  },

  selectSaveTorrentPath: (defaultName: string): Promise<string | null> => {
    return ipcRenderer.invoke('dialog:selectSaveTorrentPath', defaultName);
  },

  // File system operations
  getPathInfo: (path: string): Promise<{
    isDirectory: boolean;
    size: number;
    fileCount: number;
    name: string;
  }> => {
    return ipcRenderer.invoke('fs:getPathInfo', path);
  },

  // Shell operations
  openPath: (path: string): Promise<void> => {
    return ipcRenderer.invoke('shell:openPath', path);
  },

  showItemInFolder: (path: string): Promise<void> => {
    return ipcRenderer.invoke('shell:showItemInFolder', path);
  },

  // Cache management
  clearCache: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('cache:clear');
  },

  // Create torrent
  createTorrent: (request: CreateTorrentRequest): Promise<CreateTorrentResult> => {
    return ipcRenderer.invoke('torrent:create', request);
  },

  getDefaultTrackers: (): Promise<string[][]> => {
    return ipcRenderer.invoke('torrent:getDefaultTrackers');
  },

  // Stats subscription
  onDownloadStats: (callback: (stats: DownloadStats[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, stats: DownloadStats[]) => {
      callback(stats);
    };

    ipcRenderer.on('downloads:stats', handler);

    return () => {
      ipcRenderer.removeListener('downloads:stats', handler);
    };
  },

  onCreateTorrentProgress: (callback: (progress: CreateTorrentProgress) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, progress: CreateTorrentProgress) => {
      callback(progress);
    };

    ipcRenderer.on('torrent:createProgress', handler);

    return () => {
      ipcRenderer.removeListener('torrent:createProgress', handler);
    };
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('api', api);

