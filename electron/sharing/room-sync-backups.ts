/** Retention touches only verified previous payloads; journals and receipts remain permanent. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SYNC_RECOVERY_OPERATION_LIMIT } from '../../shared/room-file-sync';
import type { RoomSyncStore } from '../db/room-sync-store';
import { withSyncApplyLock, writeSyncRecord, discardSyncRecordTemps, parseSyncApplyJournal, parseSyncApplyReceipt, readSyncApplyRecord, type SyncApplyJournal } from './room-sync-apply';
import { assertSyncPlainPath, syncFileDigest } from './room-sync-snapshot';
import { authorizedSyncApplyJournal } from './room-sync-apply-auth';
import { validSyncBackupPolicy, type SyncBackupPolicy, type SyncBackupRow, type SyncBackupSummary, type SyncBackupResult } from '../../shared/room-file-sync-backups';

const OP = /^op-[a-zA-Z0-9]+$/;
const KNOWN = new Set(['journal.json', 'receipt.json', 'previous']);
const stamp = (s: fs.Stats) => JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink, s.mode]);
const context = (store: RoomSyncStore) => JSON.stringify([store.binding(), store.bindingEpoch(), store.logGeneration(), store.applied(), store.backupPolicy()]);
interface Copy { row: SyncBackupRow; file: string; directory: string; journal: SyncApplyJournal | null; eligible: boolean; digest?: string; identity: string }
export interface SyncBackupPlan {
  folder: string; bindingEpoch: number; context: string; policy: SyncBackupPolicy; now: number; fingerprint: string;
  summary: SyncBackupSummary; rows: SyncBackupRow[];
  selected: Array<{ operationId: string; digest: string; size: number; anchor: { operationId: string; identity: string } }>;
}
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function stat(file: string): Promise<fs.Stats | null> { try { return await fs.promises.lstat(file); } catch (error) { if (absent(error)) return null; throw error; } }
function checkCurrent(current: () => boolean): void { if (!current()) throw new Error('Backup maintenance canceled; review again'); }
function authorize(store: RoomSyncStore, journal: SyncApplyJournal): boolean {
  return authorizedSyncApplyJournal(store, journal);
}
async function operation(directory: string, id: string, store: RoomSyncStore) {
  const rawJournal = await readSyncApplyRecord(path.join(directory, 'journal.json'));
  const journal = parseSyncApplyJournal(rawJournal);
  if (!authorize(store, journal)) throw new Error('Unverified backup operation');
  const rawReceipt = await readSyncApplyRecord(path.join(directory, 'receipt.json'));
  const receipt = parseSyncApplyReceipt(rawReceipt, journal, id);
  return { journal, receipt, rawJournal, rawReceipt };
}

/** Recover an interrupted pruning rename by returning the bytes, even if an editor changed them. */
async function recoverUnlocked(folder: string, store: RoomSyncStore, current: () => boolean): Promise<void> {
  const base = path.join(folder, '.havvn-sync', 'transactions'); assertSyncPlainPath(base);
  const baseStat = await stat(base); if (!baseStat) return;
  const ids = await fs.promises.readdir(base); if (ids.length > SYNC_RECOVERY_OPERATION_LIMIT) throw new Error('Backup directory capacity reached');
  for (const id of ids.filter(name => OP.test(name))) {
    checkCurrent(current);
    const directory = path.join(base, id), marker = path.join(directory, 'prune.json');
    try {
      assertSyncPlainPath(directory);
      if (!await stat(marker) && !(await fs.promises.readdir(directory)).some(name => name.startsWith('prune.json.tmp-'))) continue;
      const { journal, receipt } = await operation(directory, id, store);
      await discardSyncRecordTemps(directory, ['prune.json']);
      if (!await stat(marker)) continue;
      const intent = await readSyncApplyRecord(marker) as { v?: number; digest?: string; size?: number };
      if (receipt.state !== 'applied' || journal.expectedDigest === null || intent?.v !== 1 || intent.digest !== journal.expectedDigest
        || !Number.isSafeInteger(intent.size) || intent.size! < 0) continue;
      const staged = path.join(directory, 'previous.pruning'), previous = path.join(directory, 'previous');
      const moved = await stat(staged), old = await stat(previous);
      if (moved) {
        if (!moved.isFile() || moved.isSymbolicLink()) continue;
        if (old) {
          // A crash can fall between the rollback link and unlink. No other links are safe.
          if (!old.isFile() || moved.dev !== old.dev || moved.ino !== old.ino || moved.nlink !== 2 || old.nlink !== 2) continue;
          assertSyncPlainPath(directory); checkCurrent(current); await fs.promises.unlink(staged);
        } else {
          assertSyncPlainPath(staged); checkCurrent(current);
          await fs.promises.link(staged, previous); await fs.promises.unlink(staged);
        }
      } else if (old) assertSyncPlainPath(previous);
      checkCurrent(current); assertSyncPlainPath(marker); await fs.promises.unlink(marker);
    } catch {
      // Preserve malformed, linked, locked or competing data. Inventory reports it as protected.
      checkCurrent(current);
    }
  }
}
export async function recoverSyncBackupPrunes(store: RoomSyncStore, current: () => boolean): Promise<void> {
  const binding = store.binding(), epoch = store.bindingEpoch(); if (!binding) return;
  const valid = () => current() && store.bindingEpoch() === epoch && store.binding()?.path === binding.path;
  return withSyncApplyLock(binding.path, () => recoverUnlocked(binding.path, store, valid));
}

