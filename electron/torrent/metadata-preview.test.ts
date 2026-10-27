import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const env = vi.hoisted(() => ({ root: '', clients: [] as any[], automatic: true }));
vi.mock('./host/db-bridge', () => ({ getSettings: async () => ({ enableDHT: false, enableLSD: false, enablePEX: false, maxConnections: 3 }) }));
vi.mock('../utils', () => ({ formatBytes: (value: number) => String(value), logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('./host/env', () => ({ getHostEnv: () => ({ tempDir: env.root, userDataDir: env.root, downloadsDir: env.root, isPackaged: false }) }));
vi.mock('webtorrent', () => ({ default: class extends EventEmitter {
  options: any; complete: any;
  constructor(public clientOptions: any) { super(); env.clients.push(this); }
  destroy = vi.fn((callback?: () => void) => { callback?.(); });
  add(_source: unknown, options: any, complete: any) {
    this.options = options; this.complete = complete;
    if (env.automatic) complete({ infoHash: 'a'.repeat(40), name: 'one.txt', files: [{ path: 'one.txt', length: 1 }] });
  }
  remove(_hash: string, options: any, complete: () => void) {
    const file = path.join(this.options.path, 'one.txt');
    if (options.destroyStore && fs.existsSync(file)) fs.unlinkSync(file);
    complete();
  }
} }));
import { TorrentManager } from './manager';
import { NativeTorrentManager } from './native/native-manager';
import { setTransferBlocks } from './transfer-policy';
beforeEach(() => { env.root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-meta-test-')); env.clients.length = 0; env.automatic = true; });
afterEach(() => {
  setTransferBlocks([]); vi.restoreAllMocks(); vi.useRealTimers();
  if (path.dirname(path.resolve(env.root)) !== path.resolve(os.tmpdir()) || !path.basename(env.root).startsWith('havvn-meta-test-')) throw Error('Invalid test cleanup path');
  fs.rmSync(env.root, { recursive: true, force: true });
});
const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
it.each(['native', 'webtorrent'])('%s preserves different metadata with the same basename even within one clock tick', engine => {
  vi.spyOn(Date, 'now').mockReturnValue(12345);
  for (const folder of ['first', 'second']) fs.mkdirSync(path.join(env.root, folder));
  const first = path.join(env.root, 'first', 'same.torrent'), second = path.join(env.root, 'second', 'same.torrent');
  fs.writeFileSync(first, 'original metadata'); fs.writeFileSync(second, 'different metadata');
  const manager = engine === 'native' ? new NativeTorrentManager() : new TorrentManager();
  const a = (manager as any).copyTorrentIntoAppData(first), b = (manager as any).copyTorrentIntoAppData(second);
  expect(a).not.toBe(b); expect(fs.readFileSync(a, 'utf8')).toBe('original metadata'); expect(fs.readFileSync(b, 'utf8')).toBe('different metadata');
});
it('reads a local torrent without constructing any networking client', async () => {
  const bencode = createRequire(import.meta.url)('bencode');
  const file = path.join(env.root, 'one.torrent');
  fs.writeFileSync(file, bencode.encode({ info: { name: 'one.txt', length: 1, 'piece length': 16384, pieces: Buffer.alloc(20) } }));
  expect(await new TorrentManager().getTorrentInfo({ torrentPath: file })).toMatchObject({ name: 'one.txt', totalSize: 1, files: [{ path: 'one.txt', size: 1, index: 0 }] });
  expect(env.clients).toHaveLength(0);
});
it('keeps pre-existing temporary files when a Classic metadata preview is cleaned up', async () => {
  const unrelated = path.join(env.root, 'one.txt'); fs.writeFileSync(unrelated, 'keep this');
  await new TorrentManager().getTorrentInfo({ magnetUri: magnet });
  expect(env.clients[0].options.path).not.toBe(env.root);
  expect(env.clients[0].clientOptions).toMatchObject({ dht: false, lsd: false, utPex: false, maxConns: 3 });
  expect(fs.readFileSync(unrelated, 'utf8')).toBe('keep this');
});

it('bounds Native HTTP metadata by declared and actual size and isolates simultaneous temporary files', async () => {
  const manager = new NativeTorrentManager() as any;
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  fetchMock.mockResolvedValueOnce(new Response('small', { headers: { 'content-length': String(11 * 1024 * 1024) } }));
  await expect(manager.fetchTorrentToTemp('https://fixture.invalid')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  fetchMock.mockResolvedValueOnce(new Response(Buffer.alloc(10 * 1024 * 1024 + 1)));
  await expect(manager.fetchTorrentToTemp('https://fixture.invalid')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  vi.spyOn(Date, 'now').mockReturnValue(12345);
  fetchMock.mockResolvedValueOnce(new Response('first')).mockResolvedValueOnce(new Response('second'));
  const [a, b] = await Promise.all([manager.fetchTorrentToTemp('https://a.invalid'), manager.fetchTorrentToTemp('https://b.invalid')]);
  expect(a).not.toBe(b); expect(fs.readFileSync(a, 'utf8')).toBe('first'); expect(fs.readFileSync(b, 'utf8')).toBe('second');
});
it('destroys an in-flight Classic metadata client when transfer protection activates', async () => {
  env.automatic = false;
  const result = new TorrentManager().getTorrentInfo({ magnetUri: magnet }).catch(error => error);
  await flush(); expect(env.clients).toHaveLength(1);
  setTransferBlocks(['vpn']); expect(await result).toMatchObject({ code: 'TRANSFER_BLOCKED' });
  expect(env.clients[0].destroy).toHaveBeenCalledOnce();
});
it.each([false, true])('cancels Native metadata probing while preserving a real existing torrent: duplicate=%s', async duplicate => {
  vi.useFakeTimers(); const manager = new NativeTorrentManager(), state = manager as any;
  const rpc = { torrentGet: vi.fn().mockResolvedValue([{ hashString: 'a'.repeat(40), metadataPercentComplete: 0, files: [] }]),
    torrentAdd: vi.fn().mockResolvedValue({ hashString: 'a'.repeat(40), duplicate }), torrentRemove: vi.fn().mockResolvedValue(undefined) };
  if (!duplicate) rpc.torrentGet.mockResolvedValueOnce([]);
  state.ready = Promise.resolve(); state.rpc = rpc;
  const result = manager.getTorrentInfo({ magnetUri: magnet }).catch(error => error);
  await flush(); setTransferBlocks(['disk']); await vi.advanceTimersByTimeAsync(501);
  expect(await result).toMatchObject({ code: 'TRANSFER_BLOCKED' });
  if (duplicate) expect(rpc.torrentRemove).not.toHaveBeenCalled();
  else expect(rpc.torrentRemove).toHaveBeenCalledExactlyOnceWith('a'.repeat(40), true);
});
