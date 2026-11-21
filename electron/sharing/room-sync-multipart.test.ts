import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db/secrets', () => ({ encryptSecret: () => { throw new Error('fixture'); }, decryptSecretStrict: () => { throw new Error('fixture'); } }));
import { RoomSyncStore, type SyncPersistence } from '../db/room-sync-store';
import { RoomSyncSession } from './room-sync-session';
import { RoomSyncExchange } from './room-sync-exchange';
import { signSyncPolicy, signSyncRevision } from './room-sync-proofs';
import { deriveMemberId } from './room-crypto';
import { validSyncPolicy, type SyncRecord } from '../../shared/room-file-sync';
import { validSyncWireBody, validSyncWireMessage, validSyncWireVersion, syncWireCanonical,
  SYNC_PAGE_BYTES, SYNC_RECORD_BYTES, SYNC_RECORD_PART_BYTES, type SyncWireBody } from '../../shared/room-file-sync-protocol';
import { gossipProofs } from '../../shared/room-message-auth';
import { validateGossip } from '../../shared/room-protocol';

const keys = crypto.generateKeyPairSync('ed25519');
const identity = { pub: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
const owner = deriveMemberId(identity.pub), peer = 'b'.repeat(32);
class Persistence implements SyncPersistence {
  data: unknown; writes = 0; fail = false;
  read() { return structuredClone(this.data); }
  write(value: unknown) { if (this.fail) throw new Error('disk full'); this.data = structuredClone(value); this.writes++; }
}
const exchanges: RoomSyncExchange[] = [], directories: string[] = [];
afterEach(() => { exchanges.splice(0).forEach(e => e.close()); directories.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })); vi.restoreAllMocks(); });

async function fixture(count = 200, encrypted = false) {
  const context = { scope: 'multipart-room', rootId: crypto.randomUUID(), ownerId: owner, e2e: encrypted };
  const source = new Persistence(), target = new Persistence();
  const leftStore = new RoomSyncStore(source, 'sender', context), rightStore = new RoomSyncStore(target, 'receiver', context);
  const genesis = signSyncPolicy(context.scope, { v: 1, rootId: context.rootId, epoch: 1, parentPolicyId: null, ownerId: owner, publisherId: owner,
    name: 'Project', allowDeletes: false, baseHeads: [], pub: identity.pub }, identity.priv);
  const records: SyncRecord[] = [{ kind: 'policy', value: genesis }];
  for (let n = 0; n < count; n++) {
    const name = `${String(n).padStart(4, '0')}.txt`;
    records.push({ kind: 'revision', value: signSyncRevision(context.scope, { v: 1, rootId: context.rootId, policyId: genesis.policyId,
      entryId: crypto.randomUUID(), parents: [], relativePath: 'project/' + name, op: 'put', blob: { name, infoHash: 'a'.repeat(40), size: 1,
        enc: encrypted, keyEpoch: encrypted ? 'a'.repeat(64) : null }, authorId: owner, createdAt: n, pub: identity.pub }, identity.priv) });
  }
  leftStore.acceptRecords(records);
  const session = new RoomSyncSession({ context, store: leftStore, identity, storage: 'unused-unbound-fixture', isCurrent: () => true });
  const plan = await session.prepareCheckpoint(); await session.confirmCheckpoint(plan);
  const bus: Array<{ from: string; body: SyncWireBody }> = [], seen: SyncWireBody[] = [];
  const make = (store: RoomSyncStore, from: string) => {
    const exchange = new RoomSyncExchange({ roots: () => [context.rootId], records: () => store.records(), current: () => true,
      accept: async (_root, page) => store.acceptRecords(page), acknowledge: (_root, ids) => store.acknowledgeMany(ids),
      send: async (_to, body) => { seen.push(structuredClone(body)); bus.push({ from, body: structuredClone(body) }); } });
    exchanges.push(exchange); return exchange;
  };
  const left = make(leftStore, owner), right = make(rightStore, peer);
  const pump = async (drop: (body: SyncWireBody) => boolean = () => false) => {
    let steps = 0;
    while (bus.length) { if (++steps > 2000) throw new Error('Multipart exchange did not converge'); const packet = bus.shift()!; if (!drop(packet.body)) await (packet.from === owner ? right : left).receive(packet.from, packet.body); }
  };
  const firstPart = async () => {
    await left.offer(peer); const offer = bus.shift()!; await right.receive(owner, offer.body);
    const request = bus.shift()!; await left.receive(peer, request.body);
    const part = bus.shift()!.body; if (part.kind !== 'record-part') throw new Error('Expected multipart fixture');
    return { offer: offer.body, part };
  };
  return { context, source, target, leftStore, rightStore, left, right, make, session, records, plan, bus, seen, pump, firstPart };
}

