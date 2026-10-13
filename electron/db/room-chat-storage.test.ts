import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomChatMessage } from '../../shared/types';
import { EMPTY_CHAT_FILTER } from '../../shared/room-chat-tools';
const state = vi.hoisted(() => ({ stores: new Map<string, Record<string, unknown>>(), fail: false, writes: [] as unknown[], encryptions: 0, decryptions: 0, available: true }));
vi.mock('electron', () => ({ app: { getPath: () => 'D:/isolated-test' } }));
vi.mock('./secrets', () => ({
  isEncryptionAvailable: () => state.available,
  encryptSecret: (value: string) => { state.encryptions++; return 'encrypted:' + Buffer.from(value).toString('base64'); },
  decryptSecret: (value?: string) => { state.decryptions++; return state.available && typeof value === 'string' ? value.startsWith('encrypted:') ? Buffer.from(value.slice(10), 'base64').toString() : value : ''; },
}));
vi.mock('../utils/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('electron-store', () => ({ default: class {
  private name: string;
  constructor(options: { name?: string; defaults: Record<string, unknown> }) {
    this.name = options.name ?? 'config';
    if (!state.stores.has(this.name)) state.stores.set(this.name, structuredClone(options.defaults));
  }
  get(key: string) { return structuredClone(state.stores.get(this.name)?.[key]); }
  set(key: string | Record<string, unknown>, value?: unknown) {
    if (state.fail) throw new Error('disk full');
    const patch = typeof key === 'string' ? { [key]: value } : key;
    state.writes.push(structuredClone(patch));
    state.stores.set(this.name, { ...state.stores.get(this.name), ...structuredClone(patch) });
  }
  has(key: string) { return key in state.stores.get(this.name)!; }
  delete(key: string) { delete state.stores.get(this.name)![key]; }
} }));
import * as db from './store';
const room = 'chat-storage';
const message = (i = 1): RoomChatMessage => ({ id: i.toString(16).padStart(32, '0'), memberId: 'A', name: 'Alice', text: 'private body ' + i, at: i, pub: 'pub', sig: 'signed', replyTo: 'parent', replyText: 'private quote' });
beforeEach(() => { state.fail = false; state.available = true; db.clearRoomChats(room); db.clearRoomChatEdits(room); state.writes = []; state.encryptions = state.decryptions = 0; });

