// Real daemon -> verified disk pieces -> HTTP Range -> FFmpeg decoder.
// Only a private local web seed and a fresh temporary daemon profile are used.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { TransmissionSidecar } = require('../dist/electron/electron/torrent/native/transmission-sidecar.js');
const { VerifiedDiskMedia, hasPiece } = require('../dist/electron/electron/torrent/verified-media.js');
const { ExternalStream } = require('../dist/electron/electron/services/external-stream.js');
const ffmpeg = require('ffmpeg-static');
async function decode(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-ss', '2', '-i', input, '-t', '1', '-map', '0:v', '-f', 'framemd5', '-'], { windowsHide: true });
    let output = '', errors = ''; const timer = setTimeout(() => { child.kill(); reject(Error('Decoder timeout: ' + errors)); }, 35000);
    child.stdout.on('data', d => output += d); child.stderr.on('data', d => errors += d);
    child.on('error', e => { clearTimeout(timer); reject(e); }); child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(Error(errors)); });
  });
}
async function main() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-external-stream-'));
  let sidecar, stream; const source = path.join(root, 'Фильм с пробелами.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=10', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '1500k', '-c:a', 'aac', '-movflags', '+faststart', source], { windowsHide: true, timeout: 20000 });
  // A valid MP4 free box keeps the torrent incomplete while its first video frames play.
  const free = Buffer.alloc(16 * 1024 * 1024); free.writeUInt32BE(free.length, 0); free.write('free', 4); fs.appendFileSync(source, free);
  const size = fs.statSync(source).size;
  const seed = http.createServer((req, res) => {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : size - 1;
    res.writeHead(range ? 206 : 200, { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    const file = fs.createReadStream(source, { start, end, highWaterMark: 64 * 1024 });
    file.on('data', chunk => { file.pause(); res.write(chunk); setTimeout(() => file.resume(), 30); }); file.on('end', () => res.end()); file.on('error', () => res.destroy()); res.on('close', () => file.destroy());
  });
  try {
    await new Promise(r => seed.listen(0, '127.0.0.1', r));
    const createTorrent = (await import('create-torrent')).default;
    const torrent = await new Promise((resolve, reject) => createTorrent(source, { announceList: [], urlList: [`http://127.0.0.1:${seed.address().port}/media`], pieceLength: 256 * 1024 }, (e, t) => e ? reject(e) : resolve(t)));
    const torrentFile = path.join(root, 'source.torrent'); fs.writeFileSync(torrentFile, torrent);
    sidecar = new TransmissionSidecar({ binaryPath: path.resolve('vendor/transmission/win32-x64/transmission-daemon.exe'), configDir: path.join(root, 'engine'), downloadDir: path.join(root, 'download'),
      settingsOverrides: { 'dht-enabled': false, 'pex-enabled': false, 'lpd-enabled': false, 'port-forwarding-enabled': false, 'cache-size-mb': 1, 'speed-limit-down-enabled': true, 'speed-limit-down': 512 } });
    const rpc = await sidecar.start(), added = await rpc.torrentAdd({ metainfo: Buffer.from(torrent), downloadDir: path.join(root, 'download'), paused: false });
    await rpc.torrentSet(added.hashString, { sequential_download: true });
    const reader = new VerifiedDiskMedia(), meta = reader.load(added.hashString, torrentFile, root); assert(meta);
    let waits = 0, readCalls = 0;
    stream = new ExternalStream(size, async (start, max) => {
      readCalls++; const [t] = await rpc.torrentGet(['status', 'pieces'], added.hashString);
      if (t.status !== 4 && t.status !== 6) return { reason: 'paused-file' };
      if (!hasPiece(t.pieces, Math.floor(start / meta.pieceLength))) { waits++; return { wait: true }; }
      const data = await reader.read(meta, path.join(root, 'download'), 0, start, max);
      if (!data) { waits++; return { wait: true }; } return { data: data.toString('base64') };
    }, () => stream.close());
    const url = await stream.url();
    const expected = await decode(source), actual = await decode(url);
    assert.deepEqual(actual, expected, 'The sought frames must match the original exactly');
    const [t] = await rpc.torrentGet(['percentDone', 'status'], added.hashString); assert(t.percentDone > 0 && t.percentDone < 1); assert.equal(t.status, 4);
    assert(waits > 0, 'Playback must have waited for missing or unflushed pieces'); assert(readCalls > 1);
    stream.close(); await assert.rejects(fetch(url));
    console.log(`PASS real native partial torrent: ${Math.round(t.percentDone * 100)}% downloaded, waited ${waits} times, exact video frames after seek, stream revoked; temporary fixture: ${root}`);
  } finally {
    stream?.close(); if (sidecar) await sidecar.stop(); seed.closeAllConnections(); await new Promise(r => seed.close(r));
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert(path.basename(root).startsWith('havvn-external-stream-')); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
