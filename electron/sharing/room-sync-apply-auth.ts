import type { SyncRevision, SyncPolicy } from '../../shared/room-file-sync';
import type { SyncTrashJournal } from './room-sync-trash';

export function authorizedSyncTrashJournal(store: { revision(id: string): SyncRevision | undefined }, journal: SyncTrashJournal): boolean {
  const revision = store.revision(journal.revisionId), base = store.revision(journal.baseRevisionId);
  if (!revision || revision.v < 6 || revision.op !== 'delete' || revision.relativePath !== journal.relativePath
    || !base || base.op !== 'put' || base.entryId !== revision.entryId || base.relativePath !== journal.relativePath) return false;
  const pending = [...revision.parents], seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!; if (id === base.revisionId) return true;
    if (seen.has(id)) continue; seen.add(id); const parent = store.revision(id);
    if (parent?.entryId !== revision.entryId) continue; pending.push(...parent.parents);
  }
  return false;
}

/** A journal can remove a source path only when the signed entry's ancestry names it. */
export function authorizedSyncApplyJournal(store: { revision(id: string): SyncRevision | undefined; checkpoint?(): SyncPolicy | null }, journal: { revisionId: string; relativePath: string; fromPath?: string }): boolean {
  const revision = store.revision(journal.revisionId);
  if (!revision || revision.op !== 'put' || revision.relativePath !== journal.relativePath) return false;
  if (!journal.fromPath) return true;
  if (revision.v < 3) return false;
  if (revision.v >= 4 && store.checkpoint?.()?.checkpoint?.origins.some(o => o.entryId === revision.entryId && o.path === journal.fromPath)) return true;
  const pending = [...revision.parents], seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id);
    const parent = store.revision(id);
    if (!parent) continue;
    if (parent.entryId !== revision.entryId) return false;
    if (parent.relativePath === journal.fromPath) return true;
    pending.push(...parent.parents);
  }
  return false;
}