async function inspect(folder: string, store: RoomSyncStore, policy: SyncBackupPolicy, now: number, current: () => boolean): Promise<Omit<SyncBackupPlan, 'bindingEpoch' | 'context'>> {
  const base = path.join(folder, '.havvn-sync', 'transactions'); assertSyncPlainPath(folder); assertSyncPlainPath(base);
  const hash = crypto.createHash('sha256'), copies: Copy[] = [];
  let bytes = 0, unscanned = 0;
  const protectedIds = new Set([...store.applied().map(a => a.revisionId), ...store.heads().flatMap(h => h.revisionIds)]);
  const baseStat = await stat(base);
  const ids = baseStat ? (await fs.promises.readdir(base)).sort() : [];
  if (ids.length > SYNC_RECOVERY_OPERATION_LIMIT) throw new Error('Backup directory capacity reached');
  hash.update(JSON.stringify([folder, policy, now, !!baseStat]));
  for (const id of ids) {
    checkCurrent(current);
    const directory = path.join(base, id);
    let children: string[] = [], journal: SyncApplyJournal | null = null, reason: SyncBackupRow['reason'] = 'unverified', time = 0;
    let previous: fs.Stats | null = null, dirStat: fs.Stats | null = null, raw: unknown = null;
    const parts: unknown[] = [];
    try {
      assertSyncPlainPath(directory); dirStat = await fs.promises.lstat(directory);
      if (!OP.test(id) || !dirStat.isDirectory()) throw new Error('Unknown backup entry');
      children = (await fs.promises.readdir(directory)).sort();
      if (children.length > 8) throw new Error('Unknown backup contents');
      for (const child of children) {
        const file = path.join(directory, child), s = await fs.promises.lstat(file);
        parts.push([child, stamp(s)]);
        if (s.isFile()) { bytes += s.size; if (!Number.isSafeInteger(bytes)) throw new Error('Backup size capacity reached'); }
        else unscanned++;
        if (child === 'previous') previous = s;
      }
      try {
        const verified = await operation(directory, id, store); journal = verified.journal;
        raw = [verified.rawJournal, verified.rawReceipt];
        const receiptStat = await fs.promises.lstat(path.join(directory, 'receipt.json'));
        time = Math.max(receiptStat.birthtimeMs, receiptStat.mtimeMs);
        reason = verified.receipt.state === 'rolled-back' ? 'rolled-back'
          : children.some(c => !KNOWN.has(c)) || !previous?.isFile() || previous.nlink !== 1 || journal.expectedDigest === null ? 'unfinished'
            : protectedIds.has(journal.revisionId) ? 'current' : 'retained';
      } catch { reason = 'unverified'; }
      if (children.includes('prune.json') || children.includes('previous.pruning') || !children.includes('receipt.json')) reason = 'unfinished';
      if (previous) {
        try { assertSyncPlainPath(path.join(directory, 'previous')); } catch { reason = 'unverified'; }
        copies.push({ directory, file: path.join(directory, 'previous'), journal, eligible: reason === 'retained' || reason === 'current', identity: stamp(previous),
          row: { operationId: id, path: journal?.relativePath ?? id, size: previous.isFile() ? previous.size : 0, createdAt: time, remove: false, reason } });
      }
      if (children.some(c => !KNOWN.has(c))) unscanned++;
    } catch { unscanned++; }
    hash.update(JSON.stringify([id, dirStat && stamp(dirStat), children, parts, raw]));
  }
  const groups = new Map<string, Copy[]>();
  const groupKey = (copy: Copy) => store.revision(copy.journal!.revisionId)!.entryId;
  for (const copy of copies.filter(c => c.eligible)) {
    const key = groupKey(copy), list = groups.get(key) ?? []; list.push(copy); groups.set(key, list);
  }
  for (const group of groups.values()) group.sort((a, b) => b.row.createdAt - a.row.createdAt || b.row.operationId.localeCompare(a.row.operationId));
  const checked = new Set<Copy>();
  const verify = async (copy: Copy): Promise<boolean> => {
    if (checked.has(copy)) return copy.row.reason !== 'changed';
    checked.add(copy); checkCurrent(current);
    try {
      assertSyncPlainPath(copy.file); copy.digest = await syncFileDigest(copy.file);
      if (stamp(await fs.promises.lstat(copy.file)) !== copy.identity || copy.digest !== copy.journal!.expectedDigest) throw new Error('Changed backup');
      return true;
    } catch { copy.row.reason = 'changed'; copy.eligible = false; return false; }
  };
  for (let pass = 0; pass <= copies.length; pass++) {
    for (const copy of copies) { copy.row.remove = false; if (copy.row.reason === 'latest' || ['count', 'age', 'budget'].includes(copy.row.reason)) copy.row.reason = 'retained'; }
    for (const group of groups.values()) {
      const eligible = group.filter(c => c.eligible);
      eligible.forEach((copy, index) => {
        if (copy.row.reason === 'current') return;
        if (index === 0) copy.row.reason = 'latest';
        else if (index >= policy.keepVersions) { copy.row.remove = true; copy.row.reason = 'count'; }
        else if (policy.maxAgeDays > 0 && copy.row.createdAt < now - policy.maxAgeDays * 86400_000) { copy.row.remove = true; copy.row.reason = 'age'; }
      });
    }
    let remaining = bytes - copies.filter(c => c.row.remove).reduce((sum, c) => sum + c.row.size, 0);
    for (const copy of [...copies].sort((a, b) => a.row.createdAt - b.row.createdAt || a.row.operationId.localeCompare(b.row.operationId))) {
      if (remaining <= policy.limitBytes) break;
      if (copy.eligible && copy.row.reason === 'retained') { copy.row.reason = 'budget'; copy.row.remove = true; remaining -= copy.row.size; }
    }
    let replan = false;
    for (const group of groups.values()) {
      if (!group.some(c => c.row.remove)) continue;
      const anchor = group.find(c => c.eligible);
      if (anchor && !await verify(anchor)) replan = true;
    }
    for (const copy of copies.filter(c => c.row.remove)) if (!await verify(copy)) replan = true;
    if (!replan) break;
  }
  checkCurrent(current);
  const rows = copies.map(c => c.row).sort((a, b) => b.createdAt - a.createdAt || b.operationId.localeCompare(a.operationId));
  hash.update(JSON.stringify(copies.map(c => [c.row, c.digest])));
  const selected = copies.filter(c => c.row.remove).map(c => {
    const anchor = groups.get(groupKey(c))!.find(a => a.eligible)!;
    return { operationId: c.row.operationId, size: c.row.size, digest: c.digest!, anchor: { operationId: anchor.row.operationId, identity: anchor.identity } };
  });
  const removeBytes = selected.reduce((sum, c) => sum + c.size, 0);
  const availableBytes = copies.filter(c => c.eligible && !['current', 'latest'].includes(c.row.reason)).reduce((sum, c) => sum + c.row.size, 0);
  return { folder, policy: { ...policy }, now, rows, selected, fingerprint: hash.digest('hex'),
    summary: { bytes, protectedBytes: bytes - availableBytes, removeBytes, copies: copies.length, removeCopies: selected.length, unscanned } };
}
export async function previewSyncBackups(store: RoomSyncStore, policy: SyncBackupPolicy, current: () => boolean, now = Date.now()): Promise<SyncBackupPlan> {
  if (!validSyncBackupPolicy(policy)) throw new Error('Invalid backup retention policy');
  const binding = store.binding(), epoch = store.bindingEpoch(); if (!binding) throw new Error('A local backup binding is required');
  const valid = () => current() && store.bindingEpoch() === epoch && store.binding()?.path === binding.path;
  return withSyncApplyLock(binding.path, async () => {
    await recoverUnlocked(binding.path, store, valid); checkCurrent(valid);
    const initial = context(store), view = await inspect(binding.path, store, policy, now, valid);
    if (context(store) !== initial) throw new Error('Backup context changed; review again');
    return { ...view, bindingEpoch: epoch, context: initial };
  });
}

