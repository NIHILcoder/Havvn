import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomChatComposer } from './roomChatComposer';
import type { RoomChatAck, RoomChatDraft } from '../../shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const id = 'a'.repeat(32), nextId = 'b'.repeat(32);
const quote = { id: 'parent', name: 'Alice', text: 'quoted body' };
function fixture(initial: RoomChatDraft = { text: '' }) {
  const stored = new Map<string, RoomChatDraft>([['A', initial]]);
  const api = {
    chatDraft: vi.fn(async (room: string) => stored.get(room) ?? { text: '' }),
    saveChatDraft: vi.fn(async (room: string, draft: RoomChatDraft) => { stored.set(room, structuredClone(draft)); return { ok: true }; }),
    sendChat: vi.fn(async (_room: string, _text: string, _reply?: string, messageId?: string): Promise<RoomChatAck> => ({ ok: true, id: messageId!, state: 'saved-locally' })),
    editChat: vi.fn(async (_room: string, _id: string, _text: string) => ({ ok: true })),
  };
  const makeId = vi.fn().mockReturnValueOnce(id).mockReturnValue(nextId);
  const composer = new RoomChatComposer('A', api, makeId);
  return { composer, api, stored, makeId };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('room chat draft and acknowledgment', () => {
  it('keeps text/reply visible while saving and sending; clears only after acknowledgment', async () => {
    const { composer, api, stored } = fixture(); await drain();
    const ack = deferred<RoomChatAck>(); api.sendChat.mockReturnValueOnce(ack.promise);
    composer.setText('hello'); composer.reply(quote);
    const sending = composer.send(); await drain();
    expect(composer.getSnapshot()).toMatchObject({ phase: 'sending', draft: { text: 'hello', reply: quote, messageId: id } });
    expect(stored.get('A')).toMatchObject({ text: 'hello', messageId: id, reply: quote });
    expect(api.sendChat).toHaveBeenCalledWith('A', 'hello', 'parent', id);
    ack.resolve({ ok: true, id, state: 'saved-locally' }); await sending;
    expect(composer.getSnapshot()).toMatchObject({ phase: 'saved', draft: { text: '' } });
    expect(stored.get('A')?.text).toBe('');
  });

  it('retries a lost acknowledgment with the same ID, including after a restart', async () => {
    const { composer, api, stored, makeId } = fixture(); await drain();
    api.sendChat.mockRejectedValueOnce(new Error('response lost'));
    composer.setText('hello'); composer.reply(quote); await composer.send();
    expect(composer.getSnapshot()).toMatchObject({ phase: 'error', error: 'response lost', draft: { text: 'hello', reply: quote, messageId: id } });
    const restarted = new RoomChatComposer('A', api, makeId); await drain();
    await restarted.send();
    expect(api.sendChat.mock.calls.map(call => call[3])).toEqual([id, id]);
    expect(makeId).toHaveBeenCalledOnce(); expect(stored.get('A')?.text).toBe('');
  });

  it('does not send or discard a draft when backup storage fails', async () => {
    const { composer, api } = fixture(); await drain();
    api.saveChatDraft.mockRejectedValueOnce(new Error('disk full'));
    composer.setText('important'); await composer.send();
    expect(api.sendChat).not.toHaveBeenCalled();
    expect(composer.getSnapshot()).toMatchObject({ phase: 'error', draft: { text: 'important', messageId: id } });
    await composer.send(); expect(api.sendChat).toHaveBeenCalledWith('A', 'important', undefined, id);
  });

  it('retains a stable retry after acknowledgment if draft cleanup fails', async () => {
    const { composer, api } = fixture(); await drain();
    api.saveChatDraft.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('cleanup failed'));
    composer.setText('accepted'); await composer.send();
    expect(composer.getSnapshot()).toMatchObject({ phase: 'error', draft: { text: 'accepted', messageId: id } });
    await composer.send(); expect(api.sendChat.mock.calls.map(call => call[3])).toEqual([id, id]);
  });

  it('rejects a mismatched acknowledgment and prevents concurrent sends or edits', async () => {
    const { composer, api } = fixture(); await drain();
    const ack = deferred<RoomChatAck>(); api.sendChat.mockReturnValueOnce(ack.promise);
    composer.setText('hello'); const sending = composer.send();
    composer.setText('changed'); composer.cancel(); await composer.send(); await composer.flush(); await drain();
    expect(api.sendChat).toHaveBeenCalledOnce(); expect(api.saveChatDraft).toHaveBeenCalledOnce();
    ack.resolve({ ok: true, id: nextId, state: 'saved-locally' }); await sending;
    expect(composer.getSnapshot()).toMatchObject({ phase: 'error', draft: { text: 'hello', messageId: id } });
  });

  it('changing content allocates a new ID; whitespace-only changes retain the retry', async () => {
    const { composer, api, makeId } = fixture(); await drain();
    api.sendChat.mockRejectedValue(new Error('offline'));
    composer.setText('hello'); await composer.send();
    composer.setText(' hello '); await composer.send();
    composer.setText('different'); await composer.send();
    expect(api.sendChat.mock.calls.map(call => call[3])).toEqual([id, id, nextId]);
    expect(makeId).toHaveBeenCalledTimes(2);
  });

  it('backs up a composed reply while editing and restores it on cancel or successful edit', async () => {
    const { composer, api } = fixture({ text: 'unsent', reply: quote, messageId: id }); await drain();
    composer.edit('old', 'edited text'); await composer.flush();
    const restored = new RoomChatComposer('A', api); await drain();
    restored.cancel(); expect(restored.getSnapshot().draft).toMatchObject({ text: 'unsent', reply: quote, messageId: id });
    composer.setText('new edit'); api.editChat.mockRejectedValueOnce(new Error('not accepted')); await composer.send();
    expect(composer.getSnapshot()).toMatchObject({ phase: 'error', draft: { text: 'new edit', editId: 'old', compose: { text: 'unsent', reply: quote } } });
    await composer.send();
    expect(api.editChat).toHaveBeenLastCalledWith('A', 'old', 'new edit');
    expect(composer.getSnapshot().draft).toMatchObject({ text: 'unsent', reply: quote, messageId: id });
    expect(api.sendChat).not.toHaveBeenCalled();
  });

  it('does not overwrite new typing with a late load or an unrelated room with a late send', async () => {
    const { composer, api } = fixture(); await drain();
    const load = deferred<RoomChatDraft>(); api.chatDraft.mockReturnValueOnce(load.promise);
    const other = new RoomChatComposer('B', api); other.setText('new room draft');
    load.resolve({ text: 'old B draft' }); await drain();
    expect(other.getSnapshot().draft.text).toBe('new room draft');
    const ack = deferred<RoomChatAck>(); api.sendChat.mockReturnValueOnce(ack.promise);
    composer.setText('in A'); const sending = composer.send(); await drain();
    other.setText('keep B'); await other.flush();
    ack.resolve({ ok: true, id, state: 'saved-locally' }); await sending;
    expect(other.getSnapshot().draft.text).toBe('keep B');
  });

  it('debounces typing and surfaces a failed automatic save without erasing text', async () => {
    const { composer, api } = fixture(); await drain();
    composer.setText('a'); await vi.advanceTimersByTimeAsync(150); composer.setText('ab');
    await vi.advanceTimersByTimeAsync(299); expect(api.saveChatDraft).not.toHaveBeenCalled();
    api.saveChatDraft.mockRejectedValueOnce(new Error('read-only'));
    await vi.advanceTimersByTimeAsync(1);
    expect(composer.getSnapshot()).toMatchObject({ phase: 'error', draft: { text: 'ab' } });
    await composer.flush(); expect(api.saveChatDraft).toHaveBeenCalledTimes(2);
  });

  it('discards a left room without letting a late send recreate its draft', async () => {
    const { composer, api, stored } = fixture(); await drain();
    const ack = deferred<RoomChatAck>(); api.sendChat.mockReturnValueOnce(ack.promise);
    composer.setText('leaving'); const pending = composer.send(); await drain();
    const before = api.saveChatDraft.mock.calls.length;
    composer.dispose(); stored.delete('A');
    ack.resolve({ ok: true, id, state: 'saved-locally' }); await pending; await composer.flush();
    expect(api.saveChatDraft).toHaveBeenCalledTimes(before);
    expect(composer.getSnapshot().draft.text).toBe('');
    const rejoined = new RoomChatComposer('A', api); await drain();
    expect(rejoined.getSnapshot().draft.text).toBe('');
  });
});
