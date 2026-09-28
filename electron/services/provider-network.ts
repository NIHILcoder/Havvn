import { net, session, type Session } from 'electron';
import { createHash } from 'node:crypto';
import { ProviderConnection, ProviderNetworkError, networkError, httpNetworkError, providerProxyConfig, providerUrl, parseProviderConnection } from '../../shared/provider-network';
import { decodeBody } from '../utils/http-fetch';

type RequestOnce = (session: Session, url: string, options: {
  method: string; body?: Uint8Array; headers: Record<string, string>; signal: AbortSignal;
}) => Promise<Response>;

// session.fetch({ redirect: 'manual' }) rejects on a redirect in Electron 44.
// net.request exposes the redirect BEFORE following it, so policy stays ours.
const chromiumRequest: RequestOnce = (sourceSession, url, options) => new Promise((resolve, reject) => {
  const request = net.request({ url, session: sourceSession, method: options.method, redirect: 'manual', useSessionCookies: true });
  let failBody: ((error: Error) => void) | undefined;
  const abort = () => {
    const error = new ProviderNetworkError('cancelled');
    reject(error); failBody?.(error); release(); request.abort();
  };
  const release = () => options.signal.removeEventListener('abort', abort);
  options.signal.addEventListener('abort', abort, { once: true });
  request.on('error', error => { release(); reject(error); failBody?.(error); });
  request.on('login', (_info, callback) => callback()); // no implicit proxy credentials
  request.on('redirect', (status, _method, location) => {
    release();
    resolve(new Response(null, { status, headers: { location } }));
    request.abort();
  });
  request.on('response', response => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    let ended = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        failBody = error => { if (!ended) { ended = true; release(); controller.error(error); } };
        response.on('data', chunk => { if (!ended) controller.enqueue(new Uint8Array(chunk)); });
        response.on('end', () => { release(); if (!ended) { ended = true; controller.close(); } });
        response.on('error', error => failBody?.(error));
        response.on('aborted', () => failBody?.(new ProviderNetworkError('network')));
      },
      cancel() { ended = true; release(); request.abort(); },
    });
    resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : stream, { status: response.statusCode, headers }));
  });
  try {
    for (const [key, value] of Object.entries(options.headers)) request.setHeader(key, value);
    // Use the identity of the browser that obtained this session's cookies,
    // rather than a standalone Python plugin's hard-coded browser version.
    request.setHeader('User-Agent', sourceSession.getUserAgent());
    if (options.signal.aborted) { abort(); release(); return; }
    if (options.body) request.write(Buffer.from(options.body));
    request.end();
  } catch (error) { release(); request.abort(); reject(error); }
});

export interface ProviderRequest {
  allowedOrigins: readonly string[];
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}
interface Entry { session: Session; signature: string; ready: Promise<void>; active: Set<AbortController>; cooldown: Map<string, number> }

/** One isolated cookie jar and explicit network route per search source. */
export class ProviderNetworkService {
  private entries = new Map<string, Entry>();
  constructor(private readonly fetch: RequestOnce = chromiumRequest) {}

  private entry(providerId: string, rawConnection: ProviderConnection): Entry {
    const connection = parseProviderConnection(rawConnection);
    const signature = JSON.stringify(connection);
    let entry = this.entries.get(providerId);
    if (!entry) {
      const key = createHash('sha256').update(providerId).digest('hex');
      entry = { session: session.fromPartition('persist:havvn-search-' + key), signature: '', ready: Promise.resolve(), active: new Set(), cooldown: new Map() };
      this.entries.set(providerId, entry);
    }
    if (signature !== entry.signature) {
      const current = entry;
      for (const controller of current.active) controller.abort();
      current.signature = signature;
      // Serialize route changes; an older caller must not request on a newer route.
      current.ready = current.ready.catch(() => {}).then(async () => {
        await current.session.closeAllConnections();
        await current.session.setProxy(providerProxyConfig(connection));
      });
    }
    return entry;
  }

  async acquireSession(providerId: string, connection: ProviderConnection) {
    const entry = this.entry(providerId, connection);
    const signature = entry.signature;
    const controller = new AbortController();
    entry.active.add(controller);
    const release = () => entry.active.delete(controller);
    try {
      await entry.ready;
      if (controller.signal.aborted || entry.signature !== signature) throw new ProviderNetworkError('cancelled');
      return { session: entry.session, signal: controller.signal, release };
    } catch (error) { release(); throw error; }
  }