export type SyncPruneStep = 'intent' | 'linked' | 'moved' | 'deleted';
export async function confirmSyncBackups(store: RoomSyncStore, plan: SyncBackupPlan, current: () => boolean,
  onStep?: (step: SyncPruneStep, directory: string) => void | Promise<void>): Promise<SyncBackupResult> {
  const valid = () => current() && store.bindingEpoch() === plan.bindingEpoch && store.binding()?.path === plan.folder;
  return withSyncApplyLock(plan.folder, async () => {
    checkCurrent(valid);
    if (context(store) !== plan.context) throw new Error('Backup context changed; review again');
    const fresh = await inspect(plan.folder, store, plan.policy, plan.now, valid);
    if (fresh.fingerprint !== plan.fingerprint || context(store) !== plan.context) throw new Error('Backups changed since preview; review again');
    store.setBackupPolicy(plan.policy); // Never delete bytes if durable settings cannot be committed.
    const saved = context(store); let removedBytes = 0, removedCopies = 0, error: string | undefined;
    const stillCurrent = () => valid() && context(store) === saved;
    for (const copy of fresh.selected) {
      const directory = path.join(plan.folder, '.havvn-sync', 'transactions', copy.operationId);
      const previous = path.join(directory, 'previous'), staged = path.join(directory, 'previous.pruning'), marker = path.join(directory, 'prune.json');
      try {
        checkCurrent(stillCurrent); assertSyncPlainPath(previous);
        await writeSyncRecord(marker, { v: 1, digest: copy.digest, size: copy.size }); await onStep?.('intent', directory); checkCurrent(stillCurrent);
        await fs.promises.link(previous, staged); await onStep?.('linked', directory);
        const linked = await fs.promises.lstat(staged), original = await fs.promises.lstat(previous);
        if (!linked.isFile() || !original.isFile() || linked.dev !== original.dev || linked.ino !== original.ino || linked.nlink !== 2 || original.nlink !== 2) throw new Error('Backup changed during staging');
        checkCurrent(stillCurrent); assertSyncPlainPath(directory);
        await fs.promises.unlink(previous); await onStep?.('moved', directory);
        assertSyncPlainPath(staged);
        const before = await fs.promises.lstat(staged);
        if (!before.isFile() || before.size !== copy.size || await syncFileDigest(staged) !== copy.digest) throw new Error('Backup changed during cleanup');
        checkCurrent(stillCurrent); assertSyncPlainPath(staged);
        if (stamp(await fs.promises.lstat(staged)) !== stamp(before)) throw new Error('Backup changed during cleanup');
        const anchor = path.join(plan.folder, '.havvn-sync', 'transactions', copy.anchor.operationId, 'previous');
        assertSyncPlainPath(anchor);
        if (stamp(await fs.promises.lstat(anchor)) !== copy.anchor.identity) throw new Error('Protected last backup changed during cleanup');
        checkCurrent(stillCurrent);
        await fs.promises.unlink(staged); removedBytes += copy.size; removedCopies++;
        await onStep?.('deleted', directory);
        assertSyncPlainPath(marker); await fs.promises.unlink(marker);
      } catch (cause) { error = String(cause instanceof Error ? cause.message : cause); break; }
    }
    // Leave interrupted intents for restart recovery; never overwrite a competing backup.
    return { removedBytes, removedCopies, bytes: fresh.summary.bytes - removedBytes, ...(error ? { error } : {}) };
  });
}
