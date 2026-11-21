import { getTorrentManager } from '../torrent';
import { logger } from '../utils';

const log = logger.child('SchedulerEngine');

/** Recompute all policies together; ending a schedule never restores an old snapshot. */
export class SchedulerEngine {
  private interval: NodeJS.Timeout | null = null;
  start(): void {
    if (this.interval) return;
    void this.tick();
    this.interval = setInterval(() => { void this.tick(); }, 60_000);
  }
  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }
  private async tick(): Promise<void> {
    try { await getTorrentManager().refreshEffectiveSettings(); }
    catch (error) { log.error('Scheduler tick error', { error: String(error) }); }
  }
  destroy(): void { this.stop(); }
}
let schedulerInstance: SchedulerEngine | null = null;
export function getSchedulerEngine(): SchedulerEngine {
  return schedulerInstance ??= new SchedulerEngine();
}
