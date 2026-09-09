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
