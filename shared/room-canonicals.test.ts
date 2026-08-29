import { describe, it, expect } from 'vitest';
import {
  chatCanonical, editCanonical, voiceStateCanonical, voiceSignalCanonical,
  rekeyCanonical, kickedCanonical, renameCanonical, topicCanonical, profileCanonical,
} from './room-canonicals';

const enc = new TextDecoder();

describe('room-canonicals', () => {
  const topic = 'abc'.repeat(13) + 'ab'; // 40 hex-ish

  it('chat bytes match the historical JSON array', () => {
    const m = { id: 'm1', at: 1_700_000_000_000, memberId: 'aabbccdd'.repeat(4), text: 'hello' };
    expect(enc.decode(chatCanonical(topic, m))).toBe(JSON.stringify([topic, m.id, m.at, m.memberId, m.text]));
  });

  it('edit / voice / kick domain tags stay byte-stable', () => {
    expect(enc.decode(editCanonical(topic, { msgId: 'm1', memberId: 'id', at: 2, text: 'x' })))
      .toBe(JSON.stringify(['chat-edit', topic, 'm1', 'id', 2, 'x']));
    expect(enc.decode(voiceStateCanonical(topic, { memberId: 'id', inVoice: true, muted: false, at: 3 })))
      .toBe(JSON.stringify(['voice-state', topic, 'id', 3, true, false]));
    expect(enc.decode(voiceSignalCanonical(topic, { memberId: 'a', to: 'b', kind: 'offer', data: { type: 'offer', sdp: 'v=0' } })))
      .toBe(JSON.stringify(['voice-signal', topic, 'a', 'b', 'offer', { type: 'offer', sdp: 'v=0' }]));
    expect(enc.decode(rekeyCanonical(topic, { newCode: 'n', kickedId: 'k', by: 'o' })))
      .toBe(JSON.stringify(['rekey', topic, 'n', 'k', 'o']));
    expect(enc.decode(kickedCanonical(topic, { targetId: 't', by: 'o' })))
      .toBe(JSON.stringify(['kicked', topic, 't', 'o']));
    expect(enc.decode(renameCanonical(topic, { name: 'R', at: 4, by: 'o' })))
      .toBe(JSON.stringify(['rename', topic, 'R', 4, 'o']));
    expect(enc.decode(topicCanonical(topic, { text: 'hi', at: 5, by: 'o' })))
      .toBe(JSON.stringify(['topic', topic, 'hi', 5, 'o']));
    expect(enc.decode(profileCanonical(topic, {
      memberId: 'id', at: 6, name: 'Ada', avatarSeed: 'rings:x', color: '', status: '', img: '',
    }))).toBe(JSON.stringify(['profile', topic, 'id', 6, 'Ada', 'rings:x', '', '', '']));
  });
});
