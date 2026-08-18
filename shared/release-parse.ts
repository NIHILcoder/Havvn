/**
 * Release-title parsing.
 *
 * A feed's items are just strings, so the RSS side had no notion of an episode:
 * a feed carrying four release groups delivered the same episode four times, and
 * "only new episodes" was not expressible at all. This pulls the structure out
 * of a release name — show, season, episode, quality — so a rule can reason
 * about what a row actually is.
 *
 * Deliberately heuristic. Release naming is a convention, not a standard, and
 * the useful behaviour is to recognise the common shapes and admit ignorance on
 * the rest rather than to be clever and wrong.
 *
 * Pure, with no Electron / Node imports, so it can be unit-tested in isolation
 * alongside the other parsers here.
 */

export interface ParsedRelease {
  /** Show or film name, separators normalized and tags stripped. */
  name: string;
  season?: number;
  /** First episode number. Multi-episode releases also fill `episodes`. */
  episode?: number;
  episodes?: number[];
  /** Anime-style absolute episode number, when there is no season/episode pair. */
  absolute?: number;
  /** A whole-season pack: a season with no episode. */
  seasonPack?: boolean;
  year?: number;
  resolution?: string;
  source?: string;
  codec?: string;
  group?: string;
}

/** Everything after this in a title is technical detail, not the name. */
const TAG_PATTERNS: Array<[RegExp, keyof ParsedRelease]> = [
  [/\b(2160p|1080p|720p|480p|4k|uhd)\b/i, 'resolution'],
  [/\b(bluray|blu-ray|bdrip|brrip|web-?dl|web-?rip|hdtv|dvdrip|remux|cam|ts)\b/i, 'source'],
  [/\b(x265|h\.?265|hevc|x264|h\.?264|avc|av1|xvid|divx)\b/i, 'codec'],
];

const SEASON_EPISODE = [
  // S01E05 / s1e5, with optional extra episodes: S01E01E02 or S01E01-E02
  /\bs(\d{1,3})[\s._-]?e(\d{1,4})((?:[\s._-]?e?\d{1,4})*)\b/i,
  // 1x05
  /\b(\d{1,3})x(\d{1,4})\b/i,
  // Season 1 Episode 5
  /\bseason[\s._-]?(\d{1,3})[\s._-]+episode[\s._-]?(\d{1,4})\b/i,
];

/** A season with no episode — "S02", "Season 2", "Complete Season 2". */
const SEASON_ONLY = [
  /\bs(\d{1,3})\b(?![\s._-]?e\d)/i,
  /\bseason[\s._-]?(\d{1,3})\b/i,
];

/**
 * Anime numbering: "[Group] Show - 12 [1080p]" or "Show - 12v2".
 * Anchored on the " - NN" separator, which is what distinguishes an episode
 * number from a year, a resolution, or part of the title.
 */
const ABSOLUTE = /\s-\s(\d{1,4})(?:v\d)?(?:\s|$|\[)/;

/** Release group: trailing "-GROUP", or a leading "[Group]". */
const TRAILING_GROUP = /-([a-z0-9]{2,20})$/i;
const LEADING_GROUP = /^\[([^\]]{1,30})\]/;

const YEAR = /\b(19\d{2}|20\d{2})\b/;

