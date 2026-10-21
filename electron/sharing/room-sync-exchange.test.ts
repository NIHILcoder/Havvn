import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../db/secrets', () => ({ encryptSecret: () => { throw new Error('fixture'); }, decryptSecretStrict: () => { throw new Error('fixture'); } }));
import { RoomSyncStore, type SyncPersistence } from '../db/room-sync-store';
import { RoomSyncExchange, canonicalSyncRecords } from './room-sync-exchange';
import { signSyncPolicy, signSyncRevision } from './room-sync-proofs';
import { deriveMemberId } from './room-crypto';
import { validSyncWireMessage, syncWireCanonical, type SyncWireBody, type SyncWireMessage } from '../../shared/room-file-sync-protocol';
import { validateGossip } from '../../shared/room-protocol';
import { gossipProofs } from '../../shared/room-message-auth';
const keys = crypto.generateKeyPairSync('ed25519'), pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const priv = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), owner = deriveMemberId(pub), peer = 'b'.repeat(32);
const context = { scope: 'room-scope', rootId: crypto.randomUUID(), ownerId: owner, e2e: false };
class Persistence implements SyncPersistence {
  data: unknown; fail = false; writes = 0;
  read() { return structuredClone(this.data); }
  write(value: unknown) { if (this.fail) throw new Error('disk full'); this.data = structuredClone(value); this.writes++; }
}
function fixture(count = 70) {
  const source = new Persistence(), target = new Persistence();
  const a = new RoomSyncStore(source, 'sender', context), b = new RoomSyncStore(target, 'receiver', context);
  const policy = signSyncPolicy(context.scope, { v: 1, rootId: context.rootId, epoch: 1, parentPolicyId: null,
    ownerId: owner, publisherId: owner, name: 'Config', allowDeletes: false, baseHeads: [], pub }, priv);
  a.acceptPolicy(policy, true); const entryId = crypto.randomUUID(); let parents: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = signSyncRevision(context.scope, { v: 1, rootId: context.rootId, policyId: policy.policyId,
      entryId, parents, relativePath: 'config.ini', op: 'put', blob: { infoHash: 'a'.repeat(40), name: 'config.ini', size: 1, enc: false, keyEpoch: null },
      authorId: owner, createdAt: i, pub }, priv);
    a.acceptRevision(r, true); parents = [r.revisionId];
  }
  const bus: Array<{ from: string; to: string; body: SyncWireBody }> = [];
  const make = (store: RoomSyncStore, id: string) => new RoomSyncExchange({ roots: () => [context.rootId],
    records: () => store.records(), accept: async (_root, records) => store.acceptRecords(records),
    acknowledge: (_root, ids) => store.acknowledgeMany(ids), current: () => true,
    send: async (to, body) => { bus.push({ from: id, to, body: structuredClone(body) }); } });
  const left = make(a, owner), right = make(b, peer);
  const pump = async (drop: (body: SyncWireBody) => boolean = () => false) => {
    let steps = 0;
    while (bus.length) {
      if (++steps > 1000) throw new Error('Exchange did not converge');
      const packet = bus.shift()!; if (!drop(packet.body)) await (packet.from === owner ? right : left).receive(packet.from, packet.body);
    }
  };
  return { a, b, source, target, bus, left, right, pump };
}

