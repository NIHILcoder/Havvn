import { describe, it, expect } from 'vitest';
import { availableCompletionActions, evaluateTick, CompletionTickState } from './completion-action';

const st = (over: Partial<CompletionTickState> = {}): CompletionTickState => ({
  armed: true,
  sawPending: false,
  countdownActive: false,
  ...over,
});

describe('availableCompletionActions', () => {
  it('offers sleep/shutdown only on Windows', () => {
    expect(availableCompletionActions('win32')).toEqual(['none', 'sleep', 'shutdown', 'quit']);
    expect(availableCompletionActions('linux')).toEqual(['none', 'quit']);
    expect(availableCompletionActions('darwin')).toEqual(['none', 'quit']);
  });
});

describe('evaluateTick', () => {
  it('does nothing when not armed', () => {
    expect(evaluateTick(st({ armed: false }), ['downloading'])).toBe('noop');
    expect(evaluateTick(st({ armed: false }), ['completed'])).toBe('noop');
  });

  it('arming while idle never fires until real work was observed', () => {
    expect(evaluateTick(st(), ['completed', 'seeding'])).toBe('noop');
    expect(evaluateTick(st(), [])).toBe('noop');
  });

  it('latches sawPending on active work, once', () => {
    expect(evaluateTick(st(), ['downloading'])).toBe('saw-pending');
    expect(evaluateTick(st(), ['queued'])).toBe('saw-pending');
    expect(evaluateTick(st({ sawPending: true }), ['downloading'])).toBe('noop');
  });

  it('fires when latched and everything is terminal', () => {
    expect(evaluateTick(st({ sawPending: true }), ['completed', 'seeding'])).toBe('fire');
  });

  it('errored torrents count as terminal and do not block', () => {
    expect(evaluateTick(st({ sawPending: true }), ['completed', 'error'])).toBe('fire');
  });

  it('paused blocks the trigger and the action stays armed (guard auto-pause)', () => {
    expect(evaluateTick(st({ sawPending: true }), ['paused', 'completed'])).toBe('noop');
  });

  it('an empty snapshot never fires (engine-restore blip)', () => {
    expect(evaluateTick(st({ sawPending: true }), [])).toBe('noop');
  });

  it('new work during a countdown aborts the pending action', () => {
    expect(evaluateTick(st({ countdownActive: true }), ['downloading'])).toBe('abort-pending');
    expect(evaluateTick(st({ countdownActive: true }), ['completed'])).toBe('noop');
  });
});
