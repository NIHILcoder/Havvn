/**
 * Watch Folder Service
 * Monitors a directory for new .torrent files and auto-adds them to downloads.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils';
// Import the proxy via the barrel — NEVER from './manager' directly, which would
// load WebTorrent into the main process and spin up a second engine.
import { getTorrentManager } from './index';

const log = logger.child('WatchFolder');

export class WatchFolderService {
  private watcher: fs.FSWatcher | null = null;
  private watchPath: string = '';
  private processing = new Map<string, { active: boolean }>();
  private generation = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  private current(session: { generation: number; path: string }): boolean {
    return session.generation === this.generation && session.path === this.watchPath && this.watcher !== null;
  }
  private later(action: () => void, delay: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); action(); }, delay);
    this.timers.add(timer);
  }

  get isActive(): boolean {
    return this.watcher !== null;
  }

  get currentPath(): string {
    return this.watchPath;
  }

  start(folderPath: string, deleteAfterAdd: boolean): void {
    this.stop();

    if (!folderPath || folderPath.trim() === '') {
      log.warn('Watch folder path is empty, not starting');
      return;
    }

    // Ensure directory exists
    try {
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
        log.info('Created watch folder', { path: folderPath });
      }
    } catch (err) {
      log.error('Failed to create watch folder', { path: folderPath, error: err });
      return;
    }

    this.watchPath = folderPath;
    const session = { generation: this.generation, path: folderPath, deleteAfterAdd };

    log.info('Starting watch folder service', { path: folderPath, deleteAfterAdd });

    // Watch for new files
    try {
      this.watcher = fs.watch(folderPath, { persistent: false }, (eventType, filename) => {
        if (!filename || !this.current(session)) return;
        if (!filename.toLowerCase().endsWith('.torrent')) return;
        if (eventType !== 'rename' && eventType !== 'change') return;

        const filePath = path.join(folderPath, filename);

        // Small delay to ensure file is fully written
        this.later(() => {
          if (!this.current(session)) return;
          this.handleNewTorrent(filePath, session).catch(err => {
            log.error('Error handling new torrent in watch folder', { filePath, error: err });
          });
        }, 500);
      });

      this.watcher.on('error', (err) => {
        if (!this.current(session)) return;
        log.error('Watch folder watcher error', { error: err });
        this.stop();
      });

      log.info('Watch folder service started', { path: folderPath });
      void this.scanExisting(session);
    } catch (err) {
      log.error('Failed to start watching folder', { path: folderPath, error: err });
      this.stop();
    }
  }

  stop(): void {
    this.generation++;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch (_) { /* ignore */ }
      this.watcher = null;
      log.info('Watch folder service stopped');
    }
    this.watchPath = '';
    // An accepted addition can still be running. Keep its ownership until it
    // settles so restarting the same folder cannot add it a second time.
    for (const [file, entry] of this.processing) if (!entry.active) this.processing.delete(file);
  }

  private async scanExisting(session: { generation: number; path: string; deleteAfterAdd: boolean }): Promise<void> {
    try {
      const files = fs.readdirSync(session.path);
      const torrentFiles = files.filter(f => f.toLowerCase().endsWith('.torrent'));

      log.info(`Found ${torrentFiles.length} existing .torrent files in watch folder`);

      for (const filename of torrentFiles) {
        if (!this.current(session)) break;
        const filePath = path.join(session.path, filename);
        await this.handleNewTorrent(filePath, session);
      }
    } catch (err) {
      log.error('Error scanning watch folder', { error: err });
    }
  }

  private async handleNewTorrent(filePath: string, session: { generation: number; path: string; deleteAfterAdd: boolean }): Promise<void> {
    if (!this.current(session)) return;
    // Avoid processing the same file twice (fs.watch can fire multiple times)
    if (this.processing.has(filePath)) return;
    if (!fs.existsSync(filePath)) return;

    const entry = { active: true };
    this.processing.set(filePath, entry);

    try {
      log.info('Watch folder: found new torrent', { filePath });

      const manager = getTorrentManager();
      await manager.addDownload({
        sourceType: 'torrent_file',
        sourceUri: filePath,
      });

      log.info('Watch folder: added torrent successfully', { filePath });

      if (session.deleteAfterAdd && this.current(session)) {
        try {
          fs.unlinkSync(filePath);
          log.debug('Watch folder: deleted .torrent after adding', { filePath });
        } catch (err) {
          log.warn('Watch folder: failed to delete .torrent after adding', { filePath, error: err });
        }
      }
    } catch (err: any) {
      // Duplicate errors are expected and non-fatal
      if (err?.code === 'DUPLICATE') {
        log.debug('Watch folder: torrent already in downloads (skipping)', { filePath });
      } else {
        log.error('Watch folder: failed to add torrent', { filePath, error: err });
      }
    } finally {
      // Remove from processing set after a delay to handle rapid duplicate events
      entry.active = false;
      const release = () => { if (this.processing.get(filePath) === entry) this.processing.delete(filePath); };
      if (this.current(session)) this.later(release, 5000); else release();
    }
  }
}

// Singleton
let watchFolderService: WatchFolderService | null = null;

export function getWatchFolderService(): WatchFolderService {
  if (!watchFolderService) {
    watchFolderService = new WatchFolderService();
  }
  return watchFolderService;
}
