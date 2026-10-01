import { expect, it } from 'vitest';
import { mergeResults } from './search-dedupe';
import { releaseComparison } from './release-comparison';
import { evaluateSearchPreferences, DEFAULT_SEARCH_PREFERENCES } from './search-preferences';
import type { SearchResult } from './types';
const base: SearchResult = { title: 'Film (2024) 1080p Audio: ENG | Subs: RUS', infoHash: 'hash', size: 10, seeds: 5, leechers: 1, provider: 'A', checkedAt: 1000 };

it('retains seed observations and receipt dates together when deduplicating providers', () => {
  const first = mergeResults([], [base]);
  const merged = mergeResults(first, [{ ...base, provider: 'B', seeds: 2, checkedAt: 2000, media: { audioLanguages: ['ru'], hasSubtitles: false } }]);
  const details = releaseComparison(merged[0]);
  expect(merged[0].seeds).toBe(5);
  expect(details.sources.map(s => [s.provider, s.seeds, s.checkedAt])).toEqual([['A', 5, 1000], ['B', 2, 2000]]);
  expect(details.title.audioLanguages).toEqual(['en']);
  expect(details.reported[0].media).toEqual({ audioLanguages: ['ru'], hasSubtitles: false });
  expect(first[0].observations).toHaveLength(1);
  expect(merged[0].title).toBe(base.title);
});
it('uses explicit API audio for preferences while keeping conflicting title evidence visible', () => {
  const [row] = mergeResults([], [{ ...base, media: { audioLanguages: ['ru'], subtitleLanguages: ['en'] } }]);
  const details = releaseComparison(row);
  expect(evaluateSearchPreferences(row, details.metadata, { ...DEFAULT_SEARCH_PREFERENCES, language: 'ru' }).score).toBe(1);
  expect(details.title.audioLanguages).toEqual(['en']);
  expect(details.reported[0].media.audioLanguages).toEqual(['ru']);
});
it('never turns subtitle language into an audio preference match', () => {
  const [row] = mergeResults([], [{ ...base, title: 'Film [RUS SUB]', media: { subtitleLanguages: ['ru'] } }]);
  expect(evaluateSearchPreferences(row, releaseComparison(row).metadata, { ...DEFAULT_SEARCH_PREFERENCES, language: 'ru' }).unknown).toEqual(['language']);
});
it('keeps different indexers and conflicting subtitle reports separate, ignoring stale repeats', () => {
  let rows = mergeResults([], [{ ...base, indexer: 'One', media: { hasSubtitles: false } }, { ...base, indexer: 'Two', checkedAt: 2000, media: { hasSubtitles: true } }]);
  rows = mergeResults(rows, [{ ...base, indexer: 'Two', checkedAt: 500, media: { hasSubtitles: false } }]);
  expect(releaseComparison(rows[0]).reported.map(r => r.media.hasSubtitles)).toEqual([false, true]);
});
