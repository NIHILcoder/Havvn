import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { torrentSourceKey } from '../../shared/torrent-creation';
import { TorrentError } from './errors';

export interface SeedFile { path: string; length: number }
export function sameSeedSources(left: readonly string[] | undefined, right: readonly string[]): boolean {
  if (!left?.length || left.length !== right.length) return false;
  const keys = new Set(left.map(torrentSourceKey));
  return keys.size === left.length && new Set(right.map(torrentSourceKey)).size === right.length
    && right.every(value => keys.has(torrentSourceKey(value)));
}
export interface SeedMetadata {
  bytes: Buffer;
  infoHash: string;
  name: string;
  length: number;
  pieceLength: number;
  files: SeedFile[];
  singleFile: boolean;
}
export const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_SEED_FILES = 100_000;

export function seedPathParts(value: string): string[] {
  const parts = value.replace(/\\/g, '/').split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[\0:]/.test(part))) {
    throw new TorrentError('Unsafe path in seed metadata', 'INVALID_INPUT');
  }
  return parts;
}
export async function parseSeedMetadata(bytes: Buffer, expectedInfoHash?: string): Promise<SeedMetadata> {
  if (!bytes.length || bytes.length > MAX_METADATA_BYTES) throw new TorrentError('Seed metadata is too large', 'INVALID_INPUT');
  const { default: parse } = await import('parse-torrent');
  const parsed = await parse(bytes);
  if (!parsed.infoHash || !parsed.name || !parsed.files?.length || parsed.files.length > MAX_SEED_FILES) {
    throw new TorrentError('Seed metadata has no valid file manifest', 'INVALID_INPUT');
  }
  const infoHash = parsed.infoHash.toLowerCase();
  if (!Number.isSafeInteger(parsed.length) || parsed.length! < 0 || !Number.isSafeInteger(parsed.pieceLength) || parsed.pieceLength! <= 0) throw new TorrentError('Invalid seed size or piece length', 'INVALID_INPUT');
  if (expectedInfoHash && infoHash !== expectedInfoHash.toLowerCase()) throw new TorrentError('The saved torrent metadata changed', 'INVALID_INPUT');
  if (seedPathParts(parsed.name).length !== 1) throw new TorrentError('Invalid torrent root name', 'INVALID_INPUT');
  // parse-torrent normalizes paths. Validate raw components first, so a dot
  // segment or embedded separator cannot disappear during normalization.
  const info = parsed.info as { files?: Array<Record<string, unknown>> };
  if (Array.isArray(info.files)) for (const file of info.files) {
    const parts = file['path.utf-8'] ?? file.path;
    if (!Array.isArray(parts) || !parts.length || parts.some(part => seedPathParts(String(part)).length !== 1)) {
      throw new TorrentError('Invalid raw path in seed metadata', 'INVALID_INPUT');
    }
  }
  if (parsed.pieces?.length !== Math.ceil(parsed.length! / parsed.pieceLength!)) throw new TorrentError('Invalid seed piece manifest', 'INVALID_INPUT');
  const files = parsed.files.map(file => {
    seedPathParts(file.path);
    if (!Number.isSafeInteger(file.length) || file.length < 0) throw new TorrentError('Invalid seed file length', 'INVALID_INPUT');
    return { path: file.path, length: file.length };
  });
  return { bytes, infoHash, name: parsed.name, length: parsed.length!, pieceLength: parsed.pieceLength!, files,
    singleFile: !Array.isArray(info.files) };
}
export async function readSeedMetadata(file: string, expectedInfoHash?: string): Promise<SeedMetadata> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) throw new TorrentError('Invalid seed metadata file', 'INVALID_INPUT');
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== stat.size) throw new TorrentError('Seed metadata changed while reading', 'INVALID_INPUT');
    return await parseSeedMetadata(bytes.subarray(0, used), expectedInfoHash);
  } finally { await handle.close(); }
}
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Map ONLY files in the saved manifest. Never walk the source tree again. */
export async function resolveSeedFilePaths(sources: string[], files: SeedFile[], checkLengths = true): Promise<string[]> {
  if (!sources.length) throw new TorrentError('Seed sources are missing', 'FILE_NOT_FOUND');
  const roots = await Promise.all(sources.map(async source => {
    const absolute = path.resolve(source), stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new TorrentError('Unsupported seed source', 'INVALID_INPUT');
    return { absolute, real: await fs.realpath(absolute), stat, name: path.basename(absolute) };
  }));
  const nameKey = (name: string) => process.platform === 'win32' ? name.toLowerCase() : name;
  const names = new Map(roots.map(root => [nameKey(root.name), root]));
  if (names.size !== roots.length) throw new TorrentError('Ambiguous source names in seed manifest', 'INVALID_INPUT');
  const seen = new Set<string>();
  const result: string[] = [];
  for (const file of files) {
    const parts = seedPathParts(file.path);
    const relative = parts.slice(1);
    const root = roots.length === 1 ? roots[0] : names.get(nameKey(relative[0] ?? ''));
    if (!root) throw new TorrentError('Cannot map a torrent file to its selected source', 'INVALID_INPUT');
    let absolute: string;
    if (root.stat.isFile()) {
      if ((roots.length === 1 && files.length !== 1) || (roots.length > 1 && relative.length !== 1)) throw new TorrentError('Invalid single-file seed mapping', 'INVALID_INPUT');
      absolute = root.absolute;
    } else {
      const child = roots.length === 1 ? relative : relative.slice(1);
      if (!child.length) throw new TorrentError('Missing path inside the seed directory', 'INVALID_INPUT');
      absolute = path.resolve(root.absolute, ...child);
      if (!within(root.absolute, absolute)) throw new TorrentError('Seed file escapes its selected directory', 'INVALID_INPUT');
    }
    const real = await fs.realpath(absolute);
    if (root.stat.isDirectory() && !within(root.real, real)) throw new TorrentError('Seed link escapes its selected directory', 'INVALID_INPUT');
    const stat = await fs.stat(real);
    if (!stat.isFile() || (checkLengths && stat.size !== file.length)) throw new TorrentError('Seed content changed or is missing', 'FILE_NOT_FOUND');
    const key = torrentSourceKey(real);
    if (seen.has(key)) throw new TorrentError('Several torrent entries resolve to the same source file', 'INVALID_INPUT');
    seen.add(key); result.push(real);
  }
  return result;
}
export async function prepareSeed(file: string | undefined, sources: string[], expectedInfoHash?: string) {
  if (!file) throw new TorrentError('Original torrent metadata is missing. Recreate the torrent before seeding.', 'FILE_NOT_FOUND');
  const metadata = await readSeedMetadata(file, expectedInfoHash);
  return { metadata, paths: await resolveSeedFilePaths(sources, metadata.files) };
}
export async function persistSeedMetadata(metadata: SeedMetadata, userDataDir: string): Promise<string> {
  const directory = path.join(userDataDir, 'torrents');
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `seed-${metadata.infoHash}-${randomUUID()}.torrent`);
  const handle = await fs.open(target, 'wx', 0o600);
  try { await handle.writeFile(metadata.bytes); await handle.sync(); }
  catch (error) { await handle.close(); await fs.unlink(target).catch(() => {}); throw error; }
  await handle.close();
  return target;
}

/** Transmission needs one physical content root. No copies or file moves. */
export function nativeSeedRoot(metadata: SeedMetadata, paths: string[]): string {
  if (metadata.singleFile) {
    if (paths.length !== 1) throw new TorrentError('Invalid single-file seed layout', 'INVALID_INPUT');
    return paths[0];
  }
  const firstRelative = seedPathParts(metadata.files[0].path).slice(1);
  let root = paths[0];
  for (const _part of firstRelative) root = path.dirname(root);
  if (!firstRelative.length || paths.some((file, index) => torrentSourceKey(path.resolve(root, ...seedPathParts(metadata.files[index].path).slice(1))) !== torrentSourceKey(file))) {
    throw new TorrentError('These sources do not share the torrent folder layout. The torrent file is saved; use the classic engine to seed scattered sources without copying them.', 'INVALID_INPUT');
  }
  if (!path.basename(root)) throw new TorrentError('Cannot remap a torrent root to a filesystem volume root', 'INVALID_INPUT');
  return root;
}
