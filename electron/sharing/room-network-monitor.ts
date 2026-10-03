import os from 'node:os';

/** Addresses only; never public-IP lookups or a VPN verdict. Our LAN adapter is
 * excluded so creating/removing it cannot tear down its own session. */
export function roomNetworkFingerprint(interfaces = os.networkInterfaces()): string {
  return Object.entries(interfaces).flatMap(([name, addresses]) =>
    name.startsWith('Havvn LAN-') ? [] : (addresses ?? []).filter(a => !a.internal)
      .map(a => [name, a.family, a.address, a.netmask, a.scopeid ?? 0].join('|')),
  ).sort().join('\n');
}

export interface RoomNetworkMonitorDeps {
  fingerprint(): string;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  changed(): Promise<void>;
  error(error: unknown): void;
}

/** Poll main-process interfaces; hidden renderer online events miss TUN changes.
 * Two equal samples debounce transient address changes. Work is serialized and
 * never reinstates LAN membership, microphone capture or a game process. */
export class RoomNetworkMonitor {
  private timer: ReturnType<typeof setInterval>;
  private stable: string;
  private candidate: string;
  private asleep = false;
  private disposed = false;
  private changeQueued = false;
  private lifecycleEpoch = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private deps: RoomNetworkMonitorDeps) {
    this.stable = this.candidate = deps.fingerprint();
    this.timer = setInterval(() => this.poll(), 3000);
    this.timer.unref();
  }

  private run(action: () => Promise<void>): void {
    this.queue = this.queue.then(() => this.disposed ? undefined : action()).catch(this.deps.error);
  }

  poll(): void {
    if (this.disposed || this.asleep) return;
    try {
      const next = this.deps.fingerprint();
      if (next === this.stable) { this.candidate = next; return; }
      if (next !== this.candidate) { this.candidate = next; return; }
      this.stable = next;
      if (this.changeQueued) return;
      this.changeQueued = true;
      const epoch = this.lifecycleEpoch;
      this.run(async () => {
        if (epoch !== this.lifecycleEpoch || this.asleep) { this.changeQueued = false; return; }
        try { await this.deps.changed(); }
        finally {
          this.changeQueued = false;
          // Recheck the latest network once, rather than accumulating a job per
          // transient address while an earlier reconnect is still waiting.
          if (epoch === this.lifecycleEpoch && !this.asleep && this.stable !== next) this.stable = next;
        }
      });
    } catch (error) { this.deps.error(error); }
  }

  suspend = (): void => {
    if (this.disposed || this.asleep) return;
    this.asleep = true; this.lifecycleEpoch++;
    // Invoke now: the manager must gate new networking before Windows sleeps.
    const pending = this.deps.suspend().catch(this.deps.error);
    this.run(() => pending);
  };

  resume = (): void => {
    if (this.disposed || !this.asleep) return;
    this.asleep = false; this.lifecycleEpoch++;
    try { this.stable = this.candidate = this.deps.fingerprint(); }
    catch (error) { this.deps.error(error); }
    this.run(this.deps.resume);
  };

  dispose(): void { this.disposed = true; clearInterval(this.timer); }
}
