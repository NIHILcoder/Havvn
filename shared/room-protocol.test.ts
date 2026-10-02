import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { validateGossip, RoomIngressBudget } from './room-protocol';
import { gossipProofs, currentHelloProofs } from './room-message-auth';
import { WatchSender, WatchReceiver, watchCanonical } from './room-watch-sync';
import { generateIdentityWeb, verifyWeb, signWeb } from './room-web-crypto';
import { lanGenesisCanonical, lanStateCanonical, lanSignalCanonical, lanAdmitCanonical, lanEvictCanonical, lanReachCanonical } from './lan-protocol';

const id = 'a'.repeat(32), session = 'b'.repeat(32), now = 1_000_000;
const watch = () => new WatchSender().next({ fileId: 'movie', action: 'join', position: 0 }, id, () => session, now)!;
describe('room protocol boundary', () => {
  it('accepts optional manifest markers from updated peers and retains older hellos', () => {
    for (const value of [undefined, false, true]) {
      expect(validateGossip({ t: 'hello', memberId: id, ...(value === undefined ? {} : { manifestFull: value }) })).not.toBeNull();
    }
    expect(validateGossip({ t: 'hello', memberId: id, manifestFull: 'yes' })).toBeNull();
  });
  it.each([null, false, 7, 'hello', [], {}, { t: 'unknown' }, { t: 'ping', memberId: [] },
    { t: 'ping', memberId: 'A', have: 'all' }, { t: 'prog', memberId: 'A', fileId: 'f', pct: Infinity },
    { t: 'folder', memberId: 'A', id: 'x', op: 'oops', at: 1 }, { t: 'ping', memberId: 'A', _t: -1 },
    JSON.parse('{"t":"ping","memberId":"A","extra":{"__proto__":{}}}'),
    { t: 'ping', memberId: 'A', have: Array(5001).fill('f') },
    { t: 'hello', memberId: 'A', files: [null] }, { t: 'hello', memberId: 'A', chatEdits: [] },
    { t: 'chat', id: 'm', memberId: 'A', text: 'unsigned', at: 1 },
    { t: 'chat-log', msgs: [{ id: 'm', memberId: 'A', text: 'unsigned', at: 1 }] },
  ])('rejects malformed values without throwing: %j', value => {
    expect(validateGossip(value)).toBeNull();
  });
  it('rejects deep extension data and cycles but accepts a bounded 5000-file availability list', () => {
    const m: any = { t: 'ping', memberId: id }, cycle: any = { t: 'ping', memberId: id };
    let tail = m; for (let i = 0; i < 20; i++) { tail.extra = {}; tail = tail.extra; }
    cycle.extra = cycle;
    expect(validateGossip(m)).toBeNull(); expect(validateGossip(cycle)).toBeNull();
    expect(validateGossip({ t: 'ping', memberId: id, have: Array(5000).fill('f') })).not.toBeNull();
  });
  it('keeps signed data byte-for-byte and rejects oversized fields rather than truncating', () => {
    const m = { t: 'chat-edit', memberId: id, msgId: 'm', at: 1, text: '  original  ', pub: 'PEM', sig: 'sig' };
    expect(validateGossip(m)).toBe(m); expect(m.text).toBe('  original  ');
    expect(validateGossip({ ...m, text: 'x'.repeat(2001) })).toBeNull();
  });
  it('bounds frame count, bytes and verification work, recovers after refill and rejects invalid charges', () => {
    const frames = new RoomIngressBudget(now);
    for (let i = 0; i < 256; i++) expect(frames.take(1, 0, now)).toBe(true);
    expect(frames.take(1, 0, now)).toBe(false); expect(frames.take(1, 0, now + 1000)).toBe(true);
    const bytes = new RoomIngressBudget(now);
    for (let i = 0; i < 4; i++) expect(bytes.take(1_000_000, 0, now)).toBe(true);
    expect(bytes.take(1, 0, now)).toBe(false); expect(bytes.take(1_000_000, 0, now + 1000)).toBe(true);
    const work = new RoomIngressBudget(now);
    expect(work.take(0, 2400, now)).toBe(true); expect(work.take(0, 1, now)).toBe(false);
    expect(work.take(0, 200, now + 1000)).toBe(true);
    expect(work.take(-1)).toBe(false); expect(work.take(1, -1)).toBe(false);
  });
  it('preserves all six frozen LAN signature domains in the shared relay proof builder', () => {
    const base = { pub: 'PEM', sig: 'sig', at: 123, sessionId: session, memberId: id, by: id, member: session,
      vip: 123, gen: 1, to: session, kind: 'ice', data: { candidate: 'ice' }, relay: true, reach: [id] };
    const vectors = [
      ['lan-genesis', lanGenesisCanonical(session, base)], ['lan-admit', lanAdmitCanonical(session, base)],
      ['lan-evict', lanEvictCanonical(session, base)], ['lan-state', lanStateCanonical('topic', base)],
      ['lan-signal', lanSignalCanonical('topic', base)], ['lan-reach', lanReachCanonical('topic', base)],
    ] as const;
    for (const [t, bytes] of vectors) {
      const m = validateGossip({ t, ...base })!;
      expect(m).not.toBeNull();
      expect(Buffer.from(gossipProofs(m, 'topic', id)[0].bytes).equals(bytes)).toBe(true);
    }
  });
  it('omits stale hello proofs after key rotation while preserving local records and current proofs', () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    const pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signFrame = (frame: any, topic: string) => {
      const p = gossipProofs(frame, topic, id)[0];
      return crypto.sign(null, p.bytes, keys.privateKey).toString('base64');
    };
    const old = { text: 'old', at: 1, by: id, pub, sig: '' }, fresh = { ...old, text: 'fresh' };
    old.sig = signFrame({ t: 'hello', chatEdits: { old } }, 'before');
    fresh.sig = signFrame({ t: 'hello', chatEdits: { fresh } }, 'after');
    const topicMsg = { ...old }; topicMsg.sig = signFrame({ t: 'topic', ...topicMsg }, 'before');
    const m = { t: 'hello', chatEdits: { old, fresh }, topicMsg };
    const clean = currentHelloProofs(m, 'after', id, p => crypto.verify(null, p.bytes, p.pub, Buffer.from(p.sig, 'base64')));
    expect(clean.chatEdits).toEqual({ fresh }); expect(clean.topicMsg).toBeUndefined();
    expect(m.chatEdits).toEqual({ old, fresh }); expect(m.topicMsg).toBe(topicMsg);
  });
});
describe('signed watch sessions', () => {
  it('whitelists outgoing fields and generates time/session/sequence locally', () => {
    const sender = new WatchSender();
    const m = sender.next({ fileId: 'movie', action: 'seek', position: 1, t: 'sync', at: 0, _g: 'spoof' } as any,
      id, () => session, now)!;
    expect(m).toMatchObject({ t: 'sync-v2', sessionId: session, startedAt: now, at: now, seq: 1 });
    expect(m).not.toHaveProperty('_g');
  });
  it('rejects legacy sync, malformed actions, nonfinite positions, invalid speeds and sequences', () => {
    const m = { ...watch(), pub: 'PEM', sig: 'sig' };
    expect(validateGossip(m)).not.toBeNull();
    for (const change of [{ t: 'sync' }, { action: 'execute' }, { position: -1 }, { position: Infinity },
      { rate: 0 }, { rate: 5 }, { seq: 0 }, { seq: 1.5 }, { at: now - 1 }, { sessionId: '' }]) {
      expect(validateGossip({ ...m, ...change })).toBeNull();
    }
  });
  it('accepts a late viewer heartbeat and ignores replay, old sessions, closed sessions and stale clocks', () => {
    const sender = new WatchSender(), receiver = new WatchReceiver();
    const input = { fileId: 'movie', action: 'join', position: 10 };
    const frame = (action: string, time = now) => ({ ...sender.next({ ...input, action }, id, () => session, time)!, pub: 'PEM', sig: 'sig' });
    const join = frame('join'), beat = frame('beat');
    expect(receiver.accept(beat, now)).toBe(true); // late viewer missed join
    expect(receiver.accept(join, now)).toBe(false); expect(receiver.accept(beat, now)).toBe(false);
    expect(receiver.accept(frame('leave'), now)).toBe(true);
    expect(receiver.accept({ ...beat, seq: 100 }, now)).toBe(false);
    expect(receiver.accept(frame('join', now + 1), now + 1)).toBe(true);
    expect(receiver.accept({ ...beat, seq: 101, at: now + 2 }, now + 2)).toBe(false);
    expect(receiver.accept(frame('beat', now + 2), now + 100_000)).toBe(false);
    expect(receiver.accept(frame('beat', now + 100_000), now)).toBe(false);
  });
  it('keeps replay floors bounded without eviction and limits commands per author', () => {
    const receiver = new WatchReceiver(), m = { ...watch(), pub: 'PEM', sig: 'sig' };
    for (let i = 1; i <= 20; i++) expect(receiver.accept({ ...m, seq: i }, now)).toBe(true);
    expect(receiver.accept({ ...m, seq: 21 }, now)).toBe(false);
    expect(receiver.accept({ ...m, seq: 21 }, now + 100)).toBe(true);
    for (let i = 1; i < 256; i++) expect(receiver.accept({ ...m, memberId: String(i) }, now)).toBe(true);
    expect(receiver.accept({ ...m, memberId: 'stranger' }, now)).toBe(false);
    expect(receiver.accept({ ...m, seq: 22 }, now + 1000)).toBe(true);
  });
  it('interoperates between Node and WebCrypto and binds every playback/session field and room', async () => {
    const identity = await generateIdentityWeb(), m = { ...watch(), memberId: identity.memberId };
    const bytes = watchCanonical('room-A', m);
    const sig = crypto.sign(null, bytes, identity.priv).toString('base64');
    expect(await verifyWeb(identity.pub, bytes, sig)).toBe(true);
    const webSig = await signWeb(identity.priv, bytes);
    expect(crypto.verify(null, bytes, identity.pub, Buffer.from(webSig, 'base64'))).toBe(true);
    for (const change of [{ memberId: session }, { fileId: 'other' }, { action: 'pause' as const }, { position: 11 },
      { rate: 2 }, { at: now + 1 }, { seq: 2 }, { sessionId: id }, { startedAt: now - 1 },
      { playing: true }, { together: true }, { emoji: '🔥' }]) {
      expect(await verifyWeb(identity.pub, watchCanonical('room-A', { ...m, ...change }), sig)).toBe(false);
    }
    expect(await verifyWeb(identity.pub, watchCanonical('room-B', m), sig)).toBe(false);
  });
});
