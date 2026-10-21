/** Trusted main-process coordinator. Transport may fetch bytes, but never grants disk authority. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RoomFile } from '../../shared/types';
import { canWriteSync, syncWriters, SYNC_CHECKPOINT_HEAD_LIMIT, validSyncRelativePath, validSyncMovePaths, syncPreviousPaths, type SyncIndexContext, type SyncRevision, type SyncPolicy } from '../../shared/room-file-sync';
import { SYNC_CHECKPOINT_ARCHIVES, syncLogCommitment, type SyncMetadataPlan } from '../db/room-sync-store';
import { syncRecordFitsTransport } from '../../shared/room-file-sync-protocol';
import type { RoomSyncStore } from '../db/room-sync-store';
import { deriveMemberId } from './room-crypto';
import { contentKeyEpoch } from './room-keyring';
import { signSyncPolicy, signSyncRevision } from './room-sync-proofs';
import { prepareSyncSnapshot, assertSyncPlainPath, syncFileDigest, flushSyncFile, type SyncSnapshot } from './room-sync-snapshot';
import { syncWorkQueue, syncWorkCanceled, type SyncWorkPriority } from './room-sync-work';
import { RoomSyncApplier, type SyncApplyReceipt } from './room-sync-apply';
import { roomDiskName, verifyRoomFile } from './room-file-storage';
import { decryptFile } from './room-e2e';
import { manageSyncCache } from './room-sync-cache';
import { excludedSyncPath } from './room-sync-watcher';
import { SYNC_DIFF_BYTES, syncTextDiff } from '../../shared/room-file-sync-diff';
import type { SyncConflictChoice, SyncConflictPreview } from '../../shared/room-file-sync-ui';
import type { SyncBackupPolicy } from '../../shared/room-file-sync-backups';
import { previewSyncBackups, confirmSyncBackups, recoverSyncBackupPrunes, type SyncBackupPlan } from './room-sync-backups';
import { syncEditorLanguage } from '../../shared/room-file-sync-editor';
import { readSyncEditorFile, encodeSyncEditorFile } from './room-sync-editor';
import { authorizedSyncApplyJournal, authorizedSyncTrashJournal } from './room-sync-apply-auth';
import { RoomSyncTrash } from './room-sync-trash';
import { previewSyncTrash, confirmSyncTrash, syncTrashIdentity, type SyncTrashPlan, type SyncTrashRetentionOptions } from './room-sync-trash-retention';
import { exportSyncTrash, verifySyncTrashExport, syncTrashExportCurrent } from './room-sync-trash-export';
import { withMetadataRecovery, metadataRecoveryValid } from './room-sync-metadata';
import { sealRoomBackup, openRoomBackup } from '../db/room-backup';
export interface SyncRestoreGuard { revisionId: string; head: string; policyId: string; bindingEpoch: number; path: string; digest: string | null; targetPath?: string; sourcePath?: string }
export interface SyncMoveGuard extends SyncRestoreGuard { entryId: string; fromPath: string; toPath: string; digest: string }
export interface SyncPathGuard extends SyncRestoreGuard { entryId: string; toPath: string; stamp: string }
export interface SyncConflictGuard extends SyncRestoreGuard { copyPath: string }
export interface SyncEditorGuard extends SyncRestoreGuard { entryId: string; base: string | null; newline: 'lf' | 'crlf'; bom: boolean; writable: boolean }
export interface SyncDeleteGuard extends SyncRestoreGuard { entryId: string; baseRevisionId: string; mode: 'publish' | 'apply'; copyPath: string; localSize: number }
export interface SyncCheckpointPlan { stamp: string; policy: SyncPolicy; records: number; archives: number }

export interface SyncSessionOptions {
  context: SyncIndexContext;
  store: RoomSyncStore;
  storage: string;
  identity: { pub: string; priv: string };
  isCurrent: () => boolean;
  contentSecret?: () => string;
  resolveSecret?: (epoch: string) => string | undefined;
  cachePins?: () => string[];
}

/** The only bridge from signed revision content to the existing torrent verifier. */
export function syncRevisionFile(revision: SyncRevision): RoomFile {
  const b = revision.blob;
  if (!b || revision.op !== 'put') throw new Error('Sync revision has no content');
  return { fileId: b.infoHash, infoHash: b.infoHash, name: b.name, size: b.size,
    magnetURI: `magnet:?xt=urn:btih:${b.infoHash}`, addedBy: revision.authorId, addedByName: '', addedAt: revision.createdAt,
    ...(b.enc ? { enc: true, keyEpoch: b.keyEpoch! } : {}) };
}

export class RoomSyncSession {
  private readonly self: string;
  private queue: Promise<unknown> = Promise.resolve();
  private workEpoch = 0;
  private operationEpoch = 0;
  private workTasks = new Set<Promise<unknown>>();

