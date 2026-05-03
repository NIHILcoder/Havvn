import { app, BrowserWindow } from 'electron';
import path from 'path';
import dotenv from 'dotenv';
import { getTorrentManager } from './torrent';
import { getCollaborativeSeedingManager } from './seeding';
import { setupIpcHandlers } from './ipc';
import { logger, detectVPN, showVPNWarning } from './utils';

// Load environment variables
dotenv.config();

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
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

  // In development, load from webpack dev server
  const isDev = process.env.NODE_ENV === 'development';
  
  if (isDev) {
    await mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    // __dirname is dist/electron/electron/ due to tsconfig rootDir
    await mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
    // No DevTools in production
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function initializeApp(): Promise<void> {
  // Disable GPU shader disk cache to prevent cache access errors
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  
  // Initialize logger first
  logger.initialize({
    minLevel: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  });
  
  logger.info('App', 'TorrentHunt starting...');

  // Initialize torrent manager (which will use electron-store)
  const torrentManager = getTorrentManager();
  await torrentManager.initialize();
  logger.info('App', 'Torrent manager initialized with electron-store.');

  // Initialize collaborative seeding manager
  const seedingManager = getCollaborativeSeedingManager();
  await seedingManager.initialize();
  logger.info('App', 'Collaborative Seeding Manager initialized.');

  // Create main window
  await createWindow();
  logger.info('App', 'Main window created.');

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
  event.preventDefault();
  await cleanup();
  app.exit(0);
});

async function cleanup(): Promise<void> {
  logger.info('App', 'Cleaning up...');
  
  try {
    const torrentManager = getTorrentManager();
    await torrentManager.destroy();
    logger.info('App', 'Torrent manager destroyed.');
  } catch (e) {
    logger.error('App', 'Error destroying torrent manager', { error: e });
  }

  try {
    const seedingManager = getCollaborativeSeedingManager();
    seedingManager.destroy();
    logger.info('App', 'Collaborative Seeding Manager destroyed.');
  } catch (e) {
    logger.error('App', 'Error destroying seeding manager', { error: e });
  }

  // electron-store doesn't need cleanup like database pool
  logger.info('App', 'electron-store will auto-save on exit.');

  logger.close();
}
