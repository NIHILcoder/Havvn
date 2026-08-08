import { describe, expect, it } from 'vitest';
import { AlertThrottle, ALERT_COOLDOWN_MS, alertOnLowDisk, alertOnStatusChange } from './server-alerts';

describe('alertOnStatusChange', () => {
  it('raises nothing while the status is unchanged', () => {
    expect(alertOnStatusChange('i1', 'S', 'running', 'running')).toBeNull();
  });

  it('raises a crash on entering crashed', () => {
    const alert = alertOnStatusChange('i1', 'S', 'running', 'crashed');
    expect(alert).toMatchObject({ kind: 'crash', instanceId: 'i1', name: 'S' });
  });

  it('reads an out-of-memory crash out of the detail', () => {
    expect(alertOnStatusChange('i1', 'S', 'running', 'crashed', 'java.lang.OutOfMemoryError: heap')?.kind).toBe('oom');
    expect(alertOnStatusChange('i1', 'S', 'running', 'crashed', 'Out of memory')?.kind).toBe('oom');
  });

  it('says nothing about an ordinary stop', () => {
    expect(alertOnStatusChange('i1', 'S', 'running', 'stopped')).toBeNull();
  });
});

describe('alertOnLowDisk', () => {
  it('stays quiet on plenty of space or an unknown figure', () => {
    expect(alertOnLowDisk('i1', 'S', 50 * 1024 ** 3)).toBeNull();
    expect(alertOnLowDisk('i1', 'S', null)).toBeNull();
  });

  it('warns below the threshold and says how much is left', () => {
    const alert = alertOnLowDisk('i1', 'S', Math.round(1.5 * 1024 ** 3));
    expect(alert).toMatchObject({ kind: 'disk', instanceId: 'i1' });
    expect(alert?.detail).toContain('1.5 GiB');
  });
});

describe('AlertThrottle', () => {
  const crash = (instanceId = 'i1') => ({ kind: 'crash' as const, instanceId, name: 'S' });

  it('lets the first one through and swallows the storm behind it', () => {
    // A crash with auto-restart on is a LOOP — crashed → starting → running →
    // crashed every few seconds. Un-throttled, that was one toast per pass until
    // the screen was unusable. The first alert carries the information.
    const t = new AlertThrottle();
    expect(t.allow(crash(), 0)).toBe(true);
    for (const at of [10, 500, 1_000, 30_000, ALERT_COOLDOWN_MS - 1]) {
      expect(t.allow(crash(), at)).toBe(false);
    }
  });

  it('speaks again once the cooldown has passed', () => {
    const t = new AlertThrottle();
    expect(t.allow(crash(), 0)).toBe(true);
    expect(t.allow(crash(), ALERT_COOLDOWN_MS)).toBe(true);
  });

  it('throttles per instance, not globally', () => {
    // Two servers crashing together are two pieces of news, not one.
    const t = new AlertThrottle();
    expect(t.allow(crash('i1'), 0)).toBe(true);
    expect(t.allow(crash('i2'), 0)).toBe(true);
  });

  it('throttles per kind, so a disk warning is not eaten by a crash', () => {
    const t = new AlertThrottle();
    expect(t.allow({ kind: 'crash', instanceId: 'i1', name: 'S' }, 0)).toBe(true);
    expect(t.allow({ kind: 'disk', instanceId: 'i1', name: 'S' }, 0)).toBe(true);
    expect(t.allow({ kind: 'oom', instanceId: 'i1', name: 'S' }, 0)).toBe(true);
  });

  it('forgets a deleted instance without touching the others', () => {
    const t = new AlertThrottle();
    t.allow(crash('i1'), 0);
    t.allow(crash('i2'), 0);
    t.forget('i1');
    expect(t.allow(crash('i1'), 10)).toBe(true);
    expect(t.allow(crash('i2'), 10)).toBe(false);
  });
});
