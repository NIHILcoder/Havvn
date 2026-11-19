/* eslint-disable @typescript-eslint/no-require-imports -- Interactive native acceptance fixture. */
// Used from node_repl while real Word/Excel are controlled through computer-use.
// Only generated test documents are transferred over a loopback-only E2E room.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const assert = require('node:assert/strict');
const repository = path.resolve(__dirname, '../..');
const prefix = 'SYNC_FIXTURE ';
function outputFor(kind) {
  assert.ok(['office', 'ide'].includes(kind));
  return path.join(repository, `dist/room-sync-${kind}`);
}

function prepare(kind = 'office') {
  const output = outputFor(kind);
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(output, 'run-'));
  for (const peer of ['publisher', 'receiver']) fs.mkdirSync(path.join(root, peer, 'working'), { recursive: true });
  return root;
}

async function start(root, kind = 'office', resume = false) {
  const output = outputFor(kind);
  assert.equal(path.dirname(path.resolve(root)), output);
  assert.ok(path.basename(root).startsWith('run-'));
  const { Server } = await import('bittorrent-tracker');
  const tracker = new Server({ udp: false, http: false, ws: true, stats: false });
  tracker.on('error', error => console.error('Office fixture tracker:', error.message));
  await new Promise(resolve => tracker.listen(0, '127.0.0.1', resolve));
  const trackerUrl = `ws://127.0.0.1:${tracker.http.address().port}`;
  const workers = {};
  const evidence = resume ? JSON.parse(fs.readFileSync(path.join(root, `${kind}-acceptance.json`), 'utf8')) : { startedAt: new Date().toISOString(), physicalMachines: 1, loopbackOnly: true,
    [kind === 'ide' ? 'ideTested' : 'officeTested']: false, plannedAutomation: 'computer-use UI, real installed applications', checks: [], passed: false,
    limitations: ['Not physical-PC/NAT acceptance', 'No installation/update acceptance'] };
  function writeReport() {
    fs.writeFileSync(path.join(root, `${kind}-acceptance.json`), JSON.stringify(evidence, null, 2));
  }
  const waitFor = async (read, predicate, label, timeout = 45_000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await read();
      if (predicate(last)) return last;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error(`${label}: ${JSON.stringify(last)}`);
  };
  async function launch(name) {
    const env = { ...process.env, HAVVN_SYNC_FIXTURE_DIRECTORY: path.join(root, name),
      HAVVN_SYNC_FIXTURE_TRACKER: trackerUrl, HAVVN_SYNC_FIXTURE_OFFICE: '1',
      HAVVN_SYNC_FIXTURE_UI: '', HAVVN_SYNC_FIXTURE_DOCUMENTS: '', HAVVN_SYNC_FIXTURE_DELETES: '' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(repository, 'scripts/smoke-room-file-sync.cjs')],
      { cwd: repository, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let sequence = 0, logs = '';
    const ready = new Promise((resolve, reject) => pending.set(0, { resolve, reject }));
    const receive = line => {
      if (!line.startsWith(prefix)) { logs = (logs + '\n' + line).slice(-12000); return; }
      const packet = JSON.parse(line.slice(prefix.length)), waiter = pending.get(packet.id);
      if (!waiter) return;
      pending.delete(packet.id);
      if (packet.ok) waiter.resolve(packet.result); else waiter.reject(Error(packet.error));
    };
    createInterface({ input: child.stdout }).on('line', receive);
    child.stderr.on('data', data => { logs = (logs + data).slice(-12000); });
    const rejectAll = error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
    child.on('error', rejectAll);
    child.on('exit', code => rejectAll(Error(`${name} exited ${code}: ${logs}`)));
    const timer = setTimeout(() => rejectAll(Error(`${name} startup timeout: ${logs}`)), 30_000);
    let socket;
    const worker = { child, logs: () => logs, call: (action, values = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`${name}/${action} timeout: ${logs}`)); }, 60_000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket.write(JSON.stringify({ id, action, ...values }) + '\n');
    }) };
    workers[name] = worker;
    try {
      const { port } = await ready;
      socket = require('node:net').createConnection({ host: '127.0.0.1', port });
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      createInterface({ input: socket }).on('line', receive);
    } finally { clearTimeout(timer); }
    return worker;
  }
  async function stop() {
    for (const worker of Object.values(workers)) {
      if (worker.child.exitCode !== null) continue;
      const exited = new Promise(resolve => worker.child.once('exit', resolve));
      try { await worker.call('stop'); await exited; } catch { worker.child.kill(); }
    }
    await new Promise(resolve => tracker.close(resolve));
    writeReport();
  }
  try {
    const left = await launch('publisher'), right = await launch('receiver');
    evidence.runtime = await left.call('runtime');
    let created, joined, rootId;
    if (resume) {
      const leftIds = await left.call('persisted-room-ids'), rightIds = await right.call('persisted-room-ids');
      assert.equal(leftIds.length, 1); assert.equal(rightIds.length, 1);
      created = { roomId: leftIds[0] }; joined = { roomId: rightIds[0] };
      await left.call('restore'); await right.call('restore');
      evidence.resumedAt = new Date().toISOString();
      if (evidence.error) { (evidence.recoveryErrors ||= []).push(evidence.error); delete evidence.error; }
    } else {
      created = await left.call('create');
      joined = await right.call('join', { invite: created.invite });
    }
    await waitFor(() => left.call('inspect', { roomId: created.roomId }), state => state.members >= 2, 'Peers did not connect');
    await waitFor(() => right.call('inspect', { roomId: joined.roomId }), state => state.members >= 2 && state.owner, 'Receiver did not connect');
    if (resume) {
      const roots = await left.call('roots', created);
      assert.equal(roots.length, 1); rootId = roots[0].rootId;
    }
    if (!resume) rootId = await left.call('create-root', { roomId: created.roomId });
    await waitFor(() => right.call('roots', { roomId: joined.roomId }), roots => roots.some(root => root.rootId === rootId), 'Root not delivered');
    if (!resume) await right.call('bind', { roomId: joined.roomId, rootId });
    const call = (peer, action, values = {}) => workers[peer].call(action,
      { roomId: peer === 'publisher' ? created.roomId : joined.roomId, rootId, ...values });
    await call('publisher', 'auto-publish', { enabled: true });
    evidence.build = Object.fromEntries(['room-file-sync.js', 'room-sync-session.js', 'room-sync-apply.js', 'room-engine.js']
      .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(repository, 'dist/electron/electron/sharing', name))).digest('hex')]));
    writeReport();
    const hash = (peer, name) => {
      const file = path.join(root, peer, 'working', name);
      return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
    };
    return { root, evidence, call, hash, waitFor, stop,
      record(id, details = {}) { evidence.checks.push({ id, passed: true, at: new Date().toISOString(), ...details }); writeReport(); },
      save: writeReport,
      async delivered(name) {
        return waitFor(async () => ({ source: hash('publisher', name), destination: hash('receiver', name),
          page: await call('receiver', 'sync-files') }), state => state.source && state.source === state.destination
            && state.page.items.some(item => item.path === name && item.status === 'applied'), `${name} not applied`);
      },
    };
  } catch (error) { evidence.error = String(error); await stop(); throw error; }
}

