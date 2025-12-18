import WebTorrent, { Torrent } from 'webtorrent';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import {
  Download,
  DownloadStatus,
  DownloadStats,
  SourceType,
  TorrentFile,
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
  private infoHashIndex: Map<string, string> = new Map(); // infoHash -> download id
  private statsInterval: NodeJS.Timeout | null = null;
  private statsCallbacks: Set<StatsCallback> = new Set();
  private maxActiveDownloads = 3;
  private maxDownKbps = 0;
  private maxUpKbps = 0;
  
  constructor() {
    this.client = new WebTorrent();
    
    this.client.on('error', (err: string | Error) => {
      log.error('WebTorrent client error', { error: err });
    });

    log.debug('TorrentManager instance created');
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
    
    log.debug('Settings loaded', {
      maxActiveDownloads: this.maxActiveDownloads,
      maxDownKbps: this.maxDownKbps,
      maxUpKbps: this.maxUpKbps,
    });

    // Restore downloads from database
    const downloads = await db.getAllDownloads();
    log.info(`Restoring ${downloads.length} downloads from database`);
    
    for (const download of downloads) {
      if (download.status === 'removed') continue;
      
      // Store in managed map
      this.managedTorrents.set(download.id, {
        id: download.id,
        torrent: null,
        download,
        infoHash: null,
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
      
      await this.addTorrentInternal(download.id, source, download.savePath, false);
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

        tempClient.add(sourceUri, { path: app.getPath('temp') }, (torrent) => {
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
  async addDownload(params: {
    sourceType: SourceType;
    sourceUri: string;
    savePath?: string;
    name?: string;
    selectedFiles?: number[];
  }): Promise<Download> {
    log.info('Adding new download', { sourceType: params.sourceType, name: params.name });

    // 1. Extract infoHash early to check for duplicates BEFORE adding
    let infoHashToCheck: string | null = null;
    
    if (params.sourceType === 'magnet') {
      infoHashToCheck = this.extractInfoHashFromMagnet(params.sourceUri);
      log.debug('Extracted infoHash from magnet', { infoHash: infoHashToCheck });
    } else if (params.sourceType === 'torrent_file') {
      infoHashToCheck = await this.extractInfoHashFromFile(params.sourceUri);
      log.debug('Extracted infoHash from torrent file', { infoHash: infoHashToCheck, filePath: params.sourceUri });
    }
    
    log.info('Checking for duplicates', { 
      infoHashToCheck, 
      indexSize: this.infoHashIndex.size,
      managedCount: this.managedTorrents.size 
    });

    // 2. Check for duplicates by infoHash - check BOTH index and all managed torrents
    if (infoHashToCheck) {
      // Check index first
      const existingId = this.infoHashIndex.get(infoHashToCheck);
      if (existingId) {
        const existing = this.managedTorrents.get(existingId);
        if (existing && existing.download.status !== 'removed') {
          const errorMessage = `Этот торрент уже в загрузках: "${existing.download.name}"`;
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
          const errorMessage = `Этот торрент уже в загрузках: "${managed.download.name}"`;
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
          const errorMessage = `Этот торрент уже в загрузках: "${managed.download.name}"`;
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
          const errorMessage = `Торрент с таким именем уже в загрузках: "${managed.download.name}"`;
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
      const errorMessage = `Недостаточно места на диске. Доступно: ${formatBytes(availableSpace)}, требуется минимум ${formatBytes(minimumRequired)}`;
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
    
    // If it's a torrent file, copy it to app data
    if (params.sourceType === 'torrent_file') {
      const appDataDir = path.join(app.getPath('userData'), 'torrents');
      if (!fs.existsSync(appDataDir)) {
        fs.mkdirSync(appDataDir, { recursive: true });
      }
      
      const fileName = path.basename(params.sourceUri);
      torrentFilePath = path.join(appDataDir, `${Date.now()}_${fileName}`);
      fs.copyFileSync(params.sourceUri, torrentFilePath);
      log.debug('Torrent file copied', { from: params.sourceUri, to: torrentFilePath });
    }
    
    // Create database record
    const download = await db.createDownload({
      name: params.name || 'Loading...',
      sourceType: params.sourceType,
      sourceUri,
      torrentFilePath,
      savePath,
      status: 'queued',
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
      
      // Transition to downloading immediately (torrent starts downloading right away)
      // We'll update the name once 'ready' event fires
      this.transitionStatus(id, 'downloading').catch((err) => {
        log.error('Failed to transition to downloading', { id, error: err });
      });
      
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
          
          const errorMessage = `Этот торрент уже добавлен: "${duplicateName}"`;
          
          // Полностью удаляем дубликат из системы
          await db.markDownloadRemoved(id);
          this.managedTorrents.delete(id);
          
          reject(new TorrentError(errorMessage, 'DUPLICATE', id));
          return;
        }

        // Update name from torrent metadata
        const name = torrent.name || 'Unknown';
        managed.download.name = name;
        
        log.debug('Torrent ready', { id, name, infoHash });

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
          });
        }
        
        resolve();
      });
      
      torrent.on('done', async () => {
        log.info('Torrent completed', { id, name: managed.download.name });
        if (managed.download.status === 'downloading') {
          await this.transitionStatus(id, 'seeding');
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
    
    // Find queued downloads
    const queued = await db.getDownloadsByStatus('queued');
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
          
          log.debug('Starting queued download', { id: download.id });
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
          // Error state is already set by addTorrentInternal
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
    
    // Destroy the torrent completely to stop all connections
    if (managed.torrent) {
      log.debug('Destroying torrent to pause completely', { id, infoHash: managed.infoHash });
      await new Promise<void>((resolve) => {
        managed.torrent!.destroy({ destroyStore: false }, () => {
          // Clear torrent reference to free memory
          managed.torrent = null;
          resolve();
        });
      });
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
    
    // If torrent was destroyed during pause, re-queue to restart
    if (!managed.torrent) {
      log.debug('Torrent was destroyed, re-queueing', { id });
      await this.transitionStatus(id, 'queued');
      await this.processQueue();
    } else {
      // If torrent still exists (shouldn't happen after new pause logic), just resume
      managed.torrent.resume();
      
      const newStatus = managed.torrent.done ? 'seeding' : 'downloading';
      await this.transitionStatus(id, newStatus);
    }

    log.debug('Download resumed successfully', { id });
  }
  
  /**
   * Mark download as removed in database
   */
  private async markDownloadRemoved(id: string): Promise<void> {
    try {
      await db.markDownloadRemoved(id);
    } catch (e) {
      log.warn('Failed to mark download as removed in database', { id, error: e });
    }
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
      // If torrent was destroyed (e.g., during pause), manually delete files
      const downloadPath = managed.download.savePath;
      if (fs.existsSync(downloadPath)) {
        try {
          const files = fs.readdirSync(downloadPath);
          // Delete files/folders that match the download name
          const downloadName = managed.download.name;
          for (const file of files) {
            if (file === downloadName || file.startsWith(downloadName)) {
              const fullPath = path.join(downloadPath, file);
              const stat = fs.statSync(fullPath);
              if (stat.isDirectory()) {
                fs.rmSync(fullPath, { recursive: true, force: true });
                log.debug('Deleted download directory', { path: fullPath });
              } else {
                fs.unlinkSync(fullPath);
                log.debug('Deleted download file', { path: fullPath });
              }
            }
          }
        } catch (e) {
          log.error('Failed to delete downloaded files', {
            path: downloadPath,
            error: e instanceof Error ? e.message : String(e),
          });
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
    
    // Remove from database (mark as removed)
    await db.markDownloadRemoved(id);
    
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
          seeds: 0,
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
   * Start periodic stats broadcasting
   */
  private startStatsBroadcast(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    
    this.statsInterval = setInterval(async () => {
      const stats = this.getStats();
      
      // Update database with current stats
      for (const stat of stats) {
        try {
          await db.updateDownloadProgress(stat.id, {
            progress: stat.progress,
            downloadedBytes: stat.downloadedBytes,
            uploadedBytes: stat.uploadedBytes,
            downSpeedBps: stat.downSpeedBps,
            upSpeedBps: stat.upSpeedBps,
            etaSeconds: stat.etaSeconds,
            peers: stat.peers,
            seeds: stat.seeds,
          });
        } catch (e) {
          // Ignore update errors
        }
      }
      
      // Broadcast to callbacks
      for (const callback of this.statsCallbacks) {
        try {
          callback(stats);
        } catch (e) {
          log.error('Stats callback error', { error: e instanceof Error ? e.message : String(e) });
        }
      }
    }, 750); // 750ms interval

    log.debug('Stats broadcast started');
  }
  
  /**
   * Update manager settings
   */
  async updateSettings(settings: {
    maxActiveDownloads?: number;
    maxDownKbps?: number;
    maxUpKbps?: number;
  }): Promise<void> {
    log.debug('Updating settings', settings);

    if (settings.maxActiveDownloads !== undefined) {
      this.maxActiveDownloads = settings.maxActiveDownloads;
    }
    if (settings.maxDownKbps !== undefined) {
      this.maxDownKbps = settings.maxDownKbps;
    }
    if (settings.maxUpKbps !== undefined) {
      this.maxUpKbps = settings.maxUpKbps;
    }
    
    // Process queue in case max downloads changed
    await this.processQueue();
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
    
    // Save final stats
    const stats = this.getStats();
    for (const stat of stats) {
      try {
        await db.updateDownloadProgress(stat.id, {
          progress: stat.progress,
          downloadedBytes: stat.downloadedBytes,
          uploadedBytes: stat.uploadedBytes,
          downSpeedBps: 0,
          upSpeedBps: 0,
          etaSeconds: null,
          peers: 0,
          seeds: 0,
        });
      } catch (e) {
        // Ignore
      }
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
