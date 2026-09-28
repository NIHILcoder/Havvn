import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// This exercises the service over real loopback HTTP, with only the Chromium
// boundary replaced. Native cookies/proxy behavior needs the Electron smoke run.
const mock = vi.hoisted(() => ({ partitions: new Map<string, any>() }));
vi.mock('electron', () => ({ session: { fromPartition: (key: string) => {
  if (!mock.partitions.has(key)) mock.partitions.set(key, {
    fetch: vi.fn((url: string, options: any) => fetch(url, options)),
    closeAllConnections: vi.fn().mockResolvedValue(undefined),
    setProxy: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
  });
  return mock.partitions.get(key);
} } }));
import { ProviderNetworkService } from './provider-network';

let server: http.Server;
let base: string;
let hits: string[];
let foreign: http.Server;
let foreignBase: string;
let foreignHits = 0;
const listen = (s: http.Server) => new Promise<string>(resolve => s.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + (s.address() as AddressInfo).port)));
beforeAll(async () => {
  foreign = http.createServer((_req, res) => { foreignHits++; res.end('foreign'); });
  foreignBase = await listen(foreign);
  server = http.createServer((req, res) => {
    hits.push(req.url!);
    if (req.url === '/relative') { res.writeHead(302, { location: '/text' }); res.end(); }
    else if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); }
    else if (req.url === '/foreign') { res.writeHead(302, { location: foreignBase }); res.end(); }
    else if (req.url === '/slow') { /* no response */ }
    else if (req.url === '/large') { res.end('x'.repeat(4096)); }
    else if (req.url === '/limited') { res.writeHead(429, { 'Retry-After': '60' }); res.end(); }
    else if (req.url === '/forbidden') { res.writeHead(403); res.end('secret'); }
    else if (req.url === '/challenge') { res.writeHead(403, { 'cf-mitigated': 'challenge' }); res.end('private challenge page'); }
    else if (req.url === '/echo') { const data: Buffer[] = []; req.on('data', c => data.push(c)); req.on('end', () => res.end(Buffer.concat(data))); }
    else { res.setHeader('Content-Type', 'text/plain; charset=windows-1251'); res.end(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])); }
  });
  base = await listen(server);
});
afterAll(async () => {
  for (const s of [server, foreign]) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); }
});
beforeEach(() => { hits = []; foreignHits = 0; mock.partitions.clear(); });
const direct = { mode: 'direct' as const };
function fixture() {
  const service = new ProviderNetworkService((sourceSession, url, options) => sourceSession.fetch(url, { ...options, redirect: 'manual' }));
  const request = (p: string, options: any = {}) => service.request('source-a', direct, base + p, { allowedOrigins: [base], ...options });
  return { service, request };
}

describe('provider transport on loopback', () => {
  it('follows a relative redirect and decodes the declared charset', async () => {
    const { request } = fixture();
    const result = await request('/relative');
    expect(result.url).toBe(base + '/text');
    expect(result.text()).toBe('Привет');
  });
  it('sends form data without changing its bytes', async () => {
    const { request } = fixture();
    const body = Buffer.from('name=%CF%F0%E8%E2%E5%F2');
    const result = await request('/echo', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(result.body.equals(body)).toBe(true);
  });
  it('bounds redirect loops', async () => {
    const { request } = fixture();
    await expect(request('/loop')).rejects.toMatchObject({ code: 'redirect' });
    expect(hits).toHaveLength(6);
  });
  it('never contacts an unapproved redirect target', async () => {
    const { request } = fixture();
    await expect(request('/foreign')).rejects.toMatchObject({ code: 'redirect' });
    expect(foreignHits).toBe(0);
  });
  it('rejects replaying a login POST to another origin, even if trusted', async () => {
    const { request } = fixture();
    await expect(request('/foreign', { method: 'POST', body: Buffer.from('password=secret'), allowedOrigins: [base, foreignBase] })).rejects.toMatchObject({ code: 'redirect' });
    expect(foreignHits).toBe(0);
  });
  it('bounds the decompressed response body', async () => {
    const { request } = fixture();
    await expect(request('/large', { maxBytes: 64 })).rejects.toMatchObject({ code: 'too-large' });
  });
  it('times out a stalled response', async () => {
    const { request } = fixture();
    await expect(request('/slow', { timeoutMs: 60 })).rejects.toMatchObject({ code: 'timeout' });
  });
  it('cancels a request and removes the active controller', async () => {
    const { request, service } = fixture();
    const controller = new AbortController();
    const pending = request('/slow', { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect((service as any).entries.get('source-a').active.size).toBe(0);
  });
  it('never starts a pre-cancelled request', async () => {
    const { request } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(request('/text', { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(hits).toHaveLength(0);
  });
  it('honors Retry-After instead of repeatedly contacting a throttled source', async () => {
    const { request } = fixture();
    await expect(request('/limited')).rejects.toMatchObject({ code: 'rate-limit' });
    await expect(request('/text')).rejects.toMatchObject({ code: 'rate-limit' });
    expect(hits).toEqual(['/limited']);
  });
  it('returns only classified HTTP diagnostics', async () => {
    const { request } = fixture();
    await expect(request('/forbidden')).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(request('/challenge')).rejects.toMatchObject({ code: 'captcha', status: 403 });
  });
  it('separates sessions and serializes route changes before fetching', async () => {
    const { request, service } = fixture();
    await request('/text');
    await service.request('source-b', direct, base, { allowedOrigins: [base] });
    expect(mock.partitions.size).toBe(2);
    const entry = [...mock.partitions.values()][0];
    let unblock!: () => void;
    entry.setProxy.mockImplementationOnce(() => new Promise<void>(resolve => { unblock = resolve; }));
    const proxy = { mode: 'proxy' as const, protocol: 'http' as const, host: '127.0.0.1', port: 12345 };
    const pending = service.request('source-a', proxy, base, { allowedOrigins: [base] });
    await vi.waitFor(() => expect(unblock).toBeDefined());
    expect(entry.fetch).toHaveBeenCalledTimes(1);
    unblock(); await pending;
    expect(entry.setProxy).toHaveBeenLastCalledWith({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:12345', proxyBypassRules: '<-loopback>' });
  });
  it('times out while the network route is still being configured', async () => {
    const { request, service } = fixture();
    await request('/text');
    const entry = [...mock.partitions.values()][0];
    entry.setProxy.mockImplementationOnce(() => new Promise(() => {}));
    await expect(service.request('source-a', { mode: 'system' }, base, { allowedOrigins: [base], timeoutMs: 60 })).rejects.toMatchObject({ code: 'timeout' });
    expect(entry.fetch).toHaveBeenCalledTimes(1);
  });
});
