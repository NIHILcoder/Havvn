import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { Download } from '../../shared/types';
import { VerifiedDiskMedia } from './verified-media';
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('./host/env', () => ({ getHostEnv: () => ({ isPackaged: false, engineStateDir: os.tmpdir() }) }));
vi.mock('./host/db-bridge', () => ({ updateDownloadStatus: vi.fn(), updateDownloadField: vi.fn(), updateDownloadFields: vi.fn() }));
import { TorrentManager } from './manager';
import { NativeTorrentManager } from './native/native-manager';
const require = createRequire(__filename);
const parse = require('parse-torrent');
const bencode = createRequire(require.resolve('parse-torrent'))('bencode');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { expect(path.dirname(root)).toBe(fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true }); } });
function diskFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-verified-media-')); roots.push(root);
  const content = Buffer.from('abc0123456789XYZ'), pieceSize = 8;
  const hashes = [content.subarray(0, 8), content.subarray(8)].map(p => crypto.createHash('sha1').update(p).digest());
  const encoded = bencode.encode({ info: { name: 'bundle', 'piece length': pieceSize, pieces: Buffer.concat(hashes), files: [
    { length: 3, path: ['other.bin'] }, { length: 10, path: ['Фильм.mp4'] }, { length: 3, path: ['tail.bin'] },
  ] } });
  const torrentFile = path.join(root, 'source.torrent'); fs.writeFileSync(torrentFile, encoded);
  fs.mkdirSync(path.join(root, 'bundle')); fs.writeFileSync(path.join(root, 'bundle/other.bin'), 'abc');
  fs.writeFileSync(path.join(root, 'bundle/Фильм.mp4.part'), Buffer.alloc(10)); fs.writeFileSync(path.join(root, 'bundle/tail.bin'), 'XYZ');
  return { root, torrentFile, content, meta: parse(encoded), disk: path.join(root, 'bundle/Фильм.mp4.part'), rel: 'bundle/Фильм.mp4' };
}
it('verifies bytes across file boundaries, blocks sparse zeros despite a full bitfield, and handles .part rename', async () => {
  const f = diskFixture(), reader = new VerifiedDiskMedia(), meta = reader.load(f.meta.infoHash, f.torrentFile, f.root)!;
  expect(meta).not.toBeNull(); expect(reader.load('f'.repeat(40), f.torrentFile, f.root)).toBeNull();
  expect(await reader.read(meta, f.root, 1, 0, 10)).toBeNull();
  fs.writeFileSync(f.disk, '0123456789');
  expect((await reader.read(meta, f.root, 1, 0, 10))!.toString()).toBe('01234');
  fs.renameSync(f.disk, f.disk.slice(0, -5));
  expect((await reader.read(meta, f.root, 1, 7, 10))!.toString()).toBe('789');
});
it('native reads only an existing active wanted file, verifies disk-cache flush, and leaves controls unchanged', async () => {
  const f = diskFixture(), manager = new NativeTorrentManager(), state = manager as any;
  const d = { id: 'test', infoHash: f.meta.infoHash, savePath: f.root, torrentFilePath: f.torrentFile, status: 'paused', progress: 0.5 } as Download;
  const t = { status: 4, files: f.meta.files.map((file: { path: string; length: number }) => ({ name: file.path, length: file.length, bytesCompleted: file.length })), fileStats: [0, 1, 2].map(() => ({ wanted: true })), pieceSize: 8, pieceCount: 2, pieces: Buffer.from([0xc0]).toString('base64') };
  const rpc = { torrentGet: vi.fn(async () => [t]), torrentSet: vi.fn(), torrentStartNow: vi.fn(), torrentAdd: vi.fn(), torrentStop: vi.fn() };
  state.ready = Promise.resolve(); state.rpc = rpc; state.records.set('test', d); state.idToHash.set('test', f.meta.infoHash);
  expect(await manager.getExternalMedia('test', f.rel)).toEqual({ ok: false, reason: 'paused-file' }); expect(rpc.torrentGet).not.toHaveBeenCalled();
  d.status = 'downloading'; const info = await manager.getExternalMedia('test', f.rel); if (!info.ok) throw Error(info.reason);
  expect(await manager.readExternalMedia('test', f.rel, info.key, 0, 10)).toEqual({ wait: true });
  fs.writeFileSync(f.disk, '0123456789');
  expect(await manager.readExternalMedia('test', f.rel, info.key, 7, 3)).toEqual({ data: Buffer.from('789').toString('base64') });
  expect(await manager.readExternalMedia('test', f.rel, 'old-engine', 0, 10)).toEqual({ reason: 'unavailable' });
  d.filePriorities = { 1: 'skip' }; expect(await manager.getExternalMedia('test', f.rel)).toEqual({ ok: false, reason: 'excluded-file' });
  d.filePriorities = {}; d.selectedFiles = [0]; expect((await manager.getExternalMedia('test', f.rel)).ok).toBe(false);
  for (const name of ['torrentSet', 'torrentStartNow', 'torrentAdd', 'torrentStop'] as const) expect(rpc[name]).not.toHaveBeenCalled();
  expect(d.status).toBe('downloading');
});
it('classic engine reads verified pieces from its store without selecting files or resuming', async () => {
  const manager = new TorrentManager(), state = manager as any;
  const d = { status: 'downloading', savePath: 'D:/downloads' } as Download;
  let ready = false;
  const torrent = { infoHash: 'a'.repeat(40), pieceLength: 8, bitfield: { get: () => ready }, files: [{ name: 'film.mp4', path: 'bundle/film.mp4', offset: 3, length: 10 }], select: vi.fn(), resume: vi.fn(), store: { get: vi.fn((_i, cb) => cb(null, Buffer.from('abc01234'))) } };
  state.managedTorrents.set('test', { torrent, download: d });
  const info = await manager.getExternalMedia('test', 'bundle/film.mp4'); if (!info.ok) throw Error(info.reason);
  expect(await manager.readExternalMedia('test', 'bundle/film.mp4', info.key, 0, 10)).toEqual({ wait: true }); expect(torrent.store.get).not.toHaveBeenCalled();
  ready = true; expect(await manager.readExternalMedia('test', 'bundle/film.mp4', info.key, 0, 10)).toEqual({ data: Buffer.from('01234').toString('base64') });
  d.status = 'paused'; expect(await manager.readExternalMedia('test', 'bundle/film.mp4', info.key, 0, 10)).toEqual({ reason: 'paused-file' });
  expect((await manager.getExternalMedia('test', '../film.mp4')).ok).toBe(false); expect(torrent.select).not.toHaveBeenCalled(); expect(torrent.resume).not.toHaveBeenCalled();
});
