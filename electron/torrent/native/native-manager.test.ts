import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, Download } from '../../../shared/types';
import { TrStatus, type TrTorrent } from './transmission-rpc';

vi.mock('../../utils', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../host/db-bridge', () => ({
  updateDownloadStatus: vi.fn().mockResolvedValue(undefined),
  updateDownloadField: vi.fn().mockResolvedValue(undefined),
  updateDownloadFields: vi.fn().mockResolvedValue(undefined),
  updateDownloadsProgressBatch: vi.fn().mockResolvedValue(undefined),
  getAllDownloads: vi.fn().mockResolvedValue([]),
  deleteDownload: vi.fn().mockResolvedValue(undefined),
  createDownload: vi.fn(async (params) => ({ id: 'new', progress: 0, ...params })),
}));

import { NativeTorrentManager } from './native-manager';
import * as db from '../host/db-bridge';

function fixture(linked = true) {
  const manager = new NativeTorrentManager();
  // Inject only the process boundary: exercise the real manager methods without
  // spawning a daemon or touching the user's profile.
  const state = manager as any;
  const rpc = {
    torrentStop: vi.fn().mockResolvedValue(undefined),
    torrentRemove: vi.fn().mockResolvedValue(undefined),
    torrentSet: vi.fn().mockResolvedValue(undefined),
    torrentGet: vi.fn().mockResolvedValue([{ metadataPercentComplete: 1 }]),
    torrentAdd: vi.fn().mockResolvedValue({ hashString: 'abc', name: 'test', duplicate: false }),
    torrentStartNow: vi.fn().mockResolvedValue(undefined),
    torrentStart: vi.fn().mockResolvedValue(undefined),
    sessionSet: vi.fn().mockResolvedValue(undefined),
  };
  const download = {
    id: 'test', infoHash: 'abc', sourceType: 'magnet', sourceUri: 'magnet:?xt=test',
    savePath: 'D:/downloads', status: 'paused', progress: 0.5, lastError: null,
  } as Download;
  state.ready = Promise.resolve();
  state.rpc = rpc;
  state.settings = { defaultDownloadDir: 'D:/downloads', maxActiveDownloads: 3 } as AppSettings;
  state.records.set(download.id, download);
  if (linked) state.link(download.id, 'abc');
  return { manager, state, rpc, download };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('native manager controls', () => {
  it('history reads do not restore daemon torrents and refuse paused streaming', async () => {
    const { manager, rpc, download } = fixture(false);
    expect(await manager.getHistoryFiles('test')).toEqual([]);
    await expect(manager.getStreamUrl('test', 0, { noResume: true })).rejects.toThrow('resume');
    download.status = 'downloading';
    await expect(manager.getStreamUrl('test', 0, { noResume: true })).rejects.toThrow('resume');
    expect(rpc.torrentAdd).not.toHaveBeenCalled(); expect(rpc.torrentStartNow).not.toHaveBeenCalled(); expect(rpc.torrentSet).not.toHaveBeenCalled();
  });
  it('history streams from an existing active daemon record without starting it', async () => {
    const { manager, state, rpc, download } = fixture(); download.status = 'downloading';
    rpc.torrentGet.mockResolvedValue([{ files: [{ name: 'film.mp4', length: 100, bytesCompleted: 10 }], fileStats: [{ wanted: true, priority: 0 }] }]);
    state.ensureMediaServer = vi.fn().mockResolvedValue(1234);
    const url = await manager.getStreamUrl('test', 0, { noResume: true });
    expect(url.transcoded).toBe(false); expect(rpc.torrentAdd).not.toHaveBeenCalled(); expect(rpc.torrentStartNow).not.toHaveBeenCalled();
    expect(rpc.torrentSet).toHaveBeenCalled();
  });
  it('reports bounded prefetch as unsupported without changing daemon selections or pause', async () => {
    const { manager, rpc } = fixture();
    expect(manager.getEpisodePrefetchSupport()).toEqual({ supported: false });
    expect(await manager.prefetchEpisode('test', { currentFile: 0, nextFile: 1, budgetBytes: 64 * 1024 * 1024, allowExcluded: true, lease: 'owner-test' })).toEqual({ state: 'unsupported', bytes: 0 });
    await manager.stopEpisodePrefetch('test', 'owner-test');
    expect(rpc.torrentSet).not.toHaveBeenCalled();
    expect(rpc.torrentStartNow).not.toHaveBeenCalled();
    expect(rpc.torrentStop).not.toHaveBeenCalled();
  });
  it('changes the download ceiling without pausing or restarting an active torrent', async () => {
    const { manager, rpc, download } = fixture();
    download.status = 'downloading';
    for (const maxDownKbps of [10000, 2048, 0, 10000]) {
      await manager.updateSettings({ maxDownKbps });
      expect(rpc.sessionSet).toHaveBeenLastCalledWith(expect.objectContaining({
        'speed-limit-down-enabled': maxDownKbps > 0,
        ...(maxDownKbps > 0 ? { 'speed-limit-down': maxDownKbps } : {}),
      }));
      expect(download.status).toBe('downloading');
    }
    expect(rpc.torrentStop).not.toHaveBeenCalled();
    expect(rpc.torrentStartNow).not.toHaveBeenCalled();
    expect(rpc.torrentRemove).not.toHaveBeenCalled();
  });
  it('stops and resumes a finished torrent without removing its files', async () => {
    const { manager, rpc, download } = fixture();
    download.progress = 1;
    download.status = 'seeding';
    await manager.stopSeeding('test');
    expect(rpc.torrentStop).toHaveBeenCalledWith('abc');
    expect(download.status).toBe('completed');
    await manager.resumeDownload('test');
    expect(rpc.torrentStart).toHaveBeenCalledWith('abc');
    expect(download.status).toBe('seeding');
    expect(rpc.torrentRemove).not.toHaveBeenCalled();
  });

  it('resumes a completed torrent after restarting the app', async () => {
    const { manager, rpc, download } = fixture(false);
    download.progress = 1;
    download.status = 'completed';
    await manager.resumeDownload('test');
    expect(rpc.torrentAdd).toHaveBeenCalledWith(expect.objectContaining({ paused: true, downloadDir: 'D:/downloads' }));
    expect(rpc.torrentStart).toHaveBeenCalledWith('abc');
    expect(download.status).toBe('seeding');
  });

  it('caps uploads by default and preserves an explicit unlimited choice', async () => {
    const { manager, rpc } = fixture();
    await manager.updateSettings({ maxDownKbps: 0 });
    expect(rpc.sessionSet).toHaveBeenLastCalledWith(expect.objectContaining({ 'speed-limit-up': 1024, 'speed-limit-up-enabled': true }));
    await manager.updateSettings({ maxUpKbps: 0 });
    expect(rpc.sessionSet).toHaveBeenLastCalledWith(expect.objectContaining({ 'speed-limit-up-enabled': false }));
    await manager.updateSettings({ maxUpKbps: 256 });
    expect(rpc.sessionSet).toHaveBeenLastCalledWith(expect.objectContaining({ 'speed-limit-up': 256, 'speed-limit-up-enabled': true }));
  });

  it('retains the record and daemon identity when removal fails so it can be retried', async () => {
    const { manager, state, rpc, download } = fixture();
    rpc.torrentRemove.mockRejectedValueOnce(new Error('RPC unavailable'));
    await expect(manager.removeDownload('test', true)).rejects.toThrow('RPC unavailable');
    expect(download.status).toBe('paused');
    expect(state.idToHash.get('test')).toBe('abc');
    expect(db.updateDownloadStatus).not.toHaveBeenCalled();
    await manager.removeDownload('test', true);
    expect(rpc.torrentRemove).toHaveBeenLastCalledWith('abc', true);
    expect(download.status).toBe('removed');
  });

  it('restores a daemon-less record before deleting its data', async () => {
    const { manager, rpc } = fixture(false);
    await manager.removeDownload('test', true);
    expect(rpc.torrentAdd).toHaveBeenCalledWith(expect.objectContaining({ paused: true }));
    expect(rpc.torrentRemove).toHaveBeenCalledWith('abc', true);
  });

  it('does not restore a daemon-less torrent when retaining its data', async () => {
    const { manager, rpc, download } = fixture(false);
    await manager.removeDownload('test', false);
    expect(rpc.torrentAdd).not.toHaveBeenCalled();
    expect(download.status).toBe('removed');
  });

  it('does not report files deleted when a restored magnet has no metadata', async () => {
    const { manager, rpc, download } = fixture(false);
    rpc.torrentGet.mockResolvedValue([{ metadataPercentComplete: 0 }]);
    await expect(manager.removeDownload('test', true)).rejects.toThrow('metadata');
    expect(rpc.torrentRemove).not.toHaveBeenCalled();
    expect(download.status).toBe('paused');
  });

  it('sends the RPC spelling of the global ratio switch and can turn it off', async () => {
    const { manager, rpc } = fixture();
    await manager.updateSettings({ defaultSeedRatioLimit: 2 });
    expect(rpc.sessionSet).toHaveBeenLastCalledWith(expect.objectContaining({ seedRatioLimited: true, seedRatioLimit: 2 }));
    await manager.updateSettings({ defaultSeedRatioLimit: 0 });
    expect(rpc.sessionSet).toHaveBeenLastCalledWith(expect.objectContaining({ seedRatioLimited: false }));
  });

  it('uses unlimited mode for an explicit zero torrent ratio', async () => {
    const { manager, rpc } = fixture();
    await manager.setSeedRatioLimit('test', 0);
    expect(rpc.torrentSet).toHaveBeenCalledWith('abc', { seedRatioLimit: 0, seedRatioMode: 2 });
  });

  it('reapplies a ratio set while the torrent was absent from the daemon before resume', async () => {
    const { manager, rpc } = fixture(false);
    await manager.setSeedRatioLimit('test', 3);
    await manager.resumeDownload('test');
    expect(rpc.torrentSet).toHaveBeenCalledWith('abc', { seedRatioLimit: 3, seedRatioMode: 1 });
    expect(rpc.torrentSet.mock.invocationCallOrder[0]).toBeLessThan(rpc.torrentStart.mock.invocationCallOrder[0]);
  });
});

describe('native download queue', () => {
  it('applies the configured limit without excluding stalled downloads or limiting seeds', async () => {
    const { manager, rpc } = fixture();
    await manager.updateSettings({ maxActiveDownloads: 2 });
    expect(rpc.sessionSet).toHaveBeenLastCalledWith(expect.objectContaining({
      'download-queue-enabled': true, 'download-queue-size': 2,
      'queue-stalled-enabled': false, 'seed-queue-enabled': false,
    }));
  });

  it('adds magnets stopped so metadata fetching cannot bypass the queue', async () => {
    const { manager, rpc } = fixture();
    rpc.torrentAdd.mockResolvedValueOnce({ hashString: 'def', name: 'new', duplicate: false });
    const result = await manager.addDownload({ sourceType: 'magnet', sourceUri: 'magnet:?xt=new' });
    expect(rpc.torrentAdd).toHaveBeenCalledWith(expect.objectContaining({ paused: true }));
    expect(result.status).toBe('queued');
    expect(rpc.torrentStart).toHaveBeenCalledWith('def');
    expect(rpc.torrentStartNow).not.toHaveBeenCalled();
  });

  it('does not start an explicitly paused add', async () => {
    const { manager, rpc } = fixture();
    rpc.torrentAdd.mockResolvedValueOnce({ hashString: 'def', name: 'new', duplicate: false });
    expect((await manager.addDownload({ sourceType: 'magnet', sourceUri: 'magnet:?xt=new', paused: true })).status).toBe('paused');
    expect(rpc.torrentStart).not.toHaveBeenCalled();
  });

  it('resumes and retries through the queue instead of forcing another active download', async () => {
    const { manager, rpc, download } = fixture();
    await manager.resumeDownload('test');
    expect(download.status).toBe('queued');
    download.status = 'error';
    await manager.retryDownload('test');
    expect(download.status).toBe('queued');
    expect(rpc.torrentStart).toHaveBeenCalledTimes(2);
    expect(rpc.torrentStartNow).not.toHaveBeenCalled();
  });

  it('restores missing magnets stopped, then starts through the daemon queue', async () => {
    const { state, rpc, download } = fixture(false);
    download.status = 'downloading';
    vi.mocked(db.getAllDownloads).mockResolvedValueOnce([download]);
    rpc.torrentGet.mockResolvedValueOnce([]);
    await state.reconcile();
    expect(rpc.torrentAdd).toHaveBeenCalledWith(expect.objectContaining({ paused: true }));
    expect(rpc.torrentStart).toHaveBeenCalledWith('abc');
    expect(rpc.torrentStartNow).not.toHaveBeenCalled();
  });
});

function live(hashString = 'abc', overrides: Partial<TrTorrent> = {}): TrTorrent {
  return {
    hashString, status: TrStatus.Downloading, name: 'test', percentDone: 0.5,
    metadataPercentComplete: 1, totalSize: 100, sizeWhenDone: 100, rateDownload: 100, rateUpload: 20,
    peersConnected: 3, downloadedEver: 50, uploadedEver: 10, eta: 10, error: 0, isFinished: false,
    ...overrides,
  } as TrTorrent;
}

function pollingFixture() {
  const f = fixture();
  f.download.status = 'downloading';
  f.download.totalSize = 100;
  f.rpc.torrentGet.mockResolvedValue([live()]);
  return f;
}

describe('native stats polling', () => {
  it('persists the full metadata size on arrival even when only some files are wanted', async () => {
    const { state, rpc, download } = pollingFixture();
    download.totalSize = 0;
    const warm = vi.spyOn(state, 'warmMetaCache').mockResolvedValue(undefined);
    const selection = vi.spyOn(state, 'applyMagnetFileSelection').mockResolvedValue(undefined);
    rpc.torrentGet.mockResolvedValue([live('abc', { totalSize: 500, sizeWhenDone: 100, name: 'resolved' })]);
    await state.tick();
    expect(download.totalSize).toBe(500);
    expect(download.name).toBe('resolved');
    expect(db.updateDownloadFields).toHaveBeenCalledExactlyOnceWith('test', { totalSize: 500, name: 'resolved' });
    expect(warm).toHaveBeenCalledOnce();
    expect(selection).toHaveBeenCalledOnce();
    expect(rpc.torrentGet.mock.calls[0][0]).toContain('totalSize');
  });

  it('repairs a restored size from metadata once without reapplying file selection', async () => {
    const { manager, state, rpc, download } = pollingFixture();
    const GB = 1024 ** 3;
    download.totalSize = 185.38 * GB;
    download.name = 'custom name';
    const selection = vi.spyOn(state, 'applyMagnetFileSelection').mockResolvedValue(undefined);
    rpc.torrentGet.mockResolvedValue([live('abc', {
      totalSize: 50 * GB, sizeWhenDone: 10 * GB, percentDone: 0.009, downloadedEver: 26.22 * GB,
    })]);
    await state.tick();
    expect(download.totalSize).toBe(50 * GB);
    expect(download.name).toBe('custom name');
    expect(manager.getStats()[0]).toMatchObject({ progress: 0.009, downloadedBytes: 26.22 * GB });
    await state.tick();
    expect(db.updateDownloadFields).toHaveBeenCalledExactlyOnceWith('test', { totalSize: 50 * GB });
    expect(selection).not.toHaveBeenCalled();
  });

  it('waits for complete metadata before accepting a size', async () => {
    const { state, rpc, download } = pollingFixture();
    download.totalSize = 0;
    rpc.torrentGet.mockResolvedValue([live('abc', { metadataPercentComplete: 0.5, totalSize: 500 })]);
    await state.tick();
    expect(download.totalSize).toBe(0);
    expect(db.updateDownloadFields).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity])('retains the known size when a poll has invalid totalSize=%s', async (totalSize) => {
    const { state, rpc, download } = pollingFixture();
    rpc.torrentGet.mockResolvedValue([live('abc', { totalSize, sizeWhenDone: 10 })]);
    await state.tick();
    expect(download.totalSize).toBe(100);
    expect(db.updateDownloadFields).not.toHaveBeenCalled();
  });

  it('allows only one tick in flight, including persistence, then resumes polling', async () => {
    const { state, rpc } = pollingFixture();
    let resolve!: (value: TrTorrent[]) => void;
    rpc.torrentGet.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = state.tick();
    await state.tick(); await state.tick();
    expect(rpc.torrentGet).toHaveBeenCalledTimes(1);
    resolve([live()]); await pending;
    state.persistCounter = 6;
    let persist!: () => void;
    vi.mocked(db.updateDownloadsProgressBatch).mockImplementationOnce(() => new Promise(done => { persist = done; }));
    const saving = state.tick();
    await vi.waitFor(() => expect(db.updateDownloadsProgressBatch).toHaveBeenCalled());
    await state.tick();
    expect(rpc.torrentGet).toHaveBeenCalledTimes(2);
    persist(); await saving;
    await state.tick();
    expect(rpc.torrentGet).toHaveBeenCalledTimes(3);
  });

  it('recovers the polling guard after an RPC failure', async () => {
    const { state, rpc } = pollingFixture();
    rpc.torrentGet.mockRejectedValueOnce(new Error('timeout'));
    await expect(state.tick()).rejects.toThrow('timeout');
    await state.tick();
    expect(rpc.torrentGet).toHaveBeenCalledTimes(2);
  });

  it('drops replies received after shutdown without publishing or persisting them', async () => {
    const { manager, state, rpc, download } = pollingFixture();
    const publish = vi.fn(); manager.onStats(publish);
    let resolve!: (value: TrTorrent[]) => void;
    rpc.torrentGet.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = state.tick();
    await manager.destroy();
    resolve([live('abc', { percentDone: 1, status: TrStatus.Seeding })]); await pending;
    expect(download.status).toBe('downloading');
    expect(publish).not.toHaveBeenCalled();
    expect(db.updateDownloadStatus).not.toHaveBeenCalled();
    expect(db.updateDownloadsProgressBatch).not.toHaveBeenCalled();
  });

  it('samples peer details every five seconds and retains only the seed count', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { manager, state, rpc } = pollingFixture();
    rpc.torrentGet.mockResolvedValueOnce([live('abc', { peers: [{ progress: 1 }, { progress: 1 }, { progress: 0.5 }] as any })]);
    await state.tick();
    expect(rpc.torrentGet.mock.calls[0][0]).toContain('peers');
    expect(manager.getStats()[0].seeds).toBe(2);
    for (let i = 1; i <= 6; i++) {
      vi.setSystemTime(i * 750); await state.tick();
      expect(rpc.torrentGet.mock.calls[i][0]).not.toContain('peers');
      expect(manager.getStats()[0].seeds).toBe(2);
    }
    vi.setSystemTime(5250);
    rpc.torrentGet.mockResolvedValueOnce([live('abc', { peers: [] })]);
    await state.tick();
    expect(rpc.torrentGet.mock.calls[7][0]).toContain('peers');
    expect(manager.getStats()[0].seeds).toBe(0);
  });

  it('defers excess running downloads after lowering the cap and preserves playback', async () => {
    const { state, rpc, download } = pollingFixture();
    download.priority = 0;
    const high = { ...download, id: 'high', infoHash: 'def', priority: 2 };
    const stream = { ...download, id: 'stream', infoHash: 'ghi' };
    state.records.set(high.id, high); state.link(high.id, 'def');
    state.records.set(stream.id, stream); state.link(stream.id, 'ghi');
    state.streamHeads.set('stream', new Set([0]));
    state.settings.maxActiveDownloads = 2;
    rpc.torrentGet.mockResolvedValue([live(), live('def'), live('ghi')]);
    await state.tick();
    expect(rpc.torrentStop).toHaveBeenCalledWith(['abc']);
    expect(rpc.torrentStart).toHaveBeenCalledWith(['abc']);
    expect(download.status).toBe('queued');
    expect(high.status).toBe('downloading'); expect(stream.status).toBe('downloading');
  });
});
describe('native asynchronous run-state acknowledgements', () => {
  it('preserves explicit pause while the daemon still reports downloading', async () => {
    const { manager, state, rpc, download } = pollingFixture();
    await manager.pauseDownload('test');
    await state.tick(); await state.tick();
    expect(download.status).toBe('paused');
    expect(manager.getStats()[0]).toMatchObject({ status: 'paused', downSpeedBps: 0, peers: 0 });
    expect(db.updateDownloadStatus).toHaveBeenCalledExactlyOnceWith('test', 'paused', undefined);
    rpc.torrentGet.mockResolvedValue([live('abc', { status: TrStatus.Stopped })]);
    await state.tick(); expect(download.status).toBe('paused');
  });

  it('retains queued intent until an acknowledged start actually appears in stats', async () => {
    const { manager, state, rpc, download } = fixture();
    download.totalSize = 100;
    await manager.resumeDownload('test');
    rpc.torrentGet.mockResolvedValue([live('abc', { status: TrStatus.Stopped })]);
    await state.tick(); await state.tick();
    expect(download.status).toBe('queued');
    expect(db.updateDownloadStatus).toHaveBeenCalledOnce();
    rpc.torrentGet.mockResolvedValue([live()]);
    await state.tick();
    expect(download.status).toBe('downloading'); expect(state.pendingStarts.size).toBe(0);
  });

  it('does not use a poll begun before resume to overwrite the new queued status', async () => {
    const { manager, state, rpc, download } = pollingFixture();
    let resolve!: (value: TrTorrent[]) => void;
    rpc.torrentGet.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = state.tick();
    await manager.resumeDownload('test');
    resolve([live('abc', { status: TrStatus.Stopped })]); await pending;
    expect(download.status).toBe('queued');
    expect(db.updateDownloadStatus).toHaveBeenCalledOnce();
  });

  it('honors a pause issued while excess downloads are being deferred', async () => {
    const { manager, state, rpc, download } = pollingFixture();
    state.settings.maxActiveDownloads = 0;
    let finishStop!: () => void;
    rpc.torrentStop.mockImplementationOnce(() => new Promise(done => { finishStop = done; }));
    const pending = state.tick();
    await vi.waitFor(() => expect(rpc.torrentStop).toHaveBeenCalledOnce());
    await manager.pauseDownload('test');
    finishStop(); await pending;
    expect(download.status).toBe('paused'); expect(rpc.torrentStart).not.toHaveBeenCalled();
    expect(manager.getStats()[0].status).toBe('paused');
  });
});
describe('native stream reservations and delayed transitions', () => {
  it('protects a viewer while stream priority RPC is still pending', async () => {
    const { manager, state, rpc } = pollingFixture();
    state.settings.maxActiveDownloads = 0;
    state.metaCache.set('test', [{ name: 'film.mp4', length: 100, bytesCompleted: 10 }]);
    state.ensureMediaServer = vi.fn().mockResolvedValue(1234);
    let finishPriority!: () => void;
    rpc.torrentSet.mockImplementationOnce(() => new Promise(done => { finishPriority = done; }));
    const stream = manager.getStreamUrl('test', 0);
    await vi.waitFor(() => expect(rpc.torrentSet).toHaveBeenCalledOnce());
    await state.tick();
    expect(rpc.torrentStop).not.toHaveBeenCalled();
    expect(state.startingStreams.get('test')).toBe(1);
    finishPriority(); await stream;
    expect(state.startingStreams.size).toBe(0);
    expect(state.streamHeads.get('test').has(0)).toBe(true);
  });

  it('releases a stream reservation when URL creation fails', async () => {
    const { manager, state, rpc, download } = pollingFixture();
    state.settings.maxActiveDownloads = 0;
    state.metaCache.set('test', [{ name: 'film.mp4', length: 100, bytesCompleted: 10 }]);
    rpc.torrentGet.mockImplementation(async (fields: string[]) => fields.includes('files')
      ? [{ files: [{ name: 'film.mp4', length: 100, bytesCompleted: 10 }], fileStats: [{ wanted: true, priority: 0 }] }]
      : [live()]);
    await expect(manager.getStreamUrl('test', 999)).rejects.toThrow('Invalid file index');
    expect(state.startingStreams.size).toBe(0);
    await state.tick();
    expect(rpc.torrentStop).toHaveBeenCalledWith(['abc']); expect(download.status).toBe('queued');
  });

  it('publishes completed status immediately when the seed time limit stops a torrent', async () => {
    const { manager, state, rpc, download } = pollingFixture();
    download.status = 'seeding'; download.progress = 1;
    download.seedingStartedAt = Date.now() - 120000;
    state.settings.defaultSeedTimeLimitMinutes = 1;
    rpc.torrentGet.mockResolvedValue([live('abc', { status: TrStatus.Seeding, percentDone: 1 })]);
    await state.tick();
    expect(download.status).toBe('completed');
    expect(manager.getStats()[0]).toMatchObject({ status: 'completed', upSpeedBps: 0 });
  });

  it('does not resurrect a pause issued while metadata is being persisted', async () => {
    const { manager, state, download } = pollingFixture();
    download.totalSize = 0;
    let finishMetadata!: () => void;
    vi.mocked(db.updateDownloadFields).mockImplementationOnce(() => new Promise(done => { finishMetadata = done; }));
    const tick = state.tick();
    await vi.waitFor(() => expect(db.updateDownloadFields).toHaveBeenCalledOnce());
    await manager.pauseDownload('test');
    finishMetadata(); await tick;
    expect(download.status).toBe('paused');
    expect(db.updateDownloadStatus).toHaveBeenCalledExactlyOnceWith('test', 'paused', undefined);
    expect(manager.getStats()[0].status).toBe('paused');
  });
});