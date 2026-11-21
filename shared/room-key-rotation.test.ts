import { describe, expect, it } from 'vitest';
import { advanceKeyRotationSchedule, createKeyRotationSchedule, restoreKeyRotationSchedule, validKeyRotationPlan } from './room-key-rotation';

describe('room key rotation schedule', () => {
  it.each([null, {}, { intervalMinutes: 0, repetitions: 1 }, { intervalMinutes: 1.5, repetitions: 1 },
    { intervalMinutes: 1441, repetitions: 1 }, { intervalMinutes: 10, repetitions: -1 },
    { intervalMinutes: 10, repetitions: 1001 }, { intervalMinutes: '10', repetitions: 1 },
    { intervalMinutes: Infinity, repetitions: 1 }])('rejects invalid plans: %j', value => {
    expect(validKeyRotationPlan(value)).toBe(false);
  });
  it('runs once after the interval and finishes only after a successful rotation', () => {
    const s = createKeyRotationSchedule('owner', { intervalMinutes: 5, repetitions: 1 }, 1000);
    expect(s).toMatchObject({ nextAt: 301_000, remaining: 1 });
    expect(advanceKeyRotationSchedule(s, 301_000)).toBeUndefined();
  });
  it('counts successful repetitions and schedules from completion instead of catching up', () => {
    const s = createKeyRotationSchedule('owner', { intervalMinutes: 1, repetitions: 3 }, 0);
    const next = advanceKeyRotationSchedule(s, 600_000)!;
    expect(next).toMatchObject({ remaining: 2, nextAt: 660_000 });
    expect(advanceKeyRotationSchedule(next, 660_000)).toMatchObject({ remaining: 1, nextAt: 720_000 });
  });
  it('can repeat until explicitly stopped', () => {
    const s = createKeyRotationSchedule('owner', { intervalMinutes: 60, repetitions: 0 }, 0);
    expect(advanceKeyRotationSchedule(s, 3_600_000)).toMatchObject({ remaining: null, nextAt: 7_200_000 });
  });
  it('restores only the same owner and keeps an unexpired deadline', () => {
    const s = createKeyRotationSchedule('owner', { intervalMinutes: 5, repetitions: 2 }, 1000);
    expect(restoreKeyRotationSchedule(s, 'owner', 2000)).toEqual(s);
    expect(restoreKeyRotationSchedule(s, 'successor', 2000)).toBeUndefined();
    expect(restoreKeyRotationSchedule({ ...s, remaining: 0 }, 'owner', 2000)).toBeUndefined();
  });
  it('restarts an overdue deadline without consuming repeats and preserves a failure pause', () => {
    const s = createKeyRotationSchedule('owner', { intervalMinutes: 1, repetitions: 2 }, 0);
    expect(restoreKeyRotationSchedule(s, 'owner', 600_000)).toMatchObject({ remaining: 2, nextAt: 660_000 });
    const paused = { ...s, nextAt: 0, error: 'peer needs an update' };
    expect(restoreKeyRotationSchedule(paused, 'owner', 600_000)).toEqual(paused);
  });
});