describe('durable room chat storage', () => {
  it('keeps missing stored text readable as an empty value', () => {
    const stored = state.stores.get('rooms')!;
    stored.roomChats = { ...(stored.roomChats as object), [room]: [{ ...message(), text: undefined, receivedAt: Date.now() }] };
    expect(db.getRoomChats(room)[0].text).toBe('');
  });

  it('counts unread without decrypting and reuses protected text only while storage is available', () => {
    db.commitRoomChat(room, message()); state.decryptions = 0;
    expect(db.getRoomUnreadCount(room, 'B')).toBe(1); expect(db.getRoomUnreadCount(room, 'A')).toBe(0);
    expect(state.decryptions).toBe(0);
    const first = db.getRoomChats(room); const count = state.decryptions;
    first[0].text = 'mutated by caller';
    expect(db.getRoomChats(room)[0].text).toBe(message().text); expect(state.decryptions).toBe(count);
    state.available = false; expect(db.getRoomChats(room)[0].text).toBe('');
    state.available = true; expect(db.getRoomChats(room)[0].text).toBe(message().text); expect(state.decryptions).toBeGreaterThan(count);
  });

  it('encrypts only new or upgraded incoming messages, preserving prior ciphertext', () => {
    db.appendRoomChats(room, [message(), message(2)]);
    const before = structuredClone((state.stores.get('rooms')?.roomChats as Record<string, RoomChatMessage[]>)[room]);
    state.encryptions = 0; db.appendRoomChats(room, [message(3)]);
    const after = (state.stores.get('rooms')?.roomChats as Record<string, RoomChatMessage[]>)[room];
    expect(after.slice(0, 2)).toEqual(before); expect(state.encryptions).toBe(2);
    state.encryptions = 0; expect(db.appendRoomChats(room, [message(3)])).toBe(false); expect(state.encryptions).toBe(0);
  });

  it('clears all room partitions in one atomic write and preserves another room', () => {
    db.commitRoomChat(room, message()); db.commitRoomChat('other', message(2));
    db.setRoomChatDraft(room, { text: 'private draft' }); db.setRoomLastRead(room, 4);
    state.writes = []; state.fail = true;
    expect(() => db.clearRoomLocalData(room)).toThrow('disk full'); expect(db.getRoomChats(room)).toHaveLength(1);
    state.fail = false; db.clearRoomLocalData(room); expect(state.writes).toHaveLength(1);
    expect(db.getRoomChats(room)).toEqual([]); expect(db.getRoomChatDraft(room)).toEqual({ text: '' }); expect(db.getRoomLastRead(room)).toBe(0);
    expect(db.getRoomChats('other')).toHaveLength(1); db.clearRoomLocalData('other');
  });

  it('atomically writes the body and retry receipt once, with content encrypted', () => {
    const msg = message(); const result = db.commitRoomChat(room, msg);
    expect(result).toEqual({ duplicate: false, message: { ...msg, receivedAt: expect.any(Number) } });
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toHaveProperty('roomChats'); expect(state.writes[0]).toHaveProperty('roomChatReceipts');
    expect(JSON.stringify(state.writes)).not.toContain('private');
    expect(db.getRoomChats(room)).toEqual([result.message]);
    expect(db.commitRoomChat(room, { ...msg, at: 200 })).toEqual({ duplicate: true, message: result.message });
    expect(state.writes).toHaveLength(1); expect(db.getRoomChats(room)).toHaveLength(1);
  });

  it('rejects changed body, sender, or reply under a previously accepted ID', () => {
    const msg = message(); db.commitRoomChat(room, msg);
    for (const change of [{ text: 'new body' }, { memberId: 'B' }, { replyTo: 'different' }]) {
      expect(() => db.commitRoomChat(room, { ...msg, ...change })).toThrow(/different content/);
    }
    expect(db.getRoomChats(room)).toEqual([{ ...msg, receivedAt: expect.any(Number) }]);
  });

  it('never acknowledges or writes half a commit if storage fails; retry succeeds', () => {
    const msg = message(); state.fail = true;
    expect(() => db.commitRoomChat(room, msg)).toThrow('disk full');
    expect(db.getRoomChats(room)).toEqual([]); expect(state.writes).toEqual([]);
    state.fail = false; expect(db.commitRoomChat(room, msg).duplicate).toBe(false);
    expect(db.getRoomChats(room)).toEqual([{ ...msg, receivedAt: expect.any(Number) }]);
  });

  it('remembers retries after a message falls out of the 200-message history', () => {
    for (let i = 1; i <= 202; i++) db.commitRoomChat(room, message(i));
    expect(db.getRoomChats(room)).toHaveLength(200);
    const before = state.writes.length;
    expect(db.commitRoomChat(room, message(1))).toEqual({ duplicate: true, message: undefined });
    expect(state.writes).toHaveLength(before); expect(db.getRoomChats(room)[0].id).toBe(message(3).id);
    expect(() => db.commitRoomChat(room, { ...message(1), text: 'changed' })).toThrow(/different content/);
  });

  it('deduplicates incoming messages within one batch and against durable local copies', () => {
    const msg = message(); db.commitRoomChat(room, msg);
    expect(db.appendRoomChats(room, [msg, message(2), message(2)])).toBe(true);
    expect(db.getRoomChats(room).map(m => m.id)).toEqual([msg.id, message(2).id]);
  });

  it('stamps receipt locally and upgrades a verified reply without a second unread message', () => {
    const msg = { ...message(), receivedAt: 9999999999999 };
    const before = Date.now();
    expect(db.appendRoomChats(room, [msg])).toBe(true);
    const saved = db.getRoomChats(room)[0];
    expect(saved.receivedAt).toBeGreaterThanOrEqual(before);
    expect(saved.receivedAt).toBeLessThanOrEqual(Date.now());
    const upgraded = { ...msg, chatV: 2 as const, contextSig: 'context', replyText: 'private corrected quote' };
    expect(db.appendRoomChats(room, [upgraded])).toBe(false);
    expect(db.getRoomChats(room)).toEqual([{ ...upgraded, receivedAt: saved.receivedAt }]);
    expect(JSON.stringify(state.writes)).not.toContain('private');
    expect(db.appendRoomChats(room, [msg])).toBe(false);
    expect(db.getRoomChats(room)[0].replyText).toBe('private corrected quote');
  });

  it('restores encrypted reply/edit drafts and clears them and receipts on leave', () => {
    const draft = { text: 'private edit', editId: 'old', compose: { text: 'private compose', messageId: message().id, reply: { id: 'parent', name: 'Alice', text: 'private quote' } } };
    db.setRoomChatDraft(room, draft); db.commitRoomChat(room, message());
    expect(JSON.stringify(state.writes)).not.toContain('private'); expect(db.getRoomChatDraft(room)).toMatchObject(draft);
    db.clearRoomChats(room);
    expect(db.getRoomChatDraft(room)).toEqual({ text: '' }); expect(db.getRoomChats(room)).toEqual([]);
    expect(db.commitRoomChat(room, message()).duplicate).toBe(false);
  });

  it('keeps recent edits when the overlay reaches its cap', () => {
    const edits = Object.fromEntries(Array.from({ length: 202 }, (_, i) => [String(i), { text: 'private edit', at: i, by: 'A', pub: 'pub', sig: 'sig' }]));
    db.setRoomChatEdits(room, edits);
    expect(db.getRoomChatEdits(room)['201']).toEqual(edits['201']);
    expect(db.getRoomChatEdits(room)['0']).toBeUndefined(); expect(Object.keys(db.getRoomChatEdits(room))).toHaveLength(200);
  });
});


