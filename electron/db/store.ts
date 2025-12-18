/**
 * Simple JSON-based storage using electron-store
 * Replaces PostgreSQL for simplicity
 */

import Store from 'electron-store';
import { Download, AppSettings, SourceType } from '../../shared/types';
import { v4 as uuidv4 } from 'uuid';
import { app } from 'electron';
import path from 'path';

interface StoreSchema {
  downloads: Record<string, Download>;
  settings: AppSettings;
}

const store = new Store<StoreSchema>({
  defaults: {
    downloads: {},
    settings: {
      id: 1,
      defaultDownloadDir: path.join(app.getPath('downloads'), 'TorrentHunt'),
      maxDownKbps: 0,
      maxUpKbps: 0,
      maxActiveDownloads: 3,
      updatedAt: new Date(),
    },
  },
});

// === Downloads ===

export async function createDownload(data: {
  name: string;
  sourceType: SourceType;
  sourceUri: string;
  torrentFilePath?: string;
  savePath: string;
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'seeding' | 'error' | 'removed';
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
  
  downloads[id] = download;
  store.set('downloads', downloads);
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

// === Settings ===

export async function getSettings(): Promise<AppSettings> {
  return store.get('settings');
}

export async function updateSettings(
  settings: Partial<AppSettings>
): Promise<AppSettings> {
  const current = store.get('settings');
  const updated = { ...current, ...settings };
  store.set('settings', updated);
  return updated;
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

// Export store for testing/debugging
export { store };
