import { ipcMain, dialog, BrowserWindow, shell } from 'electron';
import { getTorrentManager, TorrentError } from '../torrent';
import * as db from '../db/store';
import { AddDownloadRequest, DownloadStats } from '../../shared/types';
import { InvalidStateTransitionError } from '../../shared/state-machine';
import catalog from '../data/catalog.json';
import fs from 'fs';
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

  log.info('IPC handlers setup complete');
}
