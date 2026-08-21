/**
 * RSS Service
 * Manages RSS feed subscriptions, polling, and auto-download of new torrent items.
 */

import { app } from 'electron';
import { logger, httpFetch, decodeBody } from '../utils';
import { showOsNotification } from '../utils/os-notify';
import { t } from '../i18n';
import * as db from '../db/store';
import { RSSFeed, RSSItem, RSSRule } from '../../shared/types';
import { parseFeed } from '../../shared/feed-parse';
import { ruleCoversFeed, selectForRule, rememberKeys, isRssInventorySeeded, keysToRemember } from '../../shared/rss-rules';
import { getTorrentManager } from '../torrent';

const log = logger.child('RSSService');

/** Feeds are XML documents; anything past this is not a feed. */
const MAX_FEED_BYTES = 10 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 15000;

/**
 * Spread scheduled checks by up to ±10% of the interval. Without it every feed
 * left on the default 30 minutes fires in the same instant, which looks like a
 * burst to trackers that rate-limit.
 */
function jitter(intervalMs: number): number {
  const spread = intervalMs * 0.1;
  return Math.max(60_000, Math.round(intervalMs + (Math.random() * 2 - 1) * spread));
}

/** Cap on how far a failing feed's interval is stretched. */
const MAX_BACKOFF_MULTIPLIER = 16;

/**
 * How long to wait before the next attempt. A feed that keeps failing doubles
 * its interval each time, up to 16×, so a dead URL is retried occasionally
 * rather than on the dot every thirty minutes forever.
 */
function backoffMultiplier(consecutiveFailures = 0): number {
  if (consecutiveFailures <= 0) return 1;
  return Math.min(2 ** consecutiveFailures, MAX_BACKOFF_MULTIPLIER);
}

export class RSSService {
  private checkTimers: Map<string, NodeJS.Timeout> = new Map();
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Existing per-feed filters become rules before anything runs, so an upgrade
    // doesn't silently stop working subscriptions.
    const migrated = await db.migrateRSSFiltersToRules();
    if (migrated > 0) log.info(`Migrated ${migrated} feed filters into rules`);

    const feeds = await db.getRSSFeeds();
    log.info(`Initializing RSS service with ${feeds.length} feeds`);

    const overdue: RSSFeed[] = [];
    for (const feed of feeds) {
      if (!feed.enabled) continue;
      this.scheduleCheck(feed);
      if (this.isOverdue(feed)) overdue.push(feed);
    }

    // Arming a timer is not enough: a feed on a 6-hour interval whose last check
    // was yesterday would stay silent for another 6 hours after every restart.
    // Anything already past due gets checked now, staggered so they don't all
    // leave at once.
    overdue.forEach((feed, idx) => {
      const delay = 3000 + idx * 2000;
      setTimeout(() => {
        this.checkFeed(feed.id).catch(err => {
          log.error('Catch-up RSS feed check failed', { feedId: feed.id, error: err });
        });
      }, delay).unref?.();
    });

