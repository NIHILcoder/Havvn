/** Device-local retention policy; never part of room gossip. */
export interface SyncBackupPolicy { enabled: boolean; keepVersions: number; maxAgeDays: number; limitBytes: number }
export const DEFAULT_SYNC_BACKUP_POLICY: Readonly<SyncBackupPolicy> = { enabled: false, keepVersions: 10, maxAgeDays: 30, limitBytes: 1024 ** 3 };
export function validSyncBackupPolicy(value: unknown): value is SyncBackupPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).length !== 4 || Object.keys(value).some(k => !['enabled', 'keepVersions', 'maxAgeDays', 'limitBytes'].includes(k))) return false;
  const p = value as SyncBackupPolicy;
  return typeof p.enabled === 'boolean' && Number.isSafeInteger(p.keepVersions) && p.keepVersions >= 1 && p.keepVersions <= 1000
    && Number.isSafeInteger(p.maxAgeDays) && p.maxAgeDays >= 0 && p.maxAgeDays <= 3650
    && Number.isSafeInteger(p.limitBytes) && p.limitBytes >= 0 && p.limitBytes <= 100 * 1024 ** 3;
}
export type SyncBackupReason = 'retained' | 'latest' | 'current' | 'unfinished' | 'unverified' | 'changed' | 'rolled-back' | 'count' | 'age' | 'budget';
export interface SyncBackupRow { operationId: string; path: string; size: number; createdAt: number; remove: boolean; reason: SyncBackupReason }
export interface SyncBackupSummary {
  bytes: number; protectedBytes: number; removeBytes: number; copies: number; removeCopies: number; unscanned: number;
}
export interface SyncBackupPreview extends SyncBackupSummary {
  previewId: string; rootId: string; policy: SyncBackupPolicy; items: SyncBackupRow[]; next: number | null;
}
export interface SyncBackupResult { removedBytes: number; removedCopies: number; bytes: number; error?: string }
