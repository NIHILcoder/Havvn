import { expect, it, vi } from 'vitest';
import WebTorrent, { type Torrent } from 'webtorrent';
import { Server as TrackerServer } from 'bittorrent-tracker';
import FSChunkStore from 'fs-chunk-store';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppSettings, Download } from '../../shared/types';
import { TransmissionSidecar } from './native/transmission-sidecar';
import { NativeTorrentManager } from './native/native-manager';
import { TorrentManager } from './manager';
import { downloadPieceCache } from './piece-cache';

vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('./host/env', () => ({ getHostEnv: () => ({ isPackaged: false }) }));
vi.mock('./host/db-bridge', () => ({
  updateDownloadStatus: vi.fn().mockResolvedValue(undefined), updateDownloadField: vi.fn().mockResolvedValue(undefined),
  updateDownloadFields: vi.fn().mockResolvedValue(undefined), updateDownloadProgress: vi.fn().mockResolvedValue(undefined),
  updateDownloadsProgressBatch: vi.fn().mockResolvedValue(undefined), getDownloadsByStatus: vi.fn().mockResolvedValue([]),
  getSettings: vi.fn().mockResolvedValue({ autoMoveCompleted: false }),
}));

const binary = path.resolve('vendor/transmission', process.platform === 'win32' ? 'win32-x64/transmission-daemon.exe' : 'linux-x64/transmission-daemon');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quiet = { dht: false, tracker: true, lsd: false, webSeeds: false, natUpnp: false, natPmp: false, utp: false };

