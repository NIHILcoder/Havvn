/** Deletion is an atomic move into a private, durable trash; recovery never erases bytes. */
import fs from 'node:fs';
import path from 'node:path';
import { SYNC_HASH, SYNC_RECOVERY_OPERATION_LIMIT, validSyncRelativePath } from '../../shared/room-file-sync';
import { assertSyncPlainPath, syncFileDigest } from './room-sync-snapshot';
import { withSyncApplyLock, readSyncApplyRecord, writeSyncRecord as durable, discardSyncRecordTemps } from './room-sync-apply';

export interface SyncTrashJournal { v: 1; revisionId: string; baseRevisionId: string; relativePath: string; expectedDigest: string }
export interface SyncTrashReceipt extends SyncTrashJournal { operationId: string; state: 'deleted' | 'rolled-back' | 'conflict'; previousPath?: string }
type Authorize = (journal: Readonly<SyncTrashJournal>) => boolean;
export type SyncTrashStep = 'prepared' | 'previous-saved' | 'committed';
const OP = /^op-[a-zA-Z0-9]+$/;
export const SYNC_TRASH_BYTES = 2 * 1024 ** 3;
async function digest(file: string): Promise<string | null> {
  assertSyncPlainPath(file);
  try { await fs.promises.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  return syncFileDigest(file);
}
function journal(raw: unknown): SyncTrashJournal {
  const j = raw as SyncTrashJournal;
  if (!j || j.v !== 1 || !SYNC_HASH.test(j.revisionId) || !SYNC_HASH.test(j.baseRevisionId) || !SYNC_HASH.test(j.expectedDigest)
    || !validSyncRelativePath(j.relativePath)) throw new Error('Invalid sync trash journal');
  return { v: 1, revisionId: j.revisionId, baseRevisionId: j.baseRevisionId, relativePath: j.relativePath, expectedDigest: j.expectedDigest };
}
export { journal as parseSyncTrashJournal };
export function parseSyncTrashReceipt(raw: unknown, j: SyncTrashJournal, id: string): SyncTrashReceipt {
  const r = raw as SyncTrashReceipt;
  if (!r || !['deleted', 'rolled-back'].includes(r.state) || r.operationId !== id || JSON.stringify(journal(r)) !== JSON.stringify(j)) throw new Error('Invalid sync trash receipt');
  return { ...j, operationId: id, state: r.state };
}
export class RoomSyncTrash {
  private readonly root: string;
  private readonly directory: string;
  constructor(root: string, private readonly limitBytes = SYNC_TRASH_BYTES) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new Error('Invalid sync trash limit');
    this.root = path.resolve(root); this.directory = path.join(this.root, '.havvn-sync', 'trash');
  }
  private async initialize() {
    assertSyncPlainPath(this.root);
    if (!(await fs.promises.lstat(this.root)).isDirectory()) throw new Error('Sync root is not a directory');
    assertSyncPlainPath(this.directory); await fs.promises.mkdir(this.directory, { recursive: true }); assertSyncPlainPath(this.directory);
  }
  private async ids(): Promise<string[]> {
    const ids = await fs.promises.readdir(this.directory);
    if (ids.length > SYNC_RECOVERY_OPERATION_LIMIT) throw new Error('Sync trash capacity reached');
    if (ids.some(id => !OP.test(id))) throw new Error('Unexpected sync trash directory');
    return ids.sort();
  }
  private async capacity(additionalBytes: number): Promise<void> {
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new Error('Invalid sync trash size');
    const ids = await this.ids(); if (ids.length >= SYNC_RECOVERY_OPERATION_LIMIT) throw new Error('Sync trash capacity reached');
    let bytes = additionalBytes;
    for (const id of ids) {
      const previous = path.join(this.directory, id, 'previous'); assertSyncPlainPath(previous);
      try { const stat = await fs.promises.lstat(previous); if (!stat.isFile()) throw new Error('Invalid trash content'); bytes += stat.size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (bytes > this.limitBytes) throw new Error('Sync trash size limit reached; preserve or export its contents before deleting more files');
  }
  ensureCapacity(additionalBytes: number): Promise<void> {
    return withSyncApplyLock(this.root, async () => { await this.initialize(); await this.capacity(additionalBytes); });
  }
  private target(relativePath: string) { if (!validSyncRelativePath(relativePath)) throw new Error('Invalid sync trash path'); const target = path.join(this.root, ...relativePath.split('/')); assertSyncPlainPath(target); return target; }
  private receipt(id: string, j: SyncTrashJournal, state: SyncTrashReceipt['state']): SyncTrashReceipt {
    const previous = path.join(this.directory, id, 'previous');
    return { ...j, operationId: id, state, ...(fs.existsSync(previous) ? { previousPath: previous } : {}) };
  }
  private async recoverUnlocked(authorize: Authorize): Promise<SyncTrashReceipt[]> {
    await this.recoverPrunesUnlocked(authorize, () => true);
    const results: SyncTrashReceipt[] = [];
    for (const id of await this.ids()) {
      const directory = path.join(this.directory, id); assertSyncPlainPath(directory);
      const intent = path.join(directory, 'journal.json'); if (!fs.existsSync(intent)) { await discardSyncRecordTemps(directory, ['journal.json']); continue; }
      const j = journal(await readSyncApplyRecord(intent));
      if (!authorize(j)) throw new Error('Sync trash revision is not authorized');
      await discardSyncRecordTemps(directory);
      const receiptPath = path.join(directory, 'receipt.json'); assertSyncPlainPath(receiptPath);
      if (fs.existsSync(receiptPath)) {
        const receipt = parseSyncTrashReceipt(await readSyncApplyRecord(receiptPath), j, id);
        results.push(this.receipt(id, j, receipt.state)); continue;
      }
      const previous = path.join(directory, 'previous'), target = this.target(j.relativePath);
      // Recover only the rollback link created by this operation, never an arbitrary hard link.
      if (fs.existsSync(target) && fs.existsSync(previous)) {
        const a = await fs.promises.lstat(target), b = await fs.promises.lstat(previous);
        if (a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.nlink === 2 && b.nlink === 2) {
          assertSyncPlainPath(path.dirname(target)); assertSyncPlainPath(directory); await fs.promises.unlink(previous);
        }
      }
      const actual = await digest(target), old = await digest(previous);
      let state: SyncTrashReceipt['state'] = 'conflict';
      if (old === j.expectedDigest && actual === null) state = 'deleted';
      else if (old === null) state = 'rolled-back'; // A prepared intent alone never grants another deletion attempt.
      else if (old !== j.expectedDigest && actual === null) {
        // A late save followed the renamed handle. Return its bytes without overwriting a new file.
        this.target(j.relativePath); await fs.promises.link(previous, target); await fs.promises.unlink(previous); state = 'rolled-back';
      }
      const receipt = this.receipt(id, j, state);
      if (state !== 'conflict') await durable(receiptPath, receipt);
      results.push(receipt);
    }
    return results;
  }
  recover(authorize: Authorize): Promise<SyncTrashReceipt[]> {
    return withSyncApplyLock(this.root, async () => {
      assertSyncPlainPath(this.directory); if (!fs.existsSync(this.directory)) return [];
      await this.initialize(); return this.recoverUnlocked(authorize);
    });
  }
  /** Protect authenticated retained snapshots for as long as their working bytes remain in trash. */
  pins(authorize: Authorize): Promise<string[]> {
    return withSyncApplyLock(this.root, async () => {
      // A disconnected/unavailable binding is not evidence that its trash is empty.
      assertSyncPlainPath(this.root);
      if (!(await fs.promises.lstat(this.root)).isDirectory()) throw new Error('Sync trash binding is unavailable');
      assertSyncPlainPath(this.directory); if (!fs.existsSync(this.directory)) return [];
      const ids: string[] = [];
      for (const id of await this.ids()) {
        const directory = path.join(this.directory, id); assertSyncPlainPath(directory);
        if (!fs.existsSync(path.join(directory, 'journal.json'))) continue;
        const j = journal(await readSyncApplyRecord(path.join(directory, 'journal.json')));
        if (!authorize(j)) throw new Error('Sync trash revision is not authorized');
        const previous = path.join(directory, 'previous'); assertSyncPlainPath(previous);
        if (fs.existsSync(previous) || fs.existsSync(path.join(directory, 'previous.pruning')) || fs.existsSync(path.join(directory, 'prune.json'))) ids.push(j.baseRevisionId);
      }
      return [...new Set(ids)];
    });
  }
  /** Interrupted cleanup only returns staged bytes; it never resumes deletion on restart. */
  private async recoverPrunesUnlocked(authorize: Authorize, current: () => boolean): Promise<void> {
    const stat = async (file: string) => { try { return await fs.promises.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
    for (const id of await this.ids()) {
      if (!current()) throw new Error('Trash cleanup canceled');
      const directory = path.join(this.directory, id), marker = path.join(directory, 'prune.json');
      try {
        assertSyncPlainPath(directory);
        if (!await stat(marker) && !(await fs.promises.readdir(directory)).some(name => name.startsWith('prune.json.tmp-'))) continue;
        const j = journal(await readSyncApplyRecord(path.join(directory, 'journal.json')));
        if (!authorize(j) || parseSyncTrashReceipt(await readSyncApplyRecord(path.join(directory, 'receipt.json')), j, id).state !== 'deleted') continue;
        await discardSyncRecordTemps(directory, ['prune.json']);
        if (!await stat(marker)) continue;
        const children = await fs.promises.readdir(directory);
        if (children.some(c => !['journal.json', 'receipt.json', 'previous', 'previous.pruning', 'prune.json'].includes(c))) continue;
        const intent = await readSyncApplyRecord(marker) as { v?: number; digest?: string; size?: number };
        if (intent?.v !== 1 || intent.digest !== j.expectedDigest || !Number.isSafeInteger(intent.size) || intent.size! < 0) continue;
        const previous = path.join(directory, 'previous'), staged = path.join(directory, 'previous.pruning');
        const moved = await stat(staged), old = await stat(previous);
        if (!current()) throw new Error('Trash cleanup canceled');
        if (moved) {
          if (!moved.isFile() || moved.isSymbolicLink()) continue;
          if (old) {
            if (!old.isFile() || old.dev !== moved.dev || old.ino !== moved.ino || old.nlink !== 2 || moved.nlink !== 2) continue;
            assertSyncPlainPath(directory); await fs.promises.unlink(staged);
          } else {
            assertSyncPlainPath(staged); await fs.promises.link(staged, previous); await fs.promises.unlink(staged);
          }
        } else if (old) assertSyncPlainPath(previous);
        if (!current()) throw new Error('Trash cleanup canceled');
        assertSyncPlainPath(marker); await fs.promises.unlink(marker);
      } catch { if (!current()) throw new Error('Trash cleanup canceled'); }
    }
  }
  recoverCleanup(authorize: Authorize, current: () => boolean): Promise<void> {
    return withSyncApplyLock(this.root, async () => {
      assertSyncPlainPath(this.root); if (!(await fs.promises.lstat(this.root)).isDirectory()) throw new Error('Sync trash binding is unavailable');
      assertSyncPlainPath(this.directory); if (fs.existsSync(this.directory)) await this.recoverPrunesUnlocked(authorize, current);
    });
  }
  /** A reviewed local digest can abandon an interrupted intent while retaining all its bytes. */
  abandon(relativePath: string, expectedDigest: string | null, authorize: Authorize, current: () => boolean): Promise<void> {
    return withSyncApplyLock(this.root, async () => {
      assertSyncPlainPath(this.directory); if (!fs.existsSync(this.directory)) return;
      for (const id of await this.ids()) {
        const directory = path.join(this.directory, id); assertSyncPlainPath(directory);
        const intent = path.join(directory, 'journal.json'), receipt = path.join(directory, 'receipt.json');
        if (!fs.existsSync(intent) || fs.existsSync(receipt)) continue;
        const j = journal(await readSyncApplyRecord(intent)); if (j.relativePath !== relativePath) continue;
        if (!authorize(j) || !current() || await digest(this.target(relativePath)) !== expectedDigest) throw new Error('Sync deletion resolution changed; review again');
        await durable(receipt, this.receipt(id, j, 'rolled-back'));
      }
    });
  }
  remove(request: SyncTrashJournal, authorize: Authorize, current: () => boolean, onStep?: (step: SyncTrashStep) => Promise<void>): Promise<SyncTrashReceipt> {
    return withSyncApplyLock(this.root, async () => {
      const j = journal(request); await this.initialize();
      const check = () => { if (!current() || !authorize(j)) throw new Error('Sync deletion canceled'); };
      check();
      if ((await this.recoverUnlocked(authorize)).some(r => r.state === 'conflict')) throw new Error('Sync trash recovery required');
      const target = this.target(j.relativePath);
      if (await digest(target) !== j.expectedDigest) throw new Error('Sync local changes since deletion preview');
      await this.capacity((await fs.promises.lstat(target)).size);
      const directory = await fs.promises.mkdtemp(path.join(this.directory, 'op-')), id = path.basename(directory);
      // Before an intent exists this directory contains no user bytes, so a crash is harmless.
      try { await durable(path.join(directory, 'journal.json'), j); }
      catch (error) { await fs.promises.rmdir(directory).catch(() => {}); throw error; }
      await onStep?.('prepared'); check();
      if (await digest(target) !== j.expectedDigest) throw new Error('Sync local changes since deletion preview');
      const previous = path.join(directory, 'previous'); assertSyncPlainPath(previous); this.target(j.relativePath);
      await fs.promises.rename(target, previous); await onStep?.('previous-saved');
      try {
        check();
        if (await digest(previous) !== j.expectedDigest || await digest(target) !== null) throw new Error('Sync local changes during deletion');
        check();
      } catch (error) {
        // A changed policy/head/path owner or a late save must not leave working bytes hidden.
        if (await digest(target) === null && await digest(previous) !== null) {
          this.target(j.relativePath); await fs.promises.link(previous, target); await fs.promises.unlink(previous);
        }
        throw error;
      }
      const receipt = this.receipt(id, j, 'deleted');
      await durable(path.join(directory, 'receipt.json'), receipt); await onStep?.('committed'); return receipt;
    });
  }
}
