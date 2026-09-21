// Run after npm run build:electron. Exercises real main/preload/renderer with a
// temporary profile; no user downloads, router mapping or external feeds.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const reportPath = path.join(root, 'node_modules/.cache/development-smoke.json');

if (!process.versions.electron) {
  (async () => {
    const net = require('node:net');
    // Refuse to interfere with an existing dev server.
    await new Promise((resolve, reject) => {
      const socket = net.connect(3000, 'localhost');
      socket.once('connect', () => { socket.destroy(); reject(new Error('Port 3000 is already occupied')); });
      socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
    });
    const { concurrently } = await import('concurrently');
    const env = { ...process.env, NODE_ENV: 'development', HAVVN_ENGINE: 'webtorrent' };
    delete env.ELECTRON_RUN_AS_NODE;
    const { result } = concurrently([
      { command: 'npm run dev:renderer', name: 'renderer', env },
      { command: `"${require('electron')}" "${__filename}"`, name: 'electron', env },
    ], { cwd: root, killOthersOn: ['success', 'failure'], successCondition: 'first' });
    await result;
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const os = require('node:os');
  const { app, ipcMain } = require('electron');
  const profileBase = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-dev-smoke-'));
  process.env.TH_INSTANCE = 'smoke';
  const profile = `${profileBase}-smoke`;
  fs.mkdirSync(profile);
  fs.mkdirSync(path.join(profile, 'downloads'));
  app.setPath('userData', profileBase);
  app.setPath('downloads', path.join(profile, 'downloads'));
  process.argv.push('--havvn-start-hidden');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    defaultsSeeded: true, suggestedFeedSeeded: true, splitStoresMigrated: true,
    utpDefaultOnMigrated: true, vpnWarningDismissed: true,
  }));
  let finished = false;
  const timer = setTimeout(() => finish(new Error('Development smoke timed out')), 240000);
  function finish(error, details = {}) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ ok: !error, ...details, error: error?.message }, null, 2));
    if (error) console.error(error);
    app.exit(error ? 1 : 0);
  }
  process.on('uncaughtException', finish);
  process.on('unhandledRejection', error => finish(error instanceof Error ? error : new Error(String(error))));
  app.on('web-contents-created', (_event, contents) => {
    contents.on('preload-error', (_event, _file, error) => finish(error));
  });
  ipcMain.once('app:rendererReady', async event => {
    try {
      const renderer = await event.sender.executeJavaScript('({url:location.href, mounted:!!document.getElementById("root")?.childElementCount})');
      if (!renderer.mounted || renderer.url !== 'http://localhost:3000/') throw new Error('Development renderer did not mount');
      const { getTorrentManager } = require(path.join(root, 'dist/electron/electron/torrent/index.js'));
      const downloads = await getTorrentManager().getDownloads();
      if (downloads.length !== 0) throw new Error('Temporary profile unexpectedly contains downloads');
      await getTorrentManager().destroy();
      finish(null, { renderer, downloads: downloads.length, electron: process.versions.electron });
    } catch (error) { finish(error); }
  });
  (async () => {
    await app.whenReady();
    const until = Date.now() + 180000;
    let ready = false;
    while (Date.now() < until) {
      try {
        const response = await fetch('http://localhost:3000', { signal: AbortSignal.timeout(90000) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('Webpack dev server did not become ready');
    require(path.join(root, 'dist/electron/electron/app-instance.js'));
    const db = require(path.join(root, 'dist/electron/electron/db/store.js'));
    await db.updateSettings({
      engine: 'webtorrent', enableDHT: false, enableLSD: false, enablePEX: false,
      enableUtp: false, portForwarding: false, autoUpdate: false, autoLaunch: false,
      watchFolderEnabled: false, clipboardWatchEnabled: false,
    });
    require(path.join(root, 'dist/electron/electron/main.js'));
  })().catch(finish);
}
