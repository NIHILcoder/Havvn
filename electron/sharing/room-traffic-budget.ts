import { allocateRoomRates, readRoomResources, roomFileBudget, validateRoomResources, type RoomResourcePolicy } from '../../shared/room-resources';

interface Client {
  throttleUpload(rate: number): unknown;
  throttleDownload(rate: number): unknown;
}
interface Entry { client: Client; up: number; down: number; applied: [number, number] }

/** Transactional allocation across room file clients, never a separate budget per room. */
export class RoomTrafficBudget {
  private entries = new Map<string, Entry>();
  private policy = readRoomResources();
  private voiceActive = false;
  constructor(private stop: (id: string) => void) {}

  getPolicy(): RoomResourcePolicy { return { ...this.policy }; }
  isVoicePriorityActive(): boolean { return this.policy.voicePriority && this.voiceActive; }
  rates(id: string): [number, number] | undefined { return this.entries.get(id)?.applied.slice() as [number, number] | undefined; }

  /** Caller constructs the new client with BOTH rates zero, before networking starts. */
  register(id: string, client: Client, up: number, down: number): void {
    if (this.entries.has(id)) throw new Error('Room client already registered');
    this.entries.set(id, { client, up, down, applied: [0, 0] });
    try { this.reallocate(); }
    catch (error) { this.entries.delete(id); this.stop(id); throw error; }
  }
  /** Remove only after the client's transports have stopped. */
  remove(id: string): void { this.entries.delete(id); this.reallocate(); }
  setLimits(id: string, up: number, down: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const old = [entry.up, entry.down]; entry.up = up; entry.down = down;
    try { this.reallocate(); }
    catch (error) { [entry.up, entry.down] = old; throw error; }
  }
  configure(value: unknown): void {
    const next = validateRoomResources(value), old = this.policy;
    this.policy = next;
    try { this.reallocate(); }
    catch (error) { this.policy = old; throw error; }
  }
  setVoiceActive(active: boolean): void {
    if (active === this.voiceActive) return;
    const old = this.voiceActive; this.voiceActive = active;
    try { this.reallocate(); }
    catch (error) { this.voiceActive = old; throw error; }
  }

  private write(entry: Entry, axis: 0 | 1, rate: number): void {
    if (entry.applied[axis] === rate) return;
    const result = axis === 0 ? entry.client.throttleUpload(rate) : entry.client.throttleDownload(rate);
    if (result === false) throw new Error('Room limiter rejected the rate');
    entry.applied[axis] = rate;
  }
  private apply(entries: Entry[], rates: [number, number][]): void {
    // Lower ceilings first, then give the freed budget to other clients.
    for (const axis of [0, 1] as const) {
      entries.forEach((entry, i) => {
        if (rates[i][axis] !== -1 && (entry.applied[axis] === -1 || rates[i][axis] < entry.applied[axis])) this.write(entry, axis, rates[i][axis]);
      });
      entries.forEach((entry, i) => this.write(entry, axis, rates[i][axis]));
    }
  }
  private reallocate(): void {
    const entries = [...this.entries.values()], previous = entries.map(e => [...e.applied] as [number, number]);
    const total = roomFileBudget(this.policy, this.voiceActive);
    const up = allocateRoomRates(total.up, entries.map(e => e.up)), down = allocateRoomRates(total.down, entries.map(e => e.down));
    try { this.apply(entries, entries.map((_, i) => [up[i], down[i]])); }
    catch (error) {
      // A throwing setter may have mutated before throwing: force both axes back.
      try {
        entries.forEach(e => { e.applied = [-2, -2]; });
        this.apply(entries, previous);
      } catch {
        // Unknown limiter state must not continue sending without a known budget.
        const ids = [...this.entries.keys()]; this.entries.clear();
        for (const id of ids) this.stop(id);
      }
      throw error;
    }
  }
}
