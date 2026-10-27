/* eslint-disable @typescript-eslint/no-require-imports -- Isolated bundled-daemon research, not a production prefetch implementation. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), http = require('node:http'), assert = require('node:assert/strict');
const { TransmissionSidecar } = require('../dist/electron/electron/torrent/native/transmission-sidecar.js');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'artifacts/fun03/native-probe.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-native-prefetch-probe-'));
  const piece = 256 * 1024, length = 4 * 1024 * 1024, budget = 1024 * 1024;
  const files = ['episode1.bin', 'episode2.bin'].map(name => path.join(directory, name));
  for (const file of files) fs.writeFileSync(file, crypto.randomBytes(length));
  const report = { startedAt: new Date().toISOString(), passed: false, prototypeOnly: true, releaseNativePrefetch: false,
    transport: 'localhost HTTP web seed', pieceBytes: piece, requestedHeadBudget: budget, fileBytes: length, checks: [], samples: [],
    binarySha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'vendor/transmission/win32-x64/transmission-daemon.exe'))).digest('hex'),
    limitation: 'File priorities and a single sequential cursor do not expose an independent bounded prefetch range.' };
  const save = () => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); };
  const check = id => { report.checks.push({ id, passed: true }); save(); };
  const server = http.createServer((req, res) => {
    const basename = decodeURIComponent((req.url || '').split('?')[0]).split('/').pop();
    const source = files.find(file => path.basename(file) === basename);
    if (!source) { res.writeHead(404); res.end(); return; }
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), length - 1) : length - 1;
    if (start > end || start >= length) { res.writeHead(416); res.end(); return; }
    res.writeHead(match ? 206 : 200, { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${length}` } : {}) });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(source, { start, end, highWaterMark: 16 * 1024 });
    let timer;
    stream.on('data', chunk => { stream.pause(); res.write(chunk); timer = setTimeout(() => stream.resume(), 12); });
    stream.on('end', () => res.end()); stream.on('error', () => res.destroy());
    res.on('close', () => { clearTimeout(timer); stream.destroy(); });
  });
  let sidecar;
  try {
    save(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const create = (await import('create-torrent')).default;
    const metainfo = await new Promise((resolve, reject) => create(files, { name: 'series', pieceLength: piece, announceList: [],
      urlList: [`http://127.0.0.1:${server.address().port}/`] }, (error, bytes) => error ? reject(error) : resolve(bytes)));
    sidecar = new TransmissionSidecar({ binaryPath: path.join(root, 'vendor/transmission/win32-x64/transmission-daemon.exe'),
      configDir: path.join(directory, 'daemon'), downloadDir: path.join(directory, 'download'),
      settingsOverrides: { 'dht-enabled': false, 'pex-enabled': false, 'lpd-enabled': false, 'port-forwarding-enabled': false,
        'bind-address-ipv4': '127.0.0.1', 'bind-address-ipv6': '::1', 'speed-limit-down-enabled': true, 'speed-limit-down': 1024 } });
    const rpc = await sidecar.start(), session = await rpc.sessionGet();
    report.version = session.version; report.rpcVersion = session['rpc-version'];
    const torrent = await rpc.torrentAdd({ metainfo: Buffer.from(metainfo), paused: true, filesUnwanted: [1] });
    await rpc.torrentSet(torrent.hashString, { 'priority-high': [0], 'priority-low': [1], sequential_download: true, sequential_download_from_piece: 0 });
    const sample = async () => {
      const [t] = await rpc.torrentGet(['files', 'fileStats', 'status', 'sequential_download', 'sequential_download_from_piece', 'error'], torrent.hashString);
      assert.equal(t.error, 0);
      return { at: new Date().toISOString(), current: t.files?.[0]?.bytesCompleted ?? 0, next: t.files?.[1]?.bytesCompleted ?? 0,
        wanted: t.fileStats?.map(file => file.wanted), priorities: t.fileStats?.map(file => file.priority), cursor: t.sequential_download_from_piece, status: t.status };
    };
    const until = async (predicate, name, timeout = 30000) => {
      const end = Date.now() + timeout;
      do { const state = await sample(); report.samples.push(state); if (predicate(state)) { save(); return state; } await sleep(250); } while (Date.now() < end);
      throw Error('Prototype timeout: ' + name);
    };
    await rpc.torrentStartNow(torrent.hashString);
    const baseline = await until(state => state.current >= length, 'current file');
    assert.equal(baseline.next, 0); check('excluded-next-file-remains-unwanted-during-current-transfer');
    const nextBegin = length / piece;
    await rpc.torrentSet(torrent.hashString, { 'files-wanted': [1], sequential_download_from_piece: nextBegin });
    const over = await until(state => state.next > budget, 'whole-file selection exceeds a head budget');
    assert(over.next > budget); assert.equal(over.priorities[0], 1); assert.equal(over.priorities[1], -1);
    report.observedNextBytesBeyondBudget = over.next; check('low-priority-whole-file-selection-is-not-a-byte-budget');
    await rpc.torrentSet(torrent.hashString, { 'files-unwanted': [1] });
    assert.equal((await sample()).wanted[1], false); check('cancel-restores-exclusion-without-pausing-torrent');
    await rpc.torrentSet(torrent.hashString, { sequential_download_from_piece: 0 });
    assert.equal((await sample()).cursor, 0);
    await rpc.torrentSet(torrent.hashString, { sequential_download_from_piece: nextBegin });
    assert.equal((await sample()).cursor, nextBegin);
    await rpc.torrentSet(torrent.hashString, { sequential_download_from_piece: 0 });
    assert.equal((await sample()).cursor, 0); check('sequential-start-is-one-shared-torrent-cursor');
    report.conclusion = 'Existing RPC controls are insufficient for the required isolated bounded head selection. Native remains unsupported; no production polling workaround is enabled.';
    report.passed = true; report.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify({ passed: true, version: report.version, nextBytes: over.next, budget, releaseNativePrefetch: false }));
  } catch (error) { report.error = String(error); save(); throw error; }
  finally {
    if (sidecar) await sidecar.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('havvn-native-prefetch-probe-')) { console.error('Unexpected probe directory; cleanup skipped'); process.exitCode = 1; }
    else fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
