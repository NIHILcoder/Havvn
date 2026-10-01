import { releaseLanguageHints } from './release-languages';
/** Hints from release names only, never verified media properties. */
export const RESOLUTIONS = ['2160p', '1080p', '1080i', '720p', '576p', '480p'] as const;
export const CODECS = ['HEVC', 'H.264', 'AV1', 'XviD'] as const;
export const VOICES = ['DUB', 'MVO', 'DVO', 'AVO'] as const;
export interface ReleaseMetadata {
  resolutions: string[];
  codecs: string[];
  voices: string[];
  sources: string[];
  features: string[];
  audioLanguages?: string[];
  subtitleLanguages?: string[];
  hasSubtitles?: boolean;
  year?: string;
  episode?: string;
}

const token = (pattern: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${pattern})(?=$|[^\\p{L}\\p{N}])`, 'iu');

export function parseReleaseMetadata(title: string): ReleaseMetadata {
  const text = title.slice(0, 2000);
  const resolutions = RESOLUTIONS.filter(r => token(r === '2160p' ? '2160p|4k' : r).test(text));
  const codecs = CODECS.filter((_, i) => token(['x265|h[. ]?265|hevc', 'x264|h[. ]?264|avc', 'av1', 'xvid'][i]).test(text));
  const voices = VOICES.filter((_, i) => token(['dub|дубляж|дублированный', 'mvo|мво|многоголосый', 'dvo|дво|двухголосый', 'avo|аво|одноголосый'][i]).test(text));
  const sources = ['REMUX', 'BluRay', 'WEB-DL', 'WEBRip', 'HDTV', 'DVDRip', 'CAM'].filter((_, i) =>
    token(['remux', 'blu[ .-]?ray|bdrip|brrip', 'web[ .-]?dl', 'web[ .-]?rip', 'hdtv', 'dvdrip', 'cam|camrip'][i]).test(text));
  const features = ['HDR', 'Dolby Vision'].filter((_, i) => token(['hdr(?:10)?', 'dolby[ .]?vision|dv'][i]).test(text));
  // Bracketed years are explicit release conventions; bare numeric titles
  // ("1917", "2001") and technical numbers must not become a release year.
  const year = text.match(/[[(]\s*((?:19|20)\d{2})\s*[\])]/)?.[1];
  const episode = text.match(/(?:^|[^\p{L}\p{N}])(S\d{1,2}(?:[ ._-]?E\d{1,3}(?:[ -]E?\d{1,3})?)?)(?=$|[^\p{L}\p{N}])/iu)?.[1]?.toUpperCase();
  const russianSeason = text.match(/(?:сезон\s*[:№]?\s*(\d{1,2})|(?<!\d)(\d{1,2})\s*(?:-?й\s+)?сезон)(?!\d)/iu);
  return { resolutions: [...resolutions], codecs: [...codecs], voices: [...voices], sources, features, year, ...releaseLanguageHints(text),
    episode: episode ?? (russianSeason ? `S${(russianSeason[1] || russianSeason[2]).padStart(2, '0')}` : undefined) };
}

export interface ReleaseFilters {
  resolution: string;
  codec: string;
  voice: string;
  maxGiB: string;
  includeUnknown: boolean;
}
export const DEFAULT_RELEASE_FILTERS: ReleaseFilters = {
  resolution: '', codec: '', voice: '', maxGiB: '', includeUnknown: false,
};

export function sanitizeReleaseFilters(value: unknown): ReleaseFilters {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const pick = (key: string, options: readonly string[]) => typeof v[key] === 'string' && options.includes(v[key] as string) ? v[key] as string : '';
  const size = typeof v.maxGiB === 'string' ? Number(v.maxGiB) : NaN;
  return { resolution: pick('resolution', RESOLUTIONS), codec: pick('codec', CODECS), voice: pick('voice', VOICES),
    maxGiB: Number.isFinite(size) && size > 0 ? String(size) : '', includeUnknown: v.includeUnknown === true };
}

export function matchesReleaseFilters(metadata: ReleaseMetadata, size: number, filters: ReleaseFilters): boolean {
  for (const [selected, values] of [[filters.resolution, metadata.resolutions], [filters.codec, metadata.codecs], [filters.voice, metadata.voices]] as const) {
    if (selected && !values.includes(selected) && !(filters.includeUnknown && !values.length)) return false;
  }
  const max = Number(filters.maxGiB);
  if (max > 0 && Number.isFinite(max)) {
    if (!(size > 0) || !Number.isFinite(size)) return filters.includeUnknown;
    if (size > max * 1024 ** 3) return false;
  }
  return true;
}

export function releaseChips(meta: ReleaseMetadata): string[] {
  return [...meta.resolutions, ...meta.codecs, ...meta.voices, ...meta.sources, ...meta.features, ...(meta.year ? [meta.year] : []), ...(meta.episode ? [meta.episode] : [])];
}
