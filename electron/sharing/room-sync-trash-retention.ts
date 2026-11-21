/** Manual cleanup removes only authenticated trash payloads with an independent verified replica. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RoomSyncStore, SyncTrashExportReceipt } from '../db/room-sync-store';
import { SYNC_RECOVERY_OPERATION_LIMIT } from '../../shared/room-file-sync';
import type { SyncTrashRow, SyncTrashResult } from '../../shared/room-file-sync-ui';
import { SYNC_TRASH_SELECTION_LIMIT } from '../../shared/room-file-sync-ui';
import { RoomSyncTrash, parseSyncTrashJournal, parseSyncTrashReceipt, SYNC_TRASH_BYTES, type SyncTrashJournal } from './room-sync-trash';
import { authorizedSyncTrashJournal } from './room-sync-apply-auth';
import { withSyncApplyLock, readSyncApplyRecord, writeSyncRecord } from './room-sync-apply';
import { assertSyncPlainPath, syncFileDigest } from './room-sync-snapshot';

export const syncTrashIdentity = (s: fs.Stats) => JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink, s.mode]);
export interface SyncTrashReplica { revisionId: string; identity: string; exported?: SyncTrashExportReceipt }
export interface SyncTrashRetentionOptions {
  current(): boolean;
  pins(): string[];
  replica(revisionId: string, digest: string): Promise<string | null>; // Empty string means different plaintext.
  replicaCurrent(replica: SyncTrashReplica): boolean;
  exported?(operationId: string, journal: SyncTrashJournal, size: number): Promise<SyncTrashExportReceipt | null>;
}
export interface SyncTrashPayload { operationId: string; size: number; digest: string; revisionId: string; fileIdentity: string; directoryIdentity: string }
export interface SyncTrashPlan {
  folder: string; rootIdentity: string; epoch: number; context: string; fingerprint: string; rows: SyncTrashRow[];
  summary: { bytes: number; limitBytes: number; protectedBytes: number; reclaimableBytes: number; selectedBytes: number; selectedCopies: number; copies: number; unscanned: number };
  selected: Array<{ operationId: string; size: number; digest: string; replica: SyncTrashReplica; fileIdentity: string; directoryIdentity: string }>;
  exportable: SyncTrashPayload[];
}
export type SyncTrashPruneStep = 'intent' | 'linked' | 'moved' | 'deleted';
const OP = /^op-[a-zA-Z0-9]+$/;
const KNOWN = ['journal.json', 'receipt.json', 'previous'];
export function syncTrashDirectoryIdentity(file: string): string {
  assertSyncPlainPath(file); const s = fs.lstatSync(file); if (!s.isDirectory()) throw new Error('Trash directory changed');
  return JSON.stringify([s.dev, s.ino, s.birthtimeMs]);
}
const directoryIdentity = syncTrashDirectoryIdentity;
async function stat(file: string): Promise<fs.Stats | null> {
  try { return await fs.promises.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export const syncTrashContext = (store: RoomSyncStore, o: SyncTrashRetentionOptions) => crypto.createHash('sha256').update(JSON.stringify([
  store.binding(), store.bindingEpoch(), store.logGeneration(), store.policy()?.policyId, store.heads(), store.applied(),
  store.deferred(), store.pendingRecordIds(), store.watch(), store.trashExports(), o.pins()])).digest('hex');
const context = syncTrashContext;
function check(current: () => boolean) { if (!current()) throw new Error('Trash cleanup changed; review again'); }
async function inspect(store: RoomSyncStore, selected: string[], o: SyncTrashRetentionOptions): Promise<Omit<SyncTrashPlan, 'epoch' | 'context'>> {
  const folder = store.binding()!.path, base = path.join(folder, '.havvn-sync', 'trash');
  assertSyncPlainPath(folder); const root = await fs.promises.lstat(folder); if (!root.isDirectory()) throw new Error('Trash binding unavailable');
  assertSyncPlainPath(base); const baseStat = await stat(base);
  const ids = baseStat ? (await fs.promises.readdir(base)).sort() : [];
  if (ids.length > SYNC_RECOVERY_OPERATION_LIMIT) throw new Error('Sync trash capacity reached');
  const hash = crypto.createHash('sha256').update(JSON.stringify([folder, root.dev, root.ino, root.birthtimeMs, baseStat && syncTrashIdentity(baseStat)]));
  const wanted = new Set(selected), busy = new Set([...store.pendingRecordIds(), ...o.pins()]), deferred = new Set(store.deferred());
  const rows: SyncTrashRow[] = [], copies: SyncTrashPlan['selected'] = [], replicas = new Map<string, string | null>();
  const exportable: SyncTrashPayload[] = [];
  let bytes = 0, unscanned = 0;
  for (const id of ids) {
    check(o.current); const directory = path.join(base, id); let row: SyncTrashRow | null = null;
    try {
      assertSyncPlainPath(directory); const dir = await fs.promises.lstat(directory); if (!dir.isDirectory()) throw new Error('Unknown trash entry');
      const children = (await fs.promises.readdir(directory)).sort(); if (children.length > 8) throw new Error('Unknown trash contents');
      const parts: unknown[] = []; let previous: fs.Stats | null = null;
      for (const child of children) {
        const s = await fs.promises.lstat(path.join(directory, child)); parts.push([child, syncTrashIdentity(s)]);
        if (s.isFile()) bytes += s.size; else unscanned++;
        if (child === 'previous' || !previous && child === 'previous.pruning') previous = s;
      }
      hash.update(JSON.stringify([id, syncTrashIdentity(dir), parts]));
      if (!previous) { if (children.some(c => !KNOWN.includes(c))) unscanned++; continue; }
      row = { operationId: id, path: id, size: previous.isFile() ? previous.size : 0, createdAt: 0, eligible: false, selected: false, reason: 'unverified' };
      rows.push(row);
      if (!OP.test(id)) throw new Error('Unknown trash entry');
      const j = parseSyncTrashJournal(await readSyncApplyRecord(path.join(directory, 'journal.json')));
      if (!authorizedSyncTrashJournal(store, j)) throw new Error('Unverified trash operation');
      row.path = j.relativePath; hash.update(JSON.stringify(j));
      if (!children.includes('receipt.json')) { row.reason = 'unfinished'; continue; }
      const receipt = parseSyncTrashReceipt(await readSyncApplyRecord(path.join(directory, 'receipt.json')), j, id);
      hash.update(JSON.stringify(receipt)); const receiptStat = await fs.promises.lstat(path.join(directory, 'receipt.json'));
      row.createdAt = Math.max(receiptStat.birthtimeMs, receiptStat.mtimeMs);
      if (receipt.state !== 'deleted') { row.reason = 'rolled-back'; continue; }
      if (children.some(c => !KNOWN.includes(c))) { row.reason = 'unfinished'; unscanned++; continue; }
      const file = path.join(directory, 'previous');
      assertSyncPlainPath(file);
      if (!previous.isFile() || previous.nlink !== 1) throw new Error('Linked trash payload');
      if (busy.has(j.revisionId) || busy.has(j.baseRevisionId) || deferred.has(store.revision(j.revisionId)!.entryId)) { row.reason = 'busy'; continue; }
      const digest = await syncFileDigest(file); hash.update(digest);
      if (digest !== j.expectedDigest || syncTrashIdentity((await fs.promises.lstat(file))) !== syncTrashIdentity(previous)) { row.reason = 'changed'; continue; }
      row.exportable = true;
      exportable.push({ operationId: id, size: row.size, digest, revisionId: j.revisionId, fileIdentity: syncTrashIdentity(previous), directoryIdentity: directoryIdentity(directory) });
      const replicaKey = j.baseRevisionId + ':' + digest;
      if (!replicas.has(replicaKey)) {
        try { replicas.set(replicaKey, await o.replica(j.baseRevisionId, digest)); } catch { check(o.current); replicas.set(replicaKey, null); }
      }
      const identity = replicas.get(replicaKey); hash.update(JSON.stringify([replicaKey, identity]));
      const exported = !identity ? await o.exported?.(id, j, row.size) : null;
      hash.update(JSON.stringify(exported ?? null));
      if (!identity && !exported) { row.reason = identity === '' ? 'different' : 'unavailable'; continue; }
      const replica: SyncTrashReplica = { revisionId: j.baseRevisionId, identity: identity || exported!.identity, ...(exported ? { exported } : {}) };
      if (!o.replicaCurrent(replica)) { row.reason = 'unavailable'; continue; }
      row.reason = exported ? 'exported' : 'ready'; row.eligible = true; row.selected = wanted.has(id);
      if (row.selected) copies.push({ operationId: id, digest, size: row.size, replica, fileIdentity: syncTrashIdentity(previous), directoryIdentity: directoryIdentity(directory) });
    } catch { if (row) { row.reason = 'unverified'; row.eligible = false; row.selected = false; } unscanned++; }
  }
  check(o.current);
  if (!Number.isSafeInteger(bytes) || selected.some(id => !rows.some(r => r.operationId === id && r.eligible))) throw new Error('Trash cleanup changed; review again');
  rows.sort((a, b) => b.createdAt - a.createdAt || a.operationId.localeCompare(b.operationId));
  hash.update(JSON.stringify(rows));
  const reclaimableBytes = rows.filter(r => r.eligible).reduce((n, r) => n + r.size, 0), selectedBytes = copies.reduce((n, c) => n + c.size, 0);
  return { folder, rootIdentity: JSON.stringify([root.dev, root.ino, root.birthtimeMs]), fingerprint: hash.digest('hex'), rows, selected: copies, exportable,
    summary: { bytes, limitBytes: SYNC_TRASH_BYTES, protectedBytes: bytes - reclaimableBytes, reclaimableBytes, selectedBytes, selectedCopies: copies.length, copies: rows.length, unscanned } };
}
export async function previewSyncTrash(store: RoomSyncStore, selected: string[], o: SyncTrashRetentionOptions): Promise<SyncTrashPlan> {
  if (!Array.isArray(selected) || selected.length > SYNC_TRASH_SELECTION_LIMIT || new Set(selected).size !== selected.length || selected.some(id => typeof id !== 'string' || !OP.test(id))) throw new Error('Invalid trash selection');
  const binding = store.binding(), epoch = store.bindingEpoch(); if (!binding) throw new Error('Trash binding unavailable');
  const current = () => o.current() && store.bindingEpoch() === epoch && store.binding()?.path === binding.path;
  await new RoomSyncTrash(binding.path).recoverCleanup(j => authorizedSyncTrashJournal(store, j), current);
  return withSyncApplyLock(binding.path, async () => {
    check(current); const initial = context(store, o), plan = await inspect(store, selected, { ...o, current });
    if (initial !== context(store, o)) throw new Error('Trash cleanup changed; review again');
    return { ...plan, epoch, context: initial };
  });
}
export async function confirmSyncTrash(store: RoomSyncStore, plan: SyncTrashPlan, o: SyncTrashRetentionOptions,
  onStep?: (step: SyncTrashPruneStep, directory: string) => void | Promise<void>): Promise<SyncTrashResult> {
  const current = () => {
    try { return o.current() && store.bindingEpoch() === plan.epoch && store.binding()?.path === plan.folder && context(store, o) === plan.context && directoryIdentity(plan.folder) === plan.rootIdentity; }
    catch { return false; }
  };
  return withSyncApplyLock(plan.folder, async () => {
    check(current); const fresh = await inspect(store, plan.selected.map(c => c.operationId), { ...o, current });
    if (!plan.selected.length || fresh.fingerprint !== plan.fingerprint) throw new Error('Trash cleanup changed; review again');
    let removedBytes = 0, removedCopies = 0, error: string | undefined;
    for (const copy of fresh.selected) {
      const directory = path.join(plan.folder, '.havvn-sync', 'trash', copy.operationId), previous = path.join(directory, 'previous');
      const staged = path.join(directory, 'previous.pruning'), marker = path.join(directory, 'prune.json');
      const copyCurrent = () => { try { return current() && directoryIdentity(directory) === copy.directoryIdentity; } catch { return false; } };
      try {
        check(copyCurrent); if (!o.replicaCurrent(copy.replica)) throw new Error('Trash recovery copy changed');
        assertSyncPlainPath(directory); assertSyncPlainPath(previous);
        if (syncTrashIdentity(await fs.promises.lstat(previous)) !== copy.fileIdentity) throw new Error('Trash payload changed during cleanup');
        await writeSyncRecord(marker, { v: 1, digest: copy.digest, size: copy.size }); await onStep?.('intent', directory); check(copyCurrent);
        await fs.promises.link(previous, staged); await onStep?.('linked', directory);
        const a = await fs.promises.lstat(previous), b = await fs.promises.lstat(staged);
        if (!a.isFile() || !b.isFile() || a.dev !== b.dev || a.ino !== b.ino || a.nlink !== 2 || b.nlink !== 2) throw new Error('Trash cleanup changed during staging');
        check(copyCurrent); assertSyncPlainPath(directory); await fs.promises.unlink(previous); await onStep?.('moved', directory);
        assertSyncPlainPath(staged); const before = await fs.promises.lstat(staged);
        if (before.size !== copy.size || await syncFileDigest(staged) !== copy.digest) throw new Error('Trash payload changed during cleanup');
        check(copyCurrent); assertSyncPlainPath(staged);
        if (syncTrashIdentity(await fs.promises.lstat(staged)) !== syncTrashIdentity(before) || !o.replicaCurrent(copy.replica)) throw new Error('Trash recovery copy changed');
        await fs.promises.unlink(staged); removedBytes += copy.size; removedCopies++;
        await onStep?.('deleted', directory); assertSyncPlainPath(marker); await fs.promises.unlink(marker);
      } catch (cause) { error = String(cause instanceof Error ? cause.message : cause); break; }
    }
    return { removedBytes, removedCopies, ...(error ? { error } : {}) };
  });
}
