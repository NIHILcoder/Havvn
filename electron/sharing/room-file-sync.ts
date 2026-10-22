import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FileSyncIndex, canWriteSync, syncWriters, validSyncRelativePath, validSyncName, validSyncMovePaths, SYNC_HISTORY_REVISION_LIMIT, SYNC_RECOVERY_OPERATION_LIMIT, type SyncIndexContext, type SyncRecord } from '../../shared/room-file-sync';
import { SYNC_ROOT_LIMIT, validSyncWireBody, validSyncWireVersion, syncHistoryBody, type SyncWireBody, type SyncWireVersion } from '../../shared/room-file-sync-protocol';
import { openRoomSyncStore, type RoomSyncStore } from '../db/room-sync-store';
import { RoomSyncCatalog } from '../db/room-sync-catalog';
import { RoomSyncSession, type SyncSessionOptions, type SyncRestoreGuard, type SyncConflictGuard, type SyncEditorGuard, type SyncMoveGuard, type SyncDeleteGuard, type SyncCheckpointPlan, type SyncPathGuard } from './room-sync-session';
import { syncEditorLanguage, type SyncEditorDraft } from '../../shared/room-file-sync-editor';
import { syncRevisionFile } from './room-sync-session';
import { roomTorrentMetadata } from './room-file-storage';
import { verifySyncProof } from './room-sync-proofs';
import { assertSyncPlainPath } from './room-sync-snapshot';
import type { SyncWorkPriority } from './room-sync-work';
import { RoomSyncExchange } from './room-sync-exchange';
import { RoomSyncHistoryExchange } from './room-sync-history';
import type { SyncHistoryFetchResult } from '../../shared/room-file-sync-ui';
import type { RoomFile } from '../../shared/types';
import type { SyncRootView, SyncFilesPage, SyncFolderChoice, SyncFolderPreview, SyncLocalAction } from '../../shared/room-file-sync-ui';
import type { SyncRightsPreview, SyncWriterCandidate, SyncMovePreview, SyncDeletePreview, SyncLogPreview } from '../../shared/room-file-sync-ui';
import type { SyncPathConflict, SyncPathPreview } from '../../shared/room-file-sync-ui';
import type { SyncMetadataView, SyncMetadataExportResult } from '../../shared/room-file-sync-ui';
import type { SyncMetadataPlan } from '../db/room-sync-store';
import { writeSyncHistoryExport, readSyncHistoryExport } from './room-sync-metadata';
import { RoomSyncWatcher, scanSyncFolder, excludedSyncPath } from './room-sync-watcher';
import { RoomSyncMissing } from './room-sync-missing';
import type { SyncMissingView } from '../../shared/room-file-sync-ui';
import type { SyncTrashView } from '../../shared/room-file-sync-ui';
import type { SyncTrashPlan } from './room-sync-trash-retention';
import { deriveMemberId } from './room-crypto';
import type { SyncHistoryPage, SyncRestorePreview, SyncCacheView, SyncConflictChoice, SyncConflictPreview } from '../../shared/room-file-sync-ui';
import { validSyncCacheLimit } from '../db/room-sync-store';
import { SYNC_CHECKPOINT_ARCHIVES } from '../db/room-sync-store';
import type { SyncCheckpointPreview } from '../../shared/room-file-sync-ui';
import { validSyncBackupPolicy, type SyncBackupPolicy, type SyncBackupPreview } from '../../shared/room-file-sync-backups';
import type { SyncBackupPlan } from './room-sync-backups';
import { syncPathExclusion, validSyncExclusions, type SyncFilterPreview, type SyncFilterRow } from '../../shared/room-file-sync-filters';

