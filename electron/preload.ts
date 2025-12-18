import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  AddDownloadRequest,
  Download,
  DownloadStats,
  AppSettings,
  CatalogEntry,
  IpcApi,
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
  
  // Settings
  getSettings: (): Promise<AppSettings> => {
    return ipcRenderer.invoke('settings:get');
  },
  
  updateSettings: (settings: Partial<AppSettings>): Promise<AppSettings> => {
    return ipcRenderer.invoke('settings:update', settings);
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
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('api', api);