describe('bounded multipart signed checkpoints', () => {
  it('resumes a lost fragment promptly without another broadcast offer, then stops retrying', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      const f = await fixture(), { part } = await f.firstPart();
      await f.right.receive(owner, part); f.bus.length = 0;
      await vi.advanceTimersByTimeAsync(1999); expect(f.bus).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.bus[0]?.body).toMatchObject({ kind: 'part-request', byteOffset: SYNC_RECORD_PART_BYTES });
      await f.pump(); expect(f.rightStore.heads()).toEqual(f.leftStore.heads());
      await vi.advanceTimersByTimeAsync(4000); expect(f.bus).toEqual([]);
      exchanges.splice(0).forEach(e => e.close());
      await vi.advanceTimersByTimeAsync(4000); expect(f.bus).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it.each([false, true])('bootstraps 2000 file heads atomically, resumes a dropped part and reopens with verified history (E2E %s)', async encrypted => {
    const f = await fixture(2000, encrypted), before = f.target.writes;
    expect(f.plan.policy.v).toBe(5); expect(f.plan.policy.baseHeads).toHaveLength(2000);
    expect(validSyncPolicy({ ...f.plan.policy, v: 4 })).toBe(false);
    const { offer, part } = await f.firstPart(); expect(part.bytes).toBeGreaterThan(SYNC_PAGE_BYTES);
    await f.right.receive(owner, part); expect(f.target.writes).toBe(before); expect(f.rightStore.policy()).toBeNull();
    // A request/part is lost; the periodic offer resumes exactly after the received bytes.
    f.bus.length = 0; await f.right.receive(owner, offer);
    expect(f.bus[0].body).toMatchObject({ kind: 'part-request', byteOffset: SYNC_RECORD_PART_BYTES });
    await f.pump(); expect(f.target.writes).toBe(before + 1); expect(f.rightStore.heads()).toEqual(f.leftStore.heads());
    expect(f.seen.filter(b => b.kind === 'record-part').length).toBeGreaterThan(2);
    expect(f.seen.every(b => validSyncWireBody(b) && Buffer.byteLength(JSON.stringify(b)) <= SYNC_PAGE_BYTES)).toBe(true);
    const reopened = new RoomSyncStore(f.target, 'receiver', f.context); expect(reopened.heads()).toHaveLength(2000);
    await f.session.changeWriters([owner], f.session.rightsStamp(), true); expect(f.leftStore.policy()?.v).toBe(5);
    await f.left.offer(peer); await f.pump(); expect(f.rightStore.policy()).toEqual(f.leftStore.policy());
    const anchor = f.plan.policy.checkpoint!.anchors[0], policy = f.leftStore.policy()!;
    const next = signSyncRevision(f.context.scope, { ...anchor, v: 5, policyId: policy.policyId, parents: [anchor.revisionId], createdAt: 9999 }, identity.priv);
    f.leftStore.acceptRevision(next); await f.left.offer(peer); await f.pump(); expect(f.rightStore.revision(next.revisionId)).toEqual(next);
    const again = await f.session.prepareCheckpoint(); expect(again.policy.v).toBe(5);
    const downgrade = signSyncPolicy(f.context.scope, { ...again.policy, v: 4, baseHeads: [], checkpoint: { ...again.policy.checkpoint!, anchors: [], origins: [] } }, identity.priv);
    expect(() => f.leftStore.acceptPolicy(downgrade)).toThrow('downgrade');
  }, 60_000);

  it('preserves an existing bound working tree until every part is verified and persisted', async () => {
    const f = await fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-multipart-')); directories.push(directory);
    f.rightStore.acceptRecords(f.records); f.rightStore.bind(directory); f.rightStore.setAutoApply(true);
    fs.writeFileSync(path.join(directory, 'local.txt'), 'unsaved independent work');
    const previous = structuredClone(f.target.data), { part } = await f.firstPart(); await f.right.receive(owner, part);
    expect(f.target.data).toEqual(previous); expect(f.rightStore.binding()?.autoApply).toBe(true);
    await f.pump(); expect(f.rightStore.binding()?.autoApply).toBe(false); expect(f.rightStore.retiredCount()).toBe(1);
    expect(fs.readFileSync(path.join(directory, 'local.txt'), 'utf8')).toBe('unsaved independent work');
    const reopened = new RoomSyncStore(f.target, 'receiver', f.context); expect(reopened.retiredCount()).toBe(1); expect(reopened.heads()).toEqual(f.leftStore.heads());
  });

  it('handles duplicate parts and a lost final ACK without repeating the durable cutover', async () => {
    const f = await fixture(), { offer, part } = await f.firstPart();
    await f.right.receive(owner, part); f.bus.length = 0;
    await f.right.receive(owner, part); expect(f.bus[0].body).toMatchObject({ kind: 'part-request', byteOffset: SYNC_RECORD_PART_BYTES });
    await f.pump(b => b.kind === 'ack'); const writes = f.target.writes;
    expect(f.leftStore.pendingRecordIds()).toContain(f.plan.policy.policyId);
    await f.right.receive(owner, offer); expect(f.bus[0].body).toMatchObject({ kind: 'ack', next: 1 }); await f.pump();
    expect(f.target.writes).toBe(writes); expect(f.leftStore.pendingRecordIds()).not.toContain(f.plan.policy.policyId);
  });

  it('rejects corrupted bytes without a partial write or durable acknowledgement', async () => {
    const f = await fixture(), { part } = await f.firstPart(); const bytes = Buffer.from(part.data, 'base64'); bytes[0] ^= 1;
    await f.right.receive(owner, { ...part, data: bytes.toString('base64') });
    await expect(f.pump()).rejects.toThrow('digest mismatch');
    expect(f.target.writes).toBe(0); expect(f.rightStore.policy()).toBeNull(); expect(f.seen.some(b => b.kind === 'ack')).toBe(false);
    f.bus.length = 0; await f.left.offer(peer); await f.pump(); expect(f.rightStore.heads()).toHaveLength(200);
  });

  it('checks owner and anchor signatures after reassembly, even with a matching byte digest', async () => {
    const f = await fixture(), { part } = await f.firstPart();
    const record = f.leftStore.records()[0]; if (record.kind !== 'policy') throw Error('policy fixture'); record.value.checkpoint!.anchors[0].createdAt++;
    const bytes = Buffer.from(JSON.stringify(record)), digest = crypto.createHash('sha256').update(bytes).digest('hex');
    for (let offset = 0; offset < bytes.length; offset += SYNC_RECORD_PART_BYTES) {
      const receive = f.right.receive(owner, { ...part, byteOffset: offset, bytes: bytes.length, digest, data: bytes.subarray(offset, offset + SYNC_RECORD_PART_BYTES).toString('base64') });
      if (offset + SYNC_RECORD_PART_BYTES >= bytes.length) await expect(receive).rejects.toThrow('anchor'); else await receive;
      f.bus.length = 0;
    }
    expect(f.target.writes).toBe(0); expect(f.rightStore.policy()).toBeNull();
  });

  it('keeps the old snapshot on disk failure and restarts incomplete staging from byte zero', async () => {
    const f = await fixture(), { offer, part } = await f.firstPart(); await f.right.receive(owner, part);
    f.target.fail = true; await expect(f.pump()).rejects.toThrow('disk full'); expect(f.target.writes).toBe(0);
    f.right.close(); f.target.fail = false; f.bus.length = 0;
    const reopened = new RoomSyncStore(f.target, 'receiver', f.context), exchange = f.make(reopened, peer);
    await exchange.receive(owner, offer); expect(f.bus[0].body).toMatchObject({ kind: 'request', offset: 0 });
    while (f.bus.length) { const packet = f.bus.shift()!; await (packet.from === owner ? exchange : f.left).receive(packet.from, packet.body); }
    expect(reopened.heads()).toEqual(f.leftStore.heads());
  });

  it('discards stale staging on expiry or a replacement stream, and does not mix peers', async () => {
    const f = await fixture(), { offer, part } = await f.firstPart(); await f.right.receive(owner, part); f.bus.length = 0;
    await f.right.receive('c'.repeat(32), part); expect(f.bus).toEqual([]);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    await f.right.receive(owner, offer); expect(f.bus[0].body).toMatchObject({ kind: 'request', offset: 0 }); clock.mockRestore();
    f.bus.length = 0; await f.right.receive(owner, { ...offer, streamId: 'f'.repeat(64) }); f.bus.length = 0;
    await f.right.receive(owner, part); expect(f.bus).toEqual([]); expect(f.target.writes).toBe(0);
  });

  it('binds every fragment field to a v5 envelope and rejects legacy frames and oversized declarations', async () => {
    const f = await fixture(), { part } = await f.firstPart();
    const frame = { t: 'file-sync-v5', memberId: owner, to: peer, body: part, pub: identity.pub,
      sig: crypto.sign(null, syncWireCanonical(f.context.scope, owner, peer, part, 5), identity.priv).toString('base64') };
    expect(validSyncWireMessage(frame)).toBe(true); expect(validateGossip(frame)).not.toBeNull(); expect(gossipProofs(frame, f.context.scope, owner)).toHaveLength(1);
    for (const version of [1, 2, 3, 4] as const) { expect(validSyncWireVersion(part, version)).toBe(false); expect(validSyncWireMessage({ ...frame, t: `file-sync-v${version}` })).toBe(false); }
    for (const body of [{ ...part, byteOffset: 1 }, { ...part, bytes: part.bytes + 1 }, { ...part, digest: 'f'.repeat(64) }, { ...part, data: 'AAAA' }]) {
      expect(crypto.verify(null, syncWireCanonical(f.context.scope, owner, peer, body, 5), identity.pub, Buffer.from(frame.sig, 'base64'))).toBe(false);
    }
    expect(validSyncWireBody({ ...part, bytes: SYNC_RECORD_BYTES + 1 })).toBe(false);
    expect(validSyncWireBody({ ...part, data: part.data + 'AAAA' })).toBe(false);
    await expect(f.right.receive(owner, { ...part, data: 'AB==' })).rejects.toThrow();
  });

  it('ignores out-of-order bytes and rejects changed part identity or a false stream commitment before persistence', async () => {
    const f = await fixture(), { offer, part } = await f.firstPart();
    await f.right.receive(owner, { ...part, byteOffset: SYNC_RECORD_PART_BYTES });
    expect(f.bus[0].body).toMatchObject({ kind: 'request', offset: 0 }); f.bus.length = 0;
    await f.right.receive(owner, part); f.bus.length = 0;
    await expect(f.right.receive(owner, { ...part, digest: 'c'.repeat(64) })).rejects.toThrow('identity changed');
    expect(f.target.writes).toBe(0);
    const falseOffer = { ...offer, streamId: 'f'.repeat(64) }; await f.right.receive(owner, falseOffer); f.bus.length = 0;
    const bytes = Buffer.from(JSON.stringify(f.leftStore.records()[0]));
    for (let offset = 0; offset < bytes.length; offset += SYNC_RECORD_PART_BYTES) {
      const receive = f.right.receive(owner, { ...part, streamId: falseOffer.streamId, byteOffset: offset,
        data: bytes.subarray(offset, offset + SYNC_RECORD_PART_BYTES).toString('base64') });
      if (offset + SYNC_RECORD_PART_BYTES >= bytes.length) await expect(receive).rejects.toThrow('stream digest'); else await receive;
      f.bus.length = 0;
    }
    expect(f.target.writes).toBe(0);
  });

  it('bounds aggregate staged bytes across peers instead of trusting their declared record size', async () => {
    const f = await fixture(), { offer, part } = await f.firstPart(), peers = [owner, peer, 'c'.repeat(32)];
    for (const id of peers) await f.right.receive(id, offer);
    f.bus.length = 0; let limited = false;
    for (let offset = 0; offset < 6 * 1024 * 1024 && !limited; offset += SYNC_RECORD_PART_BYTES) for (const id of peers) {
      try { await f.right.receive(id, { ...part, bytes: SYNC_RECORD_BYTES, byteOffset: offset }); }
      catch (error) { expect(String(error)).toContain('staging capacity'); limited = true; break; }
      f.bus.length = 0;
    }
    expect(limited).toBe(true); expect(f.target.writes).toBe(0); expect(f.rightStore.policy()).toBeNull();
  });
});
