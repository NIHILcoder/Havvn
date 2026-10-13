/* eslint-disable @typescript-eslint/no-require-imports -- CJS harness loads the compiled Electron modules. */
// Real NativeTorrentManager + bundled daemon, isolated DB/profile, no public swarm.
// Run after npm run build:electron: node scripts/smoke-native-queue.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { setHostEnv } = require('../dist/electron/electron/torrent/host/env.js');
const db = require('../dist/electron/electron/torrent/host/db-bridge.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const binary = path.resolve(process.env.HAVVN_ENGINE_BINARY || (process.platform === 'win32'
    ? 'vendor/transmission/win32-x64/transmission-daemon.exe'
    : 'vendor/transmission/linux-x64/transmission-daemon'));
  assert(fs.existsSync(binary), 'Fetch the bundled Transmission binary before running this smoke check');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-native-queue-'));
  const downloads = path.join(root, 'download');
  // Disable discovery before the very first daemon launch, not just session-set.
  fs.mkdirSync(path.join(root, 'engine'));
  fs.writeFileSync(path.join(root, 'engine', 'settings.json'), JSON.stringify({
    'dht-enabled': false, 'pex-enabled': false, 'lpd-enabled': false, 'port-forwarding-enabled': false,
  }));
  const records = new Map();
  const settings = {
    defaultDownloadDir: downloads, maxActiveDownloads: 1,
    enableDHT: false, enablePEX: false, enableLSD: false, enableUtp: false,
    maxDownKbps: 0, maxUpKbps: 0, maxConnections: 10, maxConnectionsGlobal: 20,
    adaptiveUpload: false, encryption: 'preferred',
  };
  setHostEnv({ version: 'smoke', isPackaged: false, tempDir: root, userDataDir: root,
    downloadsDir: downloads, engine: 'native', engineBinary: binary, engineStateDir: path.join(root, 'engine') });
  Object.assign(db, {
    getSettings: async () => ({ ...settings }), getPrivacyConfig: async () => ({ vpnBindEngine: false }),
    getAllDownloads: async () => [...records.values()].map(d => ({ ...d })),
    createDownload: async params => {
      const d = { id: crypto.randomUUID(), infoHash: null, progress: 0, downloadedBytes: 0,
        uploadedBytes: 0, totalSize: 0, priority: 1, createdAt: new Date(), ...params };
      records.set(d.id, d); return { ...d };
    },
    updateDownloadStatus: async (id, status, error) => Object.assign(records.get(id), { status, lastError: error ?? null }),
    updateDownloadField: async (id, field, value) => { records.get(id)[field] = value; },
    updateDownloadFields: async (id, fields) => Object.assign(records.get(id), fields),
    updateDownloadsProgressBatch: async rows => { for (const row of rows) Object.assign(records.get(row.id), row); },
    deleteDownload: async id => { records.delete(id); },
  });
  const { NativeTorrentManager } = require('../dist/electron/electron/torrent/native/native-manager.js');
  let manager;
  const initialize = async () => {
    manager = new NativeTorrentManager(); await manager.initialize();
    // Tick explicitly so assertions are deterministic without racing the interval.
    clearInterval(manager.statsTimer); manager.statsTimer = null;
  };
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 15000;
    do {
      await manager.tick();
      const stats = manager.getStats();
      if (predicate(stats)) return stats;
      await sleep(200);
    } while (Date.now() < deadline);
    throw new Error(message + ': ' + JSON.stringify(manager.getStats()));
  };
  const status = (rows, id) => rows.find(row => row.id === id)?.status;
  const active = rows => rows.filter(row => row.status === 'downloading');
  try {
    await initialize();
    const session = await manager.rpc.sessionGet();
    assert.equal(session['download-queue-enabled'], true);
    assert.equal(session['download-queue-size'], 1);
    assert.equal(session['queue-stalled-enabled'], false);
    const createTorrent = (await import('create-torrent')).default;
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const source = path.join(root, `sample-${i}.mp4`);
      fs.writeFileSync(source, Buffer.alloc(64 * 1024, i + 1));
      const metainfo = await new Promise((resolve, reject) => createTorrent(source, {
        announceList: [], pieceLength: 16 * 1024,
      }, (error, bytes) => error ? reject(error) : resolve(bytes)));
      const file = path.join(root, `sample-${i}.torrent`); fs.writeFileSync(file, metainfo);
      ids.push((await manager.addDownload({ sourceType: 'torrent_file', sourceUri: file })).id);
    }
    const magnet = await manager.addDownload({ sourceType: 'magnet', sourceUri: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) });
    await waitFor(rows => active(rows).length === 1 && status(rows, ids[1]) === 'queued'
      && status(rows, ids[2]) === 'queued' && status(rows, magnet.id) === 'queued', 'adds must honor the cap, including magnets');
    console.log('PASS adds: one active, two files and metadata-less magnet queued');
    await manager.resumeDownload(ids[1]);
    await manager.tick(); assert.equal(status(manager.getStats(), ids[1]), 'queued');
    await manager.pauseDownload(ids[0]);
    await waitFor(rows => status(rows, ids[0]) === 'paused' && status(rows, ids[1]) === 'downloading'
      && active(rows).length === 1, 'pause must free a slot for the next download');
    await manager.resumeAllPaused();
    await manager.retryDownload(ids[0]);
    await waitFor(rows => active(rows).length === 1 && status(rows, ids[0]) === 'queued', 'resume/retry must respect the queue');
    console.log('PASS pause, resume-all and retry: queue promotes without exceeding cap');
    await manager.updateSettings({ maxActiveDownloads: 2 });
    await waitFor(rows => active(rows).length === 2, 'raising the cap must promote a queued download');
    await manager.updateSettings({ maxActiveDownloads: 1 });
    await waitFor(rows => active(rows).length === 1, 'lowering the cap must requeue excess downloads');
    console.log('PASS live limit changes: 1 -> 2 -> 1 active download');
    await manager.getStreamUrl(ids[2], 0);
    await waitFor(rows => active(rows).length === 1 && status(rows, ids[2]) === 'downloading', 'playback must keep its slot');
    await manager.stopStream(ids[2], 0);
    console.log('PASS playback: queued media starts and background downloads yield its slot');
    await manager.pauseDownload(ids[1]);
    await manager.destroy(); manager = null;
    await initialize();
    await waitFor(rows => active(rows).length === 1 && status(rows, ids[1]) === 'paused', 'restart must preserve paused intent and active limit');
    console.log('PASS restart: paused record stays paused, active/queued records restore within cap');
    for (const id of ids) assert.equal(records.get(id).totalSize, 64 * 1024, 'metadata size survives pause and restart');
    assert.equal(records.get(magnet.id).totalSize, 0, 'a metadata-less magnet has no guessed size');
    await manager.pauseAllActive();
    await manager.resumeDownload(ids[1]);
    await waitFor(rows => status(rows, ids[1]) === 'downloading', 'the paused torrent must resume after restart');
    assert.equal(records.get(ids[1]).totalSize, 64 * 1024, 'resuming cannot change the torrent size');
    console.log('PASS metadata size: preserved through pause/restart/resume, unknown magnet stays unknown');
  } finally {
    if (manager) await manager.destroy();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert(path.basename(root).startsWith('havvn-native-queue-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });