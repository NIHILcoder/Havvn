import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const system = vi.hoisted(() => ({ locked: false }));
// Test-only authenticated codec. Native safeStorage is covered by the Electron fixture.
vi.mock('./secrets', async () => {
  const { default: c } = await import('node:crypto');
  return {
    encryptSecret: (value: string) => {
      if (system.locked) throw new Error('System storage unavailable');
      const iv = c.randomBytes(12), cipher = c.createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv);
      const body = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    decryptSecretStrict: (value: string) => {
      if (system.locked) throw new Error('System storage unavailable');
      const bytes = Buffer.from(value, 'base64'), decipher = c.createDecipheriv('aes-256-gcm', Buffer.alloc(32, 7), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
    },
  };
});
import { RoomSyncStore, openRoomSyncStore, SYNC_STORE_BYTES, syncLogCommitment, type SyncPersistence } from './room-sync-store';
import type { SyncPolicy, SyncRevision } from '../../shared/room-file-sync';
import { signSyncPolicy, signSyncRevision } from '../sharing/room-sync-proofs';
import { deriveMemberId } from '../sharing/room-crypto';
import { packSyncLog, unpackSyncLog } from './room-sync-log-pack';

const keys = crypto.generateKeyPairSync('ed25519');
const pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const priv = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ownerId = deriveMemberId(pub), entryId = crypto.randomUUID();
const context = { scope: 'shared-room-crypto-context', rootId: crypto.randomUUID(), ownerId, e2e: false };
const p = signSyncPolicy(context.scope, { v: 1, rootId: context.rootId, epoch: 1, parentPolicyId: null,
  ownerId, publisherId: ownerId, name: 'Private folder title', allowDeletes: false, baseHeads: [], pub }, priv);
function revision(changes: Partial<Omit<SyncRevision, 'revisionId' | 'sig'>> = {}) {
  return signSyncRevision(context.scope, { v: 1, rootId: context.rootId, policyId: p.policyId, entryId,
    parents: [], relativePath: 'sensitive-config.ini', op: 'put', blob: { infoHash: 'a'.repeat(40), name: 'sensitive-config.ini', size: 5, enc: false, keyEpoch: null },
    authorId: ownerId, createdAt: 100, pub, ...changes }, priv);
}
class MemoryPersistence implements SyncPersistence {
  data: unknown;
  writes = 0;
  fail = false;
  read() { return structuredClone(this.data); }
  write(value: unknown) { if (this.fail) throw new Error('disk full'); this.writes++; this.data = structuredClone(value); }
}
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sync-index-')); system.locked = false; });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
const open = (backend: MemoryPersistence, room = 'local-room') => new RoomSyncStore(backend, room, context);
function checkpoint(store: RoomSyncStore) {
  const previous = store.policy()!, floor = store.checkpoint(), heads = store.heads().flatMap(h => h.revisionIds.map(revisionId => ({ entryId: h.entryId, revisionId })));
  return signSyncPolicy(context.scope, { v: 4, writers: [ownerId], rootId: context.rootId, epoch: previous.epoch + 1, parentPolicyId: previous.policyId,
    ownerId, publisherId: ownerId, name: previous.name, allowDeletes: false, baseHeads: heads, pub,
    checkpoint: { generation: (floor?.checkpoint?.generation ?? 0) + 1, parentCheckpointId: floor?.policyId ?? null,
      archiveDigest: syncLogCommitment(store.records()), archiveRecords: store.records().length, anchors: heads.map(h => store.revision(h.revisionId)!), origins: [] } }, priv);
}

describe('durable signed file-sync index', () => {
  it('commits both automatic mode flags together and preserves the old mode if persistence fails', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p); store.bind(directory);
    const before = backend.writes;
    store.setAutomaticMode(true, true);
    expect(backend.writes).toBe(before + 1); expect(open(backend).binding()?.autoApply).toBe(true); expect(open(backend).watch().enabled).toBe(true);
    backend.fail = true;
    expect(() => store.setAutomaticMode(false, false)).toThrow('disk full');
    backend.fail = false;
    expect(open(backend).binding()?.autoApply).toBe(true); expect(open(backend).watch().enabled).toBe(true);
  });
  it('persists more than 10,000 genuinely signed versions through an archived checkpoint and verified restart', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p);
    const revisions: SyncRevision[] = [];
    for (let n = 0; n < 10_000; n++) revisions.push(revision({ parents: n ? [revisions[n - 1].revisionId] : [], createdAt: n }));
    store.acceptRecords(revisions.map(value => ({ kind: 'revision', value })));
    const last = revisions.at(-1)!;
    expect(() => store.acceptRevision(revision({ parents: [last.revisionId], createdAt: 20_000 }))).toThrow('full');
    const cut = checkpoint(store); store.acceptPolicy(cut, true);
    const next = revision({ v: 4, policyId: cut.policyId, parents: [last.revisionId], createdAt: 20_001 }); store.acceptRevision(next, true);
    expect(store.records()).toHaveLength(2); expect(store.logSummary().revisions).toBe(2);
    const reopened = open(backend); expect(reopened.records()).toHaveLength(2); expect(reopened.revision(revisions[0].revisionId)).toEqual(revisions[0]);
    expect(reopened.historyRecords().filter(r => r.kind === 'revision')).toHaveLength(10_001);
    const firstPage = reopened.historyPage(entryId, 0, 2); expect(firstPage.items.map(r => r.revisionId)).toEqual([next.revisionId, last.revisionId]); expect(firstPage.more).toBe(true);
    const lastPage = reopened.historyPage(entryId, 10_000, 2); expect(lastPage.items.map(r => r.revisionId)).toEqual([revisions[0].revisionId]); expect(lastPage.more).toBe(false);
    expect(reopened.pendingRecordIds()).toEqual(expect.arrayContaining([cut.policyId, next.revisionId]));
    expect(reopened.heads()[0].revisionIds).toEqual([next.revisionId]);
  }, 60_000);
  it.each([false, true])('keeps complete active and retired epochs across an interrupted checkpoint write (persisted %s)', persisted => {
    const backend = new MemoryPersistence(), store = open(backend); store.bind(directory); store.acceptPolicy(p, true); const a = revision(); store.acceptRevision(a, true, 'a'.repeat(64));
    const b = revision({ parents: [a.revisionId], createdAt: 101 }); store.acceptRevision(b, true, 'b'.repeat(64));
    const cut = checkpoint(store), write = backend.write.bind(backend);
    vi.spyOn(backend, 'write').mockImplementation(value => { if (persisted) write(value); throw new Error('interrupted'); });
    expect(() => store.acceptPolicy(cut, true)).toThrow('interrupted');
    const reopened = open(backend); expect(reopened.revision(a.revisionId)).toEqual(a); expect(reopened.revision(b.revisionId)).toEqual(b);
    expect(reopened.retiredCount()).toBe(persisted ? 1 : 0); expect(reopened.records()).toHaveLength(persisted ? 1 : 3);
    expect(reopened.applied()[0].revisionId).toBe(b.revisionId); expect(reopened.outbox().filter(r => r.kind === 'revision')).toHaveLength(2);
  });
  it('does not commit a checkpoint page whose later record is invalid, and bounds archives without deleting history', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p); const a = revision(); store.acceptRevision(a);
    const cut = checkpoint(store), before = structuredClone(backend.data);
    expect(() => store.acceptRecords([{ kind: 'policy', value: cut }, { kind: 'revision', value: { ...a, createdAt: 999 } }])).toThrow();
    expect(backend.data).toEqual(before); expect(store.policy()?.v).toBe(1);
    for (let n = 0; n < 8; n++) store.acceptPolicy(checkpoint(store), true);
    expect(store.retiredCount()).toBe(8); const head = store.policy()!.policyId;
    expect(() => store.acceptPolicy(checkpoint(store), true)).toThrow('archive capacity'); expect(store.policy()!.policyId).toBe(head);
    expect(open(backend).revision(a.revisionId)).toEqual(a);
    const raw = backend.data as { retired: Array<{ digest: string }> }; raw.retired[0].digest = 'f'.repeat(64);
    expect(() => open(backend)).toThrow(); expect(raw.retired).toHaveLength(8);
  });
  it('compacts losslessly, preserves local consent and outbox, appends a separate tail and replays every signature after reopening', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.bind(directory); store.acceptPolicy(p, true);
    let parent: string | undefined;
    for (let i = 0; i < 30; i++) { const r = revision({ parents: parent ? [parent] : [], createdAt: i }); store.acceptRevision(r, true, 'a'.repeat(64)); parent = r.revisionId; }
    store.setAutoApply(true); store.setAutoPublish(true); store.enqueuePublications(['queued.ini']); store.defer(entryId); store.setExclusions(['*.log']);
    store.retainSource(parent!, { path: path.join(directory, 'snapshot.bin'), metadata: 'AQ==' });
    const records = store.records(), outbox = store.outbox(), applied = store.applied(), epoch = store.bindingEpoch(), plan = store.prepareLogCompaction();
    expect(plan.savedBytes).toBeGreaterThan(plan.summary.storedBytes / 2);
    const compacted = store.compactLog(plan); expect(compacted).toMatchObject({ records: 31, archived: 31, pending: 0 });
    const raw = backend.data as { v: number; archive: unknown; log: unknown[] }; expect(raw.v).toBe(2); expect(raw.log).toEqual([]);
    const reopened = open(backend); expect(reopened.records()).toEqual(records); expect(reopened.outbox()).toEqual(outbox); expect(reopened.applied()).toEqual(applied);
    expect(reopened.binding()).toEqual(store.binding()); expect(reopened.bindingEpoch()).toBe(epoch); expect(reopened.watch()).toEqual(store.watch());
    expect(reopened.sources()).toEqual(store.sources()); expect(reopened.exclusions()).toEqual(['*.log']); expect(reopened.deferred()).toEqual([entryId]);
    const archive = structuredClone(raw.archive), next = revision({ parents: [parent!], createdAt: 1000 }); reopened.acceptRevision(next, true);
    expect((backend.data as typeof raw).archive).toEqual(archive); expect((backend.data as typeof raw).log).toHaveLength(1);
    reopened.acknowledgeMany([p.policyId, parent!]); expect(reopened.outbox()).toHaveLength(outbox.length - 1);
    const again = open(backend); expect(again.records()).toEqual([...records, { kind: 'revision', value: next }]); expect(again.heads()[0].revisionIds).toEqual([next.revisionId]);
    again.compactLog(again.prepareLogCompaction()); expect(open(backend).logSummary()).toMatchObject({ records: 32, archived: 32, pending: 0 });
  });
  it('refuses stale compaction previews and does not write when there is no additional saving', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p); const a = revision(); store.acceptRevision(a);
    const stale = store.prepareLogCompaction(); store.acceptRevision(revision({ parents: [a.revisionId], createdAt: 101 }));
    expect(() => store.compactLog(stale)).toThrow('changed'); store.compactLog(store.prepareLogCompaction());
    const writes = backend.writes, summary = store.logSummary(); expect(() => store.compactLog(store.prepareLogCompaction())).toThrow('no storage saving');
    expect(backend.writes).toBe(writes); expect(store.logSummary()).toEqual(summary);
  });
  it.each([false, true])('recovers a complete old or new snapshot after an uncertain compaction write (persisted %s)', persisted => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p, true); store.acceptRevision(revision(), true);
    const records = store.records(), outbox = store.outbox(), write = backend.write.bind(backend);
    vi.spyOn(backend, 'write').mockImplementation(value => { if (persisted) write(value); throw new Error('interrupted write'); });
    expect(() => store.compactLog(store.prepareLogCompaction())).toThrow('interrupted'); expect(() => store.records()).toThrow('reopen');
    const reopened = open(backend); expect(reopened.records()).toEqual(records); expect(reopened.outbox()).toEqual(outbox);
    expect(reopened.logSummary().archived).toBe(persisted ? 2 : 0);
  });
  it('rejects archive corruption, forged signed content, lost parents and overlap with the tail without silently resetting', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p); const a = revision(); store.acceptRevision(a);
    store.acceptRevision(revision({ parents: [a.revisionId], createdAt: 101 })); store.compactLog(store.prepareLogCompaction());
    const original = structuredClone(backend.data) as { v: number; archive: ReturnType<typeof packSyncLog>; log: unknown[] };
    for (const kind of ['digest', 'signature', 'parent', 'duplicate', 'version'] as const) {
      const changed = structuredClone(original), records = unpackSyncLog(changed.archive);
      if (kind === 'digest') changed.archive.digest = 'f'.repeat(64);
      if (kind === 'signature') { (records[1].value as SyncRevision).createdAt++; changed.archive = packSyncLog(records); }
      if (kind === 'parent') { records.splice(1, 1); changed.archive = packSyncLog(records); }
      if (kind === 'duplicate') changed.log = [records[0]];
      if (kind === 'version') changed.v = 1;
      backend.data = changed; expect(() => open(backend)).toThrow(); expect(backend.data).toEqual(changed);
    }
    backend.data = original; expect(open(backend).records()).toEqual(store.records());
  });
  it('migrates exclusions, persists local rules, revokes old disk authority and removes excluded pending work without losing applied fingerprints', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.bind(directory); store.acceptPolicy(p); const r = revision(); store.acceptRevision(r); store.markApplied(entryId, r.revisionId, 'a'.repeat(64));
    delete (backend.data as Record<string, unknown>).exclusions;
    const migrated = open(backend); expect(migrated.exclusions()).toEqual([]); const epoch = migrated.bindingEpoch();
    migrated.enqueuePublications(['config.ini', 'debug.log']); migrated.setExclusions(['*.log']);
    expect(migrated.bindingEpoch()).toBe(epoch + 1); expect(migrated.applied()).toEqual(store.applied()); expect(migrated.watch().pending).toEqual(['config.ini']);
    expect(open(backend).exclusions()).toEqual(['*.log']); const copy = migrated.exclusions(); copy.push('**'); expect(migrated.exclusions()).toEqual(['*.log']);
    migrated.setExclusions(['*.log']); expect(migrated.bindingEpoch()).toBe(epoch + 1);
    migrated.bind(directory); expect(migrated.exclusions()).toEqual([]);
  });
  it('rejects malformed or unbound persisted exclusions and never installs rules after a failed write', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.bind(directory);
    for (const value of [null, '../file', ['../file'], ['a', 'A']]) { (backend.data as Record<string, unknown>).exclusions = value; expect(() => open(backend)).toThrow(); }
    (backend.data as Record<string, unknown>).exclusions = [];
    backend.fail = true; expect(() => store.setExclusions(['*.log'])).toThrow('disk full'); backend.fail = false;
    expect(open(backend).exclusions()).toEqual([]);
    const restored = open(backend); restored.bind(null); (backend.data as Record<string, unknown>).exclusions = ['*.log']; expect(() => open(backend)).toThrow();
  });
  it('migrates backup settings with automatic cleanup off, persists limits and resets consent on rebinding', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.bind(directory);
    delete (backend.data as Record<string, unknown>).backups;
    const migrated = open(backend); expect(migrated.backupPolicy()).toEqual({ enabled: false, keepVersions: 10, maxAgeDays: 30, limitBytes: 1024 ** 3 });
    const policy = { enabled: true, keepVersions: 3, maxAgeDays: 0, limitBytes: 0 };
    migrated.setBackupPolicy(policy); expect(open(backend).backupPolicy()).toEqual(policy);
    migrated.bind(null); expect(open(backend).backupPolicy()).toEqual({ ...policy, enabled: false });
    expect(() => migrated.setBackupPolicy(policy)).toThrow();
  });
  it.each([null, {}, { enabled: 'yes', keepVersions: 10, maxAgeDays: 30, limitBytes: 0 },
    { enabled: false, keepVersions: 0, maxAgeDays: 30, limitBytes: 0 }, { enabled: false, keepVersions: 1, maxAgeDays: -1, limitBytes: 0 },
    { enabled: false, keepVersions: 1, maxAgeDays: 30, limitBytes: 0.1 }, { enabled: false, keepVersions: 1, maxAgeDays: 30, limitBytes: 0, path: 'injected' }])('rejects malformed backup policy %j in a stored snapshot', bad => {
    const backend = new MemoryPersistence(), store = open(backend); store.bind(directory);
    expect(() => store.setBackupPolicy(bad as never)).toThrow('Invalid');
    (backend.data as Record<string, unknown>).backups = bad; expect(() => open(backend)).toThrow();
  });
  it('migrates absent deferrals, persists a per-file pause and clears it only on explicit resolution or rebinding', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.bind(directory); store.acceptPolicy(p); const r = revision(); store.acceptRevision(r);
    delete (backend.data as Record<string, unknown>).deferred;
    const restored = open(backend); expect(restored.deferred()).toEqual([]);
    restored.defer(entryId); restored.defer(entryId); expect(open(backend).deferred()).toEqual([entryId]);
    restored.markApplied(entryId, r.revisionId, 'a'.repeat(64)); expect(restored.deferred()).toEqual([entryId]);
    restored.markApplied(entryId, r.revisionId, 'a'.repeat(64), true); expect(open(backend).deferred()).toEqual([]);
    restored.defer(entryId); restored.bind(null); expect(open(backend).deferred()).toEqual([]);
    expect(() => restored.defer(entryId)).toThrow();
  });
  it('refuses malformed deferred IDs rather than silently resuming writes', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.bind(directory); store.acceptPolicy(p); store.acceptRevision(revision());
    (backend.data as Record<string, unknown>).deferred = ['unknown']; expect(() => open(backend)).toThrow('deferred');
    (backend.data as Record<string, unknown>).deferred = [entryId, entryId]; expect(() => open(backend)).toThrow('deferred');
    (backend.data as Record<string, unknown>).deferred = null; expect(() => open(backend)).toThrow('deferred');
  });
  it('migrates the default cache limit, persists zero and refuses invalid quota snapshots', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p);
    delete (backend.data as Record<string, unknown>).cacheLimitBytes;
    const migrated = open(backend); expect(migrated.cacheLimit()).toBe(512 * 1024 * 1024);
    migrated.setCacheLimit(0); expect(open(backend).cacheLimit()).toBe(0);
    expect(() => migrated.setCacheLimit(-1)).toThrow('Invalid');
    (backend.data as Record<string, unknown>).cacheLimitBytes = 'unlimited';
    expect(() => open(backend)).toThrow('snapshot');
  });
  it('persists a local publication queue, removes committed paths atomically and disables it on rebinding', () => {
    const backend = new MemoryPersistence(), store = open(backend);
    store.bind(directory); store.acceptPolicy(p); store.setAutoPublish(true);
    store.enqueuePublications(['sensitive-config.ini']); store.enqueuePublications(['sensitive-config.ini']);
    expect(open(backend).watch()).toEqual({ enabled: true, pending: ['sensitive-config.ini'] });
    store.acceptRevision(revision(), true, 'a'.repeat(64));
    expect(open(backend).watch()).toEqual({ enabled: true, pending: [] });
    store.enqueuePublications(['next.ini']); store.bind(null);
    expect(open(backend).watch()).toEqual({ enabled: false, pending: [] });
    expect(() => store.enqueuePublications(['next.ini'])).toThrow('Invalid');
  });
  it('migrates an absent index without enabling a binding or touching existing storage', () => {
    const backend = new MemoryPersistence(), store = open(backend);
    expect(store.policy()).toBeNull(); expect(store.heads()).toEqual([]); expect(store.binding()).toBeNull();
    expect(store.outbox()).toEqual([]); expect(backend.writes).toBe(0);
  });

  it('persists a revision and its outbox entry in the same write before returning', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p, true);
    const a = revision(); store.acceptRevision(a, true);
    expect(backend.writes).toBe(2);
    const restarted = open(backend);
    expect(restarted.outbox()).toEqual([{ kind: 'policy', value: p }, { kind: 'revision', value: a }]);
    expect(restarted.heads()).toEqual([{ entryId, revisionIds: [a.revisionId] }]);
    restarted.acknowledge(p.policyId);
    expect(open(backend).outbox()).toEqual([{ kind: 'revision', value: a }]);
  });

  it('does not acknowledge outbox entries which have not been explicitly confirmed', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p, true);
    store.acknowledge('f'.repeat(64));
    expect(backend.writes).toBe(1); expect(store.outbox()).toHaveLength(1);
  });

  it('does not echo remote arrivals or create duplicate log records', () => {
    const backend = new MemoryPersistence(), store = open(backend), a = revision();
    store.acceptPolicy(p); store.acceptRevision(a);
    expect(store.acceptRevision(a)).toBe('duplicate'); expect(store.acceptPolicy(p)).toBe('duplicate');
    expect(store.outbox()).toEqual([]); expect(backend.writes).toBe(2);
    expect(open(backend).heads()).toEqual(store.heads());
  });

  it('requires reopening after an uncertain write and never publishes uncommitted in-memory heads', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p);
    backend.fail = true;
    expect(() => store.acceptRevision(revision(), true)).toThrow('disk full');
    expect(() => store.heads()).toThrow('reopen'); expect(() => store.acceptRevision(revision())).toThrow('reopen');
    backend.fail = false;
    expect(open(backend).heads()).toEqual([]); expect(open(backend).outbox()).toEqual([]);
  });

  it('retains the outbox entry when acknowledging it fails to persist', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p, true); backend.fail = true;
    expect(() => store.acknowledge(p.policyId)).toThrow('disk full');
    backend.fail = false; expect(open(backend).outbox()).toHaveLength(1);
  });

  it('re-verifies proofs on load rather than trusting derived heads or stored descriptors', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p); store.acceptRevision(revision());
    const data = backend.data as { log: Array<{ value: SyncRevision }> };
    data.log[1].value.blob!.infoHash = 'b'.repeat(40);
    expect(() => open(backend)).toThrow('proof');
    expect(backend.writes).toBe(2);
  });

  it('rejects reordered or duplicate signed log records', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p); store.acceptRevision(revision());
    const good = structuredClone(backend.data);
    (backend.data as { log: unknown[] }).log.reverse(); expect(() => open(backend)).toThrow();
    backend.data = good;
    (backend.data as { log: unknown[] }).log.push(structuredClone((backend.data as { log: unknown[] }).log[1]));
    expect(() => open(backend)).toThrow('Duplicate');
  });

  it('rejects unknown schema versions and contexts without resetting their data', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p);
    expect(() => new RoomSyncStore(backend, 'different-local-room', context)).toThrow('incompatible');
    expect(() => new RoomSyncStore(backend, 'local-room', { ...context, scope: 'other-room' })).toThrow('incompatible');
    (backend.data as { v: number }).v = 99;
    expect(() => open(backend)).toThrow('incompatible'); expect((backend.data as { v: number }).v).toBe(99);
  });

  it('does not accept forged outbox references or duplicate applied entries', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p);
    (backend.data as { outbox: string[] }).outbox.push('a'.repeat(64));
    expect(() => open(backend)).toThrow('outbox');
  });

  it('enables writes only through an explicit local binding and resets them on rebinding', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p); const a = revision(); store.acceptRevision(a);
    expect(() => store.setAutoApply(true)).toThrow('binding');
    const local = path.join(directory, 'working'); store.bind(local);
    expect(store.binding()).toEqual({ path: local, autoApply: false });
    store.setAutoApply(true); store.markApplied(entryId, a.revisionId, 'd'.repeat(64));
    const restarted = open(backend); expect(restarted.binding()?.autoApply).toBe(true); expect(restarted.applied()).toHaveLength(1);
    restarted.bind(path.join(directory, 'different'));
    expect(restarted.binding()?.autoApply).toBe(false); expect(restarted.applied()).toEqual([]);
    restarted.bind(null); expect(open(backend).binding()).toBeNull();
  });

  it('will not mark unknown or inconsistent bytes as applied', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p); const a = revision(); store.acceptRevision(a);
    expect(() => store.markApplied(entryId, a.revisionId, 'd'.repeat(64))).toThrow();
    store.bind(directory);
    expect(() => store.markApplied(entryId, 'f'.repeat(64), 'd'.repeat(64))).toThrow();
    expect(() => store.markApplied(entryId, a.revisionId, null)).toThrow();
    expect(store.applied()).toEqual([]);
  });

  it('does not expose mutable references to saved proofs, bindings or outbox records', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p, true); store.bind(directory);
    store.policy()!.name = 'changed'; (store.outbox()[0].value as SyncPolicy).baseHeads.push({ entryId, revisionId: 'a'.repeat(64) });
    store.binding()!.path = 'changed';
    expect(store.policy()).toEqual(p); expect(store.binding()?.path).toBe(directory); expect(open(backend).outbox()[0].value).toEqual(p);
  });

  it('retains source references only for accepted content and protects their ownership', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p); const a = revision(); store.acceptRevision(a);
    const source = { path: path.join(directory, 'snapshot.ini'), metadata: Buffer.from('torrent metadata').toString('base64') };
    expect(() => store.retainSource('f'.repeat(64), source)).toThrow();
    store.retainSource(a.revisionId, source);
    store.sources()[0].path = 'changed';
    expect(open(backend).sources()).toEqual([{ revisionId: a.revisionId, ...source }]);
    expect(() => store.retainSource(a.revisionId, { ...source, metadata: 'not base64!' })).toThrow();
  });

  it('caps the stored payload before replaying an oversized snapshot', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p);
    (backend.data as Record<string, unknown>).padding = 'x'.repeat(SYNC_STORE_BYTES);
    expect(() => open(backend)).toThrow('incompatible');
  });

  it('restores forks and policy changes in causal order', () => {
    const backend = new MemoryPersistence(), store = open(backend); store.acceptPolicy(p); const a = revision(); store.acceptRevision(a);
    const b = revision({ parents: [a.revisionId], createdAt: 200 }), c = revision({ parents: [a.revisionId], createdAt: 300 });
    store.acceptRevision(b); store.acceptRevision(c);
    expect(open(backend).heads()[0].revisionIds).toEqual([b.revisionId, c.revisionId].sort());
    const next = signSyncPolicy(context.scope, { ...p, epoch: 2, parentPolicyId: p.policyId, baseHeads: [{ entryId, revisionId: b.revisionId }] }, priv);
    store.acceptPolicy(next);
    expect(open(backend).heads()[0].revisionIds).toEqual([b.revisionId]);
    expect(open(backend).revision(c.revisionId)).toEqual(c);
  });
});

