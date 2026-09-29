import crypto from 'node:crypto';
import { normalizeWatchEntry, validWatchSession, watchKey, type ExternalWatchUpdate, type WatchEntry, type WatchSession } from '../../shared/watch-history';
/** Latest update per launch. Exact acknowledgements cannot delete a newer sample. */
export class ExternalWatchQueue {
  private readonly entries = new Map<string, ExternalWatchUpdate>();
  constructor(read: () => unknown, private readonly write: (updates: ExternalWatchUpdate[]) => void) {
    const saved = read(); if (!Array.isArray(saved)) return;
    for (const update of saved.slice(-200)) {
      const entry = normalizeWatchEntry(update?.entry);
      if (entry && typeof update.id === 'string' && update.id.length <= 100 && validWatchSession(update.session) && update.session.key === watchKey(entry))
        this.entries.set(update.id, { id: update.id, entry, session: update.session });
    }
  }
  push(launch: string, entry: WatchEntry, session: WatchSession): void {
    const valid = normalizeWatchEntry(entry); if (!valid || !validWatchSession(session) || session.key !== watchKey(valid)) return;
    this.entries.delete(launch);
    this.entries.set(launch, { id: crypto.randomUUID(), entry: valid, session: { ...session } });
    while (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value!);
    this.persist();
  }
  list(): ExternalWatchUpdate[] { return [...this.entries.values()].map(u => ({ ...u, entry: { ...u.entry }, session: { ...u.session } })); }
  acknowledge(ids: unknown): void {
    if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || id.length > 100)) return;
    const wanted = new Set(ids); let changed = false;
    for (const [key, update] of this.entries) if (wanted.has(update.id)) { this.entries.delete(key); changed = true; }
    if (changed) this.persist();
  }
  private persist(): void { try { this.write(this.list()); } catch { /* Keep pending data in memory if disk storage fails. */ } }
}
