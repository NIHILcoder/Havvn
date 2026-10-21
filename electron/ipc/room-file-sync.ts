import { ipcMain, dialog, BrowserWindow } from 'electron';
import type { RoomManager } from '../sharing/room-manager';
import type { SyncFolderChoice, SyncLocalAction } from '../../shared/room-file-sync-ui';
import { SYNC_TRASH_SELECTION_LIMIT } from '../../shared/room-file-sync-ui';
import { SYNC_UUID, SYNC_HASH, validSyncRelativePath, SYNC_HISTORY_REVISION_LIMIT, SYNC_RECOVERY_OPERATION_LIMIT } from '../../shared/room-file-sync';
import { validSyncCacheLimit } from '../db/room-sync-store';
import { validSyncBackupPolicy, type SyncBackupPolicy } from '../../shared/room-file-sync-backups';
import { t } from '../i18n';
import { validSyncExclusions } from '../../shared/room-file-sync-filters';
import { validSyncEditorText } from '../../shared/room-file-sync-editor';
import { validateBackupPassword } from '../db/room-backup';

/** All paths originate in a native picker; renderer confirmation carries only an expiring token. */
export function registerRoomFileSyncIpc(mainWindow: BrowserWindow, manager: RoomManager): void {
  const check = (event: Electron.IpcMainInvokeEvent, roomId: unknown) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted file sync request');
    if (typeof roomId !== 'string' || !SYNC_UUID.test(roomId)) throw new Error('Invalid room ID');
  };
  const root = (id: unknown) => { if (typeof id !== 'string' || !SYNC_UUID.test(id)) throw new Error('Invalid sync root ID'); };
  const picking = new Set<string>();
  let historyPicking = false;
  let trashPicking = false;
  ipcMain.handle('rooms:syncTrashExport', async (event, roomId: string, previewId: string, operationId: string) => {
    check(event, roomId); root(previewId);
    if (typeof operationId !== 'string' || !/^op-[a-zA-Z0-9]{1,128}$/.test(operationId)) throw new Error('Invalid trash operation');
    if (trashPicking) throw new Error('A trash export dialog is already open'); trashPicking = true;
    try {
      return await manager.exportFileSyncTrash(roomId, previewId, operationId, async name => {
        const picked = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() ?? mainWindow, { title: t('dialog.syncTrashExport'), defaultPath: name });
        return picked.canceled || !picked.filePath ? null : picked.filePath;
      });
    } finally { trashPicking = false; }
  });
  ipcMain.handle('rooms:syncTrashPreview', async (event, roomId: string, rootId: string, selected: string[] = []) => {
    check(event, roomId); root(rootId);
    if (!Array.isArray(selected) || selected.length > SYNC_TRASH_SELECTION_LIMIT || new Set(selected).size !== selected.length || selected.some(id => typeof id !== 'string' || !/^op-[a-zA-Z0-9]+$/.test(id))) throw new Error('Invalid trash selection');
    return manager.previewFileSyncTrash(roomId, rootId, selected);
  });
  ipcMain.handle('rooms:syncTrashPage', async (event, roomId: string, previewId: string, offset = 0) => {
    check(event, roomId); root(previewId);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > SYNC_RECOVERY_OPERATION_LIMIT) throw new Error('Invalid trash page');
    return manager.fileSyncTrashPage(roomId, previewId, offset);
  });
  ipcMain.handle('rooms:syncTrashConfirm', async (event, roomId: string, previewId: string) => {
    check(event, roomId); root(previewId); return manager.confirmFileSyncTrash(roomId, previewId);
  });
  ipcMain.handle('rooms:syncMissing', async (event, roomId: string, rootId: string) => {
    check(event, roomId); root(rootId); return manager.fileSyncMissing(roomId, rootId);
  });
  ipcMain.handle('rooms:syncMissingDeletePreview', async (event, roomId: string, rootId: string, entryId: string, stamp: string, acknowledgeMass: boolean) => {
    check(event, roomId); root(rootId); root(entryId);
    if (typeof stamp !== 'string' || !SYNC_HASH.test(stamp) || typeof acknowledgeMass !== 'boolean') throw new Error('Invalid missing deletion review');
    return manager.prepareFileSyncMissingDelete(roomId, rootId, entryId, stamp, acknowledgeMass);
  });
  ipcMain.handle('rooms:syncMetadata', async (event, roomId: string, rootId: string, keep = 2) => {
    check(event, roomId); root(rootId);
    if (!Number.isSafeInteger(keep) || keep < 0 || keep > 8) throw new Error('Invalid retained history count');
    return manager.fileSyncMetadata(roomId, rootId, keep);
  });
  ipcMain.handle('rooms:syncMetadataConfirm', async (event, roomId: string, previewId: string) => {
    check(event, roomId); root(previewId); return manager.confirmFileSyncMetadata(roomId, previewId);
  });
  ipcMain.handle('rooms:syncMetadataExport', async (event, roomId: string, rootId: string, password: string) => {
    check(event, roomId); root(rootId); validateBackupPassword(password);
    if (historyPicking) throw new Error('A history dialog is already open'); historyPicking = true;
    try {
      const picked = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() ?? mainWindow, { title: t('dialog.syncHistoryExport'),
        defaultPath: `havvn-history-${rootId.slice(0, 8)}-${Date.now()}.havvn-history`, filters: [{ name: 'Havvn history', extensions: ['havvn-history'] }] });
      if (picked.canceled || !picked.filePath) return null;
      return await manager.exportFileSyncMetadata(roomId, rootId, password, picked.filePath);
    } finally { historyPicking = false; }
  });
  ipcMain.handle('rooms:syncMetadataImport', async (event, roomId: string, rootId: string, password: string) => {
    check(event, roomId); root(rootId); validateBackupPassword(password);
    if (historyPicking) throw new Error('A history dialog is already open'); historyPicking = true;
    try {
      const picked = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? mainWindow, { title: t('dialog.syncHistoryImport'),
        properties: ['openFile'], filters: [{ name: 'Havvn history', extensions: ['havvn-history'] }] });
      if (picked.canceled || picked.filePaths.length !== 1) return null;
      return await manager.importFileSyncMetadata(roomId, rootId, password, picked.filePaths[0]);
    } finally { historyPicking = false; }
  });
  ipcMain.handle('rooms:syncHistoryFetch', async (event, roomId: string, rootId: string, entryId: string) => {
    check(event, roomId); root(rootId); root(entryId); return manager.fetchFileSyncHistory(roomId, rootId, entryId);
  });
  ipcMain.handle('rooms:syncCheckpointPreview', async (event, roomId: string, rootId: string) => {
    check(event, roomId); root(rootId); return manager.previewFileSyncCheckpoint(roomId, rootId);
  });
  ipcMain.handle('rooms:syncCheckpointConfirm', async (event, roomId: string, previewId: string) => {
    check(event, roomId); root(previewId); return manager.confirmFileSyncCheckpoint(roomId, previewId);
  });
  ipcMain.handle('rooms:syncLogPreview', async (event, roomId: string, rootId: string) => {
    check(event, roomId); root(rootId); return manager.previewFileSyncLog(roomId, rootId);
  });
  ipcMain.handle('rooms:syncLogConfirm', async (event, roomId: string, previewId: string) => {
    check(event, roomId); root(previewId); return manager.confirmFileSyncLog(roomId, previewId);
  });
  ipcMain.handle('rooms:syncEditorOpen', async (event, roomId: string, rootId: string, entryId: string) => {
    check(event, roomId); root(rootId); root(entryId); return manager.openFileSyncEditor(roomId, rootId, entryId);
  });
  ipcMain.handle('rooms:syncEditorSave', async (event, roomId: string, token: string, text: string) => {
    check(event, roomId); root(token);
    if (!validSyncEditorText(text)) throw new Error('Invalid editor text');
    return manager.saveFileSyncEditor(roomId, token, text);
  });
  ipcMain.handle('rooms:syncEditorClose', async (event, roomId: string, token: string) => {
    check(event, roomId); root(token); return manager.closeFileSyncEditor(roomId, token);
  });
  ipcMain.handle('rooms:syncMovePreview', async (event, roomId: string, rootId: string, entryId: string, toPath: string) => {
    check(event, roomId); root(rootId); root(entryId);
    if (!validSyncRelativePath(toPath)) throw new Error('Invalid sync move path');
    return manager.prepareFileSyncMove(roomId, rootId, entryId, toPath);
  });
  ipcMain.handle('rooms:syncMoveConfirm', async (event, roomId: string, previewId: string) => {
    check(event, roomId); root(previewId); return manager.confirmFileSyncMove(roomId, previewId);
  });
  ipcMain.handle('rooms:syncPathConflict', async (event, roomId: string, rootId: string, entryId: string) => {
    check(event, roomId); root(rootId); root(entryId); return manager.fileSyncPathConflict(roomId, rootId, entryId);
  });
  ipcMain.handle('rooms:syncPathPreview', async (event, roomId: string, rootId: string, entryId: string, revisionId: string, toPath: string) => {
    check(event, roomId); root(rootId); root(entryId);
    if (typeof revisionId !== 'string' || !SYNC_HASH.test(revisionId) || !validSyncRelativePath(toPath)) throw new Error('Invalid sync path resolution');
    return manager.prepareFileSyncPathResolution(roomId, rootId, entryId, revisionId, toPath);
  });
  ipcMain.handle('rooms:syncPathConfirm', async (event, roomId: string, previewId: string) => {
    check(event, roomId); root(previewId); return manager.confirmFileSyncPathResolution(roomId, previewId);
  });
  ipcMain.handle('rooms:syncDeletePreview', async (event, roomId: string, rootId: string, entryId: string, resolve?: boolean) => {
    check(event, roomId); root(rootId); root(entryId);
    if (resolve !== undefined && typeof resolve !== 'boolean') throw new Error('Invalid deletion resolution mode');
    return manager.prepareFileSyncDelete(roomId, rootId, entryId, resolve);
  });
  ipcMain.handle('rooms:syncDeleteConfirm', async (event, roomId: string, previewId: string, keepBoth?: boolean) => {
    check(event, roomId); root(previewId);
    if (keepBoth !== undefined && typeof keepBoth !== 'boolean') throw new Error('Invalid deletion recovery choice');
    return manager.confirmFileSyncDelete(roomId, previewId, keepBoth);
  });
  ipcMain.handle('rooms:syncRights', async (event, roomId: string, rootId: string, writers?: string[], moves?: boolean, deletes?: boolean) => {
    check(event, roomId); root(rootId);
    if (writers !== undefined && (!Array.isArray(writers) || writers.length < 1 || writers.length > 16 || new Set(writers).size !== writers.length
      || writers.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)))) throw new Error('Invalid sync writers');
    if (moves !== undefined && typeof moves !== 'boolean') throw new Error('Invalid sync move mode');
    if (deletes !== undefined && typeof deletes !== 'boolean') throw new Error('Invalid sync deletion mode');
    return manager.fileSyncRights(roomId, rootId, writers, moves, deletes);
  });
  ipcMain.handle('rooms:syncRightsConfirm', async (event, roomId: string, previewId: string) => {
    check(event, roomId); root(previewId); return manager.confirmFileSyncRights(roomId, previewId);
  });
  ipcMain.handle('rooms:syncFilters', async (event, roomId: string, rootId: string, rules?: string[]) => {
    check(event, roomId); root(rootId);
    if (rules !== undefined && !validSyncExclusions(rules)) throw new Error('Invalid sync exclusions');
    return manager.previewFileSyncFilters(roomId, rootId, rules);
  });
  ipcMain.handle('rooms:syncFilterPage', async (event, roomId: string, previewId: string, offset = 0) => {
    check(event, roomId); root(previewId);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 12_000) throw new Error('Invalid sync filter page');
    return manager.fileSyncFilterPage(roomId, previewId, offset);
  });
  ipcMain.handle('rooms:syncFilterConfirm', async (event, roomId: string, previewId: string) => {
    check(event, roomId); root(previewId); return manager.confirmFileSyncFilters(roomId, previewId);
  });
  ipcMain.handle('rooms:syncBackups', async (event, roomId: string, rootId: string, policy?: SyncBackupPolicy) => {
    check(event, roomId); root(rootId);
    if (policy !== undefined && !validSyncBackupPolicy(policy)) throw new Error('Invalid backup retention policy');
    return manager.previewFileSyncBackups(roomId, rootId, policy);
  });
  ipcMain.handle('rooms:syncBackupPage', async (event, roomId: string, previewId: string, offset = 0) => {
    check(event, roomId); root(previewId);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > SYNC_RECOVERY_OPERATION_LIMIT) throw new Error('Invalid backup page');
    return manager.fileSyncBackupPage(roomId, previewId, offset);
  });
  ipcMain.handle('rooms:syncBackupConfirm', async (event, roomId: string, previewId: string) => {
    check(event, roomId); root(previewId); return manager.confirmFileSyncBackups(roomId, previewId);
  });
  ipcMain.handle('rooms:syncConflictPreview', async (event, roomId: string, rootId: string, entryId: string) => {
    check(event, roomId); root(rootId); root(entryId); return manager.prepareFileSyncConflict(roomId, rootId, entryId);
  });
  ipcMain.handle('rooms:syncConflictConfirm', async (event, roomId: string, previewId: string, choice: import('../../shared/room-file-sync-ui').SyncConflictChoice) => {
    check(event, roomId); root(previewId);
    if (!['accept', 'keep-both'].includes(choice)) throw new Error('Invalid sync conflict choice');
    return manager.resolveFileSyncConflict(roomId, previewId, choice);
  });
  ipcMain.handle('rooms:syncConflictDefer', async (event, roomId: string, rootId: string, entryId: string) => {
    check(event, roomId); root(rootId); root(entryId); return manager.deferFileSyncConflict(roomId, rootId, entryId);
  });
  ipcMain.handle('rooms:syncHistory', async (event, roomId: string, rootId: string, entryId: string, offset = 0) => {
    check(event, roomId); root(rootId); root(entryId);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > SYNC_HISTORY_REVISION_LIMIT) throw new Error('Invalid history page');
    return manager.fileSyncHistory(roomId, rootId, entryId, offset);
  });
  ipcMain.handle('rooms:syncRestorePreview', async (event, roomId: string, rootId: string, revisionId: string) => {
    check(event, roomId); root(rootId);
    if (typeof revisionId !== 'string' || !SYNC_HASH.test(revisionId)) throw new Error('Invalid sync revision');
    return manager.prepareFileSyncRestore(roomId, rootId, revisionId);
  });
  ipcMain.handle('rooms:syncRestoreConfirm', async (event, roomId: string, previewId: string) => {
    check(event, roomId); root(previewId); return manager.confirmFileSyncRestore(roomId, previewId);
  });
  ipcMain.handle('rooms:syncCache', async (event, roomId: string, rootId: string, limitBytes?: number) => {
    check(event, roomId); root(rootId);
    if (limitBytes !== undefined && !validSyncCacheLimit(limitBytes)) throw new Error('Invalid sync cache limit');
    return manager.fileSyncCache(roomId, rootId, limitBytes);
  });
  ipcMain.handle('rooms:syncState', async (event, roomId: string) => { check(event, roomId); return manager.fileSyncView(roomId); });
  ipcMain.handle('rooms:syncFiles', async (event, roomId: string, rootId: string, offset = 0, trash?: boolean) => {
    check(event, roomId); root(rootId);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 4000) throw new Error('Invalid sync page');
    if (trash !== undefined && typeof trash !== 'boolean') throw new Error('Invalid sync trash mode');
    return manager.fileSyncFiles(roomId, rootId, offset, trash);
  });
  ipcMain.handle('rooms:syncChoose', async (event, roomId: string, choice: SyncFolderChoice) => {
    check(event, roomId);
    if (!choice || !['create', 'bind'].includes(choice.kind)) throw new Error('Invalid sync folder choice');
    if (choice.kind === 'create') {
      if (typeof choice.name !== 'string' || !choice.name.trim() || choice.name.length > 80) throw new Error('Invalid sync folder name');
    } else root(choice.rootId);
    if (picking.has(roomId)) throw new Error('A folder picker is already open');
    picking.add(roomId);
    try {
      return await manager.chooseFileSyncFolder(roomId, choice, async () => {
        const picked = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? mainWindow,
          { title: t('dialog.syncFolder'), properties: ['openDirectory', 'createDirectory'] });
        return picked.canceled || picked.filePaths.length !== 1 ? null : picked.filePaths[0];
      });
    } finally { picking.delete(roomId); }
  });
  ipcMain.handle('rooms:syncConfirm', async (event, roomId: string, previewId: string) => {
    check(event, roomId); root(previewId); return manager.confirmFileSyncFolder(roomId, previewId);
  });
  ipcMain.handle('rooms:syncAction', async (event, roomId: string, rootId: string, action: SyncLocalAction, enabled?: boolean) => {
    check(event, roomId); root(rootId);
    if (!['auto-publish', 'auto-apply', 'mode-manual', 'mode-receive', 'mode-send', 'mode-sync', 'scan', 'unbind', 'open-folder', 'cancel-work'].includes(action)
      || ['auto-publish', 'auto-apply'].includes(action) && typeof enabled !== 'boolean'
      || !['auto-publish', 'auto-apply'].includes(action) && enabled !== undefined) throw new Error('Invalid sync action');
    return manager.fileSyncAction(roomId, rootId, action, enabled);
  });
}
