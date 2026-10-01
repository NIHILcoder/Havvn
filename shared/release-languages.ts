/** Optional API/plugin metadata. Reported by the source, never verified by Havvn. */
export interface ReleaseMedia {
  audioLanguages?: string[];
  subtitleLanguages?: string[];
  hasSubtitles?: boolean;
}

const aliases: Record<string, string> = {
  ru: 'rus|russian|русский|рус', en: 'eng|english|английский|англ',
  de: 'deu|ger|german|deutsch|немецкий', fr: 'fra|fre|french|français|французский',
  es: 'spa|spanish|испанский', it: 'ita|italian|итальянский',
  pt: 'por|portuguese|португальский', uk: 'ukr|ukrainian|украинский',
  pl: 'pol|polish|польский', zh: 'zho|chi|chinese|китайский',
  ja: 'jpn|japanese|японский', ko: 'kor|korean|корейский',
  hi: 'hin|hindi|хинди', ar: 'ara|arabic|арабский', tr: 'tur|turkish|турецкий',
};
export const RELEASE_LANGUAGES = Object.keys(aliases);
const boundary = (pattern: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${pattern})(?=$|[^\\p{L}\\p{N}])`, 'iu');
const findLanguages = (text: string) => RELEASE_LANGUAGES.filter(code => boundary(code + '|' + aliases[code]).test(text));

/** Accept bounded lists of recognized codes/names, not prose, URLs or guesses. */
export function normalizeReleaseLanguages(value: unknown): string[] {
  const values = Array.isArray(value) ? value.slice(0, 20) : typeof value === 'string' ? [value] : [];
  const result = new Set<string>();
  for (const item of values) {
    if (typeof item !== 'string' || item.length > 160) continue;
    for (const label of item.split(/[,;+/|]/)) {
      const text = label.trim().toLowerCase();
      const code = RELEASE_LANGUAGES.find(code => [code, ...aliases[code].split('|')].includes(text))
        ?? RELEASE_LANGUAGES.find(code => new RegExp(`^${code}[-_][a-z]{2}$`, 'i').test(text));
      if (code) result.add(code);
    }
  }
  return RELEASE_LANGUAGES.filter(code => result.has(code));
}

export function sanitizeReleaseMedia(value: unknown): ReleaseMedia | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const audioLanguages = normalizeReleaseLanguages(raw.audioLanguages);
  const subtitleLanguages = normalizeReleaseLanguages(raw.subtitleLanguages);
  // Conflicting "none" plus language labels is unknown, never silently "none".
  const hasSubtitles = typeof raw.hasSubtitles === 'boolean' ? raw.hasSubtitles : undefined;
  if (!audioLanguages.length && !subtitleLanguages.length && hasSubtitles === undefined) return undefined;
  return {
    ...(audioLanguages.length ? { audioLanguages } : {}),
    ...(subtitleLanguages.length ? { subtitleLanguages } : {}),
    ...(hasSubtitles !== undefined ? { hasSubtitles } : {}),
  };
}

/** Only explicitly labelled audio/subtitle sections. DUB and a movie's language
 * are insufficient evidence of its audio tracks; missing subtitles stay unknown. */
export function releaseLanguageHints(title: string): ReleaseMedia {
  const text = title.slice(0, 2000);
  const audio: string[] = [], subtitles: string[] = [];
  const technicalStart = text.search(/(?:^|[^\p{L}\p{N}])(?:\d{3,4}[pi]|4k|web[ .-]?dl|bdrip|bluray|hevc|x26[45])(?=$|[^\p{L}\p{N}])/iu);
  const labels = [...text.matchAll(/(?:^|[^\p{L}\p{N}])(audio|аудио|звук|язык\s+аудио|subtitles?|subs?|субтитры)(?:\s*[:=]\s*|[ ._-]+)/giu)];
  let labelledAbsence = false, labelledPresence = false, bracketedPresence = false;
  for (let index = 0; index < labels.length; index++) {
    const match = labels[index];
    const prefix = text.slice(0, match.index);
    // A movie called "Sub" or "Audio English" is not a track declaration.
    if (!/[:=]/.test(match[0]) && !(technicalStart >= 0 && match.index! >= technicalStart)
      && prefix.lastIndexOf('[') <= prefix.lastIndexOf(']') && !/\|\s*$/.test(prefix)) continue;
    const subtitle = /sub|субтитр/iu.test(match[1]);
    const body = text.slice(match.index! + match[0].length, labels[index + 1]?.index ?? text.length).slice(0, 100)
      .split(/[;|\n[\]]|\b(?:1080p|2160p|720p|HEVC|WEB-DL)\b/iu)[0];
    if (subtitle && /^(?:none|нет|отсутствуют)(?=$|[ .;,])/iu.test(body)) labelledAbsence = true;
    if (subtitle) labelledPresence = true;
    (subtitle ? subtitles : audio).push(...findLanguages(body));
  }
  for (const match of text.matchAll(/\[([^\]]{0,80})\]/g)) {
    if (boundary('subtitles?|subs?|субтитры').test(match[1])) { bracketedPresence = true; subtitles.push(...findLanguages(match[1])); }
  }
  const absent = labelledAbsence || boundary('без\\s+субтитров|no[ ._-]+(?:subs?|subtitles?)').test(text);
  const present = labelledPresence || bracketedPresence || (technicalStart >= 0 && boundary('subtitles?|subs?|субтитры').test(text.slice(technicalStart)));
  return { audioLanguages: [...new Set(audio)], subtitleLanguages: [...new Set(subtitles)],
    ...((absent || present) ? { hasSubtitles: !absent } : {}) };
}
