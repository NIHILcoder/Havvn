/** One protected atomic snapshot per local room/root. Never writes user documents. */
import path from 'node:path';
import crypto from 'node:crypto';
import Store from 'electron-store';
import { encryptSecret, decryptSecretStrict } from './secrets';
import { FileSyncIndex, SYNC_HASH, SYNC_UUID, SYNC_POLICY_LIMIT, SYNC_REVISION_LIMIT, SYNC_ARCHIVE_EPOCH_LIMIT,
  type SyncIndexContext, type SyncPolicy, type SyncRevision, type SyncRecord } from '../../shared/room-file-sync';
import { verifySyncProof } from '../sharing/room-sync-proofs';
import { validSyncRelativePath } from '../../shared/room-file-sync';
import { DEFAULT_SYNC_BACKUP_POLICY, validSyncBackupPolicy, type SyncBackupPolicy } from '../../shared/room-file-sync-backups';
import { validSyncExclusions, syncPathExclusion } from '../../shared/room-file-sync-filters';
import { packSyncLog, unpackSyncLog, SYNC_LOG_DECODE_BYTES, type SyncLogPack } from './room-sync-log-pack';
import type { SyncLogSummary } from '../../shared/room-file-sync-ui';
import type { SyncMetadataView } from '../../shared/room-file-sync-ui';
import { copySyncRecord } from '../../shared/room-file-sync-protocol';

