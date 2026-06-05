import { ipcMain, dialog, BrowserWindow, shell, app, Notification } from 'electron';
import { getTorrentManager, TorrentError, createTorrentFile, getDefaultTrackers } from '../torrent';
import * as db from '../db/store';
import { AddDownloadRequest, DownloadStats, CreateTorrentRequest, FilePriority } from '../../shared/types';
import { InvalidStateTransitionError } from '../../shared/state-machine';
import catalog from '../data/catalog.json';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger, detectVPN, showVPNWarning, getAppIconPath } from '../utils';
import { getRSSService } from '../services/rss-service';
import { getShareManager, downloadContentPath } from '../sharing/share-manager';
import { getSearchService } from '../services/search-service';
import { getIPBlocklistService } from '../services/ip-blocklist';
import { getWatchFolderService } from '../torrent/watch-folder';

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

  ipcMain.handle('downloads:getStreamUrl', wrapHandler('downloads:getStreamUrl',
    async (_event, id: string, fileIndex: number, opts?: { transcode?: boolean }) => {
      return torrentManager.getStreamUrl(id, fileIndex, opts);
    }
  ));

  // ── Share links (torrent → browser via WebRTC) ──────────────────────────
  ipcMain.handle('share:start', wrapHandler('share:start',
    async (_event, downloadId: string) => {
      const download = await db.getDownloadById(downloadId);
      if (!download) throw new TorrentError('Download not found', 'NOT_FOUND', downloadId);
      const isComplete = download.progress >= 1 || download.status === 'completed' || download.status === 'seeding';
      if (!isComplete) {
        throw new TorrentError('Download must be complete to share', 'NOT_COMPLETE', downloadId);
      }
      // For "start seeding" entries the content lives at the original source
      // path (the on-disk name may differ from the custom torrent name).
      const contentPath = (download.seedPaths && download.seedPaths.length === 1)
        ? download.seedPaths[0]
        : downloadContentPath(download.savePath, download.name);
      const settings = await db.getSettings();
      const useTurn = settings.shareUseTurn !== false; // default on
      return getShareManager().share(downloadId, contentPath, download.name, useTurn);
    }
  ));

  ipcMain.handle('share:stop', wrapHandler('share:stop',
    async (_event, downloadId: string) => {
      await getShareManager().stop(downloadId);
      return { ok: true };
    }
  ));

  ipcMain.handle('share:get', wrapHandler('share:get',
    async (_event, downloadId: string) => {
      return getShareManager().get(downloadId);
    }
  ));

  ipcMain.handle('share:list', wrapHandler('share:list',
    async () => getShareManager().list()
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

      // Restart the disk-space guard if its settings changed
      if (settings.diskGuardEnabled !== undefined || settings.diskGuardMinFreeMB !== undefined) {
        const { restartGuardFromConfig } = await import('../utils/disk-guard');
        await restartGuardFromConfig();
      }

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
      const content = fsSync.readFileSync(filePath).toString('base64');

      return { path: filePath, content };
    }
  ));

  // Generic showOpenDialog
  ipcMain.handle('dialog:showOpenDialog', wrapHandler('dialog:showOpenDialog',
    async (_event, options: { properties?: string[]; title?: string; defaultPath?: string; filters?: any[] }) => {
      const result = await dialog.showOpenDialog(mainWindow, options as any);
      return result;
    }
  ));

  // Generic showSaveDialog
  ipcMain.handle('dialog:showSaveDialog', wrapHandler('dialog:showSaveDialog',
    async (_event, options: { title?: string; defaultPath?: string; filters?: any[] }) => {
      const result = await dialog.showSaveDialog(mainWindow, options);
      return result;
    }
  ));

  // Shell operations
  ipcMain.handle('shell:openPath', wrapHandler('shell:openPath',
    async (_event, targetPath: string) => {
      // Basic validation: must be a non-empty string
      if (!targetPath || typeof targetPath !== 'string') {
        throw new Error('Invalid path');
      }
      // shell.openPath opens with the OS default application — safe, not arbitrary code execution
      return await shell.openPath(targetPath);
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

  // Stats subscription - send via main window.
  // Skip sending when the window is hidden (e.g. minimized to tray): the renderer
  // can't display anything and would just waste IPC/CPU. Live values are still
  // kept in the main process and pushed on the next tick after the window shows.
  torrentManager.onStats((stats: DownloadStats[]) => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.webContents.send('downloads:stats', stats);
    }
  });

  // Download completion — OS notification
  torrentManager.onComplete(({ name }) => {
    if (Notification.isSupported()) {
      const iconPath = getAppIconPath();
      const notification = new Notification({
        title: 'Download Complete',
        body: `${name} has finished downloading`,
        ...(iconPath ? { icon: iconPath } : {}),
      });
      notification.show();
    }
  });

  // ===== Create Torrent =====
  
  // Get file/folder info (size, file count)
  ipcMain.handle('fs:getPathInfo', wrapHandler('fs:getPathInfo',
    async (_event, filePath: string) => {
      const stats = await fs.stat(filePath);
      
      if (stats.isDirectory()) {
        // Recursively get folder size and file count
        let totalSize = 0;
        let fileCount = 0;
        
        const walkDir = async (dir: string) => {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await walkDir(fullPath);
            } else if (entry.isFile()) {
              const fileStats = await fs.stat(fullPath);
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

  // Build a real (recursive) file tree for the given source paths, used by the
  // Create Torrent file picker so the user can exclude individual files.
  ipcMain.handle('fs:getFileTree', wrapHandler('fs:getFileTree',
    async (_event, sourcePaths: string[]) => {
      const MAX_ENTRIES = 5000; // guard against gigantic trees
      let count = 0;

      const build = async (p: string): Promise<import('../../shared/types').FsFileNode | null> => {
        if (count >= MAX_ENTRIES) return null;
        const stats = await fs.stat(p);
        if (stats.isDirectory()) {
          const entries = await fs.readdir(p, { withFileTypes: true });
          const children: import('../../shared/types').FsFileNode[] = [];
          let dirSize = 0;
          for (const entry of entries) {
            if (count >= MAX_ENTRIES) break;
            const child = await build(path.join(p, entry.name));
            if (child) {
              children.push(child);
              dirSize += child.size;
            }
          }
          return { path: p, name: path.basename(p), size: dirSize, isDirectory: true, children };
        }
        count++;
        return { path: p, name: path.basename(p), size: stats.size, isDirectory: false };
      };

      const roots: import('../../shared/types').FsFileNode[] = [];
      for (const sp of sourcePaths) {
        const node = await build(sp);
        if (node) roots.push(node);
      }
      return roots;
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
      
      // If startSeeding is true, seed the created torrent from the source files
      // on disk (so a custom name can't break the content mapping → 0% stall).
      if (request.startSeeding && result.torrentFilePath) {
        log.info('Auto-starting seeding for created torrent', { infoHash: result.infoHash });
        await torrentManager.addSeed({
          sourcePaths: request.sourcePaths,
          name: request.options.name,
          announceList: request.options.announceList,
          pieceLength: request.options.pieceLength,
          torrentFilePath: result.torrentFilePath,
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

  // Privacy & Security handlers
  ipcMain.handle('privacy:checkVPN', wrapHandler('privacy:checkVPN',
    async () => {
      return await detectVPN();
    }
  ));

  ipcMain.handle('privacy:showVPNWarning', wrapHandler('privacy:showVPNWarning',
    async () => {
      const result = await detectVPN();
      if (!result.isVPNActive) {
        showVPNWarning(result);
      }
      return result;
    }
  ));

  ipcMain.handle('privacy:getConfig', wrapHandler('privacy:getConfig',
    async () => {
      return await db.getPrivacyConfig();
    }
  ));

  ipcMain.handle('privacy:isEncryptionAvailable', wrapHandler('privacy:isEncryptionAvailable',
    async () => {
      const { isEncryptionAvailable } = await import('../db/secrets');
      return isEncryptionAvailable();
    }
  ));

  ipcMain.handle('privacy:updateConfig', wrapHandler('privacy:updateConfig',
    async (_event, updates: Partial<any>) => {
      const result = await db.updatePrivacyConfig(updates);
      // Apply logging-related privacy changes live
      if (updates.disableLogs !== undefined || updates.sanitizeLogs !== undefined) {
        logger.setPrivacyOptions({
          disableFileLogging: result.disableLogs,
          sanitize: result.sanitizeLogs,
        });
      }
      // Restart the VPN kill-switch guard when its toggle changes
      if (updates.vpnKillSwitch !== undefined) {
        const { restartGuardFromConfig } = await import('../utils/vpn-guard');
        await restartGuardFromConfig();
      }
      return result;
    }
  ));

  ipcMain.handle('privacy:clearAllData', wrapHandler('privacy:clearAllData',
    async () => {
      await db.clearAllData();
      return { success: true };
    }
  ));
  // === System Settings ===

  // Auto-launch
  ipcMain.handle('app:setAutoLaunch', wrapHandler('app:setAutoLaunch',
    async (_event, enabled: boolean) => {
      // Register under a friendly name ("TorrentHunt") instead of the raw
      // executable, so Task Manager / Startup lists it as TorrentHunt rather
      // than electron.exe. openAsHidden: start minimised to tray at login.
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: enabled,
        name: 'TorrentHunt',
        path: process.execPath,
      });

      await db.updateSettings({ autoLaunch: enabled } as any);
      log.info('Auto-launch setting changed', { enabled });
      return { success: true };
    }
  ));

  ipcMain.handle('app:getAutoLaunch', wrapHandler('app:getAutoLaunch',
    async () => {
      // The persisted preference is the source of truth. Reading the OS login
      // item back is unreliable on Windows when it was registered under a custom
      // name ("TorrentHunt"): getLoginItemSettings() without that name reports
      // openAtLogin=false even though the registry entry exists, which made the
      // toggle reset itself on every revisit. The actual OS login item is applied
      // from this setting on startup (see main.ts) and updated on every toggle.
      const settings = await db.getSettings();
      return settings.autoLaunch ?? false;
    }
  ));

  // App version (single source of truth: package.json via Electron)
  ipcMain.handle('app:getVersion', wrapHandler('app:getVersion',
    async () => app.getVersion()
  ));

  // Default client
  ipcMain.handle('app:isDefaultClient', wrapHandler('app:isDefaultClient',
    async () => {
      // Check both magnet: and .torrent association
      return app.isDefaultProtocolClient('magnet');
    }
  ));

  ipcMain.handle('app:setDefaultClient', wrapHandler('app:setDefaultClient',
    async () => {
      // Register magnet: protocol via Electron API
      const success = app.setAsDefaultProtocolClient('magnet');

      // Also register .torrent file association with custom icon via reg.exe
      if (process.platform === 'win32') {
        try {
          const exePath = app.getPath('exe');
          const exeDir = path.dirname(exePath);
          const iconPath = path.join(exeDir, 'icon2.ico');
          const execFileAsync = promisify(execFile);

          // Register the file type class
          const regCmds: [string, string[]][] = [
            ['reg', ['add', 'HKCU\\Software\\Classes\\.torrent', '/ve', '/d', 'TorrentHunt.file', '/f']],
            ['reg', ['add', 'HKCU\\Software\\Classes\\.torrent', '/v', 'Content Type', '/d', 'application/x-bittorrent', '/f']],
            ['reg', ['add', 'HKCU\\Software\\Classes\\TorrentHunt.file', '/ve', '/d', 'BitTorrent Document', '/f']],
            ['reg', ['add', 'HKCU\\Software\\Classes\\TorrentHunt.file\\DefaultIcon', '/ve', '/d', `${iconPath},0`, '/f']],
            ['reg', ['add', 'HKCU\\Software\\Classes\\TorrentHunt.file\\shell\\open\\command', '/ve', '/d', `"${exePath}" "%1"`, '/f']],
          ];

          for (const [cmd, args] of regCmds) {
            try { await execFileAsync(cmd, args); } catch (e) { /* non-fatal */ }
          }

          // Notify Windows shell to refresh icon cache
          try {
            await execFileAsync('powershell', [
              '-NoProfile', '-Command',
              `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class Shell { [DllImport("shell32.dll")] public static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2); }'; [Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)`
            ]);
          } catch (_) { /* non-fatal */ }

          log.info('Registered .torrent file association with icon2.ico');
        } catch (err) {
          log.warn('Failed to register file association via reg.exe', { err });
        }
      }

      log.info('Set as default torrent client', { success });
      return { success };
    }
  ));

  // Close-to-tray live update (no restart needed)
  ipcMain.handle('app:setCloseToTray', wrapHandler('app:setCloseToTray',
    async (_event, enabled: boolean) => {
      await db.updateSettings({ closeToTray: enabled } as any);
      log.info('Close-to-tray setting changed', { enabled });
      return { success: true };
    }
  ));

  // Minimize-to-tray live update (no restart needed)
  ipcMain.handle('app:setMinimizeToTray', wrapHandler('app:setMinimizeToTray',
    async (_event, enabled: boolean) => {
      await db.updateSettings({ minimizeToTray: enabled } as any);
      log.info('Minimize-to-tray setting changed', { enabled });
      return { success: true };
    }
  ));

  // Export settings
  ipcMain.handle('settings:export', wrapHandler('settings:export',
    async () => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Settings',
        defaultPath: 'torrenthunt-settings.json',
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      });

      if (result.canceled || !result.filePath) {
        return { success: false };
      }

      const settings = await db.getSettings();
      const categories = await db.getCategories();
      const scheduler = await db.getScheduler();
      const privacyConfig = await db.getPrivacyConfig();

      const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        settings,
        categories,
        scheduler,
        privacyConfig,
      };

      await fs.writeFile(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8');
      log.info('Settings exported', { path: result.filePath });
      return { success: true, path: result.filePath };
    }
  ));

  // Import settings
  ipcMain.handle('settings:import', wrapHandler('settings:import',
    async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Import Settings',
        properties: ['openFile'],
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false };
      }

      const content = await fs.readFile(result.filePaths[0], 'utf-8');
      const importData = JSON.parse(content);

      if (!importData.version || !importData.settings) {
        throw new Error('Invalid settings file format');
      }

      // Apply imported settings
      if (importData.settings) {
        await db.updateSettings(importData.settings);
      }
      if (importData.scheduler) {
        await db.updateScheduler(importData.scheduler);
      }
      if (importData.privacyConfig) {
        await db.updatePrivacyConfig(importData.privacyConfig);
      }

      log.info('Settings imported', { path: result.filePaths[0] });
      return { success: true };
    }
  ));

  // App Statistics
  ipcMain.handle('stats:getAppStats', wrapHandler('stats:getAppStats',
    async () => {
      return db.getAppStatistics();
    }
  ));

  // ============================================================
  // Priority 1: New Torrent Engine Features
  // ============================================================

  ipcMain.handle('downloads:setSequential', wrapHandler('downloads:setSequential',
    async (_event, id: string, enabled: boolean) => {
      await torrentManager.setSequentialDownload(id, enabled);
    }
  ));

  ipcMain.handle('downloads:setFilePriority', wrapHandler('downloads:setFilePriority',
    async (_event, id: string, fileIndex: number, priority: FilePriority) => {
      await torrentManager.setFilePriority(id, fileIndex, priority);
    }
  ));

  ipcMain.handle('downloads:setSpeedLimits', wrapHandler('downloads:setSpeedLimits',
    async (_event, id: string, downKbps: number, upKbps: number) => {
      await torrentManager.setTorrentSpeedLimits(id, downKbps, upKbps);
    }
  ));

  ipcMain.handle('downloads:setSeedRatio', wrapHandler('downloads:setSeedRatio',
    async (_event, id: string, ratio: number) => {
      await torrentManager.setSeedRatioLimit(id, ratio);
    }
  ));

  ipcMain.handle('downloads:setSeedTime', wrapHandler('downloads:setSeedTime',
    async (_event, id: string, minutes: number) => {
      await torrentManager.setSeedTimeLimit(id, minutes);
    }
  ));

  // Tracker management
  ipcMain.handle('downloads:getTrackers', wrapHandler('downloads:getTrackers',
    async (_event, id: string) => {
      return torrentManager.getTrackers(id);
    }
  ));

  ipcMain.handle('downloads:addTracker', wrapHandler('downloads:addTracker',
    async (_event, id: string, url: string) => {
      torrentManager.addTracker(id, url);
    }
  ));

  ipcMain.handle('downloads:removeTracker', wrapHandler('downloads:removeTracker',
    async (_event, id: string, url: string) => {
      torrentManager.removeTracker(id, url);
    }
  ));

  // Watch folder
  ipcMain.handle('watchFolder:getStatus', wrapHandler('watchFolder:getStatus',
    async () => {
      const wf = getWatchFolderService();
      return { active: wf.isActive, path: wf.currentPath };
    }
  ));

  ipcMain.handle('watchFolder:set', wrapHandler('watchFolder:set',
    async (_event, folderPath: string, enabled: boolean, deleteAfterAdd: boolean) => {
      const wf = getWatchFolderService();
      if (enabled && folderPath) {
        wf.start(folderPath, deleteAfterAdd);
      } else {
        wf.stop();
      }
      // Persist to settings
      await db.updateSettings({
        watchFolderEnabled: enabled,
        watchFolderPath: folderPath,
        watchFolderDeleteAfterAdd: deleteAfterAdd,
      });
    }
  ));

  // ============================================================
  // Priority 2: RSS
  // ============================================================

  ipcMain.handle('rss:getFeeds', wrapHandler('rss:getFeeds',
    async () => db.getRSSFeeds()
  ));

  ipcMain.handle('rss:addFeed', wrapHandler('rss:addFeed',
    async (_event, feed) => {
      const rss = getRSSService();
      return rss.addFeed(feed);
    }
  ));

  ipcMain.handle('rss:updateFeed', wrapHandler('rss:updateFeed',
    async (_event, id: string, updates) => {
      const rss = getRSSService();
      return rss.updateFeed(id, updates);
    }
  ));

  ipcMain.handle('rss:removeFeed', wrapHandler('rss:removeFeed',
    async (_event, id: string) => {
      const rss = getRSSService();
      await rss.removeFeed(id);
    }
  ));

  ipcMain.handle('rss:checkFeed', wrapHandler('rss:checkFeed',
    async (_event, id: string) => {
      const rss = getRSSService();
      return rss.checkFeed(id);
    }
  ));

  ipcMain.handle('rss:checkAll', wrapHandler('rss:checkAll',
    async () => {
      const rss = getRSSService();
      await rss.checkAllFeeds();
    }
  ));

  ipcMain.handle('rss:getItems', wrapHandler('rss:getItems',
    async (_event, feedId: string) => db.getRSSItems(feedId)
  ));

  ipcMain.handle('rss:markDownloaded', wrapHandler('rss:markDownloaded',
    async (_event, guid: string) => db.markRSSItemDownloaded(guid)
  ));

  ipcMain.handle('rss:clearItems', wrapHandler('rss:clearItems',
    async (_event, feedId?: string, onlyDownloaded?: boolean) => {
      const removed = await db.clearRSSItems(feedId, onlyDownloaded);
      return { removed };
    }
  ));

  // ============================================================
  // Priority 2: Search
  // ============================================================

  ipcMain.handle('search:query', wrapHandler('search:query',
    async (_event, query: string, category?: string) => {
      const searchSvc = getSearchService();
      return searchSvc.search(query, category);
    }
  ));

  ipcMain.handle('search:getProviders', wrapHandler('search:getProviders',
    async () => db.getSearchProviders()
  ));

  ipcMain.handle('search:addProvider', wrapHandler('search:addProvider',
    async (_event, provider) => db.addSearchProvider(provider)
  ));

  ipcMain.handle('search:updateProvider', wrapHandler('search:updateProvider',
    async (_event, id: string, updates) => db.updateSearchProvider(id, updates)
  ));

  ipcMain.handle('search:removeProvider', wrapHandler('search:removeProvider',
    async (_event, id: string) => db.removeSearchProvider(id)
  ));

  ipcMain.handle('search:testProvider', wrapHandler('search:testProvider',
    async (_event, id: string) => {
      const searchSvc = getSearchService();
      return searchSvc.testProvider(id);
    }
  ));

  // ============================================================
  // Priority 2: IP Blocklist
  // ============================================================

  ipcMain.handle('blocklist:getAll', wrapHandler('blocklist:getAll',
    async () => db.getIPBlocklists()
  ));

  ipcMain.handle('blocklist:add', wrapHandler('blocklist:add',
    async (_event, name: string, url: string) => {
      const bl = await db.addIPBlocklist(name, url);
      // Immediately download
      const blSvc = getIPBlocklistService();
      try {
        const count = await blSvc.updateBlocklist(bl.id);
        return { ...bl, entryCount: count };
      } catch (err) {
        log.warn('Failed to download blocklist on add', { error: err });
        return bl;
      }
    }
  ));

  ipcMain.handle('blocklist:remove', wrapHandler('blocklist:remove',
    async (_event, id: string) => db.removeIPBlocklist(id)
  ));

  ipcMain.handle('blocklist:update', wrapHandler('blocklist:update',
    async (_event, id: string) => {
      const blSvc = getIPBlocklistService();
      const count = await blSvc.updateBlocklist(id);
      return { entryCount: count };
    }
  ));

  ipcMain.handle('blocklist:setEnabled', wrapHandler('blocklist:setEnabled',
    async (_event, id: string, enabled: boolean) => {
      await db.updateIPBlocklist(id, { enabled });
      // Reload blocklist data
      const blSvc = getIPBlocklistService();
      await blSvc.loadAll();
    }
  ));

  log.info('IPC handlers setup complete');
}
