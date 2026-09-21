import { clearSelections, hasNoSelections } from './selections';
/**
 * Exercise the production halt sequence against real WebTorrent loopback peers.
 * Repeated file selections must not prevent pausing: bytes stop after clearing
 * selections and resume when files are selected again.
 */
import { describe, it, expect, afterAll } from 'vitest';
import WebTorrent from 'webtorrent';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-pause-test-'));
const seedDir = path.join(dir, 'seed');
const dlDir = path.join(dir, 'dl');
fs.mkdirSync(seedDir);
fs.mkdirSync(dlDir);

// Multi-file torrent (the case that was broken in the wild): 2 x 16MB.
for (const name of ['a.bin', 'b.bin']) {
  const fd = fs.openSync(path.join(seedDir, name), 'w');
  for (let i = 0; i < 4; i++) fs.writeSync(fd, crypto.randomBytes(4 * 1024 * 1024));
  fs.closeSync(fd);
}

const quiet = { dht: false, tracker: false, lsd: false, webSeeds: false, natUpnp: false, natPmp: false } as any;
// Throttle the seeder so the download is slow enough to observe stop/start.
const seeder = new WebTorrent({ ...quiet, uploadLimit: 2 * 1024 * 1024 } as any);
const leecher = new WebTorrent({ ...quiet } as any);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
  await new Promise<void>((r) => leecher.destroy(() => r()));
  await new Promise<void>((r) => seeder.destroy(() => r()));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('pause mechanism (real loopback wires)', () => {
  it('halting selections stops the download; resume restarts it', async () => {
    const seedTorrent: any = await new Promise((resolve) =>
      seeder.seed([path.join(seedDir, 'a.bin'), path.join(seedDir, 'b.bin')],
        { name: 'pausetest', announce: [] } as any, resolve),
    );
    const port = (seeder as any).torrentPort;

    const t: any = await new Promise((resolve) =>
      leecher.add(seedTorrent.torrentFile, { path: dlDir, announce: [] } as any, resolve),
    );
    t.addPeer('127.0.0.1:' + port);

    // Reproduce the app's real selection pile-up: ready-handler select +
    // stream-open select + an extra high-priority stream-head range.
    t.files.forEach((f: any) => f.select());
    t.files[0].select();
    t.select(t.files[0]._startPiece, Math.min(t.files[0]._startPiece + 40, t.pieces.length - 1), 10);

    // Wait until bytes actually flow.
    const started = Date.now();
    while (t.received < 512 * 1024) {
      if (Date.now() - started > 30000) throw new Error('no data flowing — loopback setup broken');
      await sleep(200);
    }

    // Verify the application's halt sequence, independent of whether a library
    // version deduplicates repeated selections internally.
    expect(hasNoSelections(t._selections)).toBe(false);

    // Fact 2: the halt sequence used by manager.haltTorrent stops the flow.
    try { t.pause(); } catch { /* ignore */ }
    clearSelections(t._selections);
    t._critical = [];
    t._updateInterest();
    await sleep(1200); // let in-flight piece requests land
    const afterHalt = t.received;
    await sleep(3000);
    const grewWhilePaused = t.received - afterHalt;
    expect(grewWhilePaused).toBeLessThan(256 * 1024);

    // Fact 3: resume + re-select restarts the download.
    try { t.resume(); } catch { /* ignore */ }
    t.files.forEach((f: any) => f.select());
    const beforeResume = t.received;
    await sleep(3500);
    expect(t.received - beforeResume).toBeGreaterThan(512 * 1024);
  }, 90000);
});
