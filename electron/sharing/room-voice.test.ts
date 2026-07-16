/**
 * Unit tests for VoiceSession's presence/roster bookkeeping — the parts that run
 * WITHOUT touching browser media APIs (no join(), so no getUserMedia/RTCPeerConnection).
 * The WebRTC/perfect-negotiation path needs a real browser and is validated by the
 * live smoke test; here we lock the pure state machine peers drive over gossip.
 */
import { describe, it, expect, vi } from 'vitest';
import { VoiceSession, VoiceAdapter } from './room-voice';

function makeAdapter(overrides: Partial<VoiceAdapter> = {}): VoiceAdapter & { changes: number } {
  const a = {
    selfId: 'A',
    iceServers: [],
    sendSignal: vi.fn(),
    announce: vi.fn(),
    changes: 0,
    onChange() { a.changes++; },
    log: vi.fn(),
    ...overrides,
  } as VoiceAdapter & { changes: number };
  return a;
}

describe('VoiceSession roster (no media)', () => {
  it('starts empty and not in voice', () => {
    const vs = new VoiceSession(makeAdapter());
    expect(vs.isActive()).toBe(false);
    expect(vs.getState()).toEqual({ inVoice: false, muted: false, deafened: false, transmitting: false, inputMode: 'always', participants: [] });
  });

  it('input mode is settable without media and reflected in state; unknown modes are ignored', () => {
    const vs = new VoiceSession(makeAdapter());
    vs.setInputMode('ptt');
    expect(vs.getState().inputMode).toBe('ptt');
    vs.setInputMode('vad');
    expect(vs.getState().inputMode).toBe('vad');
    vs.setInputMode('bogus' as any);
    expect(vs.getState().inputMode).toBe('vad'); // unchanged
    // Not in voice → never transmitting regardless of mode.
    expect(vs.getState().transmitting).toBe(false);
  });

  it('tracks a peer joining, muting, and leaving voice', () => {
    const a = makeAdapter();
    const vs = new VoiceSession(a);
    let t = 0;

    vs.onPeerState('B', true, false, ++t);
    expect(vs.getState().participants).toEqual([{ memberId: 'B', muted: false, speaking: false }]);

    vs.onPeerState('B', true, true, ++t); // B muted their mic
    expect(vs.getState().participants).toEqual([{ memberId: 'B', muted: true, speaking: false }]);

    vs.onPeerState('B', false, false, ++t); // B left voice
    expect(vs.getState().participants).toEqual([]);
    expect(a.changes).toBeGreaterThan(0); // each change re-pushed state
  });

  it('rejects a replayed (stale-or-equal `at`) voice-state — no ghost / mute-flip', () => {
    const vs = new VoiceSession(makeAdapter());
    vs.onPeerState('B', true, false, 10);
    vs.onPeerState('B', false, false, 20); // B left (newer)
    expect(vs.getState().participants).toEqual([]);
    vs.onPeerState('B', true, false, 10); // REPLAY of the old "joined" — must be ignored
    expect(vs.getState().participants).toEqual([]);
    vs.onPeerState('B', true, true, 15);  // also stale (< 20) — ignored
    expect(vs.getState().participants).toEqual([]);
  });

  it('caps the roster so fabricated identities can\'t grow it without bound', () => {
    const vs = new VoiceSession(makeAdapter());
    for (let i = 0; i < 20; i++) vs.onPeerState('peer-' + i, true, false, i + 1);
    expect(vs.getState().participants.length).toBe(8); // MAX_VOICE_PEERS
  });

  it('ignores our OWN presence echo (self is added by join, not gossip)', () => {
    const vs = new VoiceSession(makeAdapter({ selfId: 'A' }));
    vs.onPeerState('A', true, false, 1); // a relayed echo of our own voice-state
    expect(vs.getState().participants).toEqual([]);
  });

  it('drops a peer from voice when they leave the ROOM entirely', () => {
    const vs = new VoiceSession(makeAdapter());
    vs.onPeerState('B', true, false, 1);
    vs.onPeerState('C', true, false, 1);
    expect(vs.getState().participants.map((p) => p.memberId).sort()).toEqual(['B', 'C']);

    vs.onMemberGone('B');
    expect(vs.getState().participants.map((p) => p.memberId)).toEqual(['C']);
  });

  it('re-announces presence to a late joiner only while active (no-op when idle)', () => {
    const a = makeAdapter();
    const vs = new VoiceSession(a);
    vs.reannounce();
    expect(a.announce).not.toHaveBeenCalled(); // we're not in voice — nothing to re-announce
  });
});