describe('local archive independent of gossip window', () => {
  it('retains encrypted messages beyond 200 and pages without duplicates during arrivals', () => {
    for (let i=1;i<=253;i++) db.commitRoomChat(room,message(i));
    expect(db.getRoomChats(room)).toHaveLength(200);
    const newest=db.getRoomLocalHistoryPage(room,'chat');expect(newest.items).toHaveLength(50);
    db.commitRoomChat(room,message(254));
    const older=db.getRoomLocalHistoryPage(room,'chat',newest.next);
    expect(older.items[0]).toMatchObject({kind:'chat',message:{id:message(154).id}});
    expect(older.items.at(-1)).toMatchObject({kind:'chat',message:{id:message(203).id}});
    expect(db.appendRoomChats(room,[message(1)])).toBe(false);
    expect(JSON.stringify(state.stores.get('rooms'))).not.toContain('private body');
    expect(JSON.stringify(state.stores.get('rooms'))).not.toContain('private quote');
    let count=newest.items.length, cursor=newest.next;
    while(cursor){const page=db.getRoomLocalHistoryPage(room,'chat',cursor);count+=page.items.length;cursor=page.next;}
    expect(count).toBe(253);
  });
  it('prunes expired bodies and edits atomically using LOCAL receipt times', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
      db.commitRoomChat(room,message(1)); db.setRoomChatEdits(room,{[message().id]:{text:'private edited old text',at:Date.now(),by:'A',pub:'pub',sig:'sig'}});
      vi.setSystemTime(new Date('2026-02-15T12:00:00Z')); db.commitRoomChat(room,message(2));
      db.setRoomHistoryRetention(room,7);
      const page=db.getRoomLocalHistoryPage(room,'chat');expect(page.items).toHaveLength(1);expect(page.retentionDays).toBe(7);
      const encoded=JSON.stringify(state.stores.get('rooms')?.roomChatArchive);expect(encoded).not.toContain(message(1).id);
      expect(state.stores.get('rooms')?.roomArchiveEdits).toEqual({[room]:{}});
      expect(db.getRoomChats(room)).toHaveLength(1);
    }finally{vi.useRealTimers();}
  });
  it('archives more than one activity window and forgets it on leave', () => {
    const events=Array.from({length:260},(_,i)=>({id:'event'+i,at:Date.now(),type:'joined' as const,actorId:'A',actorName:'Alice'}));
    db.appendRoomEvents(room,events);
    expect(db.getRoomHistory(room)).toHaveLength(200);
    let page=db.getRoomLocalHistoryPage(room,'event'), count=page.items.length;
    while(page.next){page=db.getRoomLocalHistoryPage(room,'event',page.next);count+=page.items.length;}
    expect(count).toBe(260);db.clearRoomHistory(room);expect(db.getRoomLocalHistoryPage(room,'event').items).toEqual([]);
  });
});


