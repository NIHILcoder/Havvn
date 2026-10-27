import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import { WebRemoteServer } from './web-remote';

vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), error: vi.fn() }) } }));
vi.mock('./cast-server', () => ({ CastServer: { lanAddress: () => '127.0.0.1' } }));

const token = 'a'.repeat(64);
const manager = {
  getDownloads: vi.fn(), getStats: vi.fn(), getFiles: vi.fn(), addDownload: vi.fn(),
  pauseDownload: vi.fn(), resumeDownload: vi.fn(), recheckDownload: vi.fn(), removeDownload: vi.fn(),
};
let server: WebRemoteServer, base: string;
const internal = () => server as unknown as { mgr(): typeof manager; server: http.Server | null };
const request = (route: string, init: RequestInit = {}) => fetch(base + route, {
  ...init, headers: { 'X-TH-Token': token, ...init.headers }, signal: AbortSignal.timeout(2000),
});
beforeEach(async () => {
  vi.resetAllMocks();
  manager.getDownloads.mockResolvedValue([{ id: 'torrent', name: 'Fixture', status: 'paused', progress: 0.5, totalSize: 100 }]);
  manager.getStats.mockReturnValue([]); manager.getFiles.mockResolvedValue([]); manager.addDownload.mockResolvedValue({ id: 'added' });
  server = new WebRemoteServer(); internal().mgr = () => manager;
  await server.start(0, token); base = `http://127.0.0.1:${server.getInfo().port}`;
});
afterEach(async () => { internal().server?.closeAllConnections(); await server.stop(); });

it('denies requests without the secret and from foreign Host headers', async () => {
  expect((await fetch(base + '/api/state')).status).toBe(403);
  expect((await request('/api/state', { headers: { 'X-TH-Token': 'wrong' } })).status).toBe(403);
  const status = await new Promise((resolve, reject) => {
    const req = http.get(base + '/api/state', { headers: { Host: 'foreign.invalid', 'X-TH-Token': token } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  expect(status).toBe(403); expect(manager.getDownloads).not.toHaveBeenCalled();
});
it('returns authenticated state without caching and with current runtime statistics', async () => {
  manager.getStats.mockReturnValue([{ id: 'torrent', progress: 0.75, downSpeedBps: 123, status: 'downloading' }]);
  const res = await request('/api/state'); expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
  expect((await res.json()).downloads[0]).toMatchObject({ progress: 0.75, down: 123, status: 'downloading' });
});
it('returns a readable error instead of leaving the response pending when the engine rejects', async () => {
  manager.getDownloads.mockRejectedValueOnce(Error('Private engine internals'));
  const res = await request('/api/state'); expect(res.status).toBe(503);
  const body = await res.json(); expect(body.error).toMatch(/temporarily unavailable.*retry/i); expect(body.error).not.toContain('Private engine');
  expect((await request('/api/state')).status).toBe(200);
});
it('also catches a synchronous manager failure inside an asynchronous control route', async () => {
  internal().mgr = () => { throw Error('Manager not ready'); };
  const res = await request('/api/torrents/torrent/pause', { method: 'POST' }); expect(res.status).toBe(503);
  expect((await res.json()).error).toMatch(/retry/i);
});
it('rejects malformed JSON and non-magnet inputs without dispatching an add', async () => {
  expect((await request('/api/add', { method: 'POST', body: '{invalid' })).status).toBe(400);
  expect((await request('/api/add', { method: 'POST', body: JSON.stringify({ magnet: 'file:///secret' }) })).status).toBe(400);
  expect(manager.addDownload).not.toHaveBeenCalled();
});
it('passes a trimmed magnet to the manager and returns its download identity', async () => {
  const magnet = 'magnet:?xt=urn:btih:' + 'c'.repeat(40);
  const res = await request('/api/add', { method: 'POST', body: JSON.stringify({ magnet: ' ' + magnet + ' ' }) });
  expect(await res.json()).toEqual({ ok: true, id: 'added' });
  expect(manager.addDownload).toHaveBeenCalledExactlyOnceWith({ sourceType: 'magnet', sourceUri: magnet });
});
it('dispatches known controls and removes the entry with its files retained', async () => {
  for (const action of ['pause','resume','recheck','remove']) expect((await request('/api/torrents/torrent/' + action, { method: 'POST' })).status).toBe(200);
  expect(manager.pauseDownload).toHaveBeenCalledExactlyOnceWith('torrent'); expect(manager.resumeDownload).toHaveBeenCalledExactlyOnceWith('torrent');
  expect(manager.recheckDownload).toHaveBeenCalledExactlyOnceWith('torrent'); expect(manager.removeDownload).toHaveBeenCalledExactlyOnceWith('torrent', false);
  expect((await request('/api/torrents/torrent/invalid', { method: 'POST' })).status).toBe(404);
});
it('reports failed actions and still serves a successful retry', async () => {
  manager.pauseDownload.mockRejectedValueOnce(Error('Pause unavailable'));
  const failed = await request('/api/torrents/torrent/pause', { method: 'POST' }); expect(failed.status).toBe(400); expect((await failed.json()).error).toBe('Pause unavailable');
  expect((await request('/api/torrents/torrent/pause', { method: 'POST' })).status).toBe(200);
});
it('revokes the previous token on rotation and stops serving when disabled', async () => {
  const rotated = 'b'.repeat(64); await server.start(0, rotated); base = `http://127.0.0.1:${server.getInfo().port}`;
  expect((await request('/api/state')).status).toBe(403); expect((await request('/api/state', { headers: { 'X-TH-Token': rotated } })).status).toBe(200);
  internal().server?.closeAllConnections(); await server.stop(); expect(server.getInfo()).toEqual({ running: false, url: null, port: 0 });
});
it('does not restart an already running server with the same port and token', async () => {
  const active = internal().server; await server.start(server.getInfo().port, token); expect(internal().server).toBe(active);
  expect((await request('/api/state')).status).toBe(200);
});
