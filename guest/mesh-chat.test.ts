/* eslint-disable @typescript-eslint/no-explicit-any -- Wire-level integration with real crypto, without microphone/network bootstrap. */
import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { GuestRoom } from './mesh';
import { deriveKey, topicHash, encrypt, decrypt, deriveMemberId } from '../electron/sharing/room-crypto';
import { generateIdentityWeb } from '../shared/room-web-crypto';
import { chatCanonical, chatContextCanonical, editCanonical } from '../shared/room-canonicals';
import { RoomIngressBudget } from '../shared/room-protocol';
import { WatchSender, watchCanonical } from '../shared/room-watch-sync';
import { chatBackfillPages } from '../shared/room-chat-history';

vi.mock('./tracker', () => ({ startRendezvous: vi.fn() }));
vi.mock('./voice', () => ({ GuestVoice: class { participants() { return []; } reannounce() {} } }));
const CODE = 'swift-amber-otter-comet-4821';
const topic = topicHash(CODE), key = deriveKey(CODE);
const pair = crypto.generateKeyPairSync('ed25519');
const pub = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const priv = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const memberId = deriveMemberId(pub);
const sign = (bytes: Uint8Array) => crypto.sign(null, Buffer.from(bytes), priv).toString('base64');
function message(i: number, changes: any = {}) {
  const msg = { id: 'm' + i, at: Date.now() + 3600000 - i, memberId, name: 'Desktop', avatarSeed: 'desktop', text: 'body ' + i, ...changes };
  return { ...msg, pub, sig: sign(chatCanonical(topic, msg)), chatV: 2 as const, contextSig: sign(chatContextCanonical(topic, msg)) };
}
async function fixture() {
  const room = new GuestRoom({ identity: await generateIdentityWeb(), name: 'Guest', avatarSeed: 'guest', trackers: [], onChange: vi.fn() });
  const internals = room as any, sent: string[] = [];
  internals.key = new Uint8Array(key); internals.topic = topic;
  const rec = { id: 1, memberId, wire: { connected: true, send: (raw: string) => sent.push(raw), destroy: vi.fn(), onData: vi.fn(), onClose: vi.fn() } };
  internals.wires.set(1, rec);
  return { room, internals, rec, sent, frame: (payload: any) => internals.onFrame(rec, encrypt(key, payload)) };
}

describe('browser guest retained chat protocol', () => {
  it('receives all 150 offline messages and replies in bounded pages despite sender clock skew', async () => {
    const f = await fixture();
    const history = Array.from({ length: 150 }, (_, i) => message(i, i === 80 ? { replyTo: 'old-parent', replyName: 'Alice', replyText: 'original quote' } : {}));
    for (const msgs of chatBackfillPages(history)) await f.frame({ t: 'chat-log', msgs });
    expect(f.room.snapshot().chat.map(m => m.id)).toEqual(history.map(m => m.id));
    expect(f.room.snapshot().chat[80]).toMatchObject(history[80]);
    // Concurrent arrivals from different wires must still deduplicate after WebCrypto awaits.
    await Promise.all([f.frame({ t: 'chat-log', msgs: history }), f.frame({ t: 'chat-log', msgs: history })]);
    expect(f.room.snapshot().chat).toHaveLength(150);
  });

  it('rejects tampered v2 quotes, explicitly accepts legacy bodies, and later upgrades in place', async () => {
    const f = await fixture(), msg = message(1, { replyTo: 'parent', replyName: 'Alice', replyText: 'real quote' });
    await f.frame({ t: 'chat', ...msg, replyText: 'forged' });
    expect(f.room.snapshot().chat).toEqual([]);
    const { chatV: _version, contextSig: _context, ...legacy } = msg;
    await f.frame({ t: 'chat', ...legacy, replyTo: 'forged-parent' });
    expect(f.room.snapshot().chat[0].chatV).toBeUndefined();
    const receivedAt = f.room.snapshot().chat[0].receivedAt;
    await f.frame({ t: 'chat-log', msgs: [msg] });
    expect(f.room.snapshot().chat).toEqual([{ ...msg, receivedAt }]);
    await f.frame({ t: 'chat', ...legacy });
    expect(f.room.snapshot().chat[0].chatV).toBe(2);
  });

  it('applies an authenticated edit received before the original and re-serves its proof in HELLO', async () => {
    const f = await fixture(), original = message(2), edit = { msgId: original.id, memberId, at: original.at + 10, text: 'edited before original' };
    const sig = sign(editCanonical(topic, edit));
    await f.frame({ t: 'chat-edit', ...edit, pub, sig });
    expect(f.room.snapshot().chatEdits[original.id]).toBeUndefined();
    await f.frame({ t: 'chat-log', msgs: [original] });
    expect(f.room.snapshot().chatEdits[original.id]).toBe(edit.text);
    expect(f.internals.helloMsg().chatEdits[original.id]).toEqual({ text: edit.text, at: edit.at, by: memberId, pub, sig });
    for (const msgs of chatBackfillPages(Array.from({ length: 201 }, (_, i) => message(i + 100)))) await f.frame({ t: 'chat-log', msgs });
    expect(f.room.snapshot().chat).toHaveLength(200);
    expect(f.room.snapshot().chatEdits[original.id]).toBeUndefined();
  });

  it('signs replies for Node verification and reconciles full/legacy HELLO by ID', async () => {
    const f = await fixture(), parent = message(1);
    await f.frame({ t: 'chat', ...parent });
    await f.room.sendChat('guest reply', parent.id);
    const wireMsg = decrypt(key, f.sent.at(-1)!);
    expect(wireMsg).toMatchObject({ chatV: 2, replyTo: parent.id, replyName: parent.name, replyText: parent.text });
    expect(wireMsg).not.toHaveProperty('receivedAt');
    expect(crypto.verify(null, Buffer.from(chatCanonical(topic, wireMsg)), wireMsg.pub, Buffer.from(wireMsg.sig, 'base64'))).toBe(true);
    expect(crypto.verify(null, Buffer.from(chatContextCanonical(topic, wireMsg)), wireMsg.pub, Buffer.from(wireMsg.contextSig, 'base64'))).toBe(true);
    f.sent.length = 0;
    await f.internals.sendChatBackfill(f.rec, { chatSync: 2 });
    expect(f.sent).toEqual([]); // slim hello
    await f.internals.sendChatBackfill(f.rec, { chatSync: 2, chatIds: [parent.id], chatAt: Number.MAX_SAFE_INTEGER });
    expect(decrypt(key, f.sent[0]).msgs.map((m: any) => m.id)).toEqual([wireMsg.id]);
    f.sent.length = 0;
    await f.internals.sendChatBackfill(f.rec, { chatAt: Number.MAX_SAFE_INTEGER });
    expect(decrypt(key, f.sent[0]).msgs).toHaveLength(2);
    f.sent.length = 0;
    await f.internals.sendChatBackfill(f.rec, {});
    expect(f.sent).toEqual([]); // once per legacy wire
  });
});


