import type { RSSFeed, RSSItem, RSSRule } from './types';
import { isExcluded, patternMatches, ruleCoversFeed, ruleMatches, selectForRule } from './rss-rules';
import { episodeKey, parseRelease } from './release-parse';
export type RssForecastReason = 'candidate' | 'downloaded' | 'ignored' | 'episode-handled' | 'episode-alternative' | 'include' | 'exclude' | 'bounds';
export interface RssForecastRow { item: RSSItem; state: 'ready' | 'processed' | 'excluded'; reason: RssForecastReason }
export interface RssForecast { at: number; matched: number; ready: number; processed: number; excluded: number; rows: RssForecastRow[]; more: number }
/** Read-only forecast for an explicit run over stored inventory, never future feed posts. */
export function forecastRssRule(rule: RSSRule, items: RSSItem[], feeds: Pick<RSSFeed, 'id'>[], now = Date.now()): RssForecast {
  const known = new Set(feeds.map(feed => feed.id));
  const scoped = items.filter(item => known.has(item.feedId) && ruleCoversFeed(rule, item.feedId));
  const candidates = scoped.filter(item => !item.downloaded && !item.ignored);
  const selected = new Set(selectForRule(rule, candidates, now).selected);
  const grabbed = new Set(rule.grabbedKeys ?? []);
  let matched = 0, ready = 0, processed = 0, excluded = 0;
  const rows: RssForecastRow[] = [];
  for (const item of scoped) {
    let state: RssForecastRow['state'], reason: RssForecastReason;
    if (!ruleMatches(rule, item, now)) {
      state = 'excluded'; reason = !patternMatches(rule.include, item.title, rule.mode) ? 'include' : isExcluded(rule, item.title) ? 'exclude' : 'bounds';
    } else {
      matched++;
      const key = rule.smartEpisode ? episodeKey(parseRelease(item.title)) : null;
      if (item.downloaded || item.ignored || key && grabbed.has(key)) { state = 'processed'; reason = item.downloaded ? 'downloaded' : item.ignored ? 'ignored' : 'episode-handled'; }
      else if (!selected.has(item)) { state = 'excluded'; reason = 'episode-alternative'; }
      else { state = 'ready'; reason = 'candidate'; }
    }
    if (state === 'ready') ready++; else if (state === 'processed') processed++; else excluded++;
    if (rows.length < 100) rows.push({ item, state, reason });
  }
  return { at: now, matched, ready, processed, excluded, rows, more: Math.max(0, scoped.length - rows.length) };
}
