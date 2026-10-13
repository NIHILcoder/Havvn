import fs from 'fs';

type Entry<T> = NonNullable<T> extends Record<string, infer V> ? V : never;
type Backend<T extends object> = {
  path?: string; store?: T;
  get(key: string): unknown;
  set(key: string | Partial<T>, value?: unknown): void;
  clear(): void;
  has(key: string): boolean;
};

/** Cache protected on-disk JSON, never expose mutable references to callers.
 * Oversized archives are read through; a failed atomic write invalidates the cache.
 * File stamps also detect replacements made by backup/import tools outside this instance.
 */
export class CachedJsonStore<T extends object> {
  private snapshot?: T;
  private stamp = '';
  private scopeDepth = 0;
  private scoped?: T;
  private readonly supported: boolean;

  constructor(private readonly backend: Backend<T>, private readonly maxBytes = 8 * 1024 * 1024) {
    this.supported = typeof backend.path === 'string';
  }

  private fileStamp(): { stamp: string; size: number } {
    try {
      const stat = fs.statSync(this.backend.path!);
      return { stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, size: stat.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { stamp: 'missing', size: 0 };
    }
  }

  private read(): T {
    if (this.scoped) return this.scoped;
    const file = this.fileStamp();
    if (this.snapshot && file.stamp === this.stamp) {
      if (this.scopeDepth) this.scoped = this.snapshot;
      return this.snapshot;
    }
    this.invalidate();
    const value = this.backend.store!;
    if (this.scopeDepth) this.scoped = value;
    if (file.size <= this.maxBytes) { this.snapshot = value; this.stamp = file.stamp; }
    return value;
  }

  get<K extends keyof T & string>(key: K): T[K] {
    return structuredClone(this.supported ? this.read()[key] : this.backend.get(key)) as T[K];
  }

  getEntry<K extends keyof T & string>(key: K, id: string): Entry<T[K]> | undefined {
    const values = (this.supported ? this.read()[key] : this.backend.get(key)) as Record<string, Entry<T[K]>> | undefined;
    return structuredClone(values && Object.prototype.hasOwnProperty.call(values, id) ? values[id] : undefined);
  }

  has(key: keyof T & string): boolean {
    return this.supported ? Object.prototype.hasOwnProperty.call(this.read(), key) : this.backend.has(key);
  }

  hasEntry(key: keyof T & string, id: string): boolean {
    const values = (this.supported ? this.read()[key] : this.backend.get(key)) as object | undefined;
    return !!values && Object.prototype.hasOwnProperty.call(values, id);
  }

  set<K extends keyof T & string>(key: K, value: T[K]): void;
  set(patch: Partial<T>): void;
  set<K extends keyof T & string>(key: K | Partial<T>, value?: T[K]): void {
    if (!this.supported) { this.backend.set(key, value); return; }
    if (typeof key === 'string' && value === undefined) throw new TypeError('Use delete() to clear values');
    const patch = typeof key === 'string' ? { [key]: value } : key;
    // Match JSON semantics (notably absent parentId vs an own undefined field).
    // Normalize only the changed partitions, never re-parse the whole archive.
    const encoded = JSON.parse(JSON.stringify(patch)) as Partial<T>;
    const next = { ...this.read(), ...encoded } as T;
    for (const field of Object.keys(patch)) {
      if (!Object.prototype.hasOwnProperty.call(encoded, field)) delete (next as Record<string, unknown>)[field];
    }
    try {
      // Use electron-store's public atomic, validated setter without re-reading JSON.
      this.backend.store = next;
      const file = this.fileStamp();
      this.invalidate();
      if (file.size <= this.maxBytes) { this.snapshot = next; this.stamp = file.stamp; }
      if (this.scopeDepth) this.scoped = next;
    } catch (error) { this.invalidate(); throw error; }
  }

  clear(): void { try { this.backend.clear(); } finally { this.invalidate(); } }
  invalidate(): void { this.snapshot = undefined; this.scoped = undefined; this.stamp = ''; }

  /** Share one parse even for oversized archives, only during a synchronous operation. */
  withSnapshot<R>(operation: () => R): R {
    this.scopeDepth++;
    try { return operation(); }
    finally { if (--this.scopeDepth === 0) this.scoped = undefined; }
  }
}
