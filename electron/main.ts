// MUST be first: sets an isolated userData dir for `TH_INSTANCE` test copies
// before electron-store / the logger read the path at module load.
import { isSecondaryInstance } from './app-instance';
import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, shell, session, ipcMain, screen, dialog } from 'electron';
import path from 'path';
import dotenv from 'dotenv';
import { getTorrentManager } from './torrent';
import { getSchedulerEngine } from './scheduler/scheduler-engine';
import { setupIpcHandlers } from './ipc';
import { logger, detectVPN, getAppIconPath } from './utils';
import { store, seedDefaultsIfNeeded, getWindowBounds, saveWindowBounds, getVpnWarningDismissed, setVpnWarningDismissed, migrateMemberIdToKeyDerived } from './db/store';
import { getRSSService } from './services/rss-service';
import { getIPBlocklistService } from './services/ip-blocklist';
import { getWatchFolderService } from './torrent/watch-folder';
import {
  initCompletionAction, stopCompletionAction, tickCompletionAction,
  getCompletionActionState, setCompletionAction,
} from './utils/completion-action';
import { t, initMainI18n, setMainLanguage } from './i18n';


// Load environment variables
dotenv.config();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// Refreshes the tray tooltip with live speeds while the tray exists;
// cleared in cleanup() alongside tray.destroy().
let trayStatsInterval: NodeJS.Timeout | null = null;

// Set inside createTray(); lets the language-change IPC re-localize the tray
// menu + tooltip live, without exposing createTray's internals.
let refreshTrayLanguage: (() => void) | null = null;

// Torrent/magnet handed to us by the OS (file double-click or magnet: link).
// On a cold start the renderer isn't listening yet, so we buffer the URI and
// flush it once the renderer signals it's ready (see 'app:rendererReady').
let rendererReady = false;
let pendingOpenUri: string | null = null;

