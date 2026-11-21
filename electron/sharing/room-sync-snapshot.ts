/** Local primitives for the file-sync spike. Not exposed over room IPC/gossip. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import parseTorrent from 'parse-torrent';
import type { RoomFile } from '../../shared/types';
import { roomDiskName, roomFileStamp, verifyRoomFile } from './room-file-storage';
import { encryptFile } from './room-e2e';
import { contentKeyEpoch } from './room-keyring';
import { validSyncName } from '../../shared/room-file-sync';
import { syncWorkQueue, type SyncWorkOptions } from './room-sync-work';

export const SYNC_SPIKE_MAX_BYTES = 256 * 1024 * 1024;

/** Check ancestors too: a safe leaf under a junction is still outside the binding. */
export function assertSyncPlainPath(candidate: string): void {
  let current = path.resolve(candidate);
  for (;;) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw new Error('Linked sync path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function syncFileDigest(candidate: string, signal?: AbortSignal): Promise<string> {
  const before = roomFileStamp(candidate);
  if (!before) throw new Error('Sync file is not a regular file');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(candidate, { signal })) hash.update(chunk);
  if (roomFileStamp(candidate) !== before) throw new Error('Sync file changed while reading');
  return hash.digest('hex');
}

export async function flushSyncFile(candidate: string): Promise<void> {
  const handle = await fs.promises.open(candidate, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

export interface SyncSnapshot {
  directory: string;
  sourcePath: string;
  plaintextDigest: string; // Local only; never advertise a plaintext digest in an E2E swarm.
  file: RoomFile;
  metadata: Buffer;
}

/** Seed only this private copy, never a file an external editor can change. */
export interface SyncSnapshotOptions {
  source: string;
  storage: string;
  authorId: string;
  name?: string;
  secret?: string;
  isCurrent?: () => boolean;
  work?: SyncWorkOptions;
}
export function prepareSyncSnapshot(options: SyncSnapshotOptions): Promise<SyncSnapshot> {
  return syncWorkQueue.run({ ...options.work, owner: options.work?.owner ?? {}, current: options.isCurrent },
    signal => prepareSnapshot(options, signal), snapshot => fs.promises.rm(snapshot.directory, { recursive: true, force: true }));
}
async function prepareSnapshot(options: SyncSnapshotOptions, signal: AbortSignal): Promise<SyncSnapshot> {
  const current = () => {
    signal.throwIfAborted();
    if (options.isCurrent && !options.isCurrent()) throw new Error('Sync snapshot canceled');
  };
  current();
  assertSyncPlainPath(options.source);
  assertSyncPlainPath(options.storage);
  const source = path.resolve(options.source), storage = path.resolve(options.storage);
  const stat = await fs.promises.lstat(source);
  if (!stat.isFile() || stat.size > SYNC_SPIKE_MAX_BYTES) throw new Error('Unsupported sync source size or type');
  const filename = options.name ?? path.basename(source);
  if (!validSyncName(filename)) throw new Error('Invalid sync snapshot name');
  const name = roomDiskName({ name: filename, enc: !!options.secret });
  await fs.promises.mkdir(storage, { recursive: true });
  assertSyncPlainPath(storage);
  const directory = await fs.promises.mkdtemp(path.join(storage, 'snapshot-'));
  try {
    current();
    const before = roomFileStamp(source);
    const plain = path.join(directory, filename);
    await fs.promises.copyFile(source, plain, fs.constants.COPYFILE_EXCL);
    if (!before || roomFileStamp(source) !== before) throw new Error('Sync source changed during snapshot');
    const copied = await fs.promises.lstat(plain);
    if (copied.size !== stat.size || copied.size > SYNC_SPIKE_MAX_BYTES) throw new Error('Sync source size changed');
    current();
    const plaintextDigest = await syncFileDigest(plain, signal);
    current();
    const sourcePath = options.secret ? path.join(directory, name) : plain;
    if (options.secret) {
      await encryptFile(plain, sourcePath, options.secret, { signal });
      await fs.promises.unlink(plain);
    }
    await flushSyncFile(sourcePath);
    current();
    const { default: createTorrent } = await import('create-torrent');
    const metadata = await new Promise<Buffer>((resolve, reject) => createTorrent(sourcePath,
      { name, announce: [], private: true }, (error, bytes) => error ? reject(error) : resolve(Buffer.from(bytes!))));
    current();
    const { infoHash } = await parseTorrent(metadata);
    const file: RoomFile = {
      fileId: infoHash, infoHash, name: filename, size: stat.size,
      magnetURI: `magnet:?xt=urn:btih:${infoHash}`, addedBy: options.authorId,
      addedByName: '', addedAt: Date.now(),
      ...(options.secret ? { enc: true, keyEpoch: contentKeyEpoch(options.secret) } : {}),
    };
    await verifyRoomFile(sourcePath, file, metadata, signal);
    current();
    return { directory, sourcePath, plaintextDigest, file, metadata };
  } catch (error) {
    // directory is the exclusive mkdtemp result beneath the checked storage root.
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
