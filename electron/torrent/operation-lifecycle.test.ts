import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { Download } from '../../shared/types';
import { classicDownloadOperation } from './classic-operation';

vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('./host/env', () => ({ getHostEnv: () => ({ isPackaged: false }) }));
vi.mock('./host/db-bridge', () => ({
  updateDownloadStatus: vi.fn().mockResolvedValue(undefined), updateDownloadField: vi.fn().mockResolvedValue(undefined),
  updateDownloadProgress: vi.fn().mockResolvedValue(undefined), getDownloadsByStatus: vi.fn().mockResolvedValue([]),
}));
import { TorrentManager } from './manager';
import * as db from './host/db-bridge';
import { TorrentError } from './errors';
import { setTransferBlocks } from './transfer-policy';
import type { EpisodePrefetcher, PrefetchTorrent } from './episode-prefetch';

it('economy clears only optional episode selections and rejects new prefetch without interrupting playback', async () => {
  const manager = new TorrentManager(); Object.assign(manager, { initDone: Promise.resolve() });
  const state = manager as unknown as { episodePrefetcher: EpisodePrefetcher };
  const current = { from: 0, to: 2 }, normal = { from: 0, to: 30 };
  const items: { from: number; to: number; notify?: () => void }[] = [current, normal];
  const torrent = { pieceLength: 1024, bitfield: { get: () => false }, _selections: { _items: items },
    _select: (from, to, _priority, notify) => { items.push({ from, to, notify }); }, _updateSelections: vi.fn() } as PrefetchTorrent;
  state.episodePrefetcher.start('one', 'lease-123456', torrent, 1, 4096, 100000, 2048);
  manager.setResourceEconomy(true); expect(items).toEqual([current, normal]);
  await expect(manager.prefetchEpisode('one', { currentFile: 0, nextFile: 1, budgetBytes: 2048, allowExcluded: false, lease: 'lease-123456' })).resolves.toEqual({ state: 'inactive', bytes: 0 });
  manager.setResourceEconomy(false); expect(items).toEqual([current, normal]);
});

it('classic queue and torrent construction cannot activate transfers under protection', async () => {
  const manager = new TorrentManager();
  const state = manager as unknown as { processQueue(): Promise<void>; addTorrentInternal(id: string, source: string, path: string, isNew: boolean): Promise<void> };
  setTransferBlocks(['disk']);
  try {
    vi.mocked(db.getDownloadsByStatus).mockClear(); await state.processQueue();
    expect(db.getDownloadsByStatus).not.toHaveBeenCalled();
    await expect(state.addTorrentInternal('test', 'magnet:?xt=test', 'D:/fixture', false)).rejects.toMatchObject({ code: 'TRANSFER_BLOCKED' });
  } finally { setTransferBlocks([]); }
});

