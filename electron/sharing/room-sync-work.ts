import type { SyncWorkView } from '../../shared/room-file-sync-ui';

export type SyncWorkPriority = 'interactive' | 'background';
export interface SyncWorkOptions { owner: object; priority?: SyncWorkPriority; current?: () => boolean }
type Job = SyncWorkOptions & { active: boolean; controller: AbortController; run(signal: AbortSignal): Promise<void>; reject(error: Error): void };
export const syncWorkCanceled = () => new Error('Sync preparation canceled');

/** Only file-sync preparation. Slots are held until I/O and cleanup settle. */
export class RoomSyncWorkQueue {
  private jobs: Job[] = [];
  private interactiveStreak = 0;
  private monitor?: ReturnType<typeof setInterval>;
  constructor(private capacity = 1, private pendingLimit = 64, private interactiveBurst = 3) {
    if (![capacity, pendingLimit, interactiveBurst].every(value => Number.isInteger(value) && value > 0)) throw Error('Invalid sync work queue limits');
  }
  private current(job: Job): boolean { try { return job.current?.() ?? true; } catch { return false; } }
  private choose(waiting: Job[], streak: number): Job | undefined {
    const background = waiting.find(job => job.priority === 'background');
    return background && streak >= this.interactiveBurst ? background : waiting.find(job => job.priority !== 'background') ?? background;
  }
  view(owner: object): SyncWorkView | undefined {
    const own = this.jobs.filter(job => job.owner === owner);
    if (!own.length) return undefined;
    const waiting = this.jobs.filter(job => !job.active);
    let streak = this.interactiveStreak, position = 0;
    while (waiting.length) {
      const next = this.choose(waiting, streak)!; position++;
      if (next.owner === owner) break;
      waiting.splice(waiting.indexOf(next), 1); streak = next.priority === 'background' ? 0 : streak + 1;
    }
    const queued = own.filter(job => !job.active).length;
    return { active: own.filter(job => job.active).length, waiting: queued,
      ...(queued ? { position, reason: 'resource-slot' as const } : {}) };
  }
  run<T>(options: SyncWorkOptions, work: (signal: AbortSignal) => Promise<T>, discard?: (value: T) => Promise<void>): Promise<T> {
    if (this.jobs.length >= this.pendingLimit) return Promise.reject(Error('Sync preparation queue is full; retry after another file finishes'));
    return new Promise<T>((resolve, reject) => {
      const job: Job = { ...options, active: false, controller: new AbortController(), reject,
        run: async signal => {
          signal.throwIfAborted(); const value = await work(signal);
          if (signal.aborted) { await discard?.(value); signal.throwIfAborted(); }
          resolve(value);
        } };
      this.jobs.push(job); this.drain();
      if (this.jobs.length && !this.monitor) {
        this.monitor = setInterval(() => { this.prune(); this.drain(); }, 50);
        this.monitor.unref?.();
      }
    });
  }
  cancel(owner: object, priority?: SyncWorkPriority): void {
    for (const job of [...this.jobs]) if (job.owner === owner && (!priority || job.priority === priority)) this.abort(job);
    this.drain();
  }
  private abort(job: Job): void {
    job.controller.abort(syncWorkCanceled());
    if (!job.active) { this.jobs.splice(this.jobs.indexOf(job), 1); job.reject(syncWorkCanceled()); }
  }
  private prune(): void { for (const job of [...this.jobs]) if (!this.current(job)) this.abort(job); }
  private drain(): void {
    this.prune();
    while (this.jobs.filter(job => job.active).length < this.capacity) {
      const job = this.choose(this.jobs.filter(job => !job.active), this.interactiveStreak);
      if (!job) break;
      job.active = true; this.interactiveStreak = job.priority === 'background' ? 0 : this.interactiveStreak + 1;
      void (async () => {
        try { await job.run(job.controller.signal); }
        catch (error) {
          const canceled = error === job.controller.signal.reason || error instanceof Error && error.name === 'AbortError';
          job.reject(job.controller.signal.aborted && canceled ? syncWorkCanceled() : error instanceof Error ? error : Error(String(error)));
        }
        finally { this.jobs.splice(this.jobs.indexOf(job), 1); this.drain(); }
      })();
    }
    if (!this.jobs.length) {
      clearInterval(this.monitor); this.monitor = undefined; this.interactiveStreak = 0;
    }
  }
}

export const syncWorkQueue = new RoomSyncWorkQueue();
