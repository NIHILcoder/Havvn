import { describe, expect, it } from 'vitest';
import type { Download, SearchResult } from './types';
import {
  indexSearchDownloadHistory, matchSearchDownload, rememberSearchDownload,
  sanitizeSearchDownloadHistory, SEARCH_DOWNLOAD_HISTORY_LIMIT,
  type SearchDownloadHistoryData,
} from './search-download-history';

const hash = '0123456789abcdef0123456789abcdef01234567';
const key = 'a'.repeat(64);
const otherKey = 'b'.repeat(64);
const empty = (): SearchDownloadHistoryData => ({ version: 1, entries: [] });
const download = (fields: Partial<Download> = {}): Download => ({
  id: 'one', infoHash: hash, sourceUri: 'file:///temporary.torrent', name: 'Film (2024) 1080p DUB',
  status: 'downloading', progress: 0.2, totalSize: 10000, ...fields,
} as Download);
const result = (fields: Partial<SearchResult> = {}): SearchResult => ({
  title: 'Film (2024) 1080p DUB', size: 10000, seeds: 1, leechers: 0, provider: 'Site', ...fields,
});

describe('persistent download history in search', () => {
  it('keeps removal after serialization and normalizes hash representations', () => {
    const saved = rememberSearchDownload(empty(), download(), [key], true, 123);
    const reloaded = sanitizeSearchDownloadHistory(JSON.parse(JSON.stringify(saved)));
    const index = indexSearchDownloadHistory([], reloaded.entries);
    for (const infoHash of [hash.toUpperCase(), 'AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH']) {
      expect(matchSearchDownload(result({ infoHash }), index)).toEqual({ state: 'removed' });
    }
    expect(reloaded.entries[0].removedAt).toBe(123);
  });
  it('uses magnet identity when metadata has not arrived yet', () => {
    const saved = rememberSearchDownload(empty(), download({ infoHash: undefined, sourceUri: `magnet:?xt=urn:btih:${hash}` }), [], true);
    expect(saved.entries[0].infoHash).toBe(hash);
  });
  it.each(['paused', 'error', 'queued', 'downloading'] as const)('lets a live %s copy override removal', status => {
    const saved = rememberSearchDownload(empty(), download(), [], true);
    const live = download({ id: 'new', status });
    expect(matchSearchDownload(result({ infoHash: hash }), indexSearchDownloadHistory([live], saved.entries))).toEqual({ state: 'inDownloads' });
  });
  it('prefers completion among live duplicates without depending on their order', () => {
    const saved = rememberSearchDownload(empty(), download(), [], true);
    for (const live of [[download(), download({ id: 'two', progress: 1 })], [download({ id: 'two', progress: 1 }), download()]]) {
      expect(matchSearchDownload(result({ infoHash: hash }), indexSearchDownloadHistory(live, saved.entries))).toEqual({ state: 'downloaded' });
    }
  });
  it('handles older records with no name or size using their known hash', () => {
    const older = { id: 'older', infoHash: hash, status: 'completed', progress: 1 } as Download;
    expect(matchSearchDownload(result({ infoHash: hash }), indexSearchDownloadHistory([older], [])))
      .toEqual({ state: 'downloaded' });
  });
  it('carries all confirmed source fingerprints through metadata arrival and removal', () => {
    let saved = rememberSearchDownload(empty(), download({ infoHash: undefined }), [key]);
    saved = rememberSearchDownload(saved, download(), [otherKey], true);
    expect(saved.entries[0].sourceKeys).toEqual([otherKey, key]);
    for (const historyKeys of [[key], [otherKey]]) {
      expect(matchSearchDownload(result({ historyKeys }), indexSearchDownloadHistory([], saved.entries)))
        .toEqual({ state: 'possible', previousState: 'removed' });
    }
  });
  it('resolves a fresh hashless search conservatively against a live source association', () => {
    const live = download({ progress: 1 });
    const saved = rememberSearchDownload(empty(), live, [key]);
    expect(matchSearchDownload(result({ historyKeys: [key] }), indexSearchDownloadHistory([live], saved.entries)))
      .toEqual({ state: 'possible', previousState: 'downloaded' });
  });
  it('never overrides an explicit different hash with a URL or a title match', () => {
    const saved = rememberSearchDownload(empty(), download(), [key], true);
    expect(matchSearchDownload(result({ historyKeys: [key], infoHash: 'f'.repeat(40) }), indexSearchDownloadHistory([], saved.entries))).toBeNull();
  });
  it('does not infer removal from a vanished active entry or a failed add rollback', () => {
    const saved = rememberSearchDownload(empty(), download(), [key]);
    expect(matchSearchDownload(result({ historyKeys: [key] }), indexSearchDownloadHistory([], saved.entries))).toBeNull();
  });
  it('allows only a complete title plus close known payload size as a weak fallback', () => {
    const saved = rememberSearchDownload(empty(), download(), [], true);
    const index = indexSearchDownloadHistory([], saved.entries);
    expect(matchSearchDownload(result({ title: 'FILM  (2024) 1080p DUB', size: 10050 }), index)?.state).toBe('possible');
    for (const fields of [
      { title: 'Film (1984) 1080p DUB' }, { title: 'Film (2024) 720p DUB' },
      { title: 'Film (2024) 1080p MVO' }, { title: 'Film S01E02 (2024) 1080p DUB' },
      { size: 0 }, { size: 12000 },
    ]) expect(matchSearchDownload(result(fields), index)).toBeNull();
  });
  it('clearing forgets removed entries but keeps live download status', () => {
    const index = indexSearchDownloadHistory([download()], []);
    expect(matchSearchDownload(result({ infoHash: hash }), index)).toEqual({ state: 'inDownloads' });
    expect(matchSearchDownload(result({ infoHash: 'f'.repeat(40) }), index)).toBeNull();
    expect(matchSearchDownload(result({ infoHash: hash }), indexSearchDownloadHistory([], []))).toBeNull();
  });
  it('re-adding an existing id revives its association without retaining removal', () => {
    const removed = rememberSearchDownload(empty(), download(), [key], true, 1);
    const revived = rememberSearchDownload(removed, download(), [], false, 2);
    expect(revived.entries[0].removedAt).toBeUndefined();
    expect(revived.entries[0].sourceKeys).toEqual([key]);
  });
  it('bounds disk data, strips unknown fields and tolerates malformed records', () => {
    const entry = rememberSearchDownload(empty(), download(), [key], true, 1).entries[0];
    const entries = Array.from({ length: SEARCH_DOWNLOAD_HISTORY_LIMIT + 2 }, (_, i) => ({
      ...entry, downloadId: String(i), updatedAt: i, sourceUri: 'https://site/?passkey=secret',
      sourceKeys: Array.from({ length: 30 }, (_, j) => j.toString(16).padStart(64, '0')),
    }));
    const clean = sanitizeSearchDownloadHistory({ version: 1, entries });
    expect(clean.entries).toHaveLength(SEARCH_DOWNLOAD_HISTORY_LIMIT);
    expect(clean.entries[0].downloadId).toBe(String(SEARCH_DOWNLOAD_HISTORY_LIMIT + 1));
    expect(clean.entries[0].sourceKeys).toHaveLength(20);
    expect(JSON.stringify(clean)).not.toContain('secret');
    expect(sanitizeSearchDownloadHistory({ version: 99, entries }).entries).toEqual([]);
    expect(sanitizeSearchDownloadHistory({ version: 1, entries: [null, {}, { ...entry, infoHash: {} }, { ...entry, updatedAt: NaN }] }).entries)
      .toEqual([{ ...entry, infoHash: undefined }].map(({ infoHash: _hash, ...rest }) => rest));
  });
});
