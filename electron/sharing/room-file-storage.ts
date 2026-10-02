/** Local-only storage and integrity checks; display names never identify bytes. */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import parseTorrent from 'parse-torrent';
import type { RoomFile } from '../../shared/types';

// The app pins synchronous parse-torrent 9. Its installed @types package
// describes the asynchronous API of a later major version.
type TorrentMetadata = { infoHash: string; name: string; length: number; pieceLength: number; pieces: string[]; info: { files?: unknown } };
const parseRoomTorrent = parseTorrent as unknown as (bytes: Buffer) => TorrentMetadata;
const MAX_METADATA = 16 * 1024 * 1024;

export function roomDiskName(file: Pick<RoomFile, 'name' | 'enc'>): string {
  const name = file.enc ? `${file.name}.enc` : file.name;
  if (!name || name.length > 240 || Array.from(name).some(char => char.charCodeAt(0) < 32)
    || /[<>:"/\\|?*]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('Unsupported room file name');
  }
  return name;
}

export function roomFileDir(root: string, fileId: string): string {
  return path.join(root, '.havvn-files', crypto.createHash('sha256').update(fileId).digest('hex'));
}

/** Each write gets a fresh directory, including retries of the same file. */
export function newRoomFilePath(root: string, fileId: string, name: string): string {
  roomDiskName({ name });
  const parent = roomFileDir(root, fileId);
  fs.mkdirSync(parent, { recursive: true });
  return path.join(fs.mkdtempSync(path.join(parent, 'data-')), name);
}

export function isManagedRoomPath(root: string, fileId: string, candidate: string): boolean {
  const rel = path.relative(roomFileDir(root, fileId), path.resolve(candidate));
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Validate the info hash AND the single-file layout before reading/writing data. */
export function roomTorrentMetadata(file: RoomFile, bytes: Uint8Array): Buffer {
  if (!bytes.length || bytes.length > MAX_METADATA) throw new Error('Invalid room torrent metadata size');
  const raw = Buffer.from(bytes);
  const meta = parseRoomTorrent(raw);
  const expectedSize = file.size + (file.enc ? 28 : 0);
  if (meta.infoHash !== file.infoHash.toLowerCase() || meta.name !== roomDiskName(file)
    || meta.info.files || meta.length !== expectedSize || !Number.isSafeInteger(meta.pieceLength)
    || meta.pieceLength <= 0 || meta.pieceLength > 64 * 1024 * 1024
    || meta.pieces.length !== Math.ceil(expectedSize / meta.pieceLength)) {
    throw new Error('Room file metadata does not match the manifest');
  }
  return raw;
}

function stamp(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

export function roomFileStamp(candidate: string): string | undefined {
  try {
    const stat = fs.lstatSync(candidate, { bigint: true });
    return stat.isFile() ? stamp(stat) : undefined;
  } catch { return undefined; }
}

/** Compare a prior plaintext with a newly authenticated one, without buffering. */
export async function matchingRoomPlaintext(candidate: string, authenticated: string): Promise<string | undefined> {
  const before = roomFileStamp(candidate), verified = roomFileStamp(authenticated);
  if (!before || !verified || fs.statSync(candidate).size !== fs.statSync(authenticated).size) return undefined;
  const digest = async (file: string) => {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  };
  const [existing, fresh] = await Promise.all([digest(candidate), digest(authenticated)]);
  return existing === fresh && before === roomFileStamp(candidate) && verified === roomFileStamp(authenticated) ? before : undefined;
}

/** Stream pieces against their original torrent hashes; never trust size alone. */
export async function verifyRoomFile(candidate: string, file: RoomFile, metadata?: Uint8Array): Promise<Buffer> {
  const before = await fs.promises.lstat(candidate, { bigint: true });
  if (!before.isFile() || before.size !== BigInt(file.size + (file.enc ? 28 : 0))) throw new Error('Room file is missing or has changed');
  let raw: Buffer;
  if (metadata) raw = roomTorrentMetadata(file, metadata);
  else {
    // Legacy manifests have no metadata. Reconstruct only if its full info hash
    // agrees; otherwise keep the old bytes intact and fetch the original swarm.
    const { default: createTorrent } = await import('create-torrent');
    raw = await new Promise<Buffer>((resolve, reject) => createTorrent(candidate,
      { name: roomDiskName(file), announce: [] }, (error, result) => error ? reject(error) : resolve(Buffer.from(result!))));
    raw = roomTorrentMetadata(file, raw);
  }
  const meta = parseRoomTorrent(raw);
  let hash = crypto.createHash('sha1'), inPiece = 0, index = 0;
  const checkPiece = () => {
    if (hash.digest('hex') !== meta.pieces[index++]) throw new Error('Room file contents have changed');
    hash = crypto.createHash('sha1'); inPiece = 0;
  };
  for await (const chunk of fs.createReadStream(candidate)) {
    let offset = 0;
    while (offset < chunk.length) {
      const count = Math.min(meta.pieceLength - inPiece, chunk.length - offset);
      hash.update(chunk.subarray(offset, offset + count)); offset += count; inPiece += count;
      if (inPiece === meta.pieceLength) checkPiece();
    }
  }
  if (inPiece) checkPiece();
  if (index !== meta.pieces.length || stamp(before) !== stamp(await fs.promises.lstat(candidate, { bigint: true }))) {
    throw new Error('Room file changed during verification');
  }
  return raw;
}

/** Copy legacy data only after checking its hash, and check the copied bytes too. */
export async function migrateRoomFile(candidate: string, root: string, file: RoomFile, metadata: Uint8Array,
  isCurrent: () => boolean): Promise<string> {
  await verifyRoomFile(candidate, file, metadata);
  if (!isCurrent()) throw new Error('Room file operation canceled');
  const target = newRoomFilePath(root, file.fileId, roomDiskName(file));
  try {
    await fs.promises.copyFile(candidate, target, fs.constants.COPYFILE_EXCL);
    await verifyRoomFile(target, file, metadata);
    if (!isCurrent()) throw new Error('Room file operation canceled');
    return target;
  } catch (error) {
    await fs.promises.rm(target, { force: true });
    throw error;
  }
}
