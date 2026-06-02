import WebTorrent, { Torrent } from 'webtorrent';
import path from 'path';
import fs from 'fs';
import os from 'os';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { app } from 'electron';
import {
  Download,
  DownloadStatus,
  DownloadStats,
  SourceType,
  TorrentFile,
  FilePriority,
  TrackerInfo,
} from '../../shared/types';
import {
  isValidTransition,
  InvalidStateTransitionError,
  canPause,
  canResume,
  isActiveState,
} from '../../shared/state-machine';
import * as db from '../db/store';
import { logger, checkDiskSpace, formatBytes } from '../utils';

const log = logger.child('TorrentManager');

interface ManagedTorrent {
  id: string;
  torrent: Torrent | null;
  download: Download;
  infoHash: string | null;
  selectedFiles?: number[];
}

type StatsCallback = (stats: DownloadStats[]) => void;
type CompletionCallback = (info: { id: string; name: string }) => void;

/**
 * Error class for torrent operation failures
 */
export class TorrentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly downloadId?: string
  ) {
    super(message);
    this.name = 'TorrentError';
  }
}

/**
 * TorrentManager wraps WebTorrent and provides:
 * - Strict state machine for status transitions
 * - Duplicate detection via infoHash
 * - Add/pause/resume/remove functionality
 * - Concurrency limiting (max active downloads)
 * - Periodic stats broadcasting
 * - Persistence integration
 * - Comprehensive logging
 */
export class TorrentManager {
  private client: WebTorrent.Instance;
  private managedTorrents: Map<string, ManagedTorrent> = new Map();
  private infoHashIndex: Map<string, string> = new Map();
    private addingTorrents: Set<string> = new Set();
  private statsInterval: NodeJS.Timeout | null = null;
  // Stats are broadcast to the UI every tick, but persisted to disk only every
  // PERSIST_INTERVAL_MS to avoid serializing the whole store many times a second.
  private lastPersistAt = 0;
  private static readonly PERSIST_INTERVAL_MS = 5000;
  private statsCallbacks: Set<StatsCallback> = new Set();
  private completionCallbacks: Set<CompletionCallback> = new Set();
  private maxActiveDownloads = 3;
  private maxDownKbps = 0;
  private maxUpKbps = 0;
  private defaultSeedRatioLimit = 0;
  private defaultSeedTimeLimitMinutes = 0;
  
  constructor() {
    // Use an ephemeral, non-identifying BitTorrent peer ID. It carries the
    // TorrentHunt client prefix (-TH<version>-) followed by random bytes that
    // rotate every launch, so peers can't correlate sessions long-term.
    this.client = new WebTorrent({ peerId: this.generateEphemeralPeerId() } as any);

    this.client.on('error', (err: string | Error) => {
      log.error('WebTorrent client error', { error: err });
    });

    log.debug('TorrentManager instance created');
  }

  /**
   * Generate a BitTorrent peer ID in Azureus-style format: -TH0140-<random>.
   * 20 bytes total, no machine-identifying data.
   */
  private generateEphemeralPeerId(): Buffer {
    const prefix = '-TH0140-'; // TH client, v1.5.5
    const random = require('crypto').randomBytes(20 - prefix.length).toString('hex').slice(0, 20 - prefix.length);
    return Buffer.from(prefix + random);
  }
  
  /**
   * Initialize the manager - restore state from database
   */
  async initialize(): Promise<void> {
    log.info('Initializing TorrentManager');

    // Load settings
    const settings = await db.getSettings();
    this.maxActiveDownloads = settings.maxActiveDownloads;
    this.maxDownKbps = settings.maxDownKbps;
    this.maxUpKbps = settings.maxUpKbps;
    this.defaultSeedRatioLimit = settings.defaultSeedRatioLimit ?? 0;
    this.defaultSeedTimeLimitMinutes = settings.defaultSeedTimeLimitMinutes ?? 0;

    log.debug('Settings loaded', {
      maxActiveDownloads: this.maxActiveDownloads,
      maxDownKbps: this.maxDownKbps,
      maxUpKbps: this.maxUpKbps,
    });

    // Apply speed throttle to WebTorrent client (best-effort — API availability depends on version)
    if (this.maxDownKbps > 0) {
      try { (this.client as any).throttleDownload?.(this.maxDownKbps * 1024); } catch (_) { /* unsupported */ }
      log.info('Download throttle applied', { limitKbps: this.maxDownKbps });
    }
    if (this.maxUpKbps > 0) {
      try { (this.client as any).throttleUpload?.(this.maxUpKbps * 1024); } catch (_) { /* unsupported */ }
      log.info('Upload throttle applied', { limitKbps: this.maxUpKbps });
    }

    // Load all downloads; permanently purge any stale 'removed' records left by older
    // app versions that used markAsRemoved instead of deleteDownload. This prevents
    // deleted torrents from resurrecting on the next launch.
    const allDownloads = await db.getAllDownloads();
    const activeDownloads: typeof allDownloads = [];
    for (const d of allDownloads) {
      if (d.status === 'removed') {
        try { await db.deleteDownload(d.id); } catch (_) { /* ignore */ }
        log.debug('Purged stale removed record', { id: d.id });
      } else {
        activeDownloads.push(d);
      }
    }

    log.info(`Restoring ${activeDownloads.length} downloads from database`);

    for (const download of activeDownloads) {
      // Store in managed map, restoring persisted selectedFiles
      this.managedTorrents.set(download.id, {
        id: download.id,
        torrent: null,
        download,
        infoHash: null,
        selectedFiles: download.selectedFiles,
      });

      // Re-add torrents that were active
      if (['downloading', 'seeding', 'queued'].includes(download.status)) {
        await this.restoreTorrent(download);
      }
    }

    // Start stats broadcasting
    this.startStatsBroadcast();

    // Process queue
    await this.processQueue();

    log.info('TorrentManager initialized successfully');
  }
  
