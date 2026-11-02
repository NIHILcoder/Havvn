import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldNow } from 'node:timers/promises';
import { STORAGE_KINDS, type StorageAction, type StorageGroup, type StorageIssue, type StorageKind, type StorageProgress, type StorageReport } from '../../shared/storage-overview';

export interface StorageLocation { kind: StorageKind; actions?: StorageAction[]; mixedData?: boolean }
export interface StorageRoot {
  key?: string;
  path: string; kinds: StorageKind[]; locate(relative: string): StorageLocation;
  affects?(relative: string): StorageKind[];
  discover?(file: string, relative: string, size: number, control: StorageControl): Promise<StorageRoot[]>;
}
export interface StorageControl { signal: AbortSignal; check(): void; issue(kind: StorageKind, issue: StorageIssue): void }
export interface StorageCatalog { roots: StorageRoot[]; issues: Array<{ kind: StorageKind; issue: StorageIssue }> }
export interface StorageLimits { entries: number; roots: number; depth: number; durationMs: number }
const DEFAULT_LIMITS: StorageLimits = { entries: 20000, roots: 1024, depth: 16, durationMs: 10000 };
const keyPath = (value: string) => {
  const absolute = path.resolve(value).replace(/^\\\\\?\\/, '');
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};
class CensusLimit extends Error {}

