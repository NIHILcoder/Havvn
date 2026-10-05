import { expect, it } from 'vitest';
import WebTorrent from 'webtorrent';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Torrent } from 'webtorrent';
import { EpisodePrefetcher, type PrefetchTorrent } from './episode-prefetch';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
it('downloads only a bounded next-file head over real loopback peers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-prefetch-'));
  // This fixture connects TCP peers explicitly; native UDP is unrelated and can be denied on CI.
  const quiet = { dht: false, tracker: false, lsd: false, webSeeds: false, natUpnp: false, natPmp: false, utp: false };
  const seeder = new WebTorrent({ ...quiet, uploadLimit: 1024 * 1024 });
  const leecher = new WebTorrent(quiet);
  const prefetch = new EpisodePrefetcher();
  try {
    for (const name of ['episode1.webm', 'episode2.webm']) fs.writeFileSync(path.join(dir, name), crypto.randomBytes(4 * 1024 * 1024));
    const seeded = await new Promise<Torrent>(resolve => seeder.seed([path.join(dir, 'episode1.webm'), path.join(dir, 'episode2.webm')], { name: 'series', announce: [], pieceLength: 256 * 1024 }, resolve));
    const torrent = await new Promise<Torrent>(resolve => leecher.add(seeded.torrentFile, { path: path.join(dir, 'download'), announce: [] }, resolve));
    torrent.files.forEach(file => file.deselect());
    const internal = torrent as unknown as PrefetchTorrent;
    internal._select(0, 3, 1, () => {}, true);
    const currentSelection = internal._selections._items[0];
    const file = torrent.files[1];
    prefetch.start('test', 'owner-test', internal, 1, file.offset, file.length, 1024 * 1024);
    expect(internal._selections._items).toContain(currentSelection);
    torrent.addPeer('127.0.0.1:' + seeder.torrentPort);
    const deadline = Date.now() + 20000;
    let state;
    do {
      await sleep(250);
      state = prefetch.start('test', 'owner-test', internal, 1, file.offset, file.length, 1024 * 1024);
    } while (state.state !== 'ready' && Date.now() < deadline);
    expect(state.state).toBe('ready');
    await sleep(1500);
    expect(file.downloaded).toBe(1024 * 1024);
    expect(torrent.files[0].downloaded).toBe(1024 * 1024);
    expect(file.progress).toBeLessThan(1);
    expect(internal._selections._items.length).toBe(0);
  } finally {
    prefetch.clear();
    await new Promise<void>(resolve => leecher.destroy(() => resolve()));
    await new Promise<void>(resolve => seeder.destroy(() => resolve()));
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(dir)).toMatch(/^havvn-prefetch-/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