  /**
   * Restore a torrent from saved state
   */
  private async restoreTorrent(download: Download): Promise<void> {
    log.debug('Restoring torrent', { id: download.id, name: download.name });

    try {
      let source: string;
      
      if (download.sourceType === 'torrent_file' && download.torrentFilePath) {
        if (fs.existsSync(download.torrentFilePath)) {
          source = download.torrentFilePath;
        } else {
          throw new TorrentError('Torrent file not found', 'FILE_NOT_FOUND', download.id);
        }
      } else {
        source = download.sourceUri;
      }
      
      await this.addTorrentInternal(download.id, source, download.savePath, false, download.selectedFiles);
      log.debug('Torrent restored successfully', { id: download.id });
    } catch (error) {
      log.error('Failed to restore torrent', {
        id: download.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.transitionStatus(
        download.id,
        'error',
        error instanceof Error ? error.message : 'Failed to restore'
      );
    }
  }
  
  /**
   * Transition a download to a new status with validation
   */
  private async transitionStatus(
    id: string,
    newStatus: DownloadStatus,
    errorMessage?: string
  ): Promise<void> {
    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError('Download not found', 'NOT_FOUND', id);
    }

    const currentStatus = managed.download.status;
    
    if (!isValidTransition(currentStatus, newStatus)) {
      const error = new InvalidStateTransitionError(currentStatus, newStatus, id);
      log.warn('Invalid state transition attempted', {
        id,
        from: currentStatus,
        to: newStatus,
      });
      throw error;
    }

    log.debug('Status transition', { id, from: currentStatus, to: newStatus });
    
    await db.updateDownloadStatus(id, newStatus, errorMessage);
    // Update local state immediately so stats broadcast reflects new status
    managed.download.status = newStatus;
    if (errorMessage) {
      managed.download.lastError = errorMessage;
    } else if (newStatus !== 'error') {
      // Clear error message when transitioning out of error state
      managed.download.lastError = null;
    }
  }

  /**
   * Check for duplicate torrent by infoHash
   */
  private getDuplicateByInfoHash(infoHash: string, excludeId?: string): string | null {
    const existingId = this.infoHashIndex.get(infoHash);
    if (existingId && existingId !== excludeId) {
      const existing = this.managedTorrents.get(existingId);
      if (existing && existing.download.status !== 'removed') {
        return existingId;
      }
    }
    return null;
  }

  /**
   * Extract infoHash from a magnet URI
   */
  private extractInfoHashFromMagnet(magnetUri: string): string | null {
    try {
      const match = magnetUri.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
      return match ? match[1].toLowerCase() : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Parse torrent file to extract infoHash without adding to WebTorrent
   * Uses parse-torrent library (version 11 - CommonJS)
   */
  private async extractInfoHashFromFile(filePath: string): Promise<string | null> {
    try {
      const parseTorrent = require('parse-torrent');
      const buffer = fs.readFileSync(filePath);
      const parsed = await parseTorrent(buffer);
      
      if (parsed && parsed.infoHash) {
        log.debug('Successfully extracted infoHash from torrent file', { filePath, hash: parsed.infoHash });
        return parsed.infoHash.toLowerCase();
      }
      
      log.warn('No infoHash in parsed torrent', { filePath });
      return null;
    } catch (err) {
      log.warn('Failed to parse torrent file for infoHash', { filePath, error: err });
      return null;
    }
  }

  /**
   * Get torrent file list before adding (for selective file download)
   */
  async getTorrentInfo(params: {
    torrentPath?: string;
    magnetUri?: string;
  }): Promise<{
    name: string;
    files: { path: string; size: number; index: number }[];
    totalSize: number;
  }> {
    log.info('Getting torrent info', params);

    return new Promise((resolve, reject) => {
      const tempClient = new WebTorrent();
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          tempClient.destroy();
          reject(new TorrentError('Timeout loading torrent information', 'TIMEOUT'));
        }
      }, 30000); // 30 second timeout

      try {
        const sourceUri = params.torrentPath || params.magnetUri;
        if (!sourceUri) {
          reject(new TorrentError('No torrent path or magnet URI provided', 'INVALID_INPUT'));
          return;
        }

        let sourceInput: string | Buffer = sourceUri;
        if (params.torrentPath && fs.existsSync(params.torrentPath)) {
          sourceInput = fs.readFileSync(params.torrentPath);
        }

        tempClient.add(sourceInput, { path: app.getPath('temp') }, (torrent) => {
          if (resolved) return;
          
          clearTimeout(timeout);
          resolved = true;

          const files = torrent.files.map((file, index) => ({
            path: file.path,
            size: file.length,
            index,
          }));

          const totalSize = files.reduce((sum, f) => sum + f.size, 0);

          const result = {
            name: torrent.name,
            files,
            totalSize,
          };

          log.info('Torrent info loaded', { 
            name: result.name, 
            fileCount: files.length,
            totalSize: formatBytes(totalSize)
          });

          // Cleanup
          tempClient.remove(torrent.infoHash, { destroyStore: true }, () => {
            tempClient.destroy();
          });

          resolve(result);
        });

        tempClient.on('error', (err) => {
          if (resolved) return;
          
          clearTimeout(timeout);
          resolved = true;
          tempClient.destroy();
          
          log.error('Error loading torrent info', { error: err });
          reject(new TorrentError(
            `Failed to load torrent: ${err instanceof Error ? err.message : String(err)}`,
            'LOAD_ERROR'
          ));
        });
      } catch (err) {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          tempClient.destroy();
          reject(err);
        }
      }
    });
  }

  /**
   * Add a new download with duplicate prevention
   */
  /**
   * Download a remote .torrent file to a temp path so the rest of the add flow
   * (infoHash extraction, copy into app data) can treat it like a local file.
   * Reads the body as binary and follows redirects (archive.org/download/...
   * redirects to a CDN host). Used for search/RSS results that expose an HTTP
   * .torrent URL rather than a magnet link.
   */
  private downloadTorrentToTemp(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const get = (current: string, redirects: number): void => {
        if (redirects > 5) {
          reject(new Error('Too many redirects fetching .torrent'));
          return;
        }
        const parsed = new URL(current);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.get(current, {
          headers: { 'User-Agent': 'TorrentHunt', 'Accept': 'application/x-bittorrent, */*' },
          timeout: 30000,
        }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            get(new URL(res.headers.location, current).toString(), redirects + 1);
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} fetching .torrent file`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              const buf = Buffer.concat(chunks);
              // Bencoded .torrent files start with 'd' (a dictionary)
              if (buf.length === 0 || buf[0] !== 0x64) {
                reject(new Error('Downloaded file is not a valid .torrent'));
                return;
              }
              let base = path.basename(parsed.pathname) || 'download.torrent';
              if (!base.toLowerCase().endsWith('.torrent')) base += '.torrent';
              const file = path.join(os.tmpdir(), `th_${Date.now()}_${base}`);
              fs.writeFileSync(file, buf);
              resolve(file);
            } catch (e) {
              reject(e);
            }
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout fetching .torrent file')); });
      };
      get(url, 0);
    });
  }

  async addDownload(params: {
    sourceType: SourceType;
    sourceUri: string;
    savePath?: string;
    name?: string;
    selectedFiles?: number[];
  }): Promise<Download> {
    log.info('Adding new download', { sourceType: params.sourceType, name: params.name });

    // For torrent files given as an HTTP(S) URL (search/RSS results), fetch the
    // .torrent to a temp file first so the rest of the flow can read it locally.
    let localTorrentPath = params.sourceUri;
    let tempTorrentToCleanup: string | null = null;
    if (params.sourceType === 'torrent_file' && /^https?:\/\//i.test(params.sourceUri)) {
      localTorrentPath = await this.downloadTorrentToTemp(params.sourceUri);
      tempTorrentToCleanup = localTorrentPath;
      log.debug('Fetched remote .torrent to temp', { url: params.sourceUri, temp: localTorrentPath });
    }

    // 1. Extract infoHash early to check for duplicates BEFORE adding
    let infoHashToCheck: string | null = null;

    if (params.sourceType === 'magnet') {
      infoHashToCheck = this.extractInfoHashFromMagnet(params.sourceUri);
      log.debug('Extracted infoHash from magnet', { infoHash: infoHashToCheck });
    } else if (params.sourceType === 'torrent_file') {
      infoHashToCheck = await this.extractInfoHashFromFile(localTorrentPath);
      log.debug('Extracted infoHash from torrent file', { infoHash: infoHashToCheck, filePath: localTorrentPath });
    }
    
    log.info('Checking for duplicates', { 
      infoHashToCheck, 
      indexSize: this.infoHashIndex.size,
      managedCount: this.managedTorrents.size 
    });

    // 2. Check for duplicates by infoHash - check BOTH index and all managed torrents
    if (infoHashToCheck) {
      // Check if already being added (race condition protection)
      if (this.addingTorrents.has(infoHashToCheck)) {
        const errorMessage = 'This torrent is already being added, please wait';
        log.warn('Duplicate torrent rejected (currently being added)', {
          infoHash: infoHashToCheck
        });
        throw new TorrentError(errorMessage, 'DUPLICATE');
      }

      // Mark as being added
      this.addingTorrents.add(infoHashToCheck);
      log.debug('Marked torrent as being added', { infoHash: infoHashToCheck });
    }

    try {
      // Continue with duplicate checks
      if (infoHashToCheck) {
        // Check index first
        const existingId = this.infoHashIndex.get(infoHashToCheck);
        if (existingId) {
          const existing = this.managedTorrents.get(existingId);
          if (existing && existing.download.status !== 'removed') {
            const errorMessage = `This torrent is already in downloads: "${existing.download.name}"`;
            log.warn('Duplicate torrent rejected (by infoHash index)', {
              infoHash: infoHashToCheck,
              existingId,
              existingName: existing.download.name
            });
            throw new TorrentError(errorMessage, 'DUPLICATE');
          }
        }

        // Also check all managed torrents directly (in case index is out of sync)
        for (const [existingId, managed] of this.managedTorrents.entries()) {
          if (managed.download.status === 'removed') continue;
          if (managed.infoHash === infoHashToCheck) {
            const errorMessage = `This torrent is already in downloads: "${managed.download.name}"`;
            log.warn('Duplicate torrent rejected (by managed torrents scan)', {
              infoHash: infoHashToCheck,
              existingId,
              existingName: managed.download.name
            });
            throw new TorrentError(errorMessage, 'DUPLICATE');
          }
        }
      }

      // 3. Fallback: check by source URI (for cases where infoHash couldn't be extracted)
      for (const [existingId, managed] of this.managedTorrents.entries()) {
        if (managed.download.status === 'removed') continue;

        if (params.sourceType === 'magnet' && managed.download.sourceType === 'magnet') {
          if (managed.download.sourceUri === params.sourceUri) {
            const errorMessage = `This torrent is already in downloads: "${managed.download.name}"`;
            log.warn('Duplicate torrent rejected (by magnet URI)', {
              existingId,
              existingName: managed.download.name
            });
            throw new TorrentError(errorMessage, 'DUPLICATE');
          }
        }
      }

      // 4. Check by torrent file name to prevent downloading the same file twice
      if (params.name && params.name !== 'Loading...') {
        for (const [existingId, managed] of this.managedTorrents.entries()) {
          if (managed.download.status === 'removed') continue;

          // Compare normalized names (case-insensitive, trimmed)
          const normalizedNewName = params.name.toLowerCase().trim();
          const normalizedExistingName = managed.download.name.toLowerCase().trim();

          if (normalizedNewName === normalizedExistingName) {
            const errorMessage = `Torrent with this name is already in downloads: "${managed.download.name}"`;
            log.warn('Duplicate torrent rejected (by name)', {
              existingId,
              existingName: managed.download.name,
              newName: params.name
            });
            throw new TorrentError(errorMessage, 'DUPLICATE');
          }
        }
      }

      const settings = await db.getSettings();
      const savePath = params.savePath || settings.defaultDownloadDir;

      // Ensure save directory exists
      if (!fs.existsSync(savePath)) {
        fs.mkdirSync(savePath, { recursive: true });
      }

      // Check available disk space
      const availableSpace = await checkDiskSpace(savePath);
      const minimumRequired = 100 * 1024 * 1024; // 100 MB minimum

      if (availableSpace !== null && availableSpace < minimumRequired) {
        const errorMessage = `Not enough disk space. Available: ${formatBytes(availableSpace)}, minimum required: ${formatBytes(minimumRequired)}`;
        log.error('Insufficient disk space', {
          savePath,
          available: availableSpace,
          required: minimumRequired,
          formatted: formatBytes(availableSpace)
        });
        throw new TorrentError(errorMessage, 'NO_SPACE');
      }

      if (availableSpace !== null) {
        log.info('Disk space check passed', {
          savePath,
          available: formatBytes(availableSpace)
        });
      } else {
        log.warn('Could not verify disk space', { savePath });
      }

      let torrentFilePath: string | undefined;
      const sourceUri = params.sourceUri;

      // If it's a torrent file, copy it (local path or freshly-fetched temp) to app data
      if (params.sourceType === 'torrent_file') {
        const appDataDir = path.join(app.getPath('userData'), 'torrents');
        if (!fs.existsSync(appDataDir)) {
          fs.mkdirSync(appDataDir, { recursive: true });
        }

        const fileName = path.basename(localTorrentPath);
        torrentFilePath = path.join(appDataDir, `${Date.now()}_${fileName}`);
        fs.copyFileSync(localTorrentPath, torrentFilePath);
        log.debug('Torrent file copied', { from: localTorrentPath, to: torrentFilePath });
      }

      // Create database record
      const download = await db.createDownload({
        name: params.name || 'Loading...',
        sourceType: params.sourceType,
        sourceUri,
        torrentFilePath,
        savePath,
        status: 'queued',
        selectedFiles: params.selectedFiles,
      });

      log.info('Download record created', { id: download.id });

      // Add to managed torrents
      this.managedTorrents.set(download.id, {
        id: download.id,
        torrent: null,
        download,
        infoHash: infoHashToCheck,
        selectedFiles: params.selectedFiles,
      });

      // Register infoHash immediately to prevent race conditions with duplicate detection
      if (infoHashToCheck) {
        this.infoHashIndex.set(infoHashToCheck, download.id);
        log.debug('InfoHash registered early', { id: download.id, infoHash: infoHashToCheck });
      }

      // Process queue to potentially start this download
      await this.processQueue();

      return download;
    } finally {
      // Always clean up the adding marker, even if an error occurred
      if (infoHashToCheck) {
        this.addingTorrents.delete(infoHashToCheck);
        log.debug('Removed torrent from adding set', { infoHash: infoHashToCheck });
      }
      // Remove the temp .torrent we fetched (it's been copied into app data)
      if (tempTorrentToCleanup) {
        try {
          fs.unlinkSync(tempTorrentToCleanup);
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  /**
   * Internal method to add torrent to WebTorrent client
   */
  private async addTorrentInternal(
    id: string,
    source: string,
    savePath: string,
    isNew: boolean,
    selectedFiles?: number[]
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const managed = this.managedTorrents.get(id);
      if (!managed) {
        reject(new TorrentError('Download not found', 'NOT_FOUND', id));
        return;
      }
      
      // Prepare torrent input
      let torrentInput: string | Buffer = source;
      if (source.endsWith('.torrent') && fs.existsSync(source)) {
        torrentInput = fs.readFileSync(source);
      }
      
      // Add torrent with options
      const addOptions: any = {
        path: savePath,
      };
      
      // If selectedFiles is provided, configure file selection
      if (selectedFiles && selectedFiles.length > 0) {
        log.info('Adding torrent with selective file download', {
          id,
          selectedCount: selectedFiles.length,
        });
      }
      
      const torrent = this.client.add(torrentInput, addOptions);
      
      managed.torrent = torrent;
      
      // Transition to downloading only if not already in a terminal/active state
      // When restoring, we preserve the existing state (e.g., seeding, completed)
      const currentStatus = managed.download.status;
      if (isNew || currentStatus === 'queued' || currentStatus === 'paused') {
        // Only transition for new downloads or resuming from queued/paused
        this.transitionStatus(id, 'downloading').catch((err) => {
          log.error('Failed to transition to downloading', { id, error: err });
        });
      } else {
        log.debug('Preserving existing state during restore', { id, status: currentStatus });
      }
      
      torrent.on('ready', async () => {
        // Apply file selection after torrent is ready
        if (selectedFiles && selectedFiles.length > 0) {
          try {
            // Deselect all files first
            torrent.files.forEach((file) => file.deselect());
            
            // Select only chosen files
            selectedFiles.forEach((index) => {
              if (index < torrent.files.length) {
                torrent.files[index].select();
                log.debug('Selected file for download', { 
                  id, 
                  index, 
                  path: torrent.files[index].path 
                });
              }
            });
            
            log.info('Applied selective file download', {
              id,
              totalFiles: torrent.files.length,
              selectedFiles: selectedFiles.length,
            });
          } catch (err) {
            log.error('Failed to apply file selection', { id, error: err });
          }
        }
        // Store infoHash for duplicate detection
        const infoHash = torrent.infoHash;
        
        // Update infoHash if it wasn't available before (shouldn't happen normally)
        if (!managed.infoHash) {
          managed.infoHash = infoHash;
          this.infoHashIndex.set(infoHash, id);
          log.debug('InfoHash registered from ready event', { id, infoHash });
        }

        // Check for duplicates (safety check)
        const duplicateId = this.getDuplicateByInfoHash(infoHash, id);
        if (duplicateId) {
          const duplicateDownload = this.managedTorrents.get(duplicateId);
          const duplicateName = duplicateDownload?.download.name || 'Unknown';
          log.warn('Duplicate torrent detected', { id, duplicateId, infoHash, duplicateName });
          
          // Remove this torrent and keep the existing one
          try {
            this.client.remove(torrent);
            log.debug('Duplicate torrent removed from WebTorrent', { id });
          } catch (e) {
            log.error('Failed to remove duplicate torrent', { id, error: e });
          }
          managed.torrent = null;
          managed.infoHash = null;
          
          const errorMessage = `This torrent is already added: "${duplicateName}"`;
          
        // Completely remove duplicate from system — use hard delete to prevent resurrection
          await db.deleteDownload(id);
          this.managedTorrents.delete(id);
          
          reject(new TorrentError(errorMessage, 'DUPLICATE', id));
          return;
        }

        // Update name and totalSize from torrent metadata
        const name = torrent.name || 'Unknown';
        const totalSize = torrent.length || 0;
        managed.download.name = name;
        managed.download.totalSize = totalSize;

        log.debug('Torrent ready', { id, name, infoHash, totalSize });

        // Update database with torrent metadata
        if (isNew || managed.download.name === 'Loading...') {
          await db.updateDownloadProgress(id, {
            progress: torrent.progress,
            downloadedBytes: torrent.downloaded,
            uploadedBytes: torrent.uploaded,
            downSpeedBps: torrent.downloadSpeed,
            upSpeedBps: torrent.uploadSpeed,
            etaSeconds: torrent.timeRemaining > 0 ? Math.floor(torrent.timeRemaining / 1000) : null,
            peers: torrent.numPeers,
            seeds: 0,
            name,
            totalSize,
          });
        }

        resolve();
      });
      
      torrent.on('done', async () => {
        log.info('Torrent completed', { id, name: managed.download.name });
        if (managed.download.status === 'downloading') {
          await this.transitionStatus(id, 'seeding');
          // Record when seeding started for time-limit tracking
          await db.updateDownloadField(id, 'seedingStartedAt', Date.now());
          managed.download.seedingStartedAt = Date.now();
          // Notify completion listeners (used for OS notifications)
          for (const cb of this.completionCallbacks) {
            try { cb({ id, name: managed.download.name }); } catch (_) { /* ignore */ }
          }
        }
      });

      
      // WebTorrent types are incomplete - error event exists but isn't typed correctly
      (torrent as unknown as NodeJS.EventEmitter).on('error', async (err: Error) => {
        log.error('Torrent error', {
          id,
          error: err?.message || String(err),
        });
        
        const errorMsg = err?.message || String(err);
        
        try {
          await this.transitionStatus(id, 'error', errorMsg);
        } catch (e) {
          // Status transition might fail if already in error state
          log.warn('Could not transition to error state', { id });
        }
        
        // Process queue to start next download
        this.processQueue();
      });
      
      // If the download was paused, pause immediately
      if (managed.download.status === 'paused') {
        torrent.pause();
      }
    });
  }
  
  /**
   * Process the download queue
   */
  private async processQueue(): Promise<void> {
    const activeCount = this.getActiveCount();

    log.debug('Processing queue', { activeCount, maxActive: this.maxActiveDownloads });

    if (activeCount >= this.maxActiveDownloads) {
      log.debug('Max active downloads reached, skipping queue processing');
      return;
    }

    // Find queued downloads, sorted by priority (2=high → 1=normal → 0=low)
    const queued = await db.getDownloadsByStatus('queued');
    queued.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const slotsAvailable = this.maxActiveDownloads - activeCount;

    log.debug('Queue status', { queuedCount: queued.length, slotsAvailable });

    for (let i = 0; i < Math.min(queued.length, slotsAvailable); i++) {
      const download = queued[i];
      const managed = this.managedTorrents.get(download.id);

      if (managed && !managed.torrent) {
        try {
          let source: string;
          if (download.sourceType === 'torrent_file' && download.torrentFilePath) {
            source = download.torrentFilePath;
          } else {
            source = download.sourceUri;
          }

          log.debug('Starting queued download', { id: download.id, priority: download.priority });
          await this.addTorrentInternal(
            download.id,
            source,
            download.savePath,
            true,
            managed.selectedFiles
          );
        } catch (error) {
          log.error('Failed to start queued download', {
            id: download.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  
  /**
   * Get count of currently active downloads
   */
  private getActiveCount(): number {
    let count = 0;
    for (const managed of this.managedTorrents.values()) {
      if (managed.torrent && isActiveState(managed.download.status)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Safely delete a path recursively with retry logic
   */
  private async deletePathRecursive(targetPath: string, downloadId: string): Promise<void> {
    const maxRetries = 3;
    const retryDelay = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!fs.existsSync(targetPath)) {
          log.debug('Path does not exist, skipping deletion', { path: targetPath });
          return;
        }

        const stat = fs.statSync(targetPath);

        if (stat.isDirectory()) {
          // First, recursively delete all contents
          const items = fs.readdirSync(targetPath);
          for (const item of items) {
            const itemPath = path.join(targetPath, item);
            await this.deletePathRecursive(itemPath, downloadId);
          }

          // Then delete the empty directory
          fs.rmdirSync(targetPath);
          log.debug('Deleted directory', { path: targetPath });
        } else {
          // Delete file
          fs.unlinkSync(targetPath);
          log.debug('Deleted file', { path: targetPath });
        }

        return; // Success
      } catch (e) {
        const error = e as NodeJS.ErrnoException;
        const errorMsg = error.message || String(e);

        if (attempt < maxRetries) {
          // Retry on permission errors or "directory not empty" errors
          if (error.code === 'EPERM' || error.code === 'ENOTEMPTY' || error.code === 'EBUSY') {
            log.warn(`Delete attempt ${attempt} failed, retrying...`, {
              path: targetPath,
              error: errorMsg,
              code: error.code,
            });
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            continue;
          }
        }

        // Final attempt failed or non-retryable error
        log.error('Failed to delete path after retries', {
          id: downloadId,
          path: targetPath,
          error: errorMsg,
          code: error.code,
          attempts: attempt,
        });
        return; // Don't throw, just log the error
      }
    }
  }

  /**
   * Pause a download
   */
  async pauseDownload(id: string): Promise<void> {
    log.info('Pausing download', { id });

    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError('Download not found', 'NOT_FOUND', id);
    }
    
    // Check if the current state can pause
    const currentStatus = managed.download.status;
    if (!canPause(currentStatus)) {
      throw new TorrentError(
        `Cannot pause download in ${currentStatus} state`,
        'INVALID_STATE',
        id
      );
    }
    
    // Validate state transition before attempting pause
    if (!isValidTransition(currentStatus, 'paused')) {
      throw new TorrentError(
        `Invalid state transition from ${currentStatus} to paused`,
        'INVALID_STATE',
        id
      );
    }
    
    // Destroy the WebTorrent instance to actually stop data transfer.
    // WebTorrent 1.9.7 does not reliably support torrent.pause().
    // Data on disk is preserved (destroyStore: false).
    if (managed.torrent) {
      log.debug('Destroying torrent instance for pause', { id, infoHash: managed.infoHash });
      try {
        managed.torrent.destroy({ destroyStore: false } as any);
      } catch (e) {
        log.warn('Error destroying torrent during pause (non-fatal)', { error: String(e) });
      }
      managed.torrent = null;
    }

    await this.transitionStatus(id, 'paused');

    // Process queue to start next download
    await this.processQueue();

    log.debug('Download paused successfully', { id });
  }
  
  /**
   * Resume a download
   */
  async resumeDownload(id: string): Promise<void> {
    log.info('Resuming download', { id });

    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError('Download not found', 'NOT_FOUND', id);
    }
    
    if (!canResume(managed.download.status)) {
      throw new TorrentError(
        `Cannot resume download in ${managed.download.status} state`,
        'INVALID_STATE',
        id
      );
    }
    
    if (managed.torrent) {
      // Torrent still in memory but shouldn't be — destroy it cleanly first
      log.debug('Torrent still in memory on resume, destroying first', { id });
      try {
        managed.torrent.destroy({ destroyStore: false } as any);
      } catch (_) { /* ignore */ }
      managed.torrent = null;
    }

    // Re-queue the download so processQueue will re-add it to WebTorrent
    log.debug('Re-queueing download for resume', { id });
    await this.transitionStatus(id, 'queued');
    await this.processQueue();

    log.debug('Download resumed successfully', { id });
  }

  /**
   * Remove a download
   */
  async removeDownload(id: string, deleteFiles: boolean): Promise<void> {
    log.info('Removing download', { id, deleteFiles, idType: typeof id, deleteFilesType: typeof deleteFiles });

    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError(`Download not found: ${id}`, 'NOT_FOUND', id);
    }
    
    // Remove from infoHash index
    if (managed.infoHash) {
      this.infoHashIndex.delete(managed.infoHash);
    }

    // Remove from WebTorrent if torrent exists
    if (managed.torrent) {
      try {
        // Check if torrent is in client before removing
        const torrentInClient = this.client.torrents.find(t => t === managed.torrent);
        if (torrentInClient) {
          this.client.remove(managed.torrent);
          log.debug('Torrent removed from WebTorrent', { id });
        } else {
          log.debug('Torrent not in WebTorrent client, skipping removal', { id });
        }
      } catch (e) {
        log.error('Failed to remove torrent from WebTorrent', { id, error: e });
        // Don't throw - continue with cleanup even if WebTorrent removal fails
      }
    }
    
    // Delete files if requested
    if (deleteFiles) {
      // Wait a bit for file handles to be released
      await new Promise(resolve => setTimeout(resolve, 500));

      const downloadPath = managed.download.savePath;
      if (fs.existsSync(downloadPath)) {
        const downloadName = managed.download.name;
        const targetPath = path.join(downloadPath, downloadName);

        if (fs.existsSync(targetPath)) {
          await this.deletePathRecursive(targetPath, id);
        }
      }
    }
    
    // Clean up stored torrent file if exists
    if (managed.download.torrentFilePath && fs.existsSync(managed.download.torrentFilePath)) {
      try {
        fs.unlinkSync(managed.download.torrentFilePath);
        log.debug('Deleted stored torrent file', { path: managed.download.torrentFilePath });
      } catch (e) {
        log.warn('Failed to delete stored torrent file', {
          path: managed.download.torrentFilePath,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    
    // Permanently delete from database — prevents resurrection on next launch
    await db.deleteDownload(id);
    log.debug('Download deleted from store', { id });
    
    // Remove from managed map
    this.managedTorrents.delete(id);
    
    // Remove from infoHash index to prevent memory leaks
    if (managed.infoHash) {
      this.infoHashIndex.delete(managed.infoHash);
      log.debug('Removed from infoHash index', { id, infoHash: managed.infoHash });
    }
    
    // Process queue
    await this.processQueue();

    log.info('Download removed successfully', { id });
  }
  
  /**
   * Stop seeding a completed download
   */
  async stopSeeding(id: string): Promise<void> {
    log.info('Stopping seeding', { id });

    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError('Download not found', 'NOT_FOUND', id);
    }
    
    if (managed.download.status !== 'seeding') {
      throw new TorrentError(
        'Download is not seeding',
        'INVALID_STATE',
        id
      );
    }

    if (managed.torrent) {
      managed.torrent.pause();
    }
    
    await this.transitionStatus(id, 'completed');

    log.debug('Seeding stopped', { id });
  }
  
  /**
   * Retry a failed download
   */
  async retryDownload(id: string): Promise<void> {
    log.info('Retrying download', { id });

    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError('Download not found', 'NOT_FOUND', id);
    }
    
    if (managed.download.status !== 'error') {
      throw new TorrentError(
        'Can only retry downloads in error state',
        'INVALID_STATE',
        id
      );
    }
    
    // Re-queue (transitionStatus will clear the error)
    await this.transitionStatus(id, 'queued');
    
    // Process queue
    await this.processQueue();

    log.debug('Download re-queued for retry', { id });
  }

  /**
   * Get all downloads
   */
  async getDownloads(): Promise<Download[]> {
    return db.getAllDownloads();
  }

  /**
   * Pause every active torrent (downloading / queued / seeding).
   * Used by the VPN kill-switch and the tray "Pause All" action.
   * Returns the number of torrents that were paused.
   */
  async pauseAllActive(): Promise<number> {
    let paused = 0;
    for (const [id, managed] of this.managedTorrents) {
      const status = managed.download.status;
      if (status === 'downloading' || status === 'queued' || status === 'seeding') {
        try {
          await this.pauseDownload(id);
          paused++;
        } catch (e) {
          log.warn('pauseAllActive: failed to pause one torrent', { id, error: String(e) });
        }
      }
    }
    log.info('Paused all active torrents', { count: paused });
    return paused;
  }

  /**
   * Get files for a specific download
   */
  async getFiles(id: string): Promise<TorrentFile[]> {
    const managed = this.managedTorrents.get(id);
    if (!managed) {
      // If not in memory, check DB to confirm it exists
      const download = await db.getDownloadById(id);
      if (!download) {
        throw new TorrentError('Download not found', 'NOT_FOUND', id);
      }
      return [];
    }

    if (managed.torrent && managed.torrent.files) {
      return managed.torrent.files.map(file => ({
        name: file.name,
        path: file.path,
        length: file.length,
        downloaded: file.downloaded,
        progress: file.progress || (file.length > 0 ? file.downloaded / file.length : 0),
      }));
    }
    
    return [];
  }
  
  /**
   * Get current stats for all managed torrents
   */
  getStats(): DownloadStats[] {
    const stats: DownloadStats[] = [];
    
    for (const managed of this.managedTorrents.values()) {
      const torrent = managed.torrent;
      const download = managed.download;
      
      if (download.status === 'removed') continue;
      
      if (torrent) {
        stats.push({
          id: download.id,
          progress: torrent.progress,
          downloadedBytes: torrent.downloaded,
          uploadedBytes: torrent.uploaded,
          downSpeedBps: torrent.downloadSpeed,
          upSpeedBps: torrent.uploadSpeed,
          etaSeconds: torrent.timeRemaining > 0 ? Math.floor(torrent.timeRemaining / 1000) : null,
          peers: torrent.numPeers,
          // WebTorrent doesn't distinguish seeds from peers; show numPeers when seeding
          seeds: download.status === 'seeding' ? torrent.numPeers : 0,
          status: download.status,
        });
      } else {
        stats.push({
          id: download.id,
          progress: download.progress,
          downloadedBytes: download.downloadedBytes,
          uploadedBytes: download.uploadedBytes,
          downSpeedBps: 0,
          upSpeedBps: 0,
          etaSeconds: null,
          peers: 0,
          seeds: 0,
          status: download.status,
        });
      }
    }
    
    return stats;
  }
  
  /**
   * Subscribe to stats updates
   */
  onStats(callback: StatsCallback): () => void {
    this.statsCallbacks.add(callback);
    return () => {
      this.statsCallbacks.delete(callback);
    };
  }

  /**
   * Subscribe to download completion events (for OS notifications)
   */
  onComplete(callback: CompletionCallback): () => void {
    this.completionCallbacks.add(callback);
    return () => {
      this.completionCallbacks.delete(callback);
    };
  }
  
  /**
   * Start periodic stats broadcasting
   */
  private startStatsBroadcast(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    
    this.statsInterval = setInterval(async () => {
      const stats = this.getStats();

      // Broadcast to callbacks every tick (in-memory, cheap) so the UI stays smooth
      for (const callback of this.statsCallbacks) {
        try {
          callback(stats);
        } catch (e) {
          log.error('Stats callback error', { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // Persist to disk only every PERSIST_INTERVAL_MS, batched into one write
      const now = Date.now();
      if (now - this.lastPersistAt >= TorrentManager.PERSIST_INTERVAL_MS) {
        this.lastPersistAt = now;
        try {
          await db.updateDownloadsProgressBatch(stats.map(stat => ({
            id: stat.id,
            progress: stat.progress,
            downloadedBytes: stat.downloadedBytes,
            uploadedBytes: stat.uploadedBytes,
            downSpeedBps: stat.downSpeedBps,
            upSpeedBps: stat.upSpeedBps,
            etaSeconds: stat.etaSeconds,
            peers: stat.peers,
            seeds: stat.seeds,
          })));
        } catch (e) {
          log.error('Failed to persist download progress', { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // Check seeding limits (ratio + time)
      await this.checkSeedingLimits();
    }, 750);
 // 750ms interval

    log.debug('Stats broadcast started');
  }
  
  /**
   * Update manager settings
   */
  async updateSettings(settings: {
    maxActiveDownloads?: number;
    maxDownKbps?: number;
    maxUpKbps?: number;
    defaultSeedRatioLimit?: number;
    defaultSeedTimeLimitMinutes?: number;
  }): Promise<void> {
    log.debug('Updating settings', settings);

    if (settings.maxActiveDownloads !== undefined) {
      this.maxActiveDownloads = settings.maxActiveDownloads;
    }
    if (settings.maxDownKbps !== undefined) {
      this.maxDownKbps = settings.maxDownKbps;
      try { (this.client as any).throttleDownload?.(this.maxDownKbps > 0 ? this.maxDownKbps * 1024 : 0); } catch (_) { /* unsupported */ }
    }
    if (settings.maxUpKbps !== undefined) {
      this.maxUpKbps = settings.maxUpKbps;
      try { (this.client as any).throttleUpload?.(this.maxUpKbps > 0 ? this.maxUpKbps * 1024 : 0); } catch (_) { /* unsupported */ }
    }
    if (settings.defaultSeedRatioLimit !== undefined) {
      this.defaultSeedRatioLimit = settings.defaultSeedRatioLimit;
    }
    if (settings.defaultSeedTimeLimitMinutes !== undefined) {
      this.defaultSeedTimeLimitMinutes = settings.defaultSeedTimeLimitMinutes;
    }

    await this.processQueue();
  }

  // ============================================================
  // Priority 1: New Engine Features
  // ============================================================

  /**
   * Toggle sequential download mode.
   * In WebTorrent this is approximated by controlling file select/deselect order.
   */
  async setSequentialDownload(id: string, enabled: boolean): Promise<void> {
    const managed = this.managedTorrents.get(id);
    if (!managed) throw new TorrentError('Download not found', 'NOT_FOUND', id);

    managed.download.sequentialDownload = enabled;
    await db.updateDownloadField(id, 'sequentialDownload', enabled);

    if (managed.torrent) {
      try {
        // WebTorrent: enable criticalLength to download pieces sequentially
        if (enabled) {
          // Select files in order to force sequential piece selection
          managed.torrent.files.forEach((file, i) => {
            file.select();
          });
          // If the torrent library supports it, try to set sequential mode
          (managed.torrent as any).critical?.(0, managed.torrent.pieces?.length ?? 0);
        }
      } catch (_) { /* unsupported — best effort */ }
    }

    log.info('Sequential download set', { id, enabled });
  }

  /**
   * Set per-file download priority.
   * 'skip' = deselect (don't download), others = select.
   */
  async setFilePriority(id: string, fileIndex: number, priority: FilePriority): Promise<void> {
    const managed = this.managedTorrents.get(id);
    if (!managed) throw new TorrentError('Download not found', 'NOT_FOUND', id);

    // Persist priority
    const priorities = managed.download.filePriorities ?? [];
    priorities[fileIndex] = priority;
    managed.download.filePriorities = priorities;
    await db.updateDownloadField(id, 'filePriorities', priorities);

    if (managed.torrent) {
      const file = managed.torrent.files[fileIndex];
      if (file) {
        if (priority === 'skip') {
          file.deselect();
          log.info('File deselected (skip)', { id, fileIndex, name: file.name });
        } else {
          file.select();
          log.info('File selected', { id, fileIndex, name: file.name, priority });
        }
      }
    }
  }

  /**
   * Set per-torrent speed limits (overrides global limits for this torrent).
   */
  async setTorrentSpeedLimits(id: string, downKbps: number, upKbps: number): Promise<void> {
    const managed = this.managedTorrents.get(id);
    if (!managed) throw new TorrentError('Download not found', 'NOT_FOUND', id);

    managed.download.maxDownloadSpeed = downKbps;
    managed.download.maxUploadSpeed = upKbps;
    await db.updateDownloadFields(id, { maxDownloadSpeed: downKbps, maxUploadSpeed: upKbps });

    if (managed.torrent) {
      try {
        (managed.torrent as any).throttleDownload?.(downKbps > 0 ? downKbps * 1024 : 0);
      } catch (_) { /* unsupported */ }
      try {
        (managed.torrent as any).throttleUpload?.(upKbps > 0 ? upKbps * 1024 : 0);
      } catch (_) { /* unsupported */ }
    }

    log.info('Per-torrent speed limits set', { id, downKbps, upKbps });
  }

  /**
   * Set seed ratio limit for a specific torrent.
   * 0 = unlimited (use global default).
   */
  async setSeedRatioLimit(id: string, ratio: number): Promise<void> {
    const managed = this.managedTorrents.get(id);
    if (!managed) throw new TorrentError('Download not found', 'NOT_FOUND', id);

    managed.download.seedRatioLimit = ratio;
    await db.updateDownloadField(id, 'seedRatioLimit', ratio);
    log.info('Seed ratio limit set', { id, ratio });
  }

  /**
   * Set seed time limit for a specific torrent.
   * 0 = unlimited.
   */
  async setSeedTimeLimit(id: string, minutes: number): Promise<void> {
    const managed = this.managedTorrents.get(id);
    if (!managed) throw new TorrentError('Download not found', 'NOT_FOUND', id);

    managed.download.seedTimeLimitMinutes = minutes;
    await db.updateDownloadField(id, 'seedTimeLimitMinutes', minutes);
    log.info('Seed time limit set', { id, minutes });
  }

  /**
   * Get current tracker info for a torrent.
   */
  getTrackers(id: string): TrackerInfo[] {
    const managed = this.managedTorrents.get(id);
    if (!managed?.torrent) return [];

    try {
      const trackers: any[] = (managed.torrent as any)._trackers ?? [];
      return trackers.map((t: any): TrackerInfo => ({
        url: t.announce || t.announceUrl || String(t),
        status: t.destroy ? 'connected' : 'disconnected',
        peers: typeof t.peers === 'number' ? t.peers : 0,
        lastAnnounce: t.lastAnnounce ? new Date(t.lastAnnounce).toISOString() : undefined,
      }));
    } catch (_) {
      return [];
    }
  }

  /**
   * Add a tracker URL to an active torrent.
   */
  addTracker(id: string, url: string): void {
    const managed = this.managedTorrents.get(id);
    if (!managed?.torrent) throw new TorrentError('Download not active', 'INVALID_STATE', id);

    try {
      (managed.torrent as any).addTracker?.(url);
      log.info('Tracker added', { id, url });
    } catch (err) {
      log.warn('addTracker not supported by WebTorrent version', { error: err });
    }
  }

  /**
   * Remove a tracker URL from an active torrent.
   */
  removeTracker(id: string, url: string): void {
    const managed = this.managedTorrents.get(id);
    if (!managed?.torrent) throw new TorrentError('Download not active', 'INVALID_STATE', id);

    try {
      (managed.torrent as any).removeTracker?.(url);
      log.info('Tracker removed', { id, url });
    } catch (err) {
      log.warn('removeTracker not supported by WebTorrent version', { error: err });
    }
  }

  /**
   * Check seeding limits (ratio + time) for all seeding torrents.
   * Called every stats tick.
   */
  private async checkSeedingLimits(): Promise<void> {
    for (const managed of this.managedTorrents.values()) {
      if (managed.download.status !== 'seeding') continue;

      const d = managed.download;
      const ratio = d.downloadedBytes > 0 ? d.uploadedBytes / d.downloadedBytes : 0;

      // Effective ratio limit: per-torrent overrides global
      const ratioLimit = (d.seedRatioLimit != null && d.seedRatioLimit > 0)
        ? d.seedRatioLimit
        : this.defaultSeedRatioLimit;

      if (ratioLimit > 0 && ratio >= ratioLimit) {
        log.info('Auto-stopped seeding (ratio limit reached)', { id: managed.id, ratio: ratio.toFixed(2), limit: ratioLimit });
        try { await this.stopSeeding(managed.id); } catch (_) { /* already stopped */ }
        continue;
      }

      // Effective time limit: per-torrent overrides global
      const timeLimit = (d.seedTimeLimitMinutes != null && d.seedTimeLimitMinutes > 0)
        ? d.seedTimeLimitMinutes
        : this.defaultSeedTimeLimitMinutes;

      if (timeLimit > 0 && d.seedingStartedAt) {
        const elapsedMinutes = (Date.now() - d.seedingStartedAt) / 60000;
        if (elapsedMinutes >= timeLimit) {
          log.info('Auto-stopped seeding (time limit reached)', { id: managed.id, elapsedMinutes: Math.round(elapsedMinutes), limit: timeLimit });
          try { await this.stopSeeding(managed.id); } catch (_) { /* already stopped */ }
        }
      }
    }
  }

  
  /**
   * Destroy the manager (cleanup on app quit)
   */
  async destroy(): Promise<void> {
    log.info('Destroying TorrentManager');

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    
    // Clear all stats callbacks to prevent memory leaks
    this.statsCallbacks.clear();
    
    // Save final stats (single batched write, speeds zeroed since we're stopping)
    try {
      const stats = this.getStats();
      await db.updateDownloadsProgressBatch(stats.map(stat => ({
        id: stat.id,
        progress: stat.progress,
        downloadedBytes: stat.downloadedBytes,
        uploadedBytes: stat.uploadedBytes,
        downSpeedBps: 0,
        upSpeedBps: 0,
        etaSeconds: null,
        peers: 0,
        seeds: 0,
      })));
    } catch (e) {
      log.error('Failed to persist final progress', { error: e instanceof Error ? e.message : String(e) });
    }
    
    // Clear all managed torrents and indices
    this.managedTorrents.clear();
    this.infoHashIndex.clear();
    
    return new Promise((resolve) => {
      this.client.destroy((err) => {
        if (err) {
          log.error('Error destroying WebTorrent client', { error: String(err) });
        }
        log.info('TorrentManager destroyed');
        resolve();
      });
    });
  }
}

// Singleton instance
let torrentManager: TorrentManager | null = null;

export function getTorrentManager(): TorrentManager {
  if (!torrentManager) {
    torrentManager = new TorrentManager();
  }
  return torrentManager;
}
