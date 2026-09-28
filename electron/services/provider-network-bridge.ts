import http from 'node:http';
import { readProviderPage } from './provider-browser';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ProviderConnection } from '../../shared/provider-network';
import { networkError } from '../../shared/provider-network';
import { providerNetwork } from './provider-network';

/** One short-lived RPC capability per script run; no cookie-store read API. */
export async function openProviderNetworkBridge(providerId: string, connection: ProviderConnection, origins: string[]) {
  const token = randomBytes(32).toString('hex');
  const controller = new AbortController();
  let active = 0;
  const browserSlots: Promise<unknown>[] = Array.from({ length: 4 }, () => Promise.resolve());
  let browserSlot = 0;
  let port = 0;
  const server = http.createServer(async (req, res) => {
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (req.method !== 'POST' || req.url !== '/request' || req.headers.origin || req.headers.host !== '127.0.0.1:' + port ||
        auth.length !== token.length || !/^[a-f0-9]{64}$/.test(auth) || !timingSafeEqual(Buffer.from(auth), Buffer.from(token))) {
      res.writeHead(403); res.end(); return;
    }
    if (active >= 12) { res.writeHead(429); res.end(); return; }
    active++;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 128 * 1024) { res.writeHead(413); res.end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || typeof input.url !== 'string' || !['GET', 'POST'].includes(input.method)) throw new Error('Invalid request');
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.headers ?? {})) {
        if (['user-agent', 'accept', 'accept-language', 'content-type', 'cookie'].includes(key.toLowerCase()) && typeof value === 'string') headers[key] = value;
      }
      if (input.browserHtml === true && (input.method !== 'GET' || input.body !== undefined)) throw new Error('Browser HTML requires GET');
      const slot = browserSlot++ % browserSlots.length;
      const browserRequest = () => readProviderPage(providerId, connection, input.url, origins, controller.signal);
      const pending = input.browserHtml === true
        ? browserSlots[slot].then(browserRequest)
        : providerNetwork.request(providerId, connection, input.url, {
        allowedOrigins: origins, method: input.method, headers,
        body: typeof input.body === 'string' ? Buffer.from(input.body, 'base64') : undefined,
        signal: controller.signal, timeoutMs: 4000, maxBytes: 4 * 1024 * 1024,
      });
      if (input.browserHtml === true) browserSlots[slot] = pending.catch(() => {});
      const result = await pending;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ body: result.body.toString('base64'), contentType: result.contentType, url: result.url }));
    } catch (error) {
      if (!res.destroyed) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: networkError(error).code })); }
    } finally { active--; }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = (server.address() as AddressInfo).port;
  return {
    url: 'http://127.0.0.1:' + port + '/request', token,
    close: async () => {
      controller.abort(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
