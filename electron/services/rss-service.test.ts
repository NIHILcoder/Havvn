import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RSSFeed, RSSItem } from '../../shared/types';

const f = vi.hoisted(() => ({
  feeds: [] as RSSFeed[], items: [] as RSSItem[], fetch: vi.fn(), saveItems: vi.fn(), update: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }));
vi.mock('../utils', () => ({
  logger: { child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  httpFetch: f.fetch, decodeBody: (body: Buffer) => body.toString('utf8'),
}));
vi.mock('../utils/os-notify', () => ({ showOsNotification: vi.fn() }));
vi.mock('../i18n', () => ({ t: (key: string) => key }));
vi.mock('../torrent', () => ({ getTorrentManager: () => ({ addDownload: vi.fn() }) }));
vi.mock('../db/store', () => ({
  migrateRSSFiltersToRules: async () => 0,
  getRSSFeeds: async () => structuredClone(f.feeds),
  getRSSItems: async (id?: string) => f.items.filter(item => !id || item.feedId === id),
  updateRSSFeed: f.update,
  removeRSSFeed: async (id: string) => { f.feeds = f.feeds.filter(feed => feed.id !== id); f.items = f.items.filter(item => item.feedId !== id); },
  saveRSSItems: f.saveItems, getRSSRules: async () => [],
}));
import { RSSService } from './rss-service';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (status = 200) => ({ status, headers: {}, body: Buffer.from('<rss><channel><item><guid>new-item</guid><title>New item</title><enclosure url="https://feed.invalid/item.torrent" type="application/x-bittorrent"/></item></channel></rss>') });
let service: RSSService;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T10:00:00Z')); vi.clearAllMocks();
  f.feeds = [{ id: 'feed', name: 'Feed', url: 'https://feed.invalid/rss', enabled: true, autoDownload: false, intervalMinutes: 30, lastChecked: new Date().toISOString() }];
  f.items = [];
  f.update.mockImplementation(async (id: string, patch: Partial<RSSFeed>) => {
    const feed = f.feeds.find(item => item.id === id); if (!feed) throw Error('Feed removed');
    Object.assign(feed, patch); return structuredClone(feed);
  });
  f.saveItems.mockImplementation(async (items: RSSItem[]) => {
    const added = items.filter(item => !f.items.some(old => old.guid === item.guid)); f.items.push(...added); return added;
  });
  f.fetch.mockResolvedValue(response()); service = new RSSService();
});
afterEach(() => { service.destroy(); vi.useRealTimers(); });

describe('RSS checks and feed lifecycle', () => {
  it('coalesces overlapping manual and scheduled checks of the same feed', async () => {
    const request = deferred<ReturnType<typeof response>>(); f.fetch.mockReturnValue(request.promise);
    const first = service.checkFeed('feed'), second = service.checkFeed('feed');
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    request.resolve(response()); await Promise.all([first, second]);
    expect(f.saveItems).toHaveBeenCalledTimes(1);
  });
  it('does not rearm polling when a failing request finishes after disabling its feed', async () => {
    await service.initialize(); const request = deferred<ReturnType<typeof response>>(); f.fetch.mockReturnValue(request.promise);
    const pending = service.checkFeed('feed'); await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    await service.updateFeed('feed', { enabled: false }); request.reject(Error('Timeout'));
    await pending.catch(() => {});
    expect(vi.getTimerCount()).toBe(0); expect(f.feeds[0].lastStatus).toBeUndefined();
  });
  it('does not restore items from a reply received after deleting a feed', async () => {
    const request = deferred<ReturnType<typeof response>>(); f.fetch.mockReturnValue(request.promise);
    const pending = service.checkFeed('feed'); await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    await service.removeFeed('feed'); request.resolve(response());
    await expect(pending).resolves.toEqual([]); expect(f.items).toEqual([]); expect(f.saveItems).not.toHaveBeenCalled();
  });
  it('ignores the old URL reply and permits an independent check of the changed feed', async () => {
    const old = deferred<ReturnType<typeof response>>(); f.fetch.mockReturnValueOnce(old.promise);
    const first = service.checkFeed('feed'); await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    await service.updateFeed('feed', { url: 'https://new.invalid/rss' });
    await service.checkFeed('feed'); expect(f.fetch).toHaveBeenCalledTimes(2);
    old.resolve(response()); await expect(first).resolves.toEqual([]);
    expect(f.saveItems).toHaveBeenCalledOnce(); expect(f.fetch.mock.calls[1][0]).toBe('https://new.invalid/rss');
  });
  it('returns from failure backoff to the normal interval after HTTP 304 recovery', async () => {
    f.feeds[0].consecutiveFailures = 3; await service.initialize(); f.fetch.mockResolvedValue(response(304));
    await service.checkFeed('feed'); expect(f.feeds[0].consecutiveFailures).toBe(0);
    f.fetch.mockClear(); await vi.advanceTimersByTimeAsync(34 * 60_000);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it('cancels the startup catch-up check on shutdown', async () => {
    f.feeds[0].lastChecked = undefined; await service.initialize(); service.destroy();
    await vi.advanceTimersByTimeAsync(5000); expect(f.fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not persist or schedule an in-flight response after shutdown', async () => {
    const request = deferred<ReturnType<typeof response>>(); f.fetch.mockReturnValue(request.promise);
    const pending = service.checkFeed('feed'); await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    service.destroy(); request.resolve(response()); await expect(pending).resolves.toEqual([]);
    expect(f.saveItems).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('allows a manual check of a disabled feed without enabling background polling', async () => {
    f.feeds[0].enabled = false; f.feeds[0].consecutiveFailures = 1;
    await expect(service.checkFeed('feed')).resolves.toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
});
