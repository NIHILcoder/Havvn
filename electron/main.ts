import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, shell, session, ipcMain } from 'electron';
import path from 'path';
import dotenv from 'dotenv';
import { getTorrentManager } from './torrent';
import { getSchedulerEngine } from './scheduler/scheduler-engine';
import { setupIpcHandlers } from './ipc';
import { logger, detectVPN, showVPNWarning, getAppIconPath } from './utils';
import { store, seedDefaultsIfNeeded } from './db/store';
import { getRSSService } from './services/rss-service';
import { getIPBlocklistService } from './services/ip-blocklist';
import { getWatchFolderService } from './torrent/watch-folder';


// Load environment variables
dotenv.config();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// Torrent/magnet handed to us by the OS (file double-click or magnet: link).
// On a cold start the renderer isn't listening yet, so we buffer the URI and
// flush it once the renderer signals it's ready (see 'app:rendererReady').
let rendererReady = false;
let pendingOpenUri: string | null = null;

function deliverOpenTorrent(uri: string): void {
  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('app:openTorrent', uri);
  } else {
    // Renderer not ready yet (cold start) — remember it and flush on ready
    pendingOpenUri = uri;
  }
}

// Renderer tells us its IPC listeners are attached; flush any buffered open.
ipcMain.on('app:rendererReady', () => {
  rendererReady = true;
  if (pendingOpenUri) {
    const uri = pendingOpenUri;
    pendingOpenUri = null;
    deliverOpenTorrent(uri);
  }
});

// === Single Instance Lock ===
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Someone tried to run a second instance — focus existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }

    // Handle protocol/file arguments from second instance
    const arg = commandLine.find(a => a.startsWith('magnet:') || a.endsWith('.torrent'));
    if (arg) {
      deliverOpenTorrent(arg);
    }
  });
}

// === Register magnet: protocol handler ===
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('magnet', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('magnet');
}

// Shows a one-time hint when the app first hides into the tray, so users
// don't think it crashed. Persisted via store so it appears only once ever.
function showTrayHintOnce(): void {
  try {
    if ((store as any).get('trayHintShown')) return;
    (store as any).set('trayHintShown', true);

    const title = 'TorrentHunt продолжает работать в фоне';
    const body = 'Загрузки активны. Откройте окно или выйдите через значок в системном трее.';

    if (Notification.isSupported()) {
      const iconPath = getAppIconPath();
      const notification = new Notification({
        title,
        body,
        ...(iconPath ? { icon: iconPath } : {}),
        silent: true,
      });
      notification.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
      });
      notification.show();
    } else {
      // Fallback for older Windows: balloon from the tray icon
      tray?.displayBalloon({ title, content: body });
    }
  } catch {
    // Notifications are best-effort — never block hiding to tray
  }
}

// === Tray Icon ===
function createTray(): void {
  let trayIcon: Electron.NativeImage;

  const iconPath = getAppIconPath();
  if (iconPath) {
    trayIcon = nativeImage.createFromPath(iconPath);
  } else {
    // Final fallback: draw a small icon programmatically
    trayIcon = nativeImage.createFromBuffer(
      Buffer.from(createTrayIconPNG()),
      { width: 16, height: 16 }
    );
  }

  // On Windows a 16x16 tray icon renders crispest; .ico is multi-resolution so resize picks the right frame
  tray = new Tray(trayIcon.isEmpty() ? trayIcon : trayIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip('TorrentHunt — Running in background');

  const buildContextMenu = () => Menu.buildFromTemplate([
    {
      label: 'Open TorrentHunt',
      type: 'normal',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          if (mainWindow.isMinimized()) mainWindow.restore();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Pause All Downloads',
      type: 'normal',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app:pauseAll');
        }
      },
    },
    {
      label: 'Resume All Downloads',
      type: 'normal',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app:resumeAll');
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit TorrentHunt',
      type: 'normal',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(buildContextMenu());

  // Rebuild menu when needed (e.g., after settings change)
  tray.on('right-click', () => {
    tray?.setContextMenu(buildContextMenu());
  });

  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

/**
 * Create a simple 16x16 tray icon as raw RGBA PNG data
 * This creates a simple blue circle icon
 */
function createTrayIconPNG(): number[] {
  // Simple 16x16 RGBA buffer (blue circle)
  const size = 16;
  const data: number[] = [];
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= r) {
        // Blue color (#3b82f6)
        data.push(59, 130, 246, 255);
      } else {
        // Transparent
        data.push(0, 0, 0, 0);
      }
    }
  }
  return data;
}

