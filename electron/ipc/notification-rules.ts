import { ipcMain, type BrowserWindow } from 'electron';
import { validateRoomId } from '../utils/security';
import { validateNotificationRule, type NotificationRule } from '../../shared/notification-policy';
import type { RoomNotifyMode } from '../../shared/room-chat-tools';

export function registerNotificationRulesIpc(getWindow: () => BrowserWindow,
  save: (id: string, rule: NotificationRule, mode?: RoomNotifyMode) => Promise<{ ok: boolean }>): void {
  ipcMain.handle('rooms:setNotificationRule', (event, roomId: unknown, input: unknown, mode?: RoomNotifyMode) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted notification rule request');
    validateRoomId(roomId);
    if (['__proto__', 'constructor', 'prototype'].includes(roomId)) throw new Error('Invalid room ID');
    if (mode !== undefined && !['all', 'mentions', 'off'].includes(mode)) throw new Error('Invalid room notification mode');
    return save(roomId, validateNotificationRule(input), mode);
  });
}
