import { beforeEach, expect, it, vi } from 'vitest';
import type { Download } from '../../../shared/types';
import { TrStatus } from './transmission-rpc';

vi.mock('../../utils', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../host/db-bridge', () => ({ updateDownloadStatus: vi.fn().mockResolvedValue(undefined) }));
import { NativeTorrentManager } from './native-manager';
import * as db from '../host/db-bridge';

beforeEach(() => vi.clearAllMocks());

it('recovers a falsely failed tracker error without restarting the transfer', async () => {
  const manager = new NativeTorrentManager();
  const state = manager as any;
  state.settings = { maxDownKbps: 0 };
  state.rpc = { torrentStop: vi.fn(), torrentStartNow: vi.fn() };
  const download = { id: 'test', totalSize: 100, status: 'error', lastError: 'User not found' } as Download;
  await state.applyTransitions(download, { status: TrStatus.Downloading, error: 2, errorString: 'User not found',
    percentDone: 0.3, downloadedEver: 30, uploadedEver: 10, metadataPercentComplete: 1 });
  expect(download.status).toBe('downloading');
  expect(download.lastError).toBeNull();
  expect(download.downloadedBytes).toBe(30);
  expect(db.updateDownloadStatus).toHaveBeenCalledWith('test', 'downloading', undefined);
  expect(state.rpc.torrentStop).not.toHaveBeenCalled();
  expect(state.rpc.torrentStartNow).not.toHaveBeenCalled();
});

it('still reports a local engine error as a failed download', async () => {
  const manager = new NativeTorrentManager();
  (manager as any).settings = { maxDownKbps: 0 };
  const download = { id: 'test', totalSize: 100, status: 'downloading', lastError: null } as Download;
  await (manager as any).applyTransitions(download, { status: TrStatus.Downloading, error: 3,
    errorString: 'No space left on device', percentDone: 0.3, downloadedEver: 30, uploadedEver: 0, metadataPercentComplete: 1 });
  expect(download.status).toBe('error');
  expect(download.lastError).toBe('No space left on device');
});