/** Reject reparse points in every ancestor before starting a supplied root. */
export async function safeStoragePath(candidate: string, signal?: AbortSignal, check: () => void = () => signal?.throwIfAborted()): Promise<void> {
  let current = path.resolve(candidate); const ancestors: string[] = [];
  for (;;) {
    ancestors.push(current); const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  for (const ancestor of ancestors.reverse()) {
    check();
    const stat = await fs.promises.lstat(ancestor); check();
    if (stat.isSymbolicLink()) throw Object.assign(Error('Unsafe storage path'), { code: 'STORAGE_LINK' });
  }
}

export async function scanStorage(id: string, catalog: (control: StorageControl) => Promise<StorageCatalog>, signal: AbortSignal,
  progress: (value: StorageProgress) => void = () => {}, overrides: Partial<StorageLimits> = {}): Promise<StorageReport> {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw Error('Invalid storage census limits');
  const started = Date.now(), groups = new Map<StorageKind, StorageGroup>(STORAGE_KINDS.map(kind => [kind, {
    kind, logicalBytes: 0, sharedBytes: 0, files: 0, reclaimableBytes: null, issues: [], actions: [], moreActions: false, mixedData: false,
  }]));
  const issue = (kind: StorageKind, reason: StorageIssue) => { const list = groups.get(kind)!.issues; if (!list.includes(reason)) list.push(reason); };
  let visited = 0, files = 0, revision = 0, lastProgress = -Infinity, uniqueReliable = true;
  const check = () => { signal.throwIfAborted(); if (Date.now() - started >= limits.durationMs) throw new CensusLimit(); };
  const control: StorageControl = { signal, check, issue };
  const notify = (phase: StorageProgress['phase'], force = false) => {
    if (force || Date.now() - lastProgress >= 250) { lastProgress = Date.now(); progress({ id, revision: ++revision, phase, visited, files, elapsedMs: Date.now() - started }); }
  };
  type Identity = { size: number; linked: boolean; paths: Set<string>; references: Set<StorageRoot>; contributions: Map<StorageKind, number> };
  const identities = new Map<string, Identity>(), countedPaths = new Set<string>();
  const roots: StorageRoot[] = [];
  let status: StorageReport['status'] = 'complete';
  const rootKeys = new Set<string>();
  const addRoot = (root: StorageRoot) => {
    const key = keyPath(root.path) + ':' + root.kinds.join(',') + ':' + (root.key ?? '');
    if (rootKeys.has(key)) return;
    if (roots.length >= limits.roots) { root.kinds.forEach(kind => issue(kind, 'limit')); return; }
    rootKeys.add(key); roots.push(root);
  };
  notify('catalog', true);
  try {
    const result = await catalog(control); check();
    for (const item of result.issues) issue(item.kind, item.issue);
    result.roots.forEach(addRoot);
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
      const root = roots[rootIndex]; check();
      try { await safeStoragePath(root.path, signal, check); }
      catch (error) {
        if (signal.aborted || error instanceof CensusLimit) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') root.kinds.forEach(kind => issue(kind, (error as NodeJS.ErrnoException).code === 'STORAGE_LINK' ? 'unsafe' : 'access'));
        continue;
      }
      const queue = [{ path: path.resolve(root.path), depth: 0 }];
      for (let head = 0; head < queue.length; head++) {
        check(); if (visited >= limits.entries) throw new CensusLimit();
        const current = queue[head], relative = path.relative(root.path, current.path).split(path.sep).join('/'), location = root.locate(relative);
        const affected = root.affects?.(relative) ?? root.kinds;
        visited++; if (visited % 64 === 0) { await yieldNow(); check(); } notify('counting');
        try {
          const stat = await fs.promises.lstat(current.path, { bigint: true }); check();
          if (stat.isSymbolicLink()) { affected.forEach(kind => issue(kind, 'unsafe')); continue; }
          // A parent replaced by a junction after the root check must not escape.
          if (keyPath(await fs.promises.realpath(current.path)) !== keyPath(current.path)) { affected.forEach(kind => issue(kind, 'unsafe')); continue; }
          if (stat.isDirectory()) {
            if (current.depth >= limits.depth) { root.kinds.forEach(kind => issue(kind, 'depth')); continue; }
            const directory = await fs.promises.opendir(current.path, { bufferSize: 32 });
            try {
              for (;;) {
                check(); const entry = await directory.read(); if (!entry) break;
                if (queue.length - head + visited >= limits.entries) { root.kinds.forEach(kind => issue(kind, 'limit')); break; }
                queue.push({ path: path.join(current.path, entry.name), depth: current.depth + 1 });
              }
            } finally { await directory.close(); }
          } else if (stat.isFile()) {
            const bytes = Number(stat.size), group = groups.get(location.kind)!;
            if (!Number.isSafeInteger(bytes) || bytes < 0 || group.logicalBytes! + bytes > Number.MAX_SAFE_INTEGER) { issue(location.kind, 'limit'); continue; }
            const pathKey = keyPath(current.path), contribution = pathKey + ':' + location.kind;
            if (!countedPaths.has(contribution)) {
              countedPaths.add(contribution); group.logicalBytes! += bytes; group.files++; files++;
              group.mixedData ||= !!location.mixedData;
              const identityKey = stat.ino > 0n ? stat.dev + ':' + stat.ino : pathKey;
              if (stat.ino === 0n && stat.nlink > 1n) { uniqueReliable = false; issue(location.kind, 'identity'); }
              let identity = identities.get(identityKey);
              if (!identity) { identity = { size: bytes, linked: stat.nlink > 1n, paths: new Set(), references: new Set(), contributions: new Map() }; identities.set(identityKey, identity); }
              if (identity.size !== bytes) { issue(location.kind, 'changed'); identity.size = Math.min(identity.size, bytes); }
              identity.paths.add(pathKey); identity.linked ||= stat.nlink > 1n;
              identity.contributions.set(location.kind, (identity.contributions.get(location.kind) ?? 0) + bytes);
            }
            const identityKey = stat.ino > 0n ? stat.dev + ':' + stat.ino : pathKey;
            identities.get(identityKey)?.references.add(root);
            for (const action of location.actions ?? []) {
              if (!group.actions.some(old => JSON.stringify(old) === JSON.stringify(action))) {
                if (group.actions.length < 64) group.actions.push(action); else group.moreActions = true;
              }
            }
            if (root.discover) { const discovered = await root.discover(current.path, relative, bytes, control); discovered.forEach(addRoot); }
          } else issue(location.kind, 'unsafe');
        } catch (error) {
          if (signal.aborted || error instanceof CensusLimit) throw error;
          affected.forEach(kind => issue(kind, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'changed' : 'access'));
        }
      }
    }
  } catch (error) {
    if (signal.aborted) status = 'canceled';
    else if (error instanceof CensusLimit) status = 'partial';
    else throw error;
    STORAGE_KINDS.forEach(kind => issue(kind, status === 'canceled' ? 'canceled' : 'limit'));
  }
  let uniqueLogicalBytes = 0, uniqueOverflow = false;
  for (const identity of identities.values()) {
    if (Number.isSafeInteger(uniqueLogicalBytes + identity.size)) uniqueLogicalBytes += identity.size;
    else uniqueOverflow = true;
    if (identity.linked || identity.paths.size > 1 || identity.contributions.size > 1 || identity.references.size > 1) {
      for (const [kind, bytes] of identity.contributions) groups.get(kind)!.sharedBytes += bytes;
    }
  }
  if (uniqueOverflow) STORAGE_KINDS.forEach(kind => issue(kind, 'limit'));
  for (const group of groups.values()) { if (group.issues.length && !group.files) group.logicalBytes = null; }
  if (status === 'complete' && [...groups.values()].some(group => group.issues.length)) status = 'partial';
  notify('counting', true);
  return { id, status, scannedAt: Date.now(), elapsedMs: Date.now() - started,
    uniqueLogicalBytes: uniqueOverflow || !identities.size && status !== 'complete' ? null : uniqueLogicalBytes,
    uniqueReliable, files: new Set([...identities.values()].flatMap(identity => [...identity.paths])).size, visited, groups: [...groups.values()] };
}

/** One census at a time; cancellation does not start overlapping filesystem work. */
export class StorageOverviewController {
  private active?: { id: string; abort: AbortController };
  constructor(private catalog: (control: StorageControl) => Promise<StorageCatalog>, private limits: Partial<StorageLimits> = {}) {}
  async scan(id: string, progress?: (value: StorageProgress) => void): Promise<StorageReport> {
    if (this.active) throw Error('Storage scan already running');
    const active = { id, abort: new AbortController() }; this.active = active;
    try { return await scanStorage(id, this.catalog, active.abort.signal, progress, this.limits); }
    finally { if (this.active === active) this.active = undefined; }
  }
  cancel(id: string): void { if (this.active?.id === id) this.active.abort.abort(); }
  close(): void { this.active?.abort.abort(); }
}