  async request(providerId: string, connection: ProviderConnection, target: string, options: ProviderRequest) {
    let url = providerUrl(target, options.allowedOrigins);
    const entry = this.entry(providerId, connection);
    const signature = entry.signature;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    entry.active.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 20000);
    let method = options.method ?? 'GET';
    let body = options.body;
    let headers = { ...options.headers };
    const checkAbort = () => {
      if (timedOut) throw new ProviderNetworkError('timeout');
      if (controller.signal.aborted || options.signal?.aborted || entry.signature !== signature) throw new ProviderNetworkError('cancelled');
    };
    try {
      checkAbort();
      await new Promise<void>((resolve, reject) => {
        const interrupted = () => reject(new ProviderNetworkError(timedOut ? 'timeout' : 'cancelled'));
        controller.signal.addEventListener('abort', interrupted, { once: true });
        entry.ready.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', interrupted));
        if (controller.signal.aborted) interrupted();
      });
      checkAbort();
      for (let hop = 0; ; hop++) {
        checkAbort();
        if ((entry.cooldown.get(url.origin) ?? 0) > Date.now()) throw new ProviderNetworkError('rate-limit', 429);
        const response = await this.fetch(entry.session, url.href, {
          method, body: body ? new Uint8Array(body) : undefined, headers, signal: controller.signal,
        });
        const status = response.status;
        if ([301, 302, 303, 307, 308].includes(status)) {
          await response.body?.cancel();
          if (hop >= 5) throw new ProviderNetworkError('redirect');
          const location = response.headers.get('location');
          if (!location) throw new ProviderNetworkError('redirect');
          const next = providerUrl(new URL(location, url).href, options.allowedOrigins);
          if (url.protocol === 'https:' && next.protocol !== 'https:') throw new ProviderNetworkError('redirect');
          if (next.origin !== url.origin) {
            // Never replay credentials or POST payloads to another origin.
            if (method !== 'GET') throw new ProviderNetworkError('redirect');
            headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !['authorization', 'cookie', 'referer'].includes(key.toLowerCase())));
          }
          if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
            method = 'GET'; body = undefined;
            headers = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'content-type'));
          }
          url = next;
          continue;
        }
        if (status < 200 || status >= 300) {
          // A successful account login does not imply the site accepted a
          // background HTTP request. Report an explicit challenge separately.
          if (response.headers.get('cf-mitigated')?.toLowerCase() === 'challenge') {
            await response.body?.cancel();
            throw new ProviderNetworkError('captcha', status);
          }
          if (status === 429) {
            const retry = response.headers.get('retry-after') ?? '';
            const ms = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
            entry.cooldown.set(url.origin, Date.now() + Math.min(3600000, Math.max(1000, Number.isFinite(ms) ? ms : 30000)));
          }
          await response.body?.cancel(); throw httpNetworkError(status);
        }
        const reader = response.body?.getReader();
        const chunks: Buffer[] = [];
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              const part = await reader.read();
              checkAbort();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > (options.maxBytes ?? 10 * 1024 * 1024)) throw new ProviderNetworkError('too-large');
              chunks.push(Buffer.from(part.value));
            }
          } finally { await reader.cancel().catch(() => {}); }
        }
        const bytes = Buffer.concat(chunks);
        return { body: bytes, status, url: url.href, contentType: response.headers.get('content-type') ?? '',
          text: () => decodeBody(bytes, response.headers.get('content-type') ?? '') };
      }
    } catch (error) {
      checkAbort();
      throw networkError(error);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      entry.active.delete(controller);
    }
  }

  async reset(providerId: string, clearCookies = false): Promise<void> {
    const entry = this.entries.get(providerId) ?? (clearCookies ? {
      session: session.fromPartition('persist:havvn-search-' + createHash('sha256').update(providerId).digest('hex')),
      ready: Promise.resolve(), active: new Set<AbortController>(), signature: '',
    } : null);
    if (!entry) return;
    for (const controller of entry.active) controller.abort();
    await entry.ready.catch(() => {});
    await entry.session.closeAllConnections();
    if (clearCookies) {
      await entry.session.clearStorageData();
      await entry.session.clearCache();
    }
    this.entries.delete(providerId);
  }
}
export const providerNetwork = new ProviderNetworkService();
