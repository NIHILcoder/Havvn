/** Private retained content only. Working files and recovery journals are never cache. */
import fs from 'node:fs';
import path from 'node:path';
import { SYNC_RECOVERY_OPERATION_LIMIT } from '../../shared/room-file-sync';
import type { RoomSyncStore } from '../db/room-sync-store';
import type { SyncCacheView } from '../../shared/room-file-sync-ui';
import { assertSyncPlainPath } from './room-sync-snapshot';

export async function manageSyncCache(storage: string, store: RoomSyncStore,
  release: (hash: string) => Promise<boolean>, current: () => boolean, trim = false, pinned: string[] = []): Promise<SyncCacheView> {
  const check = () => { if (!current()) throw new Error('Sync cache operation canceled'); };
  check();
  const protectedIds = new Set([...store.heads().flatMap(h => h.revisionIds), ...store.applied().map(a => a.revisionId),
    ...store.pendingRecordIds(), ...pinned]);
  // A tombstone has no payload. Keep its last content versions available for recovery.
  for (const head of store.heads()) for (const id of head.revisionIds) {
    const revision = store.revision(id); if (revision?.op === 'delete') revision.parents.forEach(parent => protectedIds.add(parent));
  }
  const sources = store.sources();
  const byDirectory = new Map<string, typeof sources>();
  for (const source of sources) {
    const directory = path.dirname(path.resolve(source.path)), entries = byDirectory.get(directory) ?? [];
    entries.push(source); byDirectory.set(directory, entries);
  }
  assertSyncPlainPath(storage);
  let names: string[];
  try { names = await fs.promises.readdir(storage); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { limitBytes: store.cacheLimit(), bytes: 0, protectedBytes: 0, removableBytes: 0, freedBytes: 0 }; throw error; }
  if (names.length > SYNC_RECOVERY_OPERATION_LIMIT) throw new Error('Sync cache directory capacity reached');
  const entries: Array<{ directory: string; files: string[]; ids: string[]; hashes: string[]; bytes: number; protected: boolean; order: number }> = [];
  const order = new Map(store.records().filter(r => r.kind === 'revision').map((r, i) => [r.value.revisionId, i]));
  for (const name of names) {
    check();
    const directory = path.join(path.resolve(storage), name);
    // Only generated, direct-child directories; never follow links or traverse arbitrary trees.
    if (!/^(snapshot|received)-[a-zA-Z0-9]+$/.test(name)) throw new Error('Unexpected sync cache directory');
    assertSyncPlainPath(directory);
    if (!(await fs.promises.lstat(directory)).isDirectory()) throw new Error('Invalid sync cache directory');
    const children = await fs.promises.readdir(directory);
    if (children.length > 8) throw new Error('Unexpected sync cache contents');
    let bytes = 0;
    const files: string[] = [];
    for (const child of children) {
      const file = path.join(directory, child); assertSyncPlainPath(file);
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Linked or invalid sync cache file');
      bytes += stat.size; files.push(file);
    }
    const retained = byDirectory.get(directory) ?? [];
    const ids = retained.map(s => s.revisionId);
    entries.push({ directory, files, ids, hashes: [...new Set(ids.map(id => store.revision(id)!.blob!.infoHash))], bytes,
      protected: ids.some(id => protectedIds.has(id)), order: ids.length ? Math.min(...ids.map(id => order.get(id) ?? -1)) : -1 });
  }
  let bytes = entries.reduce((sum, e) => sum + e.bytes, 0), freedBytes = 0;
  const limitBytes = store.cacheLimit();
  if (trim) for (const entry of entries.sort((a, b) => a.order - b.order)) {
    if (bytes <= limitBytes) break;
    check(); if (entry.protected) continue;
    let idle = true;
    for (const hash of entry.hashes) { if (!await release(hash)) idle = false; check(); }
    if (!idle) { entry.protected = true; continue; }
    // Durable pointer removal precedes deletion: a crash leaves an orphan, never a live missing source.
    store.forgetSources(entry.ids); check();
    for (const file of entry.files) { assertSyncPlainPath(file); await fs.promises.unlink(file); }
    assertSyncPlainPath(entry.directory); await fs.promises.rmdir(entry.directory);
    bytes -= entry.bytes; freedBytes += entry.bytes; entry.bytes = 0;
  }
  const protectedBytes = entries.filter(e => e.protected).reduce((sum, e) => sum + e.bytes, 0);
  return { limitBytes, bytes, protectedBytes, removableBytes: bytes - protectedBytes, freedBytes };
}
