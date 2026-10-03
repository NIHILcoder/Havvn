import { describe, expect, it } from 'vitest';
import { voiceMeshMembers, ROOM_VOICE_PARTICIPANTS } from './room-voice-policy';
import { GuestVoice } from '../guest/voice';
import { VoiceSession } from '../electron/sharing/room-voice';

describe('consistent voice mesh capacity', () => {
  it('chooses the same nine participants on every client regardless of arrival order', () => {
    const ids = Array.from({ length: 20 }, (_, i) => String(i).padStart(2, '0'));
    for (let i = 0; i < ids.length; i++) {
      const roster = [...ids.slice(i), ...ids.slice(0, i)].reverse().filter(id => id !== ids[i]);
      expect([...voiceMeshMembers(ids[i], true, roster)]).toEqual(ids.slice(0, ROOM_VOICE_PARTICIPANTS));
    }
    expect(voiceMeshMembers('00', false, ids).has('00')).toBe(false);
  });

  it.each(['desktop', 'browser'])('%s retains waiting participants and admits them when an earlier participant leaves', client => {
    const hooks = { selfId: '09', iceServers: [], announce() {}, announceShare() {}, sendSignal() {}, sendLoopback() {}, onChange() {}, log() {} };
    const voice = client === 'desktop' ? new VoiceSession(hooks) : new GuestVoice(hooks);
    const internals = voice as unknown as { active: boolean; inVoice: boolean; peers: Map<string, unknown> };
    internals.active = true; internals.inVoice = true;
    // Hardware stays absent: selection and state must not allocate invisible callers.
    for (let i = 8; i >= 0; i--) voice.onPeerState(String(i).padStart(2, '0'), true, false, 1);
    const state = () => client === 'desktop' ? (voice as VoiceSession).getState().participants : (voice as GuestVoice).participants();
    expect(state().find(p => p.memberId === '09')?.waitingForSlot).toBe(true);
    expect(internals.peers.size).toBe(0);
    voice.onMemberGone('00');
    expect(state().find(p => p.memberId === '09')?.waitingForSlot).not.toBe(true);
    // Replayed presence cannot reclaim the vacated slot.
    voice.onPeerState('00', true, false, 1);
    expect(state().some(p => p.memberId === '00')).toBe(false);
  });
});
