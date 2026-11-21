import { expect, it, vi } from 'vitest';
import { inspectDownloadHelp } from './download-help';
import type { Download, DownloadStats, TorrentFile } from '../../shared/types';
import type { EffectiveSettingsSnapshot } from '../../shared/effective-settings';
const download = { id: 'test', name: 'Film', status: 'paused', totalSize: 100, progress: .4, updatedAt: new Date(1) } as Download;
const settings = { blocks: [] } as unknown as EffectiveSettingsSnapshot;
function fixture() { return { download: vi.fn(async () => download), files: vi.fn(async (): Promise<TorrentFile[]> => []), stats: () => [] as DownloadStats[], settings: vi.fn(async () => settings) }; }
it('collects only read-only observations and keeps missing file details unknown', async () => {
  const deps = fixture(), result = await inspectDownloadHelp('test', deps);
  expect(result.reason).toBe('paused'); expect(result.selected).toBeNull(); expect(deps.files).toHaveBeenCalledExactlyOnceWith('test');
});
it('does not request files before metadata arrives', async () => {
  const deps = fixture(); deps.download.mockResolvedValue({ ...download, totalSize: 0 });
  await inspectDownloadHelp('test', deps); expect(deps.files).not.toHaveBeenCalled();
});
it('returns partial observations if guards or files cannot be read', async () => {
  const deps = fixture(); deps.files.mockRejectedValue(Error('not attached')); deps.settings.mockRejectedValue(Error('unavailable'));
  const result = await inspectDownloadHelp('test', deps); expect(result.settingsKnown).toBe(false); expect(result.filesKnown).toBe(false); expect(result.reason).toBe('paused');
});
it('discards file priorities changed while the snapshot was being assembled', async () => {
  const deps = fixture(); deps.files.mockResolvedValue([{ priority: 'skip' } as TorrentFile]);
  deps.download.mockResolvedValueOnce(download).mockResolvedValueOnce({ ...download, filePriorities: ['normal'], updatedAt: new Date(2) });
  expect((await inspectDownloadHelp('test', deps)).selected).toBeNull();
});
it('does not expose a stale object after removal', async () => {
  const deps = fixture(); deps.download.mockResolvedValueOnce(download).mockResolvedValueOnce({ ...download, status: 'removed' });
  await expect(inspectDownloadHelp('test', deps)).rejects.toThrow('Download not found');
});
