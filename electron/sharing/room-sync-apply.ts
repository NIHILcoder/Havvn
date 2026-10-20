/** File-sync spike: durable per-file journal, conservative recovery, no room API yet. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validSyncRelativePath, validSyncMovePaths, SYNC_RECOVERY_OPERATION_LIMIT } from '../../shared/room-file-sync';
import { assertSyncPlainPath, flushSyncFile, syncFileDigest, SYNC_SPIKE_MAX_BYTES } from './room-sync-snapshot';

const DIGEST = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(['applied', 'rolled-back']);
export type SyncApplyStep = 'prepared' | 'previous-saved' | 'published' | 'committed';
export interface SyncApplyRequest {
  relativePath: string;
  fromPath?: string;
  revisionId: string;
  source: string;
  digest: string;
  expectedDigest: string | null; // null explicitly means the destination must be absent.
  isCurrent?: () => boolean;
}
interface Journal {
  v: 1 | 2;
  relativePath: string;
  fromPath?: string;
  revisionId: string;
  digest: string;
  expectedDigest: string | null;
}
export interface SyncApplyReceipt {
  operationId: string;
  revisionId: string;
  relativePath: string;
  digest: string;
  state: 'applied' | 'rolled-back' | 'conflict';
  previousPath?: string;
}

/** Keep Windows-compatible paths on every platform; never normalize unsafe input. */
export function syncRelativePath(value: string): string {
  if (!validSyncRelativePath(value)) throw new Error('Invalid sync relative path');
  return value;
}

async function optionalDigest(candidate: string): Promise<string | null> {
  assertSyncPlainPath(candidate);
  try { return await syncFileDigest(candidate); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // syncFileDigest intentionally hides stat failures; distinguish an absent leaf.
    try { await fs.promises.lstat(candidate); } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw statError;
    }
    throw error;
  }
}

