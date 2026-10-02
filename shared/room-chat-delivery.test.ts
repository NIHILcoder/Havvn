import { describe, expect, it } from 'vitest';
import { normalizeRoomChatDraft, normalizeRoomRate } from './room-chat-delivery';

describe('room command normalization', () => {
  it('bounds drafts and strips invalid retry/reply/edit IDs and nested backup data', () => {
    const draft = normalizeRoomChatDraft({ text: 'a'.repeat(3000), editId: '../outside', messageId: 'bad',
      reply: { id: 'parent', name: 'a'.repeat(300), text: 'q'.repeat(200) }, compose: { text: 'backup', messageId: 'b'.repeat(32) } });
    expect(draft.text).toHaveLength(2000); expect(draft.editId).toBeUndefined(); expect(draft.messageId).toBeUndefined();
    expect(draft.reply?.name).toHaveLength(256); expect(draft.reply?.text).toHaveLength(140);
    expect(draft.compose).toMatchObject({ text: 'backup', messageId: 'b'.repeat(32) });
  });
  it('rejects NaN, Infinity, negative and overflowing speed ceilings; preserves unlimited', () => {
    for (const value of [NaN, Infinity, -1, 1_000_001, 'invalid']) expect(() => normalizeRoomRate(value)).toThrow('Invalid');
    expect(normalizeRoomRate(0)).toBe(0); expect(normalizeRoomRate(10.9)).toBe(10);
  });
});
