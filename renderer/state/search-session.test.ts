import { describe, expect, it } from 'vitest';
import { createSearchSession, type SearchSession } from './search-session';
import type { MergedResult } from '../../shared/search-dedupe';
const snapshot = (): SearchSession => ({ query: 'edited query', term: 'original', rows: [], hasSearched: true, interrupted: true,
  providerStats: [], sortKey: 'size', sortDesc: false, refine: '1080', minSeeds: 2, hideDead: true, providerFilter: 'A',
  expandedGroups: ['group'], addCategoryId: 'films', addPaused: true, scrollTop: 1200, capturedAt: 10 });
describe('window-local search session', () => {
  it('restores a draft query separately from the original results and view position', () => {
    const cache = createSearchSession(), value = snapshot(); cache.save(value);
    expect(cache.read()).toMatchObject(value); cache.clear(); expect(cache.read()).toBeNull();
  });
  it('bounds retained rows, groups and providers and tells the UI about truncation', () => {
    const cache = createSearchSession(), value = snapshot();
    value.rows = Array.from({ length: 10_001 }, (_, n) => ({ title: String(n) }) as MergedResult);
    value.expandedGroups = Array.from({ length: 10_001 }, (_, n) => String(n));
    cache.save(value); expect(cache.read()!.rows).toHaveLength(10_000); expect(cache.read()!.truncated).toBe(true);
    expect(cache.read()!.expandedGroups).toHaveLength(10_000); value.rows.push({ title: 'late' } as MergedResult);
    expect(cache.read()!.rows).toHaveLength(10_000);
  });
});
