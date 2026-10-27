import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebTorrent, { type Torrent } from 'webtorrent';
import FSChunkStore from 'fs-chunk-store';
import type { AppSettings, Download } from '../../shared/types';
import type { HostEnv } from './host/env';
import { createTorrentFile } from './creator';
import { prepareSeed } from './seed-metadata';
import { TorrentManager } from './manager';
import { NativeTorrentManager } from './native/native-manager';
import { TransmissionSidecar } from './native/transmission-sidecar';
import { downloadPieceCache } from './piece-cache';

const mocks = vi.hoisted(() => ({ records: {} as Record<string, Download>, env: {} as HostEnv }));
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('./host/env', () => ({ getHostEnv: () => mocks.env }));
vi.mock('./host/db-bridge', () => ({
  getDownloadById: vi.fn(async (id: string) => structuredClone(mocks.records[id] ?? null)),
  getDownloadsByStatus: vi.fn(async (status: string) => Object.values(mocks.records).filter(d => d.status === status)),
  getSettings: vi.fn(async () => ({ autoMoveCompleted: false })),
  createDownload: vi.fn(async (fields: Partial<Download>) => {
    const id = crypto.randomUUID();
    const record = { id, progress: 0, totalSize: 0, downloadedBytes: 0, uploadedBytes: 0, downSpeedBps: 0, upSpeedBps: 0,
      etaSeconds: null, peers: 0, seeds: 0, priority: 1, category: null, createdAt: new Date(), updatedAt: new Date(), lastError: null, ...fields } as Download;
    mocks.records[id] = structuredClone(record); return record;
  }),
  deleteDownload: vi.fn(async (id: string) => { delete mocks.records[id]; }),
  updateDownloadStatus: vi.fn(async (id: string, status: Download['status'], lastError: string | null = null) => { Object.assign(mocks.records[id], { status, lastError }); }),
  updateDownloadField: vi.fn(async (id: string, field: string, value: unknown) => { Object.assign(mocks.records[id], { [field]: value }); }),
  updateDownloadFields: vi.fn(async (id: string, fields: Partial<Download>) => { Object.assign(mocks.records[id], fields); }),
  updateDownloadProgress: vi.fn(async (id: string, fields: Partial<Download>) => { Object.assign(mocks.records[id], fields); }),
  updateDownloadsProgressBatch: vi.fn().mockResolvedValue(undefined),
}));
const binary = path.resolve('vendor/transmission', process.platform === 'win32' ? 'win32-x64/transmission-daemon.exe' : 'linux-x64/transmission-daemon');
const quiet = { dht: false, tracker: false, lsd: false, webSeeds: false, natUpnp: false, natPmp: false, utp: false };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const canonical = (value: string) => fs.realpathSync(value);

