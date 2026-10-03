import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceLinkRecovery, VOICE_CONNECT_TIMEOUT_MS, VOICE_DISCONNECT_GRACE_MS, VOICE_RETRY_DELAYS_MS, VOICE_STABLE_MS } from './room-voice-recovery';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function fixture() {
  const restart = vi.fn(), change = vi.fn();
  return { link: new VoiceLinkRecovery(restart, change), restart, change };
}
function exhaust(link: VoiceLinkRecovery) {
  link.update('failed');
  for (const delay of VOICE_RETRY_DELAYS_MS) {
    vi.advanceTimersByTime(delay);
    vi.advanceTimersByTime(VOICE_CONNECT_TIMEOUT_MS);
  }
}
describe('bounded voice ICE recovery', () => {
  it('times out an unfinished first handshake and stops after three spaced restarts', () => {
    const { link, restart } = fixture();
    vi.advanceTimersByTime(VOICE_CONNECT_TIMEOUT_MS - 1); expect(restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    for (const delay of VOICE_RETRY_DELAYS_MS) {
      vi.advanceTimersByTime(delay - 1); expect(link.state).toBe('reconnecting');
      vi.advanceTimersByTime(1); vi.advanceTimersByTime(VOICE_CONNECT_TIMEOUT_MS);
    }
    expect(restart).toHaveBeenCalledTimes(3); expect(link.state).toBe('failed');
    vi.advanceTimersByTime(300_000); expect(restart).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('lets a brief disconnection recover without renegotiation', () => {
    const { link, restart } = fixture(); link.update('connected'); link.update('disconnected');
    vi.advanceTimersByTime(VOICE_DISCONNECT_GRACE_MS - 1); link.update('connected');
    vi.advanceTimersByTime(60_000); expect(restart).not.toHaveBeenCalled(); expect(link.state).toBe('connected');
  });
  it('reconciles a healthy restart that emits no new connection-state event', () => {
    const restart = vi.fn();
    const link = new VoiceLinkRecovery(restart, vi.fn(), () => Date.now(), () => 'connected');
    link.update('connected'); link.retry();
    vi.advanceTimersByTime(VOICE_CONNECT_TIMEOUT_MS);
    expect(link.state).toBe('connected'); expect(restart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000); expect(restart).toHaveBeenCalledTimes(1);
  });
  it('recovers a prolonged disconnected state and coalesces repeated failure notifications', () => {
    const { link, restart } = fixture(); link.update('connected'); link.update('disconnected');
    vi.advanceTimersByTime(VOICE_DISCONNECT_GRACE_MS);
    for (let i = 0; i < 50; i++) link.update('failed');
    vi.advanceTimersByTime(1_000); expect(restart).toHaveBeenCalledTimes(1);
  });
  it('does not replenish retries on flapping connected states or remote presence', () => {
    const { link, restart } = fixture(); link.update('failed'); vi.advanceTimersByTime(1_000);
    link.update('connected'); vi.advanceTimersByTime(1_000); link.update('failed');
    vi.advanceTimersByTime(3_000); link.update('connected'); vi.advanceTimersByTime(1_000); link.update('failed');
    vi.advanceTimersByTime(8_000); link.update('failed'); vi.advanceTimersByTime(VOICE_CONNECT_TIMEOUT_MS);
    expect(link.state).toBe('failed'); expect(restart).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 50; i++) link.update('connecting');
    vi.advanceTimersByTime(300_000); expect(restart).toHaveBeenCalledTimes(3);
  });
  it('replenishes the budget only after thirty seconds of stable connection', () => {
    const { link } = fixture(); exhaust(link); link.update('connected');
    vi.advanceTimersByTime(VOICE_STABLE_MS - 1); expect(link.attempts).toBe(3);
    vi.advanceTimersByTime(1); expect(link.attempts).toBe(0);
  });
  it('allows an explicit retry and rate limits network-event storms', () => {
    const { link, restart } = fixture(); exhaust(link); link.retry(); link.retry();
    expect(link.attempts).toBe(1); expect(restart).toHaveBeenCalledTimes(4);
    link.networkChanged(); for (let i = 0; i < 100; i++) link.networkChanged();
    expect(restart).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(VOICE_STABLE_MS); link.networkChanged(); expect(link.attempts).toBe(1);
  });
  it('bounds synchronous restart errors and clears every callback when closed', () => {
    const { link, restart, change } = fixture(); restart.mockImplementation(() => { throw new Error('closed PC'); });
    exhaust(link); expect(restart).toHaveBeenCalledTimes(3); expect(link.state).toBe('failed');
    link.update('connected'); link.close(); const calls = change.mock.calls.length;
    link.retry(); link.networkChanged(); link.update('connected'); vi.advanceTimersByTime(300_000);
    expect(change).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
  });
});
