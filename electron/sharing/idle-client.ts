import type { EventEmitter } from 'node:events';

interface Client extends EventEmitter { torrents: unknown[]; destroyed?: boolean }
/** Reclaim empty clients, while asynchronous hashing/verification holds a lease. */
export class IdleClientReaper {
  private entries = new WeakMap<Client, { holds: number; timer?: ReturnType<typeof setTimeout>; schedule: () => void }>();
  constructor(private retire: (client: Client) => void, private delay = 5000) {}
  watch(client: Client): void {
    if (this.entries.has(client)) return;
    const entry = { holds: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined, schedule: () => {} };
    this.entries.set(client, entry);
    const schedule = () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      if (client.destroyed || entry.holds || !Array.isArray(client.torrents) || client.torrents.length) return;
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        if (!client.destroyed && !entry.holds && Array.isArray(client.torrents) && !client.torrents.length) this.retire(client);
      }, this.delay);
      entry.timer.unref?.();
    };
    entry.schedule = schedule; client.on('remove', schedule);
    client.once('close', () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined; client.removeListener('remove', schedule); this.entries.delete(client);
    });
    schedule();
  }
  hold(client: Client): () => void {
    this.watch(client);
    const entry = this.entries.get(client)!;
    entry.holds++;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    let released = false;
    return () => {
      if (released) return; released = true; entry.holds--;
      entry.schedule();
    };
  }
}
