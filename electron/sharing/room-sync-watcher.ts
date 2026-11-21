import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SYNC_FILE_BYTES, SYNC_ROOT_FILE_LIMIT, validSyncRelativePath } from '../../shared/room-file-sync';
import { assertSyncPlainPath, syncFileDigest } from './room-sync-snapshot';
import { syncWorkQueue } from './room-sync-work';
import { syncPathExclusion, validSyncExclusions, type SyncFilterRow } from '../../shared/room-file-sync-filters';

export function excludedSyncPath(relative: string, rules: readonly string[] = []): boolean { return !!syncPathExclusion(relative, rules); }
export interface ScannedSyncFile { path: string; size: number; stamp: string }
export interface SyncScan { files: ScannedSyncFile[]; skipped: number; fingerprint: string; entries?: SyncFilterRow[]; rootIdentity: string; directories: string[]; occupied: string[]; complete: boolean }
/** Bounded, non-following traversal shared by the native picker preview and watcher. */
export async function scanSyncFolder(folder: string, current: () => boolean = () => true, rules: string[] = [], details = false): Promise<SyncScan> {
  if (!validSyncExclusions(rules)) throw new Error('Invalid sync exclusions');
  const check = () => { if (!current()) throw new Error('Sync folder scan canceled'); };
  check(); assertSyncPlainPath(folder);
  const initial = await fs.promises.lstat(folder, { bigint: true });
  if (!initial.isDirectory()) throw new Error('Sync folder is unavailable');
  const identity = (s: typeof initial) => [s.dev, s.ino, s.birthtimeNs].join(':');
  const rootIdentity = identity(initial), foundDirectories = [''], occupied: string[] = []; let complete = true;
  const files: ScannedSyncFile[] = [], entries: SyncFilterRow[] = [], directories = ['']; let visited = 0, skipped = 0;
  const skip = (name: string, directory: boolean, reason: SyncFilterRow['reason'], size: number | null = null, rule?: string) => {
    skipped++; if (details) entries.push({ path: name, size, directory, source: 'local', reason, ...(rule ? { rule } : {}) });
  };
  while (directories.length) {
    check(); const relative = directories.pop()!, absolute = path.join(folder, ...relative.split('/'));
    assertSyncPlainPath(absolute);
    const directoryEntries = await fs.promises.opendir(absolute);
    for await (const entry of directoryEntries) {
      check(); if (++visited > 10000) throw new Error('Sync folder scan limit reached (10000 entries)');
      const name = relative ? relative + '/' + entry.name : entry.name;
      occupied.push(name);
      const exclusion = syncPathExclusion(name, rules);
      if (exclusion) { skip(name, entry.isDirectory(), exclusion.reason, null, exclusion.rule); continue; }
      if (!validSyncRelativePath(name) || entry.isSymbolicLink()) { skip(name, entry.isDirectory(), entry.isSymbolicLink() ? 'linked' : 'invalid'); continue; }
      const candidate = path.join(folder, ...name.split('/'));
      try {
        assertSyncPlainPath(candidate); const stat = await fs.promises.lstat(candidate, { bigint: true });
        if (stat.isDirectory()) {
          if (name.split('/').length >= 16) throw new Error('Sync directory depth limit reached');
          directories.push(name);
          foundDirectories.push(name);
        } else if (stat.isFile() && stat.nlink === 1n && stat.size <= BigInt(SYNC_FILE_BYTES)) {
          if (files.length >= SYNC_ROOT_FILE_LIMIT) throw new Error('Sync folder file limit reached (2000 files)');
          files.push({ path: name, size: Number(stat.size), stamp: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') });
          if (details) entries.push({ path: name, size: Number(stat.size), directory: false, source: 'local', reason: 'included' });
        } else skip(name, false, stat.nlink !== 1n ? 'linked' : stat.size > BigInt(SYNC_FILE_BYTES) ? 'size' : 'type', stat.isFile() ? Number(stat.size) : null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { complete = false; continue; }
        // Links are excluded; permission and capacity errors stop the scan visibly.
        if (String(error).includes('Linked sync path')) { skip(name, entry.isDirectory(), 'linked'); continue; }
        throw error;
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const normalized = files.map(f => f.path.normalize('NFC').toLowerCase());
  if (new Set(normalized).size !== files.length) throw new Error('Sync folder has conflicting file names');
  entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(details ? [files, entries] : files)).digest('hex');
  assertSyncPlainPath(folder);
  if (identity(await fs.promises.lstat(folder, { bigint: true })) !== rootIdentity) throw new Error('Sync folder changed during scan');
  return { files, skipped, fingerprint, rootIdentity, directories: foundDirectories, occupied, complete, ...(details ? { entries } : {}) };
}

interface WatchOptions {
  workOwner?: object;
  folder: string;
  current(): boolean;
  pending(): string[];
  enqueue(paths: string[]): void;
  complete(relativePath: string): void;
  digest(relativePath: string): string | undefined;
  publish(relativePath: string, current: () => boolean): Promise<void>;
  issue(error: unknown | null): void;
  scanned?(scan: SyncScan | null): void;
  settleMs?: number;
  intervalMs?: number;
  rules?: string[];
}

/** Events are hints; repeated bounded scans and verified snapshots decide what to publish. */
export class RoomSyncWatcher {
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private interval: ReturnType<typeof setInterval>;
  private watch?: fs.FSWatcher;
  private running?: Promise<void>;
  private again = false;
  private observed = new Map<string, { stamp: string; at: number }>();
  private checked = new Map<string, string>();
  private readonly settle: number;
  constructor(private readonly options: WatchOptions) {
    this.settle = options.settleMs ?? 1000;
    try {
      this.watch = fs.watch(options.folder, { recursive: true }, (_event, file) => {
        const name = file?.toString().replace(/\\/g, '/');
        if (name && excludedSyncPath(name, options.rules)) return;
        if (name) this.checked.delete(name); else this.checked.clear();
        this.request();
      });
      this.watch.on('error', () => { this.watch?.close(); this.watch = undefined; this.request(); });
    } catch { /* The periodic scan remains active when native watch is unsupported. */ }
    this.interval = setInterval(() => this.request(), options.intervalMs ?? 10_000); this.interval.unref?.();
    this.request(0);
  }
  current = (): boolean => {
    if (this.stopped) return false;
    try { return this.options.current(); } catch (error) { this.options.issue(error); return false; }
  };
  close(): void {
    this.stopped = true; this.watch?.close(); clearInterval(this.interval); if (this.timer) clearTimeout(this.timer);
    syncWorkQueue.cancel(this.options.workOwner ?? this, 'background');
  }
  async idle(): Promise<void> { await this.running; }
  rescan(deep = false): void { if (deep) this.checked.clear(); this.request(0); }
  private request(delay = this.settle): void {
    if (!this.current()) return;
    if (this.running) { this.again = true; return; }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.scan().catch(error => { if (this.current()) { this.options.scanned?.(null); this.options.issue(error); } }).finally(() => {
        this.running = undefined;
        if (this.again) { this.again = false; this.request(); }
      });
    }, delay); this.timer.unref?.();
  }
  private async scan(): Promise<void> {
    const scan = await scanSyncFolder(this.options.folder, this.current, this.options.rules), { files } = scan;
    if (!this.current()) return;
    this.options.scanned?.(scan);
    const present = new Set(files.map(f => f.path)), now = Date.now();
    for (const name of this.observed.keys()) if (!present.has(name)) { this.observed.delete(name); this.checked.delete(name); }
    // Missing files are reviewed separately; the watcher never publishes tombstones.
    for (const name of this.options.pending()) if (!present.has(name)) this.options.complete(name);
    const ready: ScannedSyncFile[] = [], pending = new Set(this.options.pending());
    for (const file of files) {
      const previous = this.observed.get(file.path);
      if (!previous || previous.stamp !== file.stamp) { this.observed.set(file.path, { stamp: file.stamp, at: now }); this.again = true; continue; }
      if (now - previous.at < this.settle) { this.again = true; continue; }
      if (this.checked.get(file.path) !== file.stamp || pending.has(file.path)) ready.push(file);
    }
    this.options.enqueue(ready.map(file => file.path));
    let issue: unknown = null;
    for (const file of ready) {
      if (!this.current()) return;
      try {
        if (!this.current()) return;
        const absolute = path.join(this.options.folder, ...file.path.split('/'));
        assertSyncPlainPath(absolute);
        const digest = await syncWorkQueue.run({ owner: this.options.workOwner ?? this, priority: 'background', current: this.current },
          signal => syncFileDigest(absolute, signal));
        if (!this.current()) return;
        if (this.options.digest(file.path) !== digest) await this.options.publish(file.path, this.current);
        if (!this.current()) return;
        this.options.complete(file.path); this.checked.set(file.path, file.stamp);
      } catch (error) { issue = error; }
    }
    if (this.current()) this.options.issue(issue);
  }
}
