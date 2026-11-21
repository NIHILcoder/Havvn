/**
 * Shared OS-notification builder for the main-process guards (vpn-guard,
 * disk-guard, …): Notification.isSupported guard + app icon + best-effort
 * try/catch in one place.
 *
 * Lives OUTSIDE utils/index on purpose: the barrel is imported from the
 * torrent-host utilityProcess (logger, vpn-detector), which must never pull in
 * the Electron renderer-facing modules. Import this file directly from
 * main-process code only.
 */

import { Notification, type BrowserWindow } from 'electron';
import { getAppIconPath } from './index';
import { NotificationCenter } from '../services/notification-center';
import type { NotificationContext } from '../../shared/notification-policy';
import { t } from '../i18n';

let getWindow: (() => BrowserWindow | null) | undefined;
export function setNotificationWindow(read: () => BrowserWindow | null): void { getWindow = read; }
const center = new NotificationCenter({
  read: async context => {
    const db = await import('../db/store.js');
    return db.readNotificationEnvironments([context])[0];
  },
  readMany: async contexts => (await import('../db/store.js')).readNotificationEnvironments(contexts),
  privateMessage: () => ({ title: t('notify.private.title'), body: t('notify.private.body') }),
  summary: (kind, count) => ({ title: t(`notify.summary.${kind}`), body: t('notify.summary.body', { count }) }),
  sound: () => { const window = getWindow?.(); if (window && !window.isDestroyed()) window.webContents.send('app:notificationSound'); },
  popup: message => {
  try {
    if (!Notification.isSupported()) return;
    const iconPath = getAppIconPath();
    const n = new Notification({
      title: message.title,
      body: message.body,
      // App audio is separate so turning off popups doesn't disable sound.
      silent: true,
      ...(iconPath ? { icon: iconPath } : {}),
      ...(message.critical ? { urgency: 'critical' as const } : {}),
    });
    if (message.onClick) n.on('click', message.onClick);
    n.show();
  } catch {
    /* best-effort */
  }
  },
});

export function showOsNotification(title: string, body: string, opts?: { critical?: boolean; silent?: boolean; onClick?: () => void; context?: NotificationContext }): void {
  const onClick = opts?.onClick ?? (() => {
    try {
      const window = getWindow?.();
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore(); window.show(); window.focus();
    } catch { /* Window closed while the notification was visible. */ }
  });
  void center.notify({ title, body, critical: opts?.critical, silent: opts?.silent, onClick, context: opts?.context ?? { kind: 'system', group: title.slice(0, 200) } }).catch(() => {});
}