for (const engine of ['classic', 'native'] as const) for (const layout of ['file', 'nested-folder', 'mixed-siblings', 'scattered'] as const) {
  it.skipIf(engine === 'native' && !fs.existsSync(binary))(`${engine}: create → verify → seed → localhost transfer → resume → delete (${layout})`, async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-creation-seed-'));
    let client: WebTorrent | undefined, leecher: WebTorrent | undefined, sidecar: TransmissionSidecar | undefined;
    let manager: TorrentManager | NativeTorrentManager | undefined;
    try {
      mocks.records = {}; mocks.env = { isPackaged: false, userDataDir: path.join(root, 'profile'), engineStateDir: path.join(root, 'daemon') } as HostEnv;
      const make = (relative: string, bytes: Buffer | string = crypto.randomBytes(128 * 1024 + 7)) => {
        const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); return target;
      };
      let sources: string[];
      if (layout === 'file') sources = [make('original.bin')];
      else if (layout === 'nested-folder') sources = [path.dirname(path.dirname(make('original/nested/only.bin')))];
      else {
        make('original/tree/.hidden'); make('original/tree/nested/data.bin'); make('original/tree/empty', '');
        const other = make(layout === 'scattered' ? 'elsewhere/other.bin' : 'original/other.bin');
        sources = [path.join(root, 'original/tree'), other];
      }
      const excluded = make(layout === 'file' ? 'unselected' : 'original/excluded/keep', 'excluded');
      const collision = make('custom-root/keep', 'unrelated root must not be renamed');
      const result = await createTorrentFile({ sourcePaths: sources, outputPath: path.join(root, 'result.torrent'),
        excludePaths: [excluded], startSeeding: true,
        options: { name: 'custom-root', private: true, pieceLength: 32768, announceList: [], source: 'fixture' } });
      const prepared = await prepareSeed(result.torrentFilePath, sources, result.infoHash);
      const originals = prepared.paths.map(source => fs.readFileSync(source));
      const completed = vi.fn();
      if (engine === 'classic') {
        client = new WebTorrent(quiet); manager = new TorrentManager();
        Object.assign(manager, { client, initDone: Promise.resolve(), cachedStore: downloadPieceCache.store(FSChunkStore), maxActiveDownloads: 3 });
      } else {
        sidecar = new TransmissionSidecar({ binaryPath: binary, configDir: mocks.env.engineStateDir, downloadDir: root,
          settingsOverrides: { 'dht-enabled': false, 'pex-enabled': false, 'lpd-enabled': false, 'utp-enabled': false,
            'port-forwarding-enabled': false, 'bind-address-ipv4': '127.0.0.1', 'bind-address-ipv6': '::1', preallocation: 0 } });
        const rpc = await sidecar.start(); manager = new NativeTorrentManager();
        Object.assign(manager, { ready: Promise.resolve(), rpc, settings: { maxActiveDownloads: 3, defaultSeedRatioLimit: 0 } as AppSettings });
      }
      manager.onComplete(completed);
      const add = () => manager!.addSeed({ sourcePaths: sources, torrentFilePath: result.torrentFilePath, expectedInfoHash: result.infoHash });
      if (engine === 'native' && layout === 'scattered') {
        await expect(add()).rejects.toThrow(/classic engine/);
        expect(Object.keys(mocks.records)).toHaveLength(0); expect(fs.existsSync(result.torrentFilePath)).toBe(true);
        return;
      }
      const d = await add(); expect(d.status).toBe('seeding'); expect(d.infoHash).toBe(result.infoHash);
      expect(canonical(d.torrentFilePath!)).not.toBe(canonical(result.torrentFilePath));
      expect(fs.readFileSync(d.torrentFilePath!)).toEqual(prepared.metadata.bytes);
      await expect(add()).rejects.toThrow(/already/);
      leecher = new WebTorrent(quiet);
      const received = await new Promise<Torrent>((resolve, reject) => {
        const torrent = leecher!.add(prepared.metadata.bytes, { path: path.join(root, 'received') }, resolve); torrent.once('error', reject);
      });
      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error('Local seed transfer timed out')); }, 20_000);
        const cleanup = () => { clearTimeout(timeout); received.off('done', finish); received.off('error', fail); };
        const finish = () => { cleanup(); resolve(); }; const fail = (error: Error) => { cleanup(); reject(error); };
        received.once('done', finish); received.once('error', fail);
      });
      let port: number;
      if (sidecar) port = sidecar.peerPort;
      else {
        if (!client!.listening) await new Promise<void>(resolve => client!.once('listening', resolve));
        port = client!.torrentPort;
      }
      received.addPeer('127.0.0.1:' + port); await done;
      expect(received.infoHash).toBe(result.infoHash);
      received.files.forEach((entry, index) => expect(fs.readFileSync(path.join(root, 'received', entry.path))).toEqual(originals[index]));
      await new Promise<void>(resolve => leecher!.destroy(() => resolve())); leecher = undefined;
      await manager.pauseDownload(d.id); await manager.resumeDownload(d.id);
      if (engine === 'native') await (manager as any).tick();
      expect(manager.getStats().find(stat => stat.id === d.id)?.progress).toBe(1);
      expect(completed).not.toHaveBeenCalled();
      expect(fs.readFileSync(collision, 'utf8')).toBe('unrelated root must not be renamed');
      const addedLater = make(layout === 'file' ? 'added-later' : 'original/added-later', 'new');
      await manager.removeDownload(d.id, true);
      expect(prepared.paths.every(source => !fs.existsSync(source))).toBe(true);
      expect(fs.readFileSync(excluded, 'utf8')).toBe('excluded'); expect(fs.readFileSync(addedLater, 'utf8')).toBe('new');
      expect(fs.readFileSync(collision, 'utf8')).toBe('unrelated root must not be renamed');
      expect(fs.existsSync(result.torrentFilePath)).toBe(true);
    } finally {
      if (manager instanceof NativeTorrentManager) await manager.destroy();
      await sidecar?.stop();
      if (leecher) await new Promise<void>(resolve => leecher!.destroy(() => resolve()));
      if (client) await new Promise<void>(resolve => client!.destroy(() => resolve()));
      // Allow daemon process/file handles to finish closing on Windows.
      await wait(30);
      expect(path.dirname(root)).toBe(fs.realpathSync(os.tmpdir())); expect(path.basename(root)).toMatch(/^havvn-creation-seed-/);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
}

