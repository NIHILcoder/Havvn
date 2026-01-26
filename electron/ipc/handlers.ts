import { ipcMain, dialog, BrowserWindow, shell } from 'electron';
import { getTorrentManager, TorrentError, createTorrentFile, getDefaultTrackers } from '../torrent';
import { getCollaborativeSeedingManager } from '../seeding';
import * as db from '../db/store';
import { AddDownloadRequest, DownloadStats, CreateTorrentRequest } from '../../shared/types';
import { InvalidStateTransitionError } from '../../shared/state-machine';
import catalog from '../data/catalog.json';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils';

const log = logger.child('IPC');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<any>;

/**
 * Wraps an IPC handler with error handling and logging
 */
function wrapHandler(name: string, handler: IpcHandler): IpcHandler {
  return async (event, ...args) => {
    log.debug(`IPC call: ${name}`, { args });
    try {
      const result = await handler(event, ...args);
      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof TorrentError ? error.code : undefined;

      log.error(`IPC error: ${name}`, {
        error: errorMessage,
        code: errorCode,
      });

      // Re-throw with a clean message for the renderer
      if (error instanceof TorrentError) {
        throw new Error(`${error.message} (${error.code})`);
      }
      if (error instanceof InvalidStateTransitionError) {
        throw new Error(error.message);
      }
      throw error;
    }
  };
}