export async function writeSyncRecord(candidate: string, value: unknown): Promise<void> {
  const staged = candidate + '.tmp-' + randomUUID();
  try {
    await fs.promises.writeFile(staged, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await flushSyncFile(staged);
    // Publish only complete records, without replacing an existing decision.
    // A partial receipt after ENOSPC must not mask its recoverable journal.
    await fs.promises.link(staged, candidate);
  } finally {
    await fs.promises.unlink(staged).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

/** Discard only our bounded, non-authoritative staged JSON records after restart. */
export async function discardSyncRecordTemps(directory: string, names: readonly string[] = ['journal.json', 'receipt.json', 'prune.json']): Promise<void> {
  assertSyncPlainPath(directory);
  const children = await fs.promises.readdir(directory);
  if (children.length > SYNC_RECOVERY_OPERATION_LIMIT) throw new Error('Sync record staging capacity reached');
  for (const name of children) {
    const match = /^(journal\.json|receipt\.json|prune\.json)\.tmp-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.exec(name);
    if (!match || !names.includes(match[1])) continue;
    const file = path.join(directory, name); assertSyncPlainPath(file);
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.size > 16 * 1024) throw new Error('Review invalid staged sync record');
    await fs.promises.unlink(file);
  }
}

function parseJournal(raw: unknown): Journal {
  const j = raw as Journal;
  if (!j || (j.v !== 1 && j.v !== 2) || typeof j.relativePath !== 'string' || typeof j.revisionId !== 'string' || !DIGEST.test(j.revisionId)
    || typeof j.digest !== 'string' || !DIGEST.test(j.digest)
    || j.expectedDigest !== null && (typeof j.expectedDigest !== 'string' || !DIGEST.test(j.expectedDigest))) throw new Error('Invalid sync journal');
  syncRelativePath(j.relativePath);
  if (j.v === 1 ? j.fromPath !== undefined : typeof j.fromPath !== 'string' || j.expectedDigest === null || !validSyncMovePaths(j.fromPath, j.relativePath)) throw new Error('Invalid sync move journal');
  return j;
}

async function readRecord(candidate: string): Promise<unknown> {
  assertSyncPlainPath(candidate);
  const stat = await fs.promises.lstat(candidate);
  if (!stat.isFile() || stat.size > 16 * 1024) throw new Error('Invalid sync record size or type');
  return JSON.parse(await fs.promises.readFile(candidate, 'utf8'));
}

function parseReceipt(raw: unknown, j: Journal, id: string): SyncApplyReceipt {
  const receipt = raw as SyncApplyReceipt;
  if (!receipt || !TERMINAL.has(receipt.state) || receipt.revisionId !== j.revisionId
    || receipt.relativePath !== j.relativePath || receipt.digest !== j.digest || receipt.operationId !== id) throw new Error('Invalid sync receipt');
  return receipt;
}

// Serialize even separate instances for the same binding in this process.
const queues = new Map<string, Promise<unknown>>();
export function withSyncApplyLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}
export { parseJournal as parseSyncApplyJournal, parseReceipt as parseSyncApplyReceipt, readRecord as readSyncApplyRecord };
export type { Journal as SyncApplyJournal };

export class RoomSyncApplier {
  readonly root: string;
  private readonly transactions: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.transactions = path.join(this.root, '.havvn-sync', 'transactions');
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    return withSyncApplyLock(this.root, run);
  }

  private async initialize(): Promise<void> {
    assertSyncPlainPath(this.root);
    if (!(await fs.promises.lstat(this.root)).isDirectory()) throw new Error('Sync root is not a directory');
    assertSyncPlainPath(this.transactions);
    await fs.promises.mkdir(this.transactions, { recursive: true });
    assertSyncPlainPath(this.transactions);
  }

  private target(relative: string): string {
    const target = path.join(this.root, ...syncRelativePath(relative).split('/'));
    assertSyncPlainPath(target);
    return target;
  }

  private async operations(): Promise<string[]> {
    const names = await fs.promises.readdir(this.transactions);
    if (names.length > SYNC_RECOVERY_OPERATION_LIMIT) throw new Error('Sync recovery directory capacity reached');
    return names.filter(name => /^op-[a-zA-Z0-9]+$/.test(name)).sort();
  }

  /** onStep is fault injection for the spike; throwing leaves a recoverable journal. */
  apply(request: SyncApplyRequest, onStep?: (step: SyncApplyStep) => void | Promise<void>): Promise<SyncApplyReceipt> {
    return this.serial(async () => {
      const journal = parseJournal({ v: request.fromPath ? 2 : 1, ...(request.fromPath ? { fromPath: request.fromPath } : {}), relativePath: request.relativePath, revisionId: request.revisionId,
        digest: request.digest, expectedDigest: request.expectedDigest });
      const current = () => { if (request.isCurrent && !request.isCurrent()) throw new Error('Sync apply canceled'); };
      current();
      await this.initialize();
      // Never start a second update over an interrupted transaction.
      for (const id of await this.operations()) {
        const dir = path.join(this.transactions, id);
        assertSyncPlainPath(dir);
        if (!fs.existsSync(path.join(dir, 'journal.json'))) continue;
        const prior = parseJournal(await readRecord(path.join(dir, 'journal.json')));
        if (!fs.existsSync(path.join(dir, 'receipt.json'))) throw new Error('Sync recovery required');
        parseReceipt(await readRecord(path.join(dir, 'receipt.json')), prior, id);
      }
      const target = this.target(journal.relativePath);
      const origin = journal.fromPath ? this.target(journal.fromPath) : target;
      const unchanged = async () => await optionalDigest(origin) === journal.expectedDigest && (!journal.fromPath || await optionalDigest(target) === null);
      if (!await unchanged()) throw new Error('Sync local changes or move destination exists');
      assertSyncPlainPath(request.source);
      const size = (await fs.promises.lstat(request.source)).size;
      if (size > SYNC_SPIKE_MAX_BYTES) throw new Error('Sync file is too large');
      const directory = await fs.promises.mkdtemp(path.join(this.transactions, 'op-'));
      const staged = path.join(directory, 'next'), previous = path.join(directory, 'previous');
      let journalWritten = false;
      try {
        await fs.promises.copyFile(request.source, staged, fs.constants.COPYFILE_EXCL);
        if ((await fs.promises.lstat(staged)).size > SYNC_SPIKE_MAX_BYTES) throw new Error('Sync file is too large');
        if (await syncFileDigest(staged) !== journal.digest) throw new Error('Sync content does not match');
        await flushSyncFile(staged);
        // FAT/exFAT and some network volumes cannot publish with no-overwrite links.
        // Discover that before moving an existing working file out of the way.
        const probe = path.join(directory, 'link-probe');
        await fs.promises.link(staged, probe);
        await fs.promises.unlink(probe);
        await writeSyncRecord(path.join(directory, 'journal.json'), journal);
        journalWritten = true;
        await onStep?.('prepared');
        current();
        if (!await unchanged()) throw new Error('Sync local changes or move destination exists');
        assertSyncPlainPath(target);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        this.target(journal.relativePath);
        if (journal.expectedDigest !== null) {
          assertSyncPlainPath(origin); await fs.promises.rename(origin, previous);
          // An editor may have saved after the last check. Preserve its moved bytes.
          if (await optionalDigest(previous) !== journal.expectedDigest) throw new Error('Sync local changes');
        }
        await onStep?.('previous-saved');
        current();
        if (journal.expectedDigest !== null && await optionalDigest(previous) !== journal.expectedDigest) throw new Error('Sync local changes');
        if (journal.fromPath && await optionalDigest(origin) !== null) throw new Error('Sync local changes at move source');
        this.target(journal.relativePath);
        // No-overwrite publication: an editor creating a new file wins this race.
        await fs.promises.link(staged, target);
        await fs.promises.unlink(staged);
        await onStep?.('published');
        if (await optionalDigest(target) !== journal.digest) throw new Error('Sync local changes');
        if (journal.fromPath && await optionalDigest(origin) !== null) throw new Error('Sync local changes at move source');
        const receipt = this.receipt(directory, journal, 'applied');
        await writeSyncRecord(path.join(directory, 'receipt.json'), receipt);
        await onStep?.('committed');
        return receipt;
      } catch (error) {
        if (!journalWritten) await fs.promises.rm(directory, { recursive: true, force: true });
        throw error;
      }
    });
  }

  private receipt(directory: string, j: Journal, state: SyncApplyReceipt['state']): SyncApplyReceipt {
    return { operationId: path.basename(directory), revisionId: j.revisionId, relativePath: j.relativePath, digest: j.digest, state,
      ...(fs.existsSync(path.join(directory, 'previous')) ? { previousPath: path.join(directory, 'previous') } : {}) };
  }

  /** Explicit reviewed resolution can retire an ambiguous intent without touching any of its bytes. */
  abandon(relativePath: string, expectedDigest: string | null,
    authorize: (journal: Readonly<Pick<Journal, 'revisionId' | 'relativePath' | 'digest' | 'fromPath'>>) => boolean, isCurrent: () => boolean): Promise<void> {
    return this.serial(async () => {
      await this.initialize();
      const check = async () => {
        if (!isCurrent()) throw new Error('Sync resolution canceled');
        if (await optionalDigest(this.target(relativePath)) !== expectedDigest) throw new Error('Sync local changes since preview');
      };
      await check();
      for (const id of await this.operations()) {
        const directory = path.join(this.transactions, id); assertSyncPlainPath(directory);
        const journalPath = path.join(directory, 'journal.json'), receiptPath = path.join(directory, 'receipt.json');
        if (!fs.existsSync(journalPath) || fs.existsSync(receiptPath)) continue;
        const journal = parseJournal(await readRecord(journalPath));
        if (journal.relativePath !== relativePath || journal.fromPath) continue; // Moves require both paths to be reviewed.
        if (!authorize(journal)) throw new Error('Sync resolution revision is not authorized');
        await check();
        // "rolled-back" here also covers explicitly abandoned intent. Previous/next remain recoverable.
        await writeSyncRecord(receiptPath, this.receipt(directory, journal, 'rolled-back'));
      }
    });
  }

  recover(authorize?: (journal: Readonly<Pick<Journal, 'revisionId' | 'relativePath' | 'digest' | 'fromPath'>>) => boolean): Promise<SyncApplyReceipt[]> {
    return this.serial(async () => {
      await this.initialize();
      const results: SyncApplyReceipt[] = [];
      for (const id of await this.operations()) {
        const directory = path.join(this.transactions, id);
        assertSyncPlainPath(directory);
        const journalPath = path.join(directory, 'journal.json');
        assertSyncPlainPath(journalPath);
        // A crash before creating the journal cannot have touched the destination.
        if (!fs.existsSync(journalPath)) { await discardSyncRecordTemps(directory, ['journal.json']); continue; }
        const journal = parseJournal(await readRecord(journalPath));
        if (authorize && !authorize({ revisionId: journal.revisionId, relativePath: journal.relativePath, digest: journal.digest, ...(journal.fromPath ? { fromPath: journal.fromPath } : {}) })) {
          throw new Error('Sync recovery revision is not authorized');
        }
        await discardSyncRecordTemps(directory);
        const receiptPath = path.join(directory, 'receipt.json');
        assertSyncPlainPath(receiptPath);
        if (fs.existsSync(receiptPath)) {
          const receipt = parseReceipt(await readRecord(receiptPath), journal, id);
          results.push(this.receipt(directory, journal, receipt.state));
          continue;
        }
        const target = path.join(this.root, ...journal.relativePath.split('/'));
        const origin = journal.fromPath ? path.join(this.root, ...journal.fromPath.split('/')) : target;
        const staged = path.join(directory, 'next'), previous = path.join(directory, 'previous');
        // A process can die between link() and unlink(). Remove only our known link.
        for (const [leaf, linked] of [[target, staged], [origin, previous]]) {
          if (!fs.existsSync(leaf) || !fs.existsSync(linked)) continue;
          const a = await fs.promises.lstat(leaf), b = await fs.promises.lstat(linked);
          if (a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.nlink === 2) {
            // Check all ancestors before mutating a journal-derived location.
            assertSyncPlainPath(path.dirname(leaf));
            assertSyncPlainPath(directory);
            await fs.promises.unlink(linked);
          }
        }
        const actual = await optionalDigest(target), old = await optionalDigest(previous);
        if (journal.fromPath) {
          const original = await optionalDigest(origin);
          let state: SyncApplyReceipt['state'] = 'conflict';
          if (actual === journal.digest && old === journal.expectedDigest && original === null) state = 'applied';
          else if (old === null && original !== null || actual === null && original === journal.expectedDigest && old === journal.expectedDigest) state = 'rolled-back';
          else if (original === null && old !== null && actual !== journal.digest) {
            // The destination may be another editor's file. Restore only the absent source.
            this.target(journal.fromPath); await fs.promises.link(previous, origin); await fs.promises.unlink(previous); state = 'rolled-back';
          }
          const receipt = this.receipt(directory, journal, state);
          if (state !== 'conflict') await writeSyncRecord(receiptPath, receipt);
          results.push(receipt); continue;
        }
        let state: SyncApplyReceipt['state'] = 'conflict';
        if (actual === journal.digest && old === journal.expectedDigest) state = 'applied';
        else if (actual === journal.expectedDigest && (old === null || old === journal.expectedDigest)) state = 'rolled-back';
        else if (actual === null && old !== null) {
          // Even a late editor write to the moved file must be returned to the user.
          this.target(journal.relativePath);
          await fs.promises.link(previous, target);
          await fs.promises.unlink(previous);
          state = 'rolled-back';
        }
        const receipt = this.receipt(directory, journal, state);
        if (state !== 'conflict') await writeSyncRecord(receiptPath, receipt);
        results.push(receipt);
      }
      return results;
    });
  }
}
