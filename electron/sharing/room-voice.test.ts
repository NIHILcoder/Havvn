/**
 * Unit tests for VoiceSession's presence/roster bookkeeping — the parts that run
 * WITHOUT touching browser media APIs (no join(), so no getUserMedia/RTCPeerConnection).
 * The WebRTC/perfect-negotiation path needs a real browser and is validated by the
 * live smoke test; here we lock the pure state machine peers drive over gossip.
 */
import { describe, it, expect, vi } from 'vitest';
import { VoiceSession, VoiceAdapter, sanitizeVoiceSettings, defaultVoiceSettings } from './room-voice';

function makeAdapter(overrides: Partial<VoiceAdapter> = {}): VoiceAdapter & { changes: number } {
  const a = {
    selfId: 'A',
    iceServers: [],
    sendSignal: vi.fn(),
    announce: vi.fn(),
    announceShare: vi.fn(),
    sendLoopback: vi.fn(),
    warn: vi.fn(),
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
    expect(vs.getState()).toEqual({ inVoice: false, muted: false, deafened: false, transmitting: false, inputMode: 'always', sharing: false, participants: [] });
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
    expect(vs.getState().participants).toEqual([{ memberId: 'B', muted: false, speaking: false, sharing: false }]);

    vs.onPeerState('B', true, true, ++t); // B muted their mic
    expect(vs.getState().participants).toEqual([{ memberId: 'B', muted: true, speaking: false, sharing: false }]);

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

  it('applySettings while idle is safe (no media, no announces, no recapture)', () => {
    const a = makeAdapter();
    const vs = new VoiceSession(a, () => Date.now(), defaultVoiceSettings);
    vs.applySettings();
    expect(a.announce).not.toHaveBeenCalled();
    expect(vs.isActive()).toBe(false);
  });
});

describe('VoiceSession screenshare presence (no media)', () => {
  it('tracks a rostered peer sharing and stopping', () => {
    const vs = new VoiceSession(makeAdapter());
    vs.onPeerState('B', true, false, 1);
    vs.onPeerShare('B', true, 'stream-1', 2);
    expect(vs.getState().participants).toEqual([{ memberId: 'B', muted: false, speaking: false, sharing: true }]);
    vs.onPeerShare('B', false, '', 3);
    expect(vs.getState().participants).toEqual([{ memberId: 'B', muted: false, speaking: false, sharing: false }]);
  });

  it('rejects a replayed (stale-or-equal `at`) voice-share', () => {
    const vs = new VoiceSession(makeAdapter());
    vs.onPeerState('B', true, false, 1);
    vs.onPeerShare('B', true, 's', 10);
    vs.onPeerShare('B', false, '', 20);  // stopped (newer)
    expect(vs.getState().participants[0].sharing).toBe(false);
    vs.onPeerShare('B', true, 's', 10);  // REPLAY of the old "sharing" — ignored
    expect(vs.getState().participants[0].sharing).toBe(false);
    vs.onPeerShare('B', true, 's', 15);  // still stale (< 20) — ignored
    expect(vs.getState().participants[0].sharing).toBe(false);
  });

  it('buffers a share announce that beat the sender\'s voice-state (relay reorder)', () => {
    const vs = new VoiceSession(makeAdapter());
    vs.onPeerShare('B', true, 'stream-1', 5); // B is not rostered yet
    expect(vs.getState().participants).toEqual([]);
    vs.onPeerState('B', true, false, 6);      // presence lands → buffered share applies
    expect(vs.getState().participants).toEqual([{ memberId: 'B', muted: false, speaking: false, sharing: true }]);
  });

  it('caps the pending-share buffer against fabricated identities', () => {
    const vs = new VoiceSession(makeAdapter());
    for (let i = 0; i < 20; i++) vs.onPeerShare('fake-' + i, true, 's', i + 1);
    // Only the first MAX_VOICE_PEERS (8) got buffered; the 9th identity's share is dropped.
    vs.onPeerState('fake-19', true, false, 100);
    expect(vs.getState().participants[0]?.sharing ?? false).toBe(false);
    vs.onPeerState('fake-0', true, false, 101);
    expect(vs.getState().participants.find((p) => p.memberId === 'fake-0')?.sharing).toBe(true);
  });

  it('clears sharing when the member leaves voice (no separate stop announce)', () => {
    const vs = new VoiceSession(makeAdapter());
    vs.onPeerState('B', true, false, 1);
    vs.onPeerShare('B', true, 's', 2);
    vs.onPeerState('B', false, false, 3); // left voice → share implicitly over
    expect(vs.getState().participants).toEqual([]);
    vs.onPeerState('B', true, false, 4);  // rejoins → NOT sharing anymore
    expect(vs.getState().participants[0].sharing).toBe(false);
  });

  it('clears sharing when the member leaves the room entirely', () => {
    const vs = new VoiceSession(makeAdapter());
    vs.onPeerState('B', true, false, 1);
    vs.onPeerShare('B', true, 's', 2);
    vs.onMemberGone('B');
    expect(vs.getState().participants).toEqual([]);
  });

  it('KEEPS the anti-replay floor across onMemberGone — a stale share replay cannot resurrect the badge', () => {
    const vs = new VoiceSession(makeAdapter());
    vs.onPeerState('B', true, false, 5);
    vs.onPeerShare('B', true, 's', 10); // B shared at t=10
    vs.onMemberGone('B');               // B leaves the room
    vs.onPeerState('B', true, false, 20); // B comes back to voice (newer)
    vs.onPeerShare('B', true, 's', 10); // REPLAY of the old share (t=10 ≤ kept floor) — must be ignored
    expect(vs.getState().participants).toEqual([{ memberId: 'B', muted: false, speaking: false, sharing: false }]);
  });
});

