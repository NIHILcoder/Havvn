import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// webUtils was added in Electron 30; the bundled type defs for older versions
// don't declare it, so access it defensively without a typed named import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { webUtils } = require('electron') as { webUtils?: { getPathForFile(file: File): string } };
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
  PrivacyConfig,
  ShareInfo,
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

  getStreamUrl: (id: string, fileIndex: number, opts?: { transcode?: boolean }): Promise<{ url: string; name: string; kind: 'video' | 'audio' | 'other'; transcoded: boolean }> => {
    return ipcRenderer.invoke('downloads:getStreamUrl', id, fileIndex, opts);
  },

  shareStart: (downloadId: string): Promise<ShareInfo> => {
    return ipcRenderer.invoke('share:start', downloadId);
  },
  shareStop: (downloadId: string): Promise<{ ok: boolean }> => {
    return ipcRenderer.invoke('share:stop', downloadId);
  },
  shareGet: (downloadId: string): Promise<(ShareInfo & { peers: number }) | null> => {
    return ipcRenderer.invoke('share:get', downloadId);
  },
  shareList: (): Promise<ShareInfo[]> => {
    return ipcRenderer.invoke('share:list');
  },

  getTorrentInfo: (params: { torrentPath?: string; magnetUri?: string }): Promise<any> => {
    return ipcRenderer.invoke('downloads:getTorrentInfo', params);
  },

  setDownloadCategory: (id: string, category: string | null): Promise<void> => {
    return ipcRenderer.invoke('downloads:setCategory', id, category);
  },

  getAppStats: () => {
    return ipcRenderer.invoke('stats:getAppStats');
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

  getFileTree: (sourcePaths: string[]) => {
    return ipcRenderer.invoke('fs:getFileTree', sourcePaths);
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

  // Privacy & Security
  getPrivacyConfig: () => {
    return ipcRenderer.invoke('privacy:getConfig');
  },

  updatePrivacyConfig: (updates: Partial<PrivacyConfig>) => {
    return ipcRenderer.invoke('privacy:updateConfig', updates);
  },

  checkVPN: () => {
    return ipcRenderer.invoke('privacy:checkVPN');
  },

  isEncryptionAvailable: () => {
    return ipcRenderer.invoke('privacy:isEncryptionAvailable');
  },

  clearAllData: () => {
    return ipcRenderer.invoke('privacy:clearAllData');
  },

  // Dialog API
  dialog: {
    showOpenDialog: (options: {
      properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<{ canceled: boolean; filePaths: string[] }> => {
      return ipcRenderer.invoke('dialog:showOpenDialog', options);
    },

    showSaveDialog: (options: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<{ canceled: boolean; filePath?: string }> => {
      return ipcRenderer.invoke('dialog:showSaveDialog', options);
    },
  },

  // System settings
  setAutoLaunch: (enabled: boolean): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('app:setAutoLaunch', enabled);
  },

  getAutoLaunch: (): Promise<boolean> => {
    return ipcRenderer.invoke('app:getAutoLaunch');
  },

  setCloseToTray: (enabled: boolean): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('app:setCloseToTray', enabled);
  },

  setMinimizeToTray: (enabled: boolean): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('app:setMinimizeToTray', enabled);
  },

  // Auto-update
  checkForUpdates: (): Promise<{ ok: boolean; reason?: string }> => {
    return ipcRenderer.invoke('app:checkForUpdates');
  },

  quitAndInstallUpdate: (): Promise<{ ok: boolean }> => {
    return ipcRenderer.invoke('app:quitAndInstall');
  },

  onUpdateStatus: (callback: (status: { kind: string; [k: string]: unknown }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, status: { kind: string }) => callback(status);
    ipcRenderer.on('app:updateStatus', handler);
    return () => { ipcRenderer.removeListener('app:updateStatus', handler); };
  },

  // App version (from package.json via Electron)
  getAppVersion: (): Promise<string> => {
    return ipcRenderer.invoke('app:getVersion');
  },

  // Default client
  isDefaultClient: (): Promise<boolean> => {
    return ipcRenderer.invoke('app:isDefaultClient');
  },

  setDefaultClient: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('app:setDefaultClient');
  },

  // Settings export/import
  exportSettings: (): Promise<{ success: boolean; path?: string }> => {
    return ipcRenderer.invoke('settings:export');
  },

  importSettings: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('settings:import');
  },

  // App events
  onOpenTorrent: (callback: (torrentUri: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, uri: string) => { callback(uri); };
    ipcRenderer.on('app:openTorrent', handler);
    return () => { ipcRenderer.removeListener('app:openTorrent', handler); };
  },

  notifyReady: (): void => {
    ipcRenderer.send('app:rendererReady');
  },

  // Resolve the absolute filesystem path of a dropped/selected File.
  // Electron >=30 exposes webUtils.getPathForFile; older versions still carry the
  // legacy File.path. Use whichever exists so drag & drop works across versions.
  getPathForFile: (file: File): string => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch {
      /* fall through to legacy File.path */
    }
    return (file as unknown as { path?: string }).path || '';
  },

  onPauseAll: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('app:pauseAll', handler);
    return () => { ipcRenderer.removeListener('app:pauseAll', handler); };
  },

  onResumeAll: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('app:resumeAll', handler);
    return () => { ipcRenderer.removeListener('app:resumeAll', handler); };
  },

  onVpnDropped: (callback: (info: { paused: number; publicIP?: string }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, info: { paused: number; publicIP?: string }) => callback(info);
    ipcRenderer.on('app:vpnDropped', handler);
    return () => { ipcRenderer.removeListener('app:vpnDropped', handler); };
  },

  onVpnRestored: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('app:vpnRestored', handler);
    return () => { ipcRenderer.removeListener('app:vpnRestored', handler); };
  },

  onDiskLow: (callback: (info: { paused: number; freeBytes: number; thresholdBytes: number }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, info: { paused: number; freeBytes: number; thresholdBytes: number }) => callback(info);
    ipcRenderer.on('app:diskLow', handler);
    return () => { ipcRenderer.removeListener('app:diskLow', handler); };
  },

  onDiskRecovered: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('app:diskRecovered', handler);
    return () => { ipcRenderer.removeListener('app:diskRecovered', handler); };
  },

  // Priority 1: New torrent controls
  setSequentialDownload: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('downloads:setSequential', id, enabled),

  setFilePriority: (id: string, fileIndex: number, priority: string) =>
    ipcRenderer.invoke('downloads:setFilePriority', id, fileIndex, priority),

  setTorrentSpeedLimits: (id: string, downKbps: number, upKbps: number) =>
    ipcRenderer.invoke('downloads:setSpeedLimits', id, downKbps, upKbps),

  setSeedRatioLimit: (id: string, ratio: number) =>
    ipcRenderer.invoke('downloads:setSeedRatio', id, ratio),

  setSeedTimeLimit: (id: string, minutes: number) =>
    ipcRenderer.invoke('downloads:setSeedTime', id, minutes),

  // Tracker management
  getTrackers: (id: string) =>
    ipcRenderer.invoke('downloads:getTrackers', id),

  addTracker: (id: string, url: string) =>
    ipcRenderer.invoke('downloads:addTracker', id, url),

  removeTracker: (id: string, url: string) =>
    ipcRenderer.invoke('downloads:removeTracker', id, url),

  // Watch folder
  getWatchFolderStatus: () =>
    ipcRenderer.invoke('watchFolder:getStatus'),

  setWatchFolder: (folderPath: string, enabled: boolean, deleteAfterAdd: boolean) =>
    ipcRenderer.invoke('watchFolder:set', folderPath, enabled, deleteAfterAdd),

  // Priority 2: RSS
  rss: {
    getFeeds: () => ipcRenderer.invoke('rss:getFeeds'),
    addFeed: (feed: any) => ipcRenderer.invoke('rss:addFeed', feed),
    updateFeed: (id: string, updates: any) => ipcRenderer.invoke('rss:updateFeed', id, updates),
    removeFeed: (id: string) => ipcRenderer.invoke('rss:removeFeed', id),
    checkFeed: (id: string) => ipcRenderer.invoke('rss:checkFeed', id),
    checkAll: () => ipcRenderer.invoke('rss:checkAll'),
    getItems: (feedId: string) => ipcRenderer.invoke('rss:getItems', feedId),
    markDownloaded: (guid: string) => ipcRenderer.invoke('rss:markDownloaded', guid),
    clearItems: (feedId?: string, onlyDownloaded?: boolean) => ipcRenderer.invoke('rss:clearItems', feedId, onlyDownloaded),
  },

  // Priority 2: Search
  search: {
    query: (query: string, category?: string) => ipcRenderer.invoke('search:query', query, category),
    getProviders: () => ipcRenderer.invoke('search:getProviders'),
    addProvider: (provider: any) => ipcRenderer.invoke('search:addProvider', provider),
    updateProvider: (id: string, updates: any) => ipcRenderer.invoke('search:updateProvider', id, updates),
    removeProvider: (id: string) => ipcRenderer.invoke('search:removeProvider', id),
    testProvider: (id: string) => ipcRenderer.invoke('search:testProvider', id),
  },

  // Priority 2: IP Blocklist
  blocklist: {
    getAll: () => ipcRenderer.invoke('blocklist:getAll'),
    add: (name: string, url: string) => ipcRenderer.invoke('blocklist:add', name, url),
    remove: (id: string) => ipcRenderer.invoke('blocklist:remove', id),
    update: (id: string) => ipcRenderer.invoke('blocklist:update', id),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('blocklist:setEnabled', id, enabled),
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('api', api);