describe('room metadata exchange', () => {
  it('orders independent branches identically and keeps their policy/parent dependencies replayable', () => {
    const f = fixture(1), p = f.a.policy()!, a = f.a.records()[1].value;
    if (!('revisionId' in a)) throw new Error('revision fixture');
    const b = signSyncRevision(context.scope, { ...a, parents: [a.revisionId], createdAt: 201 }, priv);
    const c = signSyncRevision(context.scope, { ...a, parents: [a.revisionId], createdAt: 202 }, priv);
    const base = f.a.records();
    const left = canonicalSyncRecords([...base, { kind: 'revision', value: b }, { kind: 'revision', value: c }]);
    const right = canonicalSyncRecords([...base, { kind: 'revision', value: c }, { kind: 'revision', value: b }]);
    expect(left).toEqual(right); expect(left[0].value).toEqual(p);
    const store = new RoomSyncStore(new Persistence(), 'sorted', context); store.acceptRecords(left); expect(store.heads()[0].revisionIds).toHaveLength(2);
    expect(() => canonicalSyncRecords(left.slice(1))).toThrow('dependency'); f.left.close(); f.right.close();
  });
  it.each([2, 3, 4, 5, 6] as const)('separates v%s wire signatures and refuses new records in older frames', version => {
    const p = signSyncPolicy(context.scope, { v: version, writers: [owner], rootId: context.rootId, epoch: 1, parentPolicyId: null,
      ownerId: owner, publisherId: owner, name: 'Team', allowDeletes: false, baseHeads: [], pub }, priv);
    const frame: SyncWireMessage = { t: `file-sync-v${version}`, memberId: owner, to: '', pub, sig: '',
      body: { kind: 'page', rootId: context.rootId, streamId: 'a'.repeat(64), offset: 0, total: 1, records: [{ kind: 'policy', value: p }] } };
    frame.to = peer;
    frame.sig = crypto.sign(null, syncWireCanonical(context.scope, owner, peer, frame.body, version), priv).toString('base64');
    expect(validSyncWireMessage(frame)).toBe(true); expect(validateGossip(frame)).not.toBeNull();
    expect(validSyncWireMessage({ ...frame, t: 'file-sync-v1' })).toBe(false);
    if (version >= 3) expect(validSyncWireMessage({ ...frame, t: 'file-sync-v2' })).toBe(false);
    if (version >= 4) expect(validSyncWireMessage({ ...frame, t: 'file-sync-v3' })).toBe(false);
    if (version >= 5) expect(validSyncWireMessage({ ...frame, t: 'file-sync-v4' })).toBe(false);
    if (version === 6) expect(validSyncWireMessage({ ...frame, t: 'file-sync-v5' })).toBe(false);
    const proofs = gossipProofs(frame, context.scope, owner);
    expect(proofs.length).toBe(2);
    expect(crypto.verify(null, syncWireCanonical(context.scope, owner, peer, frame.body), pub, Buffer.from(frame.sig, 'base64'))).toBe(false);
  });
  it('replicates causal pages and acknowledges only after atomic persistence', async () => {
    const f = fixture(); await f.left.offer(peer); await f.pump();
    expect(f.b.heads()).toEqual(f.a.heads()); expect(f.b.records()).toEqual(f.a.records());
    expect(f.target.writes).toBe(3); expect(f.a.outbox()).toEqual([]);
  });
  it('does not ACK or advance a page if the disk write fails', async () => {
    const f = fixture(2); await f.left.offer(peer);
    const offer = f.bus.shift()!; await f.right.receive(owner, offer.body);
    const request = f.bus.shift()!; await f.left.receive(peer, request.body);
    const page = f.bus.shift()!; f.target.fail = true;
    await expect(f.right.receive(owner, page.body)).rejects.toThrow('disk full');
    expect(f.bus).toEqual([]); expect(f.a.outbox()).toHaveLength(3);
    // A failed store is deliberately poisoned until reopened; simulate a process restart.
    const reopened = new RoomSyncStore(f.target, 'receiver', context); f.target.fail = false;
    const retry = new RoomSyncExchange({ roots: () => [], records: () => undefined,
      accept: async (_id, records) => reopened.acceptRecords(records), acknowledge: () => {}, current: () => true,
      send: async (to, body) => { f.bus.push({ from: peer, to, body }); } });
    await retry.receive(owner, offer.body); f.bus.length = 0; await retry.receive(owner, page.body);
    expect(f.bus.some(p => p.body.kind === 'ack')).toBe(true); expect(reopened.heads()).toEqual(f.a.heads());
  });
  it('recovers a lost final ACK on the next offer without replaying the log', async () => {
    const f = fixture(1); await f.left.offer(peer); await f.pump(body => body.kind === 'ack');
    expect(f.a.outbox()).toHaveLength(2); expect(f.b.records()).toHaveLength(2);
    const writes = f.target.writes; await f.left.offer(peer); await f.pump();
    expect(f.a.outbox()).toEqual([]); expect(f.target.writes).toBe(writes);
  });
  it('handles a reordered/lost intermediate ACK with a later prefix confirmation', async () => {
    const f = fixture(); let dropped = false; await f.left.offer(peer);
    await f.pump(body => { if (body.kind === 'ack' && !dropped) { dropped = true; return true; } return false; });
    expect(f.a.outbox()).toEqual([]); expect(f.b.heads()).toEqual(f.a.heads());
  });
  it('does not accept a page which was not requested or an ACK from another stream', async () => {
    const f = fixture(1);
    await f.right.receive(owner, { kind: 'page', rootId: context.rootId, streamId: 'a'.repeat(64), offset: 0, total: 2, records: f.a.records() });
    expect(f.target.writes).toBe(0);
    await f.left.receive(peer, { kind: 'ack', rootId: context.rootId, streamId: 'a'.repeat(64), next: 2 });
    expect(f.a.outbox()).toHaveLength(2);
  });
  it('applies an entire page or none of it when a later revision is invalid', async () => {
    const f = fixture(1), records = f.a.records();
    const bad = structuredClone(records[1]); if (bad.kind === 'revision') bad.value.createdAt++;
    expect(() => f.b.acceptRecords([records[0], bad])).toThrow(); expect(f.b.policy()).toBeNull(); expect(f.target.writes).toBe(0);
  });
  it('stops replies after the room closes', async () => {
    const f = fixture(1); f.left.close(); await expect(f.left.offer(peer)).rejects.toThrow('stopped');
    expect(f.bus).toEqual([]);
  });
  it('bounds queued metadata work while a channel send is waiting', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const exchange = new RoomSyncExchange({ roots: () => [], records: () => undefined,
      accept: async () => {}, acknowledge: () => {}, current: () => true, send: async () => gate });
    const body = { kind: 'offer', rootId: context.rootId, streamId: 'a'.repeat(64), total: 1 };
    const queued = Array.from({ length: 128 }, () => exchange.receive(owner, body));
    await expect(exchange.receive(owner, body)).rejects.toThrow('queue full');
    release(); await Promise.all(queued); exchange.close();
  });
});

