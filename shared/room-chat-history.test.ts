import { describe, expect, it } from 'vitest';
import { chatBackfillPages, chatEnvelope, chatIds, retainRoomChat, roomChatPage, upgradeChat, validChatTime } from './room-chat-history';
import type { RoomChatMessage } from './types';

const message = (i: number): RoomChatMessage => ({ id: 'm' + i, at: 1000 - i, memberId: 'A', name: 'Alice', avatarSeed: 'A', text: 'body ' + i, pub: 'pub', sig: 'sig', chatV: 2, contextSig: 'context' });

describe('bounded clock-independent room history', () => {
  it('backfills 150 missing messages in three pages despite reversed clocks and preserves replies', () => {
    const history = Array.from({ length: 200 }, (_, i) => message(i));
    history[100] = { ...history[100], replyTo: 'parent', replyName: 'Bob', replyText: 'quoted', receivedAt: 999 };
    const pages = chatBackfillPages(history, history.slice(0, 50).map(m => m.id));
    expect(pages.map(p => p.length)).toEqual([50, 50, 50]);
    expect(pages.flat().map(m => m.id)).toEqual(history.slice(50).map(m => m.id));
    expect(pages[1][0]).toMatchObject({ replyTo: 'parent', replyName: 'Bob', replyText: 'quoted', chatV: 2, contextSig: 'context' });
    expect(pages[1][0]).not.toHaveProperty('receivedAt');
    expect(chatBackfillPages(history, history.map(m => m.id))).toEqual([]);
  });

  it('serves legacy peers the entire retained window, never a 100-message tail', () => {
    const pages = chatBackfillPages(Array.from({ length: 250 }, (_, i) => message(i)));
    expect(pages.map(p => p.length)).toEqual([50, 50, 50, 50]);
    expect(pages.flat()[0].id).toBe('m50');
  });

  it('retains unique messages in arrival order and upgrades legacy metadata in place', () => {
    const v2 = { ...message(0), replyTo: 'parent', replyName: 'Bob', replyText: 'quote' };
    const legacy = { ...v2, chatV: undefined, contextSig: undefined, replyTo: 'forged', receivedAt: 3 };
    expect(retainRoomChat([legacy, message(1), v2, legacy])).toEqual([{ ...v2, receivedAt: 3 }, message(1)]);
    expect(upgradeChat(v2, legacy)).toBeUndefined();
    expect(upgradeChat(legacy, { ...v2, text: 'different body' })).toBeUndefined();
    expect(upgradeChat(legacy, { ...v2, sig: 'different signature' })).toBeUndefined();
  });

  it('pages by ID without duplication and detects a cursor pruned out of the window', () => {
    const history = Array.from({ length: 200 }, (_, i) => message(i));
    const last = roomChatPage(history), older = roomChatPage(history, last.messages[0].id);
    expect(last.messages.map(m => m.id)).toEqual(history.slice(150).map(m => m.id));
    expect(older.messages.map(m => m.id)).toEqual(history.slice(100, 150).map(m => m.id));
    expect(last.hasMore).toBe(true);
    expect(roomChatPage(history, 'm50').hasMore).toBe(false);
    expect(roomChatPage(history, 'pruned')).toEqual({ messages: [], hasMore: false, cursorExpired: true });
    expect(roomChatPage([]).messages).toEqual([]);
  });

  it('bounds inventories and rejects unknown versions or malformed signed context', () => {
    expect(chatIds(['m1', 'm1', '../path', 'x'.repeat(129), 1, null, 'ok-id'])).toEqual(['m1', 'ok-id']);
    expect(chatIds(Array.from({ length: 300 }, (_, i) => 'm' + i))).toHaveLength(200);
    for (const change of [{ chatV: 3 }, { contextSig: '' }, { replyTo: 123 }, { replyTo: '../x' }, { replyText: 'x'.repeat(141) }, { replyText: 'orphan' }, { at: NaN }, { at: -1 }, { at: Number.MAX_SAFE_INTEGER }]) {
      expect(chatEnvelope({ ...message(1), ...change })).toBeNull();
    }
    expect(chatEnvelope({ ...message(1), chatV: undefined })).toBeNull();
    expect(chatEnvelope({ ...message(1), at: 0 })?.at).toBe(0);
    expect(validChatTime(Date.now() + 3600000)).toBe(true);
  });
});
