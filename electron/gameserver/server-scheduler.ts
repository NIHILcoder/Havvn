/**
 * Per-instance start/stop/restart schedules. Pure time-matching logic so the
 * tick loop in server-manager stays testable without a live supervisor.
 */
import type { ServerScheduleAction, ServerScheduleRule } from '../../shared/gameserver-types';

export interface DueScheduleAction {
  rule: ServerScheduleRule;
  /** Dedup key for this firing — one action per rule per clock minute. */
  fireKey: string;
  /**
   * Where that key is recorded. Scoped by instance: rule ids only have to be
   * unique within the instance that owns them (and nothing enforces even that),
   * so a single global map let one instance's firing suppress another's.
   */
  dedupKey: string;
}

/**
 * The clock minutes a tick must evaluate, oldest first.
 *
 * Rules match an exact `HH:MM`, so a tick that lands a second either side of the
 * minute misses it entirely — and `setInterval` only ever drifts LATE, while a
 * blocked event loop (a multi-gigabyte world copy, say) can swallow a minute
 * whole. Evaluating every minute since the last check closes that hole.
 *
 * The catch-up is capped deliberately. After a laptop sleeps overnight, replaying
 * eight hours of rules would fire a burst of starts and stops for times long
 * past; the cap covers drift and a stalled loop, not a missed night.
 */
export function minutesToEvaluate(now: Date, lastChecked: Date | null, maxCatchUp = 5): Date[] {
  const floor = (d: Date): Date =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), 0, 0);

  const current = floor(now);
  if (!lastChecked) return [current];

  const previous = floor(lastChecked);
  const elapsed = Math.round((current.getTime() - previous.getTime()) / 60_000);
  // Not a new minute yet, or the clock went backwards (DST, an NTP correction):
  // evaluate just this one rather than trying to reason about the gap.
  if (elapsed <= 0) return elapsed === 0 ? [] : [current];

  const out: Date[] = [];
  for (let back = Math.min(elapsed, maxCatchUp) - 1; back >= 0; back--) {
    out.push(new Date(current.getTime() - back * 60_000));
  }
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DDTHH:MM` in local time — the dedup bucket for a rule firing. */
export function scheduleFireKey(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

function timeMatches(now: Date, hhmm: string): boolean {
  const current = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  return current === hhmm;
}

/**
 * Rules that should fire for the minute `now` falls in. `lastFired` maps
 * `dedupKey` → last fireKey applied, so a rule fires at most once per minute
 * however often the tick runs or how many minutes it catches up over.
 *
 * `scope` namespaces the dedup key — pass the instance id.
 */
export function findDueScheduleActions(
  now: Date,
  rules: ServerScheduleRule[],
  lastFired: ReadonlyMap<string, string>,
  scope = '',
): DueScheduleAction[] {
  const day = now.getDay();
  const fireKey = scheduleFireKey(now);
  const out: DueScheduleAction[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!rule.days.includes(day)) continue;
    if (!timeMatches(now, rule.time)) continue;
    const dedupKey = `${scope}\t${rule.id}`;
    if (lastFired.get(dedupKey) === fireKey) continue;
    out.push({ rule, fireKey, dedupKey });
  }

  return out;
}

export function normalizeScheduleAction(value: unknown): ServerScheduleAction | null {
  if (value === 'start' || value === 'stop' || value === 'restart') return value;
  return null;
}

export function sanitizeScheduleRule(raw: unknown): ServerScheduleRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 40) : null;
  const time = typeof r.time === 'string' && /^\d{2}:\d{2}$/.test(r.time) ? r.time : null;
  if (time) {
    const [hh, mm] = time.split(':').map(Number);
    if (hh > 23 || mm > 59) return null;
  }
  const action = normalizeScheduleAction(r.action);
  const days = Array.isArray(r.days)
    ? [...new Set(r.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : null;
  if (!id || !time || !action || !days?.length) return null;
  return {
    id,
    time,
    action,
    days,
    enabled: r.enabled !== false,
  };
}
