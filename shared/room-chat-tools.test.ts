import { describe, expect, it } from 'vitest';
import { hasRoomMention, roomMentionRanges, roomNotifyMode, parseFileRequest, fileRequestText, matchesChatFilter, EMPTY_CHAT_FILTER, firstUnreadMessage, validateChatFilter } from './room-chat-tools';
import type { RoomChatMessage } from './types';
const message: RoomChatMessage = { id: 'm', memberId: 'A', name: 'Alice', text: 'hello', avatarSeed: 'a', at: new Date('2026-10-12T12:00:00').getTime(), receivedAt: 10 };
describe('room chat conveniences', () => {
  it('mentions require @ and a full name; avoids emails, code, URLs and partial Unicode names', () => {
    expect(hasRoomMention('Ann joined', 'Ann')).toBe(false);
    expect(hasRoomMention('mail@Ann.org @Anna @Ann_2', 'Ann')).toBe(false);
    expect(hasRoomMention('`@Ann` https://example.org/@Ann ```\n@Ann\n```', 'Ann')).toBe(false);
    expect(hasRoomMention('Привет, @Анна Мария!', 'Анна Мария')).toBe(true);
    expect(hasRoomMention('@A+B?', 'A+B')).toBe(true);
    expect(roomMentionRanges('x @Ann, @Ann!', 'Ann')).toEqual([{ start: 2, end: 6 }, { start: 8, end: 12 }]);
  });
  it('migrates muted notification settings without losing mention mode', () => {
    expect(roomNotifyMode({})).toBe('all'); expect(roomNotifyMode({ notifyMuted: true })).toBe('off');
    expect(roomNotifyMode({ notifyMode: 'mentions' })).toBe('mentions');
  });
  it('parses old requests and structured signed bodies; bounds titles, statuses and file references', () => {
    expect(parseFileRequest('🙋 Please share a map')).toEqual({ title: 'Please share a map', status: 'open', fileIds: [] });
    const request = { title: 'Map', status: 'fulfilled' as const, fileIds: ['file-A'] };
    expect(parseFileRequest(fileRequestText(request))).toEqual(request);
    expect(parseFileRequest('🙋 havvn-request-v1 {"title":"Map","status":"fulfilled","fileIds":["../secret"]}')).toBeUndefined();
    expect(parseFileRequest('🙋 havvn-request-v1 invalid')).toBeUndefined();
    expect(parseFileRequest(fileRequestText({ ...request, title: 'x'.repeat(900) }))?.title).toHaveLength(500);
  });
  it('filters edited text, dates, authors, links, structured requests and explicit mentions', () => {
    const filter = { ...EMPTY_CHAT_FILTER, query: 'new', author: 'A', after: '2026-10-12', before: '2026-10-12' };
    expect(matchesChatFilter(message, 'new text', filter)).toBe(true);
    expect(matchesChatFilter(message, message.text, filter)).toBe(false);
    expect(matchesChatFilter(message, 'new text', { ...filter, author: 'B' })).toBe(false);
    expect(matchesChatFilter(message, 'new text', { ...filter, before: '2026-10-11' })).toBe(false);
    expect(matchesChatFilter(message, fileRequestText({ title: 'Map', status: 'open', fileIds: [] }), { ...EMPTY_CHAT_FILTER, kind: 'requests', query: 'map' })).toBe(true);
    expect(matchesChatFilter(message, 'https://example.org', { ...EMPTY_CHAT_FILTER, kind: 'links' })).toBe(true);
    expect(matchesChatFilter(message, '@Анна', { ...EMPTY_CHAT_FILTER, kind: 'mentions' }, 'Анна')).toBe(true);
    expect(() => validateChatFilter({ ...EMPTY_CHAT_FILTER, query: 'x'.repeat(201) })).toThrow();
    expect(() => validateChatFilter({ ...EMPTY_CHAT_FILTER, before: 'tomorrow' })).toThrow();
  });
  it('unread navigation uses local receipt order, ignoring our own messages and sender clock skew', () => {
    const delayed = { ...message, id: 'delayed', at: 1, receivedAt: 20 }, own = { ...message, id: 'own', receivedAt: 15 };
    expect(firstUnreadMessage([message, own, { ...delayed, memberId: 'B' }], 10, 'A')?.id).toBe('delayed');
  });
});
