import { describe, it, expect } from 'vitest';
import { mergeResults, normalizeTitle, MergedResult } from './search-dedupe';
import { SearchResult } from './types';

const GB = 1024 * 1024 * 1024;

function result(over: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Some Release 1080p',
    size: 4 * GB,
    seeds: 10,
    leechers: 2,
    provider: 'Jackett',
    ...over,
  };
}

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('normalizeTitle', () => {
  it('erases the separators indexers disagree about', () => {
    expect(normalizeTitle('Some.Release.1080p')).toBe(normalizeTitle('Some Release 1080p'));
    expect(normalizeTitle('Some_Release_1080p')).toBe(normalizeTitle('Some-Release-1080p'));
  });

  it('drops bracketed tags', () => {
    expect(normalizeTitle('[Group] Show 01 (2024)')).toBe('show 01');
  });

  it('keeps cyrillic', () => {
    expect(normalizeTitle('Сезон 1 [Лост]')).toBe('сезон 1');
  });
});

describe('mergeResults — hash matching', () => {
  it('collapses the same info hash from different providers', () => {
    const merged = mergeResults([], [
      result({ provider: 'Jackett', infoHash: HASH_A, seeds: 10 }),
      result({ provider: 'Prowlarr', infoHash: HASH_A.toUpperCase(), seeds: 40 }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].providers).toEqual(['Jackett', 'Prowlarr']);
    expect(merged[0].sourceCount).toBe(2);
  });

  it('takes the best seed count and its matching leechers', () => {
    const merged = mergeResults([], [
      result({ infoHash: HASH_A, seeds: 10, leechers: 1 }),
      result({ provider: 'B', infoHash: HASH_A, seeds: 40, leechers: 7 }),
      result({ provider: 'C', infoHash: HASH_A, seeds: 5, leechers: 99 }),
    ]);

    expect(merged[0].seeds).toBe(40);
    expect(merged[0].leechers).toBe(7);
  });

  it('reads the hash out of a magnet when the field is missing', () => {
    const merged = mergeResults([], [
      result({ provider: 'A', infoHash: HASH_A }),
      result({ provider: 'B', magnetUri: `magnet:?xt=urn:btih:${HASH_A}&dn=x` }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].providers).toEqual(['A', 'B']);
  });

  it('keeps different hashes apart', () => {
    const merged = mergeResults([], [
      result({ infoHash: HASH_A }),
      result({ infoHash: HASH_B }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('fills in links the first row lacked', () => {
    const merged = mergeResults([], [
      result({ provider: 'A', infoHash: HASH_A, torrentUrl: undefined, magnetUri: undefined }),
      result({ provider: 'B', infoHash: HASH_A, magnetUri: `magnet:?xt=urn:btih:${HASH_A}` }),
      result({ provider: 'C', infoHash: HASH_A, torrentUrl: 'https://x.test/a.torrent', detailsUrl: 'https://x.test/a' }),
    ]);

    expect(merged[0].magnetUri).toContain(HASH_A);
    expect(merged[0].torrentUrl).toBe('https://x.test/a.torrent');
    expect(merged[0].detailsUrl).toBe('https://x.test/a');
  });

  it('surfaces freeleech reported by any single indexer', () => {
    const merged = mergeResults([], [
      result({ infoHash: HASH_A }),
      result({ provider: 'B', infoHash: HASH_A, freeleech: true }),
    ]);
    expect(merged[0].freeleech).toBe(true);
  });
});

describe('mergeResults — fuzzy matching', () => {
  it('collapses the same title and size written differently', () => {
    const merged = mergeResults([], [
      result({ provider: 'A', title: 'Some.Release.1080p', size: 4 * GB }),
      result({ provider: 'B', title: 'Some Release 1080p', size: 4 * GB }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].sourceCount).toBe(2);
  });

  it('tolerates a small size disagreement', () => {
    const merged = mergeResults([], [
      result({ provider: 'A', size: 4 * GB }),
      result({ provider: 'B', size: Math.round(4 * GB * 1.005) }),
    ]);
    expect(merged).toHaveLength(1);
  });

  it('keeps sizes that differ beyond the tolerance apart', () => {
    const merged = mergeResults([], [
      result({ provider: 'A', size: 4 * GB }),
      result({ provider: 'B', size: 8 * GB }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('does not merge different releases of the same show', () => {
    const merged = mergeResults([], [
      result({ title: 'Show S01E01 1080p', size: 2 * GB }),
      result({ title: 'Show S01E02 1080p', size: 2 * GB }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('lets a hash-bearing row absorb a later one matched fuzzily', () => {
    const merged = mergeResults([], [
      result({ provider: 'A', title: 'Some.Release.1080p', infoHash: HASH_A }),
      result({ provider: 'B', title: 'Some Release 1080p' }),
      result({ provider: 'C', infoHash: HASH_A }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].providers).toEqual(['A', 'B', 'C']);
  });
});

describe('mergeResults — incremental use', () => {
  it('folds each provider batch into the rows collected so far', () => {
    let rows: MergedResult[] = [];
    rows = mergeResults(rows, [result({ provider: 'A', infoHash: HASH_A, seeds: 5 })]);
    expect(rows).toHaveLength(1);

    rows = mergeResults(rows, [result({ provider: 'B', infoHash: HASH_A, seeds: 50 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].seeds).toBe(50);
    expect(rows[0].providers).toEqual(['A', 'B']);

    rows = mergeResults(rows, [result({ provider: 'C', infoHash: HASH_B })]);
    expect(rows).toHaveLength(2);
  });

  it('does not mutate the array it was given', () => {
    const first = mergeResults([], [result({ infoHash: HASH_A })]);
    const snapshot = JSON.parse(JSON.stringify(first));

    mergeResults(first, [result({ provider: 'B', infoHash: HASH_A })]);
    expect(first).toEqual(snapshot);
  });

  it('preserves first-appearance order', () => {
    const rows = mergeResults([], [
      result({ title: 'First', infoHash: HASH_A, seeds: 1 }),
      result({ title: 'Second', infoHash: HASH_B, seeds: 99 }),
    ]);
    expect(rows.map(r => r.title)).toEqual(['First', 'Second']);
  });

  it('handles an empty batch', () => {
    const rows = mergeResults([], []);
    expect(rows).toEqual([]);
  });

  it('records the sub-indexer behind an aggregator', () => {
    const rows = mergeResults([], [
      result({ provider: 'Jackett', indexer: 'Tracker One', infoHash: HASH_A }),
      result({ provider: 'Jackett', indexer: 'Tracker Two', infoHash: HASH_A }),
    ]);

    expect(rows[0].providers).toEqual(['Jackett']);
    expect(rows[0].indexers).toEqual(['Tracker One', 'Tracker Two']);
  });
});