for (const engine of ['classic', 'native'] as const) {
  it.skipIf(engine === 'native' && !fs.existsSync(binary))(`${engine}: rejects same-size corruption before seeding without overwriting the source`, async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-corrupt-seed-'));
    let client: WebTorrent | undefined, sidecar: TransmissionSidecar | undefined, manager: TorrentManager | NativeTorrentManager | undefined;
    try {
      mocks.records = {}; mocks.env = { isPackaged: false, userDataDir: path.join(root, 'profile'), engineStateDir: path.join(root, 'daemon') } as HostEnv;
      const source = path.join(root, 'source.bin'), original = crypto.randomBytes(128 * 1024 + 7);
      fs.writeFileSync(source, original);
      const result = await createTorrentFile({ sourcePaths: [source], outputPath: path.join(root, 'saved.torrent'),
        startSeeding: true, options: { name: 'renamed.bin', private: true, pieceLength: 32768, announceList: [] } });
      const corrupted = Buffer.alloc(fs.statSync(source).size, 42); fs.writeFileSync(source, corrupted);
      if (engine === 'classic') {
        client = new WebTorrent(quiet); manager = new TorrentManager();
        Object.assign(manager, { client, initDone: Promise.resolve(), cachedStore: downloadPieceCache.store(FSChunkStore), maxActiveDownloads: 3 });
      } else {
        sidecar = new TransmissionSidecar({ binaryPath: binary, configDir: mocks.env.engineStateDir, downloadDir: root,
          settingsOverrides: { 'dht-enabled': false, 'pex-enabled': false, 'lpd-enabled': false, 'utp-enabled': false,
            'port-forwarding-enabled': false, 'bind-address-ipv4': '127.0.0.1', 'bind-address-ipv6': '::1', preallocation: 0 } });
        const rpc = await sidecar.start(); manager = new NativeTorrentManager();
        Object.assign(manager, { ready: Promise.resolve(), rpc, settings: { maxActiveDownloads: 3 } as AppSettings });
      }
      const completed = vi.fn(); manager.onComplete(completed);
      await expect(manager.addSeed({ sourcePaths: [source], torrentFilePath: result.torrentFilePath, expectedInfoHash: result.infoHash })).rejects.toThrow(/match|seed/i);
      await wait(100);
      expect(completed).not.toHaveBeenCalled(); expect(fs.readFileSync(source)).toEqual(corrupted);
      expect(fs.existsSync(result.torrentFilePath)).toBe(true);
      if (engine === 'classic') {
        expect(Object.values(mocks.records).map(record => record.status)).toEqual(['error']);
        const live = client!.torrents.find(torrent => torrent.infoHash === result.infoHash);
        expect(live?.downloaded ?? 0).toBe(0);
      } else expect(Object.keys(mocks.records)).toHaveLength(0);
      const retry = { sourcePaths: [source], torrentFilePath: result.torrentFilePath, expectedInfoHash: result.infoHash, retryExisting: true };
      const failedId = Object.keys(mocks.records)[0];
      // A retry with unrepaired content must still fail, preserving one Classic
      // error record rather than reporting a duplicate as a successful seed.
      await expect(manager.addSeed(retry)).rejects.toThrow(/match|seed/i);
      expect(Object.keys(mocks.records)).toHaveLength(engine === 'classic' ? 1 : 0);
      expect(fs.readFileSync(source)).toEqual(corrupted);
      fs.writeFileSync(source, original);
      const recovered = await manager.addSeed(retry);
      if (engine === 'classic') expect(recovered.id).toBe(failedId);
      expect(Object.keys(mocks.records)).toHaveLength(1);
      expect((await manager.addSeed(retry)).id).toBe(recovered.id);
      expect(Object.keys(mocks.records)).toHaveLength(1);
      await manager.pauseDownload(recovered.id);
      expect((await manager.addSeed(retry)).id).toBe(recovered.id);
      if (engine === 'native') await (manager as any).tick();
      expect(manager.getStats().find(stat => stat.id === recovered.id)?.progress).toBe(1);
      expect(fs.readFileSync(source)).toEqual(original);
      expect(completed).not.toHaveBeenCalled();
    } finally {
      if (manager instanceof NativeTorrentManager) await manager.destroy();
      await sidecar?.stop();
      if (client) await new Promise<void>(resolve => client!.destroy(() => resolve()));
      expect(path.dirname(root)).toBe(fs.realpathSync(os.tmpdir())); expect(path.basename(root)).toMatch(/^havvn-corrupt-seed-/);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}
