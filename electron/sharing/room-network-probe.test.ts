import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import dns from 'node:dns';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { probeRoomEndpoint } from './room-network-probe';
const servers: http.Server[] = [], sockets = new Set<Socket>();
afterEach(async () => { for (const socket of sockets) socket.destroy(); sockets.clear(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function server() {
  const s = http.createServer(); servers.push(s); s.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  return { s, url: `ws://127.0.0.1:${(s.address() as { port: number }).port}/announce` };
}
describe('safe rendezvous probe on local fixtures', () => {
  it('verifies the websocket accept without sending a room announcement', async () => {
    const { s, url } = await server(); let payload = '';
    s.on('upgrade', (request, socket) => {
      expect(request.url).toBe('/announce'); expect(request.headers).not.toHaveProperty('authorization');
      socket.on('data', data => { payload += data.toString(); });
      const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    });
    expect(await probeRoomEndpoint(url, 2, new AbortController().signal)).toEqual({ index: 2, dns: 'skipped', tcp: 'ok', tls: 'skipped', websocket: 'ok' });
    expect(payload).toBe('');
  });
  it('does not treat ordinary HTTP as a working websocket', async () => {
    const { s, url } = await server(); s.on('request', (_req, res) => { res.end('ordinary page'); });
    const result = await probeRoomEndpoint(url, 0, new AbortController().signal);
    expect(result).toMatchObject({ tcp: 'ok', websocket: 'failed', tls: 'skipped' });
  });
  it('rejects an upgrade with a forged websocket accept', async () => {
    const { s, url } = await server(); s.on('upgrade', (_req, socket) => { socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: forged\r\n\r\n'); });
    expect(await probeRoomEndpoint(url, 0, new AbortController().signal)).toMatchObject({ tcp: 'ok', websocket: 'failed' });
  });
  it('distinguishes TLS failure from the successful TCP connection', async () => {
    const { s, url } = await server(); s.on('connection', socket => { socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'); });
    expect(await probeRoomEndpoint(url.replace('ws:', 'wss:'), 0, new AbortController().signal)).toMatchObject({ tcp: 'ok', tls: 'failed', websocket: 'unknown' });
  });
  it('does not label unattempted TCP and TLS as failures when DNS fails', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      process.nextTick(() => callback(Object.assign(new Error('synthetic resolver failure'), { code: 'EAI_AGAIN' })));
    }) as typeof dns.lookup);
    try { expect(await probeRoomEndpoint('wss://fixture.invalid/announce', 0, new AbortController().signal)).toMatchObject({ dns: 'failed', tcp: 'unknown', tls: 'unknown', websocket: 'unknown' }); }
    finally { lookup.mockRestore(); }
  });
  it('bounds a stalled handshake and keeps untested stages distinct', async () => {
    const { url } = await server();
    expect(await probeRoomEndpoint(url, 0, new AbortController().signal, 40)).toMatchObject({ tcp: 'ok', websocket: 'failed', tls: 'skipped' });
  });
  it('aborts without labelling cancellation as a network failure', async () => {
    const { url } = await server(), controller = new AbortController();
    const pending = probeRoomEndpoint(url, 0, controller.signal); controller.abort();
    expect(Object.values(await pending)).not.toContain('failed');
  });
  it.each(['https://example.com', 'file:///etc/passwd', 'ws://user:secret@127.0.0.1'])('rejects invalid or credentialled target %s', async url => {
    const result = await probeRoomEndpoint(url, 0, new AbortController().signal);
    expect(result.websocket).toBe('failed'); expect(JSON.stringify(result)).not.toContain('secret');
  });
});