    if (overdue.length > 0) {
      log.info(`Scheduled catch-up checks for ${overdue.length} overdue feeds`);
    }
  }

  /** True when the feed has never been checked, or is past its interval. */
  private isOverdue(feed: RSSFeed): boolean {
    if (!feed.lastChecked) return true;
    const last = Date.parse(feed.lastChecked);
    if (!Number.isFinite(last)) return true;
    return Date.now() - last >= (feed.intervalMinutes || 30) * 60 * 1000;
  }

  private scheduleCheck(feed: RSSFeed): void {
    // Clear existing timer
    this.clearTimer(feed.id);

    const base = (feed.intervalMinutes || 30) * 60 * 1000;
    const multiplier = backoffMultiplier(feed.consecutiveFailures);
    const intervalMs = jitter(base * multiplier);

    const timer = setInterval(async () => {
      try {
        await this.checkFeed(feed.id);
      } catch (err) {
        // checkFeed already recorded the failure and rescheduled with backoff.
        log.debug('Scheduled RSS check failed', { feedId: feed.id, error: String(err) });
      }
    }, intervalMs);

    this.checkTimers.set(feed.id, timer);
    log.debug('Scheduled RSS feed check', {
      feedId: feed.id,
      intervalMinutes: feed.intervalMinutes,
      backoff: multiplier > 1 ? multiplier : undefined,
    });
  }

  private clearTimer(feedId: string): void {
    const existing = this.checkTimers.get(feedId);
    if (existing) {
      clearInterval(existing);
      this.checkTimers.delete(feedId);
    }
  }

  async addFeed(feedData: Omit<RSSFeed, 'id'>): Promise<RSSFeed> {
    const feed = await db.addRSSFeed(feedData);
    if (feed.enabled) {
      this.scheduleCheck(feed);
      // Check immediately on add
      this.checkFeed(feed.id).catch(err => {
        log.error('Initial RSS feed check failed', { feedId: feed.id, error: err });
      });
    }
    return feed;
  }

  async updateFeed(id: string, updates: Partial<RSSFeed>): Promise<RSSFeed> {
    const feed = await db.updateRSSFeed(id, updates);
    // Reschedule if enabled state or interval changed
    if (feed.enabled) {
      this.scheduleCheck(feed);
    } else {
      this.clearTimer(id);
    }
    return feed;
  }

  async removeFeed(id: string): Promise<void> {
    this.clearTimer(id);
    await db.removeRSSFeed(id);
  }

  async checkFeed(feedId: string): Promise<RSSItem[]> {
    const feeds = await db.getRSSFeeds();
    const feed = feeds.find(f => f.id === feedId);
    if (!feed) throw new Error(`RSS feed not found: ${feedId}`);

    log.info('Checking RSS feed', { name: feed.name, url: feed.url });

    // First successful inventory of this feed? Then everything in it is history,
    // not news — store the items but never auto-download the whole backlog.
    // lastChecked is written on failed attempts too, so it is not this gate.
    const isFirstCheck = !isRssInventorySeeded(feed);
    const checkedAt = new Date().toISOString();

    let fetched;
    try {
      fetched = await this.fetchFeed(feed);
    } catch (err) {
      // Record the failure on the feed itself and let the caller see it too.
      const message = err instanceof Error ? err.message : String(err);
      const failures = (feed.consecutiveFailures || 0) + 1;
      await db.updateRSSFeed(feedId, {
        lastChecked: checkedAt,
        lastStatus: 'failed',
        lastError: message,
        consecutiveFailures: failures,
      });
      // Back off so a dead feed isn't hammered on its normal interval.
      this.scheduleCheck({ ...feed, consecutiveFailures: failures });
      log.warn('RSS feed check failed', { name: feed.name, error: message, failures });
      throw err;
    }

    // 304: the server says nothing changed, so there is nothing to parse.
    if (fetched.notModified) {
      await db.updateRSSFeed(feedId, {
        lastChecked: checkedAt,
        lastStatus: 'unchanged',
        lastError: undefined,
        consecutiveFailures: 0,
      });
      log.debug('RSS feed unchanged (304)', { name: feed.name });
      return db.getRSSItems(feedId);
    }

    const items = parseFeed(fetched.body, feedId);

    // Save and learn which items are actually NEW (not seen on a prior check)
    const newItems = await db.saveRSSItems(items);

    const wasFailing = (feed.consecutiveFailures || 0) > 0;
    await db.updateRSSFeed(feedId, {
      lastChecked: checkedAt,
      lastStatus: 'ok',
      lastError: undefined,
      consecutiveFailures: 0,
      lastItemCount: items.length,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
    });
    // A feed that recovered goes back to its normal interval from its backoff.
    if (wasFailing) this.scheduleCheck({ ...feed, consecutiveFailures: 0 });

    // Rules act only on items that appeared after the feed was added.
    if (!isFirstCheck && newItems.length > 0) {
      await this.applyRules(feed, newItems);
      // A feed fetching quietly in the background is invisible otherwise: you
      // only learn it found something by opening the page.
      await this.notifyNewItems(feed, newItems);
    }

    log.info('RSS feed checked', { name: feed.name, items: items.length, newItems: newItems.length });
    return items;
  }

  /** Tell the user a feed brought something in, if they asked to be told. */
  private async notifyNewItems(feed: RSSFeed, newItems: RSSItem[]): Promise<void> {
    try {
      const settings = await db.getSettings();
      if (!settings.enableNotifications) return;

      const body = newItems.length === 1
        ? newItems[0].title
        : t('rss.notifyBody', { count: newItems.length });
      showOsNotification(feed.name, body);
    } catch (err) {
      log.debug('RSS notification skipped', { error: String(err) });
    }
  }

  /**
   * Run every enabled rule that covers this feed over the new items.
   *
   * Replaces the old one-filter-per-feed path: a rule can span feeds, several
   * rules can share a feed, and each brings its own destination.
   */
  private async applyRules(feed: RSSFeed, newItems: RSSItem[]): Promise<void> {
    const rules = (await db.getRSSRules()).filter(r => r.enabled && ruleCoversFeed(r, feed.id));
    if (rules.length === 0) return;

    // One item can satisfy two rules; download it once, for the first that claims it.
    const claimed = new Set<string>();

    for (const rule of rules) {
      const candidates = newItems.filter(i => !claimed.has(i.guid));
      if (candidates.length === 0) break;

      const { selected, skippedDuplicates } = selectForRule(rule, candidates);
      if (selected.length === 0) {
        if (skippedDuplicates.length > 0) {
          log.debug('Rule skipped duplicate episodes', { rule: rule.name, skipped: skippedDuplicates.length });
        }
        continue;
      }

      for (const item of selected) claimed.add(item.guid);

      const grabbed = await this.downloadForRule(rule, feed, selected);
      await db.updateRSSRule(rule.id, {
        lastMatch: new Date().toISOString(),
        grabbedKeys: rememberKeys(rule, keysToRemember(rule, selected, grabbed)),
      });

      log.info('RSS rule matched', {
        rule: rule.name,
        feed: feed.name,
        grabbed: grabbed.length,
        skippedDuplicates: skippedDuplicates.length,
      });
    }
  }

  async checkAllFeeds(): Promise<void> {
    const feeds = await db.getRSSFeeds();
    const enabled = feeds.filter(f => f.enabled);
    log.info(`Checking all ${enabled.length} enabled RSS feeds`);
    await Promise.allSettled(enabled.map(f => this.checkFeed(f.id)));
  }

  /**
   * Fetch a feed document. Redirect hops are capped and resolved against the
   * current URL, the body is size-capped, and the bytes are decoded with the
   * charset the server or the XML declaration states — see `utils/http-fetch`.
   *
   * Conditional: the validators from the last successful fetch are sent back, so
   * an unchanged feed answers 304 with no body at all.
   */
  private async fetchFeed(feed: RSSFeed): Promise<{
    body: string;
    notModified: boolean;
    etag?: string;
    lastModified?: string;
  }> {
    const headers: Record<string, string> = {
      'User-Agent': `Havvn/${app.getVersion()} RSS Reader`,
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    };
    if (feed.etag) headers['If-None-Match'] = feed.etag;
    if (feed.lastModified) headers['If-Modified-Since'] = feed.lastModified;

    const res = await httpFetch(feed.url, {
      headers,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_FEED_BYTES,
      what: 'RSS feed',
      allowNotModified: true,
    });

    if (res.status === 304) {
      // Keep the validators we already had — 304 need not repeat them.
      return { body: '', notModified: true, etag: feed.etag, lastModified: feed.lastModified };
    }

    return {
      body: decodeBody(res.body, String(res.headers['content-type'] || '')),
      notModified: false,
      etag: typeof res.headers.etag === 'string' ? res.headers.etag : undefined,
      lastModified: typeof res.headers['last-modified'] === 'string' ? res.headers['last-modified'] : undefined,
    };
  }

  /** Add everything a rule selected, honouring its destination. */
  private async downloadForRule(rule: RSSRule, feed: RSSFeed, items: RSSItem[]): Promise<string[]> {
    const manager = getTorrentManager();
    const grabbed: string[] = [];

    for (const item of items) {
      try {
        const isMagnet = item.link.startsWith('magnet:');
        await manager.addDownload({
          sourceType: isMagnet ? 'magnet' : 'torrent_file',
          sourceUri: item.link,
          name: item.title,
          // The rule's destination wins; the feed's is the fallback.
          savePath: rule.savePath || feed.savePath,
          categoryId: rule.categoryId ?? feed.categoryId,
          paused: rule.addPaused ?? feed.addPaused,
        });
        grabbed.push(item.guid);
        log.info('RSS auto-downloaded', { title: item.title, rule: rule.name });
      } catch (err: any) {
        if (err?.code === 'DUPLICATE') {
          // Already in downloads — mark it so we don't retry on every check
          grabbed.push(item.guid);
        } else {
          log.error('RSS auto-download failed', { title: item.title, error: err });
        }
      }
    }

    await db.markRSSItemsDownloaded(grabbed);
    return grabbed;
  }

  /**
   * Run one rule over everything already stored — the "apply to existing items"
   * action, and what makes a newly written rule able to pick up a backlog it
   * would otherwise only see on the next post.
   */
  async runRuleNow(ruleId: string): Promise<{ grabbed: number; skipped: number }> {
    const rules = await db.getRSSRules();
    const rule = rules.find(r => r.id === ruleId);
    if (!rule) throw new Error(`RSS rule not found: ${ruleId}`);

    const feeds = await db.getRSSFeeds();
    const items = (await db.getRSSItems()).filter(i => !i.downloaded && !i.ignored);

    const { selected, skippedDuplicates } = selectForRule(rule, items);
    const grabbedGuids: string[] = [];

    // Group by feed so each download still gets its feed's fallback settings.
    for (const feed of feeds) {
      const mine = selected.filter(i => i.feedId === feed.id);
      if (mine.length === 0) continue;
      grabbedGuids.push(...await this.downloadForRule(rule, feed, mine));
    }

    await db.updateRSSRule(rule.id, {
      lastMatch: new Date().toISOString(),
      grabbedKeys: rememberKeys(rule, keysToRemember(rule, selected, grabbedGuids)),
    });

    log.info('RSS rule run manually', { rule: rule.name, grabbed: grabbedGuids.length, skipped: skippedDuplicates.length });
    return { grabbed: grabbedGuids.length, skipped: skippedDuplicates.length };
  }

  /** What a rule would match among stored items — the editor's preview. */
  async previewRule(rule: RSSRule): Promise<RSSItem[]> {
    const items = await db.getRSSItems();
    return selectForRule(rule, items).selected;
  }

  destroy(): void {
    for (const [id] of this.checkTimers) {
      this.clearTimer(id);
    }
    log.info('RSS service destroyed');
  }
}

let rssService: RSSService | null = null;

export function getRSSService(): RSSService {
  if (!rssService) {
    rssService = new RSSService();
  }
  return rssService;
}
