import { ProviderNetworkError, providerUrl } from './provider-network';

export interface HttpProviderAddress { url: string; type: 'custom' | 'jackett' | 'torznab' }
export interface MirrorTarget { url: string; base: string | null }

/** Custom URLs are search endpoints; Jackett/Torznab URLs are service bases. */
export function httpProviderBase(provider: HttpProviderAddress): string {
  const url = new URL(provider.url);
  providerUrl(url.href, [url.origin]);
  return provider.type === 'custom' ? url.origin : url.origin + url.pathname.replace(/\/$/, '');
}

/** Rebase only URLs within the same service path, keeping query bytes intact. */
export function rebaseProviderUrl(value: string, from: string, to: string): string | null {
  const url = new URL(value), source = new URL(from), target = new URL(to);
  if (url.origin !== source.origin) return null;
  const prefix = source.pathname.replace(/\/$/, '');
  if (prefix && url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return null;
  target.pathname = target.pathname.replace(/\/$/, '') + url.pathname.slice(prefix.length);
  target.search = url.search;
  target.hash = url.hash;
  return target.href;
}

export function httpMirrorTargets(provider: HttpProviderAddress, requestUrl: string,
  route: { mirrors: string[]; lastWorkingMirror?: string }, sourceBase = httpProviderBase(provider)): MirrorTarget[] {
  const primary = httpProviderBase(provider);
  const bases = [...new Set([primary, ...route.mirrors])];
  for (const base of bases) {
    const url = new URL(base);
    providerUrl(base, [url.origin]);
    if (url.search || url.hash || (new URL(primary).protocol === 'https:' && url.protocol !== 'https:')) {
      throw new ProviderNetworkError('invalid-url');
    }
  }
  if (route.lastWorkingMirror && bases.includes(route.lastWorkingMirror)) {
    bases.splice(bases.indexOf(route.lastWorkingMirror), 1); bases.unshift(route.lastWorkingMirror);
  }
  // Links to third-party trackers/CDNs keep their own URL and permissions.
  if (!rebaseProviderUrl(requestUrl, sourceBase, primary)) return [{ url: requestUrl, base: null }];
  return bases.map(base => ({ url: rebaseProviderUrl(requestUrl, sourceBase, base)!, base }));
}

/** Resolve relative links against the response, then map advertised primary URLs. */
export function httpResultUrl(value: string | undefined, responseUrl: string, primary: string, mirror: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, responseUrl);
    providerUrl(url.href, [url.origin]);
    return rebaseProviderUrl(url.href, primary, mirror) ?? url.href;
  } catch { return undefined; }
}