describe('authenticated gossip frames', () => {
  it('accepts broadcast offers and authenticates both the envelope and nested records', () => {
    const f = fixture(1);
    const frame: SyncWireMessage = { t: 'file-sync-v1', memberId: owner, to: peer, pub, sig: '',
      body: { kind: 'page', rootId: context.rootId, streamId: 'a'.repeat(64), offset: 0, total: 2, records: f.a.records() } };
    frame.sig = crypto.sign(null, syncWireCanonical(context.scope, owner, peer, frame.body), priv).toString('base64');
    expect(validSyncWireMessage(frame)).toBe(true); expect(validateGossip(frame)).not.toBeNull();
    const proofs = gossipProofs(frame, context.scope, owner); expect(proofs).toHaveLength(3);
    expect(proofs.every(p => crypto.verify(null, p.bytes, pub, Buffer.from(p.sig, 'base64')))).toBe(true);
    const broadcast = { ...frame, to: '', body: { kind: 'offer' as const, rootId: context.rootId, streamId: 'a'.repeat(64), total: 2 } };
    expect(validateGossip(broadcast)).not.toBeNull();
    expect(validateGossip({ ...frame, to: '' })).toBeNull();
    expect(crypto.verify(null, syncWireCanonical('other-room', owner, peer, frame.body), pub, Buffer.from(frame.sig, 'base64'))).toBe(false);
  });
  it('binds metadata replies to the exact bytes and destination', () => {
    const body: SyncWireBody = { kind: 'blob-metadata', rootId: context.rootId, streamId: 'a'.repeat(64), metadata: Buffer.from('metadata').toString('base64') };
    const bytes = syncWireCanonical(context.scope, owner, peer, body), sig = crypto.sign(null, bytes, priv);
    expect(crypto.verify(null, syncWireCanonical(context.scope, owner, 'c'.repeat(32), body), pub, sig)).toBe(false);
    expect(crypto.verify(null, syncWireCanonical(context.scope, owner, peer, { ...body, metadata: 'AAAA' }), pub, sig)).toBe(false);
  });
});
