import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Torrent } from 'webtorrent';
import parseTorrent, { toTorrentFile, type Instance as ParsedTorrent } from 'parse-torrent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoomBlobTransport } from './room-blob-transport';
import { RoomReceiveQueue } from './room-receive-queue';
import { prepareSyncSnapshot, type SyncSnapshot } from './room-sync-snapshot';
import { roomDiskName } from './room-file-storage';

let directory: string, snapshot: SyncSnapshot;
const transports: RoomBlobTransport[] = [];
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sync-blob-'));
  const source = path.join(directory, 'config.ini'); fs.writeFileSync(source, 'verified configuration');
  snapshot = await prepareSyncSnapshot({ source, storage: path.join(directory, 'snapshots'), authorId: 'a'.repeat(32) });
});
afterEach(async () => {
  await Promise.all(transports.splice(0).map(t => t.close()));
  fs.rmSync(directory, { recursive: true, force: true });
});
function fixture(capacity = 2) {
  const queue = new RoomReceiveQueue(capacity), torrents = new Map<string, Torrent>();
  const releaseClient = vi.fn(), releaseDisk = vi.fn();
  const add = vi.fn((metadata: Buffer, target: string, hash: string) => {
    const torrent = Object.assign(new EventEmitter(), { infoHash: hash, done: true, torrentFile: metadata }) as unknown as Torrent;
    torrents.set(hash, torrent); return torrent;
  });
  const options = { directory: path.join(directory, 'downloads'), current: () => true,
    find: (hash: string) => torrents.get(hash), add,
    remove: vi.fn(async (torrent: Torrent) => { torrents.delete(torrent.infoHash); }),
    acquire: vi.fn((owner: object, id: string) => queue.acquire(owner, id)), cancel: (owner: object) => queue.cancel(owner),
    hold: vi.fn(() => releaseClient), reserve: vi.fn(() => releaseDisk) };
  const transport = new RoomBlobTransport(options); transports.push(transport);
  return { transport, options, torrents, queue, add, releaseClient, releaseDisk };
}

it('checks signed layout before allocating download space or adding a torrent', () => {
  const f = fixture();
  expect(() => f.transport.fetch({ ...snapshot.file, name: 'substituted.ini' }, snapshot.metadata)).toThrow('metadata');
  expect(f.add).not.toHaveBeenCalled(); expect(f.options.reserve).not.toHaveBeenCalled();
  expect(fs.existsSync(f.options.directory)).toBe(false);
});
it('releases a cached seeder before eviction while preserving retained source bytes', async () => {
  const f = fixture(); await f.transport.seed(snapshot.file, snapshot.sourcePath, snapshot.metadata);
  expect(await f.transport.release(snapshot.file.infoHash)).toBe(true);
  expect(f.options.remove).toHaveBeenCalledOnce(); expect(f.torrents.has(snapshot.file.infoHash)).toBe(false);
  expect(fs.existsSync(snapshot.sourcePath)).toBe(true);
});
it('refuses release during a pending download or an active upload', async () => {
  const f = fixture(0), pending = f.transport.fetch(snapshot.file, snapshot.metadata);
  expect(await f.transport.release(snapshot.file.infoHash)).toBe(false);
  const assertion = expect(pending).rejects.toThrow('canceled'); await f.transport.close(); await assertion;
  const g = fixture(); await g.transport.seed(snapshot.file, snapshot.sourcePath, snapshot.metadata);
  Object.assign(g.torrents.get(snapshot.file.infoHash)!, { uploadSpeed: 100 });
  expect(await g.transport.release(snapshot.file.infoHash)).toBe(false); expect(g.options.remove).not.toHaveBeenCalled();
});

it('strips unauthenticated tracker and web-seed endpoints before client.add', async () => {
  const f = fixture(), parse = parseTorrent as unknown as (bytes: Buffer) => ParsedTorrent;
  const withUrls = Buffer.from(toTorrentFile({ ...parse(snapshot.metadata), announce: ['wss://untrusted.invalid/announce'], urlList: ['http://127.0.0.1/private'] }));
  await f.transport.seed(snapshot.file, snapshot.sourcePath, withUrls);
  const accepted = parse(f.add.mock.calls[0][0]);
  expect(accepted.infoHash).toBe(snapshot.file.infoHash);
  expect(accepted.announce).toEqual([]); expect(accepted.urlList).toEqual([]);
});