describe('protected atomic index files', () => {
  it('round-trips real electron-store files without plaintext names, paths or context', () => {
    const store = openRoomSyncStore(directory, 'local-room', context); store.acceptPolicy(p, true); store.acceptRevision(revision(), true); store.bind(path.join(directory, 'private-working-folder'));
    const saved = fs.readFileSync(path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json'))!), 'utf8');
    for (const secret of ['Private folder title', 'sensitive-config.ini', 'private-working-folder', context.scope, priv]) expect(saved).not.toContain(secret);
    const restarted = openRoomSyncStore(directory, 'local-room', context);
    expect(restarted.heads()).toEqual(store.heads()); expect(restarted.outbox()).toEqual(store.outbox()); expect(restarted.binding()).toEqual(store.binding());
  });

  it('fails closed if system encryption becomes unavailable', () => {
    const store = openRoomSyncStore(directory, 'local-room', context); store.acceptPolicy(p);
    const filename = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json'))!);
    const before = fs.readFileSync(filename);
    system.locked = true;
    expect(() => store.acceptRevision(revision())).toThrow('unavailable');
    expect(() => openRoomSyncStore(directory, 'local-room', context)).toThrow('unavailable');
    expect(fs.readFileSync(filename)).toEqual(before);
  });

  it('preserves a malformed storage file rather than silently creating an empty index', () => {
    const store = openRoomSyncStore(directory, 'local-room', context); store.acceptPolicy(p);
    const filename = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json'))!);
    fs.writeFileSync(filename, '{broken json');
    expect(() => openRoomSyncStore(directory, 'local-room', context)).toThrow();
    expect(fs.readFileSync(filename, 'utf8')).toBe('{broken json');
  });

  it('binds a protected file to its local room even if ciphertext is copied', () => {
    const first = openRoomSyncStore(directory, 'local-room', context); first.acceptPolicy(p);
    const sourceFile = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json'))!);
    const copiedName = 'room-sync-' + crypto.createHash('sha256').update(JSON.stringify(['different-room', context.rootId])).digest('hex') + '.json';
    fs.copyFileSync(sourceFile, path.join(directory, copiedName));
    expect(() => openRoomSyncStore(directory, 'different-room', context)).toThrow('incompatible');
  });
});
