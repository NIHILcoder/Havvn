/**
 * HostEnv — the handful of Electron `app` values the torrent engine needs.
 *
 * The engine is being moved into a `utilityProcess`, which has NO access to the
 * Electron `app` module. So instead of calling `app.getVersion()` /
 * `app.getPath(...)` directly, the engine reads them from here. In the main
 * process these are derived from `app` lazily (the default); the host process
 * calls `setHostEnv()` with values passed in its init message before creating
 * the manager, so it never touches `app`.
 */

export interface HostEnv {
  version: string;
  isPackaged: boolean;
  tempDir: string;
  userDataDir: string;
  downloadsDir: string;
  /** Which download engine the host should run (settings.engine, HAVVN_ENGINE overrides). */
  engine: 'native' | 'webtorrent';
  /** Absolute path to transmission-daemon(.exe), null when not vendored for this platform. */
  engineBinary: string | null;
  /** The native engine's config/resume state dir (under userData). */
  engineStateDir: string;
}

let env: HostEnv | null = null;

/** Host process: install the values forwarded from main (call before manager use). */
export function setHostEnv(e: HostEnv): void {
  env = e;
}

/** Read the host environment. Falls back to Electron `app` (main process only). */
export function getHostEnv(): HostEnv {
  if (!env) {
    // Lazy requires so the host process (which always setHostEnv() first) never
    // pulls in the Electron `app` module or the store, which don't exist there.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getEngineChoice } = require('../../db/store') as typeof import('../../db/store.js');

    // Only a Windows daemon is vendored today; other platforms fall back below.
    const engineBinary = process.platform === 'win32'
      ? (app.isPackaged
        ? path.join(process.resourcesPath, 'engine', 'transmission-daemon.exe')
        : path.join(app.getAppPath(), 'vendor', 'transmission', 'win32-x64', 'transmission-daemon.exe'))
      : null;
    let engine = getEngineChoice();
    if (engine === 'native' && (!engineBinary || !fs.existsSync(engineBinary))) {
      // Fresh clone without `node scripts/fetch-transmission.mjs`, or an
      // unsupported platform — degrade to the legacy engine instead of a
      // host that can never come up.
      console.warn(`[host-env] native engine binary missing (${engineBinary ?? 'unsupported platform'}) — falling back to webtorrent`);
      engine = 'webtorrent';
    }

    env = {
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      tempDir: app.getPath('temp'),
      userDataDir: app.getPath('userData'),
      downloadsDir: app.getPath('downloads'),
      engine,
      engineBinary,
      engineStateDir: path.join(app.getPath('userData'), 'engine'),
    };
  }
  return env;
}
