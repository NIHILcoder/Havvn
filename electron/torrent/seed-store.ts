import fs from 'node:fs';
import type { ChunkStore } from './piece-cache';

type Callback = (error?: Error | null, data?: Uint8Array) => void;
type Range = { offset?: number; length?: number } | null;
/** Existing seed files are read-only. Failed verification must never overwrite them. */
export class SeedStore implements ChunkStore {
  readonly files: Array<{ path: string; length: number; offset: number; stat: fs.Stats }>;
  readonly length: number;
  private closed = false;
  constructor(readonly chunkLength: number, options: { files: Array<{ path: string; length: number }> }) {
    let offset = 0;
    this.files = options.files.map(file => {
      const entry = { ...file, offset, stat: fs.statSync(file.path) };
      if (!entry.stat.isFile() || entry.stat.size !== file.length) throw new Error('Seed file changed');
      offset += file.length;
      return entry;
    });
    this.length = offset;
  }
  get(index: number, options: Range | Callback, callback: Callback = () => {}): void {
    if (typeof options === 'function') { callback = options; options = null; }
    const range = options;
    void this.read(index, range).then(bytes => callback(null, bytes), error => callback(error));
  }
  private async read(index: number, range: Range): Promise<Buffer> {
    if (this.closed) throw new Error('Seed store is closed');
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid seed piece');
    const start = index * this.chunkLength, available = Math.min(this.chunkLength, this.length - start);
    const offset = range?.offset ?? 0, length = range?.length ?? available - offset;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > available) throw new Error('Invalid seed range');
    const result = Buffer.alloc(length);
    const begin = start + offset, end = begin + length;
    let used = 0;
    let low = 0, high = this.files.length;
    while (low < high) {
      const middle = (low + high) >>> 1, file = this.files[middle];
      if (file.offset + file.length <= begin) low = middle + 1; else high = middle;
    }
    for (let index = low; index < this.files.length && this.files[index].offset < end; index++) {
      const file = this.files[index];
      const from = Math.max(begin, file.offset), to = Math.min(end, file.offset + file.length);
      if (from >= to) continue;
      const handle = await fs.promises.open(file.path, 'r');
      const unchanged = (stat: fs.Stats) => stat.size === file.length && stat.dev === file.stat.dev && stat.ino === file.stat.ino
        && stat.mtimeMs === file.stat.mtimeMs && stat.ctimeMs === file.stat.ctimeMs;
      try {
        if (!unchanged(await handle.stat())) throw new Error('Seed file changed; recheck is required');
        let read = 0;
        while (read < to - from) {
          const { bytesRead } = await handle.read(result, used + read, to - from - read, from - file.offset + read);
          if (!bytesRead) throw new Error('Seed file ended before its declared length');
          read += bytesRead;
        }
        if (!unchanged(await handle.stat())) throw new Error('Seed file changed during reading');
        used += read;
      } finally { await handle.close(); }
    }
    if (used !== length || this.closed) throw new Error('Incomplete or cancelled seed read');
    return result;
  }
  put(_index: number, _data: Uint8Array, callback: Callback = () => {}): void {
    queueMicrotask(() => callback(new Error('Seed sources are read-only')));
  }
  close(callback: Callback = () => {}): void { this.closed = true; queueMicrotask(() => callback(null)); }
  destroy(callback?: Callback): void { this.close(callback); }
}
