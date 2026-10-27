import { describe, expect, it, vi } from 'vitest';
import type { Download } from '../../shared/types';
import { runDownloadBatch } from './download-batch';
describe('download group actions', () => {
  it('reports partial failures and skips incompatible statuses without hiding the failure', async () => {
    const rows = new Map([['a', { status: 'downloading' }], ['b', { status: 'paused' }], ['c', { status: 'seeding' }]] as Array<[string, Download]>);
    const api = { pauseDownload: vi.fn(async (id: string) => { if (id === 'c') throw Error('offline'); }), resumeDownload: vi.fn() };
    const result = await runDownloadBatch(['a', 'a', 'b', 'c', 'missing'], 'pause', () => rows, api);
    expect(result.succeeded).toEqual(['a']); expect(result.skipped).toEqual(['b', 'missing']); expect(result.failed.map(f => f.id)).toEqual(['c']);
    api.pauseDownload.mockResolvedValue(undefined); await runDownloadBatch(result.failed.map(f => f.id), 'pause', () => rows, api);
    expect(api.pauseDownload.mock.calls.map(call => call[0])).toEqual(['a', 'c', 'c']);
  });
  it('bounds command concurrency while rechecking each current status', async () => {
    let active = 0, max = 0;
    const api = { pauseDownload: vi.fn(), resumeDownload: vi.fn(async () => { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; }) };
    const rows = new Map(Array.from({ length: 20 }, (_, n) => [String(n), { status: 'paused' } as Download]));
    const result = await runDownloadBatch(rows.keys(), 'resume', () => rows, api); expect(result.succeeded).toHaveLength(20); expect(max).toBe(3);
  });
});
