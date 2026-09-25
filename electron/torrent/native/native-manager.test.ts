import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, Download } from '../../../shared/types';

vi.mock('../../utils', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../host/db-bridge', () => ({
  updateDownloadStatus: vi.fn().mockResolvedValue(undefined),
  updateDownloadField: vi.fn().mockResolvedValue(undefined),
  updateDownloadFields: vi.fn().mockResolvedValue(undefined),
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
    sessionSet: vi.fn().mockResolvedValue(undefined),
  };
  const download = {
    id: 'test', infoHash: 'abc', sourceType: 'magnet', sourceUri: 'magnet:?xt=test',
    savePath: 'D:/downloads', status: 'paused', progress: 0.5, lastError: null,
  } as Download;
  state.ready = Promise.resolve();
  state.rpc = rpc;
  state.settings = { defaultDownloadDir: 'D:/downloads' } as AppSettings;
  state.records.set(download.id, download);
  if (linked) state.link(download.id, 'abc');
  return { manager, state, rpc, download };
}

beforeEach(() => vi.clearAllMocks());

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
    expect(rpc.torrentStartNow).toHaveBeenCalledWith('abc');
    expect(download.status).toBe('seeding');
    expect(rpc.torrentRemove).not.toHaveBeenCalled();
  });

  it('resumes a completed torrent after restarting the app', async () => {
    const { manager, rpc, download } = fixture(false);
    download.progress = 1;
    download.status = 'completed';
    await manager.resumeDownload('test');
    expect(rpc.torrentAdd).toHaveBeenCalledWith(expect.objectContaining({ paused: true, downloadDir: 'D:/downloads' }));
    expect(rpc.torrentStartNow).toHaveBeenCalledWith('abc');
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
    expect(rpc.torrentSet.mock.invocationCallOrder[0]).toBeLessThan(rpc.torrentStartNow.mock.invocationCallOrder[0]);
  });
});
