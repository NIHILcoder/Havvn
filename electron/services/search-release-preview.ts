import { randomUUID } from 'node:crypto';
import type { SearchProvider, SearchResult } from '../../shared/types';
import { ProviderNetworkError } from '../../shared/provider-network';
import { releaseImageUrl, type ReleasePreviewImage, type SearchReleaseDetails } from '../../shared/search-release-details';
import { previewBitmap } from './release-preview-bitmap';
import { readRuTrackerDetails } from './rutracker-source';
import { getProviderRoute } from './provider-network-store';
import { providerNetwork } from './provider-network';

export interface PreviewSource { ref: string; provider: SearchProvider; result: SearchResult }
const TTL = 15 * 60 * 1000, IMAGE_LIMIT = 3 * 1024 * 1024, CACHE_LIMIT = 24 * 1024 * 1024;
type Content = Pick<SearchReleaseDetails, 'title' | 'url' | 'blocks' | 'poster' | 'screenshots' | 'fetchedAt' | 'truncated'>;
interface Asset { url: string; providerId: string; sourceOrigin: string; expires: number; data?: string }

/** Opaque source/image capabilities, bounded caches and cancellable work. */
export class SearchReleasePreview {
  private cache = new Map<string, { at: number; content: Content }>();
  private assets = new Map<string, Asset>();
  private jobs = new Map<string, AbortController>();
  private imageBytes = 0;
  private imageReaders = 0;
  private imageWaiters = new Set<() => void>();

  clear(): void {
    for (const job of this.jobs.values()) job.abort();
    this.cache.clear(); this.assets.clear(); this.imageBytes = 0;
  }
  cancel(id: string): void { this.jobs.get(id)?.abort(); }

  private async job<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (typeof id !== 'string' || !id || id.length > 180 || this.jobs.has(id)) throw new Error('Invalid preview request');
    if (this.jobs.size >= 24) throw new ProviderNetworkError('rate-limit');
    const controller = new AbortController(); this.jobs.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const result = await work(controller.signal);
      if (controller.signal.aborted) throw new ProviderNetworkError('cancelled');
      return result;
    } finally { clearTimeout(timer); if (this.jobs.get(id) === controller) this.jobs.delete(id); }
  }
  private discard(key: string): void {
    const hit = this.cache.get(key);
    if (!hit) return;
    for (const image of [hit.content.poster, ...hit.content.screenshots]) {
      if (!image) continue;
      const asset = this.assets.get(image.id);
      this.imageBytes -= asset?.data?.length ?? 0; this.assets.delete(image.id);
    }
    this.cache.delete(key);
  }
  private prune(): void {
    for (const [key, entry] of this.cache) if (Date.now() - entry.at >= TTL) this.discard(key);
    while (this.cache.size > 50) this.discard(this.cache.keys().next().value!);
  }

  async details(candidates: PreviewSource[], id: string, selected?: string, refresh = false): Promise<SearchReleaseDetails> {
    return this.job(id, async signal => {
      this.prune();
      const sources = candidates.map(item => ({ ref: item.ref, providerId: item.provider.id,
        name: item.result.indexer || item.provider.name, supported: item.provider.type === 'rutracker' && !!item.result.detailsUrl }));
      const chosen = selected ? sources.find(source => source.ref === selected) : sources.find(source => source.supported) ?? sources[0];
      if (!chosen) throw new Error('Search result expired');
      const item = candidates.find(candidate => candidate.ref === chosen.ref)!;
      let pageUrl: string | undefined;
      try { const url = new URL(item.result.detailsUrl ?? ''); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) pageUrl = url.href; } catch { /* Optional original page. */ }
      const base: SearchReleaseDetails = { source: chosen, sources, title: item.result.title, url: pageUrl,
        supported: chosen.supported, blocks: [], screenshots: [] };
      if (!chosen.supported) return base;
      const key = item.provider.id + '\0' + item.result.detailsUrl;
      if (refresh) this.discard(key);
      const cached = this.cache.get(key);
      if (cached) return { ...base, ...cached.content };
      try {
        const response = await readRuTrackerDetails(item.provider, item.result.detailsUrl!, signal);
        if (signal.aborted) throw new ProviderNetworkError('cancelled');
        // Another window may have finished the same topic while this read was pending.
        const completed = this.cache.get(key);
        if (completed) return { ...base, ...completed.content };
        const content: Content = { title: response.details.title || item.result.title, url: response.url,
          blocks: response.details.blocks, screenshots: [], fetchedAt: Date.now(), truncated: response.details.truncated };
        for (const image of response.details.images.slice(0, 9)) {
          const url = releaseImageUrl(image.url);
          if (!url) continue;
          const imageId = randomUUID();
          this.assets.set(imageId, { url, providerId: item.provider.id, sourceOrigin: new URL(response.url).origin, expires: Date.now() + TTL });
          const entry: ReleasePreviewImage = { id: imageId, label: image.label };
          if (image.poster && !content.poster) content.poster = entry;
          else content.screenshots.push(entry);
        }
        this.cache.set(key, { at: Date.now(), content }); this.prune();
        return { ...base, url: response.url, ...content };
      } catch (error) {
        if (signal.aborted || error instanceof ProviderNetworkError && error.code === 'cancelled') throw error;
        return { ...base, failure: error instanceof ProviderNetworkError ? error.code : 'network' };
      }
    });
  }

  private async imageSlot(signal: AbortSignal): Promise<() => void> {
    while (this.imageReaders >= 2) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { this.imageWaiters.delete(wake); signal.removeEventListener('abort', abort); };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(new ProviderNetworkError('cancelled')); };
        this.imageWaiters.add(wake); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    if (signal.aborted) throw new ProviderNetworkError('cancelled');
    this.imageReaders++;
    return () => { this.imageReaders--; this.imageWaiters.values().next().value?.(); };
  }

  async image(assetId: string, id: string): Promise<string> {
    if (typeof assetId !== 'string' || assetId.length > 128) throw new Error('Invalid preview image');
    return this.job(id, async signal => {
      this.prune();
      const asset = this.assets.get(assetId);
      if (!asset || asset.expires <= Date.now()) throw new Error('Preview image expired');
      if (asset.data) return asset.data;
      const release = await this.imageSlot(signal);
      try {
        if (this.assets.get(assetId) !== asset) throw new ProviderNetworkError('cancelled');
        const route = getProviderRoute(asset.providerId);
        if (!route) throw new ProviderNetworkError('auth');
        const origin = new URL(asset.url).origin;
        const response = await providerNetwork.request(asset.providerId, route.connection, asset.url, {
          allowedOrigins: [origin], omitCookies: origin !== asset.sourceOrigin, signal,
          maxBytes: IMAGE_LIMIT, timeoutMs: 12000, headers: { Accept: 'image/webp,image/png,image/jpeg' },
        });
        if (signal.aborted || this.assets.get(assetId) !== asset) throw new ProviderNetworkError('cancelled');
        if (response.body.length > IMAGE_LIMIT) throw new ProviderNetworkError('too-large');
        const data = await previewBitmap(response.body, signal);
        if (signal.aborted || this.assets.get(assetId) !== asset) throw new ProviderNetworkError('cancelled');
        // A concurrent request may already have populated this entry.
        if (!asset.data) { asset.data = data; this.imageBytes += data.length; }
        this.assets.delete(assetId); this.assets.set(assetId, asset);
        for (const old of this.assets.values()) {
          if (this.imageBytes <= CACHE_LIMIT) break;
          if (old.data && old !== asset) { this.imageBytes -= old.data.length; old.data = undefined; }
        }
        return data;
      } finally { release(); }
    });
  }
}
