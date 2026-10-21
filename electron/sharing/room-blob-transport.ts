import fs from 'node:fs';
import path from 'node:path';
import type { Torrent } from 'webtorrent';
import parseTorrent, { toTorrentFile, type Instance as ParsedTorrent } from 'parse-torrent';
import type { RoomFile } from '../../shared/types';
import { roomDiskName, roomTorrentMetadata, verifyRoomFile } from './room-file-storage';
import { assertSyncPlainPath } from './room-sync-snapshot';
import { RoomReceiveQueue } from './room-receive-queue';

interface BlobResult { sourcePath: string; metadata: Buffer }
const parseSyncTorrent = parseTorrent as unknown as (bytes: Buffer) => ParsedTorrent;
type BlobTorrent = Torrent & { destroyed?: boolean };
interface BlobOptions {
  directory: string;
  current(): boolean;
  find(hash: string): BlobTorrent | undefined;
  add(metadata: Buffer, directory: string, hash: string): BlobTorrent;
  remove(torrent: BlobTorrent): Promise<void>;
  acquire(owner: object, id: string): Promise<() => void>;
  cancel(owner: object): void;
  hold(): () => void;
  reserve(bytes: number): () => void;
}

/** Uses the room's existing client, queue, disk reservation and traffic limits. */
export class RoomBlobTransport {
  private owned = new Map<string, { torrent: BlobTorrent; sourcePath: string }>();
  private pending = new Map<string, Promise<BlobResult>>();
  private stopped = false;
  private seedQueue = new RoomReceiveQueue(1, 128);
  private retiring = new Set<string>();
  constructor(private readonly options: BlobOptions) {}
  current(): boolean { return !this.stopped && this.options.current(); }
  private check(): void { if (!this.current()) throw new Error('Sync blob transport stopped'); }

  async close(): Promise<void> {
    this.stopped = true; this.options.cancel(this); this.seedQueue.cancel(this);
    await Promise.allSettled([...this.owned.values()].map(({ torrent }) => this.options.remove(torrent)));
    this.owned.clear();
  }

