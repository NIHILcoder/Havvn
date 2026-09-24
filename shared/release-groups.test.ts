import { describe, expect, it } from 'vitest';
import { groupReleases, releaseIdentity } from './release-groups';
import type { MergedResult } from './search-dedupe';

const row = (title: string, overrides: Partial<MergedResult> = {}): MergedResult => ({
  title, size: 1024, seeds: 10, leechers: 1, provider: 'Test', providers: ['Test'], indexers: [], sourceCount: 1,
  infoHash: title, sourceRefs: [title], ...overrides,
});

describe('conservative work grouping', () => {
  it('groups quality and voice variants without mutating releases or losing source identities', () => {
    const releases = [row('Arrival (2016) 1080p HEVC DUB'), row('Arrival (2016) 720p H.264 MVO')];
    const before = structuredClone(releases);
    const groups = groupReleases(releases);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Arrival');
    expect(groups[0].releases[0]).toBe(releases[0]);
    expect(groups[0].releases[1]).toBe(releases[1]);
    expect(releases).toEqual(before);
  });
  it('recognizes common Russian year brackets and dotted English release names', () => {
    expect(groupReleases([row('Фильм [2024, драма] WEB-DL 1080p'), row('Фильм (2024) BluRay 720p')])).toHaveLength(1);
    expect(groupReleases([row('Arrival.2016.1080p.WEB-DL'), row('Arrival (2016) 720p')])).toHaveLength(1);
  });
  it('keeps remakes and missing years separate', () => {
    expect(groupReleases([row('Dune (1984) 1080p'), row('Dune (2021) 720p'), row('Dune 1080p'), row('Dune 720p')])).toHaveLength(4);
  });
  it('retains numeric titles instead of interpreting them as years', () => {
    const identity = releaseIdentity(row('1917 (2019) 1080p'));
    // Numeric-only names are deliberately not grouped without a catalog id.
    expect(identity).toBeNull();
    expect(groupReleases([row('1917 (2019) 1080p', { imdbId: 'tt8579674' }), row('1917 (2019) 720p', { imdbId: 'tt8579674' })])).toHaveLength(1);
    expect(groupReleases([row('2001: A Space Odyssey (1968) 1080p'), row('2001 A Space Odyssey (1968) 720p')])).toHaveLength(1);
  });
  it('separates seasons, episode numbers, ranges and season packs', () => {
    expect(groupReleases(['S01', 'S02', 'S01E01', 'S01E02', 'S01E01-03'].map(scope => row(`Show (2024) ${scope} 1080p`)))).toHaveLength(5);
    expect(groupReleases([row('Show (2024) S1 E2 1080p'), row('Show (2024) S01E02 720p')])).toHaveLength(1);
  });
  it('groups Russian season markers and distinguishes episode ranges', () => {
    expect(groupReleases([row('Сериал (2024) Сезон 1 1080p'), row('Сериал (2024) 1 сезон 720p')])).toHaveLength(1);
    expect(groupReleases([row('Сериал Сезон 1 (2024) 1080p'), row('Сериал (2024) S01 720p')])).toHaveLength(1);
    expect(groupReleases([row('Сериал (2024) Сезон 1, серии: 1-8 1080p'), row('Сериал (2024) Сезон 1, серии: 1-4 720p')])).toHaveLength(2);
  });
  it('does not guess ambiguous season packs, collections or episode lists', () => {
    for (const scope of ['S01-S03', 'Сезоны 1-3', 'Сезон 1, серии: 1, 3, 5', 'Collection']) {
      expect(releaseIdentity(row(`Show (2024) ${scope} 1080p`)), scope).toBeNull();
    }
  });
  it('does not merge series with unknown episode scope', () => {
    expect(groupReleases([row('Show (2024) 1080p', { category: '5000' }), row('Show (2024) 720p', { category: '5000' })])).toHaveLength(2);
    for (const scope of ['E01', 'Season 1 Episode 2', 'S01E01E02', 'Season 1']) {
      expect(releaseIdentity(row(`Show (2024) ${scope} 1080p`)), scope).toBeNull();
    }
  });
  it('uses catalog ids for titles in different languages but retains year and episode boundaries', () => {
    const a = row('Прибытие (2016) 1080p', { imdbId: 'tt2543164' });
    const b = row('Arrival (2016) 720p', { imdbId: '2543164' });
    expect(groupReleases([a, b])).toHaveLength(1);
    expect(groupReleases([a, { ...b, imdbId: 'tt9999999' }])).toHaveLength(2);
    expect(groupReleases([a, { ...b, title: 'Arrival (2024) 720p' }])).toHaveLength(2);
  });
  it('keeps different title aliases separate without a catalog id', () => {
    expect(groupReleases([row('Прибытие / Arrival (2016) 1080p'), row('Arrival (2016) 720p')])).toHaveLength(2);
  });
  it('does not group software, music, or titles with multiple explicit years', () => {
    for (const category of ['4000', 'Music', 'Игры']) expect(releaseIdentity(row('Film (2024) 1080p', { category }))).toBeNull();
    expect(releaseIdentity(row('Show (2023) (2024) 1080p'))).toBeNull();
  });
  it('keeps group keys stable as variants arrive or sort order changes', () => {
    const a = row('Film (2024) 720p');
    const b = row('Film (2024) 1080p');
    expect(groupReleases([a])[0].key).toBe(groupReleases([b, a])[0].key);
    expect(groupReleases([b, a])[0].releases).toEqual([b, a]);
  });
  it('includes every row exactly once, even when no metadata can be read', () => {
    const releases = [row('unknown'), row('another'), row('Film (2024) 1080p'), row('Film (2024) 720p')];
    expect(groupReleases(releases).flatMap(group => group.releases)).toEqual(releases);
    expect(groupReleases([])).toEqual([]);
  });
});
