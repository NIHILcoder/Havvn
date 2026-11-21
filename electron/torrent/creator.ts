/** Create metadata from an explicit, stable selection; never start a torrent client. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { CreateTorrentRequest, CreateTorrentResult, CreateTorrentProgress } from '../../shared/types';
import { calculateTorrentPieceLength, parseTorrentUrls, torrentSourceKey, TORRENT_CREATION_CANCELLED } from '../../shared/torrent-creation';
import { parseSeedMetadata, seedPathParts, MAX_METADATA_BYTES } from './seed-metadata';
import { logger } from '../utils';
export { DEFAULT_TRACKERS } from './trackers';
const log = logger.child('TorrentCreator');
let activeCreation: { requestId?: string; controller: AbortController; cancellable: boolean } | undefined;

export function cancelTorrentCreation(requestId: string): boolean {
  if (!activeCreation || !requestId || activeCreation.requestId !== requestId || !activeCreation.cancellable) return false;
  activeCreation.controller.abort(new Error(TORRENT_CREATION_CANCELLED));
  return true;
}
type ProgressCb = (progress: CreateTorrentProgress) => void;
interface SourceFile { absolute: string; relative: string[]; stat: fs.Stats }
const unchanged = (left: fs.Stats, right: fs.Stats) => left.isFile() && right.isFile() && left.dev === right.dev
  && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

async function selection(request: CreateTorrentRequest, signal: AbortSignal): Promise<{ files: SourceFile[]; singleFile: boolean; name: string }> {
  const { sourcePaths, options, outputPath } = request;
  if (!sourcePaths?.length) throw new Error('Select at least one source file or folder');
  const excluded = new Set((request.excludePaths ?? []).map(torrentSourceKey));
  excluded.add(torrentSourceKey(path.resolve(outputPath)));
  const files: SourceFile[] = [], roots = new Set<string>(), seen = new Set<string>(), physicalPaths = new Set<string>();
  const outputStat = await fs.promises.stat(outputPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  let singleFile = false;
  const walk = async (absolute: string, relative: string[]): Promise<void> => {
    signal.throwIfAborted();
    if (excluded.has(torrentSourceKey(absolute))) return;
    const stat = await fs.promises.lstat(absolute);
    signal.throwIfAborted();
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      const entries = await fs.promises.readdir(absolute);
      entries.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const entry of entries) await walk(path.join(absolute, entry), [...relative, entry]);
    } else if (stat.isFile()) {
      if (outputStat && stat.dev === outputStat.dev && stat.ino === outputStat.ino) throw new Error('The output torrent is linked to a source file');
      seedPathParts(relative.join('/'));
      const key = process.platform === 'win32' ? relative.join('/').toLowerCase() : relative.join('/');
      if (seen.has(key)) throw new Error('Two sources have the same torrent path');
      const physical = torrentSourceKey(await fs.promises.realpath(absolute));
      if (physicalPaths.has(physical)) throw new Error('A source file is selected more than once through overlapping folders');
      physicalPaths.add(physical);
      seen.add(key);
      if (files.length >= 100_000) throw new Error('A torrent can include at most 100000 files');
      files.push({ absolute, relative, stat });
    }
  };
  for (const source of sourcePaths) {
    signal.throwIfAborted();
    const absolute = path.resolve(source), stat = await fs.promises.lstat(absolute);
    if (torrentSourceKey(absolute) === torrentSourceKey(path.resolve(outputPath))) throw new Error('The output torrent must not overwrite a source');
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Unsupported source: ' + source);
    const top = path.basename(absolute), key = process.platform === 'win32' ? top.toLowerCase() : top;
    if (roots.has(key)) throw new Error('Sources have the same torrent root name: ' + top);
    roots.add(key);
    singleFile = sourcePaths.length === 1 && stat.isFile();
    await walk(absolute, sourcePaths.length === 1 && stat.isDirectory() ? [] : [top]);
  }
  if (!files.length) throw new Error('No files to include in this torrent');
  const name = options.name?.trim() || (sourcePaths.length === 1 ? path.basename(path.resolve(sourcePaths[0])) : 'Torrent');
  if (seedPathParts(name).length !== 1) throw new Error('Torrent name must not contain directory separators');
  return { files, singleFile, name };
}

async function writeTorrentAtomically(outputPath: string, bytes: Buffer, signal: AbortSignal, commit: () => void): Promise<void> {
  const temporary = path.join(path.dirname(outputPath), '.havvn-torrent-' + randomUUID() + '.tmp');
  let handle: fs.promises.FileHandle | undefined;
  try {
    signal.throwIfAborted();
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    signal.throwIfAborted();
    // Once rename is issued the file may already be saved. From this point
    // cancellation must lose to the real result, including a rename failure.
    commit();
    await fs.promises.rename(temporary, outputPath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.promises.unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') log.warn('Temporary torrent file retained', { temporary, error: String(error) }); });
  }
}

export async function createTorrentFile(request: CreateTorrentRequest, onProgress?: ProgressCb): Promise<CreateTorrentResult> {
  if (activeCreation) throw new Error('Torrent creation is already in progress');
  if (!request || !Array.isArray(request.sourcePaths) || request.sourcePaths.some(source => typeof source !== 'string' || !source.trim())) throw new Error('Invalid source selection');
  const { options, outputPath } = request;
  if (!options || !Array.isArray(options.announceList) || options.announceList.some(tier => !Array.isArray(tier) || tier.some(url => typeof url !== 'string'))) throw new Error('Invalid tracker list');
  if (options.urlList && (!Array.isArray(options.urlList) || options.urlList.some(url => typeof url !== 'string'))) throw new Error('Invalid web seed list');
  if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('Choose an output torrent file');
  if (parseTorrentUrls(options.announceList.flat().join('\n'), 'tracker').invalidLines.length || parseTorrentUrls((options.urlList ?? []).join('\n'), 'webSeed').invalidLines.length) throw new Error('Invalid tracker or web seed URL');
  if (options.pieceLength !== undefined && (!Number.isInteger(options.pieceLength) || options.pieceLength < 16384 || options.pieceLength > 16777216 || (options.pieceLength & (options.pieceLength - 1)) !== 0)) throw new Error('Invalid torrent piece size');
  if (request.requestId !== undefined && (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(request.requestId))) throw new Error('Invalid creation request ID');
  const report = (progress: CreateTorrentProgress) => { try { onProgress?.({ ...progress, requestId: request.requestId }); } catch { /* reporting cannot fail creation */ } };
  const controller = new AbortController(), streams: Readable[] = [];
  const current = { requestId: request.requestId, controller, cancellable: true };
  activeCreation = current;
  const abortStreams = () => { for (const stream of streams) stream.destroy(controller.signal.reason); };
  controller.signal.addEventListener('abort', abortStreams, { once: true });
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    report({ stage: 'hashing', progress: 0, message: 'Scanning files...' });
    controller.signal.throwIfAborted();
    const manifest = await selection(request, controller.signal);
    controller.signal.throwIfAborted();
    const totalSize = manifest.files.reduce((sum, file) => sum + file.stat.size, 0);
    if (!Number.isSafeInteger(totalSize)) throw new Error('The selected content is too large');
    const pieceLength = options.pieceLength ?? calculateTorrentPieceLength(totalSize);
    if (Math.ceil(totalSize / pieceLength) * 20 > MAX_METADATA_BYTES - 1024 * 1024) throw new Error('The chosen piece size creates too much metadata. Use Auto or larger pieces.');
    let lastProgress = Date.now(), lastReport = 0;
    // Open one file at a time. No staging copies, hidden-file filtering or symlink traversal.
    for (const file of manifest.files) {
      controller.signal.throwIfAborted();
      const stream = Readable.from((async function* () {
        controller.signal.throwIfAborted();
        const handle = await fs.promises.open(file.absolute, 'r');
        try {
          if (!unchanged(file.stat, await handle.stat())) throw new Error('A source file changed before hashing');
          for await (const chunk of handle.createReadStream({ autoClose: false, signal: controller.signal })) yield chunk;
          if (!unchanged(file.stat, await handle.stat())) throw new Error('A source file changed during hashing');
        } finally { await handle.close(); }
      })());
      Object.assign(stream, { name: file.relative.join('/') });
      stream.on('error', () => {}); // unread streams can also be aborted
      streams.push(stream);
    }
    const { default: createTorrent } = await import('create-torrent');
    controller.signal.throwIfAborted();
    const raw = await new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, value?: Uint8Array) => {
        if (settled) return; settled = true;
        controller.signal.removeEventListener('abort', abort);
        if (error || !value) reject(error || new Error('No torrent metadata generated')); else resolve(Buffer.from(value));
      };
      const abort = () => finish(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
      timer = setInterval(() => { if (Date.now() - lastProgress > 5 * 60_000) controller.abort(new Error('Torrent hashing stopped making progress')); }, 1000);
      createTorrent(streams, { name: manifest.name, comment: options.comment, createdBy: options.createdBy || 'Havvn',
        announceList: options.announceList.map(tier => [...tier]), urlList: options.urlList, private: options.private ?? false,
        pieceLength, filterJunkFiles: false, info: options.source ? { source: options.source } : undefined,
        onProgress: hashed => {
          if (controller.signal.aborted) return;
          lastProgress = Date.now();
          if (Date.now() - lastReport < 250) return;
          lastReport = Date.now();
          report({ stage: 'hashing', progress: totalSize ? Math.min(.9, hashed / totalSize * .9) : 0, message: 'Hashing files...' });
        } }, finish);
    });
    controller.signal.throwIfAborted();
    // The library treats a one-stream folder as a single-file torrent and can
    // strip a common prefix. Preserve our explicit manifest without rehashing.
    const { default: bencode } = await import('bencode');
    const encoded = bencode.decode(raw) as { info: Record<string, unknown> };
    if (manifest.singleFile) { delete encoded.info.files; encoded.info.length = totalSize; }
    else { delete encoded.info.length; encoded.info.files = manifest.files.map(file => ({ length: file.stat.size, path: file.relative })); }
    const metadata = await parseSeedMetadata(Buffer.from(bencode.encode(encoded)));
    const parser = await import('parse-torrent');
    const magnetUri = parser.toMagnetURI(await parser.default(metadata.bytes));
    for (const file of manifest.files) {
      controller.signal.throwIfAborted();
      if (!unchanged(file.stat, await fs.promises.stat(file.absolute))) throw new Error('A source file changed; create the torrent again');
    }
    report({ stage: 'writing', progress: .95, message: 'Writing torrent file...' });
    await writeTorrentAtomically(outputPath, metadata.bytes, controller.signal, () => { current.cancellable = false; });
    report({ stage: 'complete', progress: 1, message: 'Torrent created successfully!' });
    return { torrentFilePath: outputPath, infoHash: metadata.infoHash,
      magnetUri,
      totalSize, pieceCount: Math.ceil(totalSize / pieceLength), pieceLength };
  } finally {
    clearInterval(timer);
    controller.signal.removeEventListener('abort', abortStreams);
    for (const stream of streams) stream.destroy();
    await Promise.all(streams.map(stream => finished(stream).catch(() => {})));
    if (activeCreation === current) activeCreation = undefined;
  }
}
