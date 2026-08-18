import { describe, it, expect } from 'vitest';
import { patternMatches, isExcluded, ruleMatches, selectForRule, rememberKeys, MAX_GRABBED_KEYS } from './rss-rules';
import { RSSItem, RSSRule } from './types';

const GB = 1024 * 1024 * 1024;

function rule(over: Partial<RSSRule> = {}): RSSRule {
  return {
    id: 'r1',
    name: 'Rule',
    enabled: true,
    feedIds: [],
    mode: 'wildcard',
    include: '',
    ...over,
  };
}

function item(over: Partial<RSSItem> = {}): RSSItem {
  return {
    guid: Math.random().toString(36),
    title: 'Some.Show.S01E01.1080p.WEB-DL-GROUP',
    link: 'magnet:?xt=urn:btih:aaaa',
    downloaded: false,
    feedId: 'feed-1',
    ...over,
  };
}

describe('patternMatches — wildcard', () => {
  it('requires every whitespace-separated token', () => {
    expect(patternMatches('show 1080p', 'Some.Show.S01E01.1080p', 'wildcard')).toBe(true);
    expect(patternMatches('show 2160p', 'Some.Show.S01E01.1080p', 'wildcard')).toBe(false);
  });

  it('ignores token order', () => {
    expect(patternMatches('1080p show', 'Some.Show.S01E01.1080p', 'wildcard')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(patternMatches('SHOW', 'some show', 'wildcard')).toBe(true);
  });

  it('expands * and ?', () => {
    expect(patternMatches('S01E*', 'Show.S01E07.1080p', 'wildcard')).toBe(true);
    expect(patternMatches('S01E0?', 'Show.S01E07.1080p', 'wildcard')).toBe(true);
    expect(patternMatches('S02E*', 'Show.S01E07.1080p', 'wildcard')).toBe(false);
  });

  it('treats an empty pattern as everything', () => {
    expect(patternMatches('', 'anything', 'wildcard')).toBe(true);
    expect(patternMatches('   ', 'anything', 'wildcard')).toBe(true);
  });

  it('does not let a dot act as a wildcard', () => {
    expect(patternMatches('a.c', 'abc', 'wildcard')).toBe(false);
    expect(patternMatches('a.c', 'a.c', 'wildcard')).toBe(true);
  });
});

describe('patternMatches — regex', () => {
  it('uses the pattern whole', () => {
    expect(patternMatches('S\\d+E\\d+', 'Show.S01E07.1080p', 'regex')).toBe(true);
    expect(patternMatches('^Other', 'Show.S01E07', 'regex')).toBe(false);
  });

  it('matches nothing when the regex is broken, rather than everything', () => {
    // A typo that grabbed the entire feed would be the expensive failure.
    expect(patternMatches('[unclosed', 'anything', 'regex')).toBe(false);
  });
});

describe('isExcluded', () => {
  it('rejects on any excluded token', () => {
    expect(isExcluded(rule({ exclude: 'hdtv cam' }), 'Show.S01E01.HDTV')).toBe(true);
    expect(isExcluded(rule({ exclude: 'hdtv cam' }), 'Show.S01E01.WEB-DL')).toBe(false);
  });

  it('excludes nothing when empty', () => {
    expect(isExcluded(rule(), 'anything')).toBe(false);
  });

  it('excludes nothing when the regex is broken', () => {
    // Opposite default to include: a broken safety net should not kill the rule.
    expect(isExcluded(rule({ mode: 'regex', exclude: '[bad' }), 'anything')).toBe(false);
  });
});

describe('ruleMatches — scope and bounds', () => {
  it('an empty feed list covers every feed', () => {
    expect(ruleMatches(rule(), item({ feedId: 'anything' }))).toBe(true);
  });

  it('a feed list restricts the rule', () => {
    const r = rule({ feedIds: ['feed-2'] });
    expect(ruleMatches(r, item({ feedId: 'feed-1' }))).toBe(false);
    expect(ruleMatches(r, item({ feedId: 'feed-2' }))).toBe(true);
  });

  it('applies size bounds', () => {
    const r = rule({ minSize: 1 * GB, maxSize: 5 * GB });
    expect(ruleMatches(r, item({ size: 3 * GB }))).toBe(true);
    expect(ruleMatches(r, item({ size: 500 * 1024 * 1024 }))).toBe(false);
    expect(ruleMatches(r, item({ size: 9 * GB }))).toBe(false);
  });

  it('applies a seed threshold', () => {
    const r = rule({ minSeeds: 10 });
    expect(ruleMatches(r, item({ seeds: 50 }))).toBe(true);
    expect(ruleMatches(r, item({ seeds: 2 }))).toBe(false);
  });

  it('does not hold an unreported size or seed count against an item', () => {
    // Most feeds publish neither; dropping everything would look like a bug.
    const r = rule({ minSize: 1 * GB, minSeeds: 10 });
    expect(ruleMatches(r, item({ size: undefined, seeds: undefined }))).toBe(true);
  });

  it('applies a maximum age', () => {
    const now = Date.parse('2026-08-18T00:00:00Z');
    const r = rule({ maxAgeDays: 7 });
    expect(ruleMatches(r, item({ pubDate: '2026-08-15T00:00:00Z' }), now)).toBe(true);
    expect(ruleMatches(r, item({ pubDate: '2026-07-01T00:00:00Z' }), now)).toBe(false);
  });

  it('applies a start-from threshold', () => {
    const r = rule({ startFrom: 'S02E03' });
    expect(ruleMatches(r, item({ title: 'Show.S02E04.1080p' }))).toBe(true);
    expect(ruleMatches(r, item({ title: 'Show.S02E01.1080p' }))).toBe(false);
  });
});

describe('selectForRule — smart episode filter', () => {
  const fourGroups = [
    item({ guid: 'a', title: 'Some.Show.S01E05.1080p.WEB-DL-ALPHA', seeds: 10 }),
    item({ guid: 'b', title: 'Some Show S01E05 720p HDTV-BETA', seeds: 90 }),
    item({ guid: 'c', title: 'some.show.s01e05.2160p.bluray-GAMMA', seeds: 30 }),
    item({ guid: 'd', title: 'Some.Show.S01E06.1080p.WEB-DL-ALPHA', seeds: 5 }),
  ];

  it('takes one copy per episode', () => {
    const { selected } = selectForRule(rule({ smartEpisode: true }), fourGroups);
    expect(selected).toHaveLength(2);
    expect(selected.map(i => i.title)).toContain('Some.Show.S01E06.1080p.WEB-DL-ALPHA');
  });

  it('prefers the best-seeded copy of an episode', () => {
    const { selected } = selectForRule(rule({ smartEpisode: true }), fourGroups);
    const e05 = selected.find(i => /S01E05/i.test(i.title));
    expect(e05?.guid).toBe('b');
  });

  it('reports what it skipped', () => {
    const { skippedDuplicates } = selectForRule(rule({ smartEpisode: true }), fourGroups);
    expect(skippedDuplicates.map(i => i.guid).sort()).toEqual(['a', 'c']);
  });

  it('takes everything when the filter is off', () => {
    const { selected } = selectForRule(rule({ smartEpisode: false }), fourGroups);
    expect(selected).toHaveLength(4);
  });

  it('skips episodes already grabbed on an earlier check', () => {
    const r = rule({ smartEpisode: true, grabbedKeys: ['some show|s1e5'] });
    const { selected, skippedDuplicates } = selectForRule(r, fourGroups);
    expect(selected.map(i => i.guid)).toEqual(['d']);
    expect(skippedDuplicates).toHaveLength(3);
  });

  it('reports the keys worth remembering', () => {
    const { newKeys } = selectForRule(rule({ smartEpisode: true }), fourGroups);
    expect(newKeys.sort()).toEqual(['some show|s1e5', 'some show|s1e6']);
  });

  it('passes through items with no episode structure', () => {
    const films = [
      item({ guid: 'f1', title: 'Some.Film.2023.1080p.BluRay' }),
      item({ guid: 'f2', title: 'Other.Film.2024.2160p.WEB-DL' }),
    ];
    const { selected } = selectForRule(rule({ smartEpisode: true }), films);
    expect(selected).toHaveLength(2);
  });

  it('respects the include pattern before deduping', () => {
    const r = rule({ smartEpisode: true, include: '1080p' });
    const { selected } = selectForRule(r, fourGroups);
    expect(selected.every(i => /1080p/i.test(i.title))).toBe(true);
  });
});

describe('rememberKeys', () => {
  it('adds new keys and skips ones already known', () => {
    const r = rule({ grabbedKeys: ['a'] });
    expect(rememberKeys(r, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('leaves the list alone when there is nothing new', () => {
    const r = rule({ grabbedKeys: ['a'] });
    expect(rememberKeys(r, [])).toEqual(['a']);
  });

  it('caps the memory, dropping the oldest', () => {
    const existing = Array.from({ length: MAX_GRABBED_KEYS }, (_, i) => `k${i}`);
    const out = rememberKeys(rule({ grabbedKeys: existing }), ['fresh']);
    expect(out).toHaveLength(MAX_GRABBED_KEYS);
    expect(out[out.length - 1]).toBe('fresh');
    expect(out).not.toContain('k0');
  });
});