describe('browser guest validates before relay', () => {
  it('rejects malformed and forged frames without poisoning their gossip id, then relays valid chat', async () => {
    const f = await fixture(), forwarded: string[] = [];
    f.internals.wires.set(2, { id: 2, memberId: 'neighbor', wire: { connected: true, send: (raw: string) => forwarded.push(raw) } });
    for (const raw of [null, false, 3, 'frame', [], { t: 'unknown', _g: 'invalid' }, { t: 'hello', memberId, files: [null] }]) await f.frame(raw);
    const original = { t: 'chat', ...message(91), _g: 'retry-id', _t: 4 };
    await f.frame({ ...original, text: 'forged' });
    expect(forwarded).toEqual([]); expect(f.room.snapshot().chat).toEqual([]);
    await f.frame(original);
    expect(decrypt(key, forwarded[0])).toMatchObject({ ...original, _t: 3 });
    expect(f.room.snapshot().chat).toHaveLength(1);
    await f.frame({ ...original, _g: 'another-route' });
    expect(f.room.snapshot().chat).toHaveLength(1);
  });
  it('limits malformed traffic across reconnects and accepts valid traffic after refill', async () => {
    const f = await fixture(); let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      f.internals.ingress = new RoomIngressBudget(now);
      for (let i = 0; i < 256; i++) await f.frame(null);
      const m = { t: 'chat', ...message(123) };
      await f.internals.onFrame({ ...f.rec, id: 99 }, encrypt(key, m));
      expect(f.room.snapshot().chat).toEqual([]); // a fresh wire cannot reset the room budget
      now += 1000; await f.frame(m);
      expect(f.room.snapshot().chat).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });
  it('requires a known signed watch author and shared file, rejects replay/legacy/tampering, and signs its own controls', async () => {
    const f = await fixture(), events: any[] = [], sender = new WatchSender();
    f.room.onSync = ev => events.push(ev);
    f.internals.files.set('movie', { fileId: 'movie', name: 'movie.mp4', playable: true });
    const make = (action: string) => {
      const body = sender.next({ fileId: 'movie', action, position: 12, rate: 1.5, playing: true, together: true }, memberId, () => 'd'.repeat(32))!;
      return { ...body, pub, sig: sign(watchCanonical(topic, body)), _g: 'watch-' + body.startedAt + '-' + body.seq, _t: 4 };
    };
    const join = make('join');
    await f.frame(join); expect(events).toEqual([]); // signature alone does not grant roster membership
    await f.frame({ t: 'hello', memberId, pub, name: 'Known author', avatarSeed: 'author', watchSync: 2 });
    await f.frame({ ...join, rate: 2 }); expect(events).toEqual([]);
    await f.frame({ ...join, t: 'sync' }); expect(events).toEqual([]);
    await f.frame(join); expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'Known author', rate: 1.5, position: 12,
      sessionId: join.sessionId, startedAt: join.startedAt, seq: join.seq });
    await f.frame({ ...join, _g: 'new-id-same-command' }); expect(events).toHaveLength(1);
    const leave = make('leave'); await f.frame(leave); expect(events).toHaveLength(2);
    const closedBeat = { ...leave, action: 'beat', seq: leave.seq + 1, _g: 'closed-session' };
    await f.frame({ ...closedBeat, sig: sign(watchCanonical(topic, closedBeat as any)) }); expect(events).toHaveLength(2); // closed receiver session
    await f.frame(make('join')); expect(events).toHaveLength(3);
    await f.room.sendSync({ fileId: 'movie', action: 'seek', position: 40, rate: 2, at: 1, playing: true, together: true });
    const sent = decrypt(key, f.sent.at(-1)!);
    expect(sent).toMatchObject({ t: 'sync-v2', action: 'seek', position: 40, rate: 2 });
    expect(crypto.verify(null, watchCanonical(topic, sent), sent.pub, Buffer.from(sent.sig, 'base64'))).toBe(true);
  });
});
