import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { classifyMediaKind } from '../../shared/media';

export function mediaPath(value: string): string | null {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) return null;
  const rel = value.replace(/\\/g, '/');
  return !rel || path.isAbsolute(rel) || rel.includes(':') || rel.split('/').some(p => !p || p === '.' || p === '..') || classifyMediaKind(rel) === 'other' ? null : rel;
}
export function hasPiece(pieces: string, index: number): boolean {
  const buf = Buffer.from(pieces, 'base64');
  return !!(buf[index >> 3] & (0x80 >> (index & 7)));
}
interface Metadata { infoHash: string; pieceLength: number; length: number; pieces: string[]; files: Array<{ path: string; length: number; offset: number }> }
const parse = createRequire(__filename)('parse-torrent') as (buffer: Buffer) => Metadata;

/** Daemon bitfields can precede disk-cache flushes. Hash the actual full piece,
 * including neighbour files, before returning any part of it. No torrent writes. */
export class VerifiedDiskMedia {
  private metadata = new Map<string, Metadata>();
  private cache = new Map<string, Buffer>();
  private bytes = 0;
  private reading: Promise<void> = Promise.resolve();
  load(hash: string, sourceFile: string | null | undefined, stateDir: string): Metadata | null {
    if (!/^[a-f0-9]{40}$/i.test(hash)) return null;
    const cached = this.metadata.get(hash); if (cached) return cached;
    const dir = path.join(stateDir, 'torrents');
    const candidates = [sourceFile, path.join(dir, hash + '.torrent')];
    // Older Transmission releases prefix the hash with a display name.
    try { for (const name of fs.readdirSync(dir)) if (name.toLowerCase().endsWith(hash.toLowerCase() + '.torrent')) candidates.push(path.join(dir, name)); } catch { /* no metainfo yet */ }
    for (const file of candidates) {
      if (!file) continue;
      try {
        if (fs.statSync(file).size > 32 * 1024 * 1024) continue;
        const meta = parse(fs.readFileSync(file));
        if (meta.infoHash.toLowerCase() !== hash.toLowerCase() || !Number.isSafeInteger(meta.pieceLength) || meta.pieceLength <= 0 || meta.pieceLength > 32 * 1024 * 1024 || !meta.files?.length || !meta.pieces?.length) continue;
        this.metadata.set(hash, meta);
        if (this.metadata.size > 16) this.metadata.delete(this.metadata.keys().next().value!);
        return meta;
      } catch { /* incomplete or unavailable metainfo */ }
    }
    return null;
  }
  async read(meta: Metadata, savePath: string, fileIndex: number, start: number, max: number): Promise<Buffer | null> {
    // Bound temporary whole-piece buffers, and share cached verification between
    // concurrent Range requests instead of hashing the same piece repeatedly.
    const previous = this.reading; let release!: () => void;
    this.reading = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await this.readPiece(meta, savePath, fileIndex, start, max); }
    finally { release(); }
  }
  private async readPiece(meta: Metadata, savePath: string, fileIndex: number, start: number, max: number): Promise<Buffer | null> {
    const file = meta.files[fileIndex], absolute = file.offset + start;
    const index = Math.floor(absolute / meta.pieceLength), pieceStart = index * meta.pieceLength;
    const key = `${meta.infoHash}:${savePath}:${index}`;
    let piece = this.cache.get(key);
    if (!piece) {
      const length = Math.min(meta.pieceLength, meta.length - pieceStart);
      piece = Buffer.alloc(length); let filled = 0;
      const root = await fs.promises.realpath(savePath).catch(() => null); if (!root) return null;
      for (const f of meta.files) {
        const from = Math.max(pieceStart, f.offset), to = Math.min(pieceStart + length, f.offset + f.length);
        if (to <= from) continue;
        const rel = f.path.replace(/\\/g, '/');
        if (path.isAbsolute(rel) || rel.includes(':') || rel.split('/').some(p => !p || p === '..' || p === '.')) return null;
        let read = false;
        for (const suffix of ['', '.part']) {
          const disk = await fs.promises.realpath(path.join(root, rel) + suffix).catch(() => null);
          if (!disk || !disk.startsWith(root + path.sep)) continue;
          const fd = await fs.promises.open(disk, 'r').catch(() => null); if (!fd) continue;
          try {
            if (!(await fd.stat()).isFile()) continue;
            const result = await fd.read(piece, from - pieceStart, to - from, from - f.offset);
            if (result.bytesRead === to - from) { filled += result.bytesRead; read = true; break; }
          } finally { await fd.close(); }
        }
        if (!read) return null;
      }
      if (filled !== length || crypto.createHash('sha1').update(piece).digest('hex') !== meta.pieces[index]) return null;
      // Keep immutable verified bytes; this also avoids rehashing every HTTP chunk.
      if (piece.length <= 8 * 1024 * 1024) {
        while (this.bytes + piece.length > 8 * 1024 * 1024 && this.cache.size) {
          const first = this.cache.keys().next().value!; this.bytes -= this.cache.get(first)!.length; this.cache.delete(first);
        }
        const previous = this.cache.get(key); if (previous) this.bytes -= previous.length;
        this.cache.set(key, piece); this.bytes += piece.length;
      }
    }
    const offset = absolute - pieceStart;
    return piece.subarray(offset, offset + Math.min(max, file.length - start));
  }
}
