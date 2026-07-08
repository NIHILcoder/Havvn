import { ipcMain, dialog, BrowserWindow, shell, app, Notification } from 'electron';
import { getTorrentManager, TorrentError, getDefaultTrackers } from '../torrent';
import * as db from '../db/store';
import { AddDownloadRequest, DownloadStats, CreateTorrentRequest, FilePriority } from '../../shared/types';
import { safeBaseName } from '../../shared/path-safety';
import { InvalidStateTransitionError } from '../../shared/state-machine';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger, detectVPN, showVPNWarning, getAppIconPath } from '../utils';
import { getRSSService } from '../services/rss-service';
import { getShareManager, downloadContentPath } from '../sharing/share-manager';
import { customTurnToIce } from '../sharing/ice-servers';
import { getRoomManager } from '../sharing/room-manager';
import { getSearchService } from '../services/search-service';
import { getPythonStatus } from '../services/python-detector';
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

// ipcMain.handle() throws on double registration, and stats subscriptions
// would stack — so handlers are registered exactly once. The window reference
// is module-level and refreshed on every call (a window can be recreated,
// e.g. macOS dock 'activate').
let handlersRegistered = false;
let mainWindow: BrowserWindow;

export function setupIpcHandlers(window: BrowserWindow): void {
  mainWindow = window;

  const roomManager = getRoomManager();
  roomManager.setMainWindow(window);

  if (handlersRegistered) {
    log.info('IPC handlers already registered — updated window reference only');
    return;
  }
  handlersRegistered = true;

  const torrentManager = getTorrentManager();

  log.info('Setting up IPC handlers');

  // Friend swarms: re-join any persisted rooms shortly after startup so
  // swarms reconnect on their own.
  setTimeout(() => { roomManager.restoreAll().catch((e) => log.warn('Room restore failed', { error: String(e) })); }, 4000);

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

  ipcMain.handle('downloads:pauseAll', wrapHandler('downloads:pauseAll',
    async () => {
      const paused = await torrentManager.pauseAllActive();
      return { paused };
    }
  ));

  ipcMain.handle('downloads:resumeAll', wrapHandler('downloads:resumeAll',
    async () => {
      const resumed = await torrentManager.resumeAllPaused();
      return { resumed };
    }
  ));

  // Alternative ("turbo"/turtle) speed-limit quick toggle
  ipcMain.handle('speed:setAlt', wrapHandler('speed:setAlt',
    async (_event, enabled: boolean) => {
      return torrentManager.setAltSpeed(!!enabled);
    }
  ));

  ipcMain.handle('speed:getAlt', wrapHandler('speed:getAlt',
    async () => ({ altSpeedEnabled: torrentManager.isAltSpeedEnabled() })
  ));

  // ── Mobile web remote ────────────────────────────────────────────────────
  const webRemoteInfo = async () => {
    const settings = await db.getSettings();
    const { getWebRemoteServer } = await import('../torrent/web-remote');
    const info = getWebRemoteServer().getInfo();
    return { enabled: settings.webRemoteEnabled === true, ...info };
  };

  const applyWebRemote = async () => {
    const settings = await db.getSettings();
    const { getWebRemoteServer } = await import('../torrent/web-remote');
    const srv = getWebRemoteServer();
    if (settings.webRemoteEnabled) {
      const token = await db.getOrCreateWebRemoteToken();
      await srv.start(settings.webRemotePort || 8788, token);
    } else {
      await srv.stop();
    }
  };

  ipcMain.handle('webRemote:getInfo', wrapHandler('webRemote:getInfo',
    async () => webRemoteInfo()
  ));

  ipcMain.handle('webRemote:setEnabled', wrapHandler('webRemote:setEnabled',
    async (_event, enabled: boolean) => {
      await db.updateSettings({ webRemoteEnabled: !!enabled } as any);
      await applyWebRemote();
      return webRemoteInfo();
    }
  ));

  ipcMain.handle('webRemote:regenToken', wrapHandler('webRemote:regenToken',
    async () => {
      await db.regenerateWebRemoteToken();
      await applyWebRemote(); // restart with the new token (revokes old links)
      return webRemoteInfo();
    }
  ));

  ipcMain.handle('downloads:retry', wrapHandler('downloads:retry',
    async (_event, id: string) => {
      return await torrentManager.retryDownload(id);
    }
  ));

  ipcMain.handle('downloads:recheck', wrapHandler('downloads:recheck',
    async (_event, id: string) => {
      return await torrentManager.recheckDownload(id);
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

  ipcMain.handle('downloads:stopStream', wrapHandler('downloads:stopStream',
    async (_event, id: string, fileIndex?: number) => {
      return torrentManager.stopStream(id, fileIndex);
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
      const turnServers = customTurnToIce(settings.customTurnUrl, settings.customTurnUsername, settings.customTurnCredential);
      return getShareManager().share(downloadId, contentPath, download.name, useTurn, turnServers);
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

  // ── Cast to device on the LAN (HLS / direct, with seeking) ───────────────
  ipcMain.handle('cast:start', wrapHandler('cast:start',
    async (_event, id: string, fileIndex: number) => {
      // Cast server runs in the torrent host; forward via the manager proxy.
      return torrentManager.castPublish(id, fileIndex);
    }
  ));

  ipcMain.handle('cast:stop', wrapHandler('cast:stop',
    async (_event, id: string, fileIndex: number) => {
      await torrentManager.castUnpublish(id, fileIndex);
      return { ok: true };
    }
  ));

  // Remote streaming over WebRTC (watch outside the local network)
  ipcMain.handle('cast:remoteStart', wrapHandler('cast:remoteStart',
    async (_event, id: string, fileIndex: number) => {
      const { getRemoteCastManager } = await import('../sharing/remote-cast-manager');
      return getRemoteCastManager().start(id, fileIndex);
    }
  ));

  ipcMain.handle('cast:remoteStop', wrapHandler('cast:remoteStop',
    async (_event, sessionId: string) => {
      const { getRemoteCastManager } = await import('../sharing/remote-cast-manager');
      return getRemoteCastManager().stop(sessionId);
    }
  ));

  // Cast to TV (Chromecast / Android TV)
  ipcMain.handle('cast:tvList', wrapHandler('cast:tvList',
    async () => {
      const { getChromecastManager } = await import('../torrent/chromecast');
      return getChromecastManager().list();
    }
  ));

  ipcMain.handle('cast:tvRefresh', wrapHandler('cast:tvRefresh',
    async () => {
      const { getChromecastManager } = await import('../torrent/chromecast');
      const mgr = getChromecastManager();
      mgr.refresh();
      return mgr.list();
    }
  ));

  ipcMain.handle('cast:tvPlay', wrapHandler('cast:tvPlay',
    async (_event, id: string, fileIndex: number, host: string) => {
      const { getChromecastManager } = await import('../torrent/chromecast');
      const media = await torrentManager.castTvMedia(id, fileIndex);
      await getChromecastManager().play(host, media);
      return { ok: true };
    }
  ));

  ipcMain.handle('cast:tvControl', wrapHandler('cast:tvControl',
    async (_event, host: string, action: 'pause' | 'resume' | 'stop') => {
      const { getChromecastManager } = await import('../torrent/chromecast');
      const mgr = getChromecastManager();
      if (action === 'pause') await mgr.pause(host);
      else if (action === 'resume') await mgr.resume(host);
      else await mgr.stop(host);
      return { ok: true };
    }
  ));

  // Subtitles (embedded text tracks + sidecar files → WebVTT)
  ipcMain.handle('subtitles:list', wrapHandler('subtitles:list',
    async (_event, id: string, fileIndex: number) => torrentManager.getSubtitleTracks(id, fileIndex)
  ));

  ipcMain.handle('subtitles:get', wrapHandler('subtitles:get',
    async (_event, id: string, fileIndex: number, key: string) => torrentManager.getSubtitleVtt(id, fileIndex, key)
  ));

  // ── Friend swarms / private rooms (Phase 3) ─────────────────────────────
  ipcMain.handle('rooms:getProfile', wrapHandler('rooms:getProfile',
    async () => roomManager.getProfile()
  ));

  ipcMain.handle('rooms:setProfile', wrapHandler('rooms:setProfile',
    async (_event, updates: { name?: string; avatarSeed?: string }) => roomManager.setProfile(updates || {})
  ));

  ipcMain.handle('rooms:create', wrapHandler('rooms:create',
    async (_event, name: string, e2e?: boolean) => roomManager.createRoom(typeof name === 'string' ? name.trim() : '', !!e2e)
  ));

  ipcMain.handle('rooms:join', wrapHandler('rooms:join',
    async (_event, code: string) => {
      if (typeof code !== 'string' || !code.trim()) throw new Error('Room code is required');
      return roomManager.joinRoom(code);
    }
  ));

  ipcMain.handle('rooms:leave', wrapHandler('rooms:leave',
    async (_event, roomId: string) => roomManager.leaveRoom(roomId)
  ));

  ipcMain.handle('rooms:list', wrapHandler('rooms:list',
    async () => roomManager.list()
  ));

  ipcMain.handle('rooms:get', wrapHandler('rooms:get',
    async (_event, roomId: string) => roomManager.getRoom(roomId)
  ));

  ipcMain.handle('rooms:addFiles', wrapHandler('rooms:addFiles',
    async (_event, roomId: string, paths: string[]) => roomManager.addFiles(roomId, Array.isArray(paths) ? paths : [])
  ));

  ipcMain.handle('rooms:pickAndAddFiles', wrapHandler('rooms:pickAndAddFiles',
    async (_event, roomId: string) => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Add files to room',
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || !result.filePaths.length) return null;
      return roomManager.addFiles(roomId, result.filePaths);
    }
  ));

  // Share a finished download into a room ("Share to room" / "Bring a file
  // from Transfers"). Resolves the download's content on disk and feeds the
  // FILES to the room engine (it seeds single files only — directories are
  // walked; E2E rooms encrypt each file individually).
  const ROOM_SHARE_MAX_FILES = 25;
  // The picker lists more than the share cap so the user can choose which 25.
  const ROOM_SHARE_LIST_MAX = 400;

  /** The download's shareable files on disk (capped walk), or throws. */
  const collectShareableFiles = async (downloadId: string): Promise<string[]> => {
    const download = await db.getDownloadById(String(downloadId || ''));
    // Removed downloads are tombstoned (status 'removed') until next boot.
    if (!download || download.status === 'removed') throw new Error('Download not found');
    const complete = download.progress >= 1 || ['completed', 'seeding'].includes(download.status);
    if (!complete) throw new Error('This download is not complete yet');

    const collect = (root: string): string[] => {
      // lstat: treat a symlinked root like nested entries (don't follow).
      const st = fsSync.lstatSync(root, { throwIfNoEntry: false });
      if (st?.isFile()) return [root];
      if (!st?.isDirectory()) return [];
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
          if (out.length > ROOM_SHARE_LIST_MAX) return;
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.isFile()) out.push(p);
        }
      };
      walk(root);
      return out.sort();
    };

    // Created "start seeding" records are authoritative about their source
    // paths (same order as share:start) — the record's name may be a custom
    // torrent name that doesn't exist under savePath.
    let files = (download.seedPaths ?? []).flatMap(collect);
    if (!files.length) {
      // Peer-supplied torrent names are not trusted as path fragments.
      const safeName = safeBaseName(download.name) || download.name;
      files = collect(downloadContentPath(download.savePath, safeName));
    }
    if (!files.length) throw new Error('Files not found on disk');
    return files;
  };

  // The share dialogs' file-pick stage: what CAN go to a room from this download.
  ipcMain.handle('rooms:listShareableFiles', wrapHandler('rooms:listShareableFiles',
    async (_event, downloadId: string) => {
      const all = await collectShareableFiles(downloadId);
      const truncated = all.length > ROOM_SHARE_LIST_MAX;
      const files = (truncated ? all.slice(0, ROOM_SHARE_LIST_MAX) : all).map((p) => {
        let size = 0;
        try { size = fsSync.statSync(p).size; } catch { /* shown as 0 */ }
        return { path: p, name: path.basename(p), size };
      });
      return { files, truncated, maxShare: ROOM_SHARE_MAX_FILES };
    }
  ));

  ipcMain.handle('rooms:shareDownload', wrapHandler('rooms:shareDownload',
    async (_event, roomId: string, downloadId: string, selectedPaths?: string[]) => {
      let files = await collectShareableFiles(downloadId);
      if (Array.isArray(selectedPaths) && selectedPaths.length > 0) {
        // The renderer picks FROM the collected list — raw paths are not trusted.
        const allowed = new Set(files);
        files = selectedPaths.filter((p) => allowed.has(p));
        if (!files.length) throw new Error('Selected files not found on disk');
      }
      if (files.length > ROOM_SHARE_MAX_FILES) {
        throw new Error(`Too many files to share at once (over ${ROOM_SHARE_MAX_FILES}) — pick specific files`);
      }
      return roomManager.addFiles(roomId, files);
    }
  ));

  ipcMain.handle('rooms:openFolder', wrapHandler('rooms:openFolder',
    async (_event, roomId: string) => {
      const folder = roomManager.folderOf(roomId);
      if (folder) await shell.openPath(folder);
    }
  ));

  ipcMain.handle('rooms:openFile', wrapHandler('rooms:openFile',
    async (_event, roomId: string, fileId: string) => roomManager.openFile(roomId, fileId)
  ));

  ipcMain.handle('rooms:watchFile', wrapHandler('rooms:watchFile',
    async (_event, roomId: string, fileId: string) => roomManager.watchFile(roomId, fileId)
  ));

  ipcMain.handle('rooms:broadcastSync', wrapHandler('rooms:broadcastSync',
    async (_event, roomId: string, payload: { fileId: string; action: string; position: number; rate?: number; playing?: boolean }) => {
      roomManager.broadcastSync(roomId, payload);
      return { ok: true };
    }
  ));

  ipcMain.handle('rooms:removeFile', wrapHandler('rooms:removeFile',
    async (_event, roomId: string, fileId: string) => roomManager.removeFile(roomId, fileId)
  ));

  ipcMain.handle('rooms:setMuted', wrapHandler('rooms:setMuted',
    async (_event, roomId: string, memberId: string, muted: boolean) => roomManager.setMuted(roomId, memberId, !!muted)
  ));

  ipcMain.handle('rooms:kick', wrapHandler('rooms:kick',
    async (_event, roomId: string, memberId: string) => roomManager.kick(roomId, memberId)
  ));

  ipcMain.handle('rooms:sendChat', wrapHandler('rooms:sendChat',
    async (_event, roomId: string, text: string) => roomManager.sendChat(roomId, text)
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
        maxConnections: updated.maxConnections,
        maxConnectionsGlobal: updated.maxConnectionsGlobal,
        adaptiveUpload: updated.adaptiveUpload,
        dohEnabled: updated.dohEnabled,
        dohTemplateId: updated.dohTemplateId,
        dohCustomTemplates: updated.dohCustomTemplates,
      });

      // Restart the disk-space guard if its settings changed
      if (settings.diskGuardEnabled !== undefined || settings.diskGuardMinFreeMB !== undefined) {
        const { restartGuardFromConfig } = await import('../utils/disk-guard');
        await restartGuardFromConfig();
      }

      // Re-apply UPnP port forwarding if the toggle or the listening port changed.
      // (The port itself only takes effect after a restart, but re-running here
      // turns forwarding on/off live and re-maps when the user fixes the port.)
      if (settings.portForwarding !== undefined || settings.portMin !== undefined) {
        const { restartPortForwardingFromConfig } = await import('../utils/port-forwarding');
        await restartPortForwardingFromConfig(() => torrentManager.getListeningPort());
      }

      // Re-apply the active network-profile overlay so a manual base-setting change
      // (or toggling the feature) doesn't clobber the per-network override.
      const { applyForCurrentNetwork } = await import('../services/network-profiles');
      void applyForCurrentNetwork(true);

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

  // Torrent-creation progress — created in the host, relayed to the renderer.
  torrentManager.onCreateProgress((progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('torrent:createProgress', progress);
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
      
      const result = await torrentManager.createTorrentFile(request);
      
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

  // Live privacy dashboard: VPN detection + geo/ISP of the public IP, with a
  // leak flag. Only runs when the user opens the Privacy tab or hits Refresh.
  ipcMain.handle('privacy:getIpInfo', wrapHandler('privacy:getIpInfo',
    async () => {
      const { getIpInfo } = await import('../utils');
      return getIpInfo();
    }
  ));

  ipcMain.handle('privacy:openLogsFolder', wrapHandler('privacy:openLogsFolder',
    async () => {
      const dir = logger.getLogDir();
      if (dir) await shell.openPath(dir);
      return { ok: !!dir };
    }
  ));

  ipcMain.handle('privacy:clearLogs', wrapHandler('privacy:clearLogs',
    async () => {
      const removed = logger.clearLogs();
      return { removed };
    }
  ));

  // Live UPnP port-forwarding status for the Advanced settings panel.
  ipcMain.handle('network:getPortForwardStatus', wrapHandler('network:getPortForwardStatus',
    async () => {
      const { getPortForwarding } = await import('../utils/port-forwarding');
      return getPortForwarding().getStatus();
    }
  ));

  // Live adaptive-throttle / network-health snapshot for the Network settings panel.
  ipcMain.handle('network:getHealth', wrapHandler('network:getHealth',
    async () => torrentManager.getNetworkHealth()
  ));

  // DNS-over-HTTPS resolver templates (built-in + custom) for the Network panel.
  ipcMain.handle('doh:getTemplates', wrapHandler('doh:getTemplates',
    async () => {
      const { getDohTemplates } = await import('../services/doh');
      return getDohTemplates();
    }
  ));
  ipcMain.handle('doh:addTemplate', wrapHandler('doh:addTemplate',
    async (_event, name: string, url: string) => {
      const { addDohTemplate } = await import('../services/doh');
      const tpl = await addDohTemplate(name, url);
      // A new custom resolver may be (or become) the active one — re-apply live.
      const s = await db.getSettings();
      await torrentManager.updateSettings({ dohCustomTemplates: s.dohCustomTemplates });
      return tpl;
    }
  ));
  ipcMain.handle('doh:deleteTemplate', wrapHandler('doh:deleteTemplate',
    async (_event, id: string) => {
      const { deleteDohTemplate } = await import('../services/doh');
      const res = await deleteDohTemplate(id);
      const s = await db.getSettings();
      await torrentManager.updateSettings({ dohTemplateId: s.dohTemplateId, dohCustomTemplates: s.dohCustomTemplates });
      return res;
    }
  ));
  ipcMain.handle('doh:test', wrapHandler('doh:test',
    async (_event, url: string) => {
      const { testDohResolver } = await import('../services/doh');
      return testDohResolver(url);
    }
  ));

  // Smart network profiles
  ipcMain.handle('netprofiles:current', wrapHandler('netprofiles:current',
    async () => {
      const { detectNetwork } = await import('../services/network-profiles');
      return detectNetwork();
    }
  ));
  ipcMain.handle('netprofiles:list', wrapHandler('netprofiles:list',
    async () => {
      const { getProfilesState } = await import('../services/network-profiles');
      return getProfilesState();
    }
  ));
  ipcMain.handle('netprofiles:save', wrapHandler('netprofiles:save',
    async (_event, profile: import('../../shared/types').NetworkProfile) => {
      const { saveProfile } = await import('../services/network-profiles');
      return saveProfile(profile);
    }
  ));
  ipcMain.handle('netprofiles:delete', wrapHandler('netprofiles:delete',
    async (_event, id: string) => {
      const { deleteProfile } = await import('../services/network-profiles');
      return deleteProfile(id);
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
      // Register under a friendly name ("Havvn") instead of the raw
      // executable, so Task Manager / Startup lists it as Havvn rather
      // than electron.exe. openAsHidden: start minimised to tray at login.
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: enabled,
        name: 'Havvn',
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
      // name ("Havvn"): getLoginItemSettings() without that name reports
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

  // Relaunch the app (engine switch etc.). app.quit() — not exit() — so the
  // normal shutdown path (cleanup, sidecar stop, DB flush) still runs.
  ipcMain.handle('app:relaunch', wrapHandler('app:relaunch',
    async () => {
      app.relaunch();
      app.quit();
      return { ok: true };
    }
  ));

  // The engine this session actually booted with. Captured at handler setup
  // (before the user can touch settings), so the renderer can tell "configured"
  // apart from "running" and keep its restart-pending banner honest across
  // page remounts.
  const runningEngine = db.getEngineChoice();
  ipcMain.handle('app:getRunningEngine', wrapHandler('app:getRunningEngine',
    async () => runningEngine
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
            ['reg', ['add', 'HKCU\\Software\\Classes\\.torrent', '/ve', '/d', 'Havvn.file', '/f']],
            ['reg', ['add', 'HKCU\\Software\\Classes\\.torrent', '/v', 'Content Type', '/d', 'application/x-bittorrent', '/f']],
            ['reg', ['add', 'HKCU\\Software\\Classes\\Havvn.file', '/ve', '/d', 'BitTorrent Document', '/f']],
            ['reg', ['add', 'HKCU\\Software\\Classes\\Havvn.file\\DefaultIcon', '/ve', '/d', `${iconPath},0`, '/f']],
            ['reg', ['add', 'HKCU\\Software\\Classes\\Havvn.file\\shell\\open\\command', '/ve', '/d', `"${exePath}" "%1"`, '/f']],
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
        defaultPath: 'havvn-settings.json',
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      });

      if (result.canceled || !result.filePath) {
        return { success: false };
      }

      const settings = await db.getSettings();
      const categories = await db.getCategories();
      const scheduler = await db.getScheduler();
      const privacyConfig = await db.getPrivacyConfig();

      // Never write secrets to the export file in plaintext — the store keeps
      // the proxy password encrypted at rest, the export must not undo that.
      const exportableSettings = { ...settings, proxyPassword: '' };

      const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: exportableSettings,
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

      // Apply imported settings. Drop an empty proxyPassword so importing a
      // (secret-stripped) export doesn't wipe a configured password.
      if (importData.settings) {
        const incoming = { ...importData.settings };
        if (!incoming.proxyPassword) delete incoming.proxyPassword;
        await db.updateSettings(incoming);
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

  // Per-torrent connected peers (Peers tab)
  ipcMain.handle('downloads:getPeers', wrapHandler('downloads:getPeers',
    async (_event, id: string) => {
      return torrentManager.getPeers(id);
    }
  ));

  // Aggregated swarm geography for the live world map (all active torrents).
  ipcMain.handle('swarm:getGeo', wrapHandler('swarm:getGeo',
    async () => {
      return torrentManager.getSwarmGeo();
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
      return await torrentManager.addTracker(id, url);
    }
  ));

  ipcMain.handle('downloads:removeTracker', wrapHandler('downloads:removeTracker',
    async (_event, id: string, url: string) => {
      return await torrentManager.removeTracker(id, url);
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

  ipcMain.handle('search:checkPython', wrapHandler('search:checkPython',
    async (_event, force?: boolean) => getPythonStatus(!!force)
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
        await torrentManager.applyIpBlocklist(blSvc.getRanges());
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
      await torrentManager.applyIpBlocklist(blSvc.getRanges());
      return { entryCount: count };
    }
  ));

  ipcMain.handle('blocklist:setEnabled', wrapHandler('blocklist:setEnabled',
    async (_event, id: string, enabled: boolean) => {
      await db.updateIPBlocklist(id, { enabled });
      // Reload blocklist data
      const blSvc = getIPBlocklistService();
      await blSvc.loadAll();
      await torrentManager.applyIpBlocklist(blSvc.getRanges());
    }
  ));

  log.info('IPC handlers setup complete');
}
