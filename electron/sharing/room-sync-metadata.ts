/** Metadata retention never removes working bytes, cache payloads or recovery operations. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RoomSyncStore, SyncMetadataProofStore } from '../db/room-sync-store';
import { SYNC_RECOVERY_OPERATION_LIMIT } from '../../shared/room-file-sync';
import { assertSyncPlainPath } from './room-sync-snapshot';
import { withSyncApplyLock, parseSyncApplyJournal, parseSyncApplyReceipt, readSyncApplyRecord, type SyncApplyJournal } from './room-sync-apply';
import { parseSyncTrashJournal, type SyncTrashJournal } from './room-sync-trash';
import { authorizedSyncApplyJournal, authorizedSyncTrashJournal } from './room-sync-apply-auth';
import { ROOM_BACKUP_MAX_BYTES } from '../db/room-backup';

export interface SyncRecoveryProofs { stamp: string; apply: SyncApplyJournal[]; trash: SyncTrashJournal[]; ancestry: Array<{ from: string; to: string }> }
function ancestor(store: SyncMetadataProofStore, from: string, to: string): boolean {
  const pending = [to], seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!; if (id === from) return !!store.revision(from);
    if (seen.has(id)) continue; seen.add(id); const revision = store.revision(id); if (revision) pending.push(...revision.parents);
  }
  return false;
}
export async function inspectMetadataRecovery(store: RoomSyncStore): Promise<SyncRecoveryProofs> {
  const result: SyncRecoveryProofs = { stamp: '', apply: [], trash: [], ancestry: [] }, hash = crypto.createHash('sha256'), binding = store.binding();
  const activeApply: SyncApplyJournal[] = [], activeTrash: SyncTrashJournal[] = [];
  hash.update(JSON.stringify([binding, store.bindingEpoch()]));
  if (!binding) { result.stamp = hash.digest('hex'); return result; }
  assertSyncPlainPath(binding.path);
  if (!(await fs.promises.lstat(binding.path)).isDirectory()) throw new Error('Sync metadata binding is unavailable');
  for (const kind of ['transactions', 'trash'] as const) {
    const base = path.join(binding.path, '.havvn-sync', kind); assertSyncPlainPath(base);
    let ids: string[];
    try { ids = (await fs.promises.readdir(base)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { hash.update(kind + ':absent'); continue; } throw error; }
    if (ids.length > SYNC_RECOVERY_OPERATION_LIMIT) throw new Error('Sync recovery capacity reached');
    for (const id of ids) {
      if (!/^op-[a-zA-Z0-9]+$/.test(id)) throw new Error('Review unknown recovery files before metadata cleanup');
      const directory = path.join(base, id); assertSyncPlainPath(directory);
      const stat = await fs.promises.lstat(directory); if (!stat.isDirectory()) throw new Error('Invalid sync recovery directory');
      const children = (await fs.promises.readdir(directory)).sort();
      if (!children.length) { hash.update(JSON.stringify([kind, id, 'empty'])); continue; }
      if (children.length > 8 || !children.includes('journal.json')) throw new Error('Review unfinished recovery before metadata cleanup');
      hash.update(JSON.stringify([kind, id, stat.dev, stat.ino]));
      for (const child of children) {
        if (!(kind === 'trash' ? ['journal.json', 'receipt.json', 'previous'] : ['journal.json', 'receipt.json', 'previous', 'next', 'prune.json', 'previous.pruning', 'link-probe']).includes(child)) throw new Error('Review unknown recovery files before metadata cleanup');
        const file = path.join(directory, child); assertSyncPlainPath(file); const s = await fs.promises.lstat(file);
        if (!s.isFile()) throw new Error('Invalid recovery file');
        hash.update(JSON.stringify([child, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]));
      }
      const raw = await readSyncApplyRecord(path.join(directory, 'journal.json')); hash.update(JSON.stringify(raw));
      const receipt = children.includes('receipt.json') ? await readSyncApplyRecord(path.join(directory, 'receipt.json')) : null;
      if (kind === 'transactions') {
        const journal = parseSyncApplyJournal(raw); result.apply.push(journal);
        if (!receipt || parseSyncApplyReceipt(receipt, journal, id).state === 'applied') activeApply.push(journal);
      } else {
        const journal = parseSyncTrashJournal(raw); result.trash.push(journal);
        if (receipt) {
          const r = receipt as { state: string; operationId: string };
          if (!['deleted', 'rolled-back'].includes(r.state) || r.operationId !== id || JSON.stringify(parseSyncTrashJournal(receipt)) !== JSON.stringify(journal)) throw new Error('Invalid sync trash receipt');
          if (r.state === 'deleted') activeTrash.push(journal);
        } else activeTrash.push(journal);
      }
    }
  }
  const applied = new Map(store.applied().map(a => [a.entryId, a]));
  for (const journal of activeApply) {
    const revision = store.revision(journal.revisionId), base = revision && applied.get(revision.entryId);
    if (base && base.revisionId !== journal.revisionId && !(store.isRetiredRevision(journal.revisionId) && !store.isRetiredRevision(base.revisionId))) {
      const [from, to] = ancestor(store, journal.revisionId, base.revisionId) ? [journal.revisionId, base.revisionId] : [base.revisionId, journal.revisionId];
      if (!ancestor(store, from, to)) throw new Error('Review conflicting applied history before metadata cleanup');
      result.ancestry.push({ from, to });
    }
  }
  for (const journal of activeTrash) {
    const revision = store.revision(journal.revisionId), base = revision && applied.get(revision.entryId);
    if (!base || base.revisionId === journal.revisionId) continue;
    const [from, to] = ancestor(store, journal.revisionId, base.revisionId) ? [journal.revisionId, base.revisionId] : [base.revisionId, journal.revisionId];
    if (!ancestor(store, from, to)) throw new Error('Review conflicting deleted history before metadata cleanup');
    result.ancestry.push({ from, to });
  }
  // Protect authority needed by already-known updates that have not reached disk yet.
  for (const entry of store.heads()) {
    const local = applied.get(entry.entryId), base = local && store.revision(local.revisionId);
    if (!local || !base) continue;
    for (const id of entry.revisionIds) {
      const head = store.revision(id)!;
      if (head.op === 'put' && head.relativePath !== base.relativePath) result.apply.push({ v: 2, revisionId: id, relativePath: head.relativePath,
        fromPath: base.relativePath, digest: local.digest ?? '0'.repeat(64), expectedDigest: local.digest });
      if (head.op === 'delete' && base.op === 'put' && head.relativePath === base.relativePath && local.digest) result.trash.push({ v: 1,
        revisionId: id, baseRevisionId: base.revisionId, relativePath: head.relativePath, expectedDigest: local.digest });
    }
  }
  if (!metadataRecoveryValid(store, result)) throw new Error('Unverified recovery metadata; cleanup is unavailable');
  hash.update(JSON.stringify([result.apply, result.trash, result.ancestry]));
  result.stamp = hash.digest('hex'); return result;
}
export function metadataRecoveryValid(store: SyncMetadataProofStore, proofs: SyncRecoveryProofs): boolean {
  return proofs.apply.every(j => authorizedSyncApplyJournal(store, j)) && proofs.trash.every(j => authorizedSyncTrashJournal(store, j))
    && proofs.ancestry.every(edge => ancestor(store, edge.from, edge.to));
}
export function withMetadataRecovery<T>(store: RoomSyncStore, run: (proofs: SyncRecoveryProofs) => Promise<T>): Promise<T> {
  const binding = store.binding();
  const inspect = async () => run(await inspectMetadataRecovery(store));
  return binding ? withSyncApplyLock(binding.path, inspect) : inspect();
}

/** The native picker grants a new destination; existing files are never overwritten. */
export async function writeSyncHistoryExport(target: string, ciphertext: string): Promise<number> {
  assertSyncPlainPath(target);
  const handle = await fs.promises.open(target, 'wx', 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Sync history export destination already exists'); throw error;
  });
  try { await handle.writeFile(ciphertext, 'utf8'); await handle.sync(); return Buffer.byteLength(ciphertext); }
  finally { await handle.close(); } // An interrupted new file is retained and never reported as a successful export.
}
export async function readSyncHistoryExport(source: string): Promise<string> {
  assertSyncPlainPath(source); const handle = await fs.promises.open(source, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > ROOM_BACKUP_MAX_BYTES) throw new Error('Invalid or oversized sync history export');
    const content = await handle.readFile('utf8'), after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || Buffer.byteLength(content) !== before.size) throw new Error('Sync history export changed while reading');
    return content;
  } finally { await handle.close(); }
}
