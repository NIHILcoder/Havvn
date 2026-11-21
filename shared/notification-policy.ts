import type { AppSettings } from './types';

export interface NotificationRule { popups?: boolean; sound?: boolean; showContent?: boolean }
export interface NotificationPolicy {
  showContent: boolean;
  quietHours: { enabled: boolean; start: string; end: string };
  summaries: { enabled: boolean; windowSeconds: number };
}
export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = {
  showContent: true, quietHours: { enabled: false, start: '22:00', end: '08:00' }, summaries: { enabled: true, windowSeconds: 3 },
};
export type NotificationKind = 'download-complete' | 'download-error' | 'room-message' | 'rss' | 'system';
export interface NotificationContext {
  kind: NotificationKind;
  downloadId?: string;
  categoryId?: string;
  roomId?: string;
  urgent?: boolean;
  /** Distinct system guards never merge into one unrelated summary. */
  group?: string;
}
export interface NotificationEnvironment {
  settings: Pick<AppSettings, 'enableNotifications' | 'enableSounds' | 'notifyOnComplete' | 'notifyOnError' | 'notificationPolicy'>;
  categoryId?: string;
  categoryRule?: NotificationRule;
  roomRule?: NotificationRule;
  roomMode?: 'all' | 'mentions' | 'off';
  available?: boolean;
}
export type NotificationSuppression = 'unavailable' | 'quiet' | 'room-muted' | 'mentions-only' | 'completion-disabled' | 'errors-disabled';
export interface NotificationDecision { popups: boolean; sound: boolean; showContent: boolean; reason?: NotificationSuppression }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid notification policy');
  return value as Record<string, unknown>;
}
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('Invalid notification boolean');
  return value;
}
export function validateNotificationRule(value: unknown): NotificationRule {
  const source = record(value), result: NotificationRule = {};
  for (const key of ['popups', 'sound', 'showContent'] as const) if (source[key] !== undefined) result[key] = boolean(source[key], true);
  return result;
}
export function validateNotificationPolicy(value: unknown): NotificationPolicy {
  const source = record(value), base = DEFAULT_NOTIFICATION_POLICY;
  const quiet = source.quietHours === undefined ? base.quietHours : record(source.quietHours);
  const summaries = source.summaries === undefined ? base.summaries : record(source.summaries);
  const start = quiet.start ?? base.quietHours.start, end = quiet.end ?? base.quietHours.end;
  if (typeof start !== 'string' || typeof end !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) throw new Error('Invalid notification quiet hours');
  const windowSeconds = summaries.windowSeconds ?? base.summaries.windowSeconds;
  if (typeof windowSeconds !== 'number' || !Number.isSafeInteger(windowSeconds) || windowSeconds < 2 || windowSeconds > 30) throw new Error('Invalid notification summary window');
  return { showContent: boolean(source.showContent, true), quietHours: { enabled: boolean(quiet.enabled, false), start, end },
    summaries: { enabled: boolean(summaries.enabled, true), windowSeconds } };
}
/** Wall clock local to the current OS zone, evaluated again at delivery. Equal endpoints mean all day. */
export function inQuietHours(policy: NotificationPolicy, now: Date): boolean {
  if (!policy.quietHours.enabled) return false;
  const minute = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
  const start = minute(policy.quietHours.start), end = minute(policy.quietHours.end), current = now.getHours() * 60 + now.getMinutes();
  return start === end || (start < end ? current >= start && current < end : current >= start || current < end);
}
/** Global switches are caps: a room/category cannot bypass global mute or hidden content. */
export function resolveNotificationPolicy(context: NotificationContext, env: NotificationEnvironment, now = new Date()): NotificationDecision {
  const { settings } = env, policy = settings.notificationPolicy ?? DEFAULT_NOTIFICATION_POLICY;
  let reason: NotificationSuppression | undefined;
  if (env.available === false) reason = 'unavailable';
  else if (inQuietHours(policy, now)) reason = 'quiet';
  else if (env.roomMode === 'off') reason = 'room-muted';
  else if (context.kind === 'room-message' && env.roomMode === 'mentions' && !context.urgent) reason = 'mentions-only';
  else if (context.kind === 'download-complete' && settings.notifyOnComplete === false) reason = 'completion-disabled';
  else if (context.kind === 'download-error' && settings.notifyOnError === false) reason = 'errors-disabled';
  const rule = context.roomId ? env.roomRule : env.categoryRule;
  return { popups: !reason && settings.enableNotifications !== false && rule?.popups !== false,
    sound: !reason && settings.enableSounds !== false && rule?.sound !== false,
    showContent: policy.showContent && rule?.showContent !== false, ...(reason ? { reason } : {}) };
}