async function createWindow(): Promise<void> {
  // Check if we should start hidden (launched at login with openAsHidden)
  const loginSettings = app.getLoginItemSettings();
  const startHidden = loginSettings.wasOpenedAsHidden === true;

  const appIconPath = getAppIconPath();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    ...(appIconPath ? { icon: appIconPath } : {}),
    show: !startHidden, // Don't show window if launched hidden at startup
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    title: 'TorrentHunt',
    backgroundColor: '#0B0E17',
  });

  // Setup IPC handlers
  setupIpcHandlers(mainWindow);

  // === Security: navigation & new-window guards ===
  // Torrent names, RSS content and search results are untrusted data rendered in
  // the UI. Prevent the window from ever navigating away from the app, and route
  // any external link to the user's default browser instead of opening it in-app.
  const isDev = process.env.NODE_ENV === 'development';
  const allowedOrigin = isDev ? 'http://localhost:3000' : 'file://';

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(allowedOrigin)) {
      event.preventDefault();
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url);
      }
    }
  });

  // In development, load from webpack dev server
  
  if (isDev) {
    await mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    // __dirname is dist/electron/electron/ due to tsconfig rootDir
    await mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
    // No DevTools in production
  }

  // Show window once ready (after content loaded) if not starting hidden
  if (!startHidden) {
    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
    });
  }

  // === Tray behavior: Minimize to Tray ===
  mainWindow.on('minimize', (event: Electron.Event) => {
    const settings = store.get('settings') as any;
    if (settings?.minimizeToTray) {
      event.preventDefault();
      mainWindow?.hide();
      showTrayHintOnce();
    }
  });

  // === Tray behavior: Close to Tray ===
  mainWindow.on('close', (event: Electron.Event) => {
    if (!isQuitting) {
      const settings = store.get('settings') as any;
      if (settings?.closeToTray) {
        event.preventDefault();
        mainWindow?.hide();
        // Update tray tooltip to indicate background mode
        tray?.setToolTip('TorrentHunt — Running in background');
        showTrayHintOnce();
      }
    }
  });

  mainWindow.on('show', () => {
    tray?.setToolTip('TorrentHunt');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });

  // If the window is reloaded, the renderer must re-announce readiness
  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });

  // Handle startup arguments (magnet links, .torrent files).
  // Buffered until the renderer signals readiness — avoids losing the first
  // open on a cold start (the classic "first click just opens the app" bug).
  const startupArg = process.argv.find(a => a.startsWith('magnet:') || a.endsWith('.torrent'));
  if (startupArg) {
    pendingOpenUri = startupArg;
  }
}