it('seeds retained bytes even when all shared receive slots are occupied', async () => {
  const f = fixture(0);
  await f.transport.seed(snapshot.file, snapshot.sourcePath, snapshot.metadata);
  expect(f.options.acquire).not.toHaveBeenCalled(); expect(f.add).toHaveBeenCalledOnce();
  expect(f.releaseClient).toHaveBeenCalledOnce(); expect(f.options.reserve).not.toHaveBeenCalled();
  await f.transport.close(); expect(f.options.remove).toHaveBeenCalledOnce();
  expect(fs.readFileSync(snapshot.sourcePath, 'utf8')).toBe('verified configuration');
});

it('rejects corrupt source bytes without touching the client', async () => {
  const f = fixture(); fs.writeFileSync(snapshot.sourcePath, 'corruptd configuration');
  await expect(f.transport.seed(snapshot.file, snapshot.sourcePath, snapshot.metadata)).rejects.toThrow();
  expect(f.add).not.toHaveBeenCalled(); expect(f.releaseClient).toHaveBeenCalledOnce();
});

it('does not take over an existing ordinary torrent with the same hash', async () => {
  const f = fixture(), ordinary = { infoHash: snapshot.file.infoHash } as Torrent;
  f.torrents.set(ordinary.infoHash, ordinary);
  await expect(f.transport.seed(snapshot.file, snapshot.sourcePath, snapshot.metadata)).rejects.toThrow('another room transfer');
  await f.transport.close(); expect(f.options.remove).not.toHaveBeenCalled(); expect(f.torrents.get(ordinary.infoHash)).toBe(ordinary);
});

it('cancels queued receives on close without starting disk writes', async () => {
  const f = fixture(0), pending = f.transport.fetch(snapshot.file, snapshot.metadata);
  const assertion = expect(pending).rejects.toThrow('canceled');
  await f.transport.close(); await assertion;
  expect(f.options.reserve).not.toHaveBeenCalled(); expect(f.add).not.toHaveBeenCalled();
});

it('rejects downloaded bytes with wrong pieces and releases the shared resources', async () => {
  const f = fixture();
  f.add.mockImplementation((metadata, target, hash) => {
    fs.writeFileSync(path.join(target, roomDiskName(snapshot.file)), Buffer.alloc(snapshot.file.size));
    const torrent = Object.assign(new EventEmitter(), { infoHash: hash, done: true, torrentFile: metadata }) as unknown as Torrent;
    f.torrents.set(hash, torrent); return torrent;
  });
  await expect(f.transport.fetch(snapshot.file, snapshot.metadata)).rejects.toThrow('contents have changed');
  expect(f.options.remove).toHaveBeenCalledOnce(); expect(f.releaseClient).toHaveBeenCalledOnce(); expect(f.releaseDisk).toHaveBeenCalledOnce();
  expect(f.queue.counts(f.transport)).toEqual({ active: 0, waiting: 0 });
});

it('replaces a damaged owned torrent from another verified retained copy', async () => {
  const f = fixture(), backupDir = path.join(directory, 'backup'); fs.mkdirSync(backupDir);
  const backup = path.join(backupDir, roomDiskName(snapshot.file)); fs.copyFileSync(snapshot.sourcePath, backup);
  await f.transport.seed(snapshot.file, snapshot.sourcePath, snapshot.metadata);
  fs.writeFileSync(snapshot.sourcePath, 'corruptd configuration');
  const result = await f.transport.seed(snapshot.file, backup, snapshot.metadata);
  expect(result.sourcePath).toBe(backup); expect(f.options.remove).toHaveBeenCalledOnce(); expect(f.add).toHaveBeenCalledTimes(2);
});
