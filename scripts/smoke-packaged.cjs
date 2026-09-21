// Usage: node scripts/smoke-packaged.cjs <win-unpacked-directory>
// Starts the actual packaged executable with isolated profiles for both engines.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

if (process.versions.electron) {
  // Seed a complete test profile with the regular Electron runtime before
  // launching the packaged binary; never import workspace code in that binary.
  const { app } = require('electron');
  const base = process.env.HAVVN_SMOKE_PROFILE;
  if (!base) throw new Error('Missing temporary profile');
  app.setPath('userData', base);
  app.setPath('downloads', path.join(base, 'downloads'));
  require(path.join(root, 'dist/electron/electron/app-instance.js'));
  app.whenReady().then(async () => {
    const db = require(path.join(root, 'dist/electron/electron/db/store.js'));
    await db.updateSettings({ engine: process.env.HAVVN_ENGINE,
      defaultDownloadDir: path.join(base, 'downloads'),
      enableDHT: false, enableLSD: false, enablePEX: false, enableUtp: false,
      portForwarding: false, autoLaunch: false, autoUpdate: false,
      watchFolderEnabled: false, clipboardWatchEnabled: false,
      closeToTray: false, minimizeToTray: false,
    });
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const { spawn, spawnSync } = require('node:child_process');
  const net = require('node:net');
  const os = require('node:os');
  const assert = require('node:assert/strict');
  const packageDir = path.resolve(process.argv[2] || 'release/verification-20260921/win-unpacked');
  const report = {};
  const output = path.join(root, 'node_modules/.cache/packaged-smoke.json');
  async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
  }
  async function test(engine) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-package-'));
    fs.mkdirSync(path.join(base, 'downloads'));
    const instance = `check-${path.basename(base)}`;
    const profile = `${base}-${instance}`;
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
      defaultsSeeded: true, suggestedFeedSeeded: true, splitStoresMigrated: true,
      utpDefaultOnMigrated: true, vpnWarningDismissed: true,
    }));
    const env = { ...process.env, TH_INSTANCE: instance, HAVVN_ENGINE: engine,
      HAVVN_SMOKE_PROFILE: base, NODE_ENV: 'production' };
    delete env.ELECTRON_RUN_AS_NODE;
    const seed = spawnSync(require('electron'), [__filename], { env, windowsHide: true, timeout: 60000, stdio: 'pipe' });
    if (seed.status !== 0) throw new Error(`Profile seed failed: ${seed.stderr}`);
    const port = await freePort();
    const child = spawn(path.join(packageDir, 'Havvn.exe'), [
      `--user-data-dir=${base}`, '--havvn-start-hidden', `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
    ], { env, windowsHide: true, stdio: 'pipe' });
    const log = fs.createWriteStream(path.join(root, `node_modules/.cache/packaged-${engine}.log`));
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    let exited = false;
    child.once('exit', () => { exited = true; });
    child.once('error', error => { exited = true; log.write(error.message); });
    let socket;
    try {
      let page;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline && !exited) {
        try {
          const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
          page = pages.find(p => p.type === 'page' && p.url.includes('/renderer/index.html'));
          if (page) break;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!page) throw new Error(`Packaged renderer unavailable (${engine})`);
      socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      let seq = 0;
      function evaluate(expression) {
        const id = ++seq;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Packaged IPC timeout')); }, 45000);
          function receive(event) {
            const message = JSON.parse(event.data);
            if (message.id !== id) return;
            clearTimeout(timer); socket.removeEventListener('message', receive);
            if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)));
            else resolve(message.result.result.value);
          }
          socket.addEventListener('message', receive);
          socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
        });
      }
      const result = await evaluate(`(async () => {
        const until = Date.now() + 30000;
        while ((!window.api || !document.getElementById('root')?.childElementCount) && Date.now() < until) await new Promise(r => setTimeout(r, 100));
        return { mounted: !!document.getElementById('root')?.childElementCount,
          version: await window.api.getAppVersion(), engine: await window.api.getRunningEngine(),
          downloads: (await window.api.getDownloads()).length,
          downloadDir: (await window.api.getSettings()).defaultDownloadDir,
          nodeExposed: typeof window.require !== 'undefined' || typeof window.process !== 'undefined' };
      })()`);
      assert.equal(result.mounted, true); assert.equal(result.nodeExposed, false);
      assert.equal(result.engine, engine); assert.equal(result.downloads, 0);
      assert.equal(result.version, require(path.join(root, 'package.json')).version);
      assert.equal(path.resolve(result.downloadDir), path.join(base, 'downloads'));
      report[engine] = result;
      // Closing the last window can destroy its debugger before CDP replies.
      // Observe the process exit instead of waiting for a reply from that page.
      socket.send(JSON.stringify({ id: ++seq, method: 'Runtime.evaluate',
        params: { expression: 'window.api.win.close()' } }));
      for (let i = 0; i < 50 && !exited; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(exited, true, 'Packaged app did not close normally');
    } finally {
      socket?.close();
      if (!exited) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      log.end();
    }
  }
  (async () => {
    for (const engine of ['native', 'webtorrent']) await test(engine);
    fs.writeFileSync(output, JSON.stringify({ ok: true, ...report }, null, 2));
    console.log('PASS: packaged renderer, preload, IPC and both engines');
  })().catch(error => {
    fs.writeFileSync(output, JSON.stringify({ ok: false, ...report, error: error.message }, null, 2));
    console.error(error); process.exitCode = 1;
  });
}
