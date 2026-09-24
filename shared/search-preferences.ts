import type { SearchResult } from './types';
import { RESOLUTIONS, VOICES, type ReleaseMetadata } from './release-metadata';

export interface SearchPreferences {
  resolution: string;
  voice: string;
  language: string;
  maxGiB: string;
  minSeeds: string;
}
export const DEFAULT_SEARCH_PREFERENCES: SearchPreferences = { resolution: '', voice: '', language: '', maxGiB: '', minSeeds: '' };
export const SEARCH_PREFERENCE_PRESETS: Record<string, SearchPreferences> = {
  hd: { ...DEFAULT_SEARCH_PREFERENCES, resolution: '1080p', maxGiB: '15', minSeeds: '5' },
  uhd: { ...DEFAULT_SEARCH_PREFERENCES, resolution: '2160p', maxGiB: '40', minSeeds: '5' },
  compact: { ...DEFAULT_SEARCH_PREFERENCES, resolution: '720p', maxGiB: '5', minSeeds: '3' },
};

export function sanitizeSearchPreferences(input: unknown): SearchPreferences {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const choice = (key: string, values: readonly string[]) => typeof value[key] === 'string' && values.includes(value[key] as string) ? value[key] as string : '';
  const number = (key: string, integer = false) => {
    const n = typeof value[key] === 'string' ? Number(value[key]) : NaN;
    return Number.isFinite(n) && n > 0 && n <= 1000000 ? String(integer ? Math.max(1, Math.floor(n)) : n) : '';
  };
  return { resolution: choice('resolution', RESOLUTIONS), voice: choice('voice', VOICES),
    language: choice('language', ['ru', 'en']), maxGiB: number('maxGiB'), minSeeds: number('minSeeds', true) };
}

/** Only explicit audio labels, never the title language or a subtitle label. */
export function audioLanguageHints(title: string): string[] {
  const hints: string[] = [];
  const labels = [...title.slice(0, 2000).matchAll(/(?:audio|аудио|звук|язык\s+аудио)\s*[:=]\s*([^;|\n[\]]{1,80})/giu)].map(match => match[1].split(/subtitles?|субтитры/iu)[0]);
  const text = labels.join(' ');
  if (/(?:^|[^\p{L}])(?:rus|russian|русский|рус)(?=$|[^\p{L}])/iu.test(text)) hints.push('ru');
  if (/(?:^|[^\p{L}])(?:eng|english|английский|англ)(?=$|[^\p{L}])/iu.test(text)) hints.push('en');
  return hints;
}

export type PreferenceCriterion = 'resolution' | 'voice' | 'language' | 'maxGiB' | 'minSeeds';
export interface PreferenceMatch { score: number; matched: PreferenceCriterion[]; unknown: PreferenceCriterion[]; total: number }

export function evaluateSearchPreferences(result: Pick<SearchResult, 'title' | 'size' | 'seeds'>, metadata: ReleaseMetadata, preferences: SearchPreferences): PreferenceMatch {
  const matched: PreferenceCriterion[] = [];
  const unknown: PreferenceCriterion[] = [];
  let total = 0;
  const check = (criterion: PreferenceCriterion, enabled: boolean, known: boolean, matches: boolean) => {
    if (!enabled) return;
    total++;
    if (!known) unknown.push(criterion);
    else if (matches) matched.push(criterion);
  };
  const languages = preferences.language ? audioLanguageHints(result.title) : [];
  check('resolution', !!preferences.resolution, metadata.resolutions.length > 0, metadata.resolutions.includes(preferences.resolution));
  check('voice', !!preferences.voice, metadata.voices.length > 0, metadata.voices.includes(preferences.voice));
  check('language', !!preferences.language, languages.length > 0, languages.includes(preferences.language));
  check('maxGiB', Number(preferences.maxGiB) > 0, Number.isFinite(result.size) && result.size > 0, result.size <= Number(preferences.maxGiB) * 1024 ** 3);
  check('minSeeds', Number(preferences.minSeeds) > 0, Number.isFinite(result.seeds) && result.seeds >= 0, result.seeds >= Number(preferences.minSeeds));
  return { score: matched.length, matched, unknown, total };
}