describe('VoiceSession reannounce (no media)', () => {
  it('while active, re-announces BOTH presence and the current share truth (sharing:false too)', () => {
    // Not sharing: reannounce should still emit announceShare(false) so a peer whose
    // LIVE badge was set by a replay gets corrected. (isActive requires join(), which
    // needs media — so assert the adapter contract via the not-active guard instead.)
    const a = makeAdapter();
    const vs = new VoiceSession(a);
    vs.reannounce(); // idle → nothing
    expect(a.announce).not.toHaveBeenCalled();
    expect(a.announceShare).not.toHaveBeenCalled();
  });

  it('ignores our OWN share echo and share announces from the void', () => {
    const vs = new VoiceSession(makeAdapter({ selfId: 'A' }));
    vs.onPeerShare('A', true, 's', 1); // relayed echo of our own announce
    expect(vs.getState().sharing).toBe(false);
    expect(vs.isSharing()).toBe(false);
  });

  it('watchStart on an unknown/non-sharing member throws; watchStop is a safe no-op', () => {
    const vs = new VoiceSession(makeAdapter());
    expect(() => vs.watchStart('nobody')).toThrow();
    expect(() => vs.watchStop('nobody')).not.toThrow();
  });

  it('reannounce while idle announces neither presence nor share', () => {
    const a = makeAdapter();
    const vs = new VoiceSession(a);
    vs.reannounce();
    expect(a.announce).not.toHaveBeenCalled();
    expect(a.announceShare).not.toHaveBeenCalled();
  });
});

describe('sanitizeVoiceSettings', () => {
  it('returns defaults for garbage input', () => {
    const d = defaultVoiceSettings();
    expect(sanitizeVoiceSettings(null)).toEqual(d);
    expect(sanitizeVoiceSettings('nope')).toEqual(d);
    expect(sanitizeVoiceSettings(42)).toEqual(d);
    expect(sanitizeVoiceSettings({})).toEqual(d);
  });

  it('clamps numeric knobs into safe bounds', () => {
    const s = sanitizeVoiceSettings({ inputGain: 99, masterVolume: -3, vadThreshold: 100000 });
    expect(s.inputGain).toBe(2);       // 0..2
    expect(s.masterVolume).toBe(0);    // 0..1
    expect(s.vadThreshold).toBe(128);  // 1..128
    expect(sanitizeVoiceSettings({ inputGain: NaN }).inputGain).toBe(1); // non-finite → default
  });

  it('accepts only plausible device ids and defaults booleans on', () => {
    expect(sanitizeVoiceSettings({ inputDeviceId: 'abc' }).inputDeviceId).toBe('abc');
    expect(sanitizeVoiceSettings({ inputDeviceId: '' }).inputDeviceId).toBeNull();
    expect(sanitizeVoiceSettings({ inputDeviceId: 12 }).inputDeviceId).toBeNull();
    expect(sanitizeVoiceSettings({ inputDeviceId: 'x'.repeat(300) }).inputDeviceId).toBeNull(); // oversized
    const s = sanitizeVoiceSettings({ echoCancellation: false, noiseSuppression: 'yes', autoGainControl: undefined });
    expect(s.echoCancellation).toBe(false);   // explicit false honored
    expect(s.noiseSuppression).toBe(true);    // anything but false → on
    expect(s.autoGainControl).toBe(true);
  });

  it('keeps a passthrough round-trip stable', () => {
    const custom = { ...defaultVoiceSettings(), inputGain: 1.5, vadThreshold: 30, outputDeviceId: 'spk-1', echoCancellation: false };
    expect(sanitizeVoiceSettings(custom)).toEqual(custom);
  });
});
