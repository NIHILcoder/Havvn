import { describe, it, expect } from 'vitest';
import {
  parseScriptOutput,
  sanitizeString,
  sanitizeCount,
  SCRIPT_MAX_RESULTS,
} from './search-parse';

it('sanitizes optional source media and ignores plugin-supplied check timestamps', () => {
  const [result] = parseScriptOutput(JSON.stringify([{ title: 'Film', infoHash: 'abc', checkedAt: 1,
    media: { audioLanguages: ['ENG'], subtitleLanguages: ['RUS', '<script>'], hasSubtitles: false } }]), 'Example');
  expect(result.media).toEqual({ audioLanguages: ['en'], subtitleLanguages: ['ru'], hasSubtitles: false });
  expect(result.checkedAt).toBeUndefined();
});

describe('sanitizeString', () => {
  it('trims and stringifies', () => {
    expect(sanitizeString('  hi  ')).toBe('hi');
    expect(sanitizeString(42)).toBe('42');
  });

  it('returns empty for null/undefined', () => {
    expect(sanitizeString(null)).toBe('');
    expect(sanitizeString(undefined)).toBe('');
  });

  it('caps length at 2000 chars', () => {
    expect(sanitizeString('a'.repeat(5000))).toHaveLength(2000);
  });
});

describe('sanitizeCount', () => {
  it('accepts non-negative integers from numbers and strings', () => {
    expect(sanitizeCount(10)).toBe(10);
    expect(sanitizeCount('25')).toBe(25);
    expect(sanitizeCount(3.9)).toBe(3); // floored
  });

  it('coerces junk and negatives to 0', () => {
    expect(sanitizeCount(-5)).toBe(0);
    expect(sanitizeCount('abc')).toBe(0);
    expect(sanitizeCount(null)).toBe(0);
    expect(sanitizeCount(NaN)).toBe(0);
    expect(sanitizeCount(Infinity)).toBe(0);
  });
});

describe('parseScriptOutput', () => {
  it('returns [] for empty output', () => {
    expect(parseScriptOutput('', 'P')).toEqual([]);
    expect(parseScriptOutput('   \n  ', 'P')).toEqual([]);
  });

  it('parses a well-formed array and stamps the provider name', () => {
    const json = JSON.stringify([
      {
        title: 'Ubuntu 24.04',
        magnetUri: 'magnet:?xt=urn:btih:abc',
        size: 1610612736,
        seeds: 42,
        leechers: 3,
        publishDate: '2026-06-17',
        category: 'Linux',
        infoHash: 'abc',
      },
    ]);
    const [r] = parseScriptOutput(json, 'MyProvider');
    expect(r).toEqual({
      title: 'Ubuntu 24.04',
      magnetUri: 'magnet:?xt=urn:btih:abc',
      torrentUrl: undefined,
      size: 1610612736,
      seeds: 42,
      leechers: 3,
      provider: 'MyProvider',
      publishDate: '2026-06-17',
      category: 'Linux',
      infoHash: 'abc',
    });
  });

  it('accepts a { results: [...] } wrapper', () => {
    const json = JSON.stringify({
      results: [{ title: 'X', torrentUrl: 'https://e/x.torrent' }],
    });
    const out = parseScriptOutput(json, 'P');
    expect(out).toHaveLength(1);
    expect(out[0].torrentUrl).toBe('https://e/x.torrent');
  });

  it('supports alias field names (magnet/url/link, seeders/peers, hash, date)', () => {
    const json = JSON.stringify([
      { title: 'A', magnet: 'magnet:?xt=urn:btih:1', seeders: '7', peers: '2', date: 'today' },
      { title: 'B', url: 'https://e/b.torrent' },
      { title: 'C', link: 'magnet:?xt=urn:btih:3' },
      { title: 'D', hash: 'deadbeef' },
    ]);
    const out = parseScriptOutput(json, 'P');
    expect(out.map(r => r.title)).toEqual(['A', 'B', 'C', 'D']);
    expect(out[0].magnetUri).toBe('magnet:?xt=urn:btih:1');
    expect(out[0].seeds).toBe(7);
    expect(out[0].leechers).toBe(2);
    expect(out[0].publishDate).toBe('today');
    expect(out[1].torrentUrl).toBe('https://e/b.torrent');
    expect(out[2].magnetUri).toBe('magnet:?xt=urn:btih:3'); // magnet in `link` routes to magnetUri
    expect(out[3].infoHash).toBe('deadbeef');
  });

  it('rejects unsafe link schemes (file://, javascript:, data:)', () => {
    const json = JSON.stringify([
      { title: 'evil1', torrentUrl: 'file:///etc/passwd' },
      { title: 'evil2', magnetUri: 'javascript:alert(1)' },
      { title: 'evil3', link: 'data:text/html,<script>x</script>' },
      { title: 'evil4', torrentUrl: 'ftp://host/x.torrent' },
      { title: 'ok', torrentUrl: 'https://e/x.torrent' },
    ]);
    const out = parseScriptOutput(json, 'P');
    expect(out.map(r => r.title)).toEqual(['ok']);
  });

  it('keeps a row whose unsafe url is rejected but still has an infoHash', () => {
    const json = JSON.stringify([
      { title: 'X', torrentUrl: 'file:///nope', infoHash: 'cafebabe' },
    ]);
    const [r] = parseScriptOutput(json, 'P');
    expect(r.torrentUrl).toBeUndefined();
    expect(r.infoHash).toBe('cafebabe');
  });

  it('drops rows without a title or without any fetch source', () => {
    const json = JSON.stringify([
      { title: '', magnetUri: 'magnet:?xt=urn:btih:1' }, // no title
      { title: 'No link here' },                          // no magnet/url/hash
      { magnetUri: 'magnet:?xt=urn:btih:2' },             // no title
      { title: 'Keeper', magnetUri: 'magnet:?xt=urn:btih:3' },
    ]);
    const out = parseScriptOutput(json, 'P');
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Keeper');
  });

  it('skips non-object rows without throwing', () => {
    const json = JSON.stringify([
      null,
      42,
      'string',
      ['nested'],
      { title: 'Real', magnetUri: 'magnet:?xt=urn:btih:1' },
    ]);
    const out = parseScriptOutput(json, 'P');
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Real');
  });

  it('coerces hostile numeric fields to safe integers', () => {
    const json = JSON.stringify([
      { title: 'Evil', magnetUri: 'magnet:?xt=urn:btih:1', size: -999, seeds: 'NaN', leechers: 1e9 + 0.5 },
    ]);
    const [r] = parseScriptOutput(json, 'P');
    expect(r.size).toBe(0);
    expect(r.seeds).toBe(0);
    expect(r.leechers).toBe(1000000000);
  });

  it('caps an oversized result set', () => {
    const rows = Array.from({ length: SCRIPT_MAX_RESULTS + 50 }, (_, i) => ({
      title: `T${i}`,
      magnetUri: `magnet:?xt=urn:btih:${i}`,
    }));
    const out = parseScriptOutput(JSON.stringify(rows), 'P');
    expect(out).toHaveLength(SCRIPT_MAX_RESULTS);
  });

  it('throws a clear error on non-JSON', () => {
    expect(() => parseScriptOutput('not json at all', 'P')).toThrow(/valid JSON/);
  });

  it('throws when the JSON is not an array or results-wrapper', () => {
    expect(() => parseScriptOutput('{"foo":1}', 'P')).toThrow(/array of results/);
    expect(() => parseScriptOutput('"a string"', 'P')).toThrow(/array of results/);
    expect(() => parseScriptOutput('123', 'P')).toThrow(/array of results/);
  });
});
