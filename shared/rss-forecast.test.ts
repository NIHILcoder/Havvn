import { describe, expect, it } from 'vitest';
import { forecastRssRule } from './rss-forecast';
import { selectForRule } from './rss-rules';
import { episodeKey, parseRelease } from './release-parse';
import type { RSSItem, RSSRule } from './types';
const rule: RSSRule = { id: 'rule', name: 'Example', enabled: false, feedIds: ['feed'], mode: 'wildcard', include: 'Show', smartEpisode: true };
const item = (guid: string, title: string, extra: Partial<RSSItem> = {}): RSSItem => ({ guid, title, link: 'magnet:?xt=fixture', downloaded: false, feedId: 'feed', ...extra });
describe('RSS inventory forecast', () => {
  it('agrees with the explicit run selector while separating handled and excluded items', () => {
    const items = [item('one', 'Show S01E01', { downloaded: true }), item('two', 'Show S01E02', { ignored: true }), item('three', 'Show S01E03'), item('four', 'Other S01E04'), item('five', 'Show S01E05', { feedId: 'gone' })];
    const before = JSON.stringify(items), result = forecastRssRule(rule, items, [{ id: 'feed' }], 1000);
    expect(result).toMatchObject({ matched: 3, ready: 1, processed: 2, excluded: 1 });
    expect(result.rows.filter(row => row.state === 'ready').map(row => row.item.guid)).toEqual(selectForRule(rule, items.filter(i => !i.downloaded && !i.ignored && i.feedId === 'feed'), 1000).selected.map(i => i.guid));
    expect(JSON.stringify(items)).toBe(before); expect(rule.enabled).toBe(false);
  });
  it('uses remembered episodes and explains lower-ranked alternatives', () => {
    const remembered = item('old', 'Show S01E01'), saved = { ...rule, grabbedKeys: [episodeKey(parseRelease(remembered.title))!] };
    const result = forecastRssRule(saved, [remembered, item('weak', 'Show S01E02', { seeds: 1 }), item('strong', 'Show S01E02', { seeds: 100 })], [{ id: 'feed' }]);
    expect(result).toMatchObject({ matched: 3, processed: 1, ready: 1, excluded: 1 });
    expect(result.rows.find(row => row.item.guid === 'weak')?.reason).toBe('episode-alternative'); expect(result.rows.find(row => row.item.guid === 'strong')?.state).toBe('ready');
  });
  it('keeps every release when smart episode is disabled and reports exclusion reasons', () => {
    const result = forecastRssRule({ ...rule, smartEpisode: false, exclude: 'sample', minSize: 10 }, [item('a', 'Show sample'), item('b', 'Show S01E01', { size: 1 }), item('c', 'Show S01E01', { size: 20 }), item('d', 'Show S01E01', { size: 20 })], [{ id: 'feed' }]);
    expect(result.ready).toBe(2); expect(result.rows.map(row => row.reason)).toEqual(['exclude', 'bounds', 'candidate', 'candidate']);
  });
  it('bounds detail rows without truncating totals and excludes unknown feeds', () => {
    const result = forecastRssRule({ ...rule, smartEpisode: false }, Array.from({ length: 1000 }, (_, i) => item(String(i), 'Show ' + i)), [{ id: 'feed' }]);
    expect(result.ready).toBe(1000); expect(result.rows).toHaveLength(100); expect(result.more).toBe(900);
    expect(forecastRssRule(rule, [item('one', 'Show')], []).ready).toBe(0);
  });
});