export function setupIpcHandlers(mainWindow: BrowserWindow): void {
  const torrentManager = getTorrentManager();

  log.info('Setting up IPC handlers');

  // Downloads
  ipcMain.handle('downloads:add', wrapHandler('downloads:add',
    async (_event, request: AddDownloadRequest) => {
      return torrentManager.addDownload(request);
    }
  ));

  ipcMain.handle('downloads:pause', wrapHandler('downloads:pause',
    async (_event, id: string) => {
      return await torrentManager.pauseDownload(id);
    }
  ));

  ipcMain.handle('downloads:resume', wrapHandler('downloads:resume',
    async (_event, id: string) => {
      return await torrentManager.resumeDownload(id);
    }
  ));

  ipcMain.handle('downloads:remove', wrapHandler('downloads:remove',
    async (_event, id: string, deleteFiles: boolean) => {
      // Validate arguments
      if (typeof id !== 'string') {
        throw new Error(`Invalid id parameter: expected string, got ${typeof id}`);
      }
      if (typeof deleteFiles !== 'boolean') {
        throw new Error(`Invalid deleteFiles parameter: expected boolean, got ${typeof deleteFiles}`);
      }
      return await torrentManager.removeDownload(id, deleteFiles);
    }
  ));

  ipcMain.handle('downloads:stopSeeding', wrapHandler('downloads:stopSeeding',
    async (_event, id: string) => {
      return await torrentManager.stopSeeding(id);
    }
  ));

  ipcMain.handle('downloads:retry', wrapHandler('downloads:retry',
    async (_event, id: string) => {
      return await torrentManager.retryDownload(id);
    }
  ));

  ipcMain.handle('downloads:getAll', wrapHandler('downloads:getAll',
    async () => {
      return torrentManager.getDownloads();
    }
  ));

  ipcMain.handle('downloads:getFiles', wrapHandler('downloads:getFiles',
    async (_event, id: string) => {
      return torrentManager.getFiles(id);
    }
  ));

  ipcMain.handle('downloads:getTorrentInfo', wrapHandler('downloads:getTorrentInfo',
    async (_event, params: { torrentPath?: string; magnetUri?: string }) => {
      return torrentManager.getTorrentInfo(params);
    }
  ));

  // Settings
  ipcMain.handle('settings:get', wrapHandler('settings:get',
    async () => {
      return db.getSettings();
    }
  ));

  ipcMain.handle('settings:update', wrapHandler('settings:update',
    async (_event, settings) => {
      const updated = await db.updateSettings(settings);

      // Update torrent manager with new settings
      await torrentManager.updateSettings({
        maxActiveDownloads: updated.maxActiveDownloads,
        maxDownKbps: updated.maxDownKbps,
        maxUpKbps: updated.maxUpKbps,
      });

      return updated;
    }
  ));

  // Categories
  ipcMain.handle('categories:get', wrapHandler('categories:get',
    async () => {
      return db.getCategories();
    }
  ));

  ipcMain.handle('categories:add', wrapHandler('categories:add',
    async (_event, category: Omit<import('../../shared/types').Category, 'id'>) => {
      return db.addCategory(category);
    }
  ));

  ipcMain.handle('categories:update', wrapHandler('categories:update',
    async (_event, id: string, updates: Partial<import('../../shared/types').Category>) => {
      return db.updateCategory(id, updates);
    }
  ));

  ipcMain.handle('categories:delete', wrapHandler('categories:delete',
    async (_event, id: string) => {
      return db.deleteCategory(id);
    }
  ));

  ipcMain.handle('downloads:setCategory', wrapHandler('downloads:setCategory',
    async (_event, id: string, category: string | null) => {
      return db.setDownloadCategory(id, category);
    }
  ));

  // Scheduler
  ipcMain.handle('scheduler:get', wrapHandler('scheduler:get',
    async () => {
      return db.getScheduler();
    }
  ));

  ipcMain.handle('scheduler:update', wrapHandler('scheduler:update',
    async (_event, config: Partial<import('../../shared/types').SchedulerConfig>) => {
      return db.updateScheduler(config);
    }
  ));

  // Catalog
  ipcMain.handle('catalog:get', wrapHandler('catalog:get',
    async () => {
      return catalog;
    }
  ));

  // File dialogs
  ipcMain.handle('dialog:selectDirectory', wrapHandler('dialog:selectDirectory',
    async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      return result.filePaths[0];
    }
  ));

  ipcMain.handle('dialog:selectTorrentFile', wrapHandler('dialog:selectTorrentFile',
    async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Torrent Files', extensions: ['torrent'] }],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      const filePath = result.filePaths[0];
      const content = fs.readFileSync(filePath).toString('base64');

      return { path: filePath, content };
    }
  ));

  // Shell operations
  ipcMain.handle('shell:openPath', wrapHandler('shell:openPath',
    async (_event, path: string) => {
      return await shell.openPath(path);
    }
  ));

  ipcMain.handle('shell:showItemInFolder', wrapHandler('shell:showItemInFolder',
    async (_event, path: string) => {
      shell.showItemInFolder(path);
    }
  ));

  // Cache management
  ipcMain.handle('cache:clear', wrapHandler('cache:clear',
    async () => {
      try {
        const session = mainWindow.webContents.session;
        await session.clearCache();
        await session.clearStorageData({
          storages: ['cachestorage', 'serviceworkers', 'websql', 'indexdb'],
        });
        log.info('Cache cleared successfully');
        return { success: true };
      } catch (error) {
        log.error('Failed to clear cache', { error });
        throw new Error('Failed to clear cache');
      }
    }
  ));

  // Stats subscription - send via main window
  torrentManager.onStats((stats: DownloadStats[]) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('downloads:stats', stats);
    }
  });

  // ===== Create Torrent =====
  
  // Get file/folder info (size, file count)
  ipcMain.handle('fs:getPathInfo', wrapHandler('fs:getPathInfo',
    async (_event, filePath: string) => {
      const stats = await fs.promises.stat(filePath);
      
      if (stats.isDirectory()) {
        // Recursively get folder size and file count
        let totalSize = 0;
        let fileCount = 0;
        
        const walkDir = async (dir: string) => {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await walkDir(fullPath);
            } else if (entry.isFile()) {
              const fileStats = await fs.promises.stat(fullPath);
              totalSize += fileStats.size;
              fileCount++;
            }
          }
        };
        
        await walkDir(filePath);
        
        return {
          isDirectory: true,
          size: totalSize,
          fileCount,
          name: path.basename(filePath)
        };
      } else {
        return {
          isDirectory: false,
          size: stats.size,
          fileCount: 1,
          name: path.basename(filePath)
        };
      }
    }
  ));
  
  // Select files for torrent creation
  ipcMain.handle('dialog:selectFilesForTorrent', wrapHandler('dialog:selectFilesForTorrent',
    async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        title: 'Select Files for Torrent',
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      return result.filePaths;
    }
  ));

  // Select folder for torrent creation
  ipcMain.handle('dialog:selectFolderForTorrent', wrapHandler('dialog:selectFolderForTorrent',
    async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select Folder for Torrent',
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      return result.filePaths[0];
    }
  ));

  // Select save path for torrent file
  ipcMain.handle('dialog:selectSaveTorrentPath', wrapHandler('dialog:selectSaveTorrentPath',
    async (_event, defaultName: string) => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Torrent File',
        defaultPath: defaultName.endsWith('.torrent') ? defaultName : `${defaultName}.torrent`,
        filters: [{ name: 'Torrent Files', extensions: ['torrent'] }],
      });

      if (result.canceled || !result.filePath) {
        return null;
      }

      return result.filePath;
    }
  ));

  // Create torrent file
  ipcMain.handle('torrent:create', wrapHandler('torrent:create',
    async (_event, request: CreateTorrentRequest) => {
      log.info('Creating torrent', { sourcePaths: request.sourcePaths });
      
      const result = await createTorrentFile(request, mainWindow);
      
      // If startSeeding is true, add the created torrent for seeding
      if (request.startSeeding && result.torrentFilePath) {
        log.info('Auto-starting seeding for created torrent', { infoHash: result.infoHash });
        
        // Determine source folder (parent of the first source path)
        const sourceFolder = path.dirname(request.sourcePaths[0]);
        
        await torrentManager.addDownload({
          sourceType: 'torrent_file',
          sourceUri: result.torrentFilePath,
          savePath: sourceFolder,
          name: request.options.name,
        });
      }
      
      return result;
    }
  ));

  // Get default trackers
  ipcMain.handle('torrent:getDefaultTrackers', wrapHandler('torrent:getDefaultTrackers',
    async () => {
      return getDefaultTrackers();
    }
  ));

  // === Collaborative Seeding Network ===
  const seedingManager = getCollaborativeSeedingManager();

  ipcMain.handle('seeding:getReputation', wrapHandler('seeding:getReputation',
    async () => {
      return seedingManager.getReputation();
    }
  ));

  ipcMain.handle('seeding:getSeedingPriorities', wrapHandler('seeding:getSeedingPriorities',
    async () => {
      const priorities = seedingManager.getSeedingPriorities();
      // Convert Map to object for IPC transfer
      return Object.fromEntries(priorities);
    }
  ));

  ipcMain.handle('seeding:getSeedingRecommendations', wrapHandler('seeding:getSeedingRecommendations',
    async (_event, maxSlots: number = 5) => {
      return seedingManager.getSeedingRecommendations(maxSlots);
    }
  ));

  ipcMain.handle('seeding:getRecentTransactions', wrapHandler('seeding:getRecentTransactions',
    async (_event, limit: number = 20) => {
      return seedingManager.getRecentTransactions(limit);
    }
  ));

  ipcMain.handle('seeding:getBadges', wrapHandler('seeding:getBadges',
    async () => {
      return seedingManager.getBadges();
    }
  ));

  ipcMain.handle('seeding:enable', wrapHandler('seeding:enable',
    async (_event, enabled: boolean) => {
      return seedingManager.setEnabled(enabled);
    }
  ));

  log.info('IPC handlers setup complete');
}
