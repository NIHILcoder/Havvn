import { describe, expect, it } from 'vitest';
import { parseReleaseMetadata as parse, matchesReleaseFilters as matches, sanitizeReleaseFilters, DEFAULT_RELEASE_FILTERS as defaults } from './release-metadata';

describe('release title hints', () => {
  it('normalizes codec and resolution aliases', () => {
    expect(parse('Film (2024) 4K HEVC x265 WEB-DL DUB')).toMatchObject({resolutions:['2160p'], codecs:['HEVC'], voices:['DUB'], sources:['WEB-DL'], year:'2024'});
  });
  it('retains conflicting/multiple editions without guessing one', () => {
    expect(parse('Collection 720p / 1080p x264 x265').resolutions).toEqual(['1080p','720p']);
    expect(parse('Collection x264 x265').codecs).toEqual(['HEVC','H.264']);
  });
  it('recognizes Russian voice labels and season', () => {
    expect(parse('Сериал [2023] 2 сезон МВО 1080p')).toMatchObject({voices:['MVO'], episode:'S02',year:'2023'});
    expect(parse('Сериал Сезон: 12')).toMatchObject({episode:'S12'});
  });
  it('keeps episode ranges', () => {
    expect(parse('Show.S02E03-E05.1080p').episode).toBe('S02E03-E05');
  });
  it('does not match parts of words or invent absent data', () => {
    expect(parse('Cambridge Dubstep av128 x2650').codecs).toEqual([]);
    expect(parse('Cambridge Dubstep').voices).toEqual([]);
    expect(parse('Cambridge').sources).toEqual([]);
    expect(parse('1917 1080p').year).toBeUndefined();
    expect(parse('2001: A Space Odyssey').year).toBeUndefined();
    expect(parse('Ubuntu 24.04')).toMatchObject({resolutions:[],codecs:[],voices:[],sources:[]});
  });
  it('distinguishes interlaced releases', () => {
    expect(parse('Film 1080i H.264').resolutions).toEqual(['1080i']);
  });
  it('preserves HDR and Dolby Vision hints', () => {
    expect(parse('Film 2160p HDR10 DV').features).toEqual(['HDR', 'Dolby Vision']);
  });
});

describe('release filters', () => {
  it('requires all selected fields to match', () => {
    const filters = {...defaults,resolution:'1080p',codec:'HEVC',voice:'DUB',maxGiB:'15'};
    expect(matches(parse('Film 1080p HEVC DUB'),14*1024**3,filters)).toBe(true);
    expect(matches(parse('Film 720p HEVC DUB'),14*1024**3,filters)).toBe(false);
    expect(matches(parse('Film 1080p HEVC DUB'),16*1024**3,filters)).toBe(false);
  });
  it('includes unknown only when explicitly requested, never known mismatches', () => {
    const filters = {...defaults,resolution:'1080p',maxGiB:'1'};
    expect(matches(parse('Film'),0,filters)).toBe(false);
    expect(matches(parse('Film'),0,{...filters,includeUnknown:true})).toBe(true);
    expect(matches(parse('Film 720p'),0,{...filters,includeUnknown:true})).toBe(false);
  });
  it('treats size limit as inclusive and supports decimals', () => {
    expect(matches(parse('Film'),1.5*1024**3,{...defaults,maxGiB:'1.5'})).toBe(true);
    expect(matches(parse('Film'),1.5*1024**3+1,{...defaults,maxGiB:'1.5'})).toBe(false);
  });
  it('does not filter general searches by default', () => {
    expect(matches(parse('Linux'),0,defaults)).toBe(true);
  });
  it('validates persisted settings', () => {
    expect(sanitizeReleaseFilters({resolution:'8k',codec:3,voice:'anything',maxGiB:'Infinity',includeUnknown:'true'})).toEqual(defaults);
    expect(sanitizeReleaseFilters(null)).toEqual(defaults);
    expect(sanitizeReleaseFilters({...defaults,resolution:'1080p',maxGiB:'1.5'})).toMatchObject({resolution:'1080p',maxGiB:'1.5'});
  });
});
