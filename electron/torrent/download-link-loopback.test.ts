import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import WebTorrent, { type Torrent } from 'webtorrent';
import type { AppSettings, Download } from '../../shared/types';
import type { HostEnv } from './host/env';
import { parseDownloadLink } from '../../shared/download-link';
import { TransmissionSidecar } from './native/transmission-sidecar';
import { NativeTorrentManager } from './native/native-manager';

const H = vi.hoisted(() => ({ env: {} as HostEnv, records: {} as Record<string, Download>, seq: 0 }));
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('./host/env', () => ({ getHostEnv: () => H.env }));
vi.mock('./host/db-bridge', () => ({
  createDownload: vi.fn(async params => {
    const record = { id: 'link-' + ++H.seq, progress: 0, totalSize: 0, downloadedBytes: 0, uploadedBytes: 0,
      downSpeedBps: 0, upSpeedBps: 0, peers: 0, seeds: 0, priority: 1, category: null, createdAt: new Date(), updatedAt: new Date(), lastError: null, ...params } as Download;
    H.records[record.id] = record; return record;
  }),
  getSettings: vi.fn(async () => ({ autoMoveCompleted: false })),
  getAllDownloads: vi.fn(async () => Object.values(H.records)),
  getDownloadsByStatus: vi.fn(async status => Object.values(H.records).filter(d => d.status === status)),
  updateDownloadField: vi.fn(async (id, key, value) => { Object.assign(H.records[id], { [key]: value }); }),
  updateDownloadFields: vi.fn(async (id, fields) => { Object.assign(H.records[id], fields); }),
  updateDownloadStatus: vi.fn(async (id, status, lastError = null) => { Object.assign(H.records[id], { status, lastError }); }),
  updateDownloadProgress: vi.fn(async (id, fields) => { Object.assign(H.records[id], fields); }),
  updateDownloadsProgressBatch: vi.fn(async () => {}),
}));
const binary = path.resolve('vendor/transmission', process.platform === 'win32' ? 'win32-x64/transmission-daemon.exe' : 'linux-x64/transmission-daemon');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (const sequentialDownload of [false, true]) {
  it.skipIf(!fs.existsSync(binary))(`magnet preview then actual Native download succeeds without a resume, sequential=${sequentialDownload}`, async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-download-link-'));
    const seeder = new WebTorrent({ dht: false, tracker: false, lsd: false, webSeeds: false, natUpnp: false, natPmp: false, utp: false });
    let manager: NativeTorrentManager | undefined, sidecar: TransmissionSidecar | undefined;
    let connect: ReturnType<typeof setInterval> | undefined;
    const server = http.createServer();
    try {
      H.records = {}; H.seq = 0;
      const destination = path.join(root, 'downloads'), source = path.join(root, 'fixture.bin');
      fs.mkdirSync(destination); const bytes = crypto.randomBytes(512 * 1024 + 123); fs.writeFileSync(source, bytes);
      const seeded = await new Promise<Torrent>(resolve => seeder.seed(source, { announce: [], pieceLength: 32 * 1024 }, resolve));
      server.on('request', (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/x-bittorrent' }); response.end(seeded.torrentFile); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const torrentUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/download?id=1`;
      H.env = { isPackaged: false, tempDir: root, userDataDir: path.join(root, 'profile'), engineStateDir: path.join(root, 'daemon'), downloadsDir: destination } as HostEnv;
      sidecar = new TransmissionSidecar({ binaryPath: binary, configDir: H.env.engineStateDir, downloadDir: destination,
        settingsOverrides: { 'dht-enabled': false, 'pex-enabled': false, 'lpd-enabled': false, 'utp-enabled': false, 'port-forwarding-enabled': false,
          'bind-address-ipv4': '127.0.0.1', 'bind-address-ipv6': '::1', preallocation: 0 } });
      const rpc = await sidecar.start();
      manager = new NativeTorrentManager();
      Object.assign(manager, { ready: Promise.resolve(), rpc, settings: { maxActiveDownloads: 3, defaultSeedRatioLimit: 0, enableDHT: false,
        enablePEX: false, enableLSD: false, enableUtp: false } as AppSettings });
      const state = manager as any;
      await manager.updateSettings({ maxUpKbps: 128, maxDownKbps: 0, altSpeedEnabled: false });
      expect(await rpc.sessionGet()).toMatchObject({ 'speed-limit-up-enabled': true, 'speed-limit-up': 128, 'alt-speed-enabled': false });
      await manager.updateSettings({ altSpeedEnabled: true, altUpKbps: 64 });
      expect(await rpc.sessionGet()).toMatchObject({ 'speed-limit-up-enabled': true, 'speed-limit-up': 64, 'alt-speed-enabled': false });
      await manager.updateSettings({ altSpeedEnabled: false });
      const urlLink = parseDownloadLink(torrentUrl)!;
      expect(urlLink.sourceType).toBe('torrent_file');
      expect(await manager.getTorrentInfo({ torrentPath: urlLink.sourceUri })).toMatchObject({ name: 'fixture.bin', totalSize: bytes.length });
      const link = parseDownloadLink(`magnet:?xt=urn:btih:${seeded.infoHash}&dn=Fixture`)!;
      // Only explicit localhost peers are available; no trackers or DHT.
      connect = setInterval(() => seeded.addPeer('127.0.0.1:' + sidecar!.peerPort), 250);
      const info = await manager.getTorrentInfo({ magnetUri: link.sourceUri });
      expect(info).toMatchObject({ name: 'fixture.bin', totalSize: bytes.length }); expect(info.files).toHaveLength(1);
      expect(await rpc.torrentGet(['hashString'], seeded.infoHash)).toEqual([]); // preview was removed
      const download = await manager.addDownload({ ...link, savePath: destination, selectedFiles: [0], sequentialDownload });
      expect(download.status).toBe('queued'); expect(download.lastError).toBeNull();
      const deadline = Date.now() + 25_000;
      let done = false;
      while (Date.now() < deadline) {
        await state.tick();
        const [live] = await rpc.torrentGet(['percentDone', 'error', 'errorString'], seeded.infoHash);
        if (live?.percentDone === 1) { done = true; break; }
        await wait(150);
      }
      expect(done, JSON.stringify(manager.getStats())).toBe(true);
      expect(fs.readFileSync(path.join(destination, 'fixture.bin'))).toEqual(bytes);
      await manager.setSequentialDownload(download.id, !sequentialDownload);
      expect((await rpc.torrentGet(['sequential_download_from_piece'], seeded.infoHash))[0]).toMatchObject({ sequential_download_from_piece: 0 });
    } finally {
      if (connect) clearInterval(connect);
      await manager?.destroy(); await sidecar?.stop();
      await new Promise<void>(resolve => seeder.destroy(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      expect(path.dirname(root)).toBe(fs.realpathSync(os.tmpdir())); expect(path.basename(root)).toMatch(/^havvn-download-link-/);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
}
