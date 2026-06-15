import { describe, it, expect } from 'vitest';
import {
  isValidTransition,
  canPause,
  canResume,
  canRecheck,
  isActiveState,
  isFinished,
  getValidNextStates,
} from './state-machine';

describe('state-machine transitions', () => {
  it('allows the core download lifecycle', () => {
    expect(isValidTransition('queued', 'downloading')).toBe(true);
    expect(isValidTransition('downloading', 'seeding')).toBe(true);
    expect(isValidTransition('downloading', 'paused')).toBe(true);
    expect(isValidTransition('paused', 'downloading')).toBe(true);
    expect(isValidTransition('seeding', 'completed')).toBe(true);
  });

  it('treats same-state as valid and blocks illegal jumps', () => {
    expect(isValidTransition('downloading', 'downloading')).toBe(true);
    expect(isValidTransition('completed', 'downloading')).toBe(false);
    expect(isValidTransition('removed', 'downloading')).toBe(false);
  });

  it('lets any non-removed state go to error or removed', () => {
    for (const s of ['queued', 'downloading', 'paused', 'seeding'] as const) {
      expect(isValidTransition(s, 'removed')).toBe(true);
    }
    expect(isValidTransition('downloading', 'error')).toBe(true);
    expect(isValidTransition('removed', 'error')).toBe(false);
  });
});

describe('state-machine guards', () => {
  it('canPause / canResume reflect their state sets', () => {
    expect(canPause('downloading')).toBe(true);
    expect(canPause('seeding')).toBe(true);
    expect(canPause('queued')).toBe(true);
    expect(canPause('paused')).toBe(false);
    expect(canResume('paused')).toBe(true);
    expect(canResume('error')).toBe(true);
    expect(canResume('downloading')).toBe(false);
  });

  it('isActiveState is downloading-only; isFinished is seeding/completed', () => {
    expect(isActiveState('downloading')).toBe(true);
    expect(isActiveState('seeding')).toBe(false);
    expect(isActiveState('queued')).toBe(false);
    expect(isFinished('seeding')).toBe(true);
    expect(isFinished('completed')).toBe(true);
    expect(isFinished('downloading')).toBe(false);
  });

  it('canRecheck covers states that may have on-disk data', () => {
    expect(canRecheck('downloading')).toBe(true);
    expect(canRecheck('seeding')).toBe(true);
    expect(canRecheck('completed')).toBe(true);
    expect(canRecheck('queued')).toBe(false);
  });

  it('getValidNextStates never includes the same state and is non-empty except removed', () => {
    expect(getValidNextStates('removed')).toHaveLength(0);
    for (const s of ['queued', 'downloading', 'paused', 'seeding', 'completed', 'error'] as const) {
      const next = getValidNextStates(s);
      expect(next).not.toContain(s);
      expect(next.length).toBeGreaterThan(0);
    }
  });
});
