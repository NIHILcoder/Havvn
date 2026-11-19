import type { Download, IpcApi } from '../../shared/types';
import { canPause, canResume } from '../../shared/state-machine';
import { createStore } from 'zustand/vanilla';

export type BatchAction = 'pause' | 'resume';
export interface BatchResult { action: BatchAction; succeeded: string[]; skipped: string[]; failed: Array<{ id: string; error: unknown }> }
export const downloadBatchState = createStore<{ busy: boolean; result: BatchResult | null }>(() => ({ busy: false, result: null }));
/** Bounded concurrency, one result per unique id; no repeat of successful commands. */
export async function runDownloadBatch(ids: Iterable<string>, action: BatchAction,
  current: () => ReadonlyMap<string, Download>, api: Pick<IpcApi, 'pauseDownload' | 'resumeDownload'>): Promise<BatchResult> {
  const result: BatchResult = { action, succeeded: [], skipped: [], failed: [] }, pending = [...new Set(ids)];
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const id = pending[cursor++], download = current().get(id);
      if (!download || !(action === 'pause' ? canPause(download.status) : canResume(download.status))) { result.skipped.push(id); continue; }
      try { await (action === 'pause' ? api.pauseDownload(id) : api.resumeDownload(id)); result.succeeded.push(id); }
      catch (error) { result.failed.push({ id, error }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker)); return result;
}