/**
 * Reliably bring the main window back to the foreground. restore() MUST come
 * before show(): a window hidden (tray) while minimized stays minimized, and on
 * Windows show() alone does not un-minimize it — so without restore() the tray
 * icon looks dead and the app reads as a background zombie. Idempotent.
 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function deliverOpenTorrent(uri: string): void {
  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
    showMainWindow();
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

// "Don't show again" on the startup VPN warning dialog — persist the opt-out
// so the check stops nagging on every launch.
ipcMain.on('app:vpnWarningDismissed', () => {
  setVpnWarningDismissed();
});

// Renderer mirrors its selected UI language here so the tray menu, native
// dialogs, and OS notifications (which React can't reach) localize too.
ipcMain.on('app:setLanguage', (_event, lang) => {
  setMainLanguage(lang);
  refreshTrayLanguage?.();
  Menu.setApplicationMenu(buildAppMenu());
});

// === Single Instance Lock ===
// Isolated test copies (TH_INSTANCE) skip the lock so they run alongside the
// primary instead of just focusing its window — see app-instance.ts.
const gotTheLock = isSecondaryInstance ? true : app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else if (!isSecondaryInstance) {
  app.on('second-instance', (_event, commandLine) => {
    // Someone tried to run a second instance — bring the existing window back
    // (this is a primary reopen path when the app is hidden in the tray).
    showMainWindow();

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

    const title = 'Havvn продолжает работать в фоне';
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
        showMainWindow();
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

// === Application menu (native File/Edit/View/Window bar) ===
// A trimmed, fully-localized replacement for Electron's default menu. Built from
// t(), so it re-localizes live when the renderer changes language (see the
// 'app:setLanguage' handler). Quit routes through isQuitting so close-to-tray
// doesn't swallow it (mirrors the tray's Quit).
function buildAppMenu(): Menu {
  const showAbout = (): void => {
    const opts: Electron.MessageBoxOptions = {
      type: 'info',
      title: t('menu.about'),
      message: 'Havvn',
      detail: t('menu.version', { v: app.getVersion() }),
      buttons: [t('common.ok')],
    };
    if (mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBox(mainWindow, opts);
    else dialog.showMessageBox(opts);
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.quit'),
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => { isQuitting = true; app.quit(); },
        },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'reload', label: t('menu.reload') },
        { role: 'toggleDevTools', label: t('menu.toggleDevTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.resetZoom') },
        { role: 'zoomIn', label: t('menu.zoomIn') },
        { role: 'zoomOut', label: t('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.fullscreen') },
      ],
    },
    {
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        { role: 'close', label: t('menu.close') },
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        { label: t('menu.about'), click: showAbout },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// Compact speed formatter for the tray tooltip/menu header (KB/s below 1 MB/s).
function formatTraySpeed(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.round(bps / 1024)} KB/s`;
}

// Sum the per-torrent stats into the three numbers the tray shows. getStats()
// is synchronous (a cached snapshot in the manager proxy), so this is cheap.
function readTrayStats(): { down: number; up: number; active: number; avgProgress: number } {
  try {
    const stats = getTorrentManager().getStats();
    let down = 0;
    let up = 0;
    let active = 0;
    let progressSum = 0;
    for (const s of stats) {
      down += s.downSpeedBps || 0;
      up += s.upSpeedBps || 0;
      if (s.status === 'downloading') {
        active++;
        progressSum += s.progress || 0;
      }
    }
    return { down, up, active, avgProgress: active > 0 ? progressSum / active : 0 };
  } catch {
    return { down: 0, up: 0, active: 0, avgProgress: 0 };
  }
}

// Mirrors download progress onto the taskbar button (Windows) / dock (macOS):
// average progress across actively downloading torrents, cleared when idle.
function updateTaskbarProgress(stats: { active: number; avgProgress: number }): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (stats.active > 0) {
    mainWindow.setProgressBar(Math.min(1, Math.max(0, stats.avgProgress)), { mode: 'normal' });
  } else {
    mainWindow.setProgressBar(-1);
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
  tray.setToolTip(t('tray.tooltip.running'));

  // Live tooltip: keeps the existing show/hide base string (tray.tooltip vs
  // tray.tooltip.running) and appends a speeds line while anything transfers.
  const updateTrayTooltip = (): void => {
    if (!tray || tray.isDestroyed()) return;
    const base = mainWindow?.isVisible() ? t('tray.tooltip') : t('tray.tooltip.running');
    const stats = readTrayStats();
    const { down, up } = stats;
    tray.setToolTip(
      down > 0 || up > 0
        ? `${base}\n↓ ${formatTraySpeed(down)} · ↑ ${formatTraySpeed(up)}`
        : base
    );
    updateTaskbarProgress(stats);
    // On-completion action detection rides this tick — the only loop that
    // keeps running in closed-to-tray mode.
    tickCompletionAction();
  };

  trayStatsInterval = setInterval(updateTrayTooltip, 3000);

  const buildContextMenu = () => {
    const { down, up, active } = readTrayStats();
    return Menu.buildFromTemplate([
    {
      label: `↓ ${formatTraySpeed(down)} · ↑ ${formatTraySpeed(up)} · ${active} ${t('tray.active')}`,
      type: 'normal',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: t('tray.open'),
      type: 'normal',
      click: () => { showMainWindow(); },
    },
    {
      label: t('tray.openDownloads'),
      type: 'normal',
      click: () => {
        const settings = store.get('settings') as any;
        const dir = settings?.defaultDownloadDir;
        if (dir) {
          shell.openPath(dir).catch((e) => {
            logger.error('App', 'Tray open-downloads failed', { error: String(e) });
          });
        }
      },
    },
    { type: 'separator' },
    {
      label: t('tray.pauseAll'),
      type: 'normal',
      click: () => {
        // Act on the manager directly — works even with the window hidden/closed
        getTorrentManager().pauseAllActive().catch((e) => {
          logger.error('App', 'Tray pause-all failed', { error: String(e) });
        });
      },
    },
    {
      label: t('tray.resumeAll'),
      type: 'normal',
      click: () => {
        getTorrentManager().resumeAllPaused().catch((e) => {
          logger.error('App', 'Tray resume-all failed', { error: String(e) });
        });
      },
    },
    {
      label: t('tray.altSpeed'),
      type: 'checkbox',
      checked: getTorrentManager().isAltSpeedEnabled(),
      click: (item) => {
        getTorrentManager().setAltSpeed(item.checked).catch((e) => {
          logger.error('App', 'Tray alt-speed toggle failed', { error: String(e) });
        });
      },
    },
    {
      // One-shot on-completion action — the tray is the only reachable
      // surface in closed-to-tray mode; radio state rebuilds on right-click.
      label: t('tray.onDone'),
      submenu: (() => {
        const st = getCompletionActionState();
        const items: Electron.MenuItemConstructorOptions[] = st.available.map((a) => ({
          label: t(`tray.onDone.${a}`),
          type: 'radio' as const,
          checked: st.action === a,
          click: () => setCompletionAction(a),
        }));
        if (st.pending) {
          // A countdown is running (the radio shows "Do nothing" because the
          // one-shot was consumed at fire) — give tray-only users a cancel.
          items.push({ type: 'separator' });
          items.push({
            label: t('tray.onDone.cancelPending'),
            type: 'normal',
            click: () => setCompletionAction('none'),
          });
        }
        return items;
      })(),
    },
    { type: 'separator' },
    {
      label: t('tray.quit'),
      type: 'normal',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
    ]);
  };

  tray.setContextMenu(buildContextMenu());

  // Rebuild menu when needed (e.g., after settings change)
  tray.on('right-click', () => {
    tray?.setContextMenu(buildContextMenu());
  });

  // Re-localize live when the renderer changes language.
  refreshTrayLanguage = () => {
    if (!tray || tray.isDestroyed()) return;
    updateTrayTooltip();
    tray.setContextMenu(buildContextMenu());
  };

  // Single-click AND double-click both reopen — on Windows users expect a
  // single click on the tray icon to restore the window.
  tray.on('click', () => { showMainWindow(); });
  tray.on('double-click', () => { showMainWindow(); });
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

/**
 * Restore the saved window geometry, but only if it's still visible on a
 * connected display (a monitor may have been unplugged since last run).
 */
