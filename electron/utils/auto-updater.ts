/**
 * Auto-updater (electron-updater + GitHub releases)
 *
 * - Only runs in a packaged build (electron-updater can't work in dev).
 * - If AppSettings.autoUpdate is on, checks on startup and downloads silently,
 *   then installs on quit (or prompts).
 * - Always supports a manual "Check for updates" trigger from Settings.
 * - Streams status to the renderer via 'app:updateStatus' so the UI can show
 *   progress / "update ready" without a fake GitHub-API check.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { logger } from './logger';
import * as db from '../db/store';

const log = logger.child('AutoUpdater');

export type UpdateStatusKind =
  | 'checking' | 'available' | 'not-available' | 'downloading'
  | 'downloaded' | 'error' | 'dev-disabled';

let mainWindowRef: BrowserWindow | null = null;
let wired = false;
// True while a user-initiated "Check for updates" is in flight. A manual check
// is an explicit intent to update, so we download even if auto-update is off.
let manualCheck = false;

function send(kind: UpdateStatusKind, payload: Record<string, unknown> = {}): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('app:updateStatus', { kind, ...payload });
  }
}

/**
 * Turn electron-updater's cryptic errors into something a user can act on.
 * The most common one is a 404 on `latest.yml`: the GitHub release exists but
 * was published without the update-metadata file that electron-builder
 * generates (e.g. the installer was uploaded by hand). Without latest.yml the
 * updater has no way to know the version or download URL.
 */
function friendlyUpdateError(err: unknown): string {
  const raw = err == null ? 'unknown' : String((err as Error).message || err);
  if (/latest\.yml/i.test(raw) && /404/.test(raw)) {
    return (
      'No update metadata (latest.yml) was found in the latest GitHub release. ' +
      'This usually means the release was published manually without the auto-update ' +
      'files. Releases must be built and published with electron-builder ' +
      '(npm run dist) so that latest.yml is uploaded alongside the installer.'
    );
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(raw)) {
    return 'Could not reach the update server. Check your internet connection and try again.';
  }
  return raw;
}

export async function initAutoUpdater(mainWindow: BrowserWindow): Promise<void> {
  mainWindowRef = mainWindow;

  // Manual check from the UI — always available, even when auto-update is off.
  if (!wired) {
    wired = true;
    ipcMain.handle('app:checkForUpdates', async () => {
      if (!app.isPackaged) {
        send('dev-disabled');
        return { ok: false, reason: 'dev' };
      }
      try {
        manualCheck = true;
        send('checking');
        await autoUpdater.checkForUpdates();
        return { ok: true };
      } catch (e) {
        manualCheck = false;
        log.error('Manual update check failed', { error: e instanceof Error ? e.message : String(e) });
        send('error', { message: friendlyUpdateError(e) });
        return { ok: false, reason: 'error' };
      }
    });

    // Trigger install of an already-downloaded update
    ipcMain.handle('app:quitAndInstall', async () => {
      try {
        autoUpdater.quitAndInstall();
        return { ok: true };
      } catch (e) {
        log.error('quitAndInstall failed', { error: e instanceof Error ? e.message : String(e) });
        return { ok: false };
      }
    });
  }

  if (!app.isPackaged) {
    log.info('Auto-updater disabled in dev build');
    return;
  }

  // Don't auto-download; we decide based on the setting.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Pick up prerelease (beta/alpha/rc) GitHub releases when the installed
  // build is itself a prerelease. A stable build won't be offered betas.
  autoUpdater.allowPrerelease = /-(?:alpha|beta|rc)/i.test(app.getVersion());
  autoUpdater.logger = {
    info: (m: unknown) => log.info(String(m)),
    warn: (m: unknown) => log.warn(String(m)),
    error: (m: unknown) => log.error(String(m)),
    debug: (m: unknown) => log.debug(String(m)),
  } as any;

  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) => {
    send('available', { version: info.version });
    // Download when auto-update is on OR the user manually triggered the check
    // (manual check = explicit intent to update).
    void db.getSettings().then((s) => {
      const wasManual = manualCheck;
      manualCheck = false;
      if (s.autoUpdate || wasManual) {
        log.info('Downloading update', { version: info.version, manual: wasManual, autoUpdate: s.autoUpdate });
        autoUpdater.downloadUpdate().catch((e) => {
          send('error', { message: friendlyUpdateError(e) });
        });
      }
    });
  });
  autoUpdater.on('update-not-available', () => { manualCheck = false; send('not-available'); });
  autoUpdater.on('download-progress', (p) => {
    send('downloading', { percent: Math.round(p.percent), bytesPerSecond: p.bytesPerSecond });
  });
  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded', { version: info.version });
    send('downloaded', { version: info.version });
  });
  autoUpdater.on('error', (err) => {
    manualCheck = false;
    log.error('Updater error', { error: err == null ? 'unknown' : String(err) });
    send('error', { message: friendlyUpdateError(err) });
  });

  // On startup: if auto-update is enabled, check (download is triggered by the
  // 'update-available' handler above). A short delay lets the app settle.
  try {
    const settings = await db.getSettings();
    if (settings.autoUpdate) {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch((e) => {
          log.warn('Startup update check failed', { error: e instanceof Error ? e.message : String(e) });
        });
      }, 8000);
    }
  } catch {
    /* ignore */
  }
}
