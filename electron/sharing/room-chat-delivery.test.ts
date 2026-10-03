/* eslint-disable @typescript-eslint/no-explicit-any -- Actual preload functions with injected IPC/storage and wire boundaries. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { chatContextCanonical } from '../../shared/room-canonicals';
import { ROOM_CHAT_LIMIT, chatEnvelope, upgradeChat } from '../../shared/room-chat-history';

const source = readFileSync(new URL('./room-engine.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('Missing engine fixture boundary');
  return source.slice(a, b);
}
const runtime = [
  extract('function signBytes(', '/** Bind memberId'),
  extract('function chatCanonical(', 'function verifyEdit('),
  extract('function applyChatEdit(', '/** Buffer a VERIFIED edit'),
  extract('function addChat(', '/** Clock-independent catch-up'),
  extract('const chatSends =', '/** Delete one file:'),
].join('\n');
const js = ts.transpileModule(runtime, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const messageId = 'a'.repeat(32);
function fixture() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const room: any = { roomId: 'A', topic: 'topic', chat: [], chatEdits: new Map(), pendingEdits: new Map(), identities: new Map(),
    self: { memberId: 'self', name: 'Self', pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } };
  const records = new Map<string, any>(), edits = new Map<string, any>();
  const invoke = vi.fn(async (channel: string, payload: any) => {
    if (channel === 'room-persist-chat-edit') {
      const prior = edits.get(payload.msgId);
      if (prior?.text === payload.edit.text) return prior;
      edits.set(payload.msgId, payload.edit); return payload.edit;
    }
    const prior = records.get(payload.message.id);
    if (prior && (prior.text !== payload.message.text || prior.replyTo !== payload.message.replyTo)) throw new Error('Message ID already belongs to different content');
    if (!prior) records.set(payload.message.id, payload.message);
    return { duplicate: !!prior, message: prior ?? payload.message };
  });
  const context: any = {
    chatContextCanonical, ROOM_CHAT_LIMIT, chatEnvelope, upgradeChat,
    rooms: new Map([['A', room]]), netSuspended: false, crypto, Buffer, Date,
    ipcRenderer: { invoke, send: vi.fn() }, log: vi.fn(), broadcast: vi.fn(), pushState: vi.fn(), MAX_REACT_MSGS: 500,
    pruneChatReacts: () => false, pruneChatEdits: () => false, persistChatEdits: vi.fn(), persistChatReacts: vi.fn(),
  };
  vm.runInNewContext(js, context);
  return { context, room, records, edits, invoke, send: (text = 'hello', reply?: string, id = messageId) => context.sendChat('A', text, reply, id) as Promise<any> };
}

describe('local chat durability in the room engine', () => {
  it('waits for durable storage before echo, gossip and acknowledgment; signs actual bytes', async () => {
    const f = fixture(); let finish!: () => void;
    const persist = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementationOnce((channel, payload) => new Promise(resolve => { finish = () => resolve(persist(channel, payload)); }));
    let settled = false; const pending = f.send().then(ack => { settled = true; return ack; });
    expect(f.room.chat).toEqual([]); expect(f.context.broadcast).not.toHaveBeenCalled(); expect(settled).toBe(false);
    finish(); await expect(pending).resolves.toEqual({ ok: true, id: messageId, state: 'saved-locally' });
    const m = f.records.get(messageId);
    expect(crypto.verify(null, Buffer.from(JSON.stringify(['topic', m.id, m.at, m.memberId, m.text])), m.pub, Buffer.from(m.sig, 'base64'))).toBe(true);
    expect(f.room.chat).toHaveLength(1); expect(f.context.broadcast).toHaveBeenCalledOnce();
    expect(f.context.ipcRenderer.send).not.toHaveBeenCalled(); // no second fire-and-forget body write
  });

  it('rejects failed signing or disk writes without local echo or gossip', async () => {
    const f = fixture(); f.room.self.priv = 'invalid';
    await expect(f.send()).rejects.toThrow(/sign/); expect(f.invoke).not.toHaveBeenCalled();
    const good = fixture(); good.invoke.mockRejectedValueOnce(new Error('disk full'));
    await expect(good.send()).rejects.toThrow('disk full');
    expect(good.room.chat).toEqual([]); expect(good.context.broadcast).not.toHaveBeenCalled();
    await expect(good.send()).resolves.toMatchObject({ state: 'saved-locally' }); expect(good.room.chat).toHaveLength(1);
  });

  it('coalesces concurrent sends and refuses ID reuse for another body or reply', async () => {
    const f = fixture(); let finish!: () => void;
    const persist = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementationOnce((channel, payload) => new Promise(resolve => { finish = () => resolve(persist(channel, payload)); }));
    const first = f.send('hello', 'aged-out-parent');
    expect(f.send('hello', 'aged-out-parent')).toBe(first); expect(f.invoke).toHaveBeenCalledOnce();
    expect(() => f.send('different', 'aged-out-parent')).toThrow(/different content/);
    finish(); await first;
    await f.send('hello', 'aged-out-parent'); expect(f.room.chat).toHaveLength(1);
    expect(f.room.chat[0].replyTo).toBe('aged-out-parent');
    await expect(f.send('hello', 'another-parent')).rejects.toThrow(/different content/);
  });

  it('recovers an accepted message from storage after a lost response/restarted history', async () => {
    const f = fixture(); await f.send(); const saved = f.records.get(messageId);
    f.room.chat = []; await f.send();
    expect(f.room.chat).toEqual([saved]); expect(f.records.size).toBe(1);
    expect(f.room.chat[0].at).toBe(saved.at); expect(f.room.chat[0].sig).toBe(saved.sig);
  });

  it('rejects late completion after leaving and permits a later retry from the committed copy', async () => {
    const f = fixture(); let finish!: () => void;
    const persist = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementationOnce((channel, payload) => new Promise(resolve => { finish = () => resolve(persist(channel, payload)); }));
    const pending = f.send(); f.context.rooms.delete('A'); finish();
    await expect(pending).rejects.toThrow(/session ended/); expect(f.room.chat).toEqual([]);
    expect(f.context.broadcast).not.toHaveBeenCalled(); expect(f.records.size).toBe(1);
    f.context.rooms.set('A', f.room); await f.send(); expect(f.room.chat).toHaveLength(1);
  });

  it('acknowledges durable local storage even if the wire fails, without claiming remote delivery', async () => {
    const f = fixture(); f.context.broadcast.mockImplementationOnce(() => { throw new Error('wire closed'); });
    await expect(f.send()).resolves.toEqual({ ok: true, id: messageId, state: 'saved-locally' });
    expect(f.records.size).toBe(1); expect(f.room.chat).toHaveLength(1);
  });

  it('awaits an edit write before applying it; retry preserves the committed overlay', async () => {
    const f = fixture(); await f.send(); f.context.broadcast.mockClear();
    f.invoke.mockRejectedValueOnce(new Error('disk full'));
    await expect(f.context.editChat('A', messageId, 'updated')).rejects.toThrow('disk full');
    expect(f.room.chatEdits.size).toBe(0); expect(f.context.broadcast).not.toHaveBeenCalled();
    await f.context.editChat('A', messageId, 'updated'); const saved = f.edits.get(messageId);
    expect(f.room.chatEdits.get(messageId)).toEqual(saved);
    await f.context.editChat('A', messageId, 'updated'); expect(f.edits.get(messageId)).toEqual(saved);
    expect(f.context.broadcast).toHaveBeenCalledOnce();
  });

  it('refuses inactive rooms, VPN suspension, invalid IDs and oversized bodies', () => {
    const f = fixture(); f.context.netSuspended = true; expect(() => f.send()).toThrow(/not active/);
    f.context.netSuspended = false; expect(() => f.send('a'.repeat(2001))).toThrow('Invalid');
    expect(() => f.send('hello', undefined, '../bad')).toThrow('Invalid');
    f.context.rooms.clear(); expect(() => f.send()).toThrow(/not active/);
  });
});
