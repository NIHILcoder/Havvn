import { randomUUID } from 'node:crypto';
import type { DownloadDeletionPlan } from '../../shared/download-removal';
import { createOperationOwner } from '../../shared/operations';
import {
  DOWNLOAD_UNDO_MAX_BYTES, DOWNLOAD_UNDO_MAX_ENTRIES, DOWNLOAD_UNDO_WINDOW_MS,
  downloadUndoError, type DownloadRemovalSnapshot, type DownloadRemovalResult,
  type DownloadUndoItem, type DownloadUndoResult, type DownloadUndoState, type DownloadUndoWarning,
} from '../../shared/download-removal';

interface Adapter {
  capture(id: string): Promise<DownloadRemovalSnapshot>;
  remove(id: string, deleteFiles: boolean, signature?: string, plan?: DownloadDeletionPlan): Promise<void>;
  restore(snapshot: DownloadRemovalSnapshot): Promise<{ warnings: DownloadUndoWarning[] }>;
}
interface Entry {
  item: DownloadUndoItem;
  snapshot: DownloadRemovalSnapshot | null;
  bytes: number;
  owner: ReturnType<typeof createOperationOwner>;
  pending?: Promise<DownloadUndoResult>;
  result?: DownloadUndoResult;
}

/** Bounded, session-only journal. Renderer receives tokens and labels, never sources/metadata/paths. */
export class DownloadRemovalJournal {
  private entries = new Map<string, Entry>();
  private removing = new Map<string, { promise: Promise<DownloadRemovalResult>; deleteFiles: boolean }>();
  private removalTail: Promise<unknown> = Promise.resolve();
  private revision = 0;
  constructor(private adapter: Adapter, private changed: () => void = () => {}, private now = Date.now, private token = randomUUID) {}
  private publish() { this.revision++; try { this.changed(); } catch { /* Closed observer. */ } }
  prune(): void {
    let changed = false;
    for (const [token, entry] of this.entries) if (!entry.pending && entry.item.expiresAt <= this.now()) { this.entries.delete(token); changed = true; }
    if (changed) this.publish();
  }
  state(): DownloadUndoState {
    this.prune();
    return { revision: this.revision, items: [...this.entries.values()].map(entry => structuredClone(entry.item)) };
  }
  private forgetDownload(id: string) {
    for (const [token, entry] of this.entries) if (entry.item.downloadId === id && !entry.pending) this.entries.delete(token);
  }
  remove(id: string, deleteFiles: boolean, plan?: DownloadDeletionPlan): Promise<DownloadRemovalResult> {
    const pending = this.removing.get(id);
    if (pending) return pending.deleteFiles === deleteFiles ? pending.promise : Promise.reject(new Error('A different removal is already in progress'));
    if ([...this.entries.values()].some(entry => entry.item.downloadId === id && entry.pending)) return Promise.reject(new Error('Download restoration is in progress'));
    // Serial capture bounds temporary metadata buffers even for a large batch.
    const work = this.removalTail.then(() => this.performRemove(id, deleteFiles, plan)).finally(() => { if (this.removing.get(id)?.promise === work) this.removing.delete(id); });
    this.removalTail = work.catch(() => {});
    this.removing.set(id, { promise: work, deleteFiles });
    return work;
  }
  private async performRemove(id: string, deleteFiles: boolean, plan?: DownloadDeletionPlan): Promise<DownloadRemovalResult> {
    this.prune();
    let snapshot: DownloadRemovalSnapshot | null = null, unavailable: DownloadRemovalResult['unavailable'];
    if (!deleteFiles) {
      try { snapshot = await this.adapter.capture(id); }
      catch (error) { unavailable = downloadUndoError(error); }
    }
    if (plan) await this.adapter.remove(id, deleteFiles, plan.signature, plan);
    else await this.adapter.remove(id, deleteFiles, snapshot?.signature);
    this.forgetDownload(id);
    if (snapshot) {
      const bytes = JSON.stringify(snapshot).length * 2;
      if (bytes > DOWNLOAD_UNDO_MAX_BYTES) { snapshot = null; unavailable = 'too-large'; }
      else {
        let used = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
        for (const [token, entry] of this.entries) {
          if (this.entries.size < DOWNLOAD_UNDO_MAX_ENTRIES && used + bytes <= DOWNLOAD_UNDO_MAX_BYTES) break;
          if (!entry.pending) { this.entries.delete(token); used -= entry.bytes; }
        }
        if (this.entries.size >= DOWNLOAD_UNDO_MAX_ENTRIES || used + bytes > DOWNLOAD_UNDO_MAX_BYTES) { snapshot = null; unavailable = 'too-large'; }
        else {
          const token = this.token();
          const owner = createOperationOwner();
          const item: DownloadUndoItem = { token, downloadId: id, name: snapshot.download.name.slice(0, 240),
            expiresAt: this.now() + DOWNLOAD_UNDO_WINDOW_MS, status: 'available', operation: null };
          this.entries.set(token, { item, snapshot, bytes, owner }); this.publish();
          return { undo: structuredClone(item) };
        }
      }
    }
    this.publish();
    return { undo: null, ...(unavailable ? { unavailable } : {}) };
  }
  undo(token: string): Promise<DownloadUndoResult> {
    this.prune();
    const entry = this.entries.get(token);
    if (!entry) return Promise.resolve({ success: false, error: 'expired' });
    if (entry.pending) return entry.pending;
    if (entry.result) return Promise.resolve(structuredClone(entry.result));
    const work = this.performUndo(entry).finally(() => { if (entry.pending === work) entry.pending = undefined; this.prune(); });
    entry.pending = work;
    return work;
  }
  private async performUndo(entry: Entry): Promise<DownloadUndoResult> {
    const attempt = entry.owner.start('restore-download');
    entry.item.status = 'restoring'; delete entry.item.error;
    entry.item.operation = entry.owner.snapshot(); this.publish();
    try {
      const { warnings } = await this.adapter.restore(structuredClone(entry.snapshot!));
      entry.owner.finish(attempt, 'succeeded');
      entry.item.status = 'restored'; entry.item.warnings = warnings;
      entry.item.expiresAt = this.now() + 5_000;
      entry.snapshot = null; entry.bytes = 0;
      entry.result = { success: true, downloadId: entry.item.downloadId, warnings };
      return structuredClone(entry.result);
    } catch (error) {
      entry.owner.finish(attempt, 'failed');
      entry.item.status = 'failed'; entry.item.error = downloadUndoError(error);
      return { success: false, error: entry.item.error };
    } finally { entry.item.operation = entry.owner.snapshot(); this.publish(); }
  }
}