for (const engine of ['native', 'webtorrent'] as const) for (const sequential of [false, true]) {
  it.skipIf(engine === 'native' && !fs.existsSync(binary))(`${engine}: multi-file progress reaches 100%, sequential=${sequential}, including pause/resume`, async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-progress-loopback-'));
    const tracker = new TrackerServer({ udp: false, ws: false, http: true, stats: false, interval: 1000 });
    const seeder = new WebTorrent({ ...quiet, uploadLimit: 1024 * 1024 });
    let leecher: WebTorrent | undefined, sidecar: TransmissionSidecar | undefined;
    let native: NativeTorrentManager | undefined, classic: TorrentManager | undefined;
    try {
      await new Promise<void>(resolve => tracker.listen(0, '127.0.0.1', resolve));
      const announce = 'http://127.0.0.1:' + tracker.http.address().port + '/announce';
      const P = 1024 * 1024;
      const lengths = [P + 500_000, 61, 2 * P - 500_061, 2 * P + 123];
      const names = ['00-prefix.bin', '01-autorun.inf', '02-boundary.bin', '03-tail.bin'];
      const expected = new Map<string, Buffer>();
      fs.mkdirSync(path.join(root, 'source'));
      names.forEach((name, i) => {
        const bytes = crypto.randomBytes(lengths[i]); expected.set(name, bytes);
        fs.writeFileSync(path.join(root, 'source', name), bytes);
      });
      const seeded = await new Promise<Torrent>(resolve => seeder.seed(names.map(name => path.join(root, 'source', name)),
        { name: 'progress-fixture', announce: [announce], pieceLength: P }, resolve));
      const source = path.join(root, 'fixture.torrent'); fs.writeFileSync(source, seeded.torrentFile);
      const destination = path.join(root, 'download'); fs.mkdirSync(destination);
      const download: Download = { id: 'test', name: 'progress-fixture', sourceType: 'torrent_file', sourceUri: source,
        torrentFilePath: source, infoHash: seeded.infoHash, savePath: destination, status: 'downloading',
        progress: 0, downloadedBytes: 0, uploadedBytes: 0, downSpeedBps: 0, upSpeedBps: 0, etaSeconds: null,
        peers: 0, seeds: 0, totalSize: seeded.length, priority: 1, category: null, sequentialDownload: sequential,
        createdAt: new Date(), updatedAt: new Date(), lastError: null };
      let files: () => ReturnType<TorrentManager['getFiles']>, stats: () => ReturnType<TorrentManager['getStats']>;
      let tick: () => Promise<void>, stop: () => Promise<void>, resume: () => Promise<void>;
      const completed = vi.fn();
      const trace: unknown[] = [];
      if (engine === 'native') {
        sidecar = new TransmissionSidecar({ binaryPath: binary, configDir: path.join(root, 'daemon'), downloadDir: destination,
          settingsOverrides: { 'dht-enabled': false, 'pex-enabled': false, 'lpd-enabled': false, 'utp-enabled': false,
            'port-forwarding-enabled': false, 'bind-address-ipv4': '127.0.0.1', 'bind-address-ipv6': '::1', 'preallocation': 0 } });
        const rpc = await sidecar.start();
        for (const method of ['torrentStart', 'torrentStop'] as const) {
          const original = rpc[method].bind(rpc);
          rpc[method] = async ids => {
            await original(ids);
            trace.push({ action: method, at: Date.now(), state: await rpc.torrentGet(['status', 'percentDone', 'error', 'errorString', 'isFinished'], ids) });
          };
        }
        const added = await rpc.torrentAdd({ metainfo: Buffer.from(seeded.torrentFile), paused: true, downloadDir: destination });
        native = new NativeTorrentManager();
        // Real manager lifecycle and RPC; only app DB ownership is an in-memory seam.
        const state = native as unknown as { records: Map<string, Download>; idToHash: Map<string, string>; hashToId: Map<string, string>; tick(): Promise<void> };
        Object.assign(native, { ready: Promise.resolve(), rpc, settings: { maxActiveDownloads: 3 } as AppSettings });
        state.records.set('test', download); state.idToHash.set('test', added.hashString); state.hashToId.set(added.hashString, 'test');
        await native.setSequentialDownload('test', sequential); native.onComplete(completed);
        await rpc.torrentStart(added.hashString);
        seeded.addPeer('127.0.0.1:' + sidecar.peerPort);
        files = () => native!.getFiles('test'); stats = () => native!.getStats(); tick = () => state.tick();
        stop = () => native!.pauseDownload('test');
        resume = async () => { await native!.resumeDownload('test'); seeded.addPeer('127.0.0.1:' + sidecar!.peerPort); };
      } else {
        leecher = new WebTorrent(quiet); classic = new TorrentManager();
        const state = classic as unknown as { managedTorrents: Map<string, unknown>; addTorrentInternal(id: string, source: string, destination: string, isNew: boolean): Promise<void> };
        Object.assign(classic, { client: leecher, initDone: Promise.resolve(), cachedStore: downloadPieceCache.store(FSChunkStore) });
        state.managedTorrents.set('test', { id: 'test', download, torrent: null, infoHash: seeded.infoHash });
        classic.onComplete(completed);
        await state.addTorrentInternal('test', source, destination, true);
        files = () => classic!.getFiles('test'); stats = () => classic!.getStats(); tick = async () => {};
        stop = () => classic!.pauseDownload('test'); resume = () => classic!.resumeDownload('test');
      }
      let didPause = false, partial = false, previous = 0;
      const deadline = Date.now() + 50_000;
      while (Date.now() < deadline) {
        await tick();
        const snapshot = await files(), current = stats()[0];
        for (const file of snapshot) {
          expect(Number.isFinite(file.progress)).toBe(true);
          expect(file.downloaded).toBeGreaterThanOrEqual(0); expect(file.downloaded).toBeLessThanOrEqual(file.length);
          expect(file.progress).toBe(file.length ? file.downloaded / file.length : 1);
        }
        expect(current.progress).toBeGreaterThanOrEqual(previous - 0.00001); previous = current.progress;
        partial ||= current.progress > 0 && current.progress < 1;
        if (!didPause && current.progress > 0.2 && current.progress < 0.8) {
          await stop(); await tick(); expect(download.status).toBe('paused');
          await resume(); didPause = true;
        }
        if (download.status === 'seeding') break;
        await pause(150);
      }
      expect(partial).toBe(true); expect(didPause).toBe(true);
      if (download.status !== 'seeding') {
        fs.mkdirSync('dist/download-progress', { recursive: true });
        fs.writeFileSync('dist/download-progress/native-trace-' + sequential + '.json', JSON.stringify({ stats: stats(), trace }, null, 2));
      }
      expect(download.status, JSON.stringify({ stats: stats(), trace })).toBe('seeding'); expect(stats()[0].progress).toBe(1); expect(completed).toHaveBeenCalledOnce();
      for (const file of await files()) {
        expect(file.progress).toBe(1); expect(file.downloaded).toBe(file.length);
        expect(fs.readFileSync(path.join(destination, file.path))).toEqual(expected.get(file.name));
      }
    } finally {
      await native?.destroy(); await sidecar?.stop();
      if (leecher) await new Promise<void>(resolve => leecher!.destroy(() => resolve()));
      await new Promise<void>(resolve => seeder.destroy(() => resolve()));
      await new Promise<void>(resolve => tracker.close(() => resolve()));
      expect(path.dirname(root)).toBe(fs.realpathSync(os.tmpdir())); expect(path.basename(root)).toMatch(/^havvn-progress-loopback-/);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 70000);
}
