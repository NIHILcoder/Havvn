/* eslint-disable @typescript-eslint/no-require-imports, no-inner-declarations -- Dual Node/Electron CommonJS fixture. */
// Usage: node scripts/smoke-packaged.cjs <win-unpacked|linux-unpacked-directory>
// Starts the actual packaged executable with isolated profiles for both engines.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const built = path.resolve(process.env.HAVVN_SMOKE_BUILT_ROOT || path.join(root, 'dist/electron/electron'));
if (!built.startsWith(root + path.sep)) throw new Error('Fixture runtime must stay inside the repository');

if (process.versions.electron) {
  // Seed a complete test profile with the regular Electron runtime before
  // launching the packaged binary; never import workspace code in that binary.
  const { app } = require('electron');
  const base = process.env.HAVVN_SMOKE_PROFILE;
  if (!base) throw new Error('Missing temporary profile');
  app.setPath('userData', base);
  app.setPath('downloads', path.join(base, 'downloads'));
  require(path.join(built, 'app-instance.js'));
  app.whenReady().then(async () => {
    const db = require(path.join(built, 'db/store.js'));
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
  const packageDir = path.resolve(process.argv[2] || 'release/' + (process.platform === 'win32' ? 'win' : 'linux') + '-unpacked');
  const executable = process.argv.find(arg => arg.startsWith('--executable='))?.slice('--executable='.length)
    || (process.platform === 'win32' ? 'Havvn.exe' : 'havvn');
  assert.equal(path.basename(executable), executable, 'Executable must be inside the selected package');
  const expectedVersion = process.argv.find(arg => arg.startsWith('--expected-version='))?.slice('--expected-version='.length)
    || require(path.join(root, 'package.json')).version;
  const report = {};
  const output = path.join(root, 'node_modules/.cache/packaged-smoke.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
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
      appearanceAcrylic: true, appearanceNativeMaterial: 'mica',
    }));
    const env = { ...process.env, TH_INSTANCE: instance, HAVVN_ENGINE: engine,
      HAVVN_SMOKE_PROFILE: base, NODE_ENV: 'production' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.HAVVN_FILE_SYNC; // Acceptance must exercise the normal feature defaults.
    const seed = spawnSync(require('electron'), [__filename], { env, windowsHide: true, timeout: 60000, stdio: 'pipe' });
    if (seed.status !== 0) throw new Error(`Profile seed failed: ${seed.stderr}`);
    const port = await freePort();
    const child = spawn(path.join(packageDir, executable), [
      `--user-data-dir=${base}`, '--havvn-start-hidden', `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
    ], { env, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe' });
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
        } catch { /* The packaged debugger starts asynchronously. */ }
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
      // The target URL can appear before its first navigation has committed.
      // Poll without keeping a promise alive in a context being replaced.
      let ready = false;
      while (Date.now() < deadline && !exited) {
        try {
          ready = await evaluate(`document.readyState === 'complete' && !!window.api && !!document.getElementById('root')?.childElementCount`);
          if (ready) break;
        } catch (error) {
          if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(ready, true, 'Packaged renderer did not finish loading');
      const result = await evaluate(`(async () => {
        const until = Date.now() + 30000;
        while ((!window.api || !document.getElementById('root')?.childElementCount || document.getElementById('th-splash')) && Date.now() < until) await new Promise(r => setTimeout(r, 100));
        return { mounted: !!document.getElementById('root')?.childElementCount,
          splashDismissed: !document.getElementById('th-splash'),
          version: await window.api.getAppVersion(), engine: await window.api.getRunningEngine(),
          downloads: (await window.api.getDownloads()).length,
          downloadDir: (await window.api.getSettings()).defaultDownloadDir,
          nodeExposed: typeof window.require !== 'undefined' || typeof window.process !== 'undefined' };
      })()`);
      assert.equal(result.mounted, true); assert.equal(result.nodeExposed, false);
      assert.equal(result.splashDismissed, true, 'Packaged startup splash did not dismiss');
      assert.equal(result.engine, engine); assert.equal(result.downloads, 0);
      assert.equal(result.version, expectedVersion);
      assert.equal(path.resolve(result.downloadDir), path.join(base, 'downloads'));
      let devices;
      if (process.argv.includes('--devices')) {
        devices = await evaluate(`(async () => {
          const state = await window.api.devices.state();
          document.querySelector('.sidebar-util-btn[aria-label="Settings"]').click();
          const until = Date.now() + 15000;
          while (![...document.querySelectorAll('.stg-nav-item')].some(b => b.textContent.trim() === 'Devices')) { if (Date.now() > until) throw Error('Missing packaged devices navigation'); await new Promise(r => setTimeout(r, 50)); }
          [...document.querySelectorAll('.stg-nav-item')].find(b => b.textContent.trim() === 'Devices').click();
          while (!document.querySelector('[data-devices-section]')) { if (Date.now() > until) throw Error('Missing packaged devices section'); await new Promise(r => setTimeout(r, 50)); }
          return { status: state.status, self: state.self, approved: state.approved, sectionLoaded: true };
        })()`);
        assert.equal(devices.status, 'off'); assert.equal(devices.self, null); assert.equal(devices.approved, false);
        assert.equal(fs.existsSync(path.join(profile, 'devices')), false, 'Disabled packaged feature created a vault');
        const initialized = await evaluate(`(async () => {
          document.querySelector('[data-devices-section] [role="switch"]').click();
          const until = Date.now() + 20000;
          while (Date.now() < until) {
            const state = await window.api.devices.state();
            if (state.error) throw Error('Packaged device initialization failed: ' + state.error);
            if (state.self && state.enabled) { await window.api.devices.command({kind:'enable',enabled:false}); return /^[a-f0-9]{64}$/.test(state.self); }
            await new Promise(r => setTimeout(r, 100));
          }
          return false;
        })()`);
        assert.equal(initialized, true); devices.initialized = true;
        assert(!fs.readFileSync(path.join(profile, 'devices/device-state.json'), 'utf8').includes('PRIVATE KEY'));
        devices.liveControls = await evaluate(`(async () => {
          [...document.querySelectorAll('.stg-nav-item')].find(b => b.textContent.trim() === 'Interface').click();
          const until = Date.now() + 15000;
          while (!document.querySelector('[role="switch"][aria-label="Compact settings"]')) { if (Date.now() > until) throw Error('Interface controls not mounted'); await new Promise(r => setTimeout(r, 50)); }
          for (const [key, value] of Object.entries({density:'compact',uiScale:'110',speedUnits:'bits'})) {
            localStorage.setItem(key,value); window.dispatchEvent(new StorageEvent('storage',{key,newValue:value}));
          }
          while (Date.now() < until) {
            const compact = document.querySelector('[role="switch"][aria-label="Compact settings"]')?.getAttribute('aria-checked') === 'true';
            const scale = document.querySelector('[role="group"][aria-label="Interface scale"] button[aria-pressed="true"]')?.textContent === '110%';
            const units = document.querySelector('.stg-row[data-setting-label="Speed units"]')?.textContent.includes('bit/s');
            if (compact && scale && units) return true;
            await new Promise(r => setTimeout(r,50));
          }
          return false;
        })()`);
        assert.equal(devices.liveControls, true, 'Already-open interface controls did not refresh after incoming storage events');
      }
      const appearanceOperation = await evaluate(`(async () => {
        const startup = await window.api.appearance.getAcrylic();
        const acrylic = await window.api.appearance.setAcrylic(true, 'acrylic');
        const mica = await window.api.appearance.setAcrylic(true, 'mica');
        const off = await window.api.appearance.setAcrylic(false, 'mica');
        return { startup, acrylic, mica, off, state: document.documentElement.dataset.acrylic };
      })()`);
      assert.equal(appearanceOperation.startup.enabled, true);
      assert.equal(appearanceOperation.startup.material, 'mica', 'Saved Mica choice was not restored at startup');
      assert.equal(appearanceOperation.acrylic.material, 'acrylic');
      assert.equal(appearanceOperation.mica.material, 'mica');
      assert.equal(appearanceOperation.off.active, false);
      assert.equal(appearanceOperation.off.reason, appearanceOperation.startup.reason === 'unsupported' ? 'unsupported' : 'off');
      for (const state of [appearanceOperation.startup, appearanceOperation.acrylic, appearanceOperation.mica]) {
        assert.notEqual(state.reason, 'failed', 'Packaged native material failed');
      }
      const savedAppearance = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
      assert.equal(savedAppearance.appearanceAcrylic, false);
      assert.equal(savedAppearance.appearanceNativeMaterial, 'mica');
      // A real paused torrent crosses preload -> main -> host -> daemon. An
      // empty download list alone could pass with a degraded engine.
      const payload = path.join(base, 'downloads', 'package-fixture.bin');
      fs.writeFileSync(payload, require('node:crypto').randomBytes(32768));
      const { default: createTorrent } = await import('create-torrent');
      const torrentBytes = await new Promise((resolve, reject) => createTorrent(payload,
        { announceList: [], private: true }, (error, bytes) => error ? reject(error) : resolve(bytes)));
      const torrentFile = path.join(base, 'package-fixture.torrent');
      fs.writeFileSync(torrentFile, torrentBytes);
      const request = { sourceType: 'torrent_file', sourceUri: torrentFile,
        savePath: path.join(base, 'downloads'), paused: true };
      const operation = await evaluate('(async () => { const download = await window.api.addDownload(' +
        JSON.stringify(request) + '); await window.api.resumeDownload(download.id); ' +
        'let files = []; const until = Date.now() + 15000; while (!files.length && Date.now() < until) { ' +
        'files = await window.api.getTorrentFiles(download.id); if (!files.length) await new Promise(r => setTimeout(r, 100)); } ' +
        'await window.api.pauseDownload(download.id); ' +
        'await window.api.removeDownload(download.id, false); return { status: download.status, ' +
        'fileSizes: files.map(f => f.length), remaining: (await window.api.getDownloads()).filter(d => d.status !== "removed").length }; })()');
      assert.equal(operation.status, 'paused');
      assert.deepEqual(operation.fileSizes, [32768]);
      assert.equal(operation.remaining, 0);
      assert.equal(fs.statSync(payload).size, 32768, 'Removing the record deleted fixture bytes');
      const documentCheck = await evaluate(`(async () => {
        const room = await window.api.rooms.create('Package check', true, false);
        const sync = await window.api.rooms.fileSync.state(room.roomId);
        const view = await window.api.rooms.documents.view(room.roomId);
        const document = await window.api.rooms.documents.create(room.roomId, 'Packaged editor', 'markdown', '# Package check', [view.selfId]);
        const opened = await window.api.rooms.documents.open(room.roomId, document.documentId);
        const snapshot = await window.api.rooms.documents.snapshot(room.roomId, opened.token, 'Before edit');
        return { roomId: room.roomId, syncEnabled: sync.enabled, documentsEnabled: view.enabled, opened, snapshotId: snapshot.id };
      })()`);
      assert.equal(documentCheck.syncEnabled, true); assert.equal(documentCheck.documentsEnabled, true);
      const Y = await import('yjs'), textDocument = new Y.Doc();
      Y.applyUpdate(textDocument, Buffer.from(documentCheck.opened.state, 'base64'));
      assert.equal(textDocument.getText('text').toString(), '# Package check');
      textDocument.getText('text').insert(textDocument.getText('text').length, '\nSaved from packaged app');
      const encoded = Buffer.from(Y.encodeStateAsUpdate(textDocument)).toString('base64'); textDocument.destroy();
      const documentResult = await evaluate(`(async () => {
        const roomId = ${JSON.stringify(documentCheck.roomId)}, token = ${JSON.stringify(documentCheck.opened.token)};
        const updated = await window.api.rooms.documents.update(roomId, token, ${JSON.stringify(encoded)});
        const restored = await window.api.rooms.documents.restore(roomId, token, ${JSON.stringify(documentCheck.snapshotId)});
        const history = await window.api.rooms.documents.history(roomId, token);
        await window.api.rooms.documents.close(roomId, token);
        return { updated: updated.state, restored: restored.state, history: history.length };
      })()`);
      for (const [state, expected] of [[documentResult.updated, '# Package check\nSaved from packaged app'], [documentResult.restored, '# Package check']]) {
        const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(state, 'base64')); assert.equal(doc.getText('text').toString(), expected); doc.destroy();
      }
      assert.ok(documentResult.history > 0);
      // Load the actual lazy room/editor chunks from app.asar, not workspace code.
      await evaluate(`document.querySelector('.pillar-btn:last-child').click()`);
      const documentUi = await evaluate(`(async () => {
        const waitFor = async (predicate, label) => { const end = Date.now() + 15000; while (!predicate()) { if (Date.now() > end) throw Error('Packaged UI: ' + label); await new Promise(resolve => setTimeout(resolve, 50)); } };
        await waitFor(() => document.querySelector('[data-editor-open]'), 'editor entry');
        document.querySelector('[data-editor-open]').click();
        await waitFor(() => document.querySelector('[data-docs-open]'), 'document entry');
        document.querySelector('[data-docs-open]').click();
        await waitFor(() => document.querySelector('[data-docs-document]'), 'document catalog');
        document.querySelector('[data-docs-document]').click();
        await waitFor(() => document.querySelector('.cm-content') && document.querySelector('[data-docs-status]')?.getAttribute('data-docs-status') === 'rooms.docs.synced', 'confirmed editor');
        const result = { text: document.querySelector('.cm-content').innerText.trim(), status: document.querySelector('[data-docs-status]').textContent, scope: document.querySelector('[data-docs-save-scope]')?.textContent || '' };
        document.querySelector('.room-workarea-modal > .um-head .um-x').click();
        await waitFor(() => !document.querySelector('.room-workarea-modal'), 'workspace close');
        return result;
      })()`);
      assert.equal(documentUi.text, '# Package check');
      const labels = JSON.parse(fs.readFileSync(path.join(root, 'renderer/i18n/en.json'), 'utf8'));
      assert.equal(documentUi.status, labels['rooms.docs.synced']);
      assert.equal(documentUi.scope, labels['rooms.docs.confirmedHint']);
      const roomOperation = await evaluate(`(async () => {
        const left = await window.api.rooms.leave(${JSON.stringify(documentCheck.roomId)}, false, 'stop');
        return { created: true, left: left.ok, remaining: (await window.api.rooms.list()).length };
      })()`);
      assert.equal(roomOperation.created, true);
      assert.equal(roomOperation.left, true);
      assert.equal(roomOperation.remaining, 0);
      report[engine] = { ...result, torrentOperation: operation, roomOperation, appearanceOperation, ...(devices && { devices }),
        documents: { created: true, edited: true, snapshotRestored: true, history: documentResult.history, packagedEditorLoaded: true, confirmedStatusWithoutGlobalReceiptClaim: true } };

      // Closing the last window can destroy its debugger before CDP replies.
      // Observe the process exit instead of waiting for a reply from that page.
      socket.send(JSON.stringify({ id: ++seq, method: 'Runtime.evaluate',
        params: { expression: 'window.api.win.close()' } }));
      // Main owns a 5s cleanup budget; allow process teardown and OS scheduling
      // beyond that budget instead of racing an exactly-5s observer.
      for (let i = 0; i < 150 && !exited; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(exited, true, 'Packaged app did not close normally');
    } finally {
      socket?.close();
      if (!exited && child.pid) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
      }
      log.end();
    }
  }
  (async () => {
    const archive = path.join(packageDir, 'resources/app.asar');
    const archiveHash = () => require('node:crypto').createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    const beforeHash = archiveHash();
    for (const engine of ['native', 'webtorrent']) await test(engine);
    const appAsarSha256 = archiveHash(); assert.equal(appAsarSha256, beforeHash, 'Packaged archive changed during testing');
    fs.writeFileSync(output, JSON.stringify({ ok: true, ...report, checkedAt: new Date().toISOString(), appAsarSha256, packageDirectory: packageDir }, null, 2));
    console.log('PASS: packaged renderer, preload, IPC and both engines');
  })().catch(error => {
    fs.writeFileSync(output, JSON.stringify({ ok: false, ...report, error: error.message }, null, 2));
    console.error(error); process.exitCode = 1;
  });
}
