import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Download, SearchResult } from '../../shared/types';
const state = vi.hoisted(() => ({ stores: new Map<string, Record<string, unknown>>(), failWrite: false, warn: vi.fn() }));
vi.mock('electron-store', () => ({ default: class {
  private name: string;
  constructor(options: { name: string; defaults: Record<string, unknown> }) {
    this.name = options.name;
    if (!state.stores.has(this.name)) state.stores.set(this.name, structuredClone(options.defaults));
  }
  get(key: string) { return structuredClone(state.stores.get(this.name)?.[key]); }
  set(key: string, value: unknown) {
    if (state.failWrite) throw new Error('https://secret.test/?passkey=secret');
    state.stores.get(this.name)![key] = structuredClone(value);
  }
} }));
vi.mock('../utils/logger', () => ({ logger: { warn: state.warn } }));
import { SearchDownloadHistoryStore } from './search-download-history';
import { searchSourceHistoryKeys } from './search-source-history';
const record = { id: 'one', name: 'Film (2024) 1080p', infoHash: 'a'.repeat(40), totalSize: 1000 } as Download;
const result = { title: record.name, size: 1000, torrentUrl: 'https://site.test/download?t=12&passkey=secret' } as SearchResult;
beforeEach(() => { state.stores.clear(); state.failWrite = false; state.warn.mockClear(); });

describe('main-owned search download history', () => {
  it('restores associations and removals from a fresh store instance', () => {
    const keys = searchSourceHistoryKeys('provider', result);
    const first = new SearchDownloadHistoryStore();
    first.remember(record, keys);
    const restarted = new SearchDownloadHistoryStore();
    restarted.remember({ ...record, name: 'Renamed file' }, [], true);
    const saved = new SearchDownloadHistoryStore().get()[0];
    expect(saved.sourceKeys).toEqual(keys);
    expect(saved.removedAt).toBeGreaterThan(0);
    expect(saved.name).toBe('Renamed file');
    expect(JSON.stringify(state.stores.get('search-download-history'))).not.toMatch(/secret|passkey|torrentUrl|sourceUri/);
  });
  it('clears persistently without changing another store', () => {
    state.stores.set('downloads', { keep: true });
    const store = new SearchDownloadHistoryStore();
    store.remember(record, [], true);
    store.clear();
    expect(new SearchDownloadHistoryStore().get()).toEqual([]);
    expect(state.stores.get('downloads')).toEqual({ keep: true });
  });
  it('does not turn a successful engine operation into an add/removal failure on a disk error', () => {
    const store = new SearchDownloadHistoryStore(); state.failWrite = true;
    expect(() => store.remember(record, [], true)).not.toThrow();
    expect(state.warn).toHaveBeenCalledWith('SearchDownloadHistory', 'Could not save search download history');
    expect(JSON.stringify(state.warn.mock.calls)).not.toContain('secret');
  });
  it('keeps fingerprints stable across query order but separates sources and release identities', () => {
    const original = searchSourceHistoryKeys('provider', result);
    expect(original).toHaveLength(1);
    expect(searchSourceHistoryKeys('provider', { ...result, torrentUrl: 'https://site.test/download?passkey=secret&t=12#fragment' })).toEqual(original);
    for (const [provider, change] of [
      ['other', {}], ['provider', { title: 'Film (1984) 1080p' }],
      ['provider', { torrentUrl: 'https://site.test/download?t=13&passkey=secret' }],
    ] as const) expect(searchSourceHistoryKeys(provider, { ...result, ...change })).not.toEqual(original);
  });
  it('does not fingerprint local paths, magnets or URL credentials', () => {
    for (const torrentUrl of ['file:///private.torrent', 'magnet:?xt=anything', 'https://user:pass@site.test/t', 'bad']) {
      expect(searchSourceHistoryKeys('provider', { ...result, torrentUrl })).toEqual([]);
    }
  });
});
