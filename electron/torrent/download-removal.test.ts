import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebTorrent from 'webtorrent';
import FSChunkStore from 'fs-chunk-store';
import type { Download, AppSettings } from '../../shared/types';
import type { HostEnv } from './host/env';
import { restoreDownloadInMap } from '../../shared/download-removal';
import { captureRemovalSnapshot, persistRemovalSnapshot, removalSeedStorePaths } from './download-removal';
import { TransmissionSidecar } from './native/transmission-sidecar';
import { NativeTorrentManager } from './native/native-manager';
import { TorrentManager } from './manager';
import { downloadPieceCache } from './piece-cache';
import { DownloadDeletionPreviews } from '../services/download-deletion-preview';

const mocks = vi.hoisted(() => ({ records: {} as Record<string, Download>, env: { isPackaged: false } as HostEnv }));
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('./host/env', () => ({ getHostEnv: () => mocks.env }));
vi.mock('./host/db-bridge', () => ({
  getDownloadById: vi.fn(async (id: string) => structuredClone(mocks.records[id] ?? null)),
  getAllDownloads: vi.fn(async () => Object.values(mocks.records)),
  getDownloadsByStatus: vi.fn(async (status: string) => Object.values(mocks.records).filter(d => d.status === status)),
  getSettings: vi.fn(async () => ({ autoMoveCompleted: false })),
  restoreDownload: vi.fn(async (d: Download) => structuredClone(restoreDownloadInMap(mocks.records, d, [{ id: 'movies' }]))),
  deleteDownload: vi.fn(async (id: string) => { delete mocks.records[id]; }),
  updateDownloadStatus: vi.fn(async (id: string, status: Download['status'], lastError: string | null = null) => { Object.assign(mocks.records[id], { status, lastError }); }),
  updateDownloadField: vi.fn(async (id: string, key: string, value: unknown) => { Object.assign(mocks.records[id], { [key]: value }); }),
  updateDownloadFields: vi.fn(async (id: string, fields: Partial<Download>) => { Object.assign(mocks.records[id], fields); }),
  updateDownloadProgress: vi.fn(async (id: string, fields: Partial<Download>) => { Object.assign(mocks.records[id], fields); }),
  updateDownloadsProgressBatch: vi.fn().mockResolvedValue(undefined),
}));
const binary = path.resolve('vendor/transmission', process.platform === 'win32' ? 'win32-x64/transmission-daemon.exe' : 'linux-x64/transmission-daemon');
const quiet = { dht: false, tracker: false, lsd: false, webSeeds: false, natUpnp: false, natPmp: false, utp: false };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const original = (source: string, destination: string): Download => ({
  id: 'undo-test', name: 'undo-fixture', sourceType: 'torrent_file', sourceUri: source, torrentFilePath: source,
  savePath: destination, status: 'paused', progress: 1, totalSize: 0, downloadedBytes: 123456, uploadedBytes: 23456,
  downSpeedBps: 0, upSpeedBps: 0, etaSeconds: null, peers: 0, seeds: 0, priority: 2, category: 'movies',
  selectedFiles: [0, 2], filePriorities: ['high', 'skip', 'low'], seedRatioLimit: 4, seedTimeLimitMinutes: 200,
  sequentialDownload: true, seedingStartedAt: Date.now() - 1000,
  createdAt: new Date(10), updatedAt: new Date(20), lastError: null,
});

const cases = (['webtorrent', 'native'] as const).flatMap(engine => [
  { engine, previous: 'paused' as const, seed: false }, { engine, previous: 'seeding' as const, seed: false }, { engine, previous: 'seeding' as const, seed: true },
]);

