/* eslint-disable @typescript-eslint/no-explicit-any -- Real IPC router with controlled hashing and disk doubles. */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const env = vi.hoisted(() => ({ clients: [] as any[], listener: null as any, sent: [] as any[], exists: true }));
vi.mock('electron', () => ({ ipcRenderer: {
  on: (_channel: string, listener: any) => { env.listener = listener; },
  send: (channel: string, data: any) => env.sent.push({ channel, data }),
} }));
vi.mock('fs', () => ({ default: { existsSync: () => env.exists } }));
vi.mock('./chromium-webrtc', () => ({ useChromiumWebRTC: vi.fn() }));
vi.mock('fs-chunk-store', () => ({ default: class {} }));
vi.mock('webtorrent', () => ({ default: class extends EventEmitter {
  torrents: any[] = []; destroyed = false; callbacks: Array<(torrent: any) => void> = [];
  constructor(public options: any) { super(); env.clients.push(this); }
  seed = vi.fn((_source, _options, callback) => { this.callbacks.push(callback); });
  remove = vi.fn(async (torrent, callback) => { this.torrents = this.torrents.filter(t => t !== torrent); callback?.(); });
  destroy = vi.fn(() => { this.destroyed = true; this.torrents = []; });
  finish(hash = 'hash', callbackIndex = 0) {
    let torrent = this.torrents.find(t => t.infoHash === hash);
    if (!torrent) { torrent = Object.assign(new EventEmitter(), { infoHash: hash, magnetURI: 'magnet:' + hash, numPeers: 0 }); this.torrents.push(torrent); }
    this.callbacks[callbackIndex](torrent); return torrent;
  }
} }));
let sequence = 0;
const flush = async () => { await vi.dynamicImportSettled(); for (let i = 0; i < 15; i++) await Promise.resolve(); };
async function command(type: string, downloadId = 'a') {
  const reqId = ++sequence;
  await env.listener(null, { type, reqId, downloadId, contentPath: '/file', name: 'file', useTurn: false, trackers: ['ws://localhost'] });
  return env.sent.find(msg => msg.channel === 'share-res' && msg.data.reqId === reqId).data;
}
beforeEach(async () => {
  vi.resetModules(); env.clients = []; env.sent = []; env.exists = true;
  vi.stubGlobal('window', {}); await import('./share-seeder');
});
afterEach(() => vi.unstubAllGlobals());

describe('share seeder resources', () => {
  it('coalesces hashing for one download and uses the byte-budget store', async () => {
    const first = command('share'), second = command('share'); await flush(); const c = env.clients[0];
    expect(c.seed).toHaveBeenCalledOnce(); expect(c.seed.mock.calls[0][1]).toMatchObject({ storeCacheSlots: 0, store: expect.any(Function) });
    c.finish(); expect((await first).activeCount).toBe(1); expect((await second).activeCount).toBe(1);
    expect((await command('list')).data).toHaveLength(1);
  });
  it('removes a torrent before retiring the last client and creates a new client later', async () => {
    const start = command('share'); await flush(); const first = env.clients[0]; first.finish(); await start;
    expect((await command('stop')).activeCount).toBe(0); expect(first.remove).toHaveBeenCalledOnce(); expect(first.destroy).toHaveBeenCalledOnce();
    const next = command('share', 'b'); await flush(); expect(env.clients).toHaveLength(2); env.clients[1].finish(); await next;
    expect((await command('get', 'b')).data.peers).toBe(0); expect(env.clients[1].destroy).not.toHaveBeenCalled();
  });
  it('keeps a shared swarm until all download entries release it', async () => {
    const a = command('share', 'a'); await flush(); const c = env.clients[0]; c.finish(); await a;
    const b = command('share', 'b'); await flush(); c.finish('hash', 1); await b;
    expect((await command('stop', 'a')).activeCount).toBe(1); expect(c.remove).not.toHaveBeenCalled(); expect(c.destroy).not.toHaveBeenCalled();
    expect((await command('stop', 'b')).activeCount).toBe(0); expect(c.remove).toHaveBeenCalledOnce(); expect(c.destroy).toHaveBeenCalledOnce();
  });
  it('keeps another pending seed alive and cancels a stop that arrives during hashing', async () => {
    const a = command('share', 'a'); await flush(); const c = env.clients[0]; c.finish(); await a;
    const b = command('share', 'b'); await flush();
    expect((await command('stop', 'a')).activeCount).toBe(1); expect(c.destroy).not.toHaveBeenCalled();
    expect((await command('stop', 'b')).activeCount).toBe(1);
    c.finish('other', 1); expect(await b).toMatchObject({ ok: false, error: 'Sharing was canceled', activeCount: 0 });
    expect(c.destroy).toHaveBeenCalledOnce();
  });
  it('reclaims a failed client and reports a spontaneous last-torrent error', async () => {
    const failed = command('share'); await flush(); const c = env.clients[0]; c.emit('error', new Error('hash failed'));
    expect(await failed).toMatchObject({ ok: false, activeCount: 0 }); expect(c.destroy).toHaveBeenCalledOnce();
    const start = command('share'); await flush(); const next = env.clients[1]; const torrent = next.finish(); await start;
    torrent.emit('error', new Error('disk failed'));
    expect(next.destroy).toHaveBeenCalledOnce(); expect(env.sent.findLast(msg => msg.channel === 'share-count').data).toBe(0);
    expect((await command('list')).data).toEqual([]);
  });
  it('does not construct a client for a missing file', async () => {
    env.exists = false; expect(await command('share')).toMatchObject({ ok: false, activeCount: 0 }); expect(env.clients).toHaveLength(0);
  });
  it('drops a fatally closed client and ignores a late error from its old torrent', async () => {
    const start = command('share'); await flush(); const c = env.clients[0]; const oldTorrent = c.finish(); await start;
    c.destroyed = true; c.emit('error', new Error('client closed'));
    expect((await command('list')).data).toEqual([]);
    const next = command('share', 'b'); await flush(); env.clients[1].finish(); await next;
    oldTorrent.emit('error', new Error('late error'));
    expect((await command('get', 'b')).data.downloadId).toBe('b');
  });
});
