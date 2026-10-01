import type { SearchProvider } from '../../shared/types';
import { ProviderNetworkError } from '../../shared/provider-network';
import { httpMirrorTargets, type HttpProviderAddress } from '../../shared/provider-mirrors';
import { providerNetwork, type ProviderRequest } from './provider-network';
import { getProviderRoute, rememberProviderMirror } from './provider-network-store';

export const HTTP_MIRROR_ATTEMPTS = 4;
export const HTTP_MIRROR_BUDGET_MS = 20000;
const ATTEMPT_TIMEOUT_MS = 5000;
type Response = Awaited<ReturnType<typeof providerNetwork.request>>;

/** Read-only requests on explicit aliases, one session/route and one time budget. */
export async function readHttpMirrors<T>(provider: SearchProvider, target: string,
  read: (response: Response, base: string | null) => T, options: Omit<ProviderRequest, 'allowedOrigins' | 'method' | 'body'> = {}, sourceBase?: string): Promise<T> {
  const route = getProviderRoute(provider.id);
  if (!route || !['custom', 'jackett', 'torznab'].includes(provider.type)) throw new ProviderNetworkError('invalid-url');
  if (options.signal?.aborted) throw new ProviderNetworkError('cancelled');
  const candidates = httpMirrorTargets(provider as HttpProviderAddress, target, route, sourceBase).slice(0, HTTP_MIRROR_ATTEMPTS);
  const deadline = Date.now() + Math.min(options.timeoutMs ?? HTTP_MIRROR_BUDGET_MS, HTTP_MIRROR_BUDGET_MS);
  // The lease also cancels BETWEEN attempts on logout or a connection change.
  const lease = await providerNetwork.acquireSession(provider.id, route.connection, { signal: options.signal, timeoutMs: Math.max(1, deadline - Date.now()) });
  const signal = options.signal ? AbortSignal.any([options.signal, lease.signal]) : lease.signal;
  const check = () => {
    if (signal.aborted) throw new ProviderNetworkError('cancelled');
    if (Date.now() >= deadline) throw new ProviderNetworkError('timeout');
  };
  try {
    for (let index = 0; index < candidates.length; index++) {
      check();
      const candidate = candidates[index];
      try {
        const response = await providerNetwork.request(provider.id, route.connection, candidate.url, {
          ...options, signal, allowedOrigins: [...new Set([...route.origins, new URL(provider.url).origin])],
          timeoutMs: Math.min(deadline - Date.now(), candidates.length > 1 ? ATTEMPT_TIMEOUT_MS : HTTP_MIRROR_BUDGET_MS),
        });
        check();
        // Empty valid output counts as success; login/error HTML does not.
        const value = read(response, candidate.base);
        check();
        if (candidate.base) {
          // A failed preference write must not discard a valid search/download.
          try { rememberProviderMirror(provider.id, route.mirrors.includes(candidate.base) ? candidate.base : null); } catch { /* Best-effort address hint. */ }
        }
        return value;
      } catch (error) {
        check();
        if (!(error instanceof ProviderNetworkError) || !['dns', 'network', 'timeout', 'server'].includes(error.code) || index === candidates.length - 1) throw error;
      }
    }
    throw new ProviderNetworkError('network');
  } finally { lease.release(); }
}
