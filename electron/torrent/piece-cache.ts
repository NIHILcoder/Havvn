/** Retained read caches across every torrent in a process, measured in bytes. */
export const PIECE_CACHE_BYTES = {
  downloads: 32 * 1024 * 1024,
  rooms: 16 * 1024 * 1024,
  shares: 8 * 1024 * 1024,
} as const;

type Callback = (error?: Error | null, data?: Uint8Array) => void;
type Range = { offset?: number; length?: number } | null;
export interface ChunkStore {
  chunkLength: number;
  get(index: number, options: Range | Callback, callback?: Callback): void;
  put(index: number, data: Uint8Array, callback?: Callback): void;
  close(callback?: Callback): void;
  destroy(callback?: Callback): void;
}
type Entry = { owner: object; index: number; data: Buffer };
type Read = { valid: boolean; waiters: Array<{ options: Range; callback: Callback }> };

export class PieceCache {
  private entries = new Map<Entry, true>();
  private owners = new Map<object, Map<number, Entry>>();
  private bytes = 0;
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid piece cache budget');
  }
  get retainedBytes(): number { return this.bytes; }
  get retainedPieces(): number { return this.entries.size; }

  private drop(entry: Entry): void {
    this.entries.delete(entry);
    const pieces = this.owners.get(entry.owner);
    pieces?.delete(entry.index);
    if (!pieces?.size) this.owners.delete(entry.owner);
    this.bytes -= entry.data.byteLength;
  }
  private get(owner: object, index: number): Buffer | undefined {
    const entry = this.owners.get(owner)?.get(index);
    if (!entry) return;
    this.entries.delete(entry); this.entries.set(entry, true);
    return entry.data;
  }
  private invalidate(owner: object, index?: number): void {
    const pieces = this.owners.get(owner);
    if (index !== undefined) { const entry = pieces?.get(index); if (entry) this.drop(entry); }
    else if (pieces) for (const entry of [...pieces.values()]) this.drop(entry);
  }
  private save(owner: object, index: number, data: Uint8Array): void {
    this.invalidate(owner, index);
    if (!data.byteLength || data.byteLength > this.limit) return;
    while (this.bytes + data.byteLength > this.limit || this.entries.size >= 4096) {
      this.drop(this.entries.keys().next().value!);
    }
    // Copy into an exact allocation: a small slice must not retain a large slab.
    const copy = Buffer.allocUnsafeSlow(data.byteLength); copy.set(data);
    const entry = { owner, index, data: copy };
    let pieces = this.owners.get(owner);
    if (!pieces) { pieces = new Map(); this.owners.set(owner, pieces); }
    pieces.set(index, entry); this.entries.set(entry, true); this.bytes += copy.byteLength;
  }

  wrap(store: ChunkStore): ChunkStore {
    const owner = {}, pending = new Map<number, Read>(), reads = new Set<Read>();
    let closed = false;
    const closedError = () => new Error('Piece cache store is closed');
    const reply = (data: Uint8Array, options: Range, callback: Callback) => {
      const offset = options?.offset ?? 0, length = options?.length ?? data.byteLength - offset;
      if (offset < 0 || length < 0 || offset + length > data.byteLength) callback(new Error('Invalid piece range'));
      else callback(null, data.subarray(offset, offset + length));
    };
    const finish = (method: 'close' | 'destroy', callback: Callback = () => {}) => {
      if (closed) { queueMicrotask(() => callback(closedError())); return; }
      closed = true; this.invalidate(owner); pending.clear();
      for (const read of reads) {
        for (const waiter of read.waiters.splice(0)) queueMicrotask(() => waiter.callback(closedError()));
      }
      reads.clear(); store[method](callback);
    };
    return {
      chunkLength: store.chunkLength,
      get: (index, options, callback = () => {}) => {
        if (typeof options === 'function') { callback = options; options = null; }
        if (closed) { queueMicrotask(() => callback(closedError())); return; }
        const data = this.get(owner, index);
        if (data) { queueMicrotask(() => reply(data, options as Range, callback)); return; }
        // Oversized pieces are read by range and never retained in this cache.
        if (store.chunkLength > this.limit || !this.limit) { store.get(index, options, callback); return; }
        const existing = pending.get(index);
        if (existing) { existing.waiters.push({ options, callback }); return; }
        const read: Read = { valid: true, waiters: [{ options, callback }] };
        pending.set(index, read); reads.add(read);
        store.get(index, (error, buf) => {
          reads.delete(read);
          if (pending.get(index) === read) pending.delete(index);
          if (!closed && !error && buf && read.valid) this.save(owner, index, buf);
          for (const waiter of read.waiters.splice(0)) {
            if (error || !buf) waiter.callback(error || new Error('Piece read returned no data'));
            else reply(buf, waiter.options, waiter.callback);
          }
        });
      },
      put: (index, data, callback = () => {}) => {
        if (closed) { queueMicrotask(() => callback(closedError())); return; }
        this.invalidate(owner, index);
        const read = pending.get(index);
        if (read) { read.valid = false; pending.delete(index); }
        store.put(index, data, callback);
      },
      close: callback => finish('close', callback),
      destroy: callback => finish('destroy', callback),
    };
  }

  /** Public WebTorrent store constructor; disable its separate 20-piece cache. */
  store(Base: new (length: number, options: any) => ChunkStore) {
    const wrap = this.wrap.bind(this);
    return class {
      constructor(length: number, options: any) { return wrap(new Base(length, options)); }
    };
  }
}

export const downloadPieceCache = new PieceCache(PIECE_CACHE_BYTES.downloads);
export const roomPieceCache = new PieceCache(PIECE_CACHE_BYTES.rooms);
export const sharePieceCache = new PieceCache(PIECE_CACHE_BYTES.shares);
