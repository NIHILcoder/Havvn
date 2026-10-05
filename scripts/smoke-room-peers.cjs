// Three real RoomManager/preload processes; synthetic profiles/files, loopback rendezvous.
// A <-> C signaling is deliberately dropped to exercise gossip through B.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.versions.electron) {
  const { app, safeStorage } = require('electron');
  const output = process.env.HAVVN_PEER_OUTPUT;
  assert.ok(output && process.env.TH_INSTANCE && process.env.HAVVN_ROOM_TRACKERS);
  app.setPath('userData', path.join(output, 'profile'));
  require(path.join(root, 'dist/electron/electron/app-instance.js'));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  app.on('window-all-closed', () => {});
  let manager;
  async function bus(method, body) {
    const result = await fetch(process.env.HAVVN_PEER_BUS + '/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: process.env.HAVVN_PEER_TOKEN },
      body: JSON.stringify({ role: process.env.HAVVN_PEER_ROLE, ...body }),
    });
    if (!result.ok) throw new Error('Fixture controller unavailable');
    return result.json();
  }
  app.whenReady().then(async () => {
    assert.equal(safeStorage.isEncryptionAvailable(), true, 'OS protected storage is required');
    // Local fixture transport only. Production STUN/privacy policy is not changed.
    const wrapper = path.join(output, 'preload-local.cjs');
    fs.writeFileSync(wrapper, `require(${JSON.stringify(path.join(root, 'dist/electron/electron/sharing/ice-servers.js'))}).STUN_SERVERS.length=0;require(${JSON.stringify(path.join(root, 'dist/electron/electron/sharing/room-engine.js'))});`);
    const Module = require('node:module'), original = Module._load, electron = require('electron');
    class LocalWindow extends electron.BrowserWindow {
      constructor(options) {
        const engine = path.basename(options.webPreferences?.preload || '') === 'room-engine.js';
        if (engine) options.webPreferences.preload = wrapper;
        super(options);
        if (engine) this.webContents.setWebRTCIPHandlingPolicy('default_public_and_private_interfaces');
      }
    }
    Module._load = function (name, ...args) {
      if (name === 'electron') return new Proxy(electron, { get: (target, key) => key === 'BrowserWindow' ? LocalWindow : target[key] });
      return original.call(this, name, ...args);
    };
    const { RoomManager } = require(path.join(root, 'dist/electron/electron/sharing/room-manager.js'));
    Module._load = original;
    const db = require(path.join(root, 'dist/electron/electron/db/store.js'));
    await db.updateSettings({ defaultDownloadDir: path.join(app.getPath('userData'), 'downloads'), shareUseTurn: false });
    manager = new RoomManager();
    manager.setProfile({ name: 'Acceptance ' + process.env.HAVVN_PEER_ROLE });
    await bus('ready', { profile: app.getPath('userData'), memberId: manager.getProfile().memberId });
    let stopping = false;
    const commands = {
      create: p => manager.createRoom(p.name, p.e2e, false),
      join: p => manager.joinRoom(p.invite, false),
      state: p => manager.getRoom(p.roomId),
      leave: p => manager.leaveRoom(p.roomId, false),
      add: p => manager.addFiles(p.roomId, p.paths),
      fetch: p => manager.fetchFile(p.roomId, p.fileId),
      chat: p => manager.sendChat(p.roomId, p.text),
      kick: p => manager.kick(p.roomId, p.memberId),
      retry: p => manager.retryConnection(p.roomId),
      diagnose: p => manager.diagnoseRoom(p.roomId),
      suspend: () => manager.suspendNetworking('vpn'),
      resume: () => manager.resumeNetworking('vpn'),
      verified: async p => {
        const file = await manager.call('verifiedFile', p);
        const localPath = typeof file === 'string' ? file : file?.localPath || file?.path;
        assert.ok(localPath, 'Engine must return verified local path');
        return { path: localPath, sha256: crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex') };
      },
      stop: () => { stopping = true; manager.destroy(); return true; },
    };
    while (!stopping) {
      const command = await bus('poll', {});
      if (!command.id) { await pause(50); continue; }
      try {
        if (!commands[command.command]) throw new Error('Unknown fixture command');
        const value = await commands[command.command](command.payload);
        await bus('result', { id: command.id, value });
      } catch (error) { await bus('result', { id: command.id, error: String(error.message || error) }); }
    }
    app.exit(0);
  }).catch(error => { console.error(error); manager?.destroy(); app.exit(1); });
} else {
  (async () => {
    const output = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-room-peers-'));
    const token = crypto.randomBytes(32).toString('hex'), queues = new Map(), pending = new Map(), ready = new Map(), children = new Map();
    let serial = 0, blockedSignals = 0;
    const rooms = {}, identities = {}, evidence = { localRendezvousOnly: true, productionTransportPolicyUnchanged: true };
    const { Server } = await import('bittorrent-tracker');
    const tracker = new Server({ http: false, udp: false, ws: true, interval: 150000 });
    tracker.on('error', error => console.error('Fixture tracker:', error.message));
    const peerRoles = new Map();
    tracker.ws.on('connection', (socket, request) => {
      const role = request.url.slice(1);
      socket.prependListener('message', data => { try { const value = JSON.parse(String(data)); if (value.peer_id) peerRoles.set(value.peer_id, role); } catch {} });
      const send = socket.send.bind(socket);
      socket.send = (data, ...args) => {
        try {
          const value = JSON.parse(String(data)), source = peerRoles.get(value.peer_id);
          if ((value.offer || value.answer) && ((source === 'A' && role === 'C') || (source === 'C' && role === 'A'))) {
            blockedSignals++; const callback = args.find(arg => typeof arg === 'function'); callback?.(); return;
          }
        } catch {}
        return send(data, ...args);
      };
    });
    await new Promise(resolve => tracker.listen(0, '127.0.0.1', resolve));
    // Reserve a rejecting endpoint instead of assuming an unused port remains free.
    const rejected = http.createServer((_req, res) => { res.writeHead(503); res.end(); });
    rejected.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'));
    await new Promise(resolve => rejected.listen(0, '127.0.0.1', resolve));
    const bus = http.createServer(async (req, res) => {
      if (req.headers.authorization !== token || req.method !== 'POST') { res.writeHead(403); res.end(); return; }
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 8 * 1024 * 1024) throw new Error('Fixture request too large'); }
        const value = JSON.parse(body), role = value.role;
        assert.ok(['A', 'B', 'C'].includes(role));
        let reply = {};
        if (req.url === '/ready') ready.set(role, value);
        else if (req.url === '/poll') reply = queues.get(role)?.shift() || {};
        else if (req.url === '/result') {
          const job = pending.get(value.id);
          if (job?.role === role) { pending.delete(value.id); clearTimeout(job.timer); value.error ? job.reject(new Error(role + ': ' + value.error)) : job.resolve(value.value); }
        } else throw new Error('Unknown controller route');
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply));
      } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: String(error.message) })); }
    });
    await new Promise(resolve => bus.listen(0, '127.0.0.1', resolve));
    async function wait(test, label, timeout = 40000) {
      const until = Date.now() + timeout;
      while (!await test()) { if (Date.now() > until) throw new Error('Timed out: ' + label); await pause(200); }
    }
    function command(role, command, payload = {}) {
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Command timeout: ' + role + '/' + command)); }, 40000);
        pending.set(id, { role, timer, resolve, reject }); queues.get(role).push({ id, command, payload });
      });
    }
    async function start(role, generation = 0) {
      ready.delete(role); queues.set(role, []);
      const env = { ...process.env, TH_INSTANCE: 'acceptance-' + role + generation,
        HAVVN_PEER_OUTPUT: output, HAVVN_PEER_ROLE: role, HAVVN_PEER_TOKEN: token,
        HAVVN_PEER_BUS: 'http://127.0.0.1:' + bus.address().port,
        HAVVN_ROOM_TRACKERS: `ws://127.0.0.1:${tracker.http.address().port}/${role},ws://127.0.0.1:${rejected.address().port}/${role}` };
      delete env.ELECTRON_RUN_AS_NODE;
      const log = fs.openSync(path.join(output, role + generation + '.log'), 'a');
      const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: ['ignore', log, log] });
      fs.closeSync(log); children.set(role, child);
      let failure; child.on('error', error => failure = error); child.on('exit', code => { if (code) failure = new Error(role + ' exited ' + code + '; inspect isolated log'); });
      await wait(() => { if (failure) throw failure; return ready.has(role); }, role + ' ready');
      identities[role] = ready.get(role).memberId;
    }
    async function stop(role) {
      const child = children.get(role); if (!child || child.exitCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      await command(role, 'stop'); await Promise.race([exited, pause(5000).then(() => { if (child.exitCode === null) child.kill(); })]);
    }
    const state = role => command(role, 'state', { roomId: rooms[role] });
    async function join(role, invite) { const value = await command(role, 'join', { invite }); rooms[role] = value.roomId; return value; }
    async function share(role, name, content) {
      const file = path.join(output, role + '-source', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
      const value = await command(role, 'add', { roomId: rooms[role], paths: [file] });
      const entry = value.files.find(f => f.addedBy === identities[role] && f.name === name);
      assert.ok(entry); return { entry, file, sha256: crypto.createHash('sha256').update(content).digest('hex') };
    }
    async function fetchVerified(role, fixture) {
      await wait(async () => (await state(role)).files.some(f => f.fileId === fixture.entry.fileId), role + ' manifest');
      await command(role, 'fetch', { roomId: rooms[role], fileId: fixture.entry.fileId });
      await wait(async () => (await state(role)).transfers[fixture.entry.fileId]?.haveLocally === true, role + ' verified download');
      const result = await command(role, 'verified', { roomId: rooms[role], fileId: fixture.entry.fileId });
      assert.equal(result.sha256, fixture.sha256); return result;
    }
    const deadline = setTimeout(() => { console.error('Peer acceptance deadline:', output); for (const child of children.values()) child.kill(); process.exitCode = 1; }, 600000);
    try {
      for (const role of ['A', 'B', 'C']) await start(role);
      assert.equal(new Set([...ready.values()].map(v => v.profile)).size, 3);
      assert.equal(new Set(Object.values(identities)).size, 3); evidence.independentThInstanceProfiles = true;
      const plain = await command('A', 'create', { name: 'Synthetic plain', e2e: false }); rooms.A = plain.roomId;
      await join('B', plain.invite);
      await wait(async () => (await state('A')).peerCount > 0, 'A-B connected');
      await command('A', 'chat', { roomId: rooms.A, text: 'Before late join' });
      await join('C', plain.invite);
      await wait(async () => (await state('C')).chat.some(m => m.text === 'Before late join'), 'C signed backfill');
      await command('A', 'chat', { roomId: rooms.A, text: 'Across bridge' });
      await wait(async () => { const s = await state('C'); return s.chat.some(m => m.text === 'Across bridge') && s.members.some(m => m.memberId === identities.A && m.relayed); }, 'A-B-C relayed chat');
      assert.ok(blockedSignals > 0); evidence.actualThreeProcessRelayAndLateJoin = true;
      const a = await share('A', 'same.txt', 'Original A synthetic bytes\n');
      const c = await share('C', 'same.txt', 'Original C different synthetic bytes\n');
      const receivedA = await fetchVerified('B', a), receivedC = await fetchVerified('B', c);
      assert.notEqual(receivedA.path, receivedC.path); assert.equal(fs.readFileSync(a.file, 'utf8'), 'Original A synthetic bytes\n');
      assert.equal(fs.readFileSync(c.file, 'utf8'), 'Original C different synthetic bytes\n');
      evidence.sameNameFilesVerifiedWithoutOverwrite = true;
      const report = await command('B', 'retry', { roomId: rooms.B });
      assert.equal(JSON.stringify(report).includes(plain.invite), false); evidence.retryDiagnosticsExcludeInvite = true;
      assert.equal(report.connection.trackers.configured, 2);
      assert.ok(report.connection.observations['tracker-unavailable'] > 0);
      assert.ok(report.connection.channels.identified > 0); evidence.failedTrackerDoesNotPreventReadyPeers = true;
      await command('B', 'suspend');
      await assert.rejects(command('B', 'chat', { roomId: rooms.B, text: 'Must not send' }), /suspend|paused|VPN|network/i);
      await command('B', 'resume');
      await wait(async () => (await state('B')).peerCount > 0, 'B resume'); evidence.localSuspendResumeGatesCommands = true;
      for (const role of ['A','B','C']) await command(role, 'leave', {roomId: rooms[role]});
      const encrypted = await command('A', 'create', { name: 'Synthetic encrypted', e2e: true }); rooms.A = encrypted.roomId;
      await join('B', encrypted.invite); await join('C', encrypted.invite);
      await wait(async () => (await state('A')).members.some(m => m.memberId === identities.C && m.online), 'encrypted relay topology');
      const secretFile = await share('A', 'encrypted.txt', 'Synthetic old epoch payload\n');
      await fetchVerified('B', secretFile); evidence.actualEncryptedTransfer = true;
      let invite = encrypted.invite;
      for (let rotation = 1; rotation <= 10; rotation++) {
        await command('A', 'kick', { roomId: rooms.A, memberId: identities.C });
        await wait(async () => { const s = await state('B'); if (s.invite !== invite) { invite = s.invite; return true; } return false; }, 'rotation propagation ' + rotation);
        await stop('C'); await start('C', rotation); await join('C', invite);
        await wait(async () => (await state('A')).members.some(m => m.memberId === identities.C && m.online), 'rotated peer joined ' + rotation);
        console.log('Verified real key rotation', rotation);
      }
      evidence.actualKeyRotations = 10;
      const persistedRoom = rooms.B; await stop('B'); await start('B'); rooms.B = persistedRoom;
      await wait(async () => (await state('B')).peerCount > 0, 'protected-profile restore');
      await stop('A'); await stop('C'); await start('C', 11); await join('C', invite);
      await fetchVerified('C', secretFile); evidence.ownerOfflineLateJoinOldEpochDecryptAfterRestart = true;
      evidence.blockedDirectSignals = blockedSignals;
      fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
      console.log('Room peer acceptance passed:', JSON.stringify(evidence)); console.log('Isolated evidence:', output);
    } finally {
      clearTimeout(deadline);
      for (const role of children.keys()) { try { await stop(role); } catch { children.get(role)?.kill(); } }
      for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('Fixture closed')); } pending.clear();
      await new Promise(resolve => tracker.close(resolve));
      await new Promise(resolve => rejected.close(resolve)); await new Promise(resolve => bus.close(resolve));
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
