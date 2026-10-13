/* eslint-disable @typescript-eslint/no-require-imports, no-inner-declarations -- Electron main-process smoke harness. */
// npm run build:electron && node scripts/smoke-sharing-idle.cjs
// Uses only generated fixtures, an isolated profile and loopback trackers.
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sharing-idle-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  env.HAVVN_SHARING_SMOKE_ROOT = root;
  const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const cleanup = () => {
    if (!fs.existsSync(root)) return;
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('havvn-sharing-idle-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  child.on('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; try { cleanup(); } catch (error) { console.error(error); process.exitCode = 1; } });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
  const root = process.env.HAVVN_SHARING_SMOKE_ROOT;
  assert.ok(root, 'Launch this harness with Node so the parent cleans up after Electron exits');
  app.setPath('userData', path.join(root, 'profile')); app.setPath('sessionData', path.join(root, 'session'));
  // This harness needs neither GPU rendering nor video decoding.
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('in-process-gpu');
  app.on('window-all-closed', () => {});
  let share, remote, room, finished = false;
  const timeout = setTimeout(() => finish(1, new Error('Smoke timed out')), 60000);
  async function waitFor(predicate, limit = 10000) {
    const until = Date.now() + limit;
    while (!await predicate()) {
      if (Date.now() > until) throw new Error('Smoke condition timed out');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  function snapshot(label) {
    const metrics = app.getAppMetrics();
    console.log(JSON.stringify({ label, windows: BrowserWindow.getAllWindows().length,
      rendererPrivateKiB: metrics.filter(p => p.type === 'Tab').reduce((sum, p) => sum + (p.memory?.privateBytes ?? 0), 0),
      rendererPids: metrics.filter(p => p.type === 'Tab').map(p => p.pid) }));
  }
  function finish(code, error) {
    if (finished) return; finished = true; clearTimeout(timeout);
    if (error) console.error(error.stack || error);
    share?.destroy(); remote?.destroy(); for (const win of BrowserWindow.getAllWindows()) win.destroy();
    // The parent removes the verified temporary root after Chromium releases its locks.
    app.exit(code);
  }
  app.whenReady().then(async () => {
    const { ShareManager } = require('../dist/electron/electron/sharing/share-manager.js');
    const { HiddenEngine } = require('../dist/electron/electron/sharing/hidden-engine.js');
    share = new ShareManager();
    assert.deepEqual(await share.list(), []); assert.equal(await share.get('absent'), null); await share.stop('absent');
    assert.equal(BrowserWindow.getAllWindows().length, 0); snapshot('cold');
    const file = path.join(root, 'fixture.bin'); fs.writeFileSync(file, Buffer.alloc(128 * 1024, 42));
    const trackers = ['ws://127.0.0.1:9'];
    const first = await share.share('a', file, 'fixture.bin', false, [], trackers);
    const win = BrowserWindow.getAllWindows()[0], firstPid = win.webContents.getOSProcessId();
    assert.equal((await share.list()).length, 1);
    await new Promise(resolve => setTimeout(resolve, 5500)); assert.equal(win.isDestroyed(), false); snapshot('active-share');
    await share.stop('a'); await waitFor(async () => { await share.list(); return win.isDestroyed(); });
    await waitFor(() => !app.getAppMetrics().some(p => p.pid === firstPid)); snapshot('share-retired');
    const again = await share.share('b', file, 'fixture.bin', false, [], trackers); assert.equal(again.infoHash, first.infoHash);
    assert.equal(BrowserWindow.getAllWindows().length, 1); await share.stop('b');
    await waitFor(() => BrowserWindow.getAllWindows().length === 0);

    remote = new HiddenEngine('rcast', path.resolve('dist/electron/electron/sharing/remote-cast-engine.js'));
    await remote.call('start', { payload: { id: 'a'.repeat(32), contentPath: file, ffmpeg: '/unused', useTurn: false, trackers } });
    const castWin = BrowserWindow.getAllWindows()[0];
    await new Promise(resolve => setTimeout(resolve, 5500)); assert.equal(castWin.isDestroyed(), false);
    await remote.call('stop', { id: 'a'.repeat(32) }); await waitFor(() => castWin.isDestroyed()); snapshot('cast-retired');

    const page = path.join(root, 'room.html'); fs.writeFileSync(page, '<!doctype html><html></html>');
    room = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve('dist/electron/electron/sharing/room-engine.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
    let req = 0; const replies = new Map();
    ipcMain.on('room-res', (event, msg) => { if (event.sender === room.webContents) replies.set(msg.reqId, msg); });
    await room.loadFile(page);
    async function command(type, payload = {}) {
      const reqId = ++req; room.webContents.send('room-cmd', { type, reqId, ...payload });
      await waitFor(() => replies.has(reqId)); const reply = replies.get(reqId); replies.delete(reqId);
      return reply;
    }
    const debug = code => room.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }]);
    const folder = path.join(root, 'room'); fs.mkdirSync(folder);
    const joined = await command('join', { payload: { roomId: 'room', name: 'Smoke', code: 'smoke-room-idle', folder,
      self: { memberId: 'self', name: 'Smoke', avatarSeed: 'smoke', pub: '', priv: '' }, ownerId: 'self',
      manifest: [], tombstones: {}, mutes: [], identities: {}, chat: [], history: [], trackers, useTurn: false, turnServers: [] } });
    assert.equal(joined.ok, true, joined.error);
    await command('addFiles', { roomId: 'room', paths: [path.join(root, 'missing.bin')] });
    assert.equal(await debug('globalThis.__clients.size'), 1);
    await waitFor(async () => (await debug('globalThis.__clients.size')) === 0);
    assert.equal(await debug('globalThis.__rooms.size'), 1);
    const seeded = await command('addFiles', { roomId: 'room', paths: [file] }); assert.equal(seeded.ok, true, seeded.error);
    assert.equal(await debug('globalThis.__clients.size'), 1);
    assert.equal(await debug("globalThis.__clients.get('room').torrents[0]._storeCacheSlots"), 0);
    await new Promise(resolve => setTimeout(resolve, 5500)); assert.equal(await debug('globalThis.__clients.size'), 1);
    await command('leave', { roomId: 'room' }); room.destroy();
    assert.deepEqual(fs.readFileSync(file), Buffer.alloc(128 * 1024, 42));
    console.log('PASS: lazy share/cast windows, renderer exits, repeat share, empty room clients, active seeds and source preservation');
    finish(0);
  }).catch(error => finish(1, error));
}
