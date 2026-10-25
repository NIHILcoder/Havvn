import { DEFAULT_NOTIFICATION_POLICY, resolveNotificationPolicy, type NotificationContext, type NotificationDecision, type NotificationEnvironment } from '../../shared/notification-policy';

export interface NotificationNotice {
  title: string; body: string; context: NotificationContext;
  critical?: boolean; onClick?: () => void;
  silent?: boolean;
}
interface Pending { notice: NotificationNotice; admitted: NotificationDecision }
interface Bucket { items: Pending[]; timer: ReturnType<typeof setTimeout> }

/** Session-only, bounded batching. Policy and privacy are checked again just before output. */
export class NotificationCenter {
  private buckets = new Map<string, Bucket>();
  private pending = 0;
  private reading = 0;
  private delivering = 0;
  private generation = 0;
  constructor(private adapter: {
    read(context: NotificationContext): Promise<NotificationEnvironment>;
    readMany?(contexts: NotificationContext[]): Promise<NotificationEnvironment[]>;
    popup(message: { title: string; body: string; critical: boolean; onClick?: () => void }): void;
    sound(): void;
    privateMessage(): { title: string; body: string };
    summary(kind: NotificationContext['kind'], count: number): { title: string; body: string };
  }, private now = () => new Date()) {}

  async notify(input: NotificationNotice): Promise<void> {
    if (this.pending + this.delivering >= 1000 || this.reading >= 64) return;
    const generation = this.generation;
    this.reading++;
    let env: NotificationEnvironment;
    try { env = await this.adapter.read(input.context); } catch { return; } finally { this.reading--; }
    if (generation !== this.generation) return;
    const decision = resolveNotificationPolicy(input.context, env, this.now());
    if (input.silent) decision.sound = false;
    if (!decision.popups && !decision.sound) return;
    const notice = { ...input, title: input.title.slice(0, 200), body: input.body.slice(0, 500), context: { ...input.context } };
    if (!decision.showContent) Object.assign(notice, this.adapter.privateMessage());
    const item: Pending = { notice, admitted: decision };
    const summary = (env.settings.notificationPolicy ?? DEFAULT_NOTIFICATION_POLICY).summaries;
    if (!summary.enabled || input.critical) { await this.deliver([item], generation); return; }
    const key = JSON.stringify([notice.context.kind, notice.context.roomId ?? '', env.categoryId ?? notice.context.categoryId ?? '', notice.context.group ?? '']);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 64) return;
      const timer = setTimeout(() => { void this.flush(key); }, summary.windowSeconds * 1000); timer.unref?.();
      bucket = { items: [], timer }; this.buckets.set(key, bucket);
    }
    if (this.pending + this.delivering >= 1000 || bucket.items.length >= 100) return;
    if (notice.context.downloadId && bucket.items.some(item => item.notice.context.kind === notice.context.kind && item.notice.context.downloadId === notice.context.downloadId)) return;
    bucket.items.push(item); this.pending++;
  }
  private async flush(key: string): Promise<void> {
    const bucket = this.buckets.get(key); if (!bucket) return;
    this.buckets.delete(key); clearTimeout(bucket.timer); this.pending -= bucket.items.length;
    await this.deliver(bucket.items, this.generation);
  }
  private async deliver(items: Pending[], generation: number): Promise<void> {
    this.delivering += items.length;
    try { await this.dispatch(items, generation); } finally { this.delivering -= items.length; }
  }
  private async dispatch(items: Pending[], generation: number): Promise<void> {
    const groups = new Map<string, { items: Pending[]; private: boolean }>();
    let environments: NotificationEnvironment[];
    try { environments = await (this.adapter.readMany?.(items.map(item => item.notice.context)) ?? Promise.all(items.map(item => this.adapter.read(item.notice.context)))); }
    catch { return; }
    let sound = false;
    for (const [index, item] of items.entries()) {
      if (generation !== this.generation) return;
      try {
        const env = environments[index];
        if (generation !== this.generation) return;
        const decision = resolveNotificationPolicy(item.notice.context, env, this.now());
        // Enabling an option after admission never revives suppressed content/output.
        const audible = decision.sound && item.admitted.sound;
        sound ||= audible;
        if (!decision.popups || !item.admitted.popups) continue;
        const key = JSON.stringify([item.notice.context.kind, item.notice.context.roomId ?? '', env.categoryId ?? item.notice.context.categoryId ?? '', item.notice.context.group ?? '']);
        const group = groups.get(key) ?? { items: [], private: false };
        group.items.push(item); group.private ||= !decision.showContent || !item.admitted.showContent;
        groups.set(key, group);
      } catch { /* Unavailable settings/context never permit output. */ }
    }
    if (generation !== this.generation) return;
    for (const group of groups.values()) {
      const first = group.items[0].notice;
      const text = group.private ? this.adapter.privateMessage() : group.items.length > 1 ? this.adapter.summary(first.context.kind, group.items.length) : first;
      try { this.adapter.popup({ title: text.title, body: text.body, critical: group.items.some(item => item.notice.critical), onClick: first.onClick }); } catch { /* OS failure doesn't change event history. */ }
    }
    if (sound) { try { this.adapter.sound(); } catch { /* Audio unavailable. */ } }
  }
  dispose(): void {
    this.generation++;
    for (const bucket of this.buckets.values()) clearTimeout(bucket.timer);
    this.buckets.clear(); this.pending = 0;
  }
}
