// Isolated bundled-daemon test: local web seed, no public swarm or user profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { TransmissionSidecar } = require('../dist/electron/electron/torrent/native/transmission-sidecar.js');
const { TrStatus } = require('../dist/electron/electron/torrent/native/transmission-rpc.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-speed-limit-'));
  const source = path.join(dir, 'sample.bin');
  const size = 64 * 1024 * 1024;
  fs.writeFileSync(source, Buffer.alloc(size, 37));
  const server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : size - 1;
    res.writeHead(range ? 206 : 200, {
      'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    const stream = fs.createReadStream(source, { start, end, highWaterMark: 32 * 1024 });
    stream.on('data', chunk => { stream.pause(); res.write(chunk); setTimeout(() => stream.resume(), 50); });
    stream.on('end', () => res.end());
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
  });
  let sidecar;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const createTorrent = (await import('create-torrent')).default;
    const metainfo = await new Promise((resolve, reject) => createTorrent(source, {
      announceList: [], urlList: [`http://127.0.0.1:${server.address().port}/sample.bin`], pieceLength: 256 * 1024,
    }, (error, result) => error ? reject(error) : resolve(result)));
    sidecar = new TransmissionSidecar({
      binaryPath: path.resolve('vendor/transmission/win32-x64/transmission-daemon.exe'),
      configDir: path.join(dir, 'engine'), downloadDir: path.join(dir, 'download'),
      settingsOverrides: { 'dht-enabled': false, 'pex-enabled': false, 'lpd-enabled': false,
        'port-forwarding-enabled': false, 'speed-limit-down-enabled': true, 'speed-limit-down': 256 },
    });
    const rpc = await sidecar.start();
    const added = await rpc.torrentAdd({ metainfo: Buffer.from(metainfo).toString('base64') });
    const snapshot = async () => (await rpc.torrentGet(['status', 'downloadedEver', 'percentDone', 'error'], added.hashString))[0];
    const deadline = Date.now() + 30000;
    let sample;
    do { await sleep(500); sample = await snapshot(); } while (!sample.downloadedEver && Date.now() < deadline);
    assert(sample.downloadedEver > 0, 'local web seed must transfer bytes');
    for (const cap of [10000, 0, 256, 10000]) {
      const before = (await snapshot()).downloadedEver;
      await rpc.sessionSet({ 'speed-limit-down-enabled': cap > 0, ...(cap ? { 'speed-limit-down': cap } : {}) });
      const session = await rpc.sessionGet();
      assert.equal(session['speed-limit-down-enabled'], cap > 0);
      if (cap) assert.equal(session['speed-limit-down'], cap);
      for (let tick = 0; tick < 8; tick++) {
        await sleep(500);
        sample = await snapshot();
        assert.equal(sample.status, TrStatus.Downloading, 'changing cap must not stop active torrent');
        assert.equal(sample.error, 0);
      }
      assert(sample.downloadedEver > before, 'bytes must keep arriving after changing cap');
      console.log(`PASS cap=${cap} KB/s: still downloading, bytes increased`);
    }
  } finally {
    if (sidecar) await sidecar.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // Only the exact temporary directory created by this test is removed.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
