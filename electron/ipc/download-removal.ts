import { ipcMain, type BrowserWindow } from 'electron';
import type { DownloadDeletionPlan } from '../../shared/download-removal';
import { DownloadDeletionPreviews } from '../services/download-deletion-preview';
import { DownloadRemovalJournal } from '../services/download-removal';
import type { DownloadRemovalSnapshot, DownloadUndoWarning } from '../../shared/download-removal';
import type { DownloadStatus } from '../../shared/types';

export function registerDownloadRemovalIpc(getWindow: () => BrowserWindow, engine: {
  captureDownloadRemoval(id: string): Promise<DownloadRemovalSnapshot>;
  removeDownload(id: string, deleteFiles: boolean, signature?: string, plan?: DownloadDeletionPlan): Promise<void>;
  restoreRemovedDownload(snapshot: DownloadRemovalSnapshot, recordOnly?: boolean): Promise<{ warnings: DownloadUndoWarning[] }>;
  activateRestoredDownload(id: string, status: DownloadStatus): Promise<void>;
}, resumeWarnings: (snapshot: DownloadRemovalSnapshot) => Promise<DownloadUndoWarning[]>) {
  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted download undo request');
  };
  const journal = new DownloadRemovalJournal({
    capture: id => engine.captureDownloadRemoval(id),
    remove: (id, deleteFiles, signature, plan) => plan ? engine.removeDownload(id, deleteFiles, signature, plan) : engine.removeDownload(id, deleteFiles, signature),
    restore: async snapshot => {
      let before: DownloadUndoWarning[];
      try { before = await resumeWarnings(snapshot); } catch { before = ['vpn']; }
      // Unsafe or unmeasured conditions permit the record/metadata restore only;
      // even a paused engine entry must not start discovery while checking disk.
      const result = await engine.restoreRemovedDownload(snapshot, before.length > 0);
      if (before.length) return { warnings: [...result.warnings, ...before] };
      if (['queued', 'downloading', 'seeding'].includes(snapshot.download.status)
        && !result.warnings.some(warning => ['data-changed', 'engine', 'verification-pending'].includes(warning))) {
        // Re-evaluate after disk verification, which can be long. A route/limit
        // checked before verification is not a permission to resume later.
        let blocked: DownloadUndoWarning[];
        try { blocked = await resumeWarnings(snapshot); } catch { blocked = ['vpn']; }
        result.warnings.push(...blocked);
        if (!blocked.length) {
          try { await engine.activateRestoredDownload(snapshot.download.id, snapshot.download.status); }
          catch { result.warnings.push('engine'); }
        }
      }
      return result;
    },
  }, () => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('downloads:undo:changed');
  });
  ipcMain.handle('downloads:undo:list', event => { trusted(event); return journal.state(); });
  ipcMain.handle('downloads:undo', (event, token: unknown) => {
    trusted(event);
    if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/i.test(token)) throw new Error('Invalid undo token');
    return journal.undo(token);
  });
  const previews = new DownloadDeletionPreviews(id => engine.captureDownloadRemoval(id));
  ipcMain.handle('downloads:deletePreview', (event, id: unknown) => {
    trusted(event);
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid download id');
    return previews.preview(id);
  });
  const timer = setInterval(() => { journal.prune(); previews.prune(); }, 1000); timer.unref();
  return { journal, previews, trusted, dispose: () => { clearInterval(timer); previews.clear(); } };
}
