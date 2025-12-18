import { app, BrowserWindow } from 'electron';
import path from 'path';
import dotenv from 'dotenv';
import { getTorrentManager } from './torrent';
import { setupIpcHandlers } from './ipc';
import { logger } from './utils';

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
      sandbox: false, // Required for some IPC operations
    },
    title: 'TorrentHunt',
    // Use frameless window with custom title bar for modern look
    // frame: false, // Uncomment for custom title bar
    backgroundColor: '#1a1a2e',
  });

  // Setup IPC handlers
  setupIpcHandlers(mainWindow);

  // In development, load from webpack dev server (only if explicitly set)
  // In production, load the built HTML
  const isDev = process.env.NODE_ENV === 'development';
  
  if (isDev) {
    await mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    // __dirname is dist/electron/electron/ due to tsconfig rootDir
    await mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
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

  // Create main window
  await createWindow();
  logger.info('App', 'Main window created.');
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

  // electron-store doesn't need cleanup like database pool
  logger.info('App', 'electron-store will auto-save on exit.');

  logger.close();
}
