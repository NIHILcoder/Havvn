import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db/secrets', () => ({ encryptSecret: () => { throw new Error('fixture'); }, decryptSecretStrict: () => { throw new Error('fixture'); } }));
import { RoomSyncStore, syncLogCommitment, type SyncPersistence } from '../db/room-sync-store';
import { packSyncLog, unpackSyncLog } from '../db/room-sync-log-pack';
import { RoomSyncSession } from './room-sync-session';
import { RoomSyncHistoryExchange } from './room-sync-history';
import { signSyncPolicy, signSyncRevision } from './room-sync-proofs';
import { deriveMemberId } from './room-crypto';
import { SYNC_PAGE_BYTES, SYNC_RECORD_BYTES, SYNC_RECORD_PART_BYTES, validSyncWireBody, validSyncWireMessage, syncWireCanonical,
  type SyncHistoryWireBody } from '../../shared/room-file-sync-protocol';
import type { SyncRecord, SyncPolicy } from '../../shared/room-file-sync';
import { validateGossip } from '../../shared/room-protocol';
import { gossipProofs } from '../../shared/room-message-auth';

const keys = crypto.generateKeyPairSync('ed25519');
const identity = { pub: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
const owner = deriveMemberId(identity.pub), peer = 'b'.repeat(32), missing = 'c'.repeat(32);
class Persistence implements SyncPersistence {
  data: unknown; writes = 0; fail = false; afterWrite = false;
  read() { return structuredClone(this.data); }
  write(value: unknown) { if (this.fail && !this.afterWrite) throw Error('disk full'); this.data = structuredClone(value); this.writes++; if (this.fail) throw Error('disk full'); }
}
const exchanges: RoomSyncHistoryExchange[] = [], directories: string[] = [];
afterEach(() => { exchanges.splice(0).forEach(e => e.close()); directories.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })); vi.restoreAllMocks(); });

async function fixture(count = 400, encrypted = false) {
  const context = { scope: 'history-room', rootId: crypto.randomUUID(), ownerId: owner, e2e: encrypted };
  const a = new Persistence(), b = new Persistence();
  const source = new RoomSyncStore(a, 'source', context), target = new RoomSyncStore(b, 'target', context);
  const policy = signSyncPolicy(context.scope, { v: 1, rootId: context.rootId, epoch: 1, parentPolicyId: null, ownerId: owner, publisherId: owner,
    name: 'History', allowDeletes: false, baseHeads: [], pub: identity.pub }, identity.priv);
  const records: SyncRecord[] = [{ kind: 'policy', value: policy }]; const entryId = crypto.randomUUID(); let parents: string[] = [];
  for (let n = 0; n < count; n++) {
    const revision = signSyncRevision(context.scope, { v: 1, rootId: context.rootId, policyId: policy.policyId, entryId, parents,
      relativePath: 'config.ini', op: 'put', blob: { name: 'config.ini', infoHash: 'a'.repeat(40), size: n, enc: encrypted, keyEpoch: encrypted ? 'a'.repeat(64) : null },
      authorId: owner, createdAt: n, pub: identity.pub }, identity.priv);
    records.push({ kind: 'revision', value: revision }); parents = [revision.revisionId];
  }
  source.acceptRecords(records);
  const session = new RoomSyncSession({ context, store: source, identity, storage: 'unused-unbound-history-fixture', isCurrent: () => true });
  const plan = await session.prepareCheckpoint(); await session.confirmCheckpoint(plan); target.acceptRecords(source.records());
  const bus: Array<{ from: string; to: string; body: SyncHistoryWireBody }> = [], seen: SyncHistoryWireBody[] = [];
  const make = (store: RoomSyncStore, from: string, options: Partial<ConstructorParameters<typeof RoomSyncHistoryExchange>[0]> = {}) => {
    const exchange = new RoomSyncHistoryExchange({ current: () => true, peers: () => [owner], timeoutMs: 1000,
      export: (_id, digest) => store.exportHistory(digest), accept: (_id, checkpointId, pack) => store.importHistory(checkpointId, pack),
      send: async (to, body) => { seen.push(structuredClone(body)); bus.push({ from, to, body: structuredClone(body) }); }, ...options });
    exchanges.push(exchange); return exchange;
  };
  const left = make(source, owner), right = make(target, peer);
  const pump = async (drop: (body: SyncHistoryWireBody) => boolean = () => false) => {
    let steps = 0;
    while (bus.length) { if (++steps > 1000) throw Error('History did not converge'); const p = bus.shift()!; if (!drop(p.body)) await (p.from === peer ? left : right).receive(p.from, p.body); }
  };
  return { context, a, b, source, target, session, records, entryId, plan, bus, seen, make, left, right, pump };
}