  constructor(private readonly options: SyncSessionOptions) { this.self = deriveMemberId(options.identity.pub); }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const epoch = this.workEpoch;
    const next = this.queue.catch(() => {}).then(() => { if (epoch !== this.workEpoch) throw syncWorkCanceled(); this.operationEpoch = epoch; return run(); }); this.queue = next; return next;
  }
  workView() { return syncWorkQueue.view(this); }
  async cancelWork(): Promise<void> {
    const tasks = [...this.workTasks];
    this.workEpoch++; syncWorkQueue.cancel(this);
    const results = await Promise.allSettled([...tasks, this.queue]);
    for (const result of results.slice(0, tasks.length)) {
      if (result.status === 'rejected' && (!(result.reason instanceof Error) || result.reason.message !== 'Sync preparation canceled')) throw result.reason;
    }
  }
  private snapshot(options: Parameters<typeof prepareSyncSnapshot>[0], priority: SyncWorkPriority = 'interactive') {
    const epoch = this.operationEpoch;
    const task = prepareSyncSnapshot({ ...options, work: { owner: this, priority },
      isCurrent: () => epoch === this.workEpoch && this.options.isCurrent() && (options.isCurrent?.() ?? true) });
    this.workTasks.add(task);
    void task.finally(() => this.workTasks.delete(task)).catch(() => {});
    return task;
  }
  private current(): void { if (!this.options.isCurrent()) throw new Error('Sync session canceled'); }
  private checkpointStamp(): string { const store = this.options.store; return JSON.stringify([store.logGeneration(), store.policy()?.policyId, store.heads(), store.retiredCount()]); }
  prepareCheckpoint(): Promise<SyncCheckpointPlan> {
    return this.serial(async () => {
      this.current(); if ((await this.recoverBinding()).some(r => r.state === 'conflict')) throw new Error('Review interrupted disk operations before checkpointing');
      const { store, context, identity } = this.options, policy = store.policy();
      if (!policy || this.self !== context.ownerId) throw new Error('Only the owner can checkpoint a sync root');
      if (store.retiredCount() >= SYNC_CHECKPOINT_ARCHIVES) throw new Error('Sync checkpoint archive capacity reached');
      const records = store.records(), baseHeads = store.heads().flatMap(h => h.revisionIds.map(revisionId => ({ entryId: h.entryId, revisionId })));
      if (baseHeads.length > SYNC_CHECKPOINT_HEAD_LIMIT) throw new Error('Checkpoint head capacity reached; at most 2000 heads are supported');
      const previous = store.checkpoint();
      const origins = store.historicalPaths(baseHeads.map(h => h.entryId));
      const body = { writers: [...new Set([context.ownerId, ...syncWriters(policy)])].sort(), rootId: context.rootId,
        epoch: policy.epoch + 1, parentPolicyId: policy.policyId, ownerId: context.ownerId, publisherId: context.ownerId,
        name: policy.name, allowDeletes: policy.allowDeletes, baseHeads, pub: identity.pub,
        checkpoint: { generation: (previous?.checkpoint?.generation ?? 0) + 1, parentCheckpointId: previous?.policyId ?? null,
          archiveDigest: syncLogCommitment(records), archiveRecords: records.length, anchors: baseHeads.map(h => store.revision(h.revisionId)!),
          origins } };
      let next = signSyncPolicy(context.scope, { ...body, v: policy.v === 6 ? 6 : policy.v === 5 || baseHeads.length > 64 ? 5 : 4 }, identity.priv);
      if (next.v === 4 && !syncRecordFitsTransport({ kind: 'policy', value: next })) next = signSyncPolicy(context.scope, { ...body, v: 5 }, identity.priv);
      if (!syncRecordFitsTransport({ kind: 'policy', value: next })) throw new Error('Checkpoint exceeds multipart capacity');
      return { stamp: this.checkpointStamp(), policy: next, records: records.length, archives: store.retiredCount() };
    });
  }
  confirmCheckpoint(plan: SyncCheckpointPlan): Promise<void> {
    return this.serial(async () => {
      this.current(); if (this.self !== this.options.context.ownerId || plan.stamp !== this.checkpointStamp()) throw new Error('Sync checkpoint changed; review again');
      this.options.store.acceptPolicy(plan.policy, true);
    });
  }
  updateExclusions(rules: string[], review: () => Promise<void>): Promise<void> {
    return this.serial(async () => { this.current(); await review(); this.current(); this.options.store.setExclusions(rules); });
  }
  backupPreview(policy: SyncBackupPolicy = this.options.store.backupPolicy()): Promise<SyncBackupPlan> {
    return this.serial(() => previewSyncBackups(this.options.store, policy, this.options.isCurrent));
  }
  backupConfirm(plan: SyncBackupPlan) {
    return this.serial(() => confirmSyncBackups(this.options.store, plan, this.options.isCurrent));
  }
  private trashReplicaIdentity(revisionId: string): string | null {
    const source = this.options.store.sources().find(s => s.revisionId === revisionId); if (!source) return null;
    const relative = path.relative(path.resolve(this.options.storage), path.resolve(source.path));
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
    assertSyncPlainPath(source.path); const stat = fs.lstatSync(source.path);
    if (!stat.isFile() || stat.nlink !== 1) return null;
    return crypto.createHash('sha256').update(JSON.stringify([source, syncTrashIdentity(stat)])).digest('hex');
  }
  private trashRetentionOptions(): SyncTrashRetentionOptions {
    return {
      current: this.options.isCurrent, pins: () => this.options.cachePins?.() ?? [],
      replicaCurrent: replica => { try {
        if (replica.exported) return replica.exported.folder === this.options.store.binding()?.path
          && this.options.store.trashExports().some(r => JSON.stringify(r) === JSON.stringify(replica.exported)) && syncTrashExportCurrent(replica.exported);
        return this.trashReplicaIdentity(replica.revisionId) === replica.identity;
      } catch { return false; } },
      exported: async (operationId, journal, size) => {
        const receipt = this.options.store.trashExports().find(r => r.folder === this.options.store.binding()?.path && r.operationId === operationId
          && r.revisionId === journal.revisionId && r.digest === journal.expectedDigest && r.size === size);
        if (!receipt || !await verifySyncTrashExport(receipt)) return null; this.current(); return receipt;
      },
      replica: async (revisionId, expected) => {
        const revision = this.options.store.revision(revisionId), before = this.trashReplicaIdentity(revisionId);
        if (!revision || !before) return null;
        const actual = await this.historical(revision, plaintext => syncFileDigest(plaintext));
        this.current(); if (this.trashReplicaIdentity(revisionId) !== before) return null;
        return actual === expected ? before : '';
      },
    };
  }
  trashPreview(selected: string[] = []): Promise<SyncTrashPlan> {
    return this.serial(async () => { this.current(); return previewSyncTrash(this.options.store, selected, this.trashRetentionOptions()); });
  }
  trashConfirm(plan: SyncTrashPlan) {
    return this.serial(async () => {
      this.current(); const result = await confirmSyncTrash(this.options.store, plan, this.trashRetentionOptions());
      if (result.removedCopies) {
        try { this.options.store.forgetTrashExports(plan.folder, plan.selected.slice(0, result.removedCopies).map(c => c.operationId)); }
        catch { result.error ||= 'Trash export receipt cleanup failed'; }
      }
      return result;
    });
  }
  exportTrash(plan: SyncTrashPlan, operationId: string, target: string, forbidden: string[]) {
    return this.serial(async () => { this.current(); return exportSyncTrash(this.options.store, plan, operationId, target, this.trashRetentionOptions(), [...forbidden, this.options.storage]); });
  }
  logPreview() { return this.serial(async () => { this.current(); return this.options.store.prepareLogCompaction(); }); }
  compactLog(plan: ReturnType<RoomSyncStore['prepareLogCompaction']>) {
    return this.serial(async () => { this.current(); return this.options.store.compactLog(plan); });
  }
  exportMetadata(password: string) {
    return this.serial(async () => {
      this.current(); const bundle = this.options.store.metadataBundle(), stamp = this.options.store.metadataHistoryStamp();
      const ciphertext = await sealRoomBackup(bundle, password); this.current(); return { ciphertext, stamp };
    });
  }
  importMetadata(ciphertext: string, password: string) {
    return this.serial(async () => {
      this.current(); const bundle = await openRoomBackup(ciphertext, password); this.current(); return this.options.store.importMetadata(bundle);
    });
  }
  prepareMetadata(keep: number): Promise<{ plan: SyncMetadataPlan; recoveryStamp: string }> {
    return this.serial(() => withMetadataRecovery(this.options.store, async proofs => {
      this.current(); const plan = this.options.store.prepareMetadata(keep, candidate => metadataRecoveryValid(candidate, proofs), this.options.cachePins?.());
      return { plan, recoveryStamp: proofs.stamp };
    }));
  }
  confirmMetadata(plan: SyncMetadataPlan, recoveryStamp: string): Promise<void> {
    return this.serial(() => withMetadataRecovery(this.options.store, async proofs => {
      this.current(); if (proofs.stamp !== recoveryStamp) throw new Error('Sync recovery changed; review metadata cleanup again');
      this.options.store.confirmMetadata(plan, candidate => metadataRecoveryValid(candidate, proofs), this.options.cachePins?.());
    }));
  }
  cache(release: (hash: string) => Promise<boolean>, trim = false) {
    return this.serial(async () => {
      const initial = this.options.store.logGeneration();
      const pinned = this.options.cachePins?.() ?? [], pinStamp = JSON.stringify(pinned), store = this.options.store;
      const binding = store.binding(), epoch = store.bindingEpoch();
      const trashPins = binding ? await new RoomSyncTrash(binding.path).pins(j => authorizedSyncTrashJournal(store, j)) : [];
      return manageSyncCache(this.options.storage, store, release, () => this.options.isCurrent() && store.logGeneration() === initial && store.bindingEpoch() === epoch
        && JSON.stringify(this.options.cachePins?.() ?? []) === pinStamp, trim, [...pinned, ...trashPins]);
    });
  }

  private restoreContext(revisionId: string) {
    this.current();
    const { store } = this.options, revision = store.revision(revisionId), binding = store.binding(), policy = store.policy();
    const heads = revision && store.heads().find(h => h.entryId === revision.entryId)?.revisionIds;
    if (!revision || revision.op !== 'put' || !binding || !policy || !canWriteSync(policy, this.self) || !heads?.length || heads.length > (policy.v >= 2 ? 64 : 1)
      || policy.v < 3 && store.revision(heads[0])?.relativePath !== revision.relativePath || excludedSyncPath(revision.relativePath, store.exclusions())
      || store.pathConflicts().some(c => c.entryIds.includes(revision.entryId))) throw new Error('A publisher binding without conflicts is required to restore');
    const paths = [...new Set(heads.map(id => store.revision(id)!.relativePath))];
    if (paths.length > 1 && !heads.includes(revisionId)) throw new Error('Choose a current branch to resolve a move conflict');
    const targetPath = paths.length === 1 ? paths[0] : revision.relativePath;
    const applied = store.applied().find(a => a.entryId === revision.entryId);
    const sourcePath = applied ? store.revision(applied.revisionId)!.relativePath : targetPath;
    if (sourcePath !== targetPath && !validSyncMovePaths(sourcePath, targetPath)) throw new Error('Invalid or overlapping sync restore move path');
    if (excludedSyncPath(targetPath, store.exclusions()) || excludedSyncPath(sourcePath, store.exclusions())) throw new Error('Sync path excluded');
    return { revision, binding, policy, head: heads.join(','), targetPath, sourcePath };
  }
  private async localDigest(file: string): Promise<string | null> {
    assertSyncPlainPath(file);
    try { await fs.promises.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    return syncFileDigest(file);
  }
  retainHistorical(revisionId: string, downloaded: string, metadata: Buffer, purpose: 'restore' | 'conflict' | 'path' = 'restore'): Promise<void> {
    return this.serial(async () => {
      const authorize = () => purpose === 'restore' ? this.restoreContext(revisionId) : purpose === 'path' ? this.pathContext(revisionId) : this.conflictContext(revisionId);
      authorize();
      assertSyncPlainPath(downloaded); assertSyncPlainPath(this.options.storage);
      await fs.promises.mkdir(this.options.storage, { recursive: true }); assertSyncPlainPath(this.options.storage);
      const directory = await fs.promises.mkdtemp(path.join(this.options.storage, 'received-'));
      const file = syncRevisionFile(this.options.store.revision(revisionId)!);
      const payload = path.join(directory, roomDiskName(file)); let retain = false;
      try {
        await fs.promises.copyFile(downloaded, payload, fs.constants.COPYFILE_EXCL);
        await verifyRoomFile(payload, file, metadata); authorize();
        retain = true; this.options.store.retainSource(revisionId, { path: payload, metadata: metadata.toString('base64') });
      } finally { if (!retain) await fs.promises.rm(directory, { recursive: true, force: true }); }
    });
  }
  private conflictContext(revisionId: string) {
    this.current();
    const { store } = this.options, revision = store.revision(revisionId), binding = store.binding(), policy = store.policy();
    const heads = revision && store.heads().find(h => h.entryId === revision.entryId)?.revisionIds;
    if (!revision || revision.op !== 'put' || !binding || !policy || policy.v === 1 && policy.publisherId === this.self || heads?.length !== 1 || heads[0] !== revisionId
      || excludedSyncPath(revision.relativePath, store.exclusions()) || store.pathConflicts().some(c => c.entryIds.includes(revision.entryId))) throw new Error('A receiver binding with one unambiguous head is required');
    const applied = store.applied().find(a => a.entryId === revision.entryId);
    if (applied && store.revision(applied.revisionId)?.relativePath !== revision.relativePath) throw new Error('Move conflict requires both paths to be reviewed');
    return { revision, binding, policy };
  }
  prepareConflict(revisionId: string): Promise<{ guard: SyncConflictGuard; view: Omit<SyncConflictPreview, 'previewId' | 'rootId'> }> {
    return this.serial(async () => {
      const { revision, binding, policy } = this.conflictContext(revisionId), { store } = this.options;
      if ((await this.recoverBinding()).some(r => r.state === 'conflict' && r.relativePath !== revision.relativePath)) throw new Error('Sync recovery requires manual inspection');
      const target = path.join(binding.path, ...revision.relativePath.split('/'));
      const digest = await this.localDigest(target);
      const stat = digest === null ? null : await fs.promises.lstat(target);
      const copyPath = `.havvn-local/copy-${crypto.randomBytes(8).toString('hex')}/${revision.blob!.name}`;
      const guard: SyncConflictGuard = { revisionId, head: revisionId, policyId: policy.policyId, bindingEpoch: store.bindingEpoch(), path: binding.path, digest, copyPath };
      const diff = await this.historical(revision, async plaintext => {
        if ((stat?.size ?? 0) > SYNC_DIFF_BYTES || (await fs.promises.lstat(plaintext)).size > SYNC_DIFF_BYTES) return { kind: 'unavailable' as const, reason: 'large' as const };
        const local = stat ? await fs.promises.readFile(target) : Buffer.alloc(0);
        if (stat && crypto.createHash('sha256').update(local).digest('hex') !== digest) throw new Error('Sync local changes during preview; review again');
        return syncTextDiff(local, await fs.promises.readFile(plaintext), revision.relativePath);
      });
      this.conflictContext(revisionId);
      if (store.bindingEpoch() !== guard.bindingEpoch || store.policy()?.policyId !== guard.policyId || await this.localDigest(target) !== digest) throw new Error('Sync conflict preview changed; review again');
      return { guard, view: { entryId: revision.entryId, path: revision.relativePath, revisionId, createdAt: revision.createdAt,
        local: { exists: !!stat, size: stat?.size ?? 0, modifiedAt: stat?.mtimeMs ?? null }, incomingSize: revision.blob!.size, copyPath, diff } };
    });
  }
  resolveConflict(guard: SyncConflictGuard, choice: SyncConflictChoice): Promise<{ copyPath: string | null }> {
    return this.serial(async () => {
      if (!['accept', 'keep-both'].includes(choice)) throw new Error('Invalid sync conflict choice');
      const { revision, binding } = this.conflictContext(guard.revisionId), { store } = this.options;
      const valid = () => this.options.isCurrent() && store.bindingEpoch() === guard.bindingEpoch && store.binding()?.path === guard.path
        && store.policy()?.policyId === guard.policyId && store.heads().find(h => h.entryId === revision.entryId)?.revisionIds.join(',') === guard.head
        && !store.pathConflicts().some(c => c.entryIds.includes(revision.entryId));
      if (!valid()) throw new Error('Sync conflict preview changed; review again');
      const target = path.join(binding.path, ...revision.relativePath.split('/'));
      if (await this.localDigest(target) !== guard.digest || !valid()) throw new Error('Sync local changes since preview; review again');
      return this.historical(revision, async plaintext => {
        const digest = await syncFileDigest(plaintext);
        let copyPath: string | null = null;
        if (choice === 'keep-both') {
          if (guard.digest === null || !/^\.havvn-local\/copy-[a-f0-9]{16}\/$/.test(guard.copyPath.slice(0, guard.copyPath.lastIndexOf('/') + 1))
            || guard.copyPath.split('/').at(-1) !== revision.blob!.name) throw new Error('Invalid local conflict copy');
          if (!valid()) throw new Error('Sync conflict preview changed; review again');
          const base = path.join(binding.path, '.havvn-local'); assertSyncPlainPath(base);
          await fs.promises.mkdir(base, { recursive: true }); assertSyncPlainPath(base);
          const directory = path.join(base, guard.copyPath.split('/')[1]);
          await fs.promises.mkdir(directory); assertSyncPlainPath(directory);
          const copy = path.join(directory, revision.blob!.name);
          if (!valid()) throw new Error('Sync conflict preview changed; review again');
          // Keep the copy even on later failure. It can contain an editor's late save.
          await fs.promises.copyFile(target, copy, fs.constants.COPYFILE_EXCL); assertSyncPlainPath(copy);
          if (await syncFileDigest(copy) !== guard.digest) throw new Error('Sync local changes during conflict copy; review again');
          await flushSyncFile(copy); copyPath = guard.copyPath;
        }
        if (await this.localDigest(target) !== guard.digest || !valid()) throw new Error('Sync local changes since preview; review again');
        const applier = new RoomSyncApplier(binding.path);
        await applier.abandon(revision.relativePath, guard.digest, journal => {
          const verified = store.revision(journal.revisionId);
          return verified?.entryId === revision.entryId && authorizedSyncApplyJournal(store, journal);
        }, valid);
        await applier.apply({ source: plaintext, relativePath: revision.relativePath, revisionId: revision.revisionId,
          digest, expectedDigest: guard.digest, isCurrent: valid });
        // The completed receipt remains a valid local base if a newer head arrived after publication.
        this.current(); if (store.bindingEpoch() !== guard.bindingEpoch || store.binding()?.path !== binding.path) throw new Error('Sync conflict binding changed after publication');
        store.markApplied(revision.entryId, revision.revisionId, digest, true);
        return { copyPath };
      });
    });
  }
  private async historical<T>(revision: SyncRevision, run: (plaintext: string) => Promise<T>): Promise<T> {
    const source = this.options.store.sources().find(s => s.revisionId === revision.revisionId);
    if (!source) throw new Error('Sync version content unavailable');
    const relative = path.relative(path.resolve(this.options.storage), path.resolve(source.path));
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('Sync source outside storage');
    assertSyncPlainPath(source.path); assertSyncPlainPath(this.options.storage);
    const directory = await fs.promises.mkdtemp(path.join(this.options.storage, 'received-'));
    const file = syncRevisionFile(revision), metadata = Buffer.from(source.metadata, 'base64');
    try {
      const payload = path.join(directory, roomDiskName(file));
      await fs.promises.copyFile(source.path, payload, fs.constants.COPYFILE_EXCL);
      await verifyRoomFile(payload, file, metadata); this.current();
      let plaintext = payload;
      if (file.enc) {
        const secret = this.options.resolveSecret?.(file.keyEpoch!) ?? this.options.contentSecret?.();
        if (!secret || contentKeyEpoch(secret) !== file.keyEpoch) throw new Error('Sync content key unavailable');
        plaintext = path.join(directory, file.name);
        await decryptFile(payload, plaintext, secret, { expectedSize: file.size, isCurrent: this.options.isCurrent });
      }
      return await run(plaintext);
    } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
  }
  prepareRestore(revisionId: string): Promise<SyncRestoreGuard> {
    return this.serial(async () => {
      if ((await this.recoverBinding()).some(r => r.state === 'conflict')) throw new Error('Sync recovery requires manual inspection before restoring');
      const { revision, binding, policy, head, targetPath, sourcePath } = this.restoreContext(revisionId);
      if (sourcePath !== targetPath && await this.localDigest(path.join(binding.path, ...targetPath.split('/'))) !== null) throw new Error('Sync move destination exists; preserve it before restoring');
      const guard: SyncRestoreGuard = { revisionId, head, policyId: policy.policyId, bindingEpoch: this.options.store.bindingEpoch(),
        path: binding.path, digest: await this.localDigest(path.join(binding.path, ...sourcePath.split('/'))), ...(policy.v >= 3 ? { targetPath, sourcePath } : {}) };
      if (sourcePath !== targetPath && guard.digest === null) throw new Error('Sync move source is absent; recover the binding before restoring');
      await this.historical(revision, async () => {});
      if (this.restoreContext(revisionId).head !== head || this.options.store.bindingEpoch() !== guard.bindingEpoch) throw new Error('Sync restore context changed');
      return guard;
    });
  }
  restoreRevision(guard: SyncRestoreGuard): Promise<{ revision: SyncRevision; snapshot: SyncSnapshot }> {
    return this.serial(async () => {
      const { revision: selected, binding, policy, head, targetPath, sourcePath } = this.restoreContext(guard.revisionId);
      const { store, context, identity } = this.options;
      const valid = () => this.options.isCurrent() && store.bindingEpoch() === guard.bindingEpoch && store.binding()?.path === guard.path
        && store.policy()?.policyId === guard.policyId && store.heads().find(h => h.entryId === selected.entryId)?.revisionIds.join(',') === guard.head;
      if (head !== guard.head || policy.policyId !== guard.policyId || binding.path !== guard.path || !valid()
        || policy.v >= 3 && (targetPath !== guard.targetPath || sourcePath !== guard.sourcePath)) throw new Error('Sync restore preview changed; review again');
      return this.historical(selected, async plaintext => {
        const digest = await syncFileDigest(plaintext);
        const target = path.join(binding.path, ...sourcePath.split('/'));
        const destinationFree = async () => sourcePath === targetPath || await this.localDigest(path.join(binding.path, ...targetPath.split('/'))) === null;
        if (!await destinationFree()) throw new Error('Sync move destination changed; review again');
        if (await this.localDigest(target) !== guard.digest || !valid()) throw new Error('Sync local changes since preview; review again');
        const secret = context.e2e ? this.options.contentSecret?.() : undefined;
        if (context.e2e && !secret) throw new Error('Sync content key unavailable');
        const snapshot = await this.snapshot({ source: plaintext, name: targetPath.split('/').at(-1), storage: this.options.storage, authorId: this.self, secret, isCurrent: valid });
        if (await this.localDigest(target) !== guard.digest || !valid() || !await destinationFree()) { await fs.promises.rm(snapshot.directory, { recursive: true, force: true }); throw new Error('Sync local changes since preview; review again'); }
        const revision = signSyncRevision(context.scope, { v: policy.v, rootId: context.rootId, policyId: policy.policyId,
          entryId: selected.entryId, parents: head.split(','), relativePath: targetPath, ...(policy.v >= 3 ? syncPreviousPaths(targetPath, head.split(',').map(id => store.revision(id)!)) : {}), op: 'put',
          blob: { infoHash: snapshot.file.infoHash, name: snapshot.file.name, size: snapshot.file.size, enc: !!snapshot.file.enc, keyEpoch: snapshot.file.keyEpoch ?? null },
          authorId: this.self, createdAt: Date.now(), pub: identity.pub }, identity.priv);
        // Persist the signed intent before the journal so crash recovery can authenticate it.
        store.acceptRevision(revision, true, undefined, { path: snapshot.sourcePath, metadata: snapshot.metadata.toString('base64') });
        await new RoomSyncApplier(binding.path).apply({ source: plaintext, relativePath: revision.relativePath, revisionId: revision.revisionId,
          ...(sourcePath !== targetPath ? { fromPath: sourcePath } : {}), digest, expectedDigest: guard.digest,
          isCurrent: () => this.options.isCurrent() && store.bindingEpoch() === guard.bindingEpoch && store.binding()?.path === binding.path && store.policy()?.policyId === guard.policyId });
        this.current(); if (store.bindingEpoch() !== guard.bindingEpoch) throw new Error('Sync restore binding changed');
        store.markApplied(revision.entryId, revision.revisionId, digest, true);
        return { revision, snapshot };
      });
    });
  }

  createRoot(name: string, allowDeletes = false): void {
    this.current();
    const { context, identity, store } = this.options;
    if (context.ownerId !== this.self || store.policy()) throw new Error('Only the owner can initialize a new sync root');
    store.acceptPolicy(signSyncPolicy(context.scope, { v: 1, rootId: context.rootId, epoch: 1, parentPolicyId: null,
      ownerId: context.ownerId, publisherId: this.self, name, allowDeletes, baseHeads: [], pub: identity.pub }, identity.priv), true);
  }
  rightsStamp(): string { const store = this.options.store; return JSON.stringify([store.policy()?.policyId, store.heads()]); }
  private pathContext(revisionId: string) {
    this.current(); const { store } = this.options, revision = store.revision(revisionId), policy = store.policy(), binding = store.binding();
    const heads = revision && store.heads().find(h => h.entryId === revision.entryId)?.revisionIds;
    const applied = revision && store.applied().find(a => a.entryId === revision.entryId);
    if (!revision || revision.op !== 'put' || !policy || policy.v < 3 || !canWriteSync(policy, this.self) || !binding
      || !heads?.includes(revisionId) || heads.length > 64 || excludedSyncPath(revision.relativePath, store.exclusions())
      || !(heads.length > 1 || store.pathConflicts().some(c => c.entryIds.includes(revision.entryId))
        || applied?.revisionId !== revisionId)) throw new Error('A bound writer with a current path conflict is required');
    return { revision, policy, binding, heads, applied };
  }
  private pathStamp(): string { return JSON.stringify([this.options.store.policy()?.policyId, this.options.store.heads(), this.options.store.applied(), this.options.store.exclusions(), this.options.store.deferred()]); }
  private pathDestination(entryId: string, toPath: string, heads: string[]): void {
    const { store } = this.options;
    if (!validSyncRelativePath(toPath) || excludedSyncPath(toPath, store.exclusions()) || heads.some(id => !validSyncMovePaths(store.revision(id)!.relativePath, toPath))
      || !this.deletionPathAvailable(entryId, toPath)) throw new Error('Choose a free, included path outside the conflicting paths');
  }
  private async pathAbsent(target: string): Promise<boolean> {
    assertSyncPlainPath(target);
    try { await fs.promises.lstat(target); return false; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return true;
      if (code === 'ENOTDIR') return false;
      throw error;
    }
  }
  preparePathResolution(revisionId: string, toPath: string): Promise<SyncPathGuard> {
    return this.serial(async () => {
      if ((await this.recoverBinding()).some(r => r.state === 'conflict')) throw new Error('Review interrupted disk operations before resolving paths');
      const { revision, policy, binding, heads } = this.pathContext(revisionId), epoch = this.options.store.bindingEpoch(), stamp = this.pathStamp();
      this.pathDestination(revision.entryId, toPath, heads);
      if (!await this.pathAbsent(path.join(binding.path, ...toPath.split('/')))) throw new Error('Sync destination already exists');
      // Verify the retained, authenticated version before offering a confirmation.
      await this.historical(revision, async () => {});
      this.pathContext(revisionId);
      if (this.pathStamp() !== stamp || this.options.store.bindingEpoch() !== epoch) throw new Error('Sync path preview changed; review again');
      return { entryId: revision.entryId, revisionId, head: heads.join(','), policyId: policy.policyId, bindingEpoch: epoch, path: binding.path, digest: null, toPath, stamp };
    });
  }
  resolvePath(guard: SyncPathGuard): Promise<{ revision: SyncRevision; snapshot: SyncSnapshot }> {
    return this.serial(async () => {
      const { revision: selected, policy, binding, heads, applied } = this.pathContext(guard.revisionId), { store, context, identity } = this.options;
      const valid = () => this.options.isCurrent() && store.bindingEpoch() === guard.bindingEpoch && store.binding()?.path === guard.path
        && store.policy()?.policyId === guard.policyId && canWriteSync(store.policy(), this.self);
      if (!valid() || guard.entryId !== selected.entryId || guard.stamp !== this.pathStamp() || guard.head !== heads.join(',')) throw new Error('Sync path preview changed; review again');
      this.pathDestination(selected.entryId, guard.toPath, heads);
      const target = path.join(binding.path, ...guard.toPath.split('/'));
      if (!await this.pathAbsent(target)) throw new Error('Sync destination already exists');
      return this.historical(selected, async plaintext => {
        const secret = context.e2e ? this.options.contentSecret?.() : undefined;
        if (context.e2e && !secret) throw new Error('Sync content key unavailable');
        const snapshot = await this.snapshot({ source: plaintext, name: guard.toPath.split('/').at(-1), storage: this.options.storage, authorId: this.self, secret, isCurrent: valid });
        if (!valid() || guard.stamp !== this.pathStamp() || !await this.pathAbsent(target)) {
          await fs.promises.rm(snapshot.directory, { recursive: true, force: true }); throw new Error('Sync path preview changed; review again');
        }
        // Source bytes stay on disk. Other entries that could inherit those bytes must
        // be reviewed before a watcher can publish them as a different document.
        const origin = applied && store.revision(applied.revisionId)?.relativePath;
        if (origin) this.deferPathOwners(selected.entryId, origin);
        const revision = signSyncRevision(context.scope, { v: policy.v, rootId: context.rootId, policyId: policy.policyId, entryId: selected.entryId,
          parents: heads, relativePath: guard.toPath, previousPaths: [...new Set(heads.map(id => store.revision(id)!.relativePath))].sort(), op: 'put',
          blob: { infoHash: snapshot.file.infoHash, name: snapshot.file.name, size: snapshot.file.size, enc: !!snapshot.file.enc, keyEpoch: snapshot.file.keyEpoch ?? null },
          authorId: this.self, createdAt: Date.now(), pub: identity.pub }, identity.priv);
        store.acceptRevision(revision, true, undefined, { path: snapshot.sourcePath, metadata: snapshot.metadata.toString('base64') });
        await new RoomSyncApplier(binding.path).apply({ source: plaintext, relativePath: guard.toPath, revisionId: revision.revisionId, digest: snapshot.plaintextDigest,
          expectedDigest: null, isCurrent: () => valid() && store.heads().find(h => h.entryId === selected.entryId)?.revisionIds.join(',') === revision.revisionId && this.deletionPathAvailable(selected.entryId, guard.toPath) });
        if (!valid()) throw new Error('Sync path binding changed; recover the binding');
        store.markApplied(selected.entryId, revision.revisionId, snapshot.plaintextDigest, true);
        return { revision, snapshot };
      });
    });
  }
  private deferPathOwners(entryId: string, sourcePath: string): void {
    const key = sourcePath.normalize('NFC').toLowerCase(), { store } = this.options;
    for (const entry of store.heads()) if (entry.entryId !== entryId && entry.revisionIds.some(id => {
      const revision = store.revision(id)!, p = revision.relativePath.normalize('NFC').toLowerCase();
      return revision.op === 'put' && (p === key || p.startsWith(key + '/') || key.startsWith(p + '/'));
    })) store.defer(entry.entryId);
  }
  private moveContext(entryId: string, toPath: string) {
    this.current(); const { store } = this.options, policy = store.policy(), binding = store.binding();
    const heads = store.heads().find(h => h.entryId === entryId)?.revisionIds;
    const revision = heads?.length === 1 ? store.revision(heads[0]) : undefined, applied = store.applied().find(a => a.entryId === entryId);
    if (!revision || revision.op !== 'put' || !binding || !policy || policy.v < 3 || !canWriteSync(policy, this.self)
      || applied?.revisionId !== revision.revisionId || !applied.digest || store.deferred().includes(entryId)) throw new Error('A v3 writer with one applied head is required to move a file');
    if (!validSyncMovePaths(revision.relativePath, toPath) || excludedSyncPath(revision.relativePath, store.exclusions()) || excludedSyncPath(toPath, store.exclusions())) throw new Error('Invalid, excluded or overlapping sync move path');
    const key = toPath.normalize('NFC').toLowerCase();
    if (store.pathConflicts().some(c => c.entryIds.includes(entryId)) || store.heads().some(h => h.entryId !== entryId && h.revisionIds.some(id => {
      const path = store.revision(id)!.relativePath.normalize('NFC').toLowerCase(); return path === key || path.startsWith(key + '/') || key.startsWith(path + '/');
    }))) throw new Error('Sync move path conflict');
    return { revision, binding, policy, applied };
  }
  prepareMove(entryId: string, toPath: string): Promise<SyncMoveGuard> {
    return this.serial(async () => {
      if ((await this.recoverBinding()).some(r => r.state === 'conflict')) throw new Error('Sync recovery requires manual inspection before moving');
      const { revision, binding, policy, applied } = this.moveContext(entryId, toPath);
      const epoch = this.options.store.bindingEpoch(), fromPath = revision.relativePath;
      const digest = await this.localDigest(path.join(binding.path, ...fromPath.split('/')));
      if (digest !== applied.digest || await this.localDigest(path.join(binding.path, ...toPath.split('/'))) !== null) throw new Error('Sync local changes or move destination exists');
      if (this.options.store.bindingEpoch() !== epoch || this.moveContext(entryId, toPath).policy.policyId !== policy.policyId) throw new Error('Sync move context changed');
      return { entryId, revisionId: revision.revisionId, head: revision.revisionId, policyId: policy.policyId, bindingEpoch: epoch, path: binding.path, digest: digest!, fromPath, toPath };
    });
  }
  moveFile(guard: SyncMoveGuard): Promise<{ revision: SyncRevision; snapshot: SyncSnapshot }> {
    return this.serial(async () => {
      const { revision: previous, binding, policy } = this.moveContext(guard.entryId, guard.toPath), { store, context, identity } = this.options;
      const valid = () => this.options.isCurrent() && store.bindingEpoch() === guard.bindingEpoch && store.binding()?.path === guard.path && store.policy()?.policyId === guard.policyId && canWriteSync(store.policy(), this.self);
      if (previous.revisionId !== guard.head || previous.relativePath !== guard.fromPath || !valid()) throw new Error('Sync move preview changed; review again');
      const source = path.join(binding.path, ...guard.fromPath.split('/')), target = path.join(binding.path, ...guard.toPath.split('/'));
      if (await this.localDigest(source) !== guard.digest || await this.localDigest(target) !== null) throw new Error('Sync move files changed; review again');
      const secret = context.e2e ? this.options.contentSecret?.() : undefined;
      if (context.e2e && !secret) throw new Error('Sync content key unavailable');
      const snapshot = await this.snapshot({ source, name: guard.toPath.split('/').at(-1), storage: this.options.storage, authorId: this.self, secret, isCurrent: valid });
      if (!valid() || this.moveContext(guard.entryId, guard.toPath).revision.revisionId !== guard.head || snapshot.plaintextDigest !== guard.digest
        || await this.localDigest(source) !== guard.digest || await this.localDigest(target) !== null) {
        await fs.promises.rm(snapshot.directory, { recursive: true, force: true }); throw new Error('Sync move files changed; review again');
      }
      const revision = signSyncRevision(context.scope, { v: policy.v, rootId: context.rootId, policyId: policy.policyId, entryId: guard.entryId,
        parents: [guard.head], relativePath: guard.toPath, previousPaths: [guard.fromPath], op: 'put',
        blob: { infoHash: snapshot.file.infoHash, name: snapshot.file.name, size: snapshot.file.size, enc: !!snapshot.file.enc, keyEpoch: snapshot.file.keyEpoch ?? null },
        authorId: this.self, createdAt: Date.now(), pub: identity.pub }, identity.priv);
      store.acceptRevision(revision, true, undefined, { path: snapshot.sourcePath, metadata: snapshot.metadata.toString('base64') });
      await new RoomSyncApplier(binding.path).apply({ source, fromPath: guard.fromPath, relativePath: guard.toPath, revisionId: revision.revisionId,
        digest: guard.digest, expectedDigest: guard.digest, isCurrent: () => valid() && store.heads().find(h => h.entryId === guard.entryId)?.revisionIds.join(',') === revision.revisionId });
      if (!valid()) throw new Error('Sync move binding changed; recover the binding');
      store.markApplied(guard.entryId, revision.revisionId, guard.digest); return { revision, snapshot };
    });
  }
  readEditor(entryId: string) {
    return this.serial(async () => {
      this.current(); await this.recoverBinding();
      const { store } = this.options, policy = store.policy(), binding = store.binding();
      const heads = store.heads().find(h => h.entryId === entryId)?.revisionIds ?? [];
      const applied = store.applied().find(a => a.entryId === entryId);
      const revision = heads.length === 1 ? store.revision(heads[0]) : !heads.length && applied ? store.revision(applied.revisionId) : undefined;
      const language = revision && syncEditorLanguage(revision.relativePath);
      if (!revision || revision.op !== 'put' || !language || !binding || !policy || excludedSyncPath(revision.relativePath, store.exclusions())) throw new Error('Choose a bound, included text file with one resolved head');
      const epoch = store.bindingEpoch();
      const content = await readSyncEditorFile(path.join(binding.path, ...revision.relativePath.split('/')));
      this.current();
      if (store.bindingEpoch() !== epoch || store.policy()?.policyId !== policy.policyId || (store.heads().find(h => h.entryId === entryId)?.revisionIds ?? []).join(',') !== heads.join(',')) throw new Error('Editor file context changed; open again');
      const base = applied && store.revision(applied.revisionId);
      const writable = heads.length === 1 && canWriteSync(policy, this.self) && !store.deferred().includes(entryId) && !!base
        && !store.pathConflicts().some(c => c.entryIds.includes(entryId))
        && base.relativePath === revision.relativePath
        && (policy.v === 1 || base.policyId === policy.policyId || policy.baseHeads.some(h => h.entryId === entryId && h.revisionId === base.revisionId));
      const guard: SyncEditorGuard = { entryId, revisionId: revision.revisionId, head: heads.join(','), policyId: policy.policyId,
        bindingEpoch: epoch, path: binding.path, digest: content.digest, base: applied?.revisionId ?? null, newline: content.newline, bom: content.bom, writable };
      return { guard, view: { path: revision.relativePath, text: content.text, language, revisionId: revision.revisionId, writable,
        newline: content.newline, bom: content.bom, localChanges: !!applied && applied.digest !== content.digest } };
    });
  }
  saveEditor(guard: SyncEditorGuard, text: string): Promise<{ revision: SyncRevision; snapshot: SyncSnapshot | null }> {
    return this.serial(async () => {
      this.current(); const { store, context, identity } = this.options, binding = store.binding(), policy = store.policy(), selected = store.revision(guard.revisionId);
      const valid = () => this.options.isCurrent() && store.bindingEpoch() === guard.bindingEpoch && store.binding()?.path === guard.path
        && store.policy()?.policyId === guard.policyId && canWriteSync(store.policy(), this.self) && !store.deferred().includes(guard.entryId)
        && !store.pathConflicts().some(c => c.entryIds.includes(guard.entryId));
      if (!guard.writable || !binding || !policy || !selected || !valid() || store.heads().find(h => h.entryId === guard.entryId)?.revisionIds.join(',') !== guard.head
        || store.applied().find(a => a.entryId === guard.entryId)?.revisionId !== guard.base) throw new Error('Editor base, rights or binding changed; keep your draft and reopen the file');
      const bytes = encodeSyncEditorFile(text, guard.newline, guard.bom), target = path.join(binding.path, ...selected.relativePath.split('/'));
      if (await this.localDigest(target) !== guard.digest || !valid()) throw new Error('Editor file changed externally; keep your draft and reopen the file');
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (digest === guard.digest) return { revision: selected, snapshot: null };
      assertSyncPlainPath(this.options.storage); await fs.promises.mkdir(this.options.storage, { recursive: true }); assertSyncPlainPath(this.options.storage);
      const directory = await fs.promises.mkdtemp(path.join(this.options.storage, 'received-'));
      try {
        const plaintext = path.join(directory, selected.blob!.name); await fs.promises.writeFile(plaintext, bytes, { flag: 'wx' }); await flushSyncFile(plaintext);
        const secret = context.e2e ? this.options.contentSecret?.() : undefined;
        if (context.e2e && !secret) throw new Error('Sync content key unavailable');
        const snapshot = await this.snapshot({ source: plaintext, storage: this.options.storage, authorId: this.self, secret, isCurrent: valid });
        if (!valid() || await this.localDigest(target) !== guard.digest || store.heads().find(h => h.entryId === guard.entryId)?.revisionIds.join(',') !== guard.head) {
          await fs.promises.rm(snapshot.directory, { recursive: true, force: true }); throw new Error('Editor file changed while saving; keep your draft and reopen the file');
        }
        const revision = signSyncRevision(context.scope, { v: policy.v, rootId: context.rootId, policyId: policy.policyId, entryId: guard.entryId,
          parents: policy.v >= 2 ? [guard.base!] : [guard.head], relativePath: selected.relativePath, op: 'put',
          blob: { infoHash: snapshot.file.infoHash, name: snapshot.file.name, size: snapshot.file.size, enc: !!snapshot.file.enc, keyEpoch: snapshot.file.keyEpoch ?? null },
          authorId: this.self, createdAt: Date.now(), pub: identity.pub }, identity.priv);
        store.acceptRevision(revision, true, undefined, { path: snapshot.sourcePath, metadata: snapshot.metadata.toString('base64') });
        await new RoomSyncApplier(binding.path).apply({ source: plaintext, relativePath: revision.relativePath, revisionId: revision.revisionId,
          digest, expectedDigest: guard.digest, isCurrent: valid });
        this.current(); if (!valid()) throw new Error('Editor binding changed after publication; recover the binding');
        store.markApplied(revision.entryId, revision.revisionId, digest); return { revision, snapshot };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    });
  }
  changeWriters(writers: string[], expected: string, moves = false, deletes = false): Promise<void> {
    return this.serial(async () => {
      this.current(); const { store, context, identity } = this.options, policy = store.policy();
      if (!policy || context.ownerId !== this.self || this.rightsStamp() !== expected) throw new Error('Sync rights changed; review again');
      const baseHeads = store.heads().flatMap(h => h.revisionIds.map(revisionId => ({ entryId: h.entryId, revisionId })));
      const next = signSyncPolicy(context.scope, { v: deletes ? 6 : policy.v >= 4 ? policy.v : policy.v >= 3 || moves ? 3 : 2, writers: [...writers].sort(), rootId: context.rootId, epoch: policy.epoch + 1,
        parentPolicyId: policy.policyId, ownerId: context.ownerId, publisherId: context.ownerId, name: policy.name,
        allowDeletes: policy.allowDeletes || deletes, baseHeads, pub: identity.pub }, identity.priv);
      if (!syncRecordFitsTransport({ kind: 'policy', value: next })) throw new Error('Sync rights checkpoint exceeds network capacity; create a checkpoint first');
      store.acceptPolicy(next, true);
    });
  }

  private deletionPathAvailable(entryId: string, relativePath: string): boolean {
    const store = this.options.store, key = relativePath.normalize('NFC').toLowerCase();
    return !store.heads().some(h => h.entryId !== entryId && h.revisionIds.some(id => { const r = store.revision(id)!;
      const other = r.relativePath.normalize('NFC').toLowerCase(); return r.op === 'put' && (other === key || other.startsWith(key + '/') || key.startsWith(other + '/'));
    }));
  }
  private deletionContext(entryId: string, resolve: boolean) {
    this.current();
    const { store } = this.options, binding = store.binding(), policy = store.policy();
    const heads = store.heads().find(h => h.entryId === entryId)?.revisionIds ?? [];
    const revisions = heads.map(id => store.revision(id)!);
    if (!binding || !policy || policy.v < 6 || !policy.allowDeletes || !heads.length || heads.length > 64
      || store.pathConflicts().some(c => c.entryIds.includes(entryId)) || new Set(revisions.map(r => r.relativePath)).size !== 1
      || excludedSyncPath(revisions[0].relativePath, store.exclusions())) throw new Error('A bound v6 deletion-enabled file without path conflicts is required');
    if (resolve ? heads.length !== 1 || revisions[0].op !== 'delete' : !canWriteSync(policy, this.self) || revisions.every(r => r.op === 'delete')) throw new Error('Sync deletion is not authorized');
    if (!this.deletionPathAvailable(entryId, revisions[0].relativePath)) throw new Error('Sync deletion path conflict');
    const applied = store.applied().find(a => a.entryId === entryId), base = applied && store.revision(applied.revisionId);
    if (base && base.relativePath !== revisions[0].relativePath) throw new Error('Review the pending move before deleting');
    if (!resolve && (!base || base.op !== 'put' || store.deferred().includes(entryId))) throw new Error('Apply or restore the shared base before deleting');
    return { store, binding, policy, heads, revisions, applied, base, relativePath: revisions[0].relativePath };
  }
  prepareDelete(entryId: string, resolve = false): Promise<SyncDeleteGuard> {
    return this.serial(async () => {
      await this.recoverBinding(); const context = this.deletionContext(entryId, resolve);
      const { store, binding, policy, heads, applied, base, relativePath } = context;
      const value = await this.localDigest(path.join(binding.path, ...relativePath.split('/')));
      if (!resolve && value !== null && value !== applied?.digest) throw new Error('Sync local changes; publish or preserve them before deleting');
      const ancestors = [...heads], seen = new Set<string>(); let content = base?.op === 'put' ? base : undefined;
      while (!content && ancestors.length) {
        const id = ancestors.pop()!; if (seen.has(id)) continue; seen.add(id); const revision = store.revision(id);
        if (revision?.op === 'put' && revision.relativePath === relativePath) content = revision;
        else if (revision) ancestors.push(...revision.parents);
      }
      if (!content) throw new Error('Obtain the previous content history before reviewing deletion');
      return { entryId, revisionId: heads[0], baseRevisionId: content.revisionId, head: heads.join(','), policyId: policy.policyId,
        bindingEpoch: store.bindingEpoch(), path: binding.path, digest: value, mode: resolve ? 'apply' : 'publish',
        localSize: value === null ? 0 : (await fs.promises.lstat(path.join(binding.path, ...relativePath.split('/')))).size,
        copyPath: `.havvn-local/copy-${crypto.randomBytes(8).toString('hex')}/${relativePath.split('/').at(-1)!}` };
    });
  }
  confirmDelete(guard: SyncDeleteGuard, keepBoth = false, authorized: () => boolean = () => true): Promise<{ revision: SyncRevision; copyPath: string | null }> {
    return this.serial(async () => {
      const context = this.deletionContext(guard.entryId, guard.mode === 'apply'), { store, binding, policy, heads, relativePath } = context;
      const target = path.join(binding.path, ...relativePath.split('/'));
      const valid = () => authorized() && this.options.isCurrent() && store.bindingEpoch() === guard.bindingEpoch && store.binding()?.path === guard.path
        && store.policy()?.policyId === guard.policyId && this.deletionPathAvailable(guard.entryId, relativePath)
        && store.heads().find(h => h.entryId === guard.entryId)?.revisionIds.join(',') === heads.join(',');
      if (!valid() || heads.join(',') !== guard.head || await this.localDigest(target) !== guard.digest) throw new Error('Sync deletion preview changed; review again');
      if (guard.digest !== null) await new RoomSyncTrash(binding.path).ensureCapacity(guard.localSize);
      if (!valid() || await this.localDigest(target) !== guard.digest) throw new Error('Sync deletion preview changed; review again');
      if (guard.mode === 'apply') await new RoomSyncTrash(binding.path).abandon(relativePath, guard.digest, j => authorizedSyncTrashJournal(store, j), valid);
      let copyPath: string | null = null;
      if (keepBoth && guard.digest !== null) {
        if (!/^\.havvn-local\/copy-[a-f0-9]{16}\//.test(guard.copyPath) || guard.copyPath.split('/').at(-1) !== relativePath.split('/').at(-1)) throw new Error('Invalid deletion recovery copy');
        const copy = path.join(binding.path, ...guard.copyPath.split('/'));
        assertSyncPlainPath(copy); await fs.promises.mkdir(path.dirname(copy), { recursive: true }); assertSyncPlainPath(copy);
        await fs.promises.copyFile(target, copy, fs.constants.COPYFILE_EXCL); await flushSyncFile(copy);
        if (await this.localDigest(copy) !== guard.digest || await this.localDigest(target) !== guard.digest || !valid()) throw new Error('Sync local changes while preserving deletion conflict');
        copyPath = guard.copyPath;
      }
      let revision = context.revisions[0];
      if (guard.mode === 'publish') {
        if (!valid()) throw new Error('Sync deletion preview changed; review again');
        revision = signSyncRevision(this.options.context.scope, { v: 6, rootId: this.options.context.rootId, policyId: policy.policyId, entryId: guard.entryId,
          parents: heads, relativePath, op: 'delete', blob: null, authorId: this.self, createdAt: Date.now(), pub: this.options.identity.pub }, this.options.identity.priv);
        store.acceptRevision(revision, true);
      }
      const current = () => this.options.isCurrent() && store.bindingEpoch() === guard.bindingEpoch && store.binding()?.path === guard.path
        && store.policy()?.policyId === guard.policyId && this.deletionPathAvailable(guard.entryId, relativePath)
        && store.heads().find(h => h.entryId === guard.entryId)?.revisionIds.join(',') === revision.revisionId;
      if (guard.digest !== null) {
        await new RoomSyncTrash(binding.path).remove({ v: 1, revisionId: revision.revisionId, baseRevisionId: guard.baseRevisionId,
          relativePath, expectedDigest: guard.digest }, j => authorizedSyncTrashJournal(store, j), current);
      } else if (!current() || await this.localDigest(target) !== null) throw new Error('Sync local changes during deletion');
      if (!current()) throw new Error('Sync deletion context changed; recover the binding');
      store.markApplied(guard.entryId, revision.revisionId, null, true);
      return { revision, copyPath };
    });
  }
  applyDeletion(revisionId: string): Promise<void> {
    return this.serial(async () => {
      this.current(); await this.recoverBinding();
      const { store } = this.options, revision = store.revision(revisionId);
      if (!revision) throw new Error('Unknown sync deletion');
      const { binding, policy, heads, applied, base, relativePath } = this.deletionContext(revision.entryId, true);
      if (!binding.autoApply || heads[0] !== revisionId || store.deferred().includes(revision.entryId)) throw new Error('Sync deletion application is not authorized');
      if (applied?.revisionId === revisionId) return;
      const epoch = store.bindingEpoch(), target = path.join(binding.path, ...relativePath.split('/'));
      const actual = await this.localDigest(target);
      const current = () => this.options.isCurrent() && store.bindingEpoch() === epoch && store.binding()?.autoApply === true
        && store.policy()?.policyId === policy.policyId && !store.deferred().includes(revision.entryId)
        && this.deletionPathAvailable(revision.entryId, relativePath)
        && store.heads().find(h => h.entryId === revision.entryId)?.revisionIds.join(',') === revisionId;
      if (actual !== null) {
        if (!base || base.op !== 'put' || applied?.digest !== actual) throw new Error('Sync local changes prevent deletion; review the conflict');
        await new RoomSyncTrash(binding.path).remove({ v: 1, revisionId, baseRevisionId: base.revisionId, relativePath, expectedDigest: actual },
          j => authorizedSyncTrashJournal(store, j), current);
      }
      if (!current() || await this.localDigest(target) !== null) throw new Error('Sync local changes during deletion');
      store.markApplied(revision.entryId, revisionId, null);
    });
  }

  publish(relativePath: string, entryId?: string, authorized: () => boolean = () => true, priority: SyncWorkPriority = 'interactive'): Promise<{ revision: SyncRevision; snapshot: SyncSnapshot | null }> {
    return this.serial(async () => {
      this.current(); await this.recoverBinding();
      if (!authorized()) throw new Error('Sync publication canceled');
      if (!validSyncRelativePath(relativePath)) throw new Error('Invalid sync publication path');
      const { store, context, identity } = this.options;
      const policy = store.policy(), binding = store.binding();
      if (excludedSyncPath(relativePath, store.exclusions())) throw new Error('Sync path excluded');
      const bindingEpoch = store.bindingEpoch();
      if (!policy || !canWriteSync(policy, this.self) || !binding) throw new Error('A publisher binding is required');
      const matches = store.heads().filter(entry => entry.revisionIds.some(id => store.revision(id)?.relativePath.normalize('NFC').toLowerCase() === relativePath.normalize('NFC').toLowerCase()));
      if (matches.length > 1 || entryId && matches.some(entry => entry.entryId !== entryId)) throw new Error('Sync path conflict');
      if (!matches.length && store.applied().some(a => {
        const current = store.revision(a.revisionId);
        return current && current.relativePath !== relativePath && authorizedSyncApplyJournal(store, { revisionId: current.revisionId, relativePath: current.relativePath, fromPath: relativePath });
      })) throw new Error('Preserved move source requires review before publishing as a new file');
      const orphan = store.applied().find(a => store.revision(a.revisionId)?.relativePath === relativePath && !store.heads().some(h => h.entryId === a.entryId));
      if (orphan) throw new Error('Offline file excluded by owner checkpoint; preserve it and review history before republishing');
      const id = entryId ?? matches[0]?.entryId ?? crypto.randomUUID();
      if (!this.deletionPathAvailable(id, relativePath)) throw new Error('Sync path conflict');
      const heads = store.heads().find(entry => entry.entryId === id)?.revisionIds ?? [];
      const base = store.applied().find(a => a.entryId === id);
      if (policy.v >= 2 && (store.deferred().includes(id) || heads.length && !base)) throw new Error('Review or apply the shared base before publishing local changes');
      const parents = policy.v >= 2 && base ? [base.revisionId] : heads;
      if (policy.v >= 2 && parents.some(parent => store.revision(parent)?.policyId !== policy.policyId && !policy.baseHeads.some(h => h.entryId === id && h.revisionId === parent))) throw new Error('Review or apply the current epoch base before publishing local changes');
      if (policy.v === 1 && parents.length > 1) throw new Error('Sync head conflict requires explicit resolution');
      if (parents.some(parent => store.revision(parent)?.relativePath !== relativePath)) throw new Error('Sync moves require an explicit operation');
      const secret = context.e2e ? this.options.contentSecret?.() : undefined;
      if (context.e2e && !secret) throw new Error('Sync content key unavailable');
      const snapshot = await this.snapshot({ source: path.join(binding.path, ...relativePath.split('/')),
        storage: this.options.storage, authorId: this.self, secret, isCurrent: () => authorized() && store.bindingEpoch() === bindingEpoch && store.policy()?.policyId === policy.policyId }, priority);
      this.current();
      if (!authorized()) throw new Error('Sync publication canceled');
      if (store.policy()?.policyId !== policy.policyId || store.binding()?.path !== binding.path || store.bindingEpoch() !== bindingEpoch) throw new Error('Sync publication context changed');
      if (!this.deletionPathAvailable(id, relativePath)) throw new Error('Sync path conflict');
      const applied = store.applied().find(a => a.entryId === id);
      const previous = parents.length === 1 ? store.revision(parents[0]) : undefined;
      if (previous?.op === 'put' && applied?.revisionId === previous.revisionId && applied.digest === snapshot.plaintextDigest
        && previous.blob?.enc === !!snapshot.file.enc && previous.blob?.keyEpoch === (snapshot.file.keyEpoch ?? null)) {
        await fs.promises.rm(snapshot.directory, { recursive: true, force: true });
        return { revision: previous, snapshot: null };
      }
      const revision = signSyncRevision(context.scope, { v: policy.v, rootId: context.rootId, policyId: policy.policyId,
        entryId: id, parents, relativePath, op: 'put', blob: { infoHash: snapshot.file.infoHash,
          name: snapshot.file.name, size: snapshot.file.size, enc: !!snapshot.file.enc, keyEpoch: snapshot.file.keyEpoch ?? null },
        authorId: this.self, createdAt: Date.now(), pub: identity.pub }, identity.priv);
      // The stable document ID, fingerprint and outgoing announcement commit together.
      // On a failed/uncertain write retain the snapshot for recovery rather than deleting potential source bytes.
      store.acceptRevision(revision, true, snapshot.plaintextDigest,
        { path: snapshot.sourcePath, metadata: snapshot.metadata.toString('base64') });
      return { revision, snapshot };
    });
  }

  /** Resume only verified retained snapshots; an outbox record alone never means "have bytes". */
  resumeSources(): Promise<{ ready: Array<{ revisionId: string; file: RoomFile; sourcePath: string; metadata: Buffer }>; unavailable: string[] }> {
    return this.serial(async () => {
      this.current();
      const ready: Array<{ revisionId: string; file: RoomFile; sourcePath: string; metadata: Buffer }> = [], unavailable: string[] = [];
      for (const source of this.options.store.sources()) {
        this.current();
        const revision = this.options.store.revision(source.revisionId)!;
        const relative = path.relative(path.resolve(this.options.storage), path.resolve(source.path));
        try {
          if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Sync source outside storage');
          assertSyncPlainPath(source.path);
          const file = syncRevisionFile(revision), metadata = Buffer.from(source.metadata, 'base64');
          await verifyRoomFile(source.path, file, metadata);
          this.current();
          ready.push({ revisionId: revision.revisionId, file, sourcePath: source.path, metadata });
        } catch {
          this.current();
          unavailable.push(source.revisionId);
        }
      }
      return { ready, unavailable };
    });
  }

  applyReceived(revisionId: string, downloaded: string, metadata: Uint8Array): Promise<SyncApplyReceipt> {
    return this.serial(async () => {
      this.current();
      const { store } = this.options;
      const revision = store.revision(revisionId), binding = store.binding(), policyId = store.policy()?.policyId;
      const bindingEpoch = store.bindingEpoch();
      if (!revision || revision.op !== 'put' || !binding?.autoApply || excludedSyncPath(revision.relativePath, store.exclusions())) throw new Error('Sync application is not authorized');
      const stillCurrent = () => {
        const liveBinding = store.binding(), heads = store.heads().find(h => h.entryId === revision.entryId)?.revisionIds;
        return this.options.isCurrent() && store.bindingEpoch() === bindingEpoch && liveBinding?.path === binding.path && liveBinding.autoApply
          && !store.deferred().includes(revision.entryId)
          && store.policy()?.policyId === policyId && heads?.length === 1 && heads[0] === revisionId
          && !store.pathConflicts().some(conflict => conflict.entryIds.includes(revision.entryId));
      };
      if (!stillCurrent()) throw new Error('Sync head changed or conflicts');
      const applied = store.applied().find(a => a.entryId === revision.entryId);
      if (applied?.revisionId === revisionId) {
        const receipts = await new RoomSyncApplier(binding.path).recover(journal => authorizedSyncApplyJournal(store, journal));
        const receipt = receipts.find(r => r.revisionId === revisionId && r.state === 'applied' && r.digest === applied.digest);
        if (receipt) return receipt; // A replay must not replace later local edits or create another history item.
      }
      assertSyncPlainPath(downloaded);
      const file = syncRevisionFile(revision);
      let temporary: string | undefined, retain = false;
      try {
        // A download/original can change after a successful check. Verify our own
        // exclusive copy, then hash/decrypt/apply only that same private snapshot.
        assertSyncPlainPath(this.options.storage);
        await fs.promises.mkdir(this.options.storage, { recursive: true });
        assertSyncPlainPath(this.options.storage);
        temporary = await fs.promises.mkdtemp(path.join(this.options.storage, 'received-'));
        const payload = path.join(temporary, roomDiskName(file));
        await fs.promises.copyFile(downloaded, payload, fs.constants.COPYFILE_EXCL);
        await verifyRoomFile(payload, file, metadata);
        if (!stillCurrent()) throw new Error('Sync application context changed');
        // Retain verified ciphertext/plain content even while application is paused by
        // a file lock or missing key. An uncertain store write must not delete its source.
        retain = true;
        store.retainSource(revisionId, { path: payload, metadata: Buffer.from(metadata).toString('base64') });
        let plaintext = payload;
        if (file.enc) {
          const secret = this.options.resolveSecret?.(file.keyEpoch!);
          if (!secret || contentKeyEpoch(secret) !== file.keyEpoch) throw new Error('Sync content key unavailable');
          plaintext = path.join(temporary, 'plaintext');
          await decryptFile(payload, plaintext, secret, { expectedSize: file.size, isCurrent: stillCurrent });
        }
        const digest = await syncFileDigest(plaintext);
        if (!stillCurrent()) throw new Error('Sync application context changed');
        // A superseded operation can have left a valid journal even when its
        // replacement arrived before publication. Reconcile it before the next
        // apply; a process restart must not be required to continue receiving.
        await this.recoverBinding();
        const local = store.applied().find(a => a.entryId === revision.entryId), prior = local && store.revision(local.revisionId);
        const sharedSource = !!prior && !this.deletionPathAvailable(revision.entryId, prior.relativePath);
        if (sharedSource) this.deferPathOwners(revision.entryId, prior!.relativePath);
        const moving = !!prior && prior.relativePath !== revision.relativePath && !sharedSource;
        if (moving && (revision.v < 3 || excludedSyncPath(prior.relativePath, store.exclusions()) || !authorizedSyncApplyJournal(store, { revisionId, relativePath: revision.relativePath, fromPath: prior.relativePath }))) throw new Error('Sync move source is not authorized');
        const expected = prior && prior.relativePath !== revision.relativePath && sharedSource ? null : local?.digest ?? null;
        const receipt = await new RoomSyncApplier(binding.path).apply({ source: plaintext, relativePath: revision.relativePath,
          ...(moving ? { fromPath: prior.relativePath } : {}), revisionId, digest, expectedDigest: expected,
          isCurrent: () => stillCurrent() && (!moving || this.deletionPathAvailable(revision.entryId, prior.relativePath)) });
        // Once publication completed, its receipt is a valid local base even
        // when a newer head has just arrived. Do not label those bytes as an
        // independent local edit. A replaced binding still cannot inherit them.
        if (!this.options.isCurrent() || store.binding()?.path !== binding.path || store.bindingEpoch() !== bindingEpoch) throw new Error('Sync application context changed after publication; recover the binding');
        store.markApplied(revision.entryId, revisionId, digest);
        return receipt;
      } finally {
        if (temporary && file.enc) await fs.promises.rm(path.join(temporary, 'plaintext'), { force: true });
        if (temporary && !retain) await fs.promises.rm(temporary, { recursive: true, force: true });
      }
    });
  }

  recoverApplied(): Promise<SyncApplyReceipt[]> {
    return this.serial(() => this.recoverBinding());
  }
  private async recoverBinding(): Promise<SyncApplyReceipt[]> {
      this.current();
      const { store } = this.options, binding = store.binding();
      const bindingEpoch = store.bindingEpoch();
      if (!binding) return [];
      await recoverSyncBackupPrunes(store, this.options.isCurrent);
      const receipts = await new RoomSyncApplier(binding.path).recover(journal => authorizedSyncApplyJournal(store, journal));
      this.current();
      if (store.binding()?.path !== binding.path || store.bindingEpoch() !== bindingEpoch) throw new Error('Sync recovery binding changed');
      const ancestor = (candidate: string, target: string): boolean => {
        const todo = [target], seen = new Set<string>();
        while (todo.length) {
          const id = todo.pop()!;
          if (id === candidate) return true;
          if (seen.has(id)) continue;
          seen.add(id); const revision = store.revision(id); if (revision) todo.push(...revision.parents);
        }
        return false;
      };
      for (const receipt of receipts) {
        if (receipt.state !== 'applied') continue;
        const revision = store.revision(receipt.revisionId);
        if (!revision || revision.relativePath !== receipt.relativePath || revision.op !== 'put') throw new Error('Sync receipt has no verified revision');
        const applied = store.applied().find(a => a.entryId === revision.entryId);
        if (applied?.revisionId === revision.revisionId) continue;
        if (applied && ancestor(revision.revisionId, applied.revisionId)) continue;
        if (applied && !ancestor(applied.revisionId, revision.revisionId)) {
          if (store.isRetiredRevision(revision.revisionId) && !store.isRetiredRevision(applied.revisionId)) continue;
          throw new Error('Conflicting applied sync history');
        }
        store.markApplied(revision.entryId, revision.revisionId, receipt.digest);
      }
      const removed = await new RoomSyncTrash(binding.path).recover(j => authorizedSyncTrashJournal(store, j));
      this.current(); if (store.bindingEpoch() !== bindingEpoch) throw new Error('Sync trash recovery binding changed');
      for (const receipt of removed) {
        if (receipt.state === 'conflict') { receipts.push({ operationId: receipt.operationId, revisionId: receipt.revisionId, relativePath: receipt.relativePath, digest: receipt.expectedDigest, state: 'conflict' }); continue; }
        if (receipt.state !== 'deleted') continue;
        const revision = store.revision(receipt.revisionId)!, applied = store.applied().find(a => a.entryId === revision.entryId);
        if (applied && ancestor(revision.revisionId, applied.revisionId)) continue;
        if (applied && !ancestor(applied.revisionId, revision.revisionId)) throw new Error('Conflicting deleted sync history');
        store.markApplied(revision.entryId, revision.revisionId, null);
      }
      return receipts;
  }
}
