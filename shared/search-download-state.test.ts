import { describe, expect, it } from 'vitest';
import type { Download } from './types';
import { downloadSearchState, indexSearchDownloads, searchResultHash } from './search-download-state';

const hex = '0123456789abcdef0123456789abcdef01234567';
const download = (fields: Partial<Download> = {}): Download => ({
  id: 'one', infoHash: hex, status: 'downloading', progress: 0.4, ...fields,
} as Download);

describe('search download identities and state', () => {
  it('matches case, base32 and percent-encoded magnets to the same torrent', () => {
    const b32 = 'AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH';
    expect(searchResultHash({ infoHash: hex.toUpperCase() })).toBe(hex);
    expect(searchResultHash({ magnetUri: `magnet:?xt=urn:btih:${b32}` })).toBe(hex);
    expect(searchResultHash({ magnetUri: `magnet:?xt=${encodeURIComponent('urn:btih:' + hex)}` })).toBe(hex);
  });
  it('does not guess from a title, a page URL or malformed hashes', () => {
    expect(searchResultHash({ infoHash: 'bad' })).toBeNull();
    expect(searchResultHash({ magnetUri: `https://site/?xt=urn:btih:${hex}` })).toBeNull();
    expect(indexSearchDownloads([download({ infoHash: undefined, sourceUri: 'https://site/download' })]).size).toBe(0);
  });
  it('falls back to a valid magnet when the separate hash is malformed', () => {
    expect(searchResultHash({ infoHash: 'bad', magnetUri: `magnet:?xt=urn:btih:${hex}` })).toBe(hex);
  });
  it('keeps paused, queued and failed partial downloads in the list', () => {
    for (const status of ['paused', 'queued', 'error', 'completed'] as const) {
      expect(downloadSearchState(download({ status }))).toBe('inDownloads');
    }
  });
  it('uses payload completion, including finished seeding and paused torrents', () => {
    for (const status of ['completed', 'seeding', 'paused'] as const) {
      expect(downloadSearchState(download({ status, progress: 1 }))).toBe('downloaded');
    }
  });
  it('excludes removed records even if their download was complete', () => {
    expect(indexSearchDownloads([download({ status: 'removed', progress: 1 })]).size).toBe(0);
  });
  it('prefers a complete copy regardless of list order', () => {
    const complete = download({ progress: 1 });
    const partial = download();
    for (const list of [[complete, partial], [partial, complete]]) {
      expect(indexSearchDownloads(list).get(hex)).toBe('downloaded');
    }
  });
  it('does not mark another torrent of the same work', () => {
    const index = indexSearchDownloads([download()]);
    expect(index.get(searchResultHash({ infoHash: 'f'.repeat(40) })!)).toBeUndefined();
  });
});
