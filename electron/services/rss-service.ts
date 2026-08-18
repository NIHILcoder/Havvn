/**
 * RSS Service
 * Manages RSS feed subscriptions, polling, and auto-download of new torrent items.
 */

import { app } from 'electron';
import { logger, httpFetchText } from '../utils';
import * as db from '../db/store';
import { RSSFeed, RSSItem } from '../../shared/types';
import { parseFeed } from '../../shared/feed-parse';
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

export class RSSService {
  private checkTimers: Map<string, NodeJS.Timeout> = new Map();
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

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

    const intervalMs = jitter((feed.intervalMinutes || 30) * 60 * 1000);

    const timer = setInterval(async () => {
      try {
        await this.checkFeed(feed.id);
      } catch (err) {
        log.error('RSS feed check failed', { feedId: feed.id, error: err });
      }
    }, intervalMs);

    this.checkTimers.set(feed.id, timer);
    log.debug('Scheduled RSS feed check', { feedId: feed.id, intervalMinutes: feed.intervalMinutes });
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

    // First check ever for this feed? Then everything in it is history, not
    // news — store the items but never auto-download the whole backlog.
    const isFirstCheck = !feed.lastChecked;

    const xml = await this.fetchFeed(feed.url);
    const items = parseFeed(xml, feedId);

    // Apply filter if set
    const filtered = feed.filter ? this.filterItems(items, feed.filter) : items;

    // Save and learn which items are actually NEW (not seen on a prior check)
    const newItems = await db.saveRSSItems(filtered);

    // Update lastChecked
    await db.updateRSSFeed(feedId, { lastChecked: new Date().toISOString() });

    // Auto-download only items that appeared after the feed was added
    if (feed.autoDownload && !isFirstCheck && newItems.length > 0) {
      await this.autoDownload(feed, newItems);
    }

    log.info('RSS feed checked', { name: feed.name, items: filtered.length, newItems: newItems.length });
    return filtered;
  }

  async checkAllFeeds(): Promise<void> {
    const feeds = await db.getRSSFeeds();
    const enabled = feeds.filter(f => f.enabled);
    log.info(`Checking all ${enabled.length} enabled RSS feeds`);
    await Promise.allSettled(enabled.map(f => this.checkFeed(f.id)));
  }

  /**
   * Fetch a feed document as text. Redirect hops are capped and resolved against
   * the current URL, the body is size-capped, and the bytes are decoded with the
   * charset the server or the XML declaration states — see `utils/http-fetch`.
   */
  private async fetchFeed(url: string): Promise<string> {
    return httpFetchText(url, {
      headers: {
        'User-Agent': `Havvn/${app.getVersion()} RSS Reader`,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_FEED_BYTES,
      what: 'RSS feed',
    });
  }

  private filterItems(items: RSSItem[], filter: string): RSSItem[] {
    try {
      const regex = new RegExp(filter, 'i');
      return items.filter(item => regex.test(item.title));
    } catch (err) {
      log.warn('Invalid RSS filter regex', { filter, error: err });
      return items;
    }
  }

  private async autoDownload(feed: RSSFeed, items: RSSItem[]): Promise<void> {
    const existingItems = await db.getRSSItems(feed.id);
    const downloadedGuids = new Set(existingItems.filter(i => i.downloaded).map(i => i.guid));

    const manager = getTorrentManager();

    // Collected and written once at the end: flagging each guid separately
    // rewrote the entire item store per torrent.
    const grabbed: string[] = [];

    for (const item of items) {
      if (downloadedGuids.has(item.guid)) continue;

      try {
        const isMagnet = item.link.startsWith('magnet:');
        await manager.addDownload({
          sourceType: isMagnet ? 'magnet' : 'torrent_file',
          sourceUri: item.link,
          name: item.title,
          savePath: feed.savePath,
          categoryId: feed.categoryId,
          paused: feed.addPaused,
        });

        grabbed.push(item.guid);
        log.info('RSS auto-downloaded', { title: item.title, feedName: feed.name });
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