it('physically purges expired encrypted history and edit overlays without new traffic', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));db.commitRoomChat(room,message(1));
    db.setRoomChatEdits(room,{[message(1).id]:{text:'private expired edit',at:Date.now(),by:'A',pub:'pub',sig:'sig'}});
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));state.writes=[];
    expect(db.pruneRoomLocalHistory()).toContain(room);expect(state.writes).toHaveLength(1);
    expect(state.stores.get('rooms')?.roomChatArchive).toEqual({[room]:[]});expect(state.stores.get('rooms')?.roomChats).toEqual({[room]:[]});
    expect(state.stores.get('rooms')?.roomChatEdits).toEqual({[room]:{}});
    state.writes=[];expect(db.pruneRoomLocalHistory()).toEqual([]);expect(state.writes).toEqual([]);
  } finally { vi.useRealTimers(); }
});


it('uses the archive to reject conflicting retries after the recent window and receipt have expired', () => {
  for(let i=1;i<=202;i++)db.commitRoomChat(room,message(i));
  state.stores.get('rooms')!.roomChatReceipts={};
  expect(db.commitRoomChat(room,message(1))).toMatchObject({duplicate:true,message:{id:message(1).id}});
  expect(()=>db.commitRoomChat(room,{...message(1),text:'different body'})).toThrow(/different content/);
});

it('searches beyond the recent 200 messages, matches edited text and pages results without exposing ciphertext', () => {
  for (let i = 1; i <= 270; i++) db.commitRoomChat(room, { ...message(i), text: 'needle ' + i });
  db.setRoomChatEdits(room, { [message(270).id]: { text: 'changed text', at: Date.now(), by: 'A', pub: 'pub', sig: 'sig' } });
  const first = db.searchRoomChat(room, { ...EMPTY_CHAT_FILTER, query: 'needle' });
  expect(first.messages).toHaveLength(50); expect(first.messages.at(-1)?.id).toBe(message(269).id);
  let page = first;
  while (page.next) page = db.searchRoomChat(room, { ...EMPTY_CHAT_FILTER, query: 'needle' }, page.next);
  expect(page.messages[0].id).toBe(message(1).id);
  const changed = db.searchRoomChat(room, { ...EMPTY_CHAT_FILTER, query: 'changed' });
  expect(changed.messages[0].text).toBe('needle 270'); expect(changed.edits[message(270).id].text).toBe('changed text');
  expect(() => db.searchRoomChat(room, EMPTY_CHAT_FILTER, '../bad')).toThrow();
});

it('keeps read receipts ordered within the same millisecond, including late arrivals after a read', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    const first = db.commitRoomChat(room, message(1)).message;
    db.setRoomLastRead(room, first.receivedAt);
    db.appendRoomChats(room, [{ ...message(2), memberId: 'B' }]);
    expect(db.getRoomChats(room)[1].receivedAt).toBe(first.receivedAt! + 1);
    expect(db.getRoomUnreadCount(room, 'A')).toBe(1);
    db.setRoomLastRead(room, db.getRoomChats(room)[1].receivedAt);
    const watermark = db.getRoomLastRead(room);
    db.clearRoomChats(room);
    vi.setSystemTime(new Date('2026-10-12T11:00:00Z'));
    db.appendRoomChats(room, [{ ...message(3), memberId: 'B' }]);
    expect(db.getRoomChats(room)[0].receivedAt).toBe(watermark + 1);
    expect(db.getRoomUnreadCount(room, 'A')).toBe(1);
  } finally { vi.useRealTimers(); }
});

it('protects complete pin snapshots, ignores stale writes and forgets them with the room', () => {
  const pins = { t: 'chat-pins-v1' as const, by: 'A', ownerAt: 0, at: 100, pub: 'pub', sig: 'sig', items: [{ topic: 'topic', message: message(1) }] };
  db.setRoomChatPins(room, pins);
  expect(db.getRoomChatPins(room)).toEqual(pins);
  expect(JSON.stringify(state.stores.get('rooms')?.roomChatPins)).not.toContain('private body');
  db.setRoomChatPins(room, { ...pins, at: 99, items: [] });
  expect(db.getRoomChatPins(room)?.items).toHaveLength(1);
  state.fail = true;
  expect(() => db.setRoomChatPins(room, { ...pins, at: 101, items: [] })).toThrow('disk full');
  state.fail = false;
  expect(db.getRoomChatPins(room)?.items).toHaveLength(1);
  db.clearRoomLocalData(room); expect(db.getRoomChatPins(room)).toBeUndefined();
});
