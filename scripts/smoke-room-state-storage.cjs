/* eslint-disable @typescript-eslint/no-require-imports, no-inner-declarations -- Isolated Electron smoke harness. */
// npm run build:electron && node scripts/smoke-room-state-storage.cjs
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-room-state-'));
  const env = { ...process.env, HAVVN_STATE_SMOKE_ROOT: root, HAVVN_ROOM_TRACKERS: 'ws://127.0.0.1:9' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const watchdog = setTimeout(() => { console.error('Electron smoke exceeded 70 seconds'); child.kill(); }, 70000);
  const cleanup = () => {
    if (!fs.existsSync(root)) return;
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('havvn-room-state-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  child.on('error', error => { clearTimeout(watchdog); console.error(error); cleanup(); process.exitCode = 1; });
  child.on('exit', code => { clearTimeout(watchdog); process.exitCode = code ?? 1; try { cleanup(); } catch (error) { console.error(error); process.exitCode = 1; } });
} else {
  const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = process.env.HAVVN_STATE_SMOKE_ROOT; assert.ok(root);
  app.setPath('userData', path.join(root, 'profile')); app.setPath('sessionData', path.join(root, 'session'));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('in-process-gpu');
  app.on('window-all-closed', () => {});
  let manager, finished = false;
  const deadline = setTimeout(() => finish(1, new Error('Room state smoke timed out')), 60000);
  function finish(code, error) {
    if (finished) return; finished = true; clearTimeout(deadline);
    if (error) console.error(error.stack || error);
    manager?.destroy(); for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(code);
  }
  process.on('uncaughtException', error => finish(1, error));
  process.on('unhandledRejection', error => finish(1, error instanceof Error ? error : new Error(String(error))));
  async function waitFor(predicate) {
    const end = Date.now() + 12000;
    while (!await predicate()) {
      if (Date.now() > end) throw new Error('Smoke condition timed out');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  app.whenReady().then(async () => {
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    const db = require('../dist/electron/electron/db/store.js');
    const { RoomManager } = require('../dist/electron/electron/sharing/room-manager.js');
    await db.updateSettings({ defaultDownloadDir: path.join(root, 'downloads'), shareUseTurn: false });
    db.updateRoomProfile({ name: 'Smoke' });
    manager = new RoomManager();
    const page = path.join(root, 'ui.html'); fs.writeFileSync(page, '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'"></head></html>');
    const ui = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
      preload: path.resolve('dist/electron/electron/preload.js'), backgroundThrottling: false } });
    const errors = []; ui.webContents.on('preload-error', (_event, _file, error) => errors.push(String(error)));
    manager.setMainWindow(ui);
    ipcMain.handle('rooms:resyncState', (event, id) => { assert.equal(event.sender, ui.webContents); manager.resyncRendererState(id); });
    await ui.loadFile(page);
    const run = code => ui.webContents.executeJavaScript(code);
    const subscribe = () => run("window.states=[];window.unsubscribe=window.api.onRoomUpdate(s=>window.states.push({roomId:s.roomId,files:s.files.length,chat:s.chat.length,progress:s.transfers['fixture-0']?.progress,upKbps:s.upKbps,name:s.name}));true");
    assert.equal(await run('typeof window.api.onRoomUpdate'), 'function'); assert.deepEqual(errors, []); await subscribe();
    const state = await manager.createRoom('IPC smoke', false, false), id = state.roomId;
    await waitFor(async () => (await run('window.states.length')) > 0);
    const engine = BrowserWindow.getAllWindows().find(win => win !== ui);
    const debug = code => engine.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }]);
    const self = db.getRoomProfile().memberId;
    const files = Array.from({ length: 1000 }, (_, i) => ({ fileId: `fixture-${i}`, name: `file-${i}.bin`, size: 1024,
      infoHash: i.toString(16).padStart(40, '0'), magnetURI: `magnet:?xt=urn:btih:${i.toString(16).padStart(40, '0')}&dn=${'fixture'.repeat(20)}`,
      addedBy: self, addedByName: 'Smoke', addedAt: i }));
    const chat = Array.from({ length: 200 }, (_, i) => ({ id: `chat-${i}`, memberId: 'other', name: 'Other',
      text: `private smoke body ${i} ` + 'body'.repeat(100), at: Date.now(), pub: 'fixture', sig: 'fixture' }));
    db.upsertRoomManifestFiles(id, files); db.appendRoomChats(id, chat);
    await debug(`{const r=globalThis.__rooms.get(${JSON.stringify(id)});for(const f of ${JSON.stringify(files)})r.files.set(f.fileId,f);r.chat=${JSON.stringify(db.getRoomChats(id))};r.transfers.set('fixture-0',{fileId:'fixture-0',progress:0.1,status:'queued',haveLocally:false});true}`);
    const packets = [], engineContents = engine.webContents;
    ipcMain.on('room-state', (event, packet) => { if (event.sender === engineContents) packets.push(packet); });
    await manager.setLimits(id, 128, 0);
    await waitFor(async () => (await run('window.states.at(-1).files')) === 1000);
    await waitFor(() => packets.length > 0);
    const fullBytes = Buffer.byteLength(JSON.stringify(await manager.getRoom(id)));
    packets.length = 0;
    await debug(`globalThis.__rooms.get(${JSON.stringify(id)}).transfers.get('fixture-0').progress=0.2;true`);
    await manager.setLimits(id, 129, 0);
    await waitFor(() => packets.some(packet => packet.patch));
    await waitFor(async () => (await run('window.states.at(-1).progress')) === 0.2);
    const deltaBytes = Math.max(...packets.filter(packet => packet.patch).map(packet => Buffer.byteLength(JSON.stringify(packet))));
    assert.ok(deltaBytes < fullBytes / 100, `${deltaBytes} vs ${fullBytes}`);
    await run('window.unsubscribe();true');
    await new Promise(resolve => { ui.webContents.once('did-finish-load', resolve); ui.reload(); });
    await subscribe();
    await manager.setLimits(id, 130, 0);
    await waitFor(async () => (await run('window.states.at(-1)?.upKbps')) === 130);
    assert.equal(await run('window.states.at(-1).chat'), 200); assert.equal(await run('window.states.at(-1).files'), 1000);
    const roomsPath = path.join(root, 'profile', 'rooms.json'), originalRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function(file, ...args) { if (file === roomsPath) reads++; return originalRead.call(this, file, ...args); };
    try {
      for (let i = 0; i < 10; i++) assert.equal((await manager.list())[0].unread, 200);
      assert.equal(reads, 0, 'Repeated list should reuse protected JSON without disk reads');
    } finally { fs.readFileSync = originalRead; }
    const raw = JSON.parse(originalRead(roomsPath, 'utf8'));
    assert.ok(!JSON.stringify(raw).includes('private smoke body')); raw.rooms[id].name = 'External replacement';
    fs.writeFileSync(roomsPath, JSON.stringify(raw)); assert.equal(db.getPersistedRoom(id).name, 'External replacement');
    manager.destroy();
    for (const channel of ['room-persist-chat', 'room-persist-chat-edit', 'rooms:typing', 'rooms:reactFile', 'rooms:reactChat']) ipcMain.removeHandler(channel);
    manager = new RoomManager(); manager.setMainWindow(ui); await manager.restoreAll();
    const restored = await manager.getRoom(id); assert.equal(restored.files.length, 1000); assert.equal(restored.chat.length, 200);
    assert.equal(db.getRoomChats(id)[0].text, chat[0].text);
    await manager.leaveRoom(id); assert.equal(db.getPersistedRoom(id), undefined); assert.deepEqual(db.getRoomChats(id), []);
    console.log(JSON.stringify({ fullBytes, deltaBytes, reduction: +(fullBytes / deltaBytes).toFixed(1), repeatedListDiskReads: reads }));
    console.log('PASS: sandbox preload, engine/main/UI deltas, UI reload resync, protected storage cache, external replacement, restart and atomic room cleanup');
    finish(0);
  }).catch(error => finish(1, error));
}