it.skipIf(!fs.existsSync(binary))('native: deletes a dead magnet with no metadata without touching unrelated files', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-empty-magnet-removal-'));
  let sidecar: TransmissionSidecar | undefined, manager: NativeTorrentManager | undefined;
  try {
    mocks.records = {};
    const destination = path.join(root, 'downloads'), profile = path.join(root, 'profile');
    fs.mkdirSync(destination); fs.mkdirSync(profile);
    mocks.env = { ...mocks.env, userDataDir: profile, engineStateDir: path.join(root, 'daemon') };
    sidecar = new TransmissionSidecar({ binaryPath: binary, configDir: mocks.env.engineStateDir, downloadDir: destination,
      settingsOverrides: { 'dht-enabled': false, 'pex-enabled': false, 'lpd-enabled': false, 'utp-enabled': false,
        'port-forwarding-enabled': false, 'bind-address-ipv4': '127.0.0.1', 'bind-address-ipv6': '::1', preallocation: 0 } });
    const rpc = await sidecar.start(), magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
    const added = await rpc.torrentAdd({ filename: magnet, downloadDir: destination, paused: true });
    const [before] = await rpc.torrentGet(['metadataPercentComplete', 'files'], added.hashString);
    expect(before.metadataPercentComplete).toBeLessThan(1); expect(before.files).toEqual([]);
    const unrelated = path.join(destination, 'keep.txt'), namedFolder = path.join(destination, added.name);
    fs.writeFileSync(unrelated, 'unrelated download'); fs.mkdirSync(namedFolder);
    fs.writeFileSync(path.join(namedFolder, 'keep.bin'), 'same display name does not establish ownership');
    const d = { ...original('', destination), name: added.name, sourceType: 'magnet' as const, sourceUri: magnet,
      torrentFilePath: null, infoHash: added.hashString, status: 'error' as const, progress: 0, totalSize: 0, downloadedBytes: 0,
      uploadedBytes: 0,
      lastError: 'metadata unavailable' };
    mocks.records[d.id] = d;
    manager = new NativeTorrentManager();
    Object.assign(manager, { ready: Promise.resolve(), rpc, settings: { maxActiveDownloads: 3 } as AppSettings });
    const state = manager as any; state.records.set(d.id, d); state.link(d.id, added.hashString);
    await manager.removeDownload(d.id, true);
    expect(d.status).toBe('removed'); expect(state.idToHash.has(d.id)).toBe(false);
    expect(await rpc.torrentGet(['hashString'], added.hashString)).toEqual([]);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated download');
    expect(fs.readFileSync(path.join(namedFolder, 'keep.bin'), 'utf8')).toBe('same display name does not establish ownership');
  } finally {
    await manager?.destroy(); await sidecar?.stop();
    expect(path.dirname(root)).toBe(fs.realpathSync(os.tmpdir())); expect(path.basename(root)).toMatch(/^havvn-empty-magnet-removal-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

for (const { engine, previous, seed } of cases) {
  it.skipIf(engine === 'native' && !fs.existsSync(binary))(`${engine}: undo ${previous}${seed ? ' from a custom seed directory' : ''} reuses verified files, original ID/options and retained metadata without a network download`, async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-download-undo-'));
    let client: WebTorrent | undefined, sidecar: TransmissionSidecar | undefined, native: NativeTorrentManager | undefined;
    try {
      mocks.records = {};
      const profile = path.join(root, 'profile'), sourceDir = path.join(root, 'source'), destination = path.join(root, 'downloads');
      mocks.env = { ...mocks.env, userDataDir: profile, engineStateDir: path.join(root, 'daemon') };
      fs.mkdirSync(sourceDir); fs.mkdirSync(destination); fs.mkdirSync(path.join(profile, 'torrents'), { recursive: true });
      const names = ['a.bin', 'b.inf', 'c.bin'], contents = names.map((_, i) => crypto.randomBytes(i === 1 ? 61 : 256 * 1024 + i));
      const paths = names.map((name, i) => { const file = path.join(sourceDir, name); fs.writeFileSync(file, contents[i]); return file; });
      const { default: createTorrent } = await import('create-torrent');
      const bytes = await new Promise<Buffer>((resolve, reject) => createTorrent(paths, { name: 'undo-fixture', pieceLength: 32 * 1024, announceList: [] }, (error, result) => error ? reject(error) : resolve(Buffer.from(result))));
      const source = path.join(profile, 'torrents', 'original.torrent'); fs.writeFileSync(source, bytes);
      fs.mkdirSync(path.join(destination, 'undo-fixture')); names.forEach((name, i) => fs.writeFileSync(path.join(destination, 'undo-fixture', name), contents[i]));
      const d = original(source, destination); d.totalSize = contents.reduce((sum, data) => sum + data.length, 0);
      if (seed) { d.seedPaths = [sourceDir]; d.savePath = root; d.sourceUri = sourceDir; }
      mocks.records[d.id] = structuredClone(d);
      let manager: TorrentManager | NativeTorrentManager;
      if (engine === 'webtorrent') {
        client = new WebTorrent(quiet); manager = new TorrentManager();
        const state = manager as any;
        Object.assign(manager, { client, initDone: Promise.resolve(), cachedStore: downloadPieceCache.store(FSChunkStore), maxActiveDownloads: 3 });
        state.managedTorrents.set(d.id, { id: d.id, download: d, torrent: null, infoHash: null, selectedFiles: d.selectedFiles, everReady: true });
        await state.addTorrentInternal(d.id, source, d.savePath, false, d.selectedFiles, true, await removalSeedStorePaths(d));
        const torrent = state.managedTorrents.get(d.id).torrent;
        d.infoHash = torrent.infoHash; state.managedTorrents.get(d.id).infoHash = torrent.infoHash; state.infoHashIndex.set(torrent.infoHash, d.id);
      } else {
        sidecar = new TransmissionSidecar({ binaryPath: binary, configDir: mocks.env.engineStateDir, downloadDir: destination,
          settingsOverrides: { 'dht-enabled': false, 'pex-enabled': false, 'lpd-enabled': false, 'utp-enabled': false,
            'port-forwarding-enabled': false, 'bind-address-ipv4': '127.0.0.1', 'bind-address-ipv6': '::1', preallocation: 0 } });
        const rpc = await sidecar.start(), added = await rpc.torrentAdd({ metainfo: bytes, downloadDir: d.savePath, paused: true });
        if (seed) await rpc.torrentRenamePath(added.hashString, 'undo-fixture', path.basename(sourceDir));
        native = new NativeTorrentManager(); manager = native;
        Object.assign(native, { ready: Promise.resolve(), rpc, settings: { maxActiveDownloads: 3, defaultSeedRatioLimit: 0 } as AppSettings });
        const state = native as any; d.infoHash = added.hashString; d.nativeSessionBase = { downloaded: d.downloadedBytes, uploaded: d.uploadedBytes };
        state.records.set(d.id, d); state.link(d.id, added.hashString);
        await rpc.torrentSet(added.hashString, { 'files-unwanted': [1], 'priority-high': [0], 'priority-low': [2] });
        await rpc.torrentVerify(added.hashString);
        for (let attempt = 0; attempt < 150; attempt++) {
          const [live] = await rpc.torrentGet(['recheckProgress', 'status'], added.hashString);
          if (attempt > 0 && live.status === 0) break;
          await wait(50);
        }
      }
      mocks.records[d.id] = structuredClone(d);
      if (previous === 'seeding') { await manager.activateRestoredDownload(d.id, previous); mocks.records[d.id].status = 'seeding'; }
      const completed = vi.fn(); manager.onComplete(completed);
      const before = await manager.captureDownloadRemoval(d.id);
      expect(before.metadata).not.toBeNull(); expect(before.download.filePriorities).toEqual(['high', 'skip', 'low']);
      await manager.removeDownload(d.id, false, before.signature);
      if (fs.existsSync(source)) fs.unlinkSync(source);
      expect(fs.existsSync(source)).toBe(false);
      const result = await manager.restoreRemovedDownload(before);
      expect(result.warnings).toEqual([]);
      if (previous === 'seeding') await manager.activateRestoredDownload(d.id, previous);
      const restored = mocks.records[d.id];
      expect(restored).toMatchObject({ id: d.id, status: previous, category: 'movies', priority: 2, selectedFiles: [0, 2], filePriorities: ['high', 'skip', 'low'], seedRatioLimit: 4, seedTimeLimitMinutes: 200, sequentialDownload: true });
      expect(restored.createdAt).toEqual(new Date(10)); expect(fs.existsSync(restored.torrentFilePath!)).toBe(true);
      expect(restored.seedingStartedAt).toBe(before.download.seedingStartedAt);
      const files = await manager.getFiles(d.id); expect(files[0].downloaded).toBe(contents[0].length); expect(files[2].downloaded).toBe(contents[2].length);
      expect(files.map(file => file.priority)).toEqual(['high', 'skip', 'low']);
      if (native) await (native as any).tick();
      const stats = manager.getStats().find(stat => stat.id === d.id)!;
      expect(stats.downloadedBytes).toBe(before.download.downloadedBytes); expect(stats.uploadedBytes).toBe(before.download.uploadedBytes);
      names.forEach((name, i) => expect(fs.readFileSync(path.join(seed ? sourceDir : path.join(destination, 'undo-fixture'), name))).toEqual(contents[i]));
      expect(completed).not.toHaveBeenCalled();
      await expect(manager.restoreRemovedDownload(before)).rejects.toMatchObject({ code: 'conflict' });
      const payload = seed ? sourceDir : path.join(destination, 'undo-fixture');
      const unrelated = path.join(payload, 'keep-unrelated.txt'); fs.writeFileSync(unrelated, 'keep me');
      const previews = new DownloadDeletionPreviews(id => manager.captureDownloadRemoval(id));
      let preview = await previews.preview(d.id);
      expect(preview.files.map(file => path.basename(file.path)).sort()).toEqual([...names].sort());
      expect(preview.files.every(file => path.dirname(file.path) === payload)).toBe(true);
      let plan = await previews.consume(d.id, preview.token);
      if (native && previous === 'paused') {
        const remove = vi.spyOn((native as any).rpc, 'torrentRemove');
        remove.mockRejectedValueOnce(new Error('Synthetic daemon disconnect'));
        await expect(manager.removeDownload(d.id, true, plan.signature, plan)).rejects.toThrow('Synthetic daemon disconnect');
        expect(mocks.records[d.id].status).toBe('error');
        expect(fs.existsSync(mocks.records[d.id].torrentFilePath!)).toBe(true);
        names.forEach(name => expect(fs.existsSync(path.join(payload, name))).toBe(true));
        preview = await previews.preview(d.id); plan = await previews.consume(d.id, preview.token);
      }
      await manager.removeDownload(d.id, true, plan.signature, plan);
      names.forEach(name => expect(fs.existsSync(path.join(payload, name))).toBe(false));
      expect(fs.readFileSync(unrelated, 'utf8')).toBe('keep me');
      if (!seed) names.forEach((name, i) => expect(fs.readFileSync(path.join(sourceDir, name))).toEqual(contents[i]));
      previews.clear();
    } finally {
      await native?.destroy(); await sidecar?.stop();
      if (client) await new Promise<void>(resolve => client!.destroy(() => resolve()));
      expect(path.dirname(root)).toBe(fs.realpathSync(os.tmpdir())); expect(path.basename(root)).toMatch(/^havvn-download-undo-/);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
}

it('does not create a directory, record or metadata copy when previous data disappeared', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-undo-missing-'));
  try {
    const d = { ...original('', root), sourceType: 'magnet' as const, sourceUri: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), totalSize: 0 };
    const snapshot = await captureRemovalSnapshot(d, null, []), insert = vi.fn();
    snapshot.existingFiles = [{ path: path.join(root, 'missing.bin'), size: 10 }];
    await expect(persistRemovalSnapshot(snapshot, path.join(root, 'profile'), insert)).rejects.toMatchObject({ code: 'files-missing' });
    expect(insert).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(root, 'profile'))).toBe(false);
  } finally {
    expect(path.dirname(root)).toBe(fs.realpathSync(os.tmpdir())); expect(path.basename(root)).toMatch(/^havvn-undo-missing-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects corrupt metadata and cleans only its own new copy when the atomic insert fails', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-undo-storage-'));
  try {
    const source = path.join(root, 'source.bin'); fs.writeFileSync(source, crypto.randomBytes(1024));
    const { default: createTorrent } = await import('create-torrent');
    const bytes = await new Promise<Buffer>((resolve, reject) => createTorrent(source, { announceList: [] }, (error, result) => error ? reject(error) : resolve(Buffer.from(result))));
    const originalMetadata = path.join(root, 'original.torrent'); fs.writeFileSync(originalMetadata, bytes);
    const profile = path.join(root, 'profile');
    const snapshot = await captureRemovalSnapshot({ ...original(originalMetadata, root), totalSize: 1024, selectedFiles: [0] }, bytes, []);
    const insert = vi.fn().mockRejectedValue(new Error('read-only store'));
    await expect(persistRemovalSnapshot(snapshot, profile, insert)).rejects.toThrow('read-only store');
    expect(fs.readdirSync(path.join(profile, 'torrents'))).toEqual([]);
    expect(fs.readFileSync(originalMetadata)).toEqual(bytes); expect(fs.statSync(source).size).toBe(1024);
    insert.mockClear();
    await expect(persistRemovalSnapshot({ ...snapshot, metadata: Buffer.from('corrupt').toString('base64') }, profile, insert)).rejects.toMatchObject({ code: 'metadata-unavailable' });
    expect(insert).not.toHaveBeenCalled();
    await expect(persistRemovalSnapshot({ ...snapshot, download: { ...snapshot.download, savePath: path.join(root, 'missing') } }, profile, insert)).rejects.toMatchObject({ code: 'directory-missing' });
    expect(fs.existsSync(path.join(root, 'missing'))).toBe(false);
  } finally {
    expect(path.dirname(root)).toBe(fs.realpathSync(os.tmpdir())); expect(path.basename(root)).toMatch(/^havvn-undo-storage-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
