import { randomUUID } from 'node:crypto';
import type { DownloadDeletionPlan, DownloadDeletionPreview, DownloadRemovalSnapshot } from '../../shared/download-removal';
import { checkDownloadDeletion, DeletionPreviewError, prepareDownloadDeletion } from '../torrent/download-delete-plan';

/** Main-owned session tokens. File paths supplied by a renderer are never accepted. */
export class DownloadDeletionPreviews {
  private plans = new Map<string, { plan: DownloadDeletionPlan; bytes: number }>();
  private pending = new Map<string, Promise<DownloadDeletionPreview>>();
  private generation = 0;
  constructor(private capture: (id: string) => Promise<DownloadRemovalSnapshot>) {}
  prune() { for (const [token, entry] of this.plans) if (entry.plan.expiresAt <= Date.now()) this.plans.delete(token); }
  clear() { this.generation++; this.plans.clear(); this.pending.clear(); }
  preview(id: string): Promise<DownloadDeletionPreview> {
    if (this.pending.has(id)) return this.pending.get(id)!;
    if (this.pending.size >= 2) return Promise.reject(new DeletionPreviewError('busy'));
    const generation = this.generation;
    const job = (async () => {
      const snapshot = await this.capture(id), plan = await prepareDownloadDeletion(snapshot), token = randomUUID();
      if (generation !== this.generation) throw new DeletionPreviewError('expired');
      this.prune();
      const bytes = (plan.metadata?.length ?? 0) * 2 + JSON.stringify({ ...plan, metadata: null }).length * 2;
      let used = [...this.plans.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      for (const [old, entry] of this.plans) {
        if (this.plans.size < 8 && used + bytes <= 64 * 1024 * 1024) break;
        this.plans.delete(old); used -= entry.bytes;
      }
      if (bytes > 64 * 1024 * 1024) throw new DeletionPreviewError('busy');
      this.plans.set(token, { plan, bytes });
      return { token, downloadId: id, name: snapshot.download.name, expiresAt: plan.expiresAt, metadataReady: !!plan.metadata,
        locations: plan.roots.map(root => root.path), files: plan.files.map(({ path, size }) => ({ path, size })), missing: plan.absent.length,
        bytes: plan.files.reduce((sum, file) => sum + file.size, 0) };
    })().finally(() => { if (this.pending.get(id) === job) this.pending.delete(id); });
    this.pending.set(id, job); return job;
  }
  async consume(id: string, token: string): Promise<DownloadDeletionPlan> {
    this.prune(); const entry = this.plans.get(token); this.plans.delete(token);
    if (!entry || entry.plan.downloadId !== id) throw new DeletionPreviewError('expired');
    await checkDownloadDeletion(entry.plan); return entry.plan;
  }
}
