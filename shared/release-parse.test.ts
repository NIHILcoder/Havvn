import { describe, it, expect } from 'vitest';
import { parseRelease, episodeKey, isAtOrAfter, parseStartFrom } from './release-parse';

describe('parseRelease — season and episode', () => {
  it('reads the standard S01E05 form', () => {
    const r = parseRelease('Some.Show.S01E05.1080p.WEB-DL.x265-GROUP');
    expect(r.name).toBe('Some Show');
    expect(r.season).toBe(1);
    expect(r.episode).toBe(5);
  });

  it('reads lowercase and unpadded numbers', () => {
    const r = parseRelease('some show s1e5 720p');
    expect(r.season).toBe(1);
    expect(r.episode).toBe(5);
  });

  it('reads the 1x05 form', () => {
    const r = parseRelease('Some Show 1x05 HDTV');
    expect(r.season).toBe(1);
    expect(r.episode).toBe(5);
    expect(r.name).toBe('Some Show');
  });

  it('reads the spelled-out form', () => {
    const r = parseRelease('Some Show Season 2 Episode 7');
    expect(r.season).toBe(2);
    expect(r.episode).toBe(7);
  });

  it('collects a multi-episode release', () => {
    expect(parseRelease('Show.S01E01E02.1080p').episodes).toEqual([1, 2]);
    expect(parseRelease('Show.S01E01-E02.1080p').episodes).toEqual([1, 2]);
  });

  it('recognises a season pack', () => {
    const r = parseRelease('Some.Show.S02.1080p.WEB-DL');
    expect(r.season).toBe(2);
    expect(r.episode).toBeUndefined();
    expect(r.seasonPack).toBe(true);
  });

  it('does not mistake S01E01 for a season pack', () => {
    expect(parseRelease('Show.S01E01.1080p').seasonPack).toBeUndefined();
  });
});

describe('parseRelease — anime absolute numbering', () => {
  it('reads the group and the absolute episode', () => {
    const r = parseRelease('[SubGroup] Some Anime - 12 [1080p][HEVC]');
    expect(r.group).toBe('SubGroup');
    expect(r.absolute).toBe(12);
    expect(r.name).toBe('Some Anime');
  });

  it('tolerates a version suffix', () => {
    expect(parseRelease('[G] Some Anime - 07v2 [720p]').absolute).toBe(7);
  });

  it('prefers season/episode when both could be read', () => {
    const r = parseRelease('[G] Some Anime - S01E03 [1080p]');
    expect(r.season).toBe(1);
    expect(r.episode).toBe(3);
    expect(r.absolute).toBeUndefined();
  });
});

describe('parseRelease — quality tags', () => {
  it('pulls resolution, source and codec', () => {
    const r = parseRelease('Film.2023.2160p.BluRay.x265-GROUP');
    expect(r.resolution).toBe('2160p');
    expect(r.source).toBe('bluray');
    expect(r.codec).toBe('x265');
  });

  it('reads the release group from the tail', () => {
    expect(parseRelease('Show.S01E01.1080p.WEB-DL-RARBG').group).toBe('RARBG');
  });

  it('reads a year and keeps it out of the name', () => {
    const r = parseRelease('Some.Film.2023.1080p.BluRay');
    expect(r.year).toBe(2023);
    expect(r.name).toBe('Some Film');
  });

  it('ends the name at the first quality tag when there is no episode or year', () => {
    expect(parseRelease('Some.Documentary.1080p.WEB-DL').name).toBe('Some Documentary');
  });

  it('survives a title with no structure at all', () => {
    const r = parseRelease('just some words');
    expect(r.name).toBe('just some words');
    expect(r.season).toBeUndefined();
  });

  it('handles an empty title', () => {
    expect(parseRelease('').name).toBe('');
  });
});

describe('episodeKey', () => {
  it('gives four release groups of one episode a single key', () => {
    const titles = [
      'Some.Show.S01E05.1080p.WEB-DL.x265-ALPHA',
      'Some Show S01E05 720p HDTV x264-BETA',
      'some.show.s01e05.2160p.bluray-GAMMA',
      '[Group] Some Show - S01E05 [1080p]',
    ];
    const keys = new Set(titles.map(tt => episodeKey(parseRelease(tt))));
    expect(keys.size).toBe(1);
  });

  it('separates different episodes', () => {
    expect(episodeKey(parseRelease('Show.S01E05.1080p')))
      .not.toBe(episodeKey(parseRelease('Show.S01E06.1080p')));
  });

  it('separates different shows', () => {
    expect(episodeKey(parseRelease('Show A.S01E05.1080p')))
      .not.toBe(episodeKey(parseRelease('Show B.S01E05.1080p')));
  });

  it('keys a season pack apart from its episodes', () => {
    expect(episodeKey(parseRelease('Show.S02.1080p'))).toBe('show|s2|pack');
  });

  it('keys anime by absolute number', () => {
    expect(episodeKey(parseRelease('[G] Anime - 12 [1080p]'))).toBe('anime|abs12');
  });

  it('returns null for something with no episode structure', () => {
    expect(episodeKey(parseRelease('Some.Film.2023.1080p.BluRay'))).toBeNull();
    expect(episodeKey(parseRelease(''))).toBeNull();
  });
});

describe('parseStartFrom', () => {
  it('reads the common forms', () => {
    expect(parseStartFrom('S02E03')).toEqual({ season: 2, episode: 3 });
    expect(parseStartFrom('s2e3')).toEqual({ season: 2, episode: 3 });
    expect(parseStartFrom('2x03')).toEqual({ season: 2, episode: 3 });
    expect(parseStartFrom('S02')).toEqual({ season: 2, episode: 0 });
  });

  it('rejects nonsense', () => {
    expect(parseStartFrom('')).toBeNull();
    expect(parseStartFrom('later')).toBeNull();
  });
});

describe('isAtOrAfter', () => {
  const at = (title: string, from: string) => isAtOrAfter(parseRelease(title), from);

  it('accepts the threshold episode itself', () => {
    expect(at('Show.S02E03.1080p', 'S02E03')).toBe(true);
  });

  it('rejects earlier episodes of the same season', () => {
    expect(at('Show.S02E02.1080p', 'S02E03')).toBe(false);
  });

  it('rejects earlier seasons entirely', () => {
    expect(at('Show.S01E99.1080p', 'S02E03')).toBe(false);
  });

  it('accepts later seasons whatever the episode', () => {
    expect(at('Show.S03E01.1080p', 'S02E03')).toBe(true);
  });

  it('accepts a season pack of the threshold season — it contains the episode', () => {
    expect(at('Show.S02.1080p', 'S02E03')).toBe(true);
  });

  it('lets anything without a season through', () => {
    expect(at('Some.Film.2023.1080p', 'S02E03')).toBe(true);
  });

  it('lets everything through when no threshold is set', () => {
    expect(at('Show.S01E01.1080p', '')).toBe(true);
  });
});