module.exports = { prepare, start };

// Run the native peers outside the restricted tool process, while computer-use
// drives Office separately. The control endpoint is loopback-only and protected
// by a per-run random token; it only controls this fixture's generated profiles.
if (require.main === module) {
  (async () => {
    const root = path.resolve(process.argv[2] || '');
    const kind = process.argv.includes('--kind=ide') ? 'ide' : 'office';
    const session = await start(root, kind, process.argv.includes('--resume'));
    const token = crypto.randomBytes(32).toString('hex');
    const allowedActions = new Set(['sync-files', 'rescan', 'history', 'inspect', 'journal-state',
      'sync-view', 'roots', 'auto-apply', 'auto-publish', 'publish-existing', 'conflict-preview', 'conflict-resolve']);
    const server = require('node:http').createServer(async (request, response) => {
      const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
      if (request.method !== 'POST' || request.url !== '/' || request.headers.authorization !== `Bearer ${token}`) return send(403, { error: 'Forbidden' });
      try {
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 65536) throw Error('Request too large'); chunks.push(chunk); }
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let result;
        if (message.op === 'call' && ['publisher', 'receiver'].includes(message.peer) && allowedActions.has(message.action)) result = await session.call(message.peer, message.action, message.values);
        else if (message.op === 'delivered' && require('../../dist/electron/shared/room-file-sync').validSyncRelativePath(message.name)) result = await session.delivered(message.name);
        else if (message.op === 'record' && typeof message.id === 'string') { session.record(message.id, message.details); result = true; }
        else if (message.op === 'evidence') {
          for (const key of ['officeTested', 'ideTested', 'ideVersion', 'sdkVersion', 'passed', 'status', 'remainingChecks', 'officeVersions', 'wordMode', 'excelMode', 'limitations', 'finishedAt', 'error']) {
            if (message.values && Object.hasOwn(message.values, key)) session.evidence[key] = message.values[key];
          }
          session.save(); result = session.evidence;
        } else if (message.op === 'stop') {
          await session.stop(); fs.rmSync(path.join(root, 'control.json'), { force: true });
          send(200, { result: true }); server.close(); clearTimeout(deadline); return;
        } else throw Error('Unsupported fixture operation');
        send(200, { result });
      } catch (error) { send(500, { error: String(error) }); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify({ port: server.address().port, token }));
    const deadline = setTimeout(async () => { await session.stop(); fs.rmSync(path.join(root, 'control.json'), { force: true }); server.close(); }, 3_300_000);
    console.log(JSON.stringify({ ready: true, root, controlFile: path.join(root, 'control.json') }));
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
