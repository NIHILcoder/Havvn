import { describe, expect, it } from 'vitest';
import {
  findDueScheduleActions,
  minutesToEvaluate,
  scheduleFireKey,
  sanitizeScheduleRule,
} from './server-scheduler';
import type { ServerScheduleRule } from '../../shared/gameserver-types';

describe('server-scheduler', () => {
  const rule = (over: Partial<ServerScheduleRule>): ServerScheduleRule => ({
    id: 'r1',
    days: [1],
    time: '18:00',
    action: 'start',
    enabled: true,
    ...over,
  });

  it('scheduleFireKey buckets by local minute', () => {
    const now = new Date(2026, 7, 6, 18, 0, 45);
    expect(scheduleFireKey(now)).toBe('2026-08-06T18:00');
  });

  it('findDueScheduleActions matches day and time', () => {
    const now = new Date(2026, 7, 6, 18, 0, 0); // Thu
    const due = findDueScheduleActions(now, [rule({ days: [4] })], new Map());
    expect(due).toHaveLength(1);
    expect(due[0].rule.action).toBe('start');
  });

  it('findDueScheduleActions skips disabled and already-fired rules', () => {
    const now = new Date(2026, 7, 6, 18, 0, 0);
    const key = scheduleFireKey(now);
    const first = findDueScheduleActions(now, [rule({ days: [4] })], new Map(), 'inst-1');
    const fired = new Map([[first[0].dedupKey, key]]);
    expect(findDueScheduleActions(now, [rule({ days: [4], enabled: false })], fired, 'inst-1')).toHaveLength(0);
    expect(findDueScheduleActions(now, [rule({ days: [4] })], fired, 'inst-1')).toHaveLength(0);
  });

  it('scopes the dedup key per instance', () => {
    // Rule ids are only unique inside the instance that owns them — and nothing
    // enforces even that. A single global map let one instance's firing suppress
    // an identically-named rule on another.
    const now = new Date(2026, 7, 6, 18, 0, 0);
    const a = findDueScheduleActions(now, [rule({ days: [4] })], new Map(), 'inst-a');
    const fired = new Map([[a[0].dedupKey, a[0].fireKey]]);

    expect(findDueScheduleActions(now, [rule({ days: [4] })], fired, 'inst-a')).toHaveLength(0);
    expect(findDueScheduleActions(now, [rule({ days: [4] })], fired, 'inst-b')).toHaveLength(1);
  });

  it('sanitizeScheduleRule rejects invalid input', () => {
    expect(sanitizeScheduleRule(null)).toBeNull();
    expect(sanitizeScheduleRule({ id: 'x', time: '99:00', action: 'start', days: [0] })).toBeNull();
    expect(sanitizeScheduleRule({ id: 'x', time: '10:30', action: 'stop', days: [0, 1] })?.action).toBe('stop');
  });
});

describe('minutesToEvaluate', () => {
  const at = (h: number, m: number, s = 0): Date => new Date(2026, 7, 6, h, m, s);

  it('evaluates just the current minute on the first tick', () => {
    expect(minutesToEvaluate(at(18, 0, 30), null)).toEqual([at(18, 0)]);
  });

  it('returns nothing when the minute has not turned over', () => {
    // Ticking four times a minute must not re-evaluate the same minute; the
    // per-rule fire key would catch a repeat anyway, but doing no work is better.
    expect(minutesToEvaluate(at(18, 0, 45), at(18, 0, 10))).toEqual([]);
  });

  it('catches up a minute the timer skipped', () => {
    // setInterval only ever drifts LATE, and a blocked event loop can swallow a
    // minute whole — which, against an exact HH:MM match, meant the rule simply
    // never fired that day.
    expect(minutesToEvaluate(at(18, 2, 5), at(18, 0, 55))).toEqual([at(18, 1), at(18, 2)]);
  });

  it('caps the catch-up so a night of sleep is not replayed', () => {
    // Waking at 06:00 must not fire every start and stop scheduled since 22:00.
    const minutes = minutesToEvaluate(at(6, 0), new Date(2026, 7, 5, 22, 0));
    expect(minutes).toHaveLength(5);
    expect(minutes[0]).toEqual(at(5, 56));
    expect(minutes[4]).toEqual(at(6, 0));
  });

  it('evaluates only the current minute when the clock goes backwards', () => {
    // An NTP correction or a DST fall-back: reasoning about a negative gap is
    // worse than doing the one thing that is certainly right.
    expect(minutesToEvaluate(at(18, 0), at(18, 5))).toEqual([at(18, 0)]);
  });

  it('fires a rule exactly once across a catch-up', () => {
    const fired = new Map<string, string>();
    const rules = [{ id: 'r1', days: [4], time: '18:01', action: 'stop' as const, enabled: true }];
    let fires = 0;
    // Two ticks that both cover 18:01 — the second catches up over it again.
    for (const [now, last] of [[at(18, 1, 5), at(18, 0, 50)], [at(18, 3, 0), at(18, 0, 50)]] as const) {
      for (const minute of minutesToEvaluate(now, last)) {
        for (const due of findDueScheduleActions(minute, rules, fired, 'inst-1')) {
          fired.set(due.dedupKey, due.fireKey);
          fires += 1;
        }
      }
    }
    expect(fires).toBe(1);
  });
});