export function parseRelease(title: string): ParsedRelease {
  const raw = (title || '').trim();
  if (!raw) return { name: '' };

  const out: ParsedRelease = { name: '' };

  const leading = raw.match(LEADING_GROUP);
  if (leading) out.group = leading[1];

  // Work on a copy with the leading [Group] removed — it is not part of the name
  // and its digits would confuse the absolute-episode match.
  const body = leading ? raw.slice(leading[0].length).trim() : raw;

  for (const [pattern, key] of TAG_PATTERNS) {
    const hit = body.match(pattern);
    if (hit) (out[key] as string) = hit[1].toLowerCase();
  }

  if (!out.group) {
    // Only look for a trailing group after the tags: "…1080p.WEB-DL-GROUP".
    const trailing = body.match(TRAILING_GROUP);
    if (trailing && !/^\d+$/.test(trailing[1])) out.group = trailing[1];
  }

  let cutAt = body.length;

  for (const pattern of SEASON_EPISODE) {
    const hit = body.match(pattern);
    if (!hit) continue;
    out.season = parseInt(hit[1], 10);
    out.episode = parseInt(hit[2], 10);

    // Trailing episodes of a multi-episode release: "E02E03" / "-E02".
    const extra = hit[3];
    if (extra) {
      const more = extra.match(/\d{1,4}/g);
      if (more && more.length > 0) {
        out.episodes = [out.episode, ...more.map(n => parseInt(n, 10))];
      }
    }
    cutAt = Math.min(cutAt, hit.index ?? cutAt);
    break;
  }

  if (out.season === undefined) {
    for (const pattern of SEASON_ONLY) {
      const hit = body.match(pattern);
      if (!hit) continue;
      out.season = parseInt(hit[1], 10);
      out.seasonPack = true;
      cutAt = Math.min(cutAt, hit.index ?? cutAt);
      break;
    }
  }

  if (out.season === undefined && out.episode === undefined) {
    const hit = body.match(ABSOLUTE);
    if (hit) {
      out.absolute = parseInt(hit[1], 10);
      cutAt = Math.min(cutAt, hit.index ?? cutAt);
    }
  }

  const year = body.match(YEAR);
  if (year) {
    out.year = parseInt(year[1], 10);
    // A year before any episode marker ends the name too: "Show 2024 S01E01".
    if (year.index !== undefined && year.index < cutAt) cutAt = year.index;
  }

  // Anything before the first structural marker is the name; if there was no
  // marker at all, fall back to the first quality tag.
  if (cutAt === body.length) {
    const firstTag = TAG_PATTERNS.map(([p]) => body.match(p)?.index)
      .filter((i): i is number => i !== undefined)
      .sort((a, b) => a - b)[0];
    if (firstTag !== undefined) cutAt = firstTag;
  }

  out.name = cleanName(body.slice(0, cutAt));
  return out;
}

/** Normalize the name portion: separators to spaces, brackets and noise gone. */
function cleanName(part: string): string {
  return part
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s*-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Identity of the CONTENT, ignoring who released it and at what quality.
 *
 * This is what makes "one copy per episode" possible: four release groups
 * posting the same episode produce four different titles and one key. Returns
 * null when the title has no episode structure at all (a film), because there is
 * nothing to deduplicate against.
 */
export function episodeKey(parsed: ParsedRelease): string | null {
  const name = parsed.name.toLowerCase();
  if (!name) return null;

  if (parsed.season !== undefined && parsed.episode !== undefined) {
    return `${name}|s${parsed.season}e${parsed.episode}`;
  }
  if (parsed.seasonPack && parsed.season !== undefined) {
    return `${name}|s${parsed.season}|pack`;
  }
  if (parsed.absolute !== undefined) {
    return `${name}|abs${parsed.absolute}`;
  }
  return null;
}

/**
 * Is this release at or after a "start from" point like "S02E03"?
 *
 * Anything without season/episode structure passes: the threshold is about
 * episodes, and silently dropping a film because it has no season number would
 * be the wrong kind of strict.
 */
export function isAtOrAfter(parsed: ParsedRelease, startFrom: string): boolean {
  const threshold = parseStartFrom(startFrom);
  if (!threshold) return true;
  if (parsed.season === undefined) return true;

  if (parsed.season !== threshold.season) return parsed.season > threshold.season;
  // A season pack for the threshold season counts — it contains the episode.
  if (parsed.episode === undefined) return true;
  return parsed.episode >= threshold.episode;
}

/** Read "S02E03" / "2x03" / "S02" into numbers. */
export function parseStartFrom(value: string): { season: number; episode: number } | null {
  const text = (value || '').trim();
  if (!text) return null;

  const full = text.match(/^s?(\d{1,3})[\s._-]?[ex](\d{1,4})$/i);
  if (full) return { season: parseInt(full[1], 10), episode: parseInt(full[2], 10) };

  const seasonOnly = text.match(/^s?(\d{1,3})$/i);
  if (seasonOnly) return { season: parseInt(seasonOnly[1], 10), episode: 0 };

  return null;
}
