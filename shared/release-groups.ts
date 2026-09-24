import type { MergedResult } from './search-dedupe';
import { parseReleaseMetadata } from './release-metadata';

export interface ReleaseIdentity {
  key: string;
  title: string;
  year?: string;
  episode?: string;
}
export interface ReleaseGroup {
  key: string;
  title: string;
  year?: string;
  episode?: string;
  releases: MergedResult[];
}

const normalize = (name: string) => name.normalize('NFKC').toLowerCase()
  .replace(/[._]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Work identity is deliberately stricter than torrent deduplication.
 * No alias matching, guessed years/languages, or merging unknown episode ranges.
 */
export function releaseIdentity(row: MergedResult): ReleaseIdentity | null {
  const text = row.title.slice(0, 2000);
  const meta = parseReleaseMetadata(text);
  const category = row.category || '';
  if (/^(?:3|4|6|7|8)\d{3}$/.test(category) || /music|software|games|xxx|музык|софт|игры/iu.test(category)) return null;
  const imdb = row.imdbId?.match(/^(?:tt)?(\d{7,10})$/i)?.[1];
  if (!imdb && !meta.resolutions.length && !meta.sources.length && !/^(?:2|5)\d{3}$/.test(category)) return null;

  // A range of seasons or multiple works must remain a separate result.
  if (/сезон[\p{L}]*\s*[:№]?\s*\d+\s*[-–,]\s*\d+|S\d+\s*[-–,]\s*S?\d+|сборник|антология|collection|anthology/iu.test(text)) return null;
  const seasonMarkers = [...text.matchAll(/(?:^|[^\p{L}\p{N}])S\d{1,2}(?=E|[^\p{L}\p{N}]|$)/giu)];
  if (seasonMarkers.length > 1) return null;
  let episode = meta.episode;
  if (episode) {
    const match = episode.match(/^S(\d+)(?:[ ._-]?E(\d+)(?:[ -]E?(\d+))?)?$/i);
    if (!match) return null;
    episode = `S${match[1].padStart(2, '0')}`;
    if (match[2]) episode += `E${match[2].padStart(2, '0')}`;
    if (match[3]) episode += `-${match[3].padStart(2, '0')}`;
  }
  if (/сери[яий]|эпизод/iu.test(text)) {
    const match = text.match(/(?:серии?|эпизод\w*)\s*[:№]?\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?(?=\s|[\],)]|$)/iu);
    if (!episode || !match || episode.includes('E')) return null;
    episode += `E${match[1].padStart(2, '0')}${match[2] ? '-' + match[2].padStart(2, '0') : ''}`;
    // Lists such as "1, 3, 5" cannot be represented by one episode range.
    if (/\d\s*,\s*\d/.test(text.slice(match.index! + match[0].length))) return null;
  }
  const isSeries = /^(?:5)\d{3}$/.test(category) || /сериал|series|tv/iu.test(category)
    || /сезон|серии|эпизод|\bseason\b|\bepisode\b/iu.test(text) || seasonMarkers.length > 0
    || /(?:^|[^\p{L}\p{N}])E\d+(?=$|[^\p{L}\p{N}])/iu.test(text) || !!episode;
  if (isSeries && !episode) return null;

  const years = [...text.matchAll(/[[(]\s*((?:19|20)\d{2})(?=\s|[,;/\])])/g)];
  if (years.length > 1) return null;
  const yearMatch = years[0] || text.match(/[ ._-]((?:19|20)\d{2})(?=[ ._-]+(?:\d{3,4}[pi]|4K|WEB|Blu|BDRip|HDR|S\d))/i);
  const year = yearMatch?.[1];
  if (!year && !imdb) return null;

  let title = yearMatch ? text.slice(0, yearMatch.index) : text;
  title = title.replace(/(?:^|[^\p{L}\p{N}])(?:S\d{1,2}(?:E\d+)?|сезон(?=$|[^\p{L}\p{N}])|\d+\s*(?:-?й\s+)?сезон(?=$|[^\p{L}\p{N}])|\d{3,4}[pi]\b|4K\b|WEB[ .-]?(?:DL|Rip)\b|Blu[ .-]?Ray\b|BDRip\b)[\s\S]*$/iu, '')
    .replace(/\[[^\]]*\]/g, '').replace(/[._]/g, ' ').replace(/[\s/|—–-]+$/g, '').trim();
  const name = normalize(title);
  if (!name || (!imdb && (!/\p{L}/u.test(name) || name.length < 2))) return null;
  const kind = isSeries ? 'series' : 'movie';
  return { key: JSON.stringify([imdb ? `imdb:${imdb}` : name, year || '', kind, episode || '']), title, year, episode };
}

/** Preserve row objects and all source references; ordering follows the caller. */
export function groupReleases(rows: readonly MergedResult[]): ReleaseGroup[] {
  const groups: ReleaseGroup[] = [];
  const byIdentity = new Map<string, ReleaseGroup>();
  for (const row of rows) {
    const identity = releaseIdentity(row);
    if (!identity) {
      groups.push({ key: `release:${row.infoHash || row.magnetUri || row.torrentUrl || JSON.stringify([row.title, row.size])}`,
        title: row.title, releases: [row] });
      continue;
    }
    let group = byIdentity.get(identity.key);
    if (!group) {
      group = { ...identity, key: `work:${identity.key}`, releases: [] };
      byIdentity.set(identity.key, group);
      groups.push(group);
    }
    group.releases.push(row);
  }
  return groups;
}
