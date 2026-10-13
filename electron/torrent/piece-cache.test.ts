import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PieceCache, type ChunkStore } from './piece-cache';

function fixture(cache: PieceCache, pieceLength = 4) {
  const chunks = new Map<number, Buffer>([[0, Buffer.from('abcd')], [1, Buffer.from('efgh')], [2, Buffer.from('ijkl')]]);
  const raw: ChunkStore = {
    chunkLength: pieceLength,
    get: vi.fn((index, options, cb) => {
      const callback = typeof options === 'function' ? options : cb!;
      const buf = chunks.get(index);
      queueMicrotask(() => callback(buf ? null : new Error('missing'), buf));
    }),
    put: vi.fn((index, data, cb) => { chunks.set(index, Buffer.from(data)); queueMicrotask(() => cb?.()); }),
    close: vi.fn(cb => cb?.()), destroy: vi.fn(cb => cb?.()),
  };
  return { raw, store: cache.wrap(raw) };
}
const read = (store: ChunkStore, index = 0, range = {}) => new Promise<Uint8Array>((resolve, reject) => {
  store.get(index, range, (error, data) => error ? reject(error) : resolve(data!));
});
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('shared piece cache', () => {
  it('evicts by bytes across stores, retaining recently read pieces', async () => {
    const cache = new PieceCache(8), a = fixture(cache), b = fixture(cache);
    await read(a.store); await read(b.store); await read(a.store); await read(b.store, 1);
    expect(cache.retainedBytes).toBe(8); expect(cache.retainedPieces).toBe(2);
    await read(a.store); expect(a.raw.get).toHaveBeenCalledOnce();
    await read(b.store); expect(b.raw.get).toHaveBeenCalledTimes(3);
    a.store.close(); expect(cache.retainedBytes).toBe(4);
    b.store.destroy(); expect(cache.retainedBytes).toBe(0);
  });
  it('coalesces disk reads and returns the requested ranges', async () => {
    const cache = new PieceCache(8), { store, raw } = fixture(cache);
    const ranges = await Promise.all([read(store, 0, { offset: 1, length: 2 }), read(store, 0, { offset: 3 })]);
    expect(ranges.map(buf => Buffer.from(buf).toString())).toEqual(['bc', 'd']);
    expect(raw.get).toHaveBeenCalledOnce();
    expect(Buffer.from(await read(store, 0, { offset: 0, length: 0 })).toString()).toBe('');
    await expect(read(store, 0, { offset: 3, length: 3 })).rejects.toThrow('range');
  });
  it('does not retain an oversized piece and preserves range reads', async () => {
    const cache = new PieceCache(3), { store, raw } = fixture(cache);
    await read(store, 0, { offset: 2, length: 1 });
    expect(raw.get).toHaveBeenCalledWith(0, { offset: 2, length: 1 }, expect.any(Function));
    expect(cache.retainedBytes).toBe(0);
  });
  it('copies small views into exact allocations instead of retaining their slabs', async () => {
    const cache = new PieceCache(8), { store, raw } = fixture(cache);
    vi.mocked(raw.get).mockImplementation((_index, options, cb) => {
      const callback = typeof options === 'function' ? options : cb!;
      callback(null, Buffer.alloc(1024 * 1024).subarray(10, 14));
    });
    await read(store); const cached = await read(store);
    expect(cached.buffer.byteLength).toBe(4); expect(cache.retainedBytes).toBe(4);
  });
  it('invalidates writes, including a read that completes after the write', async () => {
    const cache = new PieceCache(8), { store, raw } = fixture(cache);
    let finish!: (error: Error | null, data: Buffer) => void;
    vi.mocked(raw.get).mockImplementationOnce((_index, options) => { finish = options as typeof finish; });
    const stale = read(store);
    await new Promise<void>(resolve => store.put(0, Buffer.from('new!'), () => resolve()));
    finish(null, Buffer.from('old!')); await stale;
    expect(cache.retainedBytes).toBe(0);
    expect(Buffer.from(await read(store)).toString()).toBe('new!');
    await new Promise<void>(resolve => store.put(0, Buffer.from('last'), () => resolve()));
    expect(Buffer.from(await read(store)).toString()).toBe('last');
  });
  it('rejects pending reads once on close and ignores their late data', async () => {
    const cache = new PieceCache(8), { store, raw } = fixture(cache);
    let finish!: (error: Error | null, data: Buffer) => void;
    vi.mocked(raw.get).mockImplementation((_index, options) => { finish = options as typeof finish; });
    const pending = read(store); store.close();
    await expect(pending).rejects.toThrow('closed'); finish(null, Buffer.from('late'));
    expect(cache.retainedBytes).toBe(0);
    await expect(read(store)).rejects.toThrow('closed');
  });
  it('forwards read errors and retains no failed piece', async () => {
    const cache = new PieceCache(8), { store } = fixture(cache);
    await expect(read(store, 9)).rejects.toThrow('missing'); expect(cache.retainedBytes).toBe(0);
  });
  it('caps cache bookkeeping for very small pieces', async () => {
    const cache = new PieceCache(8192), { store, raw } = fixture(cache, 1);
    vi.mocked(raw.get).mockImplementation((_index, options) => (options as (e: null, b: Buffer) => void)(null, Buffer.from('x')));
    for (let i = 0; i < 4100; i++) await read(store, i);
    expect(cache.retainedPieces).toBe(4096); expect(cache.retainedBytes).toBe(4096);
    store.close(); expect(cache.retainedPieces).toBe(0);
  });
  it('seeds and downloads real WebTorrent data through the bounded filesystem store', async () => {
    const [{ default: WebTorrent }, { default: FSStore }] = await Promise.all([import('webtorrent'), import('fs-chunk-store')]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-piece-cache-')); roots.push(root);
    const source = path.join(root, 'source.bin'), destination = path.join(root, 'download');
    const bytes = Buffer.alloc(80 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    fs.writeFileSync(source, bytes);
    const cache = new PieceCache(32 * 1024), Store = cache.store(FSStore);
    const quiet = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false };
    const seed = new WebTorrent(quiet), leecher = new WebTorrent(quiet);
    seed.on('error', () => {}); leecher.on('error', () => {});
    try {
      const torrent = await new Promise<any>((resolve, reject) => {
        seed.seed(source, { announce: [], pieceLength: 16384, store: Store, storeCacheSlots: 0 } as any, resolve).once('error', reject);
      });
      const downloading = leecher.add(torrent.torrentFile, { path: destination, store: Store, storeCacheSlots: 0 } as any);
      await new Promise<void>((resolve, reject) => { downloading.once('ready', resolve); downloading.once('error', reject); });
      const address = seed.address() as { port: number };
      downloading.addPeer('127.0.0.1:' + address.port);
      await new Promise<void>((resolve, reject) => { downloading.once('done', resolve); downloading.once('error', reject); });
      expect(fs.readFileSync(path.join(destination, torrent.name))).toEqual(bytes);
      expect(cache.retainedBytes).toBeLessThanOrEqual(cache.limit);
      expect((downloading as any)._storeCacheSlots).toBe(0);
      expect((torrent as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
    } finally {
      await Promise.all([seed, leecher].map(client => new Promise<void>(resolve => client.destroy(() => resolve()))));
    }
    expect(cache.retainedBytes).toBe(0);
    expect(fs.readFileSync(source)).toEqual(bytes);
  }, 15000);
});