  seed(file: RoomFile, sourcePath: string, metadata: Buffer): Promise<BlobResult> { return this.run(file, metadata, sourcePath); }
  fetch(file: RoomFile, metadata: Buffer): Promise<BlobResult> { return this.run(file, metadata); }
  async release(hash: string): Promise<boolean> {
    this.check();
    if (this.pending.has(hash) || this.retiring.has(hash)) return false;
    this.retiring.add(hash);
    try {
      const entry = this.owned.get(hash);
      if (entry && entry.torrent.uploadSpeed > 0) return false;
      if (entry) {
        await this.options.remove(entry.torrent); this.owned.delete(hash);
        const directory = path.dirname(path.resolve(entry.sourcePath));
        if (path.dirname(directory) === path.resolve(this.options.directory) && /^blob-[a-zA-Z0-9]+$/.test(path.basename(directory))) {
          assertSyncPlainPath(entry.sourcePath);
          await fs.promises.rm(entry.sourcePath, { force: true });
          assertSyncPlainPath(directory); await fs.promises.rmdir(directory);
        }
      }
      return true;
    } finally { this.retiring.delete(hash); }
  }
  private run(file: RoomFile, metadata: Buffer, source?: string): Promise<BlobResult> {
    this.check(); roomDiskName(file); roomTorrentMetadata(file, metadata);
    if (this.retiring.has(file.infoHash)) throw new Error('Sync blob cache maintenance in progress');
    const parsed = parseSyncTorrent(metadata);
    if (!parsed.private) throw new Error('A private sync torrent is required');
    // Trackers and web seeds are outside the authenticated info dictionary.
    // WebTorrent *merges* opts.announce with metadata URLs, so remove them here;
    // only the existing room transport may supply discovery endpoints.
    const payload = Buffer.from(toTorrentFile({ info: parsed.info, infoHash: parsed.infoHash, announce: [], urlList: [] }));
    roomTorrentMetadata(file, payload);
    if (this.pending.has(file.infoHash)) return this.pending.get(file.infoHash)!;
    const operation = (async () => {
      // Local source preparation must not wait behind network downloads: two
      // members receiving from each other would otherwise exhaust both slots.
      const releaseSlot = source ? await this.seedQueue.acquire(this, file.infoHash) : await this.options.acquire(this, file.infoHash);
      let releaseClient: (() => void) | undefined, releaseDisk: (() => void) | undefined;
      try {
        this.check(); releaseClient = this.options.hold();
        const retained = this.owned.get(file.infoHash);
        if (retained && this.options.find(file.infoHash) === retained.torrent && !retained.torrent.destroyed) {
          try {
            await verifyRoomFile(retained.sourcePath, file, metadata); this.check();
            this.owned.delete(file.infoHash); this.owned.set(file.infoHash, retained);
            return { sourcePath: retained.sourcePath, metadata };
          } catch { this.owned.delete(file.infoHash); await this.options.remove(retained.torrent); this.check(); }
        }
        // Private snapshots occupy a different info hash than normal publications.
        // Never steal or remove an unrelated torrent if a deliberate collision exists.
        if (this.options.find(file.infoHash)) throw new Error('Sync blob hash is already used by another room transfer');
        let target: string;
        if (source) {
          assertSyncPlainPath(source); await verifyRoomFile(source, file, metadata); this.check(); target = source;
        } else {
          assertSyncPlainPath(this.options.directory);
          await fs.promises.mkdir(this.options.directory, { recursive: true }); assertSyncPlainPath(this.options.directory);
          releaseDisk = this.options.reserve(file.size + (file.enc ? 28 : 0));
          // A fresh private directory isolates retries without repeating the
          // 64-character file ID in Windows paths (mkdtemp has a short path limit).
          target = path.join(await fs.promises.mkdtemp(path.join(this.options.directory, 'blob-')), roomDiskName(file));
        }
        this.check();
        if (this.owned.size >= 256) {
          const idle = [...this.owned].find(([hash, entry]) => entry.torrent.done && !this.pending.has(hash));
          if (!idle) throw new Error('Sync blob capacity reached');
          await this.options.remove(idle[1].torrent); this.owned.delete(idle[0]); this.check();
        }
        const torrent = this.options.add(payload, path.dirname(target), file.infoHash);
        this.owned.set(file.infoHash, { torrent, sourcePath: target });
        try {
          await this.done(torrent);
          this.check(); roomTorrentMetadata(file, torrent.torrentFile);
          // A zero-piece torrent has no payload writes; materialize its checked empty file.
          if (!file.enc && file.size === 0 && !fs.existsSync(target)) await fs.promises.writeFile(target, '', { flag: 'wx' });
          await verifyRoomFile(target, file, metadata); this.check();
          return { sourcePath: target, metadata: Buffer.from(torrent.torrentFile) };
        } catch (error) {
          if (this.owned.get(file.infoHash)?.torrent === torrent) this.owned.delete(file.infoHash);
          await this.options.remove(torrent).catch(() => {}); throw error;
        }
      } finally { releaseDisk?.(); releaseClient?.(); releaseSlot(); }
    })();
    this.pending.set(file.infoHash, operation);
    void operation.finally(() => { if (this.pending.get(file.infoHash) === operation) this.pending.delete(file.infoHash); }).catch(() => {});
    return operation;
  }
  private done(torrent: BlobTorrent): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearInterval(poll); clearTimeout(deadline); torrent.removeListener('done', completed); torrent.removeListener('error', failed); torrent.removeListener('close', closed);
        if (error) reject(error); else resolve();
      };
      const completed = () => finish();
      const failed = (error: Error | string) => finish(error instanceof Error ? error : new Error(error));
      const closed = () => finish(new Error('Sync blob torrent closed'));
      const poll = setInterval(() => { if (!this.current()) closed(); }, 250);
      const deadline = setTimeout(() => finish(new Error('Sync blob download timed out')), 120_000);
      torrent.once('done', completed); torrent.once('error', failed); torrent.once('close', closed);
      if (torrent.done) completed();
      else if (torrent.destroyed || !this.current()) closed();
    });
  }
}
