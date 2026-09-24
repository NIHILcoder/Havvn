import { expect, it } from 'vitest';
import { parseReleaseMetadata } from './release-metadata';
import { audioLanguageHints, evaluateSearchPreferences, sanitizeSearchPreferences, SEARCH_PREFERENCE_PRESETS } from './search-preferences';

it('validates stored preferences and rejects corrupt or extreme values', () => {
  expect(sanitizeSearchPreferences({ resolution: '8K', voice: 'bad', language: 'xx', maxGiB: 'Infinity', minSeeds: '-1' }))
    .toEqual({ resolution: '', voice: '', language: '', maxGiB: '', minSeeds: '' });
  expect(sanitizeSearchPreferences({ minSeeds: '4.9', maxGiB: '1.5' }).minSeeds).toBe('4');
  expect(sanitizeSearchPreferences(null).maxGiB).toBe('');
});
it('awards only known matching criteria and gives concrete reasons', () => {
  const title = 'Film 1080p DUB Audio: RUS';
  const match = evaluateSearchPreferences({ title, size: 10 * 1024 ** 3, seeds: 10 }, parseReleaseMetadata(title),
    { ...SEARCH_PREFERENCE_PRESETS.hd, voice: 'DUB', language: 'ru' });
  expect(match.score).toBe(5);
  expect(match.matched).toEqual(['resolution', 'voice', 'language', 'maxGiB', 'minSeeds']);
});
it('does not reward unknown metadata, unknown size or missing language', () => {
  const match = evaluateSearchPreferences({ title: 'Film', size: 0, seeds: 0 }, parseReleaseMetadata('Film'),
    { ...SEARCH_PREFERENCE_PRESETS.hd, language: 'ru' });
  expect(match.score).toBe(0);
  expect(match.unknown).toEqual(['resolution', 'language', 'maxGiB']);
});
it('keeps a nonmatching release available with a lower score', () => {
  const title = 'Film 2160p';
  const result = { title, size: 50 * 1024 ** 3, seeds: 20 };
  expect(evaluateSearchPreferences(result, parseReleaseMetadata(title), SEARCH_PREFERENCE_PRESETS.hd).score).toBe(1);
});
it('does not infer audio from the title, dubbing, or subtitles', () => {
  for (const title of ['English Film DUB', 'Film [RUS SUB]', 'Субтитры: русский', 'Film Audio: ENG; Subtitles: RUS']) {
    expect(audioLanguageHints(title)).not.toContain('ru');
  }
  expect(audioLanguageHints('Film Аудио: русский, английский | Субтитры: русский')).toEqual(['ru', 'en']);
});
