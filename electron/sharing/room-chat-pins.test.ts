/* eslint-disable @typescript-eslint/no-explicit-any -- Real engine functions with injected IPC boundary. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { chatCanonical, chatContextCanonical, editCanonical } from '../../shared/room-canonicals';
import { chatPinsCanonical, cleanChatPin, newerChatPins, validChatPins, ROOM_PIN_LIMIT } from '../../shared/room-chat-pins';
import { gossipProofs } from '../../shared/room-message-auth';
import { validateGossip } from '../../shared/room-protocol';

const source = readFileSync(new URL('./room-engine.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('Missing engine boundary');
  return source.slice(a, b);
}
const runtime = [extract('function signBytes(', '/** Bind memberId'), extract('function verifySignedBy(', '/* Authority commands'),
  extract('function verifiedChatPin(', 'function persistFolder(')].join('\n');
const js = ts.transpileModule(runtime, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function identity() {
  const keys = crypto.generateKeyPairSync('ed25519');
  const pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { pub, priv, memberId: crypto.createHash('sha256').update(pub).digest('hex').slice(0, 32) };
}
const sign = (id: ReturnType<typeof identity>, bytes: Uint8Array) => crypto.sign(null, bytes, id.priv).toString('base64');
function fixture() {
  const owner = identity(), author = identity();
  const message = (i = 1) => {
    const m: any = { id: i.toString(16).padStart(32, '0'), at: Date.now(), memberId: author.memberId, name: 'Author', avatarSeed: 'author', text: 'Private pinned text ' + i,
      signedTopic: 'topic-a', receivedAt: Date.now(), pub: author.pub, chatV: 2 };
    m.sig = sign(author, chatCanonical('topic-a', m)); m.contextSig = sign(author, chatContextCanonical('topic-a', m)); return m;
  };
  const room: any = { roomId: 'room', topic: 'topic-a', ownerId: owner.memberId, transferAt: 0, self: owner, chat: [message()], chatEdits: new Map(), identities: new Map(), kicked: false };
  const invoke = vi.fn(async () => ({ ok: true }));
  const context: any = { rooms: new Map([['room', room]]), netSuspended: false, crypto, Buffer, Date, chatContextCanonical,
    chatPinsCanonical, cleanChatPin, newerChatPins, validChatPins, ROOM_PIN_LIMIT, ROOM_IDENTITY_LIMIT: 2048,
    idMatchesPub: (id: string, pub: string) => id === crypto.createHash('sha256').update(pub).digest('hex').slice(0, 32),
    bindIdentity: (r: any, id: string, pub: string) => r.identities.set(id, pub), log: vi.fn(),
    ipcRenderer: { invoke, send: vi.fn() }, pushState: vi.fn(), broadcast: vi.fn() };
  vm.runInNewContext(js, context);
  return { context, room, owner, author, message, invoke, pin: (id = room.chat[0].id, on = true) => context.pinChat('room', id, on) as Promise<unknown> };
}
describe('shared room chat pins', () => {
  it('commits before publishing, retains signed message copies, and supplies bounded authenticated relay proofs', async () => {
    const f = fixture(); let finish!: () => void;
    f.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true }); }));
    const saving = f.pin(); await Promise.resolve(); await Promise.resolve();
    expect(f.room.chatPins).toBeUndefined(); expect(f.context.broadcast).not.toHaveBeenCalled();
    finish(); await saving;
    const pins = f.room.chatPins;
    expect(pins.items[0].message.text).toContain('Private pinned');
    expect(pins.items[0].message.receivedAt).toBeUndefined(); expect(pins.items[0].message.signedTopic).toBeUndefined();
    f.room.chat = [];
    expect(f.room.chatPins.items).toHaveLength(1);
    expect(validateGossip(pins)).not.toBeNull();
    const proofs = gossipProofs(pins, 'topic-a', f.owner.memberId);
    expect(proofs).toHaveLength(3);
    expect(proofs.every(p => crypto.verify(null, p.bytes, p.pub, Buffer.from(p.sig, 'base64')))).toBe(true);
  });
  it('rejects disk failures and non-owners without publishing a pin', async () => {
    const f = fixture(); f.invoke.mockRejectedValueOnce(new Error('disk full'));
    await expect(f.pin()).rejects.toThrow('disk full'); expect(f.room.chatPins).toBeUndefined();
    f.room.ownerId = f.author.memberId;
    await expect(f.pin()).rejects.toThrow('Only the room owner'); expect(f.context.broadcast).not.toHaveBeenCalled();
  });
  it('re-signs for a code changed while storage is pending and keeps durable pins when a wire fails', async () => {
    const f = fixture(); let finish!: () => void;
    f.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true }); }));
    const saving = f.pin(); await Promise.resolve(); await Promise.resolve();
    f.room.topic = 'rotated-topic'; f.context.broadcast.mockImplementationOnce(() => { throw new Error('closed wire'); });
    finish(); await expect(saving).resolves.toEqual({ ok: true });
    expect(f.room.chatPins.signedTopic).toBe('rotated-topic');
    expect(crypto.verify(null, chatPinsCanonical('rotated-topic', f.room.chatPins), f.owner.pub, Buffer.from(f.room.chatPins.sig, 'base64'))).toBe(true);
    expect(f.room.chatPins.items[0].topic).toBe('topic-a');
  });
  it('rejects tampering, forged author attribution, replayed removals and previous owners', async () => {
    const f = fixture(); await f.pin(); const old = structuredClone(f.room.chatPins);
    const receiver = { ...f.room, chatPins: undefined, identities: new Map() };
    const damaged = structuredClone(old); damaged.items[0].message.text = 'forged';
    damaged.sig = sign(f.owner, chatPinsCanonical('topic-a', damaged));
    expect(f.context.adoptChatPins(receiver, damaged)).toBe(false);
    expect(f.context.adoptChatPins(receiver, old)).toBe(true);
    await f.pin(old.items[0].message.id, false);
    expect(f.context.adoptChatPins(receiver, f.room.chatPins)).toBe(true);
    expect(f.context.adoptChatPins(receiver, old)).toBe(false); expect(receiver.chatPins.items).toHaveLength(0);
    receiver.ownerId = f.author.memberId; receiver.transferAt = 50;
    expect(f.context.adoptChatPins(receiver, old)).toBe(false);
  });
  it('keeps original author proofs valid across rekeys and preserves newer edits in a snapshot', async () => {
    const f = fixture(); await f.pin();
    const m = f.room.chat[0], edit: any = { text: 'Edited pin', at: m.at + 1, by: f.author.memberId, pub: f.author.pub };
    edit.sig = sign(f.author, editCanonical('topic-a', { msgId: m.id, memberId: edit.by, at: edit.at, text: edit.text }));
    f.room.chatEdits.set(m.id, edit); f.context.refreshChatPins(f.room);
    expect(f.room.chatPins.items[0].edit.text).toBe('Edited pin');
    f.room.topic = 'topic-b'; f.context.refreshChatPins(f.room);
    const pins = f.room.chatPins;
    expect(pins.items[0].topic).toBe('topic-a'); expect(pins.signedTopic).toBe('topic-b');
    const receiver = { ...f.room, chatPins: undefined, identities: new Map(), chat: [] };
    expect(f.context.adoptChatPins(receiver, pins)).toBe(true);
    expect(gossipProofs(pins, 'topic-b', f.owner.memberId).every(p => crypto.verify(null, p.bytes, p.pub, Buffer.from(p.sig, 'base64')))).toBe(true);
  });
  it('serializes rapid mutations and limits shared pins to ten', async () => {
    const f = fixture(); f.room.chat = Array.from({ length: 11 }, (_, i) => f.message(i + 1));
    await Promise.all(f.room.chat.slice(0, 10).map((m: any) => f.pin(m.id)));
    expect(f.room.chatPins.items).toHaveLength(10);
    await expect(f.pin(f.room.chat[10].id)).rejects.toThrow('pin limit');
    expect(validChatPins({ ...f.room.chatPins, items: [...f.room.chatPins.items, f.room.chatPins.items[0]] })).toBe(false);
  });
});
