import { describe, expect, it } from 'vitest';
import { explainDownload } from './download-help';
import type { Download, DownloadStats, TorrentFile } from './types';
import type { EffectiveSettingsSnapshot } from './effective-settings';
import { downloadOperation } from './download-operation';

const download = { id: 'test', name: 'Film', status: 'downloading', totalSize: 100, progress: .4, selectedFiles: [] } as Download;
const stats = { id: 'test', status: 'downloading', peers: 0, downSpeedBps: 0, progress: .4 } as DownloadStats;
const file = { name: 'Film.mp4', path: 'Film.mp4', length: 100, downloaded: 40, progress: .4, priority: 'normal' } as TorrentFile;
const settings = { blocks: [] } as unknown as EffectiveSettingsSnapshot;
describe('download waiting explanations', () => {
  it('does not interpret an empty saved selection as zero selected files', () => {
    expect(explainDownload(download, stats, settings, [file]).reason).toBe('no-peers');
    expect(explainDownload(download, stats, settings, [file]).selected).toBe(1);
  });
  it('requires known full priorities to explain no files', () => {
    expect(explainDownload(download, stats, settings, [{ ...file, priority: 'skip' }]).reason).toBe('no-files');
    expect(explainDownload(download, stats, settings, [{ ...file, priority: undefined }]).selected).toBeNull();
    expect(explainDownload(download, stats, settings, []).reason).toBe('no-peers');
  });
  it('does not reuse file selection before metadata is known', () => {
    expect(explainDownload({ ...download, totalSize: 0 }, stats, settings, [{ ...file, priority: 'skip' }]).reason).toBe('metadata');
  });
  it('explains completion of selected files separately from full torrent progress', () => {
    const result = explainDownload(download, stats, settings, [{ ...file, downloaded: 100 }, { ...file, priority: 'skip' }]);
    expect(result.reason).toBe('selected-complete'); expect(result.selected).toBe(1); expect(result.actions).not.toContain('resume');
  });
  it.each(['disk', 'vpn'] as const)('uses a confirmed %s transfer guard', block => {
    const result = explainDownload({ ...download, status: 'paused' }, undefined, { ...settings, blocks: [block] }, null);
    expect(result.reason).toBe(block); expect(result.actions).not.toContain('resume');
  });
  it('does not infer a guard from a timeout or zero speed', () => {
    expect(explainDownload(download, { ...stats, peers: 2 }, null, null).reason).toBe('unknown');
    expect(explainDownload(download, undefined, null, null).reason).toBe('no-report');
  });
  it.each(['paused', 'queued', 'error', 'completed', 'removed'] as const)('explains %s without fresh telemetry', status => {
    const expected = { paused: 'paused', queued: 'queued', error: 'failed', completed: 'finished', removed: 'removed' };
    expect(explainDownload({ ...download, status }, undefined, null, null).reason).toBe(expected[status]);
  });
  it('ignores telemetry for another torrent or an earlier status', () => {
    expect(explainDownload({ ...download, status: 'paused' }, stats, settings, null).reason).toBe('paused');
    expect(explainDownload(download, { ...stats, id: 'other' }, settings, null).peers).toBeNull();
  });
  it('does not describe malformed telemetry as connected peers or positive transfer', () => {
    expect(explainDownload(download, { ...stats, peers: -1 }, settings, null).reason).toBe('no-report');
    expect(explainDownload(download, { ...stats, downSpeedBps: Infinity }, settings, null).rate).toBeNull();
    expect(explainDownload(download, { ...stats, downSpeedBps: Infinity }, settings, null).reason).toBe('no-report');
  });
  it('offers the current guard remedy for an errored download without bypassing protection', () => {
    expect(explainDownload({ ...download, status: 'error' }, undefined, { ...settings, blocks: ['disk'] }, null).actions).toEqual(['storage', 'limits']);
  });
  it('verification outranks earlier completion and disallows resume', () => {
    const completed = { ...download, status: 'completed' as const, progress: 1 };
    const result = explainDownload(completed, { ...stats, status: 'completed', operation: downloadOperation(completed, { stage: 'checking' }) }, settings, [file]);
    expect(result.reason).toBe('checking'); expect(result.actions).not.toContain('resume');
  });
  it('reports positive transfer and preserves the snapshot collection time', () => {
    const result = explainDownload(download, { ...stats, peers: 2, downSpeedBps: 200 }, settings, null, 1234);
    expect(result.reason).toBe('transferring'); expect(result.checkedAt).toBe(1234);
  });
});
