import { ipcMain, type BrowserWindow } from 'electron';
import { StorageOverviewController } from '../services/storage-overview';
import { storageSources, type StorageSourcesOptions } from '../services/storage-sources';

export function registerStorageOverviewIpc(window: BrowserWindow, options: StorageSourcesOptions): void {
  const controller = new StorageOverviewController(storageSources(options));
  const check = (event: Electron.IpcMainInvokeEvent, id: unknown): string => {
    if (event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw Error('Untrusted storage request');
    if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw Error('Invalid storage request');
    return id;
  };
  ipcMain.handle('storage:scan', (event, id: string) => controller.scan(check(event, id), progress => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('storage:progress', progress);
  }));
  ipcMain.handle('storage:cancel', (event, id: string) => controller.cancel(check(event, id)));
  window.webContents.once('destroyed', () => controller.close());
}
