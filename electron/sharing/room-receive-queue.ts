type Job = { owner: object; id: string; active: boolean; resolve: (release: () => void) => void; reject: (e: Error) => void };

/** Slots are held until verification/decryption settles, not just torrent.add(). */
export class RoomReceiveQueue {
  private jobs: Job[] = [];
  constructor(private capacity = 2, private pendingLimit = 512, private changed: () => void = () => {}) {}
  position(owner: object, id: string): number | undefined {
    const waiting = this.jobs.filter(job => !job.active);
    const index = waiting.findIndex(job => job.owner === owner && job.id === id);
    return index < 0 ? undefined : index + 1;
  }
  positions(owner: object): Map<string, number> {
    const positions = new Map<string, number>(); let index = 0;
    for (const job of this.jobs) if (!job.active) { index++; if (job.owner === owner) positions.set(job.id, index); }
    return positions;
  }
  counts(owner: object): { active: number; waiting: number } {
    const own = this.jobs.filter(job => job.owner === owner);
    return { active: own.filter(job => job.active).length, waiting: own.filter(job => !job.active).length };
  }
  prioritize(owner: object, id: string): void {
    const job = this.jobs.find(job => job.owner === owner && job.id === id && !job.active);
    if (!job) return;
    this.jobs.splice(this.jobs.indexOf(job), 1);
    this.jobs.unshift(job); this.changed();
  }
  acquire(owner: object, id: string): Promise<() => void> {
    if (this.jobs.length >= this.pendingLimit) return Promise.reject(new Error('Room receive queue is full. Retry after another file finishes.'));
    return new Promise((resolve, reject) => {
      this.jobs.push({ owner, id, active: false, resolve, reject }); this.drain();
    });
  }
  cancel(owner: object, id?: string): void {
    for (const job of [...this.jobs]) if (job.owner === owner && (id === undefined || job.id === id)) this.remove(job, true);
    this.drain();
  }
  cancelWaiting(owner: object, id?: string): void {
    for (const job of [...this.jobs]) if (job.owner === owner && !job.active && (id === undefined || job.id === id)) this.remove(job, true);
    this.drain();
  }
  private remove(job: Job, cancel = false): void {
    const index = this.jobs.indexOf(job); if (index < 0) return;
    this.jobs.splice(index, 1);
    if (cancel && !job.active) job.reject(new Error('Room receive canceled'));
  }
  private drain(): void {
    while (this.jobs.filter(j => j.active).length < this.capacity) {
      const job = this.jobs.find(j => !j.active); if (!job) return;
      job.active = true;
      job.resolve(() => { this.remove(job); this.drain(); });
    }
    this.changed();
  }
}
