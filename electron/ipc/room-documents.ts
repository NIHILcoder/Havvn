import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RoomManager } from '../sharing/room-manager';
import { DOCUMENT_UUID, DOCUMENT_MEMBER, DOCUMENT_HASH, DOCUMENT_UPDATE_BYTES, documentBase64, validDocumentText, validDocumentTitle, type DocumentPresence } from '../../shared/room-documents';
import { assertSyncPlainPath } from '../sharing/room-sync-snapshot';

export function registerRoomDocumentsIpc(window: BrowserWindow, manager: RoomManager): void {
  const uuid = (value: unknown) => { if (typeof value !== 'string' || !DOCUMENT_UUID.test(value)) throw new Error('Invalid document session'); };
  const writers = (value: unknown) => { if (!Array.isArray(value) || value.length > 32 || value.some(v => typeof v !== 'string' || !DOCUMENT_MEMBER.test(v))) throw new Error('Invalid document writers'); };
  const check = (event: Electron.IpcMainInvokeEvent, roomId: unknown, token?: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted document request');
    uuid(roomId); if (token !== undefined) uuid(token);
  };
  ipcMain.handle('rooms:docsView', (e, roomId: string) => { check(e, roomId); return manager.documentsView(roomId); });
  ipcMain.handle('rooms:docsCreate', (e, roomId: string, title: string, language: 'markdown' | 'text', text: string, ids: string[]) => {
    check(e, roomId); writers(ids); if (!validDocumentTitle(title) || !validDocumentText(text) || !['markdown', 'text'].includes(language)) throw new Error('Invalid document');
    return manager.documents(roomId).create(title, language, text, ids);
  });
  ipcMain.handle('rooms:docsOpen', (e, roomId: string, id: string) => { check(e, roomId, id); return manager.documents(roomId).open(id); });
  ipcMain.handle('rooms:docsRequestAccess', (e, roomId: string, id: string, expected: string) => {
    check(e, roomId, id); if (typeof expected !== 'string' || !DOCUMENT_HASH.test(expected)) throw new Error('Invalid document policy');
    return manager.documents(roomId).requestAccess(id, expected);
  });
  ipcMain.handle('rooms:docsDismissAccess', (e, roomId: string, id: string, requestId: string) => { check(e, roomId, id); uuid(requestId); return manager.documents(roomId).dismissAccess(id, requestId); });
  ipcMain.handle('rooms:docsPoll', (e, roomId: string, token: string, version: number) => {
    check(e, roomId, token); if (!Number.isSafeInteger(version) || version < -1) throw new Error('Invalid document version'); return manager.documents(roomId).poll(token, version);
  });
  ipcMain.handle('rooms:docsUpdate', (e, roomId: string, token: string, data: string) => {
    check(e, roomId, token); if (!documentBase64(data, DOCUMENT_UPDATE_BYTES)) throw new Error('Invalid document update'); return manager.documents(roomId).update(token, data);
  });
  ipcMain.handle('rooms:docsClose', (e, roomId: string, token: string) => { check(e, roomId, token); manager.documents(roomId).closeDocument(token); });
  ipcMain.handle('rooms:docsPresence', (e, roomId: string, token: string, value: Pick<DocumentPresence, 'clientId' | 'anchor' | 'head'>) => {
    check(e, roomId, token);
    if (!value || !Number.isSafeInteger(value.clientId) || value.clientId < 0 || value.clientId > 0xffffffff || [value.anchor, value.head].some(v => v !== null && !documentBase64(v, 256))) throw new Error('Invalid document cursor');
    return manager.documents(roomId).presence(token, { clientId: value.clientId, anchor: value.anchor, head: value.head });
  });
  ipcMain.handle('rooms:docsPolicy', (e, roomId: string, id: string, expected: string, title: string, ids: string[], archived: boolean) => {
    check(e, roomId, id); writers(ids); if (typeof expected !== 'string' || !DOCUMENT_HASH.test(expected) || !validDocumentTitle(title) || typeof archived !== 'boolean') throw new Error('Invalid document policy');
    return manager.documents(roomId).changePolicy(id, expected, title, ids, archived);
  });
  ipcMain.handle('rooms:docsHistory', (e, roomId: string, token: string) => { check(e, roomId, token); return manager.documents(roomId).history(token); });
  ipcMain.handle('rooms:docsSnapshot', (e, roomId: string, token: string, label: string) => { check(e, roomId, token); return manager.documents(roomId).snapshot(token, label); });
  ipcMain.handle('rooms:docsKeepDraft', (e, roomId: string, token: string, text: string) => {
    check(e, roomId, token); if (!validDocumentText(text)) throw new Error('Invalid local draft'); return manager.documents(roomId).keepDraft(token, text);
  });
  ipcMain.handle('rooms:docsRestore', (e, roomId: string, token: string, id: string) => { check(e, roomId, token); uuid(id); return manager.documents(roomId).restoreSnapshot(token, id); });
  ipcMain.handle('rooms:docsReview', (e, roomId: string, token: string, choice: 'apply' | 'discard') => { check(e, roomId, token); return manager.documents(roomId).reviewDraft(token, choice); });
  let picking = false;
  ipcMain.handle('rooms:docsExport', async (e, roomId: string, token: string) => {
    check(e, roomId, token); if (picking) throw new Error('An export dialog is already open'); picking = true;
    try {
      const service = manager.documents(roomId), value = await service.exportText(token);
      const extension = value.language === 'markdown' ? 'md' : 'txt';
      const picked = await dialog.showSaveDialog(window, { defaultPath: value.title.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_') + '.' + extension, filters: [{ name: 'Text', extensions: [extension] }] });
      if (picked.canceled || !picked.filePath) return false;
      if (!service.current() || manager.documents(roomId) !== service) throw new Error('Document context changed');
      const target = path.resolve(picked.filePath), privateRoot = path.resolve(app.getPath('userData'));
      const relative = path.relative(privateRoot, target);
      if (!relative || !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('Choose a location outside application storage');
      assertSyncPlainPath(target);
      // Export is a new standalone file. Never replace an existing file or follow links.
      await fs.writeFile(target, value.text, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); return true;
    } finally { picking = false; }
  });
}
