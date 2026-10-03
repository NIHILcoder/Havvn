import { ROOM_VOICE_ROSTER } from '../shared/room-voice-policy';
import { describe, it, expect, vi } from 'vitest';
import { GuestVoice } from './voice';
import { VoiceSession } from '../electron/sharing/room-voice';

describe.each(['browser', 'desktop'])('%s voice presence policy', client => {
  function fixture() {
    const hooks = { selfId: 'self', iceServers: [], announce: vi.fn(), announceShare: vi.fn(), sendSignal: vi.fn(), sendLoopback: vi.fn(), onChange: vi.fn(), log: vi.fn() };
    const voice = client === 'browser' ? new GuestVoice(hooks) : new VoiceSession(hooks);
    return { voice, internals: voice as unknown as { roster: Map<string, unknown>; pendingOffers: Map<string, unknown>; inVoice: boolean; active: boolean } };
  }
  it('ignores reordered/equal mute or leave states and retains the floor after room departure', () => {
    const { voice, internals } = fixture();
    voice.onPeerState('B', true, false, 10);
    voice.onPeerState('B', true, true, 20, true);
    voice.onPeerState('B', true, false, 20, false);
    expect(internals.roster.get('B')).toEqual({ muted: true, deafened: true });
    voice.onPeerState('B', false, false, 30);
    voice.onPeerState('B', true, false, 10);
    expect(internals.roster.has('B')).toBe(false);
    voice.onPeerState('B', true, false, 40);
    voice.onMemberGone('B');
    voice.onPeerState('B', true, false, 40);
    expect(internals.roster.has('B')).toBe(false);
    voice.onPeerState('B', true, false, 41);
    expect(internals.roster.has('B')).toBe(true);
  });
  it('bounds roster and reordered offers, clears pending offers on leave and ignores future/self state', () => {
    const { voice, internals } = fixture();
    internals.inVoice = true; internals.active = true;
    for (let i = 0; i < 20; i++) voice.onSignal('B' + i, 'offer', { type: 'offer', sdp: String(i) });
    expect(internals.pendingOffers.size).toBe(8);
    voice.onSignal('B0', 'offer', { type: 'offer', sdp: 'newest' });
    expect(internals.pendingOffers.get('B0')).toEqual({ type: 'offer', sdp: 'newest' });
    voice.onPeerState('B0', false, false, 20);
    expect(internals.pendingOffers.has('B0')).toBe(false);
    // Keep hardware inactive while filling the public roster.
    internals.inVoice = false; internals.active = false;
    for (let i = 0; i < ROOM_VOICE_ROSTER + 10; i++) voice.onPeerState('R' + i, true, false, i + 1);
    expect(internals.roster.size).toBe(ROOM_VOICE_ROSTER);
    voice.onPeerState('self', true, false, 10);
    voice.onPeerState('future', true, false, Date.now() + 60001);
    expect(internals.roster.has('self')).toBe(false);
    expect(internals.roster.has('future')).toBe(false);
  });
});
