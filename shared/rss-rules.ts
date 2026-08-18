/**
 * RSS auto-download rule matching.
 *
 * Pure and Electron-free so the service, the UI preview and the tests all share
 * one definition of "does this rule match this item" — a preview that disagreed
 * with what actually gets downloaded would be worse than no preview.
 */

import { RSSItem, RSSRule } from './types';
import { episodeKey, isAtOrAfter, parseRelease } from './release-parse';

/** Episode keys remembered per rule before the oldest are dropped. */
export const MAX_GRABBED_KEYS = 500;

/**
 * Turn one wildcard token into a regex.
 * `*` is any run of characters, `?` is one; everything else is literal.
 */
function wildcardToRegex(token: string): RegExp {
  // One pass: the wildcards become their regex equivalents and every other
  // special character is escaped. Doing it in two passes needs a placeholder,
  // and any placeholder can appear in a real pattern.
  const escaped = token.replace(/[.+^${}()|[\]\\*?]/g, ch => {
    if (ch === '*') return '.*';
    if (ch === '?') return '.';
    return `\\${ch}`;
  });
  return new RegExp(escaped, 'i');
}

/**
 * Does the title satisfy the pattern?
 *
 * In wildcard mode the pattern is split on whitespace and EVERY token must
 * appear — "show name 1080p" means all three, in any order, which is how people
 * read a filter box. A token carrying `*` or `?` is matched as a wildcard;
 * anything else is a plain case-insensitive substring.
 *
 * In regex mode the pattern is used whole. An invalid regex matches nothing
 * rather than everything: a rule that silently grabbed the entire feed because
 * of a typo would be the expensive failure.
 */
export function patternMatches(pattern: string, title: string, mode: 'wildcard' | 'regex'): boolean {
  const text = (pattern || '').trim();
  if (!text) return true; // an empty include means "everything from these feeds"

  if (mode === 'regex') {
    try {
      return new RegExp(text, 'i').test(title);
    } catch {
      return false;
    }
  }

  const haystack = title.toLowerCase();
  return text.split(/\s+/).every(token => {
    if (/[*?]/.test(token)) return wildcardToRegex(token).test(title);
    return haystack.includes(token.toLowerCase());
  });
}

/** Any excluded token present rejects the item. Empty means nothing is excluded. */
export function isExcluded(rule: RSSRule, title: string): boolean {
  const text = (rule.exclude || '').trim();
  if (!text) return false;

  if (rule.mode === 'regex') {
    try {
      return new RegExp(text, 'i').test(title);
    } catch {
      // Unlike include, a broken exclude excludes nothing — failing open on the
      // safety net beats failing closed on the whole rule.
      return false;
    }
  }

  const haystack = title.toLowerCase();
  return text.split(/\s+/).some(token => {
    if (/[*?]/.test(token)) return wildcardToRegex(token).test(title);
    return haystack.includes(token.toLowerCase());
  });
}

/** Is this rule allowed to act on items from this feed? */
export function ruleCoversFeed(rule: RSSRule, feedId: string): boolean {
  return rule.feedIds.length === 0 || rule.feedIds.includes(feedId);
}

/**
 * Everything except episode bookkeeping: feed scope, text, size, seeds, age.
 * Bounds the feed didn't report are not held against the item — most feeds
 * publish no seed count, and silently dropping everything would look like a
 * broken rule.
 */
export function ruleMatches(rule: RSSRule, item: RSSItem, now: number = Date.now()): boolean {
  if (!ruleCoversFeed(rule, item.feedId)) return false;
  if (!patternMatches(rule.include, item.title, rule.mode)) return false;
  if (isExcluded(rule, item.title)) return false;

  if (rule.minSize !== undefined && item.size !== undefined && item.size < rule.minSize) return false;
  if (rule.maxSize !== undefined && item.size !== undefined && item.size > rule.maxSize) return false;
  if (rule.minSeeds !== undefined && item.seeds !== undefined && item.seeds < rule.minSeeds) return false;

  if (rule.maxAgeDays !== undefined && item.pubDate) {
    const published = Date.parse(item.pubDate);
    if (Number.isFinite(published) && now - published > rule.maxAgeDays * 86400000) return false;
  }

  if (rule.startFrom && !isAtOrAfter(parseRelease(item.title), rule.startFrom)) return false;

  return true;
}

export interface RuleSelection {
  /** Items to download now. */
  selected: RSSItem[];
  /** Episode keys to remember, so a re-post doesn't come back around. */
  newKeys: string[];
  /** Matched but skipped because the episode was already taken. */
  skippedDuplicates: RSSItem[];
}

/**
 * Choose what a rule should actually grab from a batch of items.
 *
 * With `smartEpisode` on, a feed carrying four release groups of one episode
 * yields one download: candidates are grouped by episode identity and the
 * best-seeded (then first-seen) one wins. Episodes already taken on an earlier
 * check are remembered on the rule and skipped.
 */
export function selectForRule(
  rule: RSSRule,
  items: RSSItem[],
  now: number = Date.now()
): RuleSelection {
  const matched = items.filter(item => ruleMatches(rule, item, now));

  if (!rule.smartEpisode) {
    return { selected: matched, newKeys: [], skippedDuplicates: [] };
  }

  const alreadyGrabbed = new Set(rule.grabbedKeys || []);
  const chosen = new Map<string, RSSItem>();
  const selected: RSSItem[] = [];
  const skippedDuplicates: RSSItem[] = [];

  // Best-seeded first, so the winner of each episode group is the one most
  // likely to actually download; ties keep feed order.
  const ranked = [...matched].sort((a, b) => (b.seeds ?? 0) - (a.seeds ?? 0));

  for (const item of ranked) {
    const key = episodeKey(parseRelease(item.title));

    // No episode structure (a film, say) — nothing to deduplicate against.
    if (!key) {
      selected.push(item);
      continue;
    }
    if (alreadyGrabbed.has(key)) {
      skippedDuplicates.push(item);
      continue;
    }
    if (chosen.has(key)) {
      skippedDuplicates.push(item);
      continue;
    }
    chosen.set(key, item);
    selected.push(item);
  }

  return { selected, newKeys: [...chosen.keys()], skippedDuplicates };
}

/** Fold newly grabbed keys into a rule's memory, keeping the most recent. */
export function rememberKeys(rule: RSSRule, keys: string[]): string[] {
  if (keys.length === 0) return rule.grabbedKeys || [];
  const merged = [...(rule.grabbedKeys || []), ...keys.filter(k => !(rule.grabbedKeys || []).includes(k))];
  return merged.length > MAX_GRABBED_KEYS ? merged.slice(-MAX_GRABBED_KEYS) : merged;
}