class TorrentFixture extends EventEmitter {
  metadata: Buffer | null = null;
  ready = false; destroyed = false; progress = .75; numPeers = 2; downloadSpeed = 0;
  received = 0; uploaded = 0; uploadSpeed = 0; timeRemaining = 0;
  name = 'test'; length = 100; infoHash = 'a'.repeat(40); files = []; _selections = [{ from: 0, to: 1 }];
  destroy = vi.fn(() => { this.destroyed = true; this.emit('close'); });
  pause = vi.fn();
}
function fixture() {
  const manager = new TorrentManager();
  const state = manager as unknown as {
    managedTorrents: Map<string, { torrent: unknown; download: Download }>;
    addTorrentInternal(id: string, source: string, savePath: string, isNew: boolean): Promise<void>;
  };
  const download = { id: 'test', name: 'test', sourceType: 'magnet', sourceUri: 'magnet:?xt=test', savePath: 'D:/fixture',
    status: 'downloading', progress: .75, totalSize: 100, downloadedBytes: 0, uploadedBytes: 0, lastError: null } as Download;
  const torrent = new TorrentFixture();
  const managed = { id: 'test', download, torrent: null, infoHash: torrent.infoHash, everReady: true };
  state.managedTorrents.set('test', managed);
  Object.assign(manager, { client: { add: () => torrent }, initDone: Promise.resolve(),
    applyConnectionLimit: vi.fn(), pruneRemovedTrackersLive: vi.fn(), applyStrategy: vi.fn() });
  const pending = state.addTorrentInternal('test', download.sourceUri, download.savePath, false);
  const outcome = pending.then(() => 'ready', error => error.code as string);
  return { manager, state, download, torrent, outcome };
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('reannounces through the real tracker-client interface, not the torrent announce URL array', async () => {
  const f = fixture(); f.torrent.ready = true; f.torrent.emit('ready'); await f.outcome;
  const update = vi.fn(); Object.assign(f.torrent, { announce: ['https://tracker.example.org/announce'], discovery: { tracker: { update } } });
  await expect(f.manager.reannounceDownload('test')).resolves.toBeUndefined(); expect(update).toHaveBeenCalledOnce();
});

it('restores saved file priorities instead of the original add-dialog subset on ready', async () => {
  const f = fixture();
  f.download.selectedFiles = [0, 1]; f.download.filePriorities = ['skip', 'low', 'high'];
  const files = Array.from({ length: 3 }, (_, index) => ({ name: `file-${index}`, path: `file-${index}`, length: 10, select: vi.fn(), deselect: vi.fn() }));
  Object.assign(f.torrent, { files });
  f.torrent.ready = true; f.torrent.emit('ready');
  expect(await f.outcome).toBe('ready');
  expect(files[0].select).not.toHaveBeenCalled();
  expect(files[1].select).toHaveBeenCalled(); expect(files[2].select).toHaveBeenCalled();
  expect(files[2].select.mock.calls[0][0]).toBeGreaterThan(files[1].select.mock.calls[0][0]);
});

it('treats an explicit priority as newer intent than the original file subset', async () => {
  const f = fixture();
  f.torrent.ready = true; f.torrent.emit('ready'); await f.outcome;
  const managed = f.state.managedTorrents.get('test')!;
  Object.assign(managed, { selectedFiles: [0] }); f.download.filePriorities = ['normal', 'high', 'skip'];
  expect((f.manager as any).fileShouldDownload(managed, 1)).toBe(true);
  expect((f.manager as any).fileShouldDownload(managed, 2)).toBe(false);
});

it('stops the metadata deadline before disk verification, without inferring a checked fraction', async () => {
  vi.useFakeTimers(); const f = fixture();
  f.torrent.metadata = Buffer.from('metadata'); f.torrent.emit('metadata');
  await vi.advanceTimersByTimeAsync(180_000);
  expect(f.torrent.destroy).not.toHaveBeenCalled(); expect(f.download.status).toBe('downloading');
  expect(classicDownloadOperation(f.download, f.torrent)).toMatchObject({ stage: 'checking', progress: null });
  f.torrent.ready = true; f.torrent.emit('ready'); expect(await f.outcome).toBe('ready');
});
it('records metadata timeout as failure, destroys its own instance, and ignores late readiness', async () => {
  vi.useFakeTimers(); const f = fixture();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(await f.outcome).toBe('METADATA_TIMEOUT'); expect(f.download.status).toBe('error');
  f.torrent.emit('ready'); f.torrent.emit('done'); await Promise.resolve();
  expect(f.download.status).toBe('error'); expect(f.torrent.destroy).toHaveBeenCalledOnce();
});
it('keeps pause intent after the metadata deadline instead of claiming cancellation or failure', async () => {
  vi.useFakeTimers(); const f = fixture(); f.download.status = 'paused';
  await vi.advanceTimersByTimeAsync(180_000); await f.outcome;
  expect(f.download.status).toBe('paused');
  expect(classicDownloadOperation(f.download)).toMatchObject({ status: 'waiting', waitingFor: 'paused' });
});
it('ignores ready/done/error from a replaced instance and coalesces recheck requests', async () => {
  vi.useFakeTimers(); const f = fixture(), completed = vi.fn(); f.manager.onComplete(completed);
  const first = f.manager.recheckDownload('test'), second = f.manager.recheckDownload('test');
  expect(first).toBe(second); await first; expect(f.torrent.destroy).not.toHaveBeenCalled();
  f.state.managedTorrents.get('test')!.torrent = new TorrentFixture();
  f.torrent.emit('done'); f.torrent.emit('error', new Error('old error')); f.torrent.emit('ready');
  expect(await f.outcome).toBe('NOT_ACTIVE'); expect(f.download.status).toBe('downloading');
  expect(completed).not.toHaveBeenCalled(); expect(db.updateDownloadStatus).not.toHaveBeenCalled();
});
it('settles an error before a ready event in the same turn, even with slow persistence', async () => {
  vi.useFakeTimers(); const f = fixture(); let finish!: () => void;
  vi.mocked(db.updateDownloadStatus).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  f.torrent.emit('error', new Error('disk failure')); f.torrent.ready = true; f.torrent.emit('ready'); f.torrent.emit('done');
  expect(await f.outcome).toBe('TORRENT_ERROR'); expect(db.updateDownloadField).not.toHaveBeenCalled();
  finish(); await Promise.resolve(); expect(f.download.status).toBe('error');
});
it('does not let an old status acknowledgement overwrite a confirmed failure', async () => {
  vi.useFakeTimers(); const f = fixture();
  const state = f.manager as unknown as { transitionStatus(id: string, status: string): Promise<void> };
  let finish!: () => void;
  vi.mocked(db.updateDownloadStatus).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = state.transitionStatus('test', 'downloading');
  await state.transitionStatus('test', 'error'); finish(); await old;
  expect(f.download.status).toBe('error'); f.torrent.destroy(); await f.outcome;
});
it.each(['paused', 'downloading'] as const)('does not convert a superseded restoration into an error from %s', async status => {
  vi.useFakeTimers(); const f = fixture(); f.download.status = status;
  const state = f.manager as unknown as { restoreTorrent(download: Download): Promise<void> };
  Object.assign(f.manager, { addTorrentInternal: vi.fn().mockRejectedValue(new TorrentError('old instance closed', 'NOT_ACTIVE')) });
  await state.restoreTorrent(f.download);
  expect(f.download.status).toBe(status); expect(db.updateDownloadStatus).not.toHaveBeenCalled();
  f.torrent.destroy(); await f.outcome;
});