function restoredBounds(): { width: number; height: number; x?: number; y?: number } {
  const fallback = { width: 1200, height: 800 };
  try {
    const saved = getWindowBounds();
    if (!saved || saved.width < 400 || saved.height < 300) return fallback;
    if (saved.x === undefined || saved.y === undefined) {
      return { width: saved.width, height: saved.height };
    }
    const onScreen = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return saved.x! >= a.x - 50 && saved.y! >= a.y - 50 &&
        saved.x! < a.x + a.width && saved.y! < a.y + a.height;
    });
    return onScreen ? saved : { width: saved.width, height: saved.height };
  } catch {
    return fallback;
  }
}

async function createWindow(): Promise<void> {
  // Check if we should start hidden (launched at login with openAsHidden)
  const loginSettings = app.getLoginItemSettings();
  const startHidden = loginSettings.wasOpenedAsHidden === true;

  const appIconPath = getAppIconPath();

  mainWindow = new BrowserWindow({
    ...restoredBounds(),
    minWidth: 800,
    minHeight: 600,
    ...(appIconPath ? { icon: appIconPath } : {}),
    // Stay hidden until the renderer has painted its first frame (the splash),
    // so the user never sees an empty window. Shown via 'ready-to-show' below
    // (unless launched hidden to tray).
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    // Test copies (TH_INSTANCE) get a labelled title so two windows on one
    // machine are tellable apart while verifying rooms/share links.
    title: isSecondaryInstance ? `Havvn — ${process.env.TH_INSTANCE}` : 'Havvn',
    backgroundColor: '#000000', // matches the app + splash; no flash before paint
  });

  // Re-assert the window icon from a loaded image (belt-and-suspenders for the
  // taskbar/thumbnail icon — the constructor `icon` option can be ignored on some
  // Windows setups). NOTE: in `npm run dev` the taskbar button still shows
  // electron.exe's icon (the host process); the packaged build embeds the real
  // icon via electron-builder, and a wrong icon there is usually Windows' stale
  // icon cache, not the app.
  if (appIconPath) {
    try {
      const img = nativeImage.createFromPath(appIconPath);
      if (!img.isEmpty()) mainWindow.setIcon(img);
    } catch { /* keep the constructor icon */ }
  }

  // Keep the instance label in the title bar: the renderer's <title> would
  // otherwise overwrite it the moment the page loads.
  if (isSecondaryInstance) {
    const label = `Havvn — ${process.env.TH_INSTANCE}`;
    mainWindow.on('page-title-updated', (e) => { e.preventDefault(); mainWindow?.setTitle(label); });
    mainWindow.setTitle(label);
  }

  // Setup IPC handlers
  setupIpcHandlers(mainWindow);

  // === Security: navigation & new-window guards ===
  // Torrent names, RSS content and search results are untrusted data rendered in
  // the UI. Prevent the window from ever navigating away from the app, and route
  // any external link to the user's default browser instead of opening it in-app.
  const isDev = process.env.NODE_ENV === 'development';
  const allowedOrigin = isDev ? 'http://localhost:3000' : 'file://';

  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // The theme editor's pop-out panel: an about:blank child window the renderer
    // scripts directly (same-origin DOM portal — no navigation, no remote
    // content), so the user can drag the editor to a second monitor.
    if (frameName === 'havvn-theme-editor' && (url === 'about:blank' || url === '')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 480,
          height: 900,
          minWidth: 360,
          minHeight: 480,
          autoHideMenuBar: true,
          backgroundColor: '#141519',
          title: 'Havvn',
        },
      };
    }
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Children allowed above (the theme-editor pop-out) are same-origin
  // about:blank windows the renderer scripts directly. Lock each one down —
  // it inherits the preload bridge, so it must never navigate or open windows
  // of its own — and never let it outlive the window that scripts it (an
  // orphaned child would also keep 'window-all-closed' from ever firing).
  const ownerWindow = mainWindow; // non-null capture for the closures below
  ownerWindow.webContents.on('did-create-window', (child) => {
    child.removeMenu(); // no app menu → no Ctrl+R accelerator reloading the child
    child.webContents.setWindowOpenHandler(({ url: childUrl }) => {
      if (childUrl.startsWith('https://') || childUrl.startsWith('http://')) {
        void shell.openExternal(childUrl);
      }
      return { action: 'deny' };
    });
    // A file/link drag-dropped onto the child would otherwise navigate it.
    child.webContents.on('will-navigate', (event) => event.preventDefault());
    const closeChild = () => { if (!child.isDestroyed()) child.close(); };
    ownerWindow.on('closed', closeChild);
    ownerWindow.on('hide', closeChild); // close-to-tray must not leave it floating
    child.on('closed', () => {
      ownerWindow.removeListener('closed', closeChild);
      ownerWindow.removeListener('hide', closeChild);
    });
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
    // DevTools no longer auto-open — use View → Toggle Developer Tools, or set
    // HAVVN_DEVTOOLS=1 when you want them from the start.
    if (process.env.HAVVN_DEVTOOLS === '1') mainWindow.webContents.openDevTools();
  } else {
    // __dirname is dist/electron/electron/ due to tsconfig rootDir
    await mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
    // No DevTools in production
  }

  // Show the window once its first frame (the splash) has painted, so the user
  // never sees an empty window. Belt-and-suspenders: also show after a short
  // timeout in case 'ready-to-show' is delayed, so the window can't get stuck
  // hidden. show() is idempotent.
  if (!startHidden) {
    let shown = false;
    const reveal = () => { if (shown) return; shown = true; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); };
    mainWindow.once('ready-to-show', reveal);
    setTimeout(reveal, 3000);
  }

  // === Tray behavior: Minimize to Tray ===
  // Electron no longer passes a preventable event to 'minimize' (and
  // preventDefault here stopped working long ago). Just hide to the tray — the
  // window minimizes then disappears, which is the intended behaviour.
  mainWindow.on('minimize', () => {
    const settings = store.get('settings') as any;
    if (settings?.minimizeToTray) {
      mainWindow?.hide();
      showTrayHintOnce();
    }
  });

  // === Tray behavior: Close to Tray ===
  mainWindow.on('close', (event: Electron.Event) => {
    // Remember geometry (normal bounds, not the maximized/minimized rect)
    try {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
        saveWindowBounds(mainWindow.getNormalBounds());
      }
    } catch { /* best-effort */ }

    if (!isQuitting) {
      const settings = store.get('settings') as any;
      if (settings?.closeToTray) {
        event.preventDefault();
        mainWindow?.hide();
        // Update tray tooltip to indicate background mode
        tray?.setToolTip(t('tray.tooltip.running'));
        showTrayHintOnce();
      }
    }
  });

  mainWindow.on('show', () => {
    tray?.setToolTip(t('tray.tooltip'));
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
    "style-src 'self' 'unsafe-inline'", // style-loader injects styles as inline <style> tags
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
  // Kept at the pre-rebrand id ON PURPOSE: it must match build.appId, and
  // changing appId would give NSIS a new identity — existing TorrentHunt
  // installs would no longer be upgraded in place (side-by-side installs).
  app.setAppUserModelId('com.torrenthunt.app');

  // Initialize logger first, honoring privacy settings (disable/sanitize logs)
  const privacyCfg = (store.get('privacyConfig') as any) || {};
  logger.initialize({
    minLevel: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
    disableFileLogging: privacyCfg.disableLogs === true,
    sanitize: privacyCfg.sanitizeLogs === true,
  });

  logger.info('App', 'Havvn starting...');

  // Upgrade this install's room memberId to the key-derived form (see the store).
  // Runs here — after 'ready', before any room work — so the signing key is only
  // (re)generated once safeStorage can encrypt it at rest.
  try { migrateMemberIdToKeyDerived(); } catch (e) { logger.warn('App', 'room memberId migration failed', { error: String(e) }); }

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

  // Load the persisted UI language so the tray/menu built below is already in
  // the right language, before the renderer loads and re-announces it.
  initMainI18n();

  // Replace Electron's default File/Edit/View/Window menu with our localized one.
  Menu.setApplicationMenu(buildAppMenu());

  // Create the tray and the window FIRST. Restoring torrents re-verifies
  // their on-disk data (sha1 over potentially many GB) and used to run before
  // the window existed — the app looked hung for tens of seconds on launch.
  // The manager gates its public API on initialization, so early UI calls
  // simply wait instead of failing.
  createTray();
  logger.info('App', 'System tray created.');

  // On-completion action (one-shot sleep/shutdown/quit; detection rides the
  // tray tick). Registered BEFORE the window exists so the renderer's very
  // first app:getCompletionAction invoke always finds the handler — the rest
  // of startup (engine re-verification) can take tens of seconds.
  initCompletionAction({
    getMainWindow: () => mainWindow,
    // isQuitting first, or close-to-tray (default ON) swallows the quit.
    quitApp: () => { isQuitting = true; app.quit(); },
  });

  await createWindow();
  logger.info('App', 'Main window created.');

  // Initialize torrent manager (restores + verifies persisted torrents).
  // The out-of-process host can now REJECT this (fail-fast) if it dies before
  // signalling ready — previously it hung here forever. Catch it so the rest of
  // startup (window is already up, RSS, tray) still proceeds in a degraded mode
  // rather than aborting with an unhandled rejection; a later engine call will
  // re-spawn the host.
  const torrentManager = getTorrentManager();
  try {
    await torrentManager.initialize();
    logger.info('App', 'Torrent manager initialized with electron-store.');
  } catch (e) {
    logger.error('App', 'Torrent engine failed to initialize — continuing in degraded mode', { error: e instanceof Error ? e.message : String(e) });
  }

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

  // Start the VPN kill-switch guard (no-op unless enabled in privacy settings)
  try {
    if (mainWindow) {
      const { initVpnGuard } = await import('./utils/vpn-guard');
      initVpnGuard(mainWindow);
    }
  } catch (e) {
    logger.error('App', 'Failed to init VPN guard', { error: e });
  }

  // Start the smart network-profile monitor (applies base settings unless enabled)
  try {
    if (mainWindow) {
      const { startNetworkProfiles } = await import('./services/network-profiles');
      startNetworkProfiles(mainWindow);
    }
  } catch (e) {
    logger.error('App', 'Failed to start network profiles', { error: e });
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

  // Start the clipboard magnet watcher (no-op unless enabled in settings)
  try {
    const { initClipboardWatcher } = await import('./utils/clipboard-watcher');
    initClipboardWatcher({
      deliver: deliverOpenTorrent,
      // Hidden-in-tray still counts: the window exists, deliverOpenTorrent
      // fronts it with the add dialog — only a destroyed window stops delivery.
      hasWindow: () => mainWindow !== null && !mainWindow.isDestroyed(),
    });
  } catch (e) {
    logger.error('App', 'Failed to init clipboard watcher', { error: e });
  }


  // Forward the listening port via UPnP so peers can connect inbound (no-op if
  // disabled in settings or the router has no UPnP). Best-effort; never blocks.
  try {
    const { restartPortForwardingFromConfig } = await import('./utils/port-forwarding');
    await restartPortForwardingFromConfig(() => torrentManager.getListeningPort());
  } catch (e) {
    logger.error('App', 'Failed to init port forwarding', { error: e });
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

  // Start the mobile web remote if the user has enabled it (off by default).
  try {
    const s = store.get('settings') as any;
    if (s?.webRemoteEnabled) {
      const { getWebRemoteServer } = await import('./torrent/web-remote');
      const { getOrCreateWebRemoteToken } = await import('./db/store');
      const token = await getOrCreateWebRemoteToken();
      await getWebRemoteServer().start(s.webRemotePort || 8788, token);
      logger.info('App', 'Web remote started.');
    }
  } catch (e) {
    logger.error('App', 'Failed to start web remote', { error: e });
  }

  // Apply auto-launch setting (registered as "Havvn", not electron.exe). This
  // re-assert also carries autostart across the rebrand: the old installer's
  // uninstaller removes the legacy "TorrentHunt" Run entry during upgrade, and
  // this recreates it under the new name from the migrated settings.
  const settings = store.get('settings') as any;
  if (settings?.autoLaunch !== undefined) {
    app.setLoginItemSettings({
      openAtLogin: settings.autoLaunch,
      openAsHidden: settings.autoLaunch,
      name: 'Havvn',
      path: process.execPath,
    });
  }

  // Initialize IP blocklist: load from store in main, ship the ranges to the
  // torrent host (where the WebTorrent client lives) to do the peer filtering.
  try {
    const torrentManager = getTorrentManager();
    const blocklistService = getIPBlocklistService();
    await blocklistService.loadAll();
    await torrentManager.applyIpBlocklist(blocklistService.getRanges());
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
      // Settings → Privacy → "VPN Detection" gates this startup check; it used
      // to be ignored and the warning fired even with the toggle off.
      const privacy = store.get('privacyConfig') as { vpnCheck?: boolean } | undefined;
      if (privacy && privacy.vpnCheck === false) {
        logger.info('App', 'VPN startup check disabled in privacy settings.');
        return;
      }
      logger.info('App', 'Checking VPN status...');
      const vpnResult = await detectVPN();

      if (!vpnResult.isVPNActive) {
        logger.warn('App', 'VPN not detected!', {
          confidence: vpnResult.confidence,
        });
        if (!getVpnWarningDismissed()) {
          // In-app warning dialog (replaces the old native message box). This
          // check runs 2s after boot, but on a slow cold start the renderer's
          // IPC listeners may not be attached yet (same race as
          // deliverOpenTorrent) — retry once instead of silently dropping it.
          const payload = { publicIP: vpnResult.details.publicIP };
          const sendWarning = (): boolean => {
            if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
              mainWindow.webContents.send('app:vpnWarning', payload);
              return true;
            }
            return false;
          };
          if (!sendWarning()) {
            setTimeout(() => {
              if (!sendWarning()) {
                logger.warn('App', 'Renderer not ready — VPN warning not shown this session');
              }
            }, 5000);
          }
        }
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
  // Bound the teardown: if cleanup() stalls (e.g. an unresponsive engine host),
  // exit anyway so quitting can never hang the process in the background.
  await Promise.race([cleanup(), new Promise((r) => setTimeout(r, 5000))]);
  app.exit(0);
});

// cleanup() can be reached twice on quit (window-all-closed → app.quit() →
// before-quit). Every step is try/catch'd, but there's no point running the
// whole teardown again — guard it.
let cleanupDone = false;

async function cleanup(): Promise<void> {
  if (cleanupDone) return;
  cleanupDone = true;
  logger.info('App', 'Cleaning up...');

  // Check if clearDataOnExit is enabled
  try {
    const privacyConfig = (store.get('privacyConfig') as any) || {};
    if (privacyConfig.clearDataOnExit) {
      logger.info('App', 'clearDataOnExit enabled — removing logs and temp files');
      const fs = await import('fs');
      const pathMod = await import('path');

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
    const { getShareManager } = await import('./sharing/share-manager');
    getShareManager().destroy();
    logger.info('App', 'Share manager destroyed.');
  } catch (e) {
    logger.error('App', 'Error destroying share manager', { error: e });
  }

  try {
    const { getRoomManager } = await import('./sharing/room-manager');
    getRoomManager().destroy();
    logger.info('App', 'Room manager destroyed.');
  } catch (e) {
    logger.error('App', 'Error destroying room manager', { error: e });
  }

  // The cast server now lives in the torrent host process; it is torn down when
  // the torrent manager (proxy) is destroyed above, which kills the host.

  try {
    const { getWebRemoteServer } = await import('./torrent/web-remote');
    getWebRemoteServer().destroy();
    logger.info('App', 'Web remote destroyed.');
  } catch (e) {
    logger.error('App', 'Error destroying web remote', { error: e });
  }

  try {
    const { getRemoteCastManager } = await import('./sharing/remote-cast-manager');
    getRemoteCastManager().destroy();
    logger.info('App', 'Remote-cast manager destroyed.');
  } catch (e) {
    logger.error('App', 'Error destroying remote-cast manager', { error: e });
  }

  try {
    const { getChromecastManager } = await import('./torrent/chromecast');
    getChromecastManager().destroy();
    logger.info('App', 'Chromecast manager destroyed.');
  } catch (e) {
    logger.error('App', 'Error destroying chromecast manager', { error: e });
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

  // Stop the clipboard watcher poll
  try {
    const { stopClipboardWatcher } = await import('./utils/clipboard-watcher');
    stopClipboardWatcher();
  } catch { /* ignore */ }

  // Clear completion-action timers (an OS-scheduled shutdown is left alone)
  stopCompletionAction();

  // Remove the UPnP port mapping and stop renewing it
  try {
    const { stopPortForwarding } = await import('./utils/port-forwarding');
    await stopPortForwarding();
  } catch { /* ignore */ }

  // Destroy tray (and stop the tooltip stats ticker with it)
  if (trayStatsInterval) {
    clearInterval(trayStatsInterval);
    trayStatsInterval = null;
  }
  // Clear the taskbar progress overlay so it doesn't linger after quit
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setProgressBar(-1);
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }

  // electron-store doesn't need cleanup like database pool
  logger.info('App', 'electron-store will auto-save on exit.');

  logger.close();
}
