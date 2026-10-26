import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Download, TorrentFile } from '../../shared/types';
import { DOWNLOAD_UNDO_MAX_FILES, DOWNLOAD_UNDO_METADATA_BYTES, DownloadUndoFailure,
  downloadRemovalSignature, type DownloadRemovalSnapshot } from '../../shared/download-removal';
import { readSeedMetadata, resolveSeedFilePaths } from './seed-metadata';

async function parsedMetadata(bytes: Buffer) {
  if (!bytes.length || bytes.length > DOWNLOAD_UNDO_METADATA_BYTES) throw new DownloadUndoFailure('too-large');
  try {
    const { default: parse } = await import('parse-torrent');
    const result = await parse(bytes);
    if (!result.infoHash || !result.files?.length) throw new Error('No metadata');
    if (result.files.length > DOWNLOAD_UNDO_MAX_FILES) throw new DownloadUndoFailure('too-large');
    return result;
  } catch (error) {
    if (error instanceof DownloadUndoFailure) throw error;
    throw new DownloadUndoFailure('metadata-unavailable');
  }
}
export async function readRemovalMetadata(filePath: string): Promise<Buffer> {
  const file = await fs.open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > DOWNLOAD_UNDO_METADATA_BYTES) throw new DownloadUndoFailure('too-large');
    const buffer = Buffer.alloc(DOWNLOAD_UNDO_METADATA_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > DOWNLOAD_UNDO_METADATA_BYTES) throw new DownloadUndoFailure('too-large');
    return buffer.subarray(0, used);
  } finally { await file.close(); }
}
function contained(root: string, relative: string): string {
  const file = path.resolve(root, relative);
  const from = path.relative(path.resolve(root), file);
  if (!from || from === '..' || from.startsWith(`..${path.sep}`) || path.isAbsolute(from)) throw new DownloadUndoFailure('metadata-unavailable');
  return file;
}
async function filePaths(download: Download, files: DownloadRemovalSnapshot['files']): Promise<string[]> {
  if (!download.seedPaths?.length) return files.map(file => contained(download.savePath, file.path));
  return resolveSeedFilePaths(download.seedPaths, files, false);
}
export async function removalSeedStorePaths(download: Download): Promise<string[] | undefined> {
  if (!download.seedPaths?.length) return undefined;
  if (!download.torrentFilePath) throw new Error('Original torrent metadata is missing; recreate this seed');
  const metadata = await readSeedMetadata(download.torrentFilePath, download.infoHash);
  return resolveSeedFilePaths(download.seedPaths, metadata.files);
}
export async function readNativeRemovalMetadata(download: Download, stateDir: string): Promise<Buffer | null> {
  if (download.torrentFilePath) {
    try { return await readRemovalMetadata(download.torrentFilePath); } catch { /* Try daemon-owned metainfo. */ }
  }
  const hash = download.infoHash?.toLowerCase();
  if (!hash || !/^[a-f0-9]{40}$/.test(hash)) return null;
  const directory = path.join(stateDir, 'torrents');
  try { return await readRemovalMetadata(path.join(directory, `${hash}.torrent`)); } catch { /* Older daemon filenames have a name prefix. */ }
  try {
    const entries = await fs.opendir(directory);
    let seen = 0;
    for await (const entry of entries) {
      if (++seen > DOWNLOAD_UNDO_MAX_FILES) break;
      if (entry.isFile() && entry.name.toLowerCase().endsWith(`${hash}.torrent`)) return await readRemovalMetadata(path.join(directory, entry.name));
    }
  } catch { /* Unresolved magnet or unavailable daemon metadata. */ }
  return null;
}
export async function captureRemovalSnapshot(download: Download, metadata: Buffer | null, liveFiles: TorrentFile[]): Promise<DownloadRemovalSnapshot> {
  const copy = structuredClone(download);
  const signature = downloadRemovalSignature(copy);
  let files: DownloadRemovalSnapshot['files'] = [];
  if (metadata) {
    const parsed = await parsedMetadata(metadata);
    if (copy.infoHash && copy.infoHash.toLowerCase() !== parsed.infoHash.toLowerCase()) throw new DownloadUndoFailure('metadata-unavailable');
    copy.infoHash = parsed.infoHash.toLowerCase();
    files = parsed.files!.map((file, index) => {
      const live = liveFiles[index];
      const priority = live?.priority ?? copy.filePriorities?.[index]
        ?? (copy.selectedFiles?.length && !copy.selectedFiles.includes(index) ? 'skip' : 'normal');
      const downloaded = live && Number.isFinite(live.downloaded) ? Math.min(file.length, Math.max(0, live.downloaded))
        : (copy.status === 'completed' || copy.status === 'seeding') && priority !== 'skip' ? file.length : 0;
      return { path: live?.path ?? file.path, length: file.length, downloaded, priority };
    });
    copy.filePriorities = files.map(file => file.priority ?? 'normal');
  } else if (copy.sourceType !== 'magnet' || copy.totalSize > 0 || copy.seedPaths?.length) {
    throw new DownloadUndoFailure('metadata-unavailable');
  }
  const existingFiles: DownloadRemovalSnapshot['existingFiles'] = [];
  const paths = await filePaths(copy, files);
  // Bounded metadata/file count; avoid an unbounded recursive directory scan.
  for (const file of paths) {
    const stat = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new DownloadUndoFailure('files-missing');
    });
    if (stat) {
      if (!stat.isFile()) throw new DownloadUndoFailure('files-missing');
      existingFiles.push({ path: file, size: stat.size });
    }
  }
  return { download: copy, signature, metadata: metadata?.toString('base64') ?? null, files, existingFiles };
}
export async function validateRemovalData(snapshot: DownloadRemovalSnapshot): Promise<void> {
  const directory = await fs.stat(snapshot.download.savePath).catch(() => null);
  if (!directory?.isDirectory()) throw new DownloadUndoFailure('directory-missing');
  for (const file of snapshot.existingFiles) {
    const stat = await fs.stat(file.path).catch(() => null);
    if (!stat?.isFile() || stat.size < file.size) throw new DownloadUndoFailure('files-missing');
  }
}
/** Writes a new, app-owned metadata file before the atomic record insert. Never overwrites a source. */
export async function persistRemovalSnapshot(snapshot: DownloadRemovalSnapshot, userDataDir: string,
  insert: (download: Download) => Promise<Download>): Promise<Download> {
  await validateRemovalData(snapshot);
  const download = structuredClone(snapshot.download);
  const previousError = download.lastError;
  download.status = 'paused'; download.lastError = previousError;
  let stored: string | null = null;
  try {
    if (snapshot.metadata) {
      if (snapshot.metadata.length > Math.ceil(DOWNLOAD_UNDO_METADATA_BYTES / 3) * 4) throw new DownloadUndoFailure('too-large');
      const bytes = Buffer.from(snapshot.metadata, 'base64');
      if (bytes.toString('base64') !== snapshot.metadata) throw new DownloadUndoFailure('metadata-unavailable');
      const parsed = await parsedMetadata(bytes);
      if (parsed.infoHash.toLowerCase() !== download.infoHash?.toLowerCase()) throw new DownloadUndoFailure('metadata-unavailable');
      const directory = path.join(userDataDir, 'torrents');
      await fs.mkdir(directory, { recursive: true });
      stored = path.join(directory, `undo-${randomUUID()}.torrent`);
      const file = await fs.open(stored, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      download.torrentFilePath = stored;
    } else if (download.sourceType !== 'magnet' || download.totalSize > 0) throw new DownloadUndoFailure('metadata-unavailable');
    return await insert(download);
  } catch (error) {
    if (stored) await fs.unlink(stored).catch(() => {});
    throw error;
  }
}
export function removalDataChanged(snapshot: DownloadRemovalSnapshot, files: TorrentFile[]): boolean {
  return snapshot.files.some((before, index) => before.priority !== 'skip' && before.downloaded > 0
    && (!files[index] || files[index].downloaded + 1 < before.downloaded));
}
