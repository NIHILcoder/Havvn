/** Local UI contract. These fields never enter room gossip. */
export type SyncFileStatus = 'published' | 'applied' | 'waiting' | 'receiving' | 'conflict' | 'deferred' | 'error' | 'excluded' | 'deleted';
export interface SyncWorkView { active: number; waiting: number; position?: number; reason?: 'resource-slot' }
export interface SyncFileRow { entryId: string; path: string; size: number; revisionId: string; status: SyncFileStatus; detail?: string; resolvable?: boolean; editable?: boolean; orphaned?: boolean; movable?: boolean; deleted?: boolean; deletable?: boolean; pathResolvable?: boolean }
export interface SyncRootView {
  rootId: string; name: string; paused: boolean; publisher: boolean;
  multiWriter?: boolean; owner?: boolean; writers?: string[]; moves?: boolean; deletes?: boolean; trash?: number; missing?: number;
  path: string | null; autoApply: boolean; autoPublish: boolean;
  files: number; pending: number; conflicts: number; receiving?: number; waiting?: number; error?: string; notice?: 'rights-changed';
  work?: SyncWorkView;
}
export interface SyncRoomView { enabled: boolean; canCreate: boolean; roots: SyncRootView[] }
export interface SyncWriterCandidate { memberId: string; name: string; capable: boolean; moves?: boolean; checkpoints?: boolean; multipart?: boolean; deletes?: boolean }
export interface SyncRightsPreview {
  rootId: string; previewId: string | null; version: 1 | 2 | 3 | 4 | 5 | 6; epoch: number; ownerId: string; moves: boolean; deletes?: boolean;
  selected: string[]; candidates: SyncWriterCandidate[];
}
export interface SyncFilesPage { items: SyncFileRow[]; next: number | null }
export interface SyncFolderPreview {
  previewId: string; rootId: string | null; name: string; path: string;
  localFiles: number; skipped: number; incoming: number; existing: number;
  items: Array<{ path: string; size: number; existing: boolean }>;
  more: boolean;
}
export type SyncFolderChoice = { kind: 'create'; name: string } | { kind: 'bind'; rootId: string };
export type SyncMode = 'manual' | 'receive' | 'send' | 'sync';
export type SyncLocalAction = 'auto-publish' | 'auto-apply' | `mode-${SyncMode}` | 'scan' | 'unbind' | 'open-folder' | 'cancel-work';
export function syncMode(root: Pick<SyncRootView, 'autoPublish' | 'autoApply'>): SyncMode {
  return root.autoPublish ? root.autoApply ? 'sync' : 'send' : root.autoApply ? 'receive' : 'manual';
}
export function syncFolderStatus(root: SyncRootView): 'unavailable' | 'connect' | 'conflict' | 'error' | 'rights' | 'working' | 'waiting' | 'manual' | 'ready' {
  if (root.paused) return 'unavailable';
  if (!root.path) return 'connect';
  if (root.conflicts) return 'conflict';
  if (root.error) return 'error';
  if (root.notice) return 'rights';
  if (root.work?.active || root.receiving) return 'working';
  if (syncMode(root) === 'manual') return 'manual';
  if (root.work?.waiting || root.pending || root.waiting) return 'waiting';
  return 'ready';
}
export interface SyncHistoryPage {
  items: Array<{ revisionId: string; authorId?: string; createdAt: number; size: number; current: boolean; local: boolean; deleted?: boolean }>;
  next: number | null; canRestore: boolean; path: string; branches?: number; canFetch?: boolean;
}
export interface SyncHistoryFetchResult { epochs: number; state: 'complete' | 'unavailable' | 'limit' }
export interface SyncRestorePreview { previewId: string; rootId: string; path: string; createdAt: number; replacesLocal: boolean; branches?: number; moveFrom?: string }
export interface SyncMovePreview { previewId: string; rootId: string; entryId: string; fromPath: string; toPath: string; size: number }
export interface SyncPathConflict {
  rootId: string; entryId: string; suggestedPath: string;
  versions: Array<{ revisionId: string; path: string; size: number; authorId: string; createdAt: number }>;
  others: Array<{ entryId: string; path: string; size: number; authorId: string }>; more: boolean;
}
export interface SyncPathPreview extends SyncMovePreview { revisionId: string; branches: number }
export interface SyncMetadataView {
  rootId: string; previewId: string | null; keep: number; exported: boolean; blocked?: boolean;
  beforeBytes: number; afterBytes: number; removed: number;
  epochs: Array<{ digest: string; generation: number; records: number; bytes: number; source: 'retired' | 'downloaded'; remove: boolean; reason: 'keep' | 'pending' | 'source' | 'applied' | 'recovery' | 'chain' | 'remove' }>;
}
export interface SyncMetadataExportResult { path: string; bytes: number }
export interface SyncDeletePreview { previewId: string; rootId: string; entryId: string; path: string; size: number; mode: 'publish' | 'apply'; copyPath: string; external?: boolean }
export interface SyncMissingView {
  rootId: string; stamp: string; waiting: number; mass: boolean;
  blocked: 'unavailable' | 'changed' | 'incomplete' | 'directory' | 'all' | null;
  items: Array<{ entryId: string; revisionId: string; path: string; size: number }>;
}
export interface SyncCacheView { limitBytes: number; bytes: number; protectedBytes: number; removableBytes: number; freedBytes: number }
export type SyncTrashReason = 'ready' | 'exported' | 'unfinished' | 'unverified' | 'changed' | 'unavailable' | 'different' | 'busy' | 'rolled-back';
export const SYNC_TRASH_SELECTION_LIMIT = 100;
export interface SyncTrashRow { operationId: string; path: string; size: number; createdAt: number; reason: SyncTrashReason; eligible: boolean; selected: boolean; exportable?: boolean }
export interface SyncTrashExportResult { path: string; bytes: number; digest: string }
export interface SyncTrashView {
  rootId: string; previewId: string; bytes: number; limitBytes: number; protectedBytes: number; reclaimableBytes: number;
  selectedBytes: number; selectedCopies: number; copies: number; unscanned: number; items: SyncTrashRow[]; next: number | null;
}
export interface SyncTrashResult { removedBytes: number; removedCopies: number; error?: string }
export interface SyncLogSummary {
  records: number; policies: number; revisions: number; archived: number; pending: number;
  storedBytes: number; decodedBytes: number; revisionLimit: number; policyLimit: number; decodedLimitBytes: number;
}
export interface SyncLogPreview extends SyncLogSummary { rootId: string; previewId: string | null; afterBytes: number; savedBytes: number }
export interface SyncCheckpointPreview { rootId: string; previewId: string; generation: number; activeRecords: number; heads: number; archives: number; maxArchives: number; version: 4 | 5 | 6 }
export type SyncConflictChoice = 'accept' | 'keep-both';
export interface SyncConflictPreview {
  previewId: string; rootId: string; entryId: string; path: string; revisionId: string; createdAt: number;
  local: { exists: boolean; size: number; modifiedAt: number | null }; incomingSize: number;
  copyPath: string; diff: import('./room-file-sync-diff').SyncTextDiff;
}
