import type { AppSettings, NetworkProfile, SchedulerConfig } from '../../shared/types';
import { resolveEffectiveSettings, type EconomyLimits, type EffectiveSettingsSnapshot, type TransferBlock } from '../../shared/effective-settings';

/** Single writer for derived engine settings. No persisted base values are written here. */
export class EffectiveSettingsController {
  private network: NetworkProfile | null = null;
  private economy: EconomyLimits | null = null;
  private blocks = new Set<TransferBlock>();
  private tail: Promise<void> = Promise.resolve();
  private snapshot: EffectiveSettingsSnapshot | null = null;
  private generation = 0;
  constructor(private deps: {
    readBase: () => Promise<AppSettings>;
    readScheduler: () => Promise<SchedulerConfig>;
    apply: (patch: Partial<AppSettings>) => Promise<void>;
    now?: () => Date;
  }) {}

  getBlocks(): TransferBlock[] { return [...this.blocks]; }
  invalidate(): void { this.generation++; if (this.snapshot) this.snapshot = { ...this.snapshot, applied: false }; }
  setBlock(reason: TransferBlock, blocked: boolean): void {
    if (blocked) this.blocks.add(reason); else this.blocks.delete(reason);
    if (this.snapshot) this.snapshot = { ...this.snapshot, blocks: this.getBlocks() };
  }
  setNetwork(profile: NetworkProfile | null): Promise<void> {
    this.network = profile ? structuredClone(profile) : null;
    return this.refresh();
  }
  setEconomy(limits: EconomyLimits | null): Promise<void> {
    this.economy = limits ? { ...limits } : null;
    return this.refresh();
  }
  async resolve(): Promise<{ base: AppSettings; effective: ReturnType<typeof resolveEffectiveSettings> }> {
    const [base, scheduler] = await Promise.all([this.deps.readBase(), this.deps.readScheduler()]);
    return { base, effective: resolveEffectiveSettings(base, { scheduler, network: this.network, economy: this.economy,
      blocks: this.getBlocks(), now: this.deps.now?.() }) };
  }
  async getSnapshot(): Promise<EffectiveSettingsSnapshot> {
    if (this.snapshot) return structuredClone(this.snapshot);
    return { ...(await this.resolve()).effective, applied: false };
  }
  refresh(patch: Partial<AppSettings> = {}): Promise<void> {
    const work = this.tail.catch(() => {}).then(async () => {
      const { effective } = await this.resolve();
      const revision = this.generation;
      this.snapshot = { ...effective, applied: false };
      await this.deps.apply({ ...patch, ...effective.engine });
      this.snapshot = { ...effective, blocks: this.getBlocks(), applied: revision === this.generation };
    });
    this.tail = work;
    return work;
  }
}