export interface SyncSeed { revisionId: string; file: RoomFile; sourcePath: string; metadata: Buffer }
export interface RoomFileSyncOptions {
  roomId: string;
  context: Omit<SyncIndexContext, 'rootId'>;
  directory: string;
  identity: SyncSessionOptions['identity'];
  current(): boolean;
  send(to: string, body: SyncWireBody, version?: SyncWireVersion): Promise<void>;
  seed(rootId: string, source: SyncSeed): Promise<void>;
  fetch(rootId: string, revisionId: string, file: RoomFile, metadata: Buffer): Promise<{ sourcePath: string; metadata: Buffer }>;
  release?(hash: string): Promise<boolean>;
  contentSecret?: () => string;
  resolveSecret?: (epoch: string) => string | undefined;
  forbidden?: string[];
  otherBindings?(rootId?: string): string[];
  writerCandidates?(): SyncWriterCandidate[];
  historyPeers?(): string[];
  warn?(error: unknown): void;
  catalog?: Pick<RoomSyncCatalog, 'roots' | 'add'>;
  openStore?: (context: SyncIndexContext) => RoomSyncStore;
}
type Root = { context: SyncIndexContext; store: RoomSyncStore; session: RoomSyncSession };
const RIGHTS_CHANGED = 'sync-rights-changed';
const overlaps = (a: string, b: string) => {
  const normalize = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  const relative = path.relative(normalize(a), normalize(b));
  return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

/** Main-process room integration; network messages never contain local paths or write consent. */
export class RoomFileSync {
  private roots = new Map<string, Root>();
  private inactiveRoots = new Map<string, Root>();
  private readonly catalog: Pick<RoomSyncCatalog, 'roots' | 'add'>;
  private readonly exchange: RoomSyncExchange;
  private readonly historyExchange: RoomSyncHistoryExchange;
  private historyBusy = false;
  private stopped = false;
  private wireVersions = new Map<string, SyncWireVersion>();
  private timer?: ReturnType<typeof setInterval>;
  private work = new Set<string>();
  private restoreJob?: Promise<void>;
  private retryAt = new Map<string, number>();
  private metadata = new Map<string, { promise: Promise<Buffer>; resolve: (bytes: Buffer) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; retry: ReturnType<typeof setInterval> }>();
  private metadataHints = new Map<string, Buffer>();
  private replies = new Map<string, number>();
  private watchers = new Map<string, RoomSyncWatcher>();
  private missingFiles = new Map<string, RoomSyncMissing>();
  private trashPreviews = new Map<string, { rootId: string; plan: SyncTrashPlan; expires: number }>();
  private closingWatchers = new Set<Promise<void>>();
  private issues = new Map<string, string>();
  private errors = new Map<string, string>();
  private previews = new Map<string, { view: SyncFolderPreview; fingerprint: string; heads: string; expires: number }>();
  private restorePreviews = new Map<string, { rootId: string; guard: SyncRestoreGuard; expires: number }>();
  private conflictPreviews = new Map<string, { rootId: string; guard: SyncConflictGuard; expires: number }>();
  private maintenance = new Set<string>();
  private cacheJobs = new Map<string, Promise<void>>();
  private backupPreviews = new Map<string, { rootId: string; plan: SyncBackupPlan; expires: number }>();
  private backupJobs = new Map<string, Promise<void>>();
  private backupAt = new Map<string, number>();
  private filterPreviews = new Map<string, { view: SyncFilterPreview; rows: SyncFilterRow[]; fingerprint: string; context: string; expires: number }>();
  private rightsPreviews = new Map<string, { rootId: string; writers: string[]; moves: boolean; deletes: boolean; stamp: string; candidates: string; expires: number }>();
  private deletePreviews = new Map<string, { rootId: string; guard: SyncDeleteGuard; expires: number; missingStamp?: string; missingCurrent?: () => boolean }>();
  private editorDrafts = new Map<string, { rootId: string; guard: SyncEditorGuard; expires: number }>();
  private movePreviews = new Map<string, { rootId: string; guard: SyncMoveGuard; expires: number }>();
  private pathPreviews = new Map<string, { rootId: string; guard: SyncPathGuard; expires: number }>();
  private metadataPreviews = new Map<string, { rootId: string; plan: SyncMetadataPlan; recoveryStamp: string; expires: number }>();
  private metadataExports = new Map<string, { stamp: string; path: string; digest: string }>();
  private logPreviews = new Map<string, { rootId: string; plan: ReturnType<RoomSyncStore['prepareLogCompaction']>; expires: number }>();
  private checkpointPreviews = new Map<string, { rootId: string; plan: SyncCheckpointPlan; expires: number }>();

  constructor(private readonly options: RoomFileSyncOptions) {
    this.catalog = options.catalog ?? new RoomSyncCatalog(options.directory, options.roomId);
    for (const context of this.catalog.roots()) (this.matches(context) ? this.roots : this.inactiveRoots).set(context.rootId, this.open(context));
    this.exchange = new RoomSyncExchange({
      roots: () => [...this.roots.keys()], records: id => this.roots.get(id)?.store.records(),
      current: () => this.current(), send: (to, body) => this.send(to, body),
      accept: async (id, records, from, streamId) => {
        const version = this.wireVersions.get(from + ':' + id + ':' + streamId) ?? 1;
        if (records.some(r => r.value.v > version)) throw new Error('Sync record exceeds its signed transport version');
        this.accept(id, records); this.schedule(id);
      },
      acknowledge: (id, ids) => { this.roots.get(id)?.store.acknowledgeMany(ids); void this.trimCache(id); },
    });
    this.historyExchange = new RoomSyncHistoryExchange({ current: () => this.current(), peers: options.historyPeers,
      send: (to, body) => this.options.send(to, body, 5), export: (id, digest) => this.roots.get(id)?.store.exportHistory(digest),
      accept: (id, checkpointId, pack) => { this.check(); const root = this.roots.get(id); if (!root) throw new Error('Unknown history root'); return root.store.importHistory(checkpointId, pack); } });
    if (this.roots.size) this.startTimer();
  }
  current(): boolean { return !this.stopped && this.options.current(); }
  private check(): void { if (!this.current()) throw new Error('Room file sync is paused'); }
  private send(to: string, body: SyncWireBody): Promise<void> {
    const reply = body.kind === 'request' || body.kind === 'part-request' || body.kind === 'ack';
    const version = Math.max(this.roots.get(body.rootId)?.store.policy()?.v ?? 1, reply ? this.wireVersions.get(to + ':' + body.rootId + ':' + body.streamId) ?? 1 : 1) as SyncWireVersion;
    return this.options.send(to, body, version);
  }
  private matches(c: SyncIndexContext): boolean {
    return c.scope === this.options.context.scope && c.ownerId === this.options.context.ownerId && c.e2e === this.options.context.e2e;
  }
  private open(context: SyncIndexContext): Root {
    const store = this.options.openStore?.(context) ?? openRoomSyncStore(this.options.directory, this.options.roomId, context);
    const session = new RoomSyncSession({ context, store, storage: path.join(this.options.directory, 'bytes', context.rootId),
      identity: this.options.identity, isCurrent: () => this.current(), contentSecret: this.options.contentSecret, resolveSecret: this.options.resolveSecret,
      cachePins: () => [...this.restorePreviews.values(), ...this.pathPreviews.values()].filter(p => p.rootId === context.rootId && p.expires >= Date.now()).map(p => p.guard.revisionId) });
    return { context, store, session };
  }
  private accept(id: string, records: SyncRecord[]): void {
    this.check(); let root = this.roots.get(id);
    const previousPolicy = root?.store.policy()?.policyId;
    if (!root) {
      const contexts = this.catalog.roots();
      if (contexts.some(c => c.rootId === id) || contexts.length >= SYNC_ROOT_LIMIT) throw new Error('Sync root paused or capacity reached');
      const context = { ...this.options.context, rootId: id };
      // Authenticate genesis before creating files or reserving a root slot.
      const genesis = records[0];
      if (genesis?.kind !== 'policy' || genesis.value.epoch !== 1 && !genesis.value.checkpoint) throw new Error('Sync root genesis or checkpoint required');
      new FileSyncIndex(context, verifySyncProof).acceptPolicy(genesis.value);
      root = this.open(context); root.store.acceptRecords(records); this.catalog.add(context);
      this.roots.set(id, root); this.startTimer();
    } else root.store.acceptRecords(records);
    if (previousPolicy && root.store.policy()?.policyId !== previousPolicy) {
      this.stopWatcher(id); this.issues.set(id, RIGHTS_CHANGED);
    }
  }
  private startTimer(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (!this.current()) return;
      void this.exchange.offer().catch(error => this.options.warn?.(error));
      for (const id of this.roots.keys()) { this.schedule(id); void this.trimCache(id); void this.trimBackups(id); }
    }, 30_000);
    this.timer.unref?.();
  }
  close(): void {
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.exchange.close(); this.historyExchange.close();
    for (const root of new Set([...this.roots.values(), ...this.inactiveRoots.values()])) {
      const done = root.session.cancelWork().catch(error => this.options.warn?.(error)); this.closingWatchers.add(done);
      void done.finally(() => this.closingWatchers.delete(done)).catch(() => {});
    }
    for (const id of this.watchers.keys()) this.stopWatcher(id); this.previews.clear(); this.restorePreviews.clear(); this.conflictPreviews.clear();
    this.backupPreviews.clear();
    this.filterPreviews.clear();
    this.rightsPreviews.clear();
    this.editorDrafts.clear();
    this.movePreviews.clear();
    this.pathPreviews.clear();
    this.metadataPreviews.clear(); this.metadataExports.clear();
    this.deletePreviews.clear();
    this.missingFiles.clear();
    this.trashPreviews.clear();
    this.logPreviews.clear();
    this.checkpointPreviews.clear();
    for (const pending of this.metadata.values()) { clearTimeout(pending.timer); clearInterval(pending.retry); pending.reject(new Error('Room file sync stopped')); }
    this.metadata.clear();
    this.metadataHints.clear();
    this.wireVersions.clear();
  }
  private stopWatcher(rootId: string): void {
    const watcher = this.watchers.get(rootId); if (!watcher) return;
    watcher.close(); this.watchers.delete(rootId);
    const job = watcher.idle(); this.closingWatchers.add(job);
    void job.finally(() => this.closingWatchers.delete(job)).catch(() => {});
  }
  async settled(): Promise<void> { await Promise.all([...this.closingWatchers, ...this.backupJobs.values(), ...this.cacheJobs.values()]); }
  async peer(memberId: string): Promise<void> { this.check(); await this.restore(); await this.exchange.offer(memberId); }
  async receive(memberId: string, body: unknown, version: SyncWireVersion = 1): Promise<void> {
    this.check(); if (!validSyncWireBody(body) || !validSyncWireVersion(body, version)) throw new Error('Invalid file sync frame');
    if (syncHistoryBody(body)) { await this.historyExchange.receive(memberId, body); return; }
    if (version < (this.roots.get(body.rootId)?.store.policy()?.v ?? 1)) throw new Error('Sync root requires its current protocol version');
    if (version >= 2) {
      const stream = memberId + ':' + body.rootId + ':' + body.streamId;
      if (!this.wireVersions.has(stream) && this.wireVersions.size >= 64) this.wireVersions.delete(this.wireVersions.keys().next().value!);
      this.wireVersions.set(stream, version);
    }
    const key = body.rootId + ':' + body.streamId;
    if (body.kind === 'blob-request') {
      if (this.maintenance.has(body.rootId)) return;
      const source = this.roots.get(body.rootId)?.store.sources().find(s => s.revisionId === body.streamId);
      if (!source || source.metadata.length > 192 * 1024) return;
      const replyKey = memberId + ':' + key, previous = this.replies.get(replyKey) ?? 0;
      if (Date.now() - previous < 10_000) return;
      if (this.replies.size >= 1024) this.replies.delete(this.replies.keys().next().value!);
      this.replies.set(replyKey, Date.now());
      const revision = this.roots.get(body.rootId)?.store.revision(body.streamId);
      if (revision) {
        try { await this.options.seed(body.rootId, { revisionId: revision.revisionId, file: syncRevisionFile(revision),
          sourcePath: source.path, metadata: Buffer.from(source.metadata, 'base64') }); }
        catch (error) { this.options.warn?.(error); }
      }
      this.check();
      await this.send(memberId, { kind: 'blob-metadata', rootId: body.rootId, streamId: body.streamId, metadata: source.metadata });
    } else if (body.kind === 'blob-metadata') {
      const pending = this.metadata.get(key), revision = this.roots.get(body.rootId)?.store.revision(body.streamId);
      if (!pending || !revision || revision.op !== 'put') return;
      const bytes = Buffer.from(body.metadata, 'base64');
      if (bytes.toString('base64') !== body.metadata) throw new Error('Invalid sync metadata encoding');
      roomTorrentMetadata(syncRevisionFile(revision), bytes);
      // Reuse authenticated hints when an excluded in-flight download is later re-enabled.
      // A second request otherwise waits for the peer's reply throttle despite already known metadata.
      if (this.metadataHints.size >= 32) this.metadataHints.delete(this.metadataHints.keys().next().value!);
      this.metadataHints.set(key, Buffer.from(bytes));
      clearTimeout(pending.timer); clearInterval(pending.retry); this.metadata.delete(key); pending.resolve(bytes);
    } else await this.exchange.receive(memberId, body);
  }
  private requestMetadata(rootId: string, revisionId: string): Promise<Buffer> {
    const source = this.roots.get(rootId)?.store.sources().find(s => s.revisionId === revisionId);
    if (source) return Promise.resolve(Buffer.from(source.metadata, 'base64'));
    const key = rootId + ':' + revisionId;
    const hint = this.metadataHints.get(key); if (hint) return Promise.resolve(Buffer.from(hint));
    const existing = this.metadata.get(key); if (existing) return existing.promise;
    let resolve!: (bytes: Buffer) => void, reject!: (error: Error) => void;
    const promise = new Promise<Buffer>((yes, no) => { resolve = yes; reject = no; });
    const send = () => {
      if (this.metadata.get(key)?.promise !== promise) return;
      void this.send('', { kind: 'blob-request', rootId, streamId: revisionId }).catch(error => this.options.warn?.(error));
    };
    // A persisted root can be opened before its peer channels reconnect. Reissue bounded hints.
    const retry = setInterval(send, 2000); retry.unref?.();
    const timer = setTimeout(() => {
      clearInterval(retry);
      if (this.metadata.get(key)?.promise === promise) this.metadata.delete(key);
      reject(new Error('Sync content source unavailable'));
    }, 15_000);
    this.metadata.set(key, { promise, resolve, reject, timer, retry }); send();
    return promise;
  }
  private async seedRetained(rootId: string, revisionId: string): Promise<void> {
    const root = this.roots.get(rootId), source = root?.store.sources().find(s => s.revisionId === revisionId), revision = root?.store.revision(revisionId);
    if (!source || !revision) return;
    // Release the verified transfer copy before seeding the retained version, keeping one payload.
    if (this.options.release && !await this.options.release(revision.blob!.infoHash)) return;
    this.check();
    await this.options.seed(rootId, { revisionId, file: syncRevisionFile(revision), sourcePath: source.path, metadata: Buffer.from(source.metadata, 'base64') });
  }
  restore(): Promise<void> {
    this.restoreJob ??= (async () => {
      for (const [id, root] of this.roots) {
        this.check(); await root.session.recoverApplied();
        const sources = await root.session.resumeSources();
        for (const source of sources.ready) {
          this.check();
          try { await this.options.seed(id, source); } catch (error) { this.check(); this.options.warn?.(error); }
        }
        this.schedule(id);
        this.watchRoot(id);
        await this.trimCache(id);
        void this.trimBackups(id);
      }
    })().catch(error => { this.restoreJob = undefined; throw error; });
    return this.restoreJob;
  }
  list(): Array<{ rootId: string; name: string; paused: boolean; binding: ReturnType<RoomSyncStore['binding']> }> {
    return this.catalog.roots().map(c => ({ rootId: c.rootId, name: this.roots.get(c.rootId)?.store.policy()?.name ?? 'Sync folder',
      paused: !this.matches(c) || !this.current(), binding: this.roots.get(c.rootId)?.store.binding() ?? null }));
  }
  async create(name: string, localFolder: string): Promise<string> {
    this.check(); if (this.catalog.roots().length >= SYNC_ROOT_LIMIT) throw new Error('Sync root capacity reached');
    if (deriveMemberId(this.options.identity.pub) !== this.options.context.ownerId) throw new Error('Only the owner can create a sync folder');
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Invalid sync folder name');
    this.validateBinding(localFolder);
    const context = { ...this.options.context, rootId: crypto.randomUUID() }, root = this.open(context);
    root.store.bind(localFolder); root.session.createRoot(name); this.catalog.add(context); this.roots.set(context.rootId, root); this.startTimer();
    await this.exchange.offer('', context.rootId); return context.rootId;
  }
  private validateBinding(folder: string, own?: string): void {
    if (!path.isAbsolute(folder)) throw new Error('An absolute sync folder is required');
    assertSyncPlainPath(folder); if (!fs.statSync(folder).isDirectory()) throw new Error('A sync directory is required');
    const forbidden = [this.options.directory, ...(this.options.forbidden ?? []), ...(this.options.otherBindings?.(own) ?? []),
      ...[...this.roots].filter(([id]) => id !== own).map(([, root]) => root.store.binding()?.path).filter((p): p is string => !!p)];
    if (forbidden.some(other => overlaps(folder, other) || overlaps(other, folder))) throw new Error('Overlapping sync bindings are not supported');
  }
  async bind(rootId: string, folder: string, autoApply = false): Promise<void> {
    if (this.maintenance.has(rootId)) throw new Error('Sync maintenance in progress');
    this.check(); const root = this.roots.get(rootId); if (!root) throw new Error('Unknown or paused sync root');
    this.validateBinding(folder, rootId);
    if (root.store.binding()?.path !== path.resolve(folder)) {
      this.stopWatcher(rootId); root.store.bind(folder); this.missingFiles.delete(rootId);
      for (const key of this.retryAt.keys()) if (key.startsWith(rootId + ':')) { this.retryAt.delete(key); this.errors.delete(key); }
    }
    root.store.setAutoApply(autoApply); this.schedule(rootId);
  }
  async publish(rootId: string, relativePath: string, authorized: () => boolean = () => true, priority: SyncWorkPriority = 'interactive'): Promise<string> {
    if (this.maintenance.has(rootId)) throw new Error('Sync maintenance in progress');
    this.check(); const root = this.roots.get(rootId); if (!root) throw new Error('Unknown sync root');
    const result = await root.session.publish(relativePath, undefined, authorized, priority); this.check();
    root.store.completePublication(relativePath);
    if (result.snapshot) await this.options.seed(rootId, { revisionId: result.revision.revisionId, file: result.snapshot.file,
      sourcePath: result.snapshot.sourcePath, metadata: result.snapshot.metadata });
    await this.exchange.offer('', rootId);
    await this.trimCache(rootId);
    void this.trimBackups(rootId);
    return result.revision.revisionId;
  }
  private rightsCandidates(root: Root): SyncWriterCandidate[] {
    const members = this.options.writerCandidates?.() ?? [];
    const byId = new Map(members.map(m => [m.memberId, { ...m }]));
    byId.set(this.options.context.ownerId, { memberId: this.options.context.ownerId, name: byId.get(this.options.context.ownerId)?.name ?? 'Owner', capable: true, moves: true, checkpoints: true, multipart: true, deletes: true });
    for (const id of syncWriters(root.store.policy())) if (!byId.has(id)) byId.set(id, { memberId: id, name: id.slice(0, 12), capable: false });
    return [...byId.values()].sort((a, b) => a.memberId.localeCompare(b.memberId));
  }
  private async editorDraft(rootId: string, root: Root, entryId: string): Promise<SyncEditorDraft> {
    const { guard, view } = await root.session.readEditor(entryId), token = crypto.randomUUID();
    if (this.editorDrafts.size >= 8) this.editorDrafts.delete(this.editorDrafts.keys().next().value!);
    this.editorDrafts.set(token, { rootId, guard, expires: Date.now() + 30 * 60_000 });
    return { ...view, token, rootId, entryId };
  }
  async openEditor(rootId: string, entryId: string): Promise<SyncEditorDraft> {
    this.check(); const root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId);
    try { return await this.editorDraft(rootId, root, entryId); }
    finally { this.maintenance.delete(rootId); this.schedule(rootId); }
  }
  closeEditor(token: string): void { this.editorDrafts.delete(token); }
  async saveEditor(token: string, text: string): Promise<{ revisionId: string; draft: SyncEditorDraft | null }> {
    this.check(); const draft = this.editorDrafts.get(token); this.editorDrafts.delete(token);
    if (!draft || draft.expires < Date.now()) throw new Error('Editor session expired; keep your draft and reopen the file');
    const root = this.roots.get(draft.rootId);
    if (!root || this.maintenance.has(draft.rootId)) throw new Error('Sync root unavailable; keep your draft');
    this.maintenance.add(draft.rootId); this.stopWatcher(draft.rootId);
    try {
      await this.settled(); const result = await root.session.saveEditor(draft.guard, text); this.check();
      if (result.snapshot) {
        await this.options.seed(draft.rootId, { revisionId: result.revision.revisionId, file: result.snapshot.file, sourcePath: result.snapshot.sourcePath, metadata: result.snapshot.metadata });
        await this.exchange.offer('', draft.rootId);
      }
      let next: SyncEditorDraft | null = null;
      try { next = await this.editorDraft(draft.rootId, root, draft.guard.entryId); } catch (error) { this.options.warn?.(error); }
      return { revisionId: result.revision.revisionId, draft: next };
    } finally { this.maintenance.delete(draft.rootId); this.watchRoot(draft.rootId); this.schedule(draft.rootId); void this.trimBackups(draft.rootId); }
  }
  rights(rootId: string, selected?: string[], moves?: boolean, deletes?: boolean): SyncRightsPreview {
    this.check(); const root = this.roots.get(rootId), self = deriveMemberId(this.options.identity.pub), policy = root?.store.policy();
    if (!root || !policy || self !== this.options.context.ownerId || this.maintenance.has(rootId)) throw new Error('Only the owner can change sync writers');
    const candidates = this.rightsCandidates(root), writers = selected ?? [...new Set([self, ...syncWriters(policy)])].sort();
    const deleting = deletes ?? (policy.v >= 6 && policy.allowDeletes), moving = deleting || (moves ?? policy.v >= 3);
    if (typeof deleting !== 'boolean' || policy.v >= 6 && !deleting) throw new Error('Sync deletion protocol cannot downgrade');
    if (typeof moving !== 'boolean' || policy.v >= 3 && !moving) throw new Error('Sync protocol cannot downgrade');
    let previewId: string | null = null;
    if (selected !== undefined) {
      if (!Array.isArray(selected) || selected.length < 1 || selected.length > 16 || new Set(selected).size !== selected.length || !selected.includes(self)
        || selected.some(id => !candidates.some(m => m.memberId === id && (deleting ? m.deletes || policy.v >= 6 && syncWriters(policy).includes(id) : policy.v >= 4 ? (policy.v >= 5 ? m.multipart : m.checkpoints) || syncWriters(policy).includes(id) : moving ? m.moves || policy.v >= 3 && syncWriters(policy).includes(id)
          : m.capable || policy.v >= 2 && syncWriters(policy).includes(id))))) throw new Error('Select known compatible writers, including the owner');
      previewId = crypto.randomUUID();
      if (this.rightsPreviews.size >= 8) this.rightsPreviews.delete(this.rightsPreviews.keys().next().value!);
      this.rightsPreviews.set(previewId, { rootId, writers: [...selected].sort(), moves: moving, deletes: deleting, stamp: root.session.rightsStamp(), candidates: JSON.stringify(candidates), expires: Date.now() + 5 * 60_000 });
    }
    return { rootId, previewId, version: policy.v, epoch: policy.epoch, ownerId: self, selected: [...writers].sort(), candidates, moves: moving, deletes: deleting };
  }
  async confirmRights(previewId: string): Promise<void> {
    this.check(); const preview = this.rightsPreviews.get(previewId); this.rightsPreviews.delete(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Sync rights preview expired; review again');
    const root = this.roots.get(preview.rootId);
    if (!root || this.maintenance.has(preview.rootId) || JSON.stringify(this.rightsCandidates(root)) !== preview.candidates) throw new Error('Room membership changed; review rights again');
    this.maintenance.add(preview.rootId); this.stopWatcher(preview.rootId);
    try {
      await this.settled(); await root.session.changeWriters(preview.writers, preview.stamp, preview.moves, preview.deletes);
      this.issues.set(preview.rootId, RIGHTS_CHANGED);
      await this.exchange.offer('', preview.rootId);
    } finally { this.maintenance.delete(preview.rootId); this.watchRoot(preview.rootId); }
  }
  localBindings(): Array<{ rootId: string; path: string }> {
    return [...this.roots, ...this.inactiveRoots].flatMap(([rootId, root]) => { const binding = root.store.binding(); return binding ? [{ rootId, path: binding.path }] : []; });
  }
  private watchRoot(rootId: string): void {
    if (!this.current()) return;
    const root = this.roots.get(rootId), binding = root?.store.binding();
    if (!root || !binding || !root.store.watch().enabled || !canWriteSync(root.store.policy(), deriveMemberId(this.options.identity.pub))) return;
    if (this.watchers.has(rootId)) return;
    const epoch = root.store.bindingEpoch();
    const watcher = new RoomSyncWatcher({ folder: binding.path, rules: root.store.exclusions(), workOwner: root.session,
      current: () => this.current() && root.store.bindingEpoch() === epoch && root.store.binding()?.path === binding.path && root.store.watch().enabled
        && canWriteSync(root.store.policy(), deriveMemberId(this.options.identity.pub)),
      pending: () => root.store.watch().pending, enqueue: paths => root.store.enqueuePublications(paths), complete: p => root.store.completePublication(p),
      digest: p => {
        if ((root.store.policy()?.v ?? 1) >= 2) return root.store.applied().find(a => root.store.revision(a.revisionId)?.relativePath === p)?.digest ?? undefined;
        const head = root.store.heads().find(h => h.revisionIds.length === 1 && root.store.revision(h.revisionIds[0])?.relativePath === p);
        const applied = head && root.store.applied().find(a => a.entryId === head.entryId && a.revisionId === head.revisionIds[0]);
        return applied?.digest ?? undefined;
      },
      publish: async (p, current) => { await this.publish(rootId, p, current, 'background'); },
      scanned: scan => { this.missingDetector(rootId).update(scan); },
      issue: error => { if (error) { this.issues.set(rootId, String(error)); this.options.warn?.(error); } else this.issues.delete(rootId); },
    });
    this.watchers.set(rootId, watcher);
  }
  async action(rootId: string, action: SyncLocalAction, enabled?: boolean): Promise<void> {
    if (this.maintenance.has(rootId) && action !== 'cancel-work') throw new Error('Sync maintenance in progress');
    this.check(); const root = this.roots.get(rootId) ?? (action === 'unbind' ? this.inactiveRoots.get(rootId) : undefined);
    if (!root) throw new Error('Unknown or paused sync root');
    if (['mode-manual', 'mode-receive', 'mode-send', 'mode-sync'].includes(action)) {
      const publish = action === 'mode-send' || action === 'mode-sync', apply = action === 'mode-receive' || action === 'mode-sync';
      if (publish && !canWriteSync(root.store.policy(), deriveMemberId(this.options.identity.pub))) throw new Error('Only an authorized writer can enable publication');
      this.validateBinding(root.store.binding()?.path ?? '', rootId);
      root.store.setAutomaticMode(publish, apply);
      this.stopWatcher(rootId);
      if (publish) this.watchRoot(rootId);
      this.schedule(rootId);
    } else if (action === 'cancel-work') {
      root.store.setAutoPublish(false); this.stopWatcher(rootId);
      await root.session.cancelWork();
    } else if (action === 'auto-publish') {
      if (typeof enabled !== 'boolean' || !canWriteSync(root.store.policy(), deriveMemberId(this.options.identity.pub))) throw new Error('Only an authorized writer can enable publication');
      if (enabled) this.validateBinding(root.store.binding()?.path ?? '', rootId);
      root.store.setAutoPublish(enabled); this.stopWatcher(rootId);
      if (enabled) this.watchRoot(rootId);
    } else if (action === 'auto-apply') {
      if (typeof enabled !== 'boolean') throw new Error('Invalid application choice');
      if (enabled) this.validateBinding(root.store.binding()?.path ?? '', rootId);
      root.store.setAutoApply(enabled); this.schedule(rootId);
    } else if (action === 'scan') {
      this.watchers.get(rootId)?.rescan(true);
      for (const key of this.retryAt.keys()) if (key.startsWith(rootId + ':')) this.retryAt.delete(key);
      this.schedule(rootId);
    } else if (action === 'unbind') {
      this.stopWatcher(rootId); root.store.bind(null); await root.session.cancelWork(); this.issues.delete(rootId); this.missingFiles.delete(rootId);
    } else throw new Error('Invalid sync action');
  }
  view(): SyncRootView[] {
    this.check(); const self = deriveMemberId(this.options.identity.pub);
    return this.catalog.roots().map(context => {
      const root = this.roots.get(context.rootId) ?? this.inactiveRoots.get(context.rootId), binding = root?.store.binding(), rows = root ? this.rows(root) : [], policy = root?.store.policy() ?? null;
      return { rootId: context.rootId, name: policy?.name ?? 'Sync folder', paused: !this.matches(context),
        work: root?.session.workView(),
        publisher: canWriteSync(policy, self), multiWriter: (policy?.v ?? 1) >= 2, moves: (policy?.v ?? 1) >= 3, deletes: (policy?.v ?? 1) >= 6 && policy?.allowDeletes, owner: context.ownerId === self,
        writers: syncWriters(policy), path: binding?.path ?? null, autoApply: binding?.autoApply ?? false,
        autoPublish: root?.store.watch().enabled ?? false, files: rows.filter(r => !r.deleted).length, trash: rows.filter(r => r.deleted).length, pending: root?.store.watch().pending.length ?? 0,
        missing: this.missingFiles.get(context.rootId)?.read().items.length ?? 0,
        conflicts: rows.filter(row => row.status === 'conflict' || row.status === 'deferred').length,
        receiving: rows.filter(row => row.status === 'receiving').length, waiting: rows.filter(row => row.status === 'waiting').length,
        error: this.issues.get(context.rootId) === RIGHTS_CHANGED ? undefined : this.issues.get(context.rootId),
        notice: this.issues.get(context.rootId) === RIGHTS_CHANGED && !root?.store.watch().enabled && !binding?.autoApply ? 'rights-changed' : undefined };
    });
  }
  private rows(root: Root): SyncFilesPage['items'] {
    const rules = root.store.exclusions();
    const applied = new Map(root.store.applied().map(a => [a.entryId, a.revisionId]));
    const conflicts = new Set(root.store.pathConflicts().flatMap(c => c.entryIds));
    const policy = root.store.policy(), version = policy?.v ?? 1, bound = !!root.store.binding();
    const publisher = canWriteSync(policy, deriveMemberId(this.options.identity.pub));
    const deferred = new Set(root.store.deferred());
    const activeHeads = root.store.heads();
    const items: SyncFilesPage['items'] = activeHeads.map(head => {
      const revision = root.store.revision(head.revisionIds[0])!, key = root.context.rootId + ':' + revision.revisionId;
      const base = root.store.revision(applied.get(head.entryId) ?? '');
      const pendingMove = !!base && base.relativePath !== revision.relativePath;
      const error = this.errors.get(key), conflict = head.revisionIds.length > 1 || conflicts.has(head.entryId)
        || !!error && (error.includes('local changes') || error.includes('recovery required'));
      return { entryId: head.entryId, path: revision.relativePath, size: revision.blob?.size ?? 0, revisionId: revision.revisionId,
        deleted: head.revisionIds.every(id => root.store.revision(id)!.op === 'delete'),
        deletable: version >= 6 && !!policy?.allowDeletes && publisher && bound && head.revisionIds.some(id => root.store.revision(id)!.op === 'put')
          && head.revisionIds.every(id => root.store.revision(id)!.relativePath === revision.relativePath) && !!base && base.op === 'put' && !deferred.has(head.entryId)
          && base.relativePath === revision.relativePath && !conflicts.has(head.entryId) && !excludedSyncPath(revision.relativePath, rules),
        movable: version >= 3 && publisher && bound && head.revisionIds.length === 1 && revision.op === 'put'
          && applied.get(head.entryId) === revision.revisionId && !deferred.has(head.entryId) && !conflicts.has(head.entryId) && !excludedSyncPath(revision.relativePath, rules),
        pathResolvable: version >= 3 && publisher && bound && head.revisionIds.length <= 64 && head.revisionIds.some(id => {
          const r = root.store.revision(id)!; return r.op === 'put' && !excludedSyncPath(r.relativePath, rules);
        }) && (conflicts.has(head.entryId) || head.revisionIds.length > 1 || pendingMove || !!error && applied.get(head.entryId) !== revision.revisionId),
        editable: bound && head.revisionIds.length === 1 && revision.op === 'put' && !!syncEditorLanguage(revision.relativePath)
          && !conflicts.has(head.entryId) && !excludedSyncPath(revision.relativePath, rules),
        resolvable: !pendingMove && (!publisher || version >= 2) && bound && head.revisionIds.length === 1 && !conflicts.has(head.entryId)
          && !excludedSyncPath(revision.relativePath, rules) && (deferred.has(head.entryId) || !!error && (revision.op === 'delete' || error.includes('local changes') || error.includes('recovery required'))),
        status: excludedSyncPath(revision.relativePath, rules) ? 'excluded' as const : deferred.has(head.entryId) ? 'deferred' as const : conflict ? 'conflict' as const : error ? 'error' as const : applied.get(head.entryId) === revision.revisionId
          ? revision.op === 'delete' ? 'deleted' as const : publisher ? 'published' as const : 'applied' as const : this.work.has(key) ? 'receiving' as const : 'waiting' as const,
        ...(error ? { detail: error } : {}) };
    });
    for (const local of root.store.applied()) {
      if (activeHeads.some(h => h.entryId === local.entryId)) continue;
      const revision = root.store.revision(local.revisionId)!;
      if (revision.op !== 'put') continue;
      const excluded = excludedSyncPath(revision.relativePath, rules);
      items.push({ entryId: local.entryId, path: revision.relativePath, size: revision.blob!.size, revisionId: revision.revisionId,
        status: excluded ? 'excluded' : 'deferred', orphaned: true, editable: !excluded && bound && !!syncEditorLanguage(revision.relativePath) });
    }
    return items.sort((a, b) => a.path.localeCompare(b.path));
  }
  files(rootId: string, offset = 0, trash = false): SyncFilesPage {
    this.check(); if (!Number.isSafeInteger(offset) || offset < 0 || offset > 4000) throw new Error('Invalid sync page');
    const root = this.roots.get(rootId); if (!root) throw new Error('Unknown or paused sync root');
    const rows = this.rows(root).filter(row => trash ? row.deleted : !row.deleted || ['conflict', 'deferred', 'error'].includes(row.status));
    return { items: rows.slice(offset, offset + 100), next: offset + 100 < rows.length ? offset + 100 : null };
  }
  history(rootId: string, entryId: string, offset = 0): SyncHistoryPage {
    this.check(); const root = this.roots.get(rootId); if (!root) throw new Error('Unknown or paused sync root');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > SYNC_HISTORY_REVISION_LIMIT) throw new Error('Invalid history page');
    const page = root.store.historyPage(entryId, offset);
    if (page.path === null) throw new Error('Unknown sync file');
    const sources = new Set(root.store.sources().map(s => s.revisionId)), heads = root.store.heads().find(h => h.entryId === entryId)?.revisionIds ?? [];
    return { path: page.path, branches: heads.length, canFetch: !!root.store.nextHistoryCheckpoint(), canRestore: !!root.store.binding() && !excludedSyncPath(page.path, root.store.exclusions()) && canWriteSync(root.store.policy(), deriveMemberId(this.options.identity.pub))
      && heads.length > 0 && heads.length <= ((root.store.policy()?.v ?? 1) >= 2 ? 64 : 1) && !root.store.pathConflicts().some(c => c.entryIds.includes(entryId)),
      items: page.items.map(r => ({ revisionId: r.revisionId, authorId: r.authorId, createdAt: r.createdAt, size: r.blob?.size ?? 0, current: heads.includes(r.revisionId), deleted: r.op === 'delete',
        local: sources.has(r.revisionId) && fs.existsSync(root.store.sources().find(s => s.revisionId === r.revisionId)!.path) })), next: page.more ? offset + 50 : null };
  }
  async fetchHistory(rootId: string, entryId: string): Promise<SyncHistoryFetchResult> {
    this.check(); const root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId) || this.historyBusy || root.store.historyPage(entryId, 0, 1).path === null) throw new Error('Sync history unavailable or busy');
    this.historyBusy = true; let epochs = 0;
    try {
      for (;;) {
        this.check(); const checkpoint = root.store.nextHistoryCheckpoint();
        if (!checkpoint) return { epochs, state: 'complete' };
        if (root.store.importedHistoryCount() >= SYNC_CHECKPOINT_ARCHIVES) return { epochs, state: 'limit' };
        const received = await this.historyExchange.fetch(checkpoint); this.check();
        if (received === null) return { epochs, state: 'unavailable' };
        epochs++;
      }
    } catch (error) {
      if (error instanceof Error && ['Sync snapshot capacity reached', 'Downloaded history archive capacity reached'].includes(error.message)) return { epochs, state: 'limit' };
      throw error;
    } finally { this.historyBusy = false; }
  }
  private receiverFile(rootId: string, entryId: string) {
    this.check(); const root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId) || !root.store.binding() || root.store.policy()?.v === 1 && root.store.policy()?.publisherId === deriveMemberId(this.options.identity.pub)) throw new Error('Receiver sync root unavailable');
    const heads = root.store.heads().find(h => h.entryId === entryId)?.revisionIds;
    const revision = heads?.length === 1 ? root.store.revision(heads[0]) : undefined;
    if (!revision || revision.op !== 'put' || excludedSyncPath(revision.relativePath, root.store.exclusions()) || root.store.pathConflicts().some(c => c.entryIds.includes(entryId))) throw new Error('Ambiguous sync conflict requires manual inspection');
    return { root, revision };
  }
  deferFile(rootId: string, entryId: string): void {
    const { root } = this.receiverFile(rootId, entryId);
    root.store.defer(entryId);
  }
  async prepareConflict(rootId: string, entryId: string): Promise<SyncConflictPreview> {
    const { root, revision } = this.receiverFile(rootId, entryId);
    this.maintenance.add(rootId);
    try {
      await this.cacheJobs.get(rootId); this.check();
      if (!root.store.sources().some(s => s.revisionId === revision.revisionId && fs.existsSync(s.path))) {
        const metadata = await this.requestMetadata(rootId, revision.revisionId);
        const bytes = await this.options.fetch(rootId, revision.revisionId, syncRevisionFile(revision), metadata); this.check();
        await root.session.retainHistorical(revision.revisionId, bytes.sourcePath, bytes.metadata, 'conflict');
        await this.seedRetained(rootId, revision.revisionId);
      }
      const { guard, view } = await root.session.prepareConflict(revision.revisionId), previewId = crypto.randomUUID();
      if (this.conflictPreviews.size >= 8) this.conflictPreviews.delete(this.conflictPreviews.keys().next().value!);
      this.conflictPreviews.set(previewId, { rootId, guard, expires: Date.now() + 5 * 60_000 });
      return { ...view, previewId, rootId };
    } finally { this.maintenance.delete(rootId); this.schedule(rootId); }
  }
  async resolveConflict(previewId: string, choice: SyncConflictChoice): Promise<{ copyPath: string | null }> {
    this.check();
    if (!['accept', 'keep-both'].includes(choice)) throw new Error('Invalid sync conflict choice');
    const preview = this.conflictPreviews.get(previewId); this.conflictPreviews.delete(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Sync conflict preview expired; review again');
    const { rootId, guard } = preview, root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId);
    try {
      const result = await root.session.resolveConflict(guard, choice);
      const key = rootId + ':' + guard.revisionId;
      this.errors.delete(key); this.retryAt.delete(key);
      return result;
    } finally { this.maintenance.delete(rootId); this.schedule(rootId); void this.trimBackups(rootId); }
  }
  async prepareRestore(rootId: string, revisionId: string): Promise<SyncRestorePreview> {
    this.check(); const root = this.roots.get(rootId); if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    const revision = root.store.revision(revisionId);
    if (!revision || revision.op !== 'put' || excludedSyncPath(revision.relativePath, root.store.exclusions()) || !canWriteSync(root.store.policy(), deriveMemberId(this.options.identity.pub)) || !root.store.binding()) throw new Error('Only a bound writer with an included path can restore');
    this.maintenance.add(rootId);
    try {
      await this.cacheJobs.get(rootId); this.check();
      if (!root.store.sources().some(s => s.revisionId === revisionId && fs.existsSync(s.path))) {
        const metadata = await this.requestMetadata(rootId, revisionId);
        const bytes = await this.options.fetch(rootId, revisionId, syncRevisionFile(revision), metadata); this.check();
        await root.session.retainHistorical(revisionId, bytes.sourcePath, bytes.metadata);
        await this.seedRetained(rootId, revisionId);
      }
      const guard = await root.session.prepareRestore(revisionId), previewId = crypto.randomUUID();
      if (this.restorePreviews.size >= 8) this.restorePreviews.delete(this.restorePreviews.keys().next().value!);
      this.restorePreviews.set(previewId, { rootId, guard, expires: Date.now() + 5 * 60_000 });
      return { previewId, rootId, path: guard.targetPath ?? revision.relativePath, createdAt: revision.createdAt, replacesLocal: guard.digest !== null, branches: guard.head.split(',').length,
        ...(guard.sourcePath && guard.sourcePath !== guard.targetPath ? { moveFrom: guard.sourcePath } : {}) };
    } finally { this.maintenance.delete(rootId); }
  }
  async confirmRestore(previewId: string): Promise<void> {
    this.check(); const preview = this.restorePreviews.get(previewId); this.restorePreviews.delete(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Sync restore preview expired; review again');
    const { rootId, guard } = preview, root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId); const watching = root.store.watch().enabled;
    this.stopWatcher(rootId);
    try {
      if (watching) root.store.setAutoPublish(false);
      await this.settled();
      const result = await root.session.restoreRevision(guard); this.check();
      await this.options.seed(rootId, { revisionId: result.revision.revisionId, file: result.snapshot.file, sourcePath: result.snapshot.sourcePath, metadata: result.snapshot.metadata });
      await this.exchange.offer('', rootId);
      if (watching) root.store.setAutoPublish(true);
      this.issues.delete(rootId);
    } finally { this.maintenance.delete(rootId); this.watchRoot(rootId); }
    await this.trimCache(rootId);
    void this.trimBackups(rootId);
  }
  async prepareMove(rootId: string, entryId: string, toPath: string): Promise<SyncMovePreview> {
    this.check(); const root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId);
    try {
      const guard = await root.session.prepareMove(entryId, toPath), previewId = crypto.randomUUID();
      if (this.movePreviews.size >= 8) this.movePreviews.delete(this.movePreviews.keys().next().value!);
      this.movePreviews.set(previewId, { rootId, guard, expires: Date.now() + 5 * 60_000 });
      return { previewId, rootId, entryId, fromPath: guard.fromPath, toPath: guard.toPath, size: root.store.revision(guard.revisionId)!.blob!.size };
    } finally { this.maintenance.delete(rootId); this.schedule(rootId); }
  }
  pathConflict(rootId: string, entryId: string): SyncPathConflict {
    this.check(); const root = this.roots.get(rootId), row = root && this.rows(root).find(r => r.entryId === entryId);
    if (!root || !row?.pathResolvable || this.maintenance.has(rootId)) throw new Error('Sync path conflict unavailable');
    const heads = root.store.heads().find(h => h.entryId === entryId)!.revisionIds;
    const versions = heads.map(id => root.store.revision(id)!).filter(r => r.op === 'put' && !excludedSyncPath(r.relativePath, root.store.exclusions()))
      .map(r => ({ revisionId: r.revisionId, path: r.relativePath, size: r.blob!.size, authorId: r.authorId, createdAt: r.createdAt }));
    const ids = new Set(root.store.pathConflicts().filter(c => c.entryIds.includes(entryId)).flatMap(c => c.entryIds));
    const others = root.store.heads().filter(h => h.entryId !== entryId && ids.has(h.entryId)).flatMap(h => h.revisionIds.map(id => root.store.revision(id)!))
      .filter(r => r.op === 'put').map(r => ({ entryId: r.entryId, path: r.relativePath, size: r.blob!.size, authorId: r.authorId }));
    const first = versions[0].path, dot = first.lastIndexOf('.'), slash = first.lastIndexOf('/'), split = dot > slash + 1 ? dot : first.length;
    let suggestedPath = first.slice(0, split) + '-copy-' + entryId.slice(0, 8) + first.slice(split);
    const key = suggestedPath.normalize('NFC').toLowerCase();
    if (!validSyncRelativePath(suggestedPath) || !validSyncName(suggestedPath.split('/').at(-1)! + '.enc') || versions.some(v => !validSyncMovePaths(v.path, suggestedPath))
      || root.store.heads().some(h => h.entryId !== entryId && h.revisionIds.some(id => {
        const r = root.store.revision(id)!, p = r.relativePath.normalize('NFC').toLowerCase();
        return r.op === 'put' && (p === key || p.startsWith(key + '/') || key.startsWith(p + '/'));
      }))) suggestedPath = 'copy-' + entryId + (split === dot && first.length - split <= 32 ? first.slice(split) : '');
    return { rootId, entryId, versions, others: others.slice(0, 32), more: others.length > 32,
      suggestedPath };
  }
  async preparePathResolution(rootId: string, entryId: string, revisionId: string, toPath: string): Promise<SyncPathPreview> {
    this.pathConflict(rootId, entryId); const root = this.roots.get(rootId)!;
    if (root.store.revision(revisionId)?.entryId !== entryId || root.store.revision(revisionId)?.op !== 'put'
      || !root.store.heads().find(h => h.entryId === entryId)?.revisionIds.includes(revisionId)) throw new Error('Invalid sync path version');
    this.maintenance.add(rootId);
    try {
      await this.cacheJobs.get(rootId); this.check();
      const revision = root.store.revision(revisionId)!;
      if (!root.store.sources().some(s => s.revisionId === revisionId && fs.existsSync(s.path))) {
        const metadata = await this.requestMetadata(rootId, revisionId);
        const bytes = await this.options.fetch(rootId, revisionId, syncRevisionFile(revision), metadata); this.check();
        await root.session.retainHistorical(revisionId, bytes.sourcePath, bytes.metadata, 'path');
        await this.seedRetained(rootId, revisionId);
      }
      const guard = await root.session.preparePathResolution(revisionId, toPath), previewId = crypto.randomUUID();
      for (const [id, preview] of this.pathPreviews) if (preview.rootId === rootId || preview.expires < Date.now()) this.pathPreviews.delete(id);
      if (this.pathPreviews.size >= 8) this.pathPreviews.delete(this.pathPreviews.keys().next().value!);
      this.pathPreviews.set(previewId, { rootId, guard, expires: Date.now() + 5 * 60_000 });
      return { previewId, rootId, entryId, revisionId, fromPath: revision.relativePath, toPath, size: revision.blob!.size, branches: guard.head.split(',').length };
    } finally { this.maintenance.delete(rootId); this.schedule(rootId); }
  }
  async confirmPathResolution(previewId: string): Promise<void> {
    this.check(); const preview = this.pathPreviews.get(previewId); this.pathPreviews.delete(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Sync path preview expired; review again');
    const { rootId, guard } = preview, root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId); this.stopWatcher(rootId);
    try {
      await this.settled(); const result = await root.session.resolvePath(guard); this.check();
      await this.options.seed(rootId, { revisionId: result.revision.revisionId, file: result.snapshot.file, sourcePath: result.snapshot.sourcePath, metadata: result.snapshot.metadata });
      await this.exchange.offer('', rootId);
    } finally { this.maintenance.delete(rootId); this.watchRoot(rootId); this.schedule(rootId); }
    await this.trimCache(rootId);
  }
  private missingDetector(rootId: string): RoomSyncMissing {
    let detector = this.missingFiles.get(rootId);
    if (!detector) {
      const root = this.roots.get(rootId); if (!root) throw new Error('Sync root unavailable');
      detector = new RoomSyncMissing(rootId, root.store, deriveMemberId(this.options.identity.pub)); this.missingFiles.set(rootId, detector);
    }
    return detector;
  }
  async missing(rootId: string): Promise<SyncMissingView> {
    this.check(); const root = this.roots.get(rootId), detector = this.missingDetector(rootId), binding = root?.store.binding();
    if (!root || !binding) return detector.update(null);
    const stamp = detector.stateStamp(), epoch = root.store.bindingEpoch(), generation = root.store.logGeneration();
    try {
      const scan = await scanSyncFolder(binding.path, () => this.current() && root.store.bindingEpoch() === epoch && root.store.logGeneration() === generation, root.store.exclusions());
      this.check(); return detector.update(detector.stateStamp() === stamp ? scan : null);
    } catch { this.check(); return detector.update(null); }
  }
  async prepareMissingDelete(rootId: string, entryId: string, stamp: string, acknowledgeMass = false): Promise<SyncDeletePreview> {
    this.check(); const root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId); this.stopWatcher(rootId);
    try {
      await this.settled();
      const view = await this.missing(rootId), row = view.items.find(item => item.entryId === entryId);
      if (view.blocked || !row || view.stamp !== stamp || view.mass && !acknowledgeMass) throw new Error('Sync missing files changed; review again');
      const guard = await root.session.prepareDelete(entryId);
      if (guard.digest !== null || guard.head !== row.revisionId) throw new Error('Sync missing files changed; review again');
      // Retain and verify a usable content version before publishing the absent-file tombstone.
      if (!root.store.sources().some(source => source.revisionId === row.revisionId && fs.existsSync(source.path))) {
        const revision = root.store.revision(row.revisionId)!, metadata = await this.requestMetadata(rootId, row.revisionId);
        const received = await this.options.fetch(rootId, row.revisionId, syncRevisionFile(revision), metadata);
        await root.session.retainHistorical(row.revisionId, received.sourcePath, received.metadata);
      }
      await root.session.prepareRestore(row.revisionId);
      const checked = await this.missing(rootId);
      if (checked.blocked || checked.stamp !== stamp || !checked.items.some(item => item.entryId === entryId)) throw new Error('Sync missing files changed; review again');
      const previewId = crypto.randomUUID();
      if (this.deletePreviews.size >= 8) this.deletePreviews.delete(this.deletePreviews.keys().next().value!);
      const missingCurrent = this.missingDetector(rootId).diskGuard(row.path);
      this.deletePreviews.set(previewId, { rootId, guard, missingStamp: stamp, missingCurrent, expires: Date.now() + 5 * 60_000 });
      return { previewId, rootId, entryId, path: row.path, size: row.size, mode: 'publish', copyPath: guard.copyPath, external: true };
    } finally { this.maintenance.delete(rootId); this.watchRoot(rootId); this.schedule(rootId); }
  }
  async prepareDelete(rootId: string, entryId: string, resolve = false): Promise<SyncDeletePreview> {
    this.check(); const root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId);
    try {
      const guard = await root.session.prepareDelete(entryId, resolve), previewId = crypto.randomUUID();
      if (!resolve && guard.digest === null) throw new Error('Sync missing files changed; review again');
      if (this.deletePreviews.size >= 8) this.deletePreviews.delete(this.deletePreviews.keys().next().value!);
      this.deletePreviews.set(previewId, { rootId, guard, expires: Date.now() + 5 * 60_000 });
      const revision = root.store.revision(guard.revisionId)!;
      return { previewId, rootId, entryId, path: revision.relativePath, size: guard.localSize, mode: guard.mode, copyPath: guard.copyPath };
    } finally { this.maintenance.delete(rootId); this.schedule(rootId); }
  }
  async confirmDelete(previewId: string, keepBoth = false): Promise<{ copyPath: string | null }> {
    this.check(); const preview = this.deletePreviews.get(previewId); this.deletePreviews.delete(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Sync deletion preview expired; review again');
    const { rootId, guard } = preview, root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId); this.stopWatcher(rootId);
    try {
      await this.settled();
      if (preview.missingStamp) {
        const view = await this.missing(rootId);
        if (view.blocked || view.stamp !== preview.missingStamp || !view.items.some(item => item.entryId === guard.entryId)) throw new Error('Sync missing files changed; review again');
        await root.session.prepareRestore(guard.baseRevisionId);
      }
      const result = await root.session.confirmDelete(guard, keepBoth, preview.missingCurrent); this.check();
      this.retryAt.delete(rootId + ':' + result.revision.revisionId); this.errors.delete(rootId + ':' + result.revision.revisionId);
      await this.exchange.offer('', rootId); return { copyPath: result.copyPath };
    } catch (error) {
      // A published intent can outlive a file lock or a failed local journal write.
      // Expose it for explicit retry even when the author's automatic receive mode is off.
      const heads = root.store.heads().find(h => h.entryId === guard.entryId)?.revisionIds ?? [];
      if (heads.length === 1 && root.store.revision(heads[0])?.op === 'delete') this.errors.set(rootId + ':' + heads[0], String(error));
      throw error;
    } finally { this.maintenance.delete(rootId); this.watchRoot(rootId); this.schedule(rootId); }
  }
  async confirmMove(previewId: string): Promise<void> {
    this.check(); const preview = this.movePreviews.get(previewId); this.movePreviews.delete(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Sync move preview expired; review again');
    const { rootId, guard } = preview, root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId); this.stopWatcher(rootId);
    try {
      await this.settled(); const result = await root.session.moveFile(guard); this.check();
      await this.options.seed(rootId, { revisionId: result.revision.revisionId, file: result.snapshot.file, sourcePath: result.snapshot.sourcePath, metadata: result.snapshot.metadata });
      await this.exchange.offer('', rootId);
    } finally { this.maintenance.delete(rootId); this.watchRoot(rootId); this.schedule(rootId); void this.trimBackups(rootId); }
    await this.trimCache(rootId);
  }
  async previewCheckpoint(rootId: string): Promise<SyncCheckpointPreview> {
    this.check(); const root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId);
    try {
      const plan = await root.session.prepareCheckpoint(); this.check(); const previewId = crypto.randomUUID();
      for (const [id, old] of this.checkpointPreviews) if (old.rootId === rootId || old.expires < Date.now()) this.checkpointPreviews.delete(id);
      if (this.checkpointPreviews.size >= 2) this.checkpointPreviews.delete(this.checkpointPreviews.keys().next().value!);
      this.checkpointPreviews.set(previewId, { rootId, plan, expires: Date.now() + 5 * 60_000 });
      return { rootId, previewId, version: plan.policy.v as 4 | 5 | 6, generation: plan.policy.checkpoint!.generation, activeRecords: plan.records,
        heads: plan.policy.baseHeads.length, archives: plan.archives, maxArchives: SYNC_CHECKPOINT_ARCHIVES };
    } finally { this.maintenance.delete(rootId); this.schedule(rootId); }
  }
  async confirmCheckpoint(previewId: string): Promise<void> {
    this.check(); const preview = this.checkpointPreviews.get(previewId); this.checkpointPreviews.delete(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Sync checkpoint preview expired; review again');
    const { rootId, plan } = preview, root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId); this.stopWatcher(rootId);
    try {
      await this.settled(); this.check(); await root.session.confirmCheckpoint(plan);
      this.issues.set(rootId, 'Checkpoint accepted. Review local files and resume automatic modes.');
      await this.exchange.offer('', rootId);
    } finally { this.maintenance.delete(rootId); this.schedule(rootId); }
  }
  async previewLog(rootId: string): Promise<SyncLogPreview> {
    this.check(); const root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId);
    try {
      const plan = await root.session.logPreview(); this.check();
      for (const [id, old] of this.logPreviews) if (old.rootId === rootId || old.expires < Date.now()) this.logPreviews.delete(id);
      let previewId: string | null = null;
      if (plan.savedBytes > 0) {
        if (this.logPreviews.size >= 2) this.logPreviews.delete(this.logPreviews.keys().next().value!);
        previewId = crypto.randomUUID(); this.logPreviews.set(previewId, { rootId, plan, expires: Date.now() + 5 * 60_000 });
      }
      return { rootId, previewId, ...plan.summary, afterBytes: plan.afterBytes, savedBytes: plan.savedBytes };
    } finally { this.maintenance.delete(rootId); this.schedule(rootId); }
  }
  async confirmLog(previewId: string) {
    this.check(); const preview = this.logPreviews.get(previewId); this.logPreviews.delete(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Sync log preview expired; review again');
    const { rootId, plan } = preview, root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId); this.stopWatcher(rootId);
    try { await this.settled(); this.check(); return await root.session.compactLog(plan); }
    finally { this.maintenance.delete(rootId); this.watchRoot(rootId); this.schedule(rootId); }
  }
  async cache(rootId: string, limitBytes?: number): Promise<SyncCacheView> {
    this.check(); const root = this.roots.get(rootId); if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    if (limitBytes !== undefined && !validSyncCacheLimit(limitBytes)) throw new Error('Invalid sync cache limit');
    await this.restore(); this.check();
    if (this.maintenance.has(rootId)) throw new Error('Sync maintenance in progress');
    this.maintenance.add(rootId);
    try {
      if (limitBytes !== undefined) root.store.setCacheLimit(limitBytes);
      return await root.session.cache(hash => this.options.release?.(hash) ?? Promise.resolve(false), limitBytes !== undefined);
    } finally { this.maintenance.delete(rootId); }
  }
  async previewMetadata(rootId: string, keep = 2): Promise<SyncMetadataView> {
    this.check(); const root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    if (!Number.isSafeInteger(keep) || keep < 0 || keep > SYNC_CHECKPOINT_ARCHIVES) throw new Error('Invalid retained history count');
    this.maintenance.add(rootId);
    try {
      await this.settled(); this.check();
      let prepared: { plan: SyncMetadataPlan; recoveryStamp: string }, blocked = false;
      try { prepared = await root.session.prepareMetadata(keep); }
      catch { this.check(); blocked = true; prepared = { plan: root.store.prepareMetadata(keep, () => false), recoveryStamp: '' }; }
      const { plan, recoveryStamp } = prepared, previewId = !blocked && plan.remove.length ? crypto.randomUUID() : null;
      for (const [id, p] of this.metadataPreviews) if (p.rootId === rootId || p.expires < Date.now()) this.metadataPreviews.delete(id);
      if (previewId) {
        if (this.metadataPreviews.size >= 8) this.metadataPreviews.delete(this.metadataPreviews.keys().next().value!);
        this.metadataPreviews.set(previewId, { rootId, plan, recoveryStamp, expires: Date.now() + 5 * 60_000 });
      }
      return { rootId, previewId, keep, blocked, exported: this.metadataExports.get(rootId)?.stamp === plan.historyStamp,
        beforeBytes: plan.beforeBytes, afterBytes: plan.afterBytes, removed: plan.remove.length, epochs: plan.epochs };
    } finally { this.maintenance.delete(rootId); this.schedule(rootId); }
  }
  async exportMetadata(rootId: string, password: string, target: string): Promise<SyncMetadataExportResult> {
    this.check(); const root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    const allowed = () => {
      this.check(); if (!path.isAbsolute(target)) throw new Error('An absolute history export destination is required');
      const folders = [this.options.directory, ...(this.options.forbidden ?? []), ...(this.options.otherBindings?.() ?? []),
        ...[...this.roots.values(), ...this.inactiveRoots.values()].flatMap(r => r.store.binding() ? [r.store.binding()!.path] : [])];
      if (folders.some(folder => overlaps(folder, target))) throw new Error('Save history outside shared folders and application storage');
    };
    allowed(); this.maintenance.add(rootId);
    try {
      const exported = await root.session.exportMetadata(password); allowed();
      const bytes = await writeSyncHistoryExport(target, exported.ciphertext); this.check();
      this.metadataExports.set(rootId, { stamp: exported.stamp, path: target, digest: crypto.createHash('sha256').update(exported.ciphertext).digest('hex') });
      return { path: target, bytes };
    } finally { this.maintenance.delete(rootId); this.schedule(rootId); }
  }
  async importMetadata(rootId: string, password: string, source: string): Promise<number> {
    this.check(); const root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    this.maintenance.add(rootId); this.stopWatcher(rootId);
    try { await this.settled(); const content = await readSyncHistoryExport(source); this.check(); return await root.session.importMetadata(content, password); }
    finally { this.maintenance.delete(rootId); this.watchRoot(rootId); this.schedule(rootId); }
  }
  async confirmMetadata(previewId: string): Promise<void> {
    this.check(); const preview = this.metadataPreviews.get(previewId); this.metadataPreviews.delete(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Sync metadata preview expired; review again');
    const { rootId, plan, recoveryStamp } = preview, root = this.roots.get(rootId), exported = this.metadataExports.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync root unavailable');
    if (!exported || exported.stamp !== plan.historyStamp) throw new Error('Export the current signed history before metadata cleanup');
    this.maintenance.add(rootId); this.stopWatcher(rootId);
    try {
      await this.settled(); const content = await readSyncHistoryExport(exported.path); this.check();
      if (crypto.createHash('sha256').update(content).digest('hex') !== exported.digest) throw new Error('Sync history export changed; save a new export before cleanup');
      await root.session.confirmMetadata(plan, recoveryStamp);
    } finally { this.maintenance.delete(rootId); this.watchRoot(rootId); this.schedule(rootId); }
  }
  private trimCache(rootId: string): Promise<void> {
    const root = this.roots.get(rootId); if (!root || this.maintenance.has(rootId)) return Promise.resolve();
    const previous = this.cacheJobs.get(rootId); if (previous) return previous;
    const job = root.session.cache(hash => this.options.release?.(hash) ?? Promise.resolve(false), true)
      .then(() => {}, error => { this.options.warn?.(error); }).finally(() => { this.cacheJobs.delete(rootId); });
    this.cacheJobs.set(rootId, job); return job;
  }
  async previewTrash(rootId: string, selected: string[] = []): Promise<SyncTrashView> {
    this.check(); const root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Trash binding unavailable');
    this.maintenance.add(rootId); this.stopWatcher(rootId);
    try {
      await this.settled(); const plan = await root.session.trashPreview(selected); this.check();
      for (const [id, p] of this.trashPreviews) if (p.rootId === rootId || p.expires < Date.now()) this.trashPreviews.delete(id);
      if (this.trashPreviews.size >= 4) this.trashPreviews.delete(this.trashPreviews.keys().next().value!);
      const previewId = crypto.randomUUID(); this.trashPreviews.set(previewId, { rootId, plan, expires: Date.now() + 5 * 60_000 });
      return this.trashPage(previewId);
    } finally { this.maintenance.delete(rootId); this.watchRoot(rootId); this.schedule(rootId); }
  }
  trashPage(previewId: string, offset = 0): SyncTrashView {
    this.check(); const p = this.trashPreviews.get(previewId);
    if (!p || p.expires < Date.now()) throw new Error('Trash preview expired; review again');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > SYNC_RECOVERY_OPERATION_LIMIT) throw new Error('Invalid trash page');
    return { ...p.plan.summary, rootId: p.rootId, previewId, items: p.plan.rows.slice(offset, offset + 100).map(r => ({ ...r })),
      next: offset + 100 < p.plan.rows.length ? offset + 100 : null };
  }
  async confirmTrash(previewId: string) {
    this.check(); const p = this.trashPreviews.get(previewId); this.trashPreviews.delete(previewId);
    if (!p || p.expires < Date.now()) throw new Error('Trash preview expired; review again');
    const root = this.roots.get(p.rootId); if (!root || this.maintenance.has(p.rootId)) throw new Error('Trash binding unavailable');
    this.maintenance.add(p.rootId); this.stopWatcher(p.rootId);
    try { await this.settled(); return await root.session.trashConfirm(p.plan); }
    finally { this.maintenance.delete(p.rootId); this.watchRoot(p.rootId); this.schedule(p.rootId); }
  }
  async exportTrash(previewId: string, operationId: string, pick: (name: string) => Promise<string | null>, privateRoot: string) {
    this.check(); const p = this.trashPreviews.get(previewId);
    if (!p || p.expires < Date.now()) throw new Error('Trash preview expired; review again');
    const row = p.plan.rows.find(r => r.operationId === operationId && r.exportable);
    if (!row) throw new Error('Trash copy is not exportable');
    const target = await pick(path.posix.basename(row.path)); if (!target) return null;
    this.check(); if (this.trashPreviews.get(previewId) !== p || p.expires < Date.now()) throw new Error('Trash preview expired; review again');
    const root = this.roots.get(p.rootId); if (!root || this.maintenance.has(p.rootId)) throw new Error('Trash binding unavailable');
    for (const [id, preview] of this.trashPreviews) if (preview.rootId === p.rootId) this.trashPreviews.delete(id);
    this.maintenance.add(p.rootId); this.stopWatcher(p.rootId);
    try {
      await this.settled();
      const forbidden = [privateRoot, this.options.directory, ...(this.options.forbidden ?? []), ...(this.options.otherBindings?.() ?? []), ...this.localBindings().map(b => b.path)];
      return await root.session.exportTrash(p.plan, operationId, path.resolve(target), forbidden);
    } finally { this.maintenance.delete(p.rootId); this.watchRoot(p.rootId); this.schedule(p.rootId); }
  }
  async previewBackups(rootId: string, policy?: SyncBackupPolicy): Promise<SyncBackupPreview> {
    this.check(); const root = this.roots.get(rootId);
    if (!root || !root.store.binding() || this.maintenance.has(rootId)) throw new Error('Backup binding unavailable');
    if (policy !== undefined && !validSyncBackupPolicy(policy)) throw new Error('Invalid backup retention policy');
    this.maintenance.add(rootId);
    try {
      const plan = await root.session.backupPreview(policy ?? root.store.backupPolicy()); this.check();
      const previewId = crypto.randomUUID();
      for (const [id, previous] of this.backupPreviews) if (previous.rootId === rootId || previous.expires < Date.now()) this.backupPreviews.delete(id);
      if (this.backupPreviews.size >= 4) this.backupPreviews.delete(this.backupPreviews.keys().next().value!);
      this.backupPreviews.set(previewId, { rootId, plan, expires: Date.now() + 5 * 60_000 });
      return this.backupPage(previewId);
    } finally { this.maintenance.delete(rootId); this.schedule(rootId); }
  }
  backupPage(previewId: string, offset = 0): SyncBackupPreview {
    this.check(); const preview = this.backupPreviews.get(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Backup preview expired; review again');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > SYNC_RECOVERY_OPERATION_LIMIT) throw new Error('Invalid backup page');
    const { rootId, plan } = preview;
    return { ...plan.summary, rootId, previewId, policy: { ...plan.policy }, items: plan.rows.slice(offset, offset + 100).map(r => ({ ...r })),
      next: offset + 100 < plan.rows.length ? offset + 100 : null };
  }
  async confirmBackups(previewId: string) {
    this.check(); const preview = this.backupPreviews.get(previewId); this.backupPreviews.delete(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Backup preview expired; review again');
    const root = this.roots.get(preview.rootId); if (!root || this.maintenance.has(preview.rootId)) throw new Error('Backup binding unavailable');
    this.maintenance.add(preview.rootId);
    try { return await root.session.backupConfirm(preview.plan); }
    finally { this.maintenance.delete(preview.rootId); this.backupAt.set(preview.rootId, Date.now()); this.schedule(preview.rootId); }
  }
  private trimBackups(rootId: string): Promise<void> {
    const root = this.roots.get(rootId);
    try {
      if (!this.current() || !root?.store.binding() || !root.store.backupPolicy().enabled || this.maintenance.has(rootId)) return Promise.resolve();
    } catch (error) { this.options.warn?.(error); return Promise.resolve(); }
    if (!root) return Promise.resolve();
    const previous = this.backupJobs.get(rootId); if (previous) return previous;
    if (Date.now() - (this.backupAt.get(rootId) ?? 0) < 60_000) return Promise.resolve();
    // Keep review stable while the user is choosing settings; an expired token grants no pause.
    if ([...this.backupPreviews.values()].some(p => p.rootId === rootId && p.expires >= Date.now())) return Promise.resolve();
    this.backupAt.set(rootId, Date.now());
    const job = (async () => {
      const plan = await root.session.backupPreview(); this.check();
      if (!root.store.backupPolicy().enabled || this.maintenance.has(rootId)
        || [...this.backupPreviews.values()].some(p => p.rootId === rootId && p.expires >= Date.now())) return;
      if (plan.selected.length) {
        const result = await root.session.backupConfirm(plan);
        if (result.error) throw new Error(result.error);
      }
    })().catch(error => { this.options.warn?.(error); }).finally(() => { this.backupJobs.delete(rootId); });
    this.backupJobs.set(rootId, job); return job;
  }
  private headStamp(rootId: string | null): string {
    const store = rootId && this.roots.get(rootId)?.store;
    return store ? JSON.stringify([store.policy()?.policyId, store.heads(), store.bindingEpoch(), store.binding(), store.watch().enabled]) : '';
  }
  async previewFilters(rootId: string, rules?: string[]): Promise<SyncFilterPreview> {
    this.check(); const root = this.roots.get(rootId), binding = root?.store.binding();
    if (!root || !binding || this.maintenance.has(rootId)) throw new Error('Sync filter binding unavailable');
    const selected = rules ?? root.store.exclusions();
    if (!validSyncExclusions(selected)) throw new Error('Invalid sync exclusions');
    const initial = this.headStamp(rootId), previous = root.store.exclusions();
    const epoch = root.store.bindingEpoch(), generation = root.store.logGeneration();
    for (const [id, p] of this.filterPreviews) if (p.view.rootId === rootId || p.expires < Date.now()) this.filterPreviews.delete(id);
    let scanned: Awaited<ReturnType<typeof scanSyncFolder>>;
    try { scanned = await scanSyncFolder(binding.path, () => this.current() && root.store.bindingEpoch() === epoch && root.store.logGeneration() === generation, selected, true); }
    catch (error) {
      this.check(); if (this.headStamp(rootId) !== initial) throw new Error('Sync filter context changed; review again');
      // Keep the editor accessible when exclusions are needed to fix an oversized/inaccessible tree.
      // A failed scan grants no confirmation token and never presents partial counts as complete.
      return { rootId, previewId: '', rules: [...selected], publisher: canWriteSync(root.store.policy(), deriveMemberId(this.options.identity.pub)),
        included: 0, skipped: 0, sharedIncluded: 0, sharedSkipped: 0, items: [], next: null, scanError: String(error instanceof Error ? error.message : error) };
    }
    this.check(); if (this.headStamp(rootId) !== initial) throw new Error('Sync filter context changed; review again');
    const local = (scanned.entries ?? []).map(row => this.filterChange(row, previous));
    const shared: SyncFilterRow[] = this.rows(root).map(row => this.filterChange({ path: row.path, size: row.size, directory: false, source: 'shared',
      ...(syncPathExclusion(row.path, selected) ?? { reason: 'included' as const }) }, previous));
    const rows = [...local, ...shared], previewId = crypto.randomUUID();
    const view: SyncFilterPreview = { rootId, previewId, rules: [...selected], publisher: canWriteSync(root.store.policy(), deriveMemberId(this.options.identity.pub)),
      included: scanned.files.length, skipped: scanned.skipped, sharedIncluded: shared.filter(r => r.reason === 'included').length,
      sharedSkipped: shared.filter(r => r.reason !== 'included').length, items: [], next: null };
    if (this.filterPreviews.size >= 4) this.filterPreviews.delete(this.filterPreviews.keys().next().value!);
    this.filterPreviews.set(previewId, { view, rows, context: initial, fingerprint: scanned.fingerprint, expires: Date.now() + 5 * 60_000 });
    return this.filterPage(previewId);
  }
  private filterChange(row: SyncFilterRow, previous: string[]): SyncFilterRow {
    if (!['included', 'system', 'default', 'rule'].includes(row.reason)) return row;
    const was = !syncPathExclusion(row.path, previous), included = row.reason === 'included';
    return { ...row, ...(was === included ? {} : { change: included ? 'include' as const : 'exclude' as const }) };
  }
  filterPage(previewId: string, offset = 0): SyncFilterPreview {
    this.check(); const preview = this.filterPreviews.get(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Sync filter preview expired; review again');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 12_000) throw new Error('Invalid sync filter page');
    return structuredClone({ ...preview.view, items: preview.rows.slice(offset, offset + 100), next: offset + 100 < preview.rows.length ? offset + 100 : null });
  }
  async confirmFilters(previewId: string): Promise<void> {
    this.check(); const preview = this.filterPreviews.get(previewId); this.filterPreviews.delete(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Sync filter preview expired; review again');
    const rootId = preview.view.rootId, root = this.roots.get(rootId);
    if (!root || this.maintenance.has(rootId)) throw new Error('Sync filter binding unavailable');
    this.maintenance.add(rootId); this.stopWatcher(rootId);
    try {
      await root.session.updateExclusions(preview.view.rules, async () => {
        const epoch = root.store.bindingEpoch(), generation = root.store.logGeneration();
        const valid = () => this.current() && root.store.bindingEpoch() === epoch && root.store.logGeneration() === generation;
        if (!valid() || this.headStamp(rootId) !== preview.context) throw new Error('Sync filter context changed; review again');
        const scan = await scanSyncFolder(root.store.binding()!.path, valid, preview.view.rules, true);
        if (!valid() || this.headStamp(rootId) !== preview.context || scan.fingerprint !== preview.fingerprint) throw new Error('Sync folder changed; review filters again');
      });
      for (const key of this.retryAt.keys()) if (key.startsWith(rootId + ':')) { this.retryAt.delete(key); this.errors.delete(key); }
    } finally {
      this.maintenance.delete(rootId);
      try { if (this.current()) this.watchRoot(rootId); } catch (error) { this.issues.set(rootId, String(error)); }
      this.schedule(rootId);
    }
  }
  validateChoice(choice: SyncFolderChoice): void {
    this.check();
    if (choice.kind === 'bind' && !this.roots.has(choice.rootId)) throw new Error('Unknown or paused sync root');
    if (choice.kind === 'create' && (deriveMemberId(this.options.identity.pub) !== this.options.context.ownerId
      || !choice.name.trim() || choice.name.length > 80 || this.catalog.roots().length >= SYNC_ROOT_LIMIT)) throw new Error('Invalid sync folder creation');
  }
  async preview(folder: string, choice: SyncFolderChoice): Promise<SyncFolderPreview> {
    this.validateChoice(choice); const rootId = choice.kind === 'bind' ? choice.rootId : null, root = rootId ? this.roots.get(rootId) : undefined;
    this.validateBinding(folder, rootId ?? undefined);
    const rules = root?.store.binding()?.path === path.resolve(folder) ? root.store.exclusions() : [];
    const scanned = await scanSyncFolder(folder, () => this.current(), rules); this.check();
    const local = new Set(scanned.files.map(file => file.path.normalize('NFC').toLowerCase()));
    const remote = root ? this.rows(root).filter(row => !excludedSyncPath(row.path, rules)) : [];
    const incoming = remote.length, existing = remote.filter(row => local.has(row.path.normalize('NFC').toLowerCase())).length;
    const items = root ? remote.map(row => ({ path: row.path, size: row.size, existing: local.has(row.path.normalize('NFC').toLowerCase()) }))
      : scanned.files.map(file => ({ path: file.path, size: file.size, existing: false }));
    const view: SyncFolderPreview = { previewId: crypto.randomUUID(), rootId, name: root?.store.policy()?.name ?? (choice as { name: string }).name.trim(), path: path.resolve(folder),
      localFiles: scanned.files.length, skipped: scanned.skipped, incoming, existing, items: items.slice(0, 100), more: items.length > 100 };
    if (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(view.previewId, { view, fingerprint: scanned.fingerprint, heads: this.headStamp(rootId), expires: Date.now() + 5 * 60_000 });
    return structuredClone(view);
  }
  async confirm(previewId: string): Promise<void> {
    this.check(); const preview = this.previews.get(previewId); this.previews.delete(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Sync folder preview expired; choose the folder again');
    const { view } = preview; this.validateBinding(view.path, view.rootId ?? undefined);
    const store = view.rootId ? this.roots.get(view.rootId)?.store : undefined;
    const rules = store?.binding()?.path === view.path ? store.exclusions() : [];
    const scanned = await scanSyncFolder(view.path, () => this.current(), rules); this.check();
    if (scanned.fingerprint !== preview.fingerprint || this.headStamp(view.rootId) !== preview.heads) throw new Error('Sync folder changed; review the folder again');
    if (view.rootId) {
      const root = this.roots.get(view.rootId)!;
      this.stopWatcher(view.rootId);
      if (root.store.watch().enabled) root.store.setAutoPublish(false);
      if (root.store.backupPolicy().enabled) root.store.setBackupPolicy({ ...root.store.backupPolicy(), enabled: false });
      await this.bind(view.rootId, view.path);
    } else await this.create(view.name, view.path);
  }
  private schedule(rootId: string): void {
    try { this.scheduleRoot(rootId); }
    catch (error) { this.issues.set(rootId, String(error)); this.options.warn?.(error); }
  }
  private scheduleRoot(rootId: string): void {
    if (this.maintenance.has(rootId)) return;
    const root = this.roots.get(rootId); if (!root?.store.binding()?.autoApply || !this.current()) return;
    const deferred = new Set(root.store.deferred()), conflicts = new Set(root.store.pathConflicts().flatMap(c => c.entryIds));
    const applied = new Map(root.store.applied().map(a => [a.entryId, a.revisionId])), rules = root.store.exclusions();
    for (const entry of root.store.heads().sort((a, b) => (this.retryAt.get(rootId + ':' + a.revisionIds[0]) ?? 0) - (this.retryAt.get(rootId + ':' + b.revisionIds[0]) ?? 0))) {
      if (deferred.has(entry.entryId)) continue;
      if (entry.revisionIds.length !== 1 || conflicts.has(entry.entryId)) continue;
      const id = entry.revisionIds[0], revision = root.store.revision(id)!;
      if (excludedSyncPath(revision.relativePath, rules) || applied.get(entry.entryId) === id) continue;
      const key = rootId + ':' + id; if (this.work.has(key) || this.work.size >= 32) continue;
      if ((this.retryAt.get(key) ?? 0) > Date.now()) continue;
      this.work.add(key);
      void (async () => {
        await this.restore(); this.check();
        if (revision.op === 'delete') await root.session.applyDeletion(id);
        else {
          const metadata = await this.requestMetadata(rootId, id); this.check();
          const received = await this.options.fetch(rootId, id, syncRevisionFile(revision), metadata); this.check();
          await root.session.applyReceived(id, received.sourcePath, received.metadata);
          await this.seedRetained(rootId, id);
        }
        this.retryAt.delete(key);
        this.errors.delete(key);
        await this.trimCache(rootId);
        void this.trimBackups(rootId);
      })().catch(error => {
        // A manual resolution may have completed while an older fetch was still in flight.
        try { if (excludedSyncPath(revision.relativePath, root.store.exclusions()) || root.store.applied().some(a => a.entryId === revision.entryId && a.revisionId === id)) return; }
        catch { /* A poisoned store must still report the original failure without rejecting this handler. */ }
        this.retryAt.set(key, Date.now() + 60_000); this.errors.set(key, String(error)); this.options.warn?.(error);
      })
        .finally(() => { this.work.delete(key); if (this.current()) this.schedule(rootId); });
    }
  }
}
