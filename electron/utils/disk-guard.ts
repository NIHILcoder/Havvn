/**
 * Disk-Space Guard
 *
 * Periodically checks free space on the download directory while torrents are
 * active. If free space falls below the configured threshold, it auto-pauses
 * ALL torrents (so a full disk can't corrupt writes or wedge the client),
 * fires an OS notification, and tells the renderer to show a warning banner.
 *
 * Resume is manual — the user frees space, then resumes. Re-arms automatically
 * once free space recovers above the threshold.
 *
 * Enabled via AppSettings.diskGuardEnabled / diskGuardMinFreeMB.
 */

import { BrowserWindow, Notification } from 'electron';
import { logger, checkDiskSpace, formatBytes, getAppIconPath } from './index';
import * as db from '../db/store';
import { getTorrentManager } from '../torrent';

const log = logger.child('DiskGuard');

const CHECK_INTERVAL_MS = 30_000; // re-check every 30s

let timer: NodeJS.Timeout | null = null;
let tripped = false; // already auto-paused this low-space episode
let mainWindowRef: BrowserWindow | null = null;

export function initDiskGuard(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow;
  void restartGuardFromConfig();
}

/** (Re)start or stop the guard loop based on persisted settings. */
export async function restartGuardFromConfig(): Promise<void> {
  let enabled = false;
  try {
    const settings = await db.getSettings();
    enabled = settings.diskGuardEnabled !== false; // default on
  } catch {
    enabled = false;
  }

  stopDiskGuard();
  if (!enabled) {
    log.info('Disk-space guard disabled');
    return;
  }

  log.info('Disk-space guard enabled — monitoring');
  tripped = false;
  timer = setInterval(() => { void tick(); }, CHECK_INTERVAL_MS);
  setTimeout(() => { void tick(); }, 3_000);
}

export function stopDiskGuard(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  try {
    const settings = await db.getSettings();
    const thresholdBytes = Math.max(0, (settings.diskGuardMinFreeMB ?? 2048)) * 1024 * 1024;

    const manager = getTorrentManager();
    const downloads = await manager.getDownloads();
    const active = downloads.filter(d => d.status === 'downloading' || d.status === 'queued');

    // Idle and not in a low-space episode → nothing to guard.
    if (active.length === 0 && !tripped) return;

    // Check every DISTINCT volume we're actually writing to (or would resume onto),
    // not just the default dir: a torrent can save to another drive, so checking
    // only the default both misses a full target drive and false-alarms when the
    // default drive is low but no active torrent writes there. Include paused
    // torrents' paths too, so recovery is detected on the same volume that tripped
    // even after everything was auto-paused (which empties `active`).
    const relevant = downloads.filter(
      d => d.status === 'downloading' || d.status === 'queued' || d.status === 'paused'
    );
    const paths = new Set<string>([settings.defaultDownloadDir]);
    for (const d of relevant) { if (d.savePath) paths.add(d.savePath); }

    let minFree: number | null = null;
    let minPath = settings.defaultDownloadDir;
    for (const p of paths) {
      const free = await checkDiskSpace(p);
      if (free === null) continue; // couldn't determine this one — skip it
      if (minFree === null || free < minFree) { minFree = free; minPath = p; }
    }
    if (minFree === null) return; // couldn't determine ANY — don't act blindly

    if (minFree < thresholdBytes && !tripped && active.length > 0) {
      tripped = true;
      const count = await manager.pauseAllActive();
      log.warn('Low disk space — auto-paused all torrents', {
        free: formatBytes(minFree),
        path: minPath,
        threshold: formatBytes(thresholdBytes),
        paused: count,
      });
      notifyLowSpace(minFree, count);
      sendToRenderer('app:diskLow', { paused: count, freeBytes: minFree, thresholdBytes });
    } else if (minFree >= thresholdBytes && tripped) {
      // Genuine recovery — signal the renderer to clear its banner, THEN re-arm.
      // (Previously the latch was cleared the moment `active` emptied after the
      // auto-pause, so this recovery branch could never fire and the banner stuck.)
      tripped = false;
      log.info('Disk space recovered — guard re-armed (resume is manual)', { free: formatBytes(minFree), path: minPath });
      sendToRenderer('app:diskRecovered', { freeBytes: minFree });
    }
  } catch (e) {
    log.error('Disk guard tick failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

function notifyLowSpace(free: number, count: number): void {
  try {
    if (!Notification.isSupported()) return;
    const iconPath = getAppIconPath();
    const n = new Notification({
      title: 'Low disk space — torrents paused',
      body: count > 0
        ? `Only ${formatBytes(free)} free. Paused ${count} torrent${count === 1 ? '' : 's'}. Free up space, then resume manually.`
        : `Only ${formatBytes(free)} free on the download drive.`,
      ...(iconPath ? { icon: iconPath } : {}),
      urgency: 'critical',
    });
    n.show();
  } catch {
    /* best-effort */
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, payload);
  }
}
