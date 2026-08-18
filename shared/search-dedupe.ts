/**
 * Search result deduplication.
 *
 * Ask three indexers for the same film and you get the same torrent three times,
 * so choosing between rows meant reading them and guessing which were the same
 * thing. This collapses them into one row that keeps every source: the best seed
 * count wins, every provider is remembered, and every link is kept so the add
 * still has something to work with if one indexer's URL is dead.
 *
 * Results arrive progressively (one provider at a time), so merging is
 * incremental: `mergeResults` folds a new batch into the rows accumulated so far.
 *
 * Lives in `shared/` with no Electron / Node imports so it can be unit-tested in
 * isolation, alongside `search-parse.ts` and `feed-parse.ts`.
 */

import { SearchResult } from './types';

/** One torrent, with every indexer that reported it. */
export interface MergedResult extends SearchResult {
  /** Provider names that returned this torrent, in first-seen order. */
  providers: string[];
  /** Indexer names (Jackett/Prowlarr sub-trackers), where reported. */
  indexers: string[];
  /** How many separate rows collapsed into this one. */
  sourceCount: number;
}

/**
 * Sizes differ slightly between indexers for the same release (some report the
 * torrent's own length, some the payload). Treat them as equal within 1%.
 */
const SIZE_TOLERANCE = 0.01;

/**
 * Strip everything that varies between indexers describing one release:
 * punctuation used as separators, bracketed tags, and case.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')  // [group] / (year) style tags
    .replace(/[._\-+]/g, ' ')               // dots and underscores as separators
    .replace(/[^a-z0-9Ѐ-ӿ ]/g, '') // keep latin, digits and cyrillic
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Identity for exact matching. An info hash is definitive; without one we fall
 * back to the normalized title, and compare sizes separately (a bucket key
 * cannot express "within 1%").
 */
function hashKey(r: SearchResult): string | null {
  const h = (r.infoHash || '').trim().toLowerCase();
  if (h) return `h:${h}`;

  // A magnet carries the hash even when the indexer didn't break it out.
  const fromMagnet = (r.magnetUri || '').match(/xt=urn:btih:([a-z0-9]+)/i);
  if (fromMagnet) return `h:${fromMagnet[1].toLowerCase()}`;

  return null;
}

function sizesMatch(a: number, b: number): boolean {
  if (!a || !b) return true; // one side unknown — don't let it split the group
  const larger = Math.max(a, b);
  return Math.abs(a - b) / larger <= SIZE_TOLERANCE;
}

function pushUnique(list: string[], value: string | undefined): void {
  if (value && !list.includes(value)) list.push(value);
}

/** Fold one result into an existing merged row. */
function absorb(target: MergedResult, incoming: SearchResult): void {
  pushUnique(target.providers, incoming.provider);
  pushUnique(target.indexers, incoming.indexer);
  target.sourceCount += 1;

  // Seed counts are the reason to prefer one indexer's copy over another's;
  // take the best anyone reports rather than whichever answered first.
  if (incoming.seeds > target.seeds) {
    target.seeds = incoming.seeds;
    target.leechers = incoming.leechers;
  }

  // Keep the first non-empty value of everything that helps the add or the row.
  if (!target.magnetUri && incoming.magnetUri) target.magnetUri = incoming.magnetUri;
  if (!target.torrentUrl && incoming.torrentUrl) target.torrentUrl = incoming.torrentUrl;
  if (!target.infoHash && incoming.infoHash) target.infoHash = incoming.infoHash;
  if (!target.detailsUrl && incoming.detailsUrl) target.detailsUrl = incoming.detailsUrl;
  if (!target.publishDate && incoming.publishDate) target.publishDate = incoming.publishDate;
  if (!target.category && incoming.category) target.category = incoming.category;
  if (!target.imdbId && incoming.imdbId) target.imdbId = incoming.imdbId;
  if (!target.size && incoming.size) target.size = incoming.size;
  if (target.grabs === undefined && incoming.grabs !== undefined) target.grabs = incoming.grabs;
  // Freeleech on any indexer is worth surfacing.
  if (incoming.freeleech) target.freeleech = true;
}

function toMerged(r: SearchResult): MergedResult {
  return {
    ...r,
    providers: [r.provider],
    indexers: r.indexer ? [r.indexer] : [],
    sourceCount: 1,
  };
}

/**
 * Merge a new batch of results into rows already collected.
 *
 * Returns a new array (callers hold it in React state). Ordering follows first
 * appearance; sorting is the table's business, not this function's.
 */
export function mergeResults(existing: MergedResult[], incoming: SearchResult[]): MergedResult[] {
  const merged = existing.map(r => ({ ...r, providers: [...r.providers], indexers: [...r.indexers] }));

  // Exact index for hash matches; the title index needs a size check per
  // candidate, so it holds every row sharing a normalized title.
  const byHash = new Map<string, MergedResult>();
  const byTitle = new Map<string, MergedResult[]>();

  const index = (row: MergedResult) => {
    const key = hashKey(row);
    if (key) byHash.set(key, row);
    const titleKey = normalizeTitle(row.title);
    if (titleKey) {
      const bucket = byTitle.get(titleKey);
      if (bucket) bucket.push(row);
      else byTitle.set(titleKey, [row]);
    }
  };

  merged.forEach(index);

  for (const result of incoming) {
    const key = hashKey(result);
    if (key) {
      const hit = byHash.get(key);
      if (hit) {
        absorb(hit, result);
        continue;
      }
    }

    // No hash match: same normalized title AND a compatible size is the fuzzy
    // rule. Title alone would merge a 1080p and a 2160p rip whose bracketed
    // tags were stripped; size alone would merge unrelated torrents.
    //
    // Rows that BOTH carry a hash and did not match above are definitively
    // different torrents — a re-encode and its source can share a title and a
    // near-identical size, so the fuzzy rule must never overrule the hashes.
    const titleKey = normalizeTitle(result.title);
    const candidates = titleKey ? byTitle.get(titleKey) : undefined;
    const fuzzy = candidates?.find(
      c => sizesMatch(c.size, result.size) && !(key && hashKey(c))
    );
    if (fuzzy) {
      absorb(fuzzy, result);
      // A row that arrived without a hash can gain one here, so re-index it.
      const gained = hashKey(fuzzy);
      if (gained) byHash.set(gained, fuzzy);
      continue;
    }

    const row = toMerged(result);
    merged.push(row);
    index(row);
  }

  return merged;
}
