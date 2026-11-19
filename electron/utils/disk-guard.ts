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

import { BrowserWindow } from 'electron';
import { logger, checkDiskSpace, formatBytes } from './index';
import { showOsNotification } from './os-notify';
import * as db from '../db/store';
import { getTorrentManager } from '../torrent';
import { t } from '../i18n';
import { getAppEvents, recordAppEvent, resolveAppEvent } from '../services/app-events';

const log = logger.child('DiskGuard');

const CHECK_INTERVAL_MS = 30_000; // re-check every 30s

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let generation = 0;
let ticking = false;
let tripped = false; // already auto-paused this low-space episode
let mainWindowRef: BrowserWindow | null = null;

export function initDiskGuard(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow;
  void restartGuardFromConfig();
}

/** (Re)start or stop the guard loop based on persisted settings. */
export async function restartGuardFromConfig(): Promise<void> {
  stopDiskGuard();
  const revision = generation;
  let enabled = true;
  try {
    const settings = await db.getSettings();
    enabled = settings.diskGuardEnabled !== false; // default on
  } catch {
    log.warn('Disk guard config unavailable — retaining protection');
  }

  if (revision !== generation) return;
  if (!enabled) {
    getTorrentManager().setTransferBlock('disk', false);
    log.info('Disk-space guard disabled');
    return;
  }

  log.info('Disk-space guard enabled — monitoring');
  tripped = tripped || getAppEvents().isActive('disk-low', { kind: 'system' });
  getTorrentManager().setTransferBlock('disk', tripped);
  const run = async () => { if (ticking) return; ticking = true; try { await tick(revision); } finally { ticking = false; } };
  timer = setInterval(() => { void run(); }, CHECK_INTERVAL_MS);
  initialTimer = setTimeout(() => { initialTimer = null; void run(); }, 3_000);
}

export function stopDiskGuard(): void {
  generation++;
  if (initialTimer) { clearTimeout(initialTimer); initialTimer = null; }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(revision: number): Promise<void> {
  try {
    const settings = await db.getSettings();
    if (revision !== generation) return;
    const thresholdBytes = Math.max(0, (settings.diskGuardMinFreeMB ?? 2048)) * 1024 * 1024;

    const manager = getTorrentManager();
    const downloads = await manager.getDownloads();
    if (revision !== generation) return;
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
      if (revision !== generation) return;
      if (free === null) continue; // couldn't determine this one — skip it
      if (minFree === null || free < minFree) { minFree = free; minPath = p; }
    }
    if (minFree === null) return; // couldn't determine ANY — don't act blindly

    if (minFree < thresholdBytes && !tripped && active.length > 0) {
      tripped = true;
      manager.setTransferBlock('disk', true);
      const count = await manager.pauseAllActive();
      if (revision !== generation) return;
      log.warn('Low disk space — auto-paused all torrents', {
        free: formatBytes(minFree),
        path: minPath,
        threshold: formatBytes(thresholdBytes),
        paused: count,
      });
      notifyLowSpace(minFree, count);
      recordAppEvent('disk-low', { kind: 'system' }, { paused: count });
      sendToRenderer('app:diskLow', { paused: count, freeBytes: minFree, thresholdBytes });
    } else if (minFree >= thresholdBytes && tripped) {
      // Genuine recovery — signal the renderer to clear its banner, THEN re-arm.
      // (Previously the latch was cleared the moment `active` emptied after the
      // auto-pause, so this recovery branch could never fire and the banner stuck.)
      tripped = false;
      manager.setTransferBlock('disk', false);
      resolveAppEvent('disk-low', { kind: 'system' });
      log.info('Disk space recovered — guard re-armed (resume is manual)', { free: formatBytes(minFree), path: minPath });
      sendToRenderer('app:diskRecovered', { freeBytes: minFree });
    }
  } catch (e) {
    log.error('Disk guard tick failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

function notifyLowSpace(free: number, count: number): void {
  showOsNotification(t('notify.lowDisk.title'), count > 0
        ? t(count === 1 ? 'notify.lowDisk.bodyOne' : 'notify.lowDisk.bodyMany', { free: formatBytes(free), count })
        : t('notify.lowDisk.bodyNone', { free: formatBytes(free) }), { critical: true, context: { kind: 'system', group: 'disk-low' } });
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, payload);
  }
}
