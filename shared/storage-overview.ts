/** Local, read-only census. Byte counts never authorize a cleanup. */
export const STORAGE_KINDS = ['downloads', 'room-copies', 'ciphertext', 'sync-cache', 'backups', 'trash', 'drafts', 'app-cache', 'originals', 'protected'] as const;
export type StorageKind = typeof STORAGE_KINDS[number];
export type StorageIssue = 'access' | 'unsafe' | 'limit' | 'depth' | 'changed' | 'catalog' | 'encrypted' | 'metadata-limit' | 'identity' | 'canceled';
export type StorageAction = { kind: 'downloads' | 'cache' } | { kind: 'room-data' | 'documents'; roomId: string; label: string }
  | { kind: 'sync'; roomId: string; rootId?: string; label: string; section: 'cache' | 'backups' | 'trash' };
export interface StorageGroup {
  kind: StorageKind;
  logicalBytes: number | null;
  sharedBytes: number;
  files: number;
  reclaimableBytes: null;
  issues: StorageIssue[];
  actions: StorageAction[];
  moreActions: boolean;
  mixedData: boolean;
}
export interface StorageProgress { id: string; revision: number; phase: 'catalog' | 'counting'; visited: number; files: number; elapsedMs: number }
export interface StorageReport {
  id: string; status: 'complete' | 'partial' | 'canceled'; scannedAt: number; elapsedMs: number;
  uniqueLogicalBytes: number | null; uniqueReliable: boolean; files: number; visited: number; groups: StorageGroup[];
}
export const STORAGE_OPEN_PAGE = 'havvn:storage-open-page';
