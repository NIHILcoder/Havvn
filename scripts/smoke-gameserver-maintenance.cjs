// Actual Minecraft/NeoForge acceptance. Only cached binaries and an already
// accepted eula.txt are read from --source; no user world/config/mod is copied.
// Usage: npm run build:electron, then node <this script> --source <installed
// NeoForge root> --java <java.exe>. Isolated profile, loopback listener, no peers.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app } = require('electron');
  const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), crypto = require('node:crypto'), net = require('node:net');
  const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-minecraft-maintenance-'));
  app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu'); app.on('window-all-closed', () => {});
  let manager, supervisor;
  const deadline = setTimeout(() => { console.error('Minecraft acceptance timeout; evidence:', output); supervisor?.dispose(); app.exit(1); }, 420_000);
  app.whenReady().then(async () => {
    const source = path.resolve(option('--source')), java = path.resolve(option('--java'));
    assert.ok(/^eula=true\s*$/m.test(fs.readFileSync(path.join(source, 'eula.txt'), 'utf8')), 'Source must have an already accepted Minecraft EULA');
    assert.ok(fs.existsSync(java));
    const versions = fs.readdirSync(path.join(source, 'libraries/net/neoforged/neoforge'));
    const version = versions.find(v => fs.existsSync(path.join(source, 'libraries/net/neoforged/neoforge', v, 'win_args.txt')));
    assert.ok(version, 'An installed NeoForge server is required');
    const root = path.resolve(__dirname, '..'), built = path.join(root, 'dist/electron/electron');
    const { ServerManager } = require(path.join(built, 'gameserver/server-manager.js'));
    const store = require(path.join(built, 'db/servers-store.js'));
    const paths = require(path.join(built, 'gameserver/paths.js'));
    const backups = require(path.join(built, 'gameserver/world-backup.js'));
    const resources = require(path.join(built, 'gameserver/host-resources.js'));
    const id = '64'.repeat(16), instance = paths.ensureInstanceDirs(id);
    await fsp.cp(path.join(source, 'libraries'), path.join(instance.root, 'libraries'), { recursive: true });
    fs.writeFileSync(path.join(instance.root, 'eula.txt'), '# Previously accepted in the source installation\neula=true\n');
    const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
    fs.writeFileSync(path.join(instance.root, 'server.properties'), [
      'server-ip=127.0.0.1', `server-port=${port}`, 'online-mode=false', 'white-list=true', 'enable-query=false', 'enable-rcon=false',
      'level-name=acceptance', 'level-seed=12345', 'view-distance=2', 'simulation-distance=2', 'spawn-protection=0', 'max-players=1', 'sync-chunk-writes=true',
    ].join('\n'));
    const argfile = `libraries/net/neoforged/neoforge/${version}/win_args.txt`;
    store.upsertInstance({ instanceId: id, moduleId: 'minecraft', roomId: 'acceptance-room', name: '6.4 isolated Minecraft', createdAt: Date.now(), installed: true,
      autoRestart: false, config: { 'havvn-memory-mb': '1024' }, contentBindings: {}, ref: { id: `neoforge:${version}`, label: `NeoForge ${version}`, flavour: 'neoforge', version: '1.20.6', stable: true, runtime: { id: 'java', major: 21 }, meta: { argfile } } });
    let files = [];
    manager = new ServerManager(); manager.init({ getSelfId: () => 'acceptance-host', getRoomVip: () => null, getServerMirrors: () => [], getRoomContentFiles: () => files,
      getKnownRoomIds: () => ['acceptance-room'], isRoomAvailable: () => true, onRoomUpdate: () => {} });
    supervisor = manager.entries.get(id).supervisor; supervisor.deps.resolveRuntime = () => java;
    const lines = [];
    supervisor.console.subscribe(line => { lines.push(line.text); fs.appendFileSync(path.join(output, 'console.txt'), line.text + '\n'); });
    const wait = async (predicate, label) => { const until = Date.now() + 120_000; while (!predicate()) {
      if (supervisor.status === 'crashed' || Date.now() > until) throw new Error(label + ': ' + lines.slice(-15).join('\n'));
      await new Promise(resolve => setTimeout(resolve, 100));
    } };
    const start = async () => { assert.equal(manager.start(id).ok, true); await wait(() => supervisor.status === 'running', 'Minecraft ready'); };
    const command = async (text, response) => { const index = lines.length; assert.equal((await manager.sendCommand(id, text)).ok, true);
      await wait(() => lines.slice(index).some(line => line.includes(response)), 'Command ' + text); };
    const stop = async () => { await supervisor.stopAndWait(); assert.equal(supervisor.pid, undefined); };
    const world = path.join(instance.root, 'acceptance');
    const hashes = () => { const out = {}; const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name); if (e.isDirectory()) walk(abs); else out[path.relative(world, abs)] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    } }; walk(world); return out; };
    await start();
    await assert.rejects(manager.createBackup(id), /stop-first/); await assert.rejects(manager.restoreBackup(id, 'not-made'), /stop-first/);
    await command('forceload add 0 0', 'Marked');
    await command('setblock 0 80 0 minecraft:diamond_block', 'Changed the block'); await stop();
    const snapshot = hashes(), backup = await manager.createBackup(id, 'actual Minecraft saved world');
    // A real async OS copy exposes the start/delete race without a mocked process.
    const copy = manager.createBackup(id, 'race guard');
    assert.equal(manager.start(id).reason, 'maintenance-busy'); await assert.rejects(manager.deleteInstance(id, { deleteFiles: true }), /maintenance-busy/); await copy;
    await start(); await command('setblock 0 80 0 minecraft:gold_block', 'Changed the block'); await stop();
    const current = hashes(); assert.notDeepEqual(current, snapshot);
    const backupFile = path.join(instance.base, 'backups', backup.id, 'world/level.dat');
    const intact = fs.readFileSync(backupFile); fs.appendFileSync(backupFile, ' damaged');
    try { await assert.rejects(manager.restoreBackup(id, backup.id), /backup-damaged/); assert.deepEqual(hashes(), current); }
    finally { fs.writeFileSync(backupFile, intact); }
    const free = resources.freeBytes; resources.freeBytes = () => 0;
    try { await assert.rejects(manager.restoreBackup(id, backup.id), /disk-space/); assert.deepEqual(hashes(), current); }
    finally { resources.freeBytes = free; }
    const cp = fsp.cp; fsp.cp = async (_src, dest) => { await fsp.mkdir(dest, { recursive: true }); await fsp.writeFile(path.join(dest, 'partial'), 'broken'); throw new Error('ENOSPC acceptance fault'); };
    try { await assert.rejects(manager.restoreBackup(id, backup.id), /ENOSPC/); assert.deepEqual(hashes(), current); }
    finally { fsp.cp = cp; }
    await manager.restoreBackup(id, backup.id); assert.deepEqual(hashes(), snapshot);
    await start(); await command('execute if block 0 80 0 minecraft:diamond_block run say HAVVN_RESTORED_WORLD', 'HAVVN_RESTORED_WORLD'); await stop();
    // Use a real loader and a jar from its cache. With no hash approval the jar
    // must never enter mods/ and the manager must refuse starting that pack.
    const jar = path.join(source, 'libraries/com/google/code/gson/gson/2.10.1/gson-2.10.1.jar'); assert.ok(fs.existsSync(jar));
    const modSource = path.join(output, 'candidate.jar'); await fsp.copyFile(jar, modSource);
    files = [{ fileId: 'candidate', name: 'candidate.jar', folderId: 'mods-folder', infoHash: 'fixture', size: fs.statSync(modSource).size, localPath: modSource }];
    manager.setContentFolder(id, 'mods', 'mods-folder');
    const pending = await manager.syncContent(id); assert.equal(pending.sync, 'conflict');
    assert.equal(fs.existsSync(path.join(instance.root, 'mods/candidate.jar')), false); assert.equal(manager.start(id).reason, 'content-pending'); assert.equal(supervisor.pid, undefined);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(modSource)).digest('hex'); manager.consentContent([hash]);
    const accepted = await manager.syncContent(id); assert.equal(accepted.sync, 'ok');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(instance.root, 'mods/candidate.jar'))).digest('hex'), hash);
    fs.appendFileSync(modSource, ' changed');
    assert.equal((await manager.syncContent(id)).sync, 'conflict'); assert.equal(manager.start(id).reason, 'content-pending');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(instance.root, 'mods/candidate.jar'))).digest('hex'), hash);
    // Remove the fixture jar before restarting: it is a consent probe, not a mod.
    files = []; assert.equal((await manager.syncContent(id)).sync, 'ok');
    // A harmless, locally generated datapack exercises actual content loading,
    // including the configured world name. No remote mod code is executed.
    const pack = path.join(output, 'acceptance.zip');
    const writePack = message => {
      const entries = [ ['pack.mcmeta', JSON.stringify({ pack: { pack_format: 41, description: 'Havvn acceptance' } })],
        ['data/minecraft/tags/functions/load.json', '{"values":["havvn:load"]}'], ['data/havvn/functions/load.mcfunction', 'say ' + message + '\n'] ];
      const local = [], central = []; let offset = 0;
      for (const [filename, text] of entries) {
        const name = Buffer.from(filename), data = Buffer.from(text), crc = require('node:zlib').crc32(data);
        const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
        const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
        directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
        local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
      }
      const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16); fs.writeFileSync(pack, Buffer.concat([...local, index, end]));
    };
    manager.setContentFolder(id, 'datapacks', 'packs');
    for (const revision of ['A', 'B']) {
      writePack('HAVVN_CONTENT_' + revision);
      files = [{ fileId: 'pack', name: 'acceptance.zip', folderId: 'packs', infoHash: revision, size: fs.statSync(pack).size, localPath: pack }];
      manager.onRoomContentChanged('acceptance-room'); assert.equal((await manager.syncContent(id)).sync, 'ok');
      assert.ok(fs.existsSync(path.join(world, 'datapacks/acceptance.zip')));
      const index = lines.length; await start();
      await wait(() => lines.slice(index).some(line => line.includes('HAVVN_CONTENT_' + revision)), 'Actual datapack revision loaded');
      if (revision === 'B') assert.ok(!lines.slice(index).some(line => line.includes('HAVVN_CONTENT_A')));
      await stop();
    }
    const evidence = { server: `Minecraft 1.20.6 / NeoForge ${version}`, realJvm: true, isolatedLoopbackOnly: true,
      runningBackupAndRestoreRefused: true, copyBlocksStartAndDelete: true, savedWorldBackup: true, restoredWorldHashesMatch: true, restoredBlockLoadedByMinecraft: true,
      lowSpacePreservesWorld: true, failedCopyPreservesWorld: true, damagedBackupPreservesWorld: true, unapprovedJarNeverInstalledOrStarted: true, approvedJarHashMatches: true, changedJarRequiresNewConsent: true,
      executableFixtureIsLibraryNotGameplayMod: true, serverStartsAfterContentRemoval: true, actualDatapackRevisionSwitch: true, customWorldDatapacksLoaded: true };
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    manager.dispose(); clearTimeout(deadline); console.log('Minecraft maintenance passed:', JSON.stringify(evidence)); console.log('Evidence:', path.join(output, 'evidence.json')); app.exit(0);
  }).catch(async error => { console.error(error); console.error('Evidence:', output); try { await supervisor?.stopAndWait(); } catch {} manager?.dispose(); clearTimeout(deadline); app.exit(1); });
}