// Apply a Content-Security-Policy to the renderer. Only enabled in production —
// the webpack dev server relies on eval/websocket which a strict CSP would break.
// This mitigates XSS from untrusted strings (torrent names, RSS/search results).
function applyContentSecurityPolicy(): void {
  if (process.env.NODE_ENV === 'development') return;

  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // CSS-in-JS / framer-motion inject inline styles
    "img-src 'self' data: https: http:", // posters, QR codes, remote thumbnails
    "font-src 'self' data:",
    // Local-only WebTorrent streaming server (127.0.0.1:<random port>)
    "media-src 'self' http://127.0.0.1:* http://localhost:*",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

async function initializeApp(): Promise<void> {
  // Disable GPU shader disk cache to prevent cache access errors
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

  // Identify the app to Windows so notifications/toasts are attributed correctly
  // (otherwise they appear to come from "electron.exe", and may be suppressed).
  app.setAppUserModelId('com.torrenthunt.app');

  // Initialize logger first, honoring privacy settings (disable/sanitize logs)
  const privacyCfg = (store.get('privacyConfig') as any) || {};
  logger.initialize({
    minLevel: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
    disableFileLogging: privacyCfg.disableLogs === true,
    sanitize: privacyCfg.sanitizeLogs === true,
  });

  logger.info('App', 'TorrentHunt starting...');

  // Safety net: log async errors from native deps (e.g. utp-native socket
  // errors, networking hiccups) instead of letting Electron pop an endless
  // "A JavaScript error occurred in the main process" dialog. Genuine startup
  // bugs still surface in logs.
  process.on('uncaughtException', (err) => {
    logger.error('App', 'Uncaught exception (suppressed)', {
      message: err?.message,
      stack: err?.stack,
    });
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('App', 'Unhandled rejection (suppressed)', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  // Apply CSP before any window loads content
  applyContentSecurityPolicy();

  // Initialize torrent manager (which will use electron-store)
  const torrentManager = getTorrentManager();
  await torrentManager.initialize();
  logger.info('App', 'Torrent manager initialized with electron-store.');

  // Seed first-run defaults (built-in Internet Archive provider + suggested
  // disabled RSS feeds). Runs once; no network traffic results from this.
  try {
    await seedDefaultsIfNeeded();
    logger.info('App', 'First-run defaults ensured.');
  } catch (e) {
    logger.error('App', 'Failed to seed defaults', { error: e });
  }

  // Start scheduler engine
  const scheduler = getSchedulerEngine();
  scheduler.start();
  logger.info('App', 'Scheduler engine started.');

  // Create system tray
  createTray();
  logger.info('App', 'System tray created.');

  // Create main window
  await createWindow();
  logger.info('App', 'Main window created.');

  // Start the VPN kill-switch guard (no-op unless enabled in privacy settings)
  try {
    if (mainWindow) {
      const { initVpnGuard } = await import('./utils/vpn-guard');
      initVpnGuard(mainWindow);
    }
  } catch (e) {
    logger.error('App', 'Failed to init VPN guard', { error: e });
  }

  // Start the disk-space guard (auto-pauses torrents when free space is low)
  try {
    if (mainWindow) {
      const { initDiskGuard } = await import('./utils/disk-guard');
      initDiskGuard(mainWindow);
    }
  } catch (e) {
    logger.error('App', 'Failed to init disk guard', { error: e });
  }

  // Initialize the auto-updater (no-op in dev; respects the autoUpdate setting)
  try {
    if (mainWindow) {
      const { initAutoUpdater } = await import('./utils/auto-updater');
      await initAutoUpdater(mainWindow);
    }
  } catch (e) {
    logger.error('App', 'Failed to init auto-updater', { error: e });
  }

  // Apply auto-launch setting (registered as "TorrentHunt", not electron.exe)
  const settings = store.get('settings') as any;
  if (settings?.autoLaunch !== undefined) {
    app.setLoginItemSettings({
      openAtLogin: settings.autoLaunch,
      openAsHidden: settings.autoLaunch,
      name: 'TorrentHunt',
      path: process.execPath,
    });
  }

  // Initialize IP blocklist (load from store, apply to client)
  try {
    const torrentManager = getTorrentManager();
    const blocklistService = getIPBlocklistService();
    await blocklistService.loadAll();
    blocklistService.applyToClient((torrentManager as any).client);
    logger.info('App', 'IP blocklist service initialized.');
  } catch (e) {
    logger.error('App', 'Failed to initialize IP blocklist', { error: e });
  }

  // Initialize RSS service
  try {
    const rssService = getRSSService();
    await rssService.initialize();
    logger.info('App', 'RSS service initialized.');
  } catch (e) {
    logger.error('App', 'Failed to initialize RSS service', { error: e });
  }

  // Initialize watch folder
  try {
    if (settings?.watchFolderEnabled && settings?.watchFolderPath) {
      const watchFolder = getWatchFolderService();
      watchFolder.start(settings.watchFolderPath, settings.watchFolderDeleteAfterAdd ?? false);
      logger.info('App', 'Watch folder service started.', { path: settings.watchFolderPath });
    }
  } catch (e) {
    logger.error('App', 'Failed to initialize watch folder', { error: e });
  }

  // Check VPN status on startup
  setTimeout(async () => {
    try {
      logger.info('App', 'Checking VPN status...');
      const vpnResult = await detectVPN();

      if (!vpnResult.isVPNActive) {
        logger.warn('App', 'VPN not detected!', {
          confidence: vpnResult.confidence,
        });
        // Show warning dialog
        showVPNWarning(vpnResult);
      } else {
        logger.info('App', 'VPN detected', {
          provider: vpnResult.details.vpnProvider,
          confidence: vpnResult.confidence,
          interfaces: vpnResult.details.detectedInterfaces,
        });
      }
    } catch (error) {
      logger.error('App', 'Failed to check VPN status', { error });
    }
  }, 2000); // Delay to let UI load first
}

app.whenReady().then(initializeApp);

app.on('window-all-closed', async () => {
  // On macOS, keep app running until explicitly quit
  if (process.platform !== 'darwin') {
    // Don't quit if close-to-tray is enabled — app keeps running in tray
    const settings = store.get('settings') as any;
    if (settings?.closeToTray && !isQuitting) {
      // App continues running in the system tray
      logger.info('App', 'Window closed — continuing in system tray');
      return;
    }
    await cleanup();
    app.quit();
  }
});

app.on('activate', async () => {
  // On macOS, recreate window when dock icon is clicked
  if (mainWindow === null) {
    await createWindow();
  }
});

app.on('before-quit', async (event) => {
  isQuitting = true;
  event.preventDefault();
  await cleanup();
  app.exit(0);
});

async function cleanup(): Promise<void> {
  logger.info('App', 'Cleaning up...');

  // Check if clearDataOnExit is enabled
  try {
    const privacyConfig = (store.get('privacyConfig') as any) || {};
    if (privacyConfig.clearDataOnExit) {
      logger.info('App', 'clearDataOnExit enabled — removing logs and temp files');
      const fs = require('fs');
      const pathMod = require('path');

      // Remove copied .torrent files
      const torrentsDir = pathMod.join(app.getPath('userData'), 'torrents');
      if (fs.existsSync(torrentsDir)) {
        fs.rmSync(torrentsDir, { recursive: true, force: true });
        logger.info('App', 'Deleted temp torrent files');
      }

      // Remove log files
      const logsDir = pathMod.join(app.getPath('userData'), 'logs');
      if (fs.existsSync(logsDir)) {
        fs.rmSync(logsDir, { recursive: true, force: true });
        logger.info('App', 'Deleted log files');
      }
    }
  } catch (e) {
    logger.error('App', 'Error during clearDataOnExit', { error: e });
  }

  try {
    const torrentManager = getTorrentManager();
    await torrentManager.destroy();
    logger.info('App', 'Torrent manager destroyed.');
  } catch (e) {
    logger.error('App', 'Error destroying torrent manager', { error: e });
  }

  try {
    const { getShareManager } = require('./sharing/share-manager');
    getShareManager().destroy();
    logger.info('App', 'Share manager destroyed.');
  } catch (e) {
    logger.error('App', 'Error destroying share manager', { error: e });
  }

  // Stop scheduler
  try {
    const scheduler = getSchedulerEngine();
    scheduler.destroy();
    logger.info('App', 'Scheduler engine destroyed.');
  } catch (e) {
    logger.error('App', 'Error destroying scheduler', { error: e });
  }

  // Stop RSS service
  try {
    const rssService = getRSSService();
    rssService.destroy();
    logger.info('App', 'RSS service destroyed.');
  } catch (e) {
    logger.error('App', 'Error destroying RSS service', { error: e });
  }

  // Stop watch folder
  try {
    const watchFolder = getWatchFolderService();
    watchFolder.stop();
    logger.info('App', 'Watch folder service stopped.');
  } catch (e) {
    logger.error('App', 'Error stopping watch folder', { error: e });
  }

  // Stop the VPN guard timer
  try {
    const { stopVpnGuard } = await import('./utils/vpn-guard');
    stopVpnGuard();
  } catch { /* ignore */ }

  // Stop the disk-space guard timer
  try {
    const { stopDiskGuard } = await import('./utils/disk-guard');
    stopDiskGuard();
  } catch { /* ignore */ }

  // Destroy tray
  if (tray) {
    tray.destroy();
    tray = null;
  }

  // electron-store doesn't need cleanup like database pool
  logger.info('App', 'electron-store will auto-save on exit.');

  logger.close();
}
