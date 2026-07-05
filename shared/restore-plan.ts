/**
 * Startup restore planning — pure partitioning extracted from the manager's
 * initialize() loop. This is the logic that fixed the "every restored torrent
 * hash-checks its on-disk data at once" startup disk-thrash: only 'downloading'
 * torrents count against maxActiveDownloads, 'seeding' always resumes (it holds
 * no download slot), the overflow is re-queued lowest-priority-first, and 'queued'
 * rows are left for processQueue(). It has product-visible consequences (the app
 * was unusable on startup before it) so it's worth pinning.
 */

export interface RestorableDownload {
  status: string;
  priority?: number | null;
}

export interface RestorePlan<T extends RestorableDownload> {
  /** Bring these live now (in priority order). */
  live: T[];
  /** Transition these back to 'queued' so processQueue() starts them as slots free. */
  requeue: T[];
}

/**
 * Partition restorable downloads into what to bring live vs re-queue, honouring
 * maxActive. Higher priority claims the live download slots first. Seeding never
 * counts against the limit; 'queued' rows are ignored (left for the queue).
 */
export function planRestore<T extends RestorableDownload>(downloads: T[], maxActive: number): RestorePlan<T> {
  const live: T[] = [];
  const requeue: T[] = [];
  let slots = Math.max(0, maxActive);

  const ranked = downloads
    .filter((d) => d.status === 'downloading' || d.status === 'seeding' || d.status === 'queued')
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const d of ranked) {
    if (d.status === 'seeding') {
      live.push(d);
    } else if (d.status === 'downloading') {
      if (slots > 0) {
        live.push(d);
        slots--;
      } else {
        requeue.push(d);
      }
    }
    // 'queued' left untouched for processQueue().
  }

  return { live, requeue };
}