describe('verified historical epoch downloads', () => {
  it.each([false, true])('loads an owner-anchored chain without changing active state, consent or working bytes and reopens (E2E %s)', async encrypted => {
    const f = await fixture(400, encrypted), first = f.records[1].value;
    const anchor = f.plan.policy.checkpoint!.anchors[0];
    const next = signSyncRevision(f.context.scope, { ...anchor, v: 4, policyId: f.plan.policy.policyId, parents: [anchor.revisionId], createdAt: 999 }, identity.priv);
    f.source.acceptRevision(next); const plan2 = await f.session.prepareCheckpoint(); await f.session.confirmCheckpoint(plan2); f.target.acceptRecords(f.source.records());
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-history-')); directories.push(directory);
    fs.writeFileSync(path.join(directory, 'config.ini'), 'independent local work'); f.target.bind(directory); f.target.setAutoApply(true);
    const active = f.target.records(), heads = f.target.heads(), epoch = f.target.bindingEpoch(), generation = f.target.logGeneration();
    while (f.target.nextHistoryCheckpoint()) {
      const result = f.right.fetch(f.target.nextHistoryCheckpoint()!); await f.pump(); expect(await result).not.toBeNull();
    }
    expect(f.target.records()).toEqual(active); expect(f.target.heads()).toEqual(heads); expect(f.target.bindingEpoch()).toBe(epoch);
    expect(f.target.logGeneration()).toBe(generation); expect(f.target.binding()?.autoApply).toBe(true); expect(f.target.pendingRecordIds()).toEqual([]);
    expect(fs.readFileSync(path.join(directory, 'config.ini'), 'utf8')).toBe('independent local work');
    expect(f.target.historyPage(f.entryId, 0).items).toHaveLength(50); expect(f.target.historyPage(f.entryId, 400).items[0]).toEqual(first);
    expect(f.target.importedHistoryCount()).toBe(2); expect(f.seen.filter(b => b.kind === 'history-part').length).toBeGreaterThan(2);
    expect(f.seen.every(b => validSyncWireBody(b) && Buffer.byteLength(JSON.stringify(b)) <= SYNC_PAGE_BYTES)).toBe(true);
    const reopened = new RoomSyncStore(f.b, 'target', f.context); expect(reopened.revision('revisionId' in first ? first.revisionId : '')).toEqual(first);
    expect(reopened.nextHistoryCheckpoint()).toBeNull(); expect(reopened.importedHistoryCount()).toBe(2);
    const copy = f.source.exportHistory(f.plan.policy.checkpoint!.archiveDigest)!;
    expect(reopened.importHistory(f.plan.policy.policyId, copy)).toBe(0);
    reopened.setCacheLimit(1); expect(new RoomSyncStore(f.b, 'target', f.context).importedHistoryCount()).toBe(2);
    reopened.compactLog(reopened.prepareLogCompaction()); expect(new RoomSyncStore(f.b, 'target', f.context).importedHistoryCount()).toBe(2);
  }, 20_000);

  it('rejects substituted signed records, missing records and a false predecessor without changing the snapshot', async () => {
    const f = await fixture(3), digest = f.plan.policy.checkpoint!.archiveDigest, pack = f.source.exportHistory(digest)!, previous = structuredClone(f.b.data);
    const records = unpackSyncLog(pack), altered = structuredClone(records);
    if (altered[1].kind !== 'revision') throw Error('revision fixture');
    altered[1].value = signSyncRevision(f.context.scope, { ...altered[1].value, createdAt: 888 }, identity.priv);
    for (const invalid of [packSyncLog(altered), packSyncLog(records.slice(0, -1))]) expect(() => f.target.importHistory(f.plan.policy.policyId, invalid)).toThrow();
    expect(() => f.target.importHistory('f'.repeat(64), pack)).toThrow('Unknown');
    expect(f.b.data).toEqual(previous); expect(f.target.revision(f.plan.policy.checkpoint!.anchors[0].parents[0])).toBeUndefined();
    const corrupt = structuredClone(f.b.data) as { v: number; history: unknown[] }; corrupt.v = 4;
    corrupt.history = [{ checkpointId: f.plan.policy.policyId, pack: packSyncLog(records.slice(0, -1)) }]; f.b.data = corrupt;
    expect(() => new RoomSyncStore(f.b, 'target', f.context)).toThrow();
  });

  it.each([false, true])('recovers a complete old or new snapshot on write failure (after persistence %s)', async afterWrite => {
    const f = await fixture(2), pack = f.source.exportHistory(f.plan.policy.checkpoint!.archiveDigest)!;
    f.b.fail = true; f.b.afterWrite = afterWrite;
    expect(() => f.target.importHistory(f.plan.policy.policyId, pack)).toThrow('disk full'); expect(() => f.target.records()).toThrow('reopen');
    f.b.fail = false; const reopened = new RoomSyncStore(f.b, 'target', f.context);
    expect(reopened.importedHistoryCount()).toBe(afterWrite ? 1 : 0); expect(reopened.heads()).toEqual(f.source.heads());
  });

  it('keeps foreign offline archive branches separate and downloads only the committed owner set', async () => {
    const f = await fixture(2), divergent = new Persistence(), store = new RoomSyncStore(divergent, 'divergent', f.context);
    store.acceptRecords(f.records); const last = f.records.at(-1)!; if (last.kind !== 'revision') throw Error('revision fixture');
    store.acceptRevision(signSyncRevision(f.context.scope, { ...last.value, parents: [last.value.revisionId], createdAt: 55 }, identity.priv));
    store.acceptRecords(f.source.records()); expect(store.exportHistory(f.plan.policy.checkpoint!.archiveDigest)).toBeUndefined();
    store.importHistory(f.plan.policy.policyId, f.source.exportHistory(f.plan.policy.checkpoint!.archiveDigest)!);
    expect(store.historyPage(f.entryId, 0).items).toHaveLength(3); expect(store.retiredCount()).toBe(1); expect(store.importedHistoryCount()).toBe(1);
    expect(new RoomSyncStore(divergent, 'divergent', f.context).historyPage(f.entryId, 0).items).toHaveLength(3);
  });

  it('retries a lost part at its next offset and does not mix duplicate or unsolicited replies', async () => {
    const f = await fixture(), result = f.right.fetch(f.plan.policy); await Promise.resolve();
    const request = f.bus.shift()!; await f.left.receive(peer, request.body); const part = f.bus.shift()!.body;
    expect(part.kind).toBe('history-part'); await f.right.receive(missing, part); expect(f.bus).toEqual([]);
    await f.right.receive(owner, part); const next = f.bus.shift()!; expect(next.body).toMatchObject({ kind: 'history-request', byteOffset: SYNC_RECORD_PART_BYTES });
    await f.right.receive(owner, part); expect(f.bus[0].body).toMatchObject({ byteOffset: SYNC_RECORD_PART_BYTES });
    await f.pump(); expect(await result).toBeGreaterThan(0); expect(f.target.importedHistoryCount()).toBe(1);
    const writes = f.b.writes; await f.right.receive(owner, part); expect(f.b.writes).toBe(writes);
  });

  it('returns unavailable when all capable peers lack the epoch, and can use a peer that retained it', async () => {
    const f = await fixture(2), exchange = f.make(f.target, peer, { peers: () => [missing, owner] });
    const result = exchange.fetch(f.plan.policy); await Promise.resolve(); const requests = f.bus.splice(0);
    const absent = requests.find(p => p.to === missing)!;
    await exchange.receive(missing, { ...absent.body, kind: 'history-missing' });
    for (const request of [...requests.filter(p => p.to === owner), ...f.bus.splice(0)]) await f.left.receive(peer, request.body);
    while (f.bus.length) { const p = f.bus.shift()!; await (p.from === peer ? f.left : exchange).receive(p.from, p.body); }
    expect(await result).toBeGreaterThan(0);
    const empty = f.make(f.target, peer, { peers: () => [] }); await expect(empty.fetch(f.plan.policy)).resolves.toBeNull();
    const noSource = f.make(f.target, peer, { peers: () => [missing] }); const unavailable = noSource.fetch(f.plan.policy); await Promise.resolve();
    const request = f.bus.shift()!; await noSource.receive(missing, { ...request.body, kind: 'history-missing' }); await expect(unavailable).resolves.toBeNull();
  });

  it('rejects damaged transfer bytes before import and cancels downloads when a room closes', async () => {
    const f = await fixture(), result = f.right.fetch(f.plan.policy), rejected = expect(result).rejects.toThrow('digest'); await Promise.resolve();
    const request = f.bus.shift()!; await f.left.receive(peer, request.body); const part = f.bus.shift()!.body; if (part.kind !== 'history-part') throw Error('part fixture');
    const data = Buffer.from(part.data, 'base64'); data[0] ^= 1; await f.right.receive(owner, { ...part, data: data.toString('base64') });
    await expect(f.pump()).rejects.toThrow('digest'); await rejected; expect(f.target.importedHistoryCount()).toBe(0);
    f.bus.length = 0; const stopped = f.right.fetch(f.plan.policy), closing = expect(stopped).rejects.toThrow('stopped'); f.right.close(); await closing;
    await expect(f.right.receive(owner, part)).rejects.toThrow('stopped');
  });

  it('signs all history fields in a separate capability, including broadcast requests and bounded parts', async () => {
    const f = await fixture(2), pending = f.right.fetch(f.plan.policy); void pending.catch(() => {}); await Promise.resolve();
    const body = f.bus[0].body, frame = { t: 'file-sync-history-v1', memberId: owner, to: '', body, pub: identity.pub,
      sig: crypto.sign(null, syncWireCanonical(f.context.scope, owner, '', body, 5), identity.priv).toString('base64') };
    expect(validSyncWireMessage(frame)).toBe(true); expect(validateGossip(frame)).not.toBeNull(); expect(gossipProofs(frame, f.context.scope, owner)).toHaveLength(1);
    expect(validSyncWireMessage({ ...frame, t: 'file-sync-v5' })).toBe(false);
    expect(validSyncWireMessage({ ...frame, t: 'file-sync-v4' })).toBe(false);
    if (body.kind !== 'history-request') throw Error('request fixture');
    expect(crypto.verify(null, syncWireCanonical(f.context.scope, owner, '', { ...body, archiveDigest: 'f'.repeat(64) }, 5), identity.pub, Buffer.from(frame.sig, 'base64'))).toBe(false);
    expect(validSyncWireBody({ ...body, byteOffset: 1 })).toBe(false);
    expect(validSyncWireBody({ ...body, byteOffset: SYNC_RECORD_BYTES })).toBe(false);
  });

  it('retains eight downloaded epochs and stops at the quota without dropping older data or changing the floor', async () => {
    const f = await fixture(1), archives = new Map<string, ReturnType<typeof packSyncLog>>();
    let records = f.records, previous = f.records[0].value as SyncPolicy, parentCheckpointId: string | null = null;
    const anchor = f.plan.policy.checkpoint!.anchors[0];
    for (let generation = 1; generation <= 9; generation++) {
      const digest = syncLogCommitment(records); archives.set(digest, packSyncLog(records));
      const next = signSyncPolicy(f.context.scope, { ...previous, v: 4, writers: [owner], epoch: previous.epoch + 1, parentPolicyId: previous.policyId,
        baseHeads: [{ entryId: anchor.entryId, revisionId: anchor.revisionId }], checkpoint: { generation, parentCheckpointId,
          archiveDigest: digest, archiveRecords: records.length, anchors: [anchor], origins: [] } }, identity.priv);
      records = [{ kind: 'policy', value: next }]; previous = next; parentCheckpointId = next.policyId;
    }
    const persistence = new Persistence(), target = new RoomSyncStore(persistence, 'bounded', f.context); target.acceptRecords(records);
    const active = target.records();
    for (let n = 0; n < 8; n++) { const cp = target.nextHistoryCheckpoint()!; target.importHistory(cp.policyId, archives.get(cp.checkpoint!.archiveDigest)!); }
    expect(target.importedHistoryCount()).toBe(8); const cp = target.nextHistoryCheckpoint()!, before = structuredClone(persistence.data);
    expect(() => target.importHistory(cp.policyId, archives.get(cp.checkpoint!.archiveDigest)!)).toThrow('capacity');
    expect(persistence.data).toEqual(before); expect(target.records()).toEqual(active);
    const reopened = new RoomSyncStore(persistence, 'bounded', f.context); expect(reopened.importedHistoryCount()).toBe(8); expect(reopened.nextHistoryCheckpoint()?.policyId).toBe(cp.policyId);
    const session = new RoomSyncSession({ context: f.context, store: reopened, identity, storage: 'unused-history-quota-fixture', isCurrent: () => true });
    await session.confirmCheckpoint(await session.prepareCheckpoint()); expect(new RoomSyncStore(persistence, 'bounded', f.context).importedHistoryCount()).toBe(8);
  });

  it('requests the missing byte offset after a real retry interval', async () => {
    const f = await fixture(), exchange = f.make(f.target, peer, { timeoutMs: 10_000 }); vi.useFakeTimers();
    try {
      const pending = exchange.fetch(f.plan.policy); void pending.catch(() => {}); await Promise.resolve();
      const request = f.bus.shift()!; await f.left.receive(peer, request.body); const part = f.bus.shift()!.body;
      await exchange.receive(owner, part); f.bus.length = 0;
      await vi.advanceTimersByTimeAsync(2000); expect(f.bus[0].body).toMatchObject({ kind: 'history-request', byteOffset: SYNC_RECORD_PART_BYTES });
      while (f.bus.length) { const p = f.bus.shift()!; await (p.from === peer ? f.left : exchange).receive(p.from, p.body); }
      expect(await pending).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });

  it('falls back to a retained replica when the selected peer stops responding', async () => {
    const f = await fixture(), replica = f.make(f.source, missing), exchange = f.make(f.target, peer, { timeoutMs: 15_000, peers: () => [owner, missing] });
    vi.useFakeTimers();
    try {
      const pending = exchange.fetch(f.plan.policy); void pending.catch(() => {}); await Promise.resolve(); await Promise.resolve();
      const requests = f.bus.splice(0); await f.left.receive(peer, requests.find(p => p.to === owner)!.body);
      await exchange.receive(owner, f.bus.shift()!.body); f.bus.length = 0;
      await vi.advanceTimersByTimeAsync(6000);
      expect(f.bus.some(p => p.to === missing && p.body.kind === 'history-request' && p.body.byteOffset === 0)).toBe(true);
      f.bus.splice(0, f.bus.findIndex(p => p.to === missing));
      while (f.bus.length) { const p = f.bus.shift()!; await (p.from === peer ? replica : exchange).receive(p.from, p.body); }
      expect(await pending).toBeGreaterThan(0); expect(f.target.importedHistoryCount()).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('asks another provider when sending to the first destination fails', async () => {
    const f = await fixture(2), replica = f.make(f.source, missing), exchange = f.make(f.target, peer, { peers: () => [owner, missing],
      send: async (to, body) => { if (to === owner) throw Error('channel closed'); f.bus.push({ from: peer, to, body }); } });
    const pending = exchange.fetch(f.plan.policy); await vi.waitFor(() => expect(f.bus.some(p => p.to === missing)).toBe(true));
    while (f.bus.length) { const p = f.bus.shift()!; await (p.from === peer ? replica : exchange).receive(p.from, p.body); }
    expect(await pending).toBeGreaterThan(0);
  });
});
