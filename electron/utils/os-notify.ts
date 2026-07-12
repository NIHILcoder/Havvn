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

import { Notification } from 'electron';
import { getAppIconPath } from './index';

export function showOsNotification(title: string, body: string, opts?: { critical?: boolean; onClick?: () => void }): void {
  try {
    if (!Notification.isSupported()) return;
    const iconPath = getAppIconPath();
    const n = new Notification({
      title,
      body,
      ...(iconPath ? { icon: iconPath } : {}),
      ...(opts?.critical ? { urgency: 'critical' as const } : {}),
    });
    if (opts?.onClick) n.on('click', opts.onClick);
    n.show();
  } catch {
    /* best-effort */
  }
}
