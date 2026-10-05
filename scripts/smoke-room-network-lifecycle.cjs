// Isolated native process smoke: synthetic loopback server, never a user's JVM/world.
if (!process.versions.electron) {
  const env = { ...process.env, HAVVN_SMOKE_NODE: process.execPath }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), net = require('node:net');
  const output = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-room-network-'));
  app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu'); app.on('window-all-closed', () => {});
  let supervisor; const deadline = setTimeout(() => { supervisor?.dispose(); app.exit(1); }, 60_000);
  app.whenReady().then(async () => {
    const root = path.resolve(__dirname, '..');
    const { Supervisor } = require(path.join(root, 'dist/electron/electron/gameserver/supervisor.js'));
    const { genericModule } = require(path.join(root, 'dist/electron/electron/gameserver/modules/generic/index.js'));
    const fixture = path.join(output, 'loopback-server.cjs');
    fs.writeFileSync(fixture, `const net=require('node:net'),fs=require('node:fs');
      const server=net.createServer(s=>{s.on('error',()=>{});s.end()});server.listen(0,'127.0.0.1',()=>console.log('READY:'+server.address().port));
      process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{console.log('SEEN:'+text.trim());if(text.trim()==='stop'&&!process.argv.includes('--ignore-stop')){
        fs.writeFileSync('world-preserved.txt','saved');server.close(()=>process.exit(0));}});`);
    let port; let ignoreStop = false;
    const module = { ...genericModule,
      planLaunch: () => ({ runtime: { id: 'java', major: 21 }, args: ignoreStop ? [fixture, '--ignore-stop'] : [fixture], cwd: '' }),
      stopPlan: () => ({ command: 'stop', graceMs: 1000 }),
      parseLine: line => { const m = /^READY:(\d+)$/.exec(line); if (m) { port = Number(m[1]); return [{ t: 'ready' }]; } return []; },
    };
    supervisor = new Supervisor(module, { config: {} }, { resolveRuntime: () => process.env.HAVVN_SMOKE_NODE,
      instanceRoot: output, logsDir: path.join(output, 'logs'), onChange: () => {}, onEvent: () => {} });
    const wait = async predicate => { const limit = Date.now() + 12_000; while (!predicate()) {
      if (Date.now() > limit) throw new Error('Synthetic server state timeout'); await new Promise(r => setTimeout(r, 25));
    } };
    assert.equal(supervisor.start().ok, true); await wait(() => supervisor.status === 'running');
    const reachable = p => new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port: p });
      socket.on('connect', () => { socket.destroy(); resolve(true); }); socket.on('error', () => resolve(false)); });
    assert.equal(await reachable(port), true);
    await supervisor.stopAndWait(); assert.equal(supervisor.child, null);
    assert.equal(await reachable(port), false); assert.equal(fs.readFileSync(path.join(output, 'world-preserved.txt'), 'utf8'), 'saved');
    supervisor.autoRestart = true; assert.equal(supervisor.start().ok, true); await wait(() => supervisor.status === 'running');
    supervisor.child.kill(); await wait(() => supervisor.status === 'starting' && !supervisor.child);
    await supervisor.stopAndWait(); assert.notEqual(supervisor.status, 'starting');
    await new Promise(resolve => setTimeout(resolve, 5500)); assert.equal(supervisor.child, null);
    assert.equal(supervisor.start().ok, true); await wait(() => supervisor.status === 'running'); await supervisor.stopAndWait();
    ignoreStop = true; assert.equal(supervisor.start().ok, true); await wait(() => supervisor.status === 'running');
    const forcedPort = port; await supervisor.stopAndWait(); assert.equal(supervisor.child, null); assert.equal(await reachable(forcedPort), false);
    assert.equal(fs.readFileSync(path.join(output, 'world-preserved.txt'), 'utf8'), 'saved');
    // Exercise the actual manager's detach path against this live loopback child.
    ignoreStop = false; supervisor.dispose();
    const { ServerManager } = require(path.join(root, 'dist/electron/electron/gameserver/server-manager.js'));
    const store = require(path.join(root, 'dist/electron/electron/db/servers-store.js'));
    const manager = new ServerManager();
    const instanceId = '1'.repeat(32), ref = (await genericModule.catalog())[0];
    const persisted = { instanceId, moduleId: 'generic', roomId: 'synthetic-room', name: 'Isolated fixture', ref, config: {}, createdAt: Date.now(), installed: true,
      autoRestart: true, scheduleEnabled: true, schedules: [], contentBindings: { mods: 'old-room-folder' }, contentAutoSync: true, contentRev: 0 };
    store.upsertInstance(persisted); store.grantOperator(instanceId, 'operator');
    let available = true;
    const updates = [];
    const deps = { getSelfId: () => 'self', isRoomAvailable: () => available, getRoomVip: () => '10.1.0.1', getServerMirrors: () => [], getRoomContentFiles: () => [], getKnownRoomIds: () => ['synthetic-room'], onRoomUpdate: roomId => updates.push(roomId) };
    const paths = require(path.join(root, 'dist/electron/electron/gameserver/paths.js'));
    paths.ensureInstanceDirs(instanceId); manager.init(deps);
    const entry = manager.entries.get(instanceId), capturedBinding = entry.persisted;
    entry.module = module; supervisor = entry.supervisor; supervisor.module = module;
    supervisor.deps.resolveRuntime = () => process.env.HAVVN_SMOKE_NODE;
    assert.equal(manager.start(instanceId).ok, true); await wait(() => supervisor.status === 'running');
    const request = { commandId: require('node:crypto').randomUUID(), by: 'operator', hostId: 'self', instanceId, command: 'say fixture', at: Date.now(), expiresAt: Date.now() + 30000 };
    assert.equal(manager.handleRemoteCommand('operator', 'synthetic-room', instanceId, request.command, request).ok, true);
    assert.equal(manager.handleRemoteCommand('operator', 'synthetic-room', instanceId, request.command, { ...request, at: request.at + 1 }).ok, true);
    await wait(() => supervisor.console.snapshot(0).some(line => line.text === 'SEEN:say fixture'));
    assert.equal(supervisor.console.snapshot(0).filter(line => line.text === 'SEEN:say fixture').length, 1);
    available = false;
    await manager.onRoomUnavailable('synthetic-room', 'left-local');
    assert.equal(await reachable(port), true); assert.equal(supervisor.status, 'running');
    assert.equal(entry.persisted, capturedBinding); assert.equal(manager.stateForRoom('').instances[0].local, true); assert.equal(manager.stateForRoom('synthetic-room').instances.length, 0);
    assert.deepEqual(store.listOperators(instanceId), []); assert.equal(store.getInstance(instanceId).scheduleEnabled, false);
    assert.equal(store.getInstance(instanceId).contentAutoSync, false); assert.equal(store.getInstance(instanceId).roomId, '');
    assert.equal(manager.handleRemoteCommand('operator', 'synthetic-room', instanceId, 'stop').ok, false);
    updates.length = 0; await supervisor.stopAndWait(); assert.equal(await reachable(port), false);
    assert.ok(updates.includes('')); assert.ok(!updates.includes('synthetic-room'));
    // Safe default waits for stop then exposes the kept server locally too.
    Object.assign(entry.persisted, { ...persisted, roomId: 'second-room' }); store.upsertInstance(entry.persisted);
    assert.equal(supervisor.start().ok, true); await wait(() => supervisor.status === 'running');
    await manager.onRoomUnavailable('second-room', 'left'); assert.equal(await reachable(port), false);
    assert.equal(store.getInstance(instanceId).roomId, ''); assert.equal(fs.readFileSync(path.join(output, 'world-preserved.txt'), 'utf8'), 'saved');
    assert.equal(fs.readFileSync(path.join(paths.instancePaths(instanceId).root, 'world-preserved.txt'), 'utf8'), 'saved');
    manager.dispose();
    const orphanId = '2'.repeat(32); paths.ensureInstanceDirs(orphanId); store.upsertInstance({ ...store.getInstance(instanceId), instanceId: orphanId, roomId: 'removed-room', autoRestart: true, scheduleEnabled: true });
    const restored = new ServerManager(); restored.init({ ...manager.deps, getRoomContentFiles: () => [], getKnownRoomIds: () => [] });
    assert.equal(restored.stateForRoom('').instances[0].local, true); assert.notEqual(restored.stateForRoom('').instances[0].status, 'running'); assert.equal(store.getInstance(orphanId).roomId, ''); assert.equal(store.getInstance(orphanId).scheduleEnabled, false); restored.dispose();
    const evidence = { realCommandAcknowledgedOnce: true, restoredCallbacksFollowLocalBinding: true, orphanedInstanceMigrated: true, backgroundDetachmentKeepsLiveProcess: true, detachedInstanceManageable: true, persistedRestoreStaysStopped: true, remoteGrantsRemoved: true,
      schedulesAndContentSyncDisabled: true, safeDefaultStopsAndPreservesWorld: true, isolatedLoopbackOnly: true, realChildStarted: true, listenerClosedBeforeCompletion: true,
      worldSavedAndPreserved: true, pendingAutoRestartCancelled: true, restartSlotReleased: true, manualRestartWorks: true, unresponsiveProcessTerminated: true };
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('Room network lifecycle smoke passed:', JSON.stringify(evidence)); console.log('Evidence:', path.join(output, 'evidence.json'));
    supervisor.dispose(); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); console.error(supervisor?.console.snapshot(0)); supervisor?.dispose(); clearTimeout(deadline); app.exit(1); });
}
