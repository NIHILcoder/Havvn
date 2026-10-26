import type { Download, TorrentFile } from './types';
import type { OwnedOperation } from './operations';
import { extractInfoHashFromMagnet } from './magnet';

export const DOWNLOAD_UNDO_WINDOW_MS = 30_000;
export const DOWNLOAD_UNDO_MAX_ENTRIES = 20;
export const DOWNLOAD_UNDO_MAX_BYTES = 64 * 1024 * 1024;
export const DOWNLOAD_UNDO_METADATA_BYTES = 8 * 1024 * 1024;
export const DOWNLOAD_UNDO_MAX_FILES = 10_000;

/** Internal main↔engine snapshot. Never sent to the renderer or exported with settings. */
export interface DownloadRemovalSnapshot {
  download: Download;
  signature: string;
  metadata: string | null;
  files: Array<Pick<TorrentFile, 'path' | 'length' | 'downloaded' | 'priority'>>;
  existingFiles: Array<{ path: string; size: number }>;
}
export interface DownloadDeletionPreview {
  token: string; downloadId: string; name: string; expiresAt: number; metadataReady: boolean;
  locations: string[]; files: Array<{ path: string; size: number }>; missing: number; bytes: number;
}
/** Internal only: renderer can submit a token, never paths or file identities. */
export interface DownloadDeletionPlan {
  schema: 1; downloadId: string; signature: string; expiresAt: number; metadata: string | null;
  roots: Array<{ path: string; file: boolean }>;
  files: Array<{ path: string; size: number; dev: number; ino: number; birth: number }>;
  absent: string[];
}
export function downloadRemovalSignature(download: Download): string {
  const { id, name, status, sourceType, sourceUri, torrentFilePath, savePath, totalSize, priority, category,
    selectedFiles, seedPaths, filePriorities, sequentialDownload, seedRatioLimit, seedTimeLimitMinutes,
    seedingStartedAt, maxDownloadSpeed, maxUploadSpeed, customTrackers, removedTrackers, lastError } = download;
  return JSON.stringify({ id, name, status, sourceType, sourceUri, torrentFilePath, savePath, totalSize, priority, category,
    selectedFiles, seedPaths, filePriorities, sequentialDownload, seedRatioLimit, seedTimeLimitMinutes,
    seedingStartedAt, maxDownloadSpeed, maxUploadSpeed, customTrackers, removedTrackers, lastError });
}
export type DownloadUndoError = 'expired' | 'conflict' | 'directory-missing' | 'files-missing'
  | 'metadata-unavailable' | 'too-large' | 'engine' | 'storage';
export type DownloadUndoWarning = 'vpn' | 'disk' | 'seed-limit' | 'data-changed' | 'category-missing' | 'engine' | 'verification-pending';
export interface DownloadUndoItem {
  token: string;
  downloadId: string;
  name: string;
  expiresAt: number;
  status: 'available' | 'restoring' | 'failed' | 'restored';
  operation: OwnedOperation | null;
  error?: DownloadUndoError;
  warnings?: DownloadUndoWarning[];
}
export interface DownloadUndoState { revision: number; items: DownloadUndoItem[] }
export interface DownloadRemovalResult { undo: DownloadUndoItem | null; unavailable?: DownloadUndoError }
export type DownloadUndoResult = { success: true; downloadId: string; warnings: DownloadUndoWarning[] }
  | { success: false; error: DownloadUndoError };
export class DownloadUndoFailure extends Error {
  constructor(readonly code: DownloadUndoError) { super(code); this.name = 'DownloadUndoFailure'; }
}
export function downloadUndoError(error: unknown): DownloadUndoError {
  const code = (error as { code?: unknown })?.code;
  if (['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EIO'].includes(String(code))) return 'storage';
  return ['expired', 'conflict', 'directory-missing', 'files-missing', 'metadata-unavailable', 'too-large', 'engine', 'storage'].includes(String(code))
    ? code as DownloadUndoError : 'engine';
}

export function downloadIdentity(download: Download): string | null {
  return download.infoHash && /^[a-f0-9]{40}$/i.test(download.infoHash)
    ? download.infoHash.toLowerCase() : extractInfoHashFromMagnet(download.sourceUri);
}

/** Single synchronous DB write performs the final identity check. */
export function restoreDownloadInMap(records: Record<string, Download>, input: Download, categories: readonly { id: string }[]): Download {
  if (!input || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id) || ['__proto__', 'prototype', 'constructor'].includes(input.id) || input.status === 'removed') throw new DownloadUndoFailure('storage');
  const hash = downloadIdentity(input);
  for (const current of Object.values(records)) {
    if (current.status === 'removed') continue;
    if (current.id === input.id || (hash && hash === downloadIdentity(current))
      || ((!hash || !downloadIdentity(current)) && input.sourceUri && current.sourceUri === input.sourceUri)) throw new DownloadUndoFailure('conflict');
  }
  const restored = structuredClone(input);
  restored.createdAt = new Date(input.createdAt);
  restored.updatedAt = new Date();
  if (restored.category && !categories.some(category => category.id === restored.category)) restored.category = null;
  restored.downSpeedBps = 0; restored.upSpeedBps = 0; restored.etaSeconds = null; restored.peers = 0; restored.seeds = 0;
  records[restored.id] = restored;
  return restored;
}
