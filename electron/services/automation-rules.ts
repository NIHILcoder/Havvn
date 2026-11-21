import { randomUUID } from 'node:crypto';
import type { AddDownloadRequest, Category, Download } from '../../shared/types';
import { EMPTY_AUTOMATION, applyAutomationPlan, automationInput, automationReceipt, isAutomationReceipt, planAutomation, validateAutomationRules,
  type AutomationConfig, type AutomationEvent, type AutomationInput, type AutomationReceipt, type AutomationSnapshot } from '../../shared/automation-rules';

export interface AutomationAdapter {
  readConfig(): AutomationConfig | null; writeConfig(config: AutomationConfig): void;
  categories(): Promise<Category[]>; downloads(): Promise<Download[]>; download(id: string): Promise<Download | null>;
  persist(id: string, event: AutomationEvent, receipt: AutomationReceipt): Promise<void>;
  category(id: string, category: string): Promise<void>;
  notify(download: Download, receipt: AutomationReceipt): Promise<void>;
  history(id: string, failed: boolean): void;
}
/** Receipts live with the download. No action creates downloads, runs a shell or deletes files. */
export class AutomationRules {
  private config: AutomationConfig = structuredClone(EMPTY_AUTOMATION);
  private ready = true;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private adapter: AutomationAdapter, private uuid: () => string = randomUUID, private now = Date.now) {
    try {
      const raw = adapter.readConfig();
      if (raw) {
        if (raw.schema !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0) throw Error('Invalid automation config');
        this.config = { schema: 1, revision: raw.revision, rules: validateAutomationRules(raw.rules) };
      }
    } catch { this.ready = false; }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  async snapshot(): Promise<AutomationSnapshot> {
    const downloads = await this.adapter.downloads();
    const history = downloads.flatMap(download => Object.values(download.automation ?? {}).filter(isAutomationReceipt).map(receipt => ({ downloadId: download.id, receipt })))
      .sort((a,b) => b.receipt.at - a.receipt.at).slice(0,100);
    return structuredClone({ config: this.config, storage: this.ready ? 'ready' : 'unavailable', history });
  }
  async save(raw: AutomationConfig): Promise<AutomationSnapshot> {
    if (!this.ready) throw Error('Automation storage unavailable');
    if (!raw || raw.schema !== 1 || raw.revision !== this.config.revision) throw Error('Automation config changed; reload');
    const rules = validateAutomationRules(raw.rules).map(rule => {
      const old = this.config.rules.find(r => r.id === rule.id);
      return { ...rule, version: old ? old.version + (JSON.stringify({ ...old, version: 0 }) === JSON.stringify({ ...rule, version: 0 }) ? 0 : 1) : 1 };
    });
    const next: AutomationConfig = { schema: 1, revision: this.config.revision + 1, rules };
    this.adapter.writeConfig(next); this.config = next;
    return this.snapshot();
  }
  async preview(input: AutomationInput, rules: unknown) { return planAutomation(validateAutomationRules(rules), input, await this.adapter.categories()); }
  async prepare(request: AddDownloadRequest): Promise<{ request: AddDownloadRequest; receipt?: AutomationReceipt }> {
    // Incoming private receipts are never trusted, including from old renderers.
    const clean = { ...request }; delete clean.automation;
    if (!this.ready || !this.config.rules.some(r => r.enabled && r.event === 'added')) return { request: clean };
    const input = automationInput(clean), plan = planAutomation(this.config.rules, input, await this.adapter.categories());
    const receipt = automationReceipt(plan, input, this.uuid(), this.now());
    return { request: applyAutomationPlan(clean, plan), receipt };
  }
  completion(download: Download, categories: Category[]): AutomationReceipt | undefined {
    if (!this.ready || !this.config.rules.some(r => r.enabled && r.event === 'completed')) return undefined;
    const input: AutomationInput = { event: 'completed', name: download.name, sourceType: download.sourceType, categoryId: download.category ?? undefined,
      explicitCategory: download.category !== null && download.categoryOrigin !== 'automation', explicitDefaults: {} };
    return automationReceipt(planAutomation(this.config.rules, input, categories), input, this.uuid(), this.now());
  }
  process(id: string, retry = false): Promise<void> { return this.serial(async () => {
    if (!this.ready) return;
    for (const event of ['added', 'completed'] as const) {
      let download = await this.adapter.download(id);
      const stored = download?.automation?.[event];
      if (!isAutomationReceipt(stored) || !download || download.status === 'removed') continue;
      const receipt = structuredClone(stored);
      if (receipt.runs.every(run => run.status === 'completed') || (!retry && receipt.runs.some(run => run.status === 'failed'))) continue;
      const persist = () => this.adapter.persist(id, event, receipt);
      try {
        // Reconcile the effect before retry. A manual category edit made since
        // capture wins, even when a crash left the old run marked started.
        if (!receipt.categoryApplied && receipt.plan.categoryId) {
          download = (await this.adapter.download(id))!;
          if (download.category !== receipt.plan.categoryId) {
            if (download.category !== receipt.expectedCategory) receipt.runs.forEach(run => { run.reason = 'user-changed'; });
            else await this.adapter.category(id, receipt.plan.categoryId);
          }
          receipt.categoryApplied = true; await persist();
        }
        // One event produces one policy-controlled request. Claim BEFORE output:
        // a crash can lose the popup, but replay cannot flood duplicate popups.
        if (receipt.runs.some(run => run.notify === 'claimed')) receipt.runs.forEach(run => { if (run.notify === 'claimed') run.reason = 'notification-uncertain'; });
        const pending = receipt.runs.filter(run => run.notify === 'pending');
        if (pending.length) {
          pending.forEach(run => { run.notify = 'claimed'; }); await persist();
          download = (await this.adapter.download(id))!;
          if (!download || download.status === 'removed') continue;
          await this.adapter.notify(download, receipt);
          pending.forEach(run => { run.notify = 'requested'; }); await persist();
        }
        receipt.runs.forEach(run => { run.status = 'completed'; if (run.reason === 'effect-failed') delete run.reason; });
        await persist(); this.adapter.history(id, false);
      } catch {
        receipt.runs.forEach(run => { run.status = 'failed'; run.reason = run.notify === 'claimed' ? 'notification-uncertain' : 'effect-failed'; });
        try { await persist(); } catch { /* Durable started receipt is reconciled on restart. */ }
        this.adapter.history(id, true);
      }
    }
  }); }
  async recover(): Promise<void> { for (const download of await this.adapter.downloads()) if (download.automation) await this.process(download.id); }
}
