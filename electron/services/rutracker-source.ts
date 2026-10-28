import type { SearchProvider, SearchResult } from '../../shared/types';
import { rutrackerBase, ruTrackerQuery, parseRuTrackerSearch, ruTrackerMagnet } from '../../shared/rutracker';
import { ProviderNetworkError } from '../../shared/provider-network';
import { httpMirrorTargets } from '../../shared/provider-mirrors';
import { getProviderRoute, rememberProviderMirror } from './provider-network-store';
import { providerNetwork } from './provider-network';
import { readProviderPage } from './provider-browser';
import { t } from '../i18n';
import { checkRuTrackerPage } from '../../shared/rutracker';
import type { RawReleaseDetails } from '../../shared/search-release-details';

async function read<T>(provider: SearchProvider, target: string, parse: (html: string, base: string, details?: RawReleaseDetails) => T, signal?: AbortSignal, sourceBase?: string, withDetails = false): Promise<T> {
  const route = getProviderRoute(provider.id);
  if (!route) throw new ProviderNetworkError('auth');
  const base = rutrackerBase(provider.url);
  // Native RuTracker always uses the browser session where the user signed in.
  const timeout = AbortSignal.timeout(20000);
  const lease = await providerNetwork.acquireSession(provider.id, route.connection, { signal, timeoutMs: 20000 });
  const combined = AbortSignal.any([timeout, lease.signal, ...(signal ? [signal] : [])]);
  try {
    const targets = httpMirrorTargets({ type: 'rutracker', url: base }, target, { ...route, mirrors: route.mirrors.map(rutrackerBase) }, sourceBase).slice(0, 4);
    for (let index = 0; index < targets.length; index++) {
      if (combined.aborted) throw new ProviderNetworkError(timeout.aborted ? 'timeout' : 'cancelled');
      const candidate = targets[index];
      try {
        const response = await readProviderPage(provider.id, route.connection, candidate.url,
          [...route.origins, new URL(base).origin], combined, 4 * 1024 * 1024, withDetails);
        const final = new URL(response.url);
        if (!final.pathname.startsWith('/forum/')) throw new ProviderNetworkError('invalid-response');
        const activeBase = final.origin + '/forum';
        const result = parse(response.body.toString('utf8'), activeBase, response.details);
        if (combined.aborted) throw new ProviderNetworkError(timeout.aborted ? 'timeout' : 'cancelled');
        try { rememberProviderMirror(provider.id, route.mirrors.includes(activeBase) ? activeBase : null); } catch { /* hint only */ }
        return result;
      } catch (error) {
        if (combined.aborted) throw new ProviderNetworkError(timeout.aborted ? 'timeout' : 'cancelled');
        if (!(error instanceof ProviderNetworkError) || !['dns', 'network', 'timeout', 'server'].includes(error.code) || index === targets.length - 1) throw error;
      }
    }
    throw new ProviderNetworkError('network');
  } finally { lease.release(); }
}
export async function searchRuTracker(provider: SearchProvider, query: string, offset = 0, signal?: AbortSignal) {
  const base = rutrackerBase(provider.url);
  let encoded: string;
  try { encoded = ruTrackerQuery(query); } catch { throw new Error(t('search.rutracker.queryUnsupported')); }
  return read(provider, `${base}/tracker.php?nm=${encoded}&start=${offset}`, (html, activeBase) => {
    const page = parseRuTrackerSearch(html, offset);
    const results: SearchResult[] = page.results.map(({ id, ...row }) => ({ ...row,
      provider: provider.name, detailsUrl: `${activeBase}/viewtopic.php?t=${id}`,
      deferredSource: `${provider.id}:${id}`,
    }));
    return { results, nextOffset: page.nextOffset, base: activeBase };
  }, signal);
}
export async function resolveRuTracker(provider: SearchProvider, detailsUrl: string, signal?: AbortSignal) {
  const topic = new URL(detailsUrl);
  if (topic.pathname !== '/forum/viewtopic.php' || !/^\d+$/.test(topic.searchParams.get('t') ?? '')) throw new ProviderNetworkError('invalid-url');
  return read(provider, detailsUrl, (html, base) => {
    const magnetUri = ruTrackerMagnet(html);
    return { magnetUri, torrentUrl: magnetUri ? undefined : `${base}/dl.php?t=${topic.searchParams.get('t')}`, base };
  }, signal, topic.origin + '/forum');
}

export async function readRuTrackerDetails(provider: SearchProvider, detailsUrl: string, signal: AbortSignal) {
  const topic = new URL(detailsUrl);
  if (topic.pathname !== '/forum/viewtopic.php' || !/^\d+$/.test(topic.searchParams.get('t') ?? '')) throw new ProviderNetworkError('invalid-url');
  return read(provider, detailsUrl, (html, base, details) => {
    checkRuTrackerPage(html);
    if (!details?.available) throw new ProviderNetworkError('invalid-response');
    return { details, url: `${base}/viewtopic.php?t=${topic.searchParams.get('t')}` };
  }, signal, topic.origin + '/forum', true);
}