export const SYNC_STORE_BYTES = 16 * 1024 * 1024;
export const SYNC_CHECKPOINT_ARCHIVES = SYNC_ARCHIVE_EPOCH_LIMIT;
export const validSyncCacheLimit = (bytes: unknown): bytes is number => Number.isSafeInteger(bytes) && (bytes as number) >= 0 && (bytes as number) <= 100 * 1024 ** 3;
export interface SyncPersistence { read(): unknown; write(snapshot: unknown): void }
export interface SyncApplied { entryId: string; revisionId: string; digest: string | null }
export interface SyncBinding { path: string; autoApply: boolean }
export interface SyncLocalSource { revisionId: string; path: string; metadata: string }
export const SYNC_TRASH_EXPORT_LIMIT = 2000;
export interface SyncTrashExportReceipt { operationId: string; folder: string; revisionId: string; digest: string; size: number; path: string; identity: string }
export interface SyncMetadataBundle {
  format: 'havvn-file-sync-history'; v: 1; context: SyncIndexContext;
  active: SyncLogPack; retired: SyncLogPack[]; history: Array<{ checkpointId: string; pack: SyncLogPack }>;
}
export interface SyncMetadataPlan {
  stamp: string; historyStamp: string; keep: number; remove: string[];
  beforeBytes: number; afterBytes: number; epochs: SyncMetadataView['epochs'];
}
export type SyncMetadataProofStore = Pick<RoomSyncStore, 'revision' | 'checkpoint'>;
interface Snapshot {
  v: 1 | 2 | 3 | 4;
  context: SyncIndexContext & { localRoomId: string };
  log: SyncRecord[];
  archive?: SyncLogPack;
  retired?: SyncLogPack[];
  history?: Array<{ checkpointId: string; pack: SyncLogPack }>;
  outbox: string[];
  binding: SyncBinding | null;
  applied: SyncApplied[];
  sources: SyncLocalSource[];
  watch: { enabled: boolean; pending: string[] };
  bindingEpoch: number;
  cacheLimitBytes: number;
  deferred: string[];
  backups: SyncBackupPolicy;
  exclusions: string[];
  trashExports?: SyncTrashExportReceipt[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const MAX_RECORDS = SYNC_POLICY_LIMIT + SYNC_REVISION_LIMIT;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const recordId = (record: SyncRecord) => record.kind === 'policy' ? record.value.policyId : record.value.revisionId;
export const syncLogCommitment = (records: SyncRecord[]) => crypto.createHash('sha256').update(JSON.stringify(records.map(recordId).sort())).digest('hex');
function replayLog(records: SyncRecord[], context: SyncIndexContext): FileSyncIndex {
  const index = new FileSyncIndex(context, verifySyncProof);
  for (const [ordinal, r] of records.entries()) {
    if (!isObject(r) || !isObject(r.value) || (r.kind !== 'policy' && r.kind !== 'revision')) throw new Error('Invalid sync archive record');
    if (r.kind === 'policy' && r.value.checkpoint && ordinal !== 0) throw new Error('Checkpoint must start an archive epoch');
    const result = r.kind === 'policy' ? index.acceptPolicy(r.value) : index.acceptRevision(r.value);
    if (result !== 'accepted') throw new Error('Duplicate sync archive record');
  }
  return index;
}
const bindingValid = (v: unknown): v is SyncBinding => isObject(v) && typeof v.path === 'string'
  && v.path.length <= 4096 && path.isAbsolute(v.path) && typeof v.autoApply === 'boolean';
function sourceValid(v: unknown): v is SyncLocalSource {
  return isObject(v) && typeof v.revisionId === 'string' && SYNC_HASH.test(v.revisionId)
    && typeof v.path === 'string' && v.path.length <= 4096 && path.isAbsolute(v.path)
    && typeof v.metadata === 'string' && v.metadata.length > 0 && v.metadata.length <= 1024 * 1024
    && Buffer.from(v.metadata, 'base64').toString('base64') === v.metadata;
}
function trashExportValid(v: unknown): v is SyncTrashExportReceipt {
  return isObject(v) && typeof v.operationId === 'string' && /^op-[a-zA-Z0-9]{1,128}$/.test(v.operationId)
    && typeof v.folder === 'string' && v.folder.length <= 4096 && path.isAbsolute(v.folder)
    && typeof v.path === 'string' && v.path.length <= 4096 && path.isAbsolute(v.path)
    && typeof v.revisionId === 'string' && SYNC_HASH.test(v.revisionId) && typeof v.digest === 'string' && SYNC_HASH.test(v.digest)
    && Number.isSafeInteger(v.size) && (v.size as number) >= 0 && (v.size as number) <= 2 * 1024 ** 3
    && typeof v.identity === 'string' && v.identity.length > 0 && v.identity.length <= 1024;
}

export class RoomSyncStore {
  private index: FileSyncIndex;
  private snapshot: Snapshot;
  private failed = false;
  private logEpoch = 0;
  private archived: SyncRecord[] = [];
  private decodedLogBytes = 2;
  private retiredIds = new Map<string, number>();
  private retiredCache?: { ordinal: number; index: FileSyncIndex };
  private remoteIds = new Map<string, number>();
  private remoteCache?: { ordinal: number; index: FileSyncIndex };
  private checkpoints = new Map<string, SyncPolicy>();
  private archiveDigests = new Map<string, { remote: boolean; ordinal: number }>();
  private retiredGenerations = new Map<number, number>();

  private catalogArchive(ordinal: number, records: SyncRecord[]): void {
    this.archiveDigests.set(syncLogCommitment(records), { remote: false, ordinal });
    this.retiredGenerations.set(ordinal, records[0]?.kind === 'policy' ? records[0].value.checkpoint?.generation ?? 0 : 0);
    for (const r of records) {
      this.retiredIds.set(recordId(r), ordinal);
      if (r.kind === 'policy' && r.value.checkpoint) this.checkpoints.set(r.value.policyId, r.value);
      if (r.kind === 'policy') for (const a of r.value.checkpoint?.anchors ?? []) this.retiredIds.set(a.revisionId, ordinal);
    }
  }
  private catalogRemote(ordinal: number, records: SyncRecord[]): void {
    this.archiveDigests.set(syncLogCommitment(records), { remote: true, ordinal });
    for (const r of records) {
      this.remoteIds.set(recordId(r), ordinal);
      if (r.kind === 'policy' && r.value.checkpoint) {
        this.checkpoints.set(r.value.policyId, r.value);
        for (const a of r.value.checkpoint.anchors) this.remoteIds.set(a.revisionId, ordinal);
      }
    }
  }
  private remoteRevision(id: string): SyncRevision | undefined {
    const ordinal = this.remoteIds.get(id); if (ordinal === undefined) return undefined;
    if (this.remoteCache?.ordinal !== ordinal) this.remoteCache = { ordinal, index: replayLog(unpackSyncLog(this.snapshot.history![ordinal].pack), this.index.context) };
    return this.remoteCache.index.revision(id);
  }
  private verifyHistory(checkpoint: SyncPolicy, pack: SyncLogPack): SyncRecord[] {
    const records = unpackSyncLog(pack), index = replayLog(records, this.index.context), cp = checkpoint.checkpoint!;
    if (records.length !== cp.archiveRecords || syncLogCommitment(records) !== cp.archiveDigest
      || index.policy()?.policyId !== checkpoint.parentPolicyId || (index.checkpoint()?.policyId ?? null) !== cp.parentCheckpointId
      || (index.checkpoint()?.checkpoint?.generation ?? 0) !== cp.generation - 1
      || JSON.stringify(index.heads().flatMap(h => h.revisionIds.map(revisionId => ({ entryId: h.entryId, revisionId })))) !== JSON.stringify(checkpoint.baseHeads)) {
      throw new Error('History archive does not match its signed checkpoint');
    }
    return records.map(copySyncRecord);
  }
  private retiredRevision(id: string): SyncRevision | undefined {
    const ordinal = this.retiredIds.get(id); if (ordinal === undefined) return undefined;
    if (this.retiredCache?.ordinal !== ordinal) this.retiredCache = { ordinal, index: replayLog(unpackSyncLog(this.snapshot.retired![ordinal]), this.index.context) };
    return this.retiredCache.index.revision(id);
  }

  constructor(private readonly persistence: SyncPersistence, localRoomId: string, context: SyncIndexContext) {
    if (!localRoomId || localRoomId.length > 256) throw new Error('Invalid local room ID');
    this.index = new FileSyncIndex(context, verifySyncProof);
    this.snapshot = { v: 1, context: { ...context, localRoomId }, log: [], outbox: [], binding: null, applied: [], sources: [], watch: { enabled: false, pending: [] }, bindingEpoch: 0, cacheLimitBytes: 512 * 1024 * 1024, deferred: [], backups: { ...DEFAULT_SYNC_BACKUP_POLICY }, exclusions: [] };
    const raw = persistence.read();
    if (raw === undefined) return; // Existing rooms acquire no bindings or permissions through migration.
    if (!isObject(raw) || (raw.v !== 1 && raw.v !== 2 && raw.v !== 3 && raw.v !== 4) || (raw.v === 1 ? raw.archive !== undefined : raw.v === 2 && raw.archive === undefined)
      || (raw.v >= 3 ? !Array.isArray(raw.retired) || raw.retired.length > SYNC_CHECKPOINT_ARCHIVES : raw.retired !== undefined)
      || (raw.v === 4 ? !Array.isArray(raw.history) || raw.history.length > SYNC_CHECKPOINT_ARCHIVES : raw.history !== undefined)
      || !isObject(raw.context) || jsonBytes(raw) > SYNC_STORE_BYTES
      || Object.entries(this.snapshot.context).some(([key, value]) => (raw.context as Record<string, unknown>)[key] !== value)
      || !Array.isArray(raw.log) || raw.log.length > MAX_RECORDS || !Array.isArray(raw.outbox) || raw.outbox.length > MAX_RECORDS * (SYNC_CHECKPOINT_ARCHIVES + 1)
      || raw.binding !== null && !bindingValid(raw.binding) || !Array.isArray(raw.applied) || raw.applied.length > 2000
      || raw.sources !== undefined && (!Array.isArray(raw.sources) || raw.sources.length > SYNC_REVISION_LIMIT * (SYNC_CHECKPOINT_ARCHIVES + 1))
      || raw.bindingEpoch !== undefined && (!Number.isSafeInteger(raw.bindingEpoch) || (raw.bindingEpoch as number) < 0)
      || raw.cacheLimitBytes !== undefined && !validSyncCacheLimit(raw.cacheLimitBytes)
      || raw.trashExports !== undefined && (!Array.isArray(raw.trashExports) || raw.trashExports.length > SYNC_TRASH_EXPORT_LIMIT || raw.trashExports.some(r => !trashExportValid(r))
        || new Set(raw.trashExports.map(r => JSON.stringify([r.folder, r.operationId]))).size !== raw.trashExports.length)
      || raw.backups !== undefined && (!validSyncBackupPolicy(raw.backups) || !raw.binding && raw.backups.enabled)
      || raw.exclusions !== undefined && (!validSyncExclusions(raw.exclusions) || !raw.binding && raw.exclusions.length > 0)) {
      throw new Error('Invalid or incompatible sync snapshot');
    }
    const log: SyncRecord[] = [];
    const archived = raw.archive === undefined ? [] : unpackSyncLog(raw.archive);
    if (archived.length + raw.log.length > MAX_RECORDS || jsonBytes([...archived, ...raw.log]) > SYNC_LOG_DECODE_BYTES) throw new Error('Sync log decoded capacity reached');
    const ids = new Set<string>();
    const retired = (raw.retired ?? []) as unknown[];
    const retiredPacks: SyncLogPack[] = [];
    for (const [ordinal, pack] of retired.entries()) {
      const records = unpackSyncLog(pack); replayLog(records, context);
      this.catalogArchive(ordinal, records); for (const id of this.retiredIds.keys()) ids.add(id);
      retiredPacks.push(packSyncLog(records));
    }
    if (raw.v >= 3) this.snapshot.retired = retiredPacks;
    // Re-verify the signed log in causal order. Derived heads are never trusted from disk.
    for (const record of [...archived, ...raw.log]) {
      if (!isObject(record) || !isObject(record.value)) throw new Error('Invalid sync log record');
      if (record.kind === 'policy' && record.value.checkpoint && (raw.v < 3 || log.length)) throw new Error('Checkpoint must start a v3 storage epoch');
      let accepted: 'accepted' | 'duplicate';
      let clean: SyncRecord;
      if (record.kind === 'policy') {
        accepted = this.index.acceptPolicy(record.value);
        clean = { kind: 'policy', value: this.index.policy()! };
      } else if (record.kind === 'revision') {
        accepted = this.index.acceptRevision(record.value);
        clean = { kind: 'revision', value: this.index.revision(record.value.revisionId as string)! };
      } else throw new Error('Unsupported sync log record');
      if (accepted !== 'accepted') throw new Error('Duplicate sync log record');
      ids.add(recordId(clean)); log.push(clean);
      if (clean.kind === 'policy') {
        if (clean.value.checkpoint) this.checkpoints.set(clean.value.policyId, clean.value);
        for (const a of clean.value.checkpoint?.anchors ?? []) ids.add(a.revisionId);
      }
    }
    const history: NonNullable<Snapshot['history']> = [];
    for (const item of (raw.history ?? []) as unknown[]) {
      if (!isObject(item) || typeof item.checkpointId !== 'string' || history.some(h => h.checkpointId === item.checkpointId)) throw new Error('Invalid downloaded history archive');
      const checkpoint = this.checkpoints.get(item.checkpointId);
      if (!checkpoint) throw new Error('Unknown history checkpoint');
      const records = this.verifyHistory(checkpoint, item.pack as SyncLogPack), pack = packSyncLog(records);
      this.catalogRemote(history.length, records); history.push({ checkpointId: checkpoint.policyId, pack });
      for (const id of this.remoteIds.keys()) ids.add(id);
    }
    if (raw.v === 4) this.snapshot.history = history;
    if (raw.outbox.some(id => typeof id !== 'string' || !ids.has(id)) || new Set(raw.outbox).size !== raw.outbox.length) {
      throw new Error('Invalid sync outbox');
    }
    const applied: SyncApplied[] = [];
    for (const a of raw.applied) {
      if (!isObject(a) || typeof a.entryId !== 'string' || !SYNC_UUID.test(a.entryId)
        || typeof a.revisionId !== 'string' || !SYNC_HASH.test(a.revisionId)
        || a.digest !== null && (typeof a.digest !== 'string' || !SYNC_HASH.test(a.digest))) throw new Error('Invalid applied sync revision');
      const revision = this.index.revision(a.revisionId) ?? this.retiredRevision(a.revisionId) ?? this.remoteRevision(a.revisionId);
      if (!revision || revision.entryId !== a.entryId || (revision.op === 'delete') !== (a.digest === null)) throw new Error('Unknown applied sync revision');
      applied.push({ entryId: a.entryId, revisionId: a.revisionId, digest: a.digest as string | null });
    }
    if (new Set(applied.map(a => a.entryId)).size !== applied.length || !raw.binding && applied.length) throw new Error('Invalid applied sync entries');
    const sources: SyncLocalSource[] = [];
    for (const source of (raw.sources ?? []) as unknown[]) {
      if (!sourceValid(source) || (this.index.revision(source.revisionId) ?? this.retiredRevision(source.revisionId) ?? this.remoteRevision(source.revisionId))?.op !== 'put') throw new Error('Invalid local sync source');
      sources.push({ revisionId: source.revisionId, path: source.path, metadata: source.metadata });
    }
    if (new Set(sources.map(s => s.revisionId)).size !== sources.length) throw new Error('Duplicate local sync source');
    const deferred = raw.deferred === undefined ? [] : raw.deferred;
    if (!Array.isArray(deferred) || deferred.length > 2000 || new Set(deferred).size !== deferred.length
      || deferred.some(id => typeof id !== 'string' || !this.index.heads().some(h => h.entryId === id) && !applied.some(a => a.entryId === id))
      || !raw.binding && deferred.length) throw new Error('Invalid deferred sync entries');
    const watch = raw.watch === undefined ? { enabled: false, pending: [] } : raw.watch;
    if (!isObject(watch) || typeof watch.enabled !== 'boolean' || !Array.isArray(watch.pending) || watch.pending.length > 2000
      || watch.pending.some(p => !validSyncRelativePath(p)) || new Set(watch.pending).size !== watch.pending.length
      || !raw.binding && (watch.enabled || watch.pending.length)) throw new Error('Invalid local publication queue');
    this.archived = log.slice(0, archived.length);
    this.decodedLogBytes = jsonBytes(log);
    // Keep the verified normalized archive; raw extension fields cannot survive into future writes.
    const archive = archived.length ? packSyncLog(this.archived) : undefined;
    this.snapshot = { ...this.snapshot, v: raw.v >= 3 ? raw.v : archive ? 2 : 1, ...(archive ? { archive } : {}), ...(raw.v >= 3 ? { retired: retiredPacks } : {}), ...(raw.v === 4 ? { history } : {}), log: log.slice(archived.length), outbox: [...raw.outbox] as string[],
      binding: raw.binding ? { path: raw.binding.path, autoApply: raw.binding.autoApply } : null, applied, sources,
      watch: { enabled: watch.enabled, pending: [...watch.pending] as string[] }, bindingEpoch: (raw.bindingEpoch as number | undefined) ?? 0,
      cacheLimitBytes: (raw.cacheLimitBytes as number | undefined) ?? this.snapshot.cacheLimitBytes, deferred: [...deferred],
      backups: raw.backups === undefined ? this.snapshot.backups : { ...raw.backups as SyncBackupPolicy }, exclusions: [...(raw.exclusions as string[] | undefined ?? [])],
      ...(raw.trashExports === undefined ? {} : { trashExports: structuredClone(raw.trashExports as SyncTrashExportReceipt[]) }) };
  }

  private ready(): void { if (this.failed) throw new Error('Sync storage write failed; reopen the index before continuing'); }

  private commit(next: Snapshot, index = this.index): void {
    this.ready();
    if (jsonBytes(next) > SYNC_STORE_BYTES) throw new Error('Sync snapshot capacity reached');
    // Compression never expands the admitted history or bypasses decode/replay budgets.
    const decodedBytes = next.log === this.snapshot.log ? this.decodedLogBytes : jsonBytes([...this.archived, ...next.log]);
    if (decodedBytes > SYNC_LOG_DECODE_BYTES) throw new Error('Sync log decoded capacity reached');
    try { this.persistence.write(structuredClone(next)); }
    catch (error) { this.failed = true; throw error; }
    if (index !== this.index) this.logEpoch++;
    this.snapshot = next; this.index = index;
    this.decodedLogBytes = decodedBytes;
  }

  policy(): SyncPolicy | null { this.ready(); return this.index.policy(); }
  revision(id: string): SyncRevision | undefined { this.ready(); return this.index.revision(id) ?? this.retiredRevision(id) ?? this.remoteRevision(id); }
  checkpoint(): SyncPolicy | null { this.ready(); return this.index.checkpoint(); }
  isRetiredRevision(id: string): boolean { this.ready(); return (this.retiredIds.has(id) || this.remoteIds.has(id)) && !this.index.revision(id); }
  nextHistoryCheckpoint(): SyncPolicy | null {
    this.ready(); let checkpoint = this.index.checkpoint();
    for (let i = 0; checkpoint && i <= SYNC_CHECKPOINT_ARCHIVES * 2; i++) {
      if (!this.archiveDigests.has(checkpoint.checkpoint!.archiveDigest)) return checkpoint;
      const previous = checkpoint.checkpoint!.parentCheckpointId;
      if (!previous) return null;
      checkpoint = this.checkpoints.get(previous) ?? null;
      if (!checkpoint) throw new Error('Incomplete verified history chain');
    }
    if (checkpoint) throw new Error('History chain capacity reached');
    return null;
  }
  exportHistory(digest: string): SyncLogPack | undefined {
    this.ready(); const found = this.archiveDigests.get(digest);
    return found && structuredClone(found.remote ? this.snapshot.history![found.ordinal].pack : this.snapshot.retired![found.ordinal]);
  }
  importedHistoryCount(): number { this.ready(); return this.snapshot.history?.length ?? 0; }
  importHistory(checkpointId: string, pack: SyncLogPack): number {
    this.ready(); const checkpoint = this.index.checkpoint()?.policyId === checkpointId ? this.index.checkpoint()! : this.checkpoints.get(checkpointId);
    if (!checkpoint) throw new Error('Unknown history checkpoint');
    const records = this.verifyHistory(checkpoint, pack), digest = checkpoint.checkpoint!.archiveDigest;
    if (this.archiveDigests.has(digest)) return 0;
    const history = this.snapshot.history ?? [];
    if (history.length >= SYNC_CHECKPOINT_ARCHIVES) throw new Error('Downloaded history archive capacity reached');
    this.commit({ ...this.snapshot, v: 4, retired: this.snapshot.retired ?? [], history: [...history, { checkpointId, pack: packSyncLog(records) }] });
    this.catalogRemote(history.length, records); this.checkpoints.set(checkpointId, checkpoint); this.remoteCache = undefined;
    return records.filter(r => r.kind === 'revision').length;
  }
  heads(): ReturnType<FileSyncIndex['heads']> { this.ready(); return this.index.heads(); }
  pathConflicts(): ReturnType<FileSyncIndex['pathConflicts']> { this.ready(); return this.index.pathConflicts(); }
  binding(): SyncBinding | null { this.ready(); return structuredClone(this.snapshot.binding); }
  bindingEpoch(): number { this.ready(); return this.snapshot.bindingEpoch; }
  exclusions(): string[] { this.ready(); return [...this.snapshot.exclusions]; }
  setExclusions(rules: string[]): void {
    this.ready();
    if (!this.snapshot.binding || !validSyncExclusions(rules)) throw new Error('Invalid sync exclusions');
    if (JSON.stringify(rules) === JSON.stringify(this.snapshot.exclusions)) return;
    if (this.snapshot.bindingEpoch >= Number.MAX_SAFE_INTEGER) throw new Error('Sync binding generation limit reached');
    // Revoke in-flight disk authority and stale previews without forgetting valid applied fingerprints.
    this.commit({ ...this.snapshot, exclusions: [...rules], bindingEpoch: this.snapshot.bindingEpoch + 1,
      watch: { ...this.snapshot.watch, pending: this.snapshot.watch.pending.filter(p => !syncPathExclusion(p, rules)) } });
  }
  applied(): SyncApplied[] { this.ready(); return structuredClone(this.snapshot.applied); }
  deferred(): string[] { this.ready(); return [...this.snapshot.deferred]; }
  defer(entryId: string): void {
    this.ready();
    if (!this.snapshot.binding || !this.index.heads().some(h => h.entryId === entryId)) throw new Error('Unknown deferred sync file');
    if (!this.snapshot.deferred.includes(entryId)) this.commit({ ...this.snapshot, deferred: [...this.snapshot.deferred, entryId] });
  }
  sources(): SyncLocalSource[] { this.ready(); return structuredClone(this.snapshot.sources); }
  trashExports(): SyncTrashExportReceipt[] { this.ready(); return structuredClone(this.snapshot.trashExports ?? []); }
  rememberTrashExport(receipt: SyncTrashExportReceipt): void {
    this.ready();
    if (!trashExportValid(receipt) || receipt.folder !== this.snapshot.binding?.path || this.revision(receipt.revisionId)?.op !== 'delete') throw new Error('Invalid trash export receipt');
    const receipts = (this.snapshot.trashExports ?? []).filter(r => r.folder !== receipt.folder || r.operationId !== receipt.operationId);
    if (receipts.length >= SYNC_TRASH_EXPORT_LIMIT) throw new Error('Trash export receipt capacity reached');
    this.commit({ ...this.snapshot, trashExports: [...receipts, structuredClone(receipt)] });
  }
  forgetTrashExports(folder: string, operationIds: string[]): void {
    this.ready(); const removed = new Set(operationIds), current = this.snapshot.trashExports ?? [];
    const remaining = current.filter(r => r.folder !== folder || !removed.has(r.operationId));
    if (remaining.length !== current.length) this.commit({ ...this.snapshot, trashExports: remaining });
  }
  logGeneration(): number { this.ready(); return this.logEpoch; }
  cacheLimit(): number { this.ready(); return this.snapshot.cacheLimitBytes; }
  backupPolicy(): SyncBackupPolicy { this.ready(); return { ...this.snapshot.backups }; }
  setBackupPolicy(policy: SyncBackupPolicy): void {
    this.ready();
    if (!validSyncBackupPolicy(policy) || policy.enabled && !this.snapshot.binding) throw new Error('Invalid backup retention policy');
    this.commit({ ...this.snapshot, backups: { enabled: policy.enabled, keepVersions: policy.keepVersions, maxAgeDays: policy.maxAgeDays, limitBytes: policy.limitBytes } });
  }
  setCacheLimit(bytes: number): void {
    if (!validSyncCacheLimit(bytes)) throw new Error('Invalid sync cache limit');
    this.commit({ ...this.snapshot, cacheLimitBytes: bytes });
  }
  forgetSources(ids: string[]): void {
    const removed = new Set(ids);
    this.commit({ ...this.snapshot, sources: this.snapshot.sources.filter(s => !removed.has(s.revisionId)) });
  }
  watch(): { enabled: boolean; pending: string[] } { this.ready(); return structuredClone(this.snapshot.watch); }
  setAutoPublish(enabled: boolean): void {
    this.ready(); if (typeof enabled !== 'boolean' || !this.snapshot.binding) throw new Error('A local sync binding is required');
    this.commit({ ...this.snapshot, watch: { ...this.snapshot.watch, enabled } });
  }
  enqueuePublications(paths: string[]): void {
    this.ready(); if (!this.snapshot.binding || paths.some(p => !validSyncRelativePath(p))) throw new Error('Invalid local publication path');
    const pending = [...new Set([...this.snapshot.watch.pending, ...paths])];
    if (pending.length > 2000) throw new Error('Local sync queue capacity reached');
    if (pending.length !== this.snapshot.watch.pending.length) this.commit({ ...this.snapshot, watch: { ...this.snapshot.watch, pending } });
  }
  completePublication(relativePath: string): void {
    this.ready(); const pending = this.snapshot.watch.pending.filter(p => p !== relativePath);
    if (pending.length !== this.snapshot.watch.pending.length) this.commit({ ...this.snapshot, watch: { ...this.snapshot.watch, pending } });
  }
  outbox(): SyncRecord[] {
    this.ready(); const ids = new Set(this.snapshot.outbox);
    return this.historyRecords().filter(record => ids.has(recordId(record)));
  }
  pendingRecordIds(): string[] { this.ready(); return [...this.snapshot.outbox]; }
  records(): SyncRecord[] { this.ready(); return structuredClone([...this.archived, ...this.snapshot.log]); }
  private *epochsNewest(): Generator<SyncRecord[]> {
    yield [...this.archived, ...this.snapshot.log];
    const epochs = (this.snapshot.retired ?? []).map((pack, ordinal) => ({ pack, generation: this.retiredGenerations.get(ordinal) ?? 0, local: true }));
    for (const h of this.snapshot.history ?? []) epochs.push({ pack: h.pack, generation: this.checkpoints.get(h.checkpointId)!.checkpoint!.generation - 1, local: false });
    epochs.sort((a, b) => b.generation - a.generation || Number(b.local) - Number(a.local));
    for (const epoch of epochs) yield unpackSyncLog(epoch.pack);
  }
  historyPage(entryId: string, offset: number, limit = 50): { items: SyncRevision[]; path: string | null; more: boolean } {
    this.ready();
    if (!SYNC_UUID.test(entryId) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid sync history page');
    const seen = new Set<string>(), items: SyncRevision[] = []; let skipped = 0, latest: string | null = null;
    for (const epoch of this.epochsNewest()) for (let i = epoch.length - 1; i >= 0; i--) {
      const r = epoch[i], revisions = r.kind === 'revision' ? [r.value] : r.value.checkpoint?.anchors ?? [];
      for (const revision of revisions) {
        if (revision.entryId !== entryId || seen.has(revision.revisionId)) continue;
        seen.add(revision.revisionId); latest ??= revision.relativePath;
        if (skipped++ < offset) continue;
        if (items.length === limit) return { items, path: latest, more: true };
        items.push(structuredClone(revision));
      }
    }
    return { items, path: latest, more: false };
  }
  historicalPaths(entryIds: string[]): Array<{ entryId: string; path: string }> {
    this.ready(); const entries = new Set(entryIds), paths = new Map<string, { entryId: string; path: string }>();
    for (const epoch of this.epochsNewest()) for (const r of epoch) {
      const origins = r.kind === 'revision' ? [{ entryId: r.value.entryId, path: r.value.relativePath }] : r.value.checkpoint?.origins ?? [];
      for (const o of origins) if (entries.has(o.entryId)) {
        paths.set(o.entryId + ':' + o.path, { entryId: o.entryId, path: o.path });
        if (paths.size > 4096) throw new Error('Checkpoint path history capacity reached');
      }
    }
    return [...paths.values()].sort((a, b) => a.entryId.localeCompare(b.entryId) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  historyRecords(): SyncRecord[] {
    this.ready(); const records = new Map<string, SyncRecord>();
    for (const segment of this.epochsNewest()) for (const r of segment) {
      records.set(recordId(r), r);
      if (r.kind === 'policy') for (const a of r.value.checkpoint?.anchors ?? []) records.set(a.revisionId, { kind: 'revision', value: a });
    }
    return structuredClone([...records.values()]);
  }
  retiredCount(): number { this.ready(); return this.snapshot.retired?.length ?? 0; }
  metadataBundle(): SyncMetadataBundle {
    this.ready();
    const { scope, rootId, ownerId, e2e } = this.index.context;
    const portable = (pack: SyncLogPack) => packSyncLog(unpackSyncLog(pack).map(copySyncRecord));
    return structuredClone({ format: 'havvn-file-sync-history', v: 1, context: { scope, rootId, ownerId, e2e }, active: packSyncLog(this.records()),
      retired: (this.snapshot.retired ?? []).map(portable), history: (this.snapshot.history ?? []).map(h => ({ checkpointId: h.checkpointId, pack: portable(h.pack) })) });
  }
  metadataHistoryStamp(): string {
    this.ready(); return crypto.createHash('sha256').update(JSON.stringify([this.records(), this.snapshot.retired ?? [], this.snapshot.history ?? []])).digest('hex');
  }
  private metadataStamp(): string { return crypto.createHash('sha256').update(JSON.stringify(this.snapshot)).digest('hex'); }
  private metadataCandidate(remove: Set<string>): Snapshot {
    return { ...this.snapshot, ...(this.snapshot.v >= 3 ? { retired: (this.snapshot.retired ?? []).filter(p => !remove.has(p.digest)) } : {}),
      ...(this.snapshot.v === 4 ? { history: this.snapshot.history!.filter(h => !remove.has(h.pack.digest)) } : {}) };
  }
  private verifyMetadataSnapshot(snapshot: Snapshot): RoomSyncStore {
    return new RoomSyncStore({ read: () => structuredClone(snapshot), write: () => { throw new Error('Read-only metadata verification'); } }, this.snapshot.context.localRoomId, this.index.context);
  }
  prepareMetadata(keep: number, recovery: (candidate: SyncMetadataProofStore) => boolean = () => true, pinned: string[] = []): SyncMetadataPlan {
    this.ready(); if (!Number.isSafeInteger(keep) || keep < 0 || keep > SYNC_CHECKPOINT_ARCHIVES) throw new Error('Invalid retained history count');
    const epochs: SyncMetadataView['epochs'] = [];
    const packs = [...(this.snapshot.retired ?? []).map(pack => ({ pack, source: 'retired' as const })),
      ...(this.snapshot.history ?? []).map(h => ({ pack: h.pack, source: 'downloaded' as const }))];
    const records = new Map<string, Set<string>>(), checkpoints = new Map<string, string[]>();
    for (const { pack, source } of packs) {
      const log = unpackSyncLog(pack), first = log[0]; records.set(pack.digest, new Set(log.flatMap(r => [recordId(r), ...(r.kind === 'policy' ? r.value.checkpoint?.anchors.map(a => a.revisionId) ?? [] : [])])));
      checkpoints.set(pack.digest, log.filter(r => r.kind === 'policy' && r.value.checkpoint).map(recordId));
      epochs.push({ digest: pack.digest, generation: first.kind === 'policy' ? first.value.checkpoint?.generation ?? 0 : 0,
        records: log.length, bytes: jsonBytes(pack), source, remove: false, reason: 'keep' });
    }
    const retained = new Set<string>();
    for (const source of ['retired', 'downloaded']) for (const e of epochs.filter(e => e.source === source).sort((a, b) => b.generation - a.generation || b.digest.localeCompare(a.digest)).slice(0, keep)) retained.add(e.digest);
    const removed = new Set<string>();
    for (const epoch of [...epochs].sort((a, b) => a.generation - b.generation || a.digest.localeCompare(b.digest))) {
      if (retained.has(epoch.digest)) continue;
      const ids = records.get(epoch.digest)!;
      // Retained sources remain owned by cache management; metadata never orphans payloads.
      const checks = [['pending', this.snapshot.outbox], ['source', this.snapshot.sources.map(s => s.revisionId)], ['applied', this.snapshot.applied.map(a => a.revisionId)], ['recovery', pinned]] as const;
      const remainingIds = new Set(this.records().flatMap(r => [recordId(r), ...(r.kind === 'policy' ? r.value.checkpoint?.anchors.map(a => a.revisionId) ?? [] : [])]));
      for (const other of epochs) if (other.digest !== epoch.digest && !removed.has(other.digest)) for (const id of records.get(other.digest)!) remainingIds.add(id);
      const blocked = checks.find(([, references]) => references.some(id => ids.has(id) && !remainingIds.has(id)));
      if (blocked) { epoch.reason = blocked[0]; continue; }
      const trial = new Set([...removed, epoch.digest]);
      const availableCheckpoints = new Set(this.records().filter(r => r.kind === 'policy' && r.value.checkpoint).map(recordId));
      for (const pack of this.snapshot.retired ?? []) if (!trial.has(pack.digest)) for (const id of checkpoints.get(pack.digest)!) availableCheckpoints.add(id);
      let chain = true;
      for (const h of this.snapshot.history ?? []) if (!trial.has(h.pack.digest)) {
        if (!availableCheckpoints.has(h.checkpointId)) { chain = false; break; }
        for (const id of checkpoints.get(h.pack.digest)!) availableCheckpoints.add(id);
      }
      if (!chain) { epoch.reason = 'chain'; continue; }
      // All records were verified on admission. A filtered read view avoids replaying
      // every signature once per candidate; the complete result is replayed once below.
      const candidate: SyncMetadataProofStore = { revision: id => remainingIds.has(id) ? this.revision(id) : undefined, checkpoint: () => this.checkpoint() };
      if (!recovery(candidate)) { epoch.reason = 'recovery'; continue; }
      removed.add(epoch.digest); epoch.remove = true; epoch.reason = 'remove';
    }
    if (removed.size) this.verifyMetadataSnapshot(this.metadataCandidate(removed));
    return { stamp: this.metadataStamp(), historyStamp: this.metadataHistoryStamp(), keep, remove: [...removed], beforeBytes: jsonBytes(this.snapshot),
      afterBytes: jsonBytes(this.metadataCandidate(removed)), epochs };
  }
  confirmMetadata(plan: SyncMetadataPlan, recovery: (candidate: SyncMetadataProofStore) => boolean = () => true, pinned: string[] = []): void {
    this.ready();
    if (plan.stamp !== this.metadataStamp()) throw new Error('Sync metadata changed; review again');
    const fresh = this.prepareMetadata(plan.keep, recovery, pinned);
    if (!plan.remove.length || JSON.stringify(fresh.remove) !== JSON.stringify(plan.remove)) throw new Error('Sync metadata protection changed; review again');
    const next = this.metadataCandidate(new Set(plan.remove));
    this.commit(next); this.rebuildMetadataCatalogs(); this.logEpoch++;
  }
  private rebuildMetadataCatalogs(): void {
    this.retiredIds.clear(); this.remoteIds.clear(); this.archiveDigests.clear(); this.checkpoints.clear(); this.retiredGenerations.clear();
    this.retiredCache = undefined; this.remoteCache = undefined;
    for (const [ordinal, pack] of (this.snapshot.retired ?? []).entries()) this.catalogArchive(ordinal, unpackSyncLog(pack));
    for (const r of this.records()) if (r.kind === 'policy' && r.value.checkpoint) this.checkpoints.set(r.value.policyId, r.value);
    for (const [ordinal, h] of (this.snapshot.history ?? []).entries()) this.catalogRemote(ordinal, unpackSyncLog(h.pack));
  }
  importMetadata(value: unknown): number {
    this.ready(); const bundle = value as SyncMetadataBundle;
    if (!isObject(bundle) || bundle.format !== 'havvn-file-sync-history' || bundle.v !== 1 || jsonBytes(bundle) > SYNC_STORE_BYTES * 2
      || Object.keys(bundle).some(k => !['format', 'v', 'context', 'active', 'retired', 'history'].includes(k)) || !isObject(bundle.context)
      || Object.keys(bundle.context).some(k => !['scope', 'rootId', 'ownerId', 'e2e'].includes(k))
      || Object.entries(this.index.context).some(([key, value]) => (bundle.context as unknown as Record<string, unknown>)[key] !== value)
      || !Array.isArray(bundle.retired) || bundle.retired.length > SYNC_CHECKPOINT_ARCHIVES
      || !Array.isArray(bundle.history) || bundle.history.length > SYNC_CHECKPOINT_ARCHIVES) throw new Error('Invalid or foreign sync history export');
    // Validate every epoch, even duplicates, before considering any durable change.
    const decoded = [...bundle.retired, bundle.active, ...bundle.history.map(h => h?.pack)].map(pack => {
      const records = unpackSyncLog(pack); replayLog(records, this.index.context); return { records: records.map(copySyncRecord) };
    });
    const before = new Set(this.historyRecords().map(recordId)), known = new Set(before), retired = [...(this.snapshot.retired ?? [])];
    for (const item of decoded.slice(0, bundle.retired.length + 1)) {
      if (item.records.every(r => known.has(recordId(r)))) continue;
      if (retired.length >= SYNC_CHECKPOINT_ARCHIVES) throw new Error('Sync checkpoint archive capacity reached');
      retired.push(packSyncLog(item.records)); item.records.forEach(r => known.add(recordId(r)));
    }
    const next: Snapshot = { ...this.snapshot, v: this.snapshot.v === 4 ? 4 : 3, retired };
    // A writable temporary store performs normal chain verification and capacity checks.
    let staged = next;
    const candidate = new RoomSyncStore({ read: () => structuredClone(staged), write: s => { staged = structuredClone(s) as Snapshot; } }, this.snapshot.context.localRoomId, this.index.context);
    for (const h of bundle.history) {
      if (!isObject(h) || typeof h.checkpointId !== 'string' || !SYNC_HASH.test(h.checkpointId) || Object.keys(h).some(k => !['checkpointId', 'pack'].includes(k))) throw new Error('Invalid exported history checkpoint');
      candidate.importHistory(h.checkpointId, h.pack);
    }
    const added = candidate.historyRecords().filter(r => !before.has(recordId(r))).length;
    if (!added) return 0;
    this.verifyMetadataSnapshot(staged); this.commit(staged); this.rebuildMetadataCatalogs(); this.logEpoch++; return added;
  }
  logSummary(): SyncLogSummary {
    this.ready(); const records = [...this.archived, ...this.snapshot.log];
    const policies = records.filter(r => r.kind === 'policy').length;
    return { records: records.length, policies, revisions: records.length - policies + (this.index.checkpoint()?.checkpoint?.anchors.length ?? 0), archived: this.archived.length, pending: this.snapshot.log.length,
      storedBytes: jsonBytes({ ...(this.snapshot.archive ? { archive: this.snapshot.archive } : {}), log: this.snapshot.log }),
      decodedBytes: this.decodedLogBytes, revisionLimit: SYNC_REVISION_LIMIT, policyLimit: SYNC_POLICY_LIMIT, decodedLimitBytes: SYNC_LOG_DECODE_BYTES };
  }
  prepareLogCompaction(): { generation: number; digest: string; archive: SyncLogPack; summary: SyncLogSummary; afterBytes: number; savedBytes: number } {
    this.ready(); const records = this.records();
    const archive = packSyncLog(records), summary = this.logSummary(), afterBytes = jsonBytes({ archive, log: [] });
    return { generation: this.logEpoch, digest: archive.digest, archive, summary, afterBytes, savedBytes: Math.max(0, summary.storedBytes - afterBytes) };
  }
  compactLog(plan: ReturnType<RoomSyncStore['prepareLogCompaction']>): SyncLogSummary {
    this.ready();
    if (this.logEpoch !== plan.generation || crypto.createHash('sha256').update(JSON.stringify(this.records())).digest('hex') !== plan.digest) throw new Error('Sync log changed; review compaction again');
    const decoded = unpackSyncLog(plan.archive);
    if (JSON.stringify(decoded) !== JSON.stringify(this.records())) throw new Error('Sync compaction does not preserve the log');
    const summary = this.logSummary();
    if (jsonBytes({ archive: plan.archive, log: [] }) >= summary.storedBytes) throw new Error('Sync log already compact; no storage saving');
    // Re-verify every proof before the only durable replacement. Disk files and local consent are untouched.
    const verified = new FileSyncIndex(this.index.context, verifySyncProof);
    for (const r of decoded) {
      if (r.kind === 'policy') verified.acceptPolicy(r.value);
      else verified.acceptRevision(r.value);
    }
    const previous = this.archived;
    // commit's capacity check must use the replacement archive, restored on any failure.
    this.archived = decoded;
    try { this.commit({ ...this.snapshot, v: this.snapshot.v >= 3 ? this.snapshot.v : 2, archive: structuredClone(plan.archive), log: [] }, verified); }
    catch (error) { this.archived = previous; throw error; }
    return this.logSummary();
  }
  private policyTransition(next: FileSyncIndex): Partial<Snapshot> {
    if (!this.snapshot.binding || (next.policy()?.v ?? 1) < 2 || next.policy()?.policyId === this.index.policy()?.policyId) return {};
    if (this.snapshot.bindingEpoch >= Number.MAX_SAFE_INTEGER) throw new Error('Sync binding generation limit reached');
    const deferred = new Set(this.snapshot.deferred);
    for (const applied of this.snapshot.applied) if (!next.includesApplied(applied.entryId, applied.revisionId)) deferred.add(applied.entryId);
    if (deferred.size > 2000) throw new Error('Too many local sync conflicts; review before changing rights');
    // A checkpoint can exclude offline branches. Keep their fingerprints, snapshots and working files,
    // revoke in-flight writes and require deliberate local resumption after every rights change.
    return { binding: { ...this.snapshot.binding, autoApply: false }, watch: { ...this.snapshot.watch, enabled: false },
      bindingEpoch: this.snapshot.bindingEpoch + 1, deferred: [...deferred] };
  }
  acceptRecords(records: SyncRecord[]): void {
    this.ready();
    const next = this.index.clone(), accepted: SyncRecord[] = [];
    let checkpoint: SyncPolicy | undefined;
    for (const record of records) {
      if (record.kind === 'policy') {
        if (next.acceptPolicy(record.value) === 'accepted') {
          if (record.value.checkpoint) {
            if (accepted.length || records[0] !== record) throw new Error('Sync checkpoint must start a page');
            checkpoint = next.policy()!;
          }
          accepted.push({ kind: 'policy', value: next.policy()! });
        }
      } else if (record.kind === 'revision') {
        if (next.acceptRevision(record.value) === 'accepted') accepted.push({ kind: 'revision', value: next.revision(record.value.revisionId)! });
      } else throw new Error('Invalid sync batch record');
    }
    if (checkpoint) this.commitCheckpoint(next, checkpoint, accepted, false);
    else if (accepted.length) this.commit({ ...this.snapshot, ...this.policyTransition(next), log: [...this.snapshot.log, ...accepted] }, next);
  }
  acknowledgeMany(ids: string[]): void {
    this.ready(); const confirmed = new Set(ids);
    const outbox = this.snapshot.outbox.filter(id => !confirmed.has(id));
    if (outbox.length !== this.snapshot.outbox.length) this.commit({ ...this.snapshot, outbox });
  }

  acceptPolicy(policy: unknown, publish = false): 'accepted' | 'duplicate' {
    this.ready();
    const next = this.index.clone(), result = next.acceptPolicy(policy);
    if (result === 'duplicate') return result;
    const clean = next.policy()!;
    if (clean.checkpoint) {
      this.commitCheckpoint(next, clean, [{ kind: 'policy', value: clean }], publish); return result;
    }
    this.commit({ ...this.snapshot, ...this.policyTransition(next), log: [...this.snapshot.log, { kind: 'policy', value: clean }],
      outbox: publish ? [...this.snapshot.outbox, clean.policyId] : this.snapshot.outbox }, next);
    return result;
  }
  private commitCheckpoint(next: FileSyncIndex, clean: SyncPolicy, records: SyncRecord[], publish: boolean): void {
      const current = this.records(), retired = [...(this.snapshot.retired ?? [])];
      if (current.length) {
        if (retired.length >= SYNC_CHECKPOINT_ARCHIVES) throw new Error('Sync checkpoint archive capacity reached');
        if (publish && (clean.checkpoint!.archiveDigest !== syncLogCommitment(current) || clean.checkpoint!.archiveRecords !== current.length)) throw new Error('Checkpoint archive commitment changed');
        retired.push(packSyncLog(current));
      }
      const previous = this.archived; this.archived = [];
      try { this.commit({ ...this.snapshot, ...this.policyTransition(next), v: this.snapshot.v === 4 ? 4 : 3, archive: undefined, retired, log: records,
        outbox: publish ? [...this.snapshot.outbox, clean.policyId] : this.snapshot.outbox }, next); }
      catch (error) { this.archived = previous; throw error; }
      if (current.length) this.catalogArchive(retired.length - 1, current);
      this.checkpoints.set(clean.policyId, clean);
      this.retiredCache = undefined;
  }

  acceptRevision(revision: unknown, publish = false, localDigest?: string, source?: Omit<SyncLocalSource, 'revisionId'>): 'accepted' | 'duplicate' {
    this.ready();
    const next = this.index.clone(), result = next.acceptRevision(revision);
    if (result === 'duplicate') return result;
    const clean = next.revision((revision as SyncRevision).revisionId)!;
    if (localDigest !== undefined && (!publish || !this.snapshot.binding || typeof localDigest !== 'string' || !SYNC_HASH.test(localDigest) || clean.op !== 'put')) {
      throw new Error('Invalid local publication fingerprint');
    }
    const localSource = source && { revisionId: clean.revisionId, path: source.path, metadata: source.metadata };
    if (localSource && (!publish || !sourceValid(localSource))) throw new Error('Invalid local sync source');
    this.commit({ ...this.snapshot, log: [...this.snapshot.log, { kind: 'revision', value: clean }],
      outbox: publish ? [...this.snapshot.outbox, clean.revisionId] : this.snapshot.outbox,
      applied: localDigest === undefined ? this.snapshot.applied : [...this.snapshot.applied.filter(a => a.entryId !== clean.entryId),
        { entryId: clean.entryId, revisionId: clean.revisionId, digest: localDigest }],
      sources: localSource ? [...this.snapshot.sources, localSource] : this.snapshot.sources,
      watch: publish ? { ...this.snapshot.watch, pending: this.snapshot.watch.pending.filter(p => p !== clean.relativePath) } : this.snapshot.watch }, next);
    return result;
  }

  acknowledge(id: string): void {
    this.ready();
    if (!this.snapshot.outbox.includes(id)) return;
    this.commit({ ...this.snapshot, outbox: this.snapshot.outbox.filter(value => value !== id) });
  }

  retainSource(revisionId: string, source: Omit<SyncLocalSource, 'revisionId'>): void {
    this.ready();
    const clean = { revisionId, path: source.path, metadata: source.metadata };
    if (!sourceValid(clean) || this.revision(revisionId)?.op !== 'put') throw new Error('Invalid retained sync source');
    this.commit({ ...this.snapshot, sources: [...this.snapshot.sources.filter(s => s.revisionId !== revisionId), clean] });
  }

  /** Every new path starts disabled and forgets the old path's applied fingerprints. */
  bind(localPath: string | null): void {
    this.ready();
    if (localPath !== null && !bindingValid({ path: localPath, autoApply: false })) throw new Error('Invalid local sync binding');
    if (this.snapshot.bindingEpoch >= Number.MAX_SAFE_INTEGER) throw new Error('Sync binding generation limit reached');
    this.commit({ ...this.snapshot, binding: localPath === null ? null : { path: path.resolve(localPath), autoApply: false },
      applied: [], deferred: [], exclusions: [], backups: { ...this.snapshot.backups, enabled: false }, watch: { enabled: false, pending: [] }, bindingEpoch: this.snapshot.bindingEpoch + 1 });
  }
  setAutoApply(enabled: boolean): void {
    this.ready();
    if (typeof enabled !== 'boolean' || !this.snapshot.binding) throw new Error('A local sync binding is required');
    this.commit({ ...this.snapshot, binding: { ...this.snapshot.binding, autoApply: enabled } });
  }
  setAutomaticMode(publish: boolean, apply: boolean): void {
    this.ready();
    if (!this.snapshot.binding || typeof publish !== 'boolean' || typeof apply !== 'boolean') throw new Error('A local sync binding is required');
    this.commit({ ...this.snapshot, binding: { ...this.snapshot.binding, autoApply: apply }, watch: { ...this.snapshot.watch, enabled: publish } });
  }
  markApplied(entryId: string, revisionId: string, digest: string | null, resolveDeferred = false): void {
    this.ready();
    const revision = this.revision(revisionId);
    if (!this.snapshot.binding || !revision || revision.entryId !== entryId
      || (revision.op === 'delete') !== (digest === null)
      || digest !== null && (typeof digest !== 'string' || !SYNC_HASH.test(digest))) throw new Error('Invalid applied sync revision');
    const deferred = resolveDeferred ? this.snapshot.deferred.filter(id => id !== entryId) : [...this.snapshot.deferred];
    if (this.index.checkpoint() && !this.index.includesApplied(entryId, revisionId) && !deferred.includes(entryId)) deferred.push(entryId);
    this.commit({ ...this.snapshot, applied: [...this.snapshot.applied.filter(a => a.entryId !== entryId), { entryId, revisionId, digest }], deferred });
  }
}

/** DPAPI/Keychain/libsecret protects paths, filenames and the signature context too. */
export function openRoomSyncStore(directory: string, localRoomId: string, context: SyncIndexContext): RoomSyncStore {
  // Validate before creating any file, including for an absent legacy index.
  new FileSyncIndex(context, verifySyncProof);
  if (!localRoomId || localRoomId.length > 256) throw new Error('Invalid local room ID');
  const name = 'room-sync-' + crypto.createHash('sha256').update(JSON.stringify([localRoomId, context.rootId])).digest('hex');
  const backend = new Store<{ snapshot: string }>({ cwd: directory, name, clearInvalidConfig: false });
  return new RoomSyncStore({
    read: () => {
      if (!backend.has('snapshot')) return undefined;
      const sealed: unknown = backend.get('snapshot');
      if (typeof sealed !== 'string' || sealed.length > SYNC_STORE_BYTES * 2) throw new Error('Invalid protected sync snapshot');
      const plain = decryptSecretStrict(sealed);
      if (Buffer.byteLength(plain) > SYNC_STORE_BYTES) throw new Error('Sync snapshot capacity reached');
      return JSON.parse(plain);
    },
    write: snapshot => backend.set('snapshot', encryptSecret(JSON.stringify(snapshot), false)),
  }, localRoomId, context);
}
