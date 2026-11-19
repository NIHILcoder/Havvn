import { resolveResourceMode, validateResourceMode, type PowerSource, type ResourceMode, type ResourceModeSnapshot } from '../../shared/resource-mode';

/** Runtime policy only; preferences for appearance/player are never written here. */
export class ResourceModeController {
  private state = resolveResourceMode('normal', 'unknown');
  private listeners = new Set<(snapshot: ResourceModeSnapshot) => void>();
  private request = 0;
  private powerRevision = 0;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private deps: {
    readMode: () => Promise<ResourceMode>;
    writeMode: (mode: ResourceMode) => Promise<unknown>;
    readPower: () => PowerSource;
  }) {}
  peek(): ResourceModeSnapshot { return { ...this.state }; }
  subscribe(listener: (snapshot: ResourceModeSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private commit(mode: ResourceMode, power: PowerSource): ResourceModeSnapshot {
    const next = resolveResourceMode(mode, power, this.state.revision);
    if (next.mode !== this.state.mode || next.power !== this.state.power) {
      this.state = { ...next, revision: this.state.revision + 1 };
      for (const listener of this.listeners) {
        try { listener(this.peek()); } catch { /* A closed observer cannot block other consumers. */ }
      }
    }
    return this.peek();
  }
  receivePower(power: PowerSource): void { this.powerRevision++; this.commit(this.state.mode, power); }
  async refresh(): Promise<ResourceModeSnapshot> {
    const request = ++this.request, powerRevision = this.powerRevision;
    const mode = validateResourceMode(await this.deps.readMode());
    if (request !== this.request) return this.peek();
    let power = this.state.power;
    if (powerRevision === this.powerRevision) { try { power = this.deps.readPower(); } catch { power = 'unknown'; } }
    return this.commit(mode, power);
  }
  setMode(input: unknown): Promise<ResourceModeSnapshot> {
    const mode = validateResourceMode(input);
    const work = this.writes.catch(() => {}).then(async () => { await this.deps.writeMode(mode); return this.refresh(); });
    this.writes = work; return work;
  }
}
