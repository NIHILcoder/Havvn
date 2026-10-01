import { expect, it } from 'vitest';
import { normalizeReleaseLanguages, releaseLanguageHints as hints, sanitizeReleaseMedia } from './release-languages';

it('separates multilingual audio and subtitle sections, including adjacent labels', () => {
  expect(hints('Film 1080p Audio: RUS, ENG | Subtitles: English, Deutsch')).toMatchObject({ audioLanguages: ['ru', 'en'], subtitleLanguages: ['en', 'de'], hasSubtitles: true });
  expect(hints('Film Аудио: русский, японский Субтитры: английский')).toMatchObject({ audioLanguages: ['ru', 'ja'], subtitleLanguages: ['en'] });
  expect(hints('Film Audio: ENG; Subtitles: RUS')).toMatchObject({ audioLanguages: ['en'], subtitleLanguages: ['ru'] });
});
it('recognizes reverse bracketed subtitle tags and dotted labels without inventing audio', () => {
  expect(hints('Film [RUS SUB]')).toMatchObject({ audioLanguages: [], subtitleLanguages: ['ru'], hasSubtitles: true });
  expect(hints('Film.1080p.Sub.Rus.Eng')).toMatchObject({ audioLanguages: [], subtitleLanguages: ['ru', 'en'] });
});
it('keeps unknown, explicit absence, and presence with unknown language distinct', () => {
  expect(hints('Film 1080p DUB')).toMatchObject({ audioLanguages: [], subtitleLanguages: [] });
  expect(hints('Film 1080p DUB').hasSubtitles).toBeUndefined();
  expect(hints('Film [Subs]').hasSubtitles).toBe(true);
  for (const title of ['Film без субтитров', 'Film [No Subs]', 'Film Subtitles: none', 'Film Субтитры: нет']) expect(hints(title).hasSubtitles).toBe(false);
});
it('does not use title language, translation type or bare language tags as audio evidence', () => {
  for (const title of ['English Film DUB', 'Русский фильм МВО', 'Film RUS ENG', 'Submarine Audioengine Russian', 'Film [ENG SUB]']) expect(hints(title).audioLanguages).toEqual([]);
  expect(hints('Audio English (2024) 1080p').audioLanguages).toEqual([]);
  expect(hints('Sub (2024) 1080p').hasSubtitles).toBeUndefined();
});
it('bounds input and accepts only explicit recognized API values', () => {
  expect(normalizeReleaseLanguages(['RUS', 'en-US', 'jpn', 'ZH', 'en', '<script>', 'not english', 5])).toEqual(['ru', 'en', 'zh', 'ja']);
  expect(sanitizeReleaseMedia({ audioLanguages: 'RUS; ENG', subtitleLanguages: ['fra'], hasSubtitles: 'false', checkedAt: 123 })).toEqual({ audioLanguages: ['ru', 'en'], subtitleLanguages: ['fr'] });
  expect(sanitizeReleaseMedia({ hasSubtitles: false })).toEqual({ hasSubtitles: false });
  expect(sanitizeReleaseMedia({ audioLanguages: ['bad'], hasSubtitles: 'yes' })).toBeUndefined();
  expect(hints('x'.repeat(2001) + ' Audio: ENG').audioLanguages).toEqual([]);
});
