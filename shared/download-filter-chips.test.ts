import { describe, expect, it } from 'vitest';
import { activeDownloadConditions, clearDownloadCondition } from './download-filter-chips';
import type { DownloadViewConditions } from './download-views';

describe('temporary download filter conditions', () => {
  const all: DownloadViewConditions = { status: 'paused', category: null, name: 'Movie', path: 'D:/Archive', minBytes: 0, maxBytes: 500 };
  it('includes uncategorized and zero bounds, without inventing inactive conditions', () => {
    expect(activeDownloadConditions(all)).toEqual(['status', 'category', 'name', 'path', 'minBytes', 'maxBytes']);
    expect(activeDownloadConditions({ status: 'all', name: '', path: '' })).toEqual([]);
  });
  it.each(['status', 'category', 'name', 'path', 'minBytes', 'maxBytes'] as const)('removes only %s and never changes its input', key => {
    const next = clearDownloadCondition(all, key);
    expect(activeDownloadConditions(next)).not.toContain(key);
    for (const other of Object.keys(all) as Array<keyof DownloadViewConditions>) if (other !== key) expect(next[other]).toEqual(all[other]);
    expect(activeDownloadConditions(all)).toHaveLength(6);
  });
  it('clears to the neutral conditions without retaining an optional zero bound', () => {
    expect(clearDownloadCondition(all)).toEqual({ status: 'all', name: '', path: '' });
  });
});
