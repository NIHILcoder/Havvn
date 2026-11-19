import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db/secrets', () => ({ encryptSecret: () => { throw new Error('Memory persistence only'); }, decryptSecretStrict: () => { throw new Error('Memory persistence only'); } }));
import { RoomSyncStore, syncLogCommitment, type SyncMetadataBundle, type SyncPersistence } from '../db/room-sync-store';
import { signSyncPolicy, signSyncRevision } from './room-sync-proofs';
import { deriveMemberId } from './room-crypto';
import { RoomSyncSession } from './room-sync-session';
import { RoomSyncApplier } from './room-sync-apply';
import { RoomSyncTrash } from './room-sync-trash';
import { inspectMetadataRecovery, metadataRecoveryValid, readSyncHistoryExport, writeSyncHistoryExport } from './room-sync-metadata';
import { packSyncLog, unpackSyncLog } from '../db/room-sync-log-pack';
import { openRoomBackup } from '../db/room-backup';

const keys = crypto.generateKeyPairSync('ed25519'), pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const priv = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), ownerId = deriveMemberId(pub);
class Persistence implements SyncPersistence {
  data: unknown; fail = false;
  read() { return structuredClone(this.data); }
  write(value: unknown) { if (this.fail) throw new Error('Disk full'); this.data = structuredClone(value); }
}
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sync-metadata-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
function fixture(epochs = 3, publish = false) {
  const context = { scope: 'metadata-room-context', rootId: crypto.randomUUID(), ownerId, e2e: false }, persistence = new Persistence();
  const store = new RoomSyncStore(persistence, 'local-room', context), entryId = crypto.randomUUID();
  store.acceptPolicy(signSyncPolicy(context.scope, { v: 6, writers: [ownerId], rootId: context.rootId, epoch: 1, parentPolicyId: null,
    ownerId, publisherId: ownerId, name: 'Sensitive history', allowDeletes: true, baseHeads: [], pub }, priv), publish);
  const versions = [];
  for (let i = 0; i <= epochs; i++) {
    const previous = store.heads()[0]?.revisionIds ?? [], policy = store.policy()!;
    const revision = signSyncRevision(context.scope, { v: 6, rootId: context.rootId, policyId: policy.policyId, entryId, parents: previous,
      relativePath: 'private.ini', op: 'put', blob: { infoHash: 'a'.repeat(40), name: 'private.ini', size: 4, enc: false, keyEpoch: null }, authorId: ownerId, createdAt: i, pub }, priv);
    store.acceptRevision(revision, publish); versions.push(revision);
    if (i === epochs) break;
    const heads = store.heads().flatMap(h => h.revisionIds.map(revisionId => ({ entryId: h.entryId, revisionId })));
    store.acceptPolicy(signSyncPolicy(context.scope, { ...policy, epoch: policy.epoch + 1, parentPolicyId: policy.policyId, baseHeads: heads,
      checkpoint: { generation: i + 1, parentCheckpointId: store.checkpoint()?.policyId ?? null, archiveDigest: syncLogCommitment(store.records()),
        archiveRecords: store.records().length, anchors: heads.map(h => store.revision(h.revisionId)!), origins: [] } }, priv), publish);
  }
  const session = new RoomSyncSession({ context, store, storage: path.join(directory, 'bytes'), identity: { pub, priv }, isCurrent: () => true });
  return { context, persistence, store, session, versions, entryId };
}
it('exports metadata without local paths or keys and restores pruned epochs without changing active heads or consent', () => {
  const f = fixture(), bundle = f.store.metadataBundle(), active = f.store.records(), policy = f.store.policy(), heads = f.store.heads();
  expect(JSON.stringify(bundle)).not.toContain(directory); expect(JSON.stringify(bundle)).not.toContain('local-room'); expect(JSON.stringify(bundle)).not.toContain('sources');
  const plan = f.store.prepareMetadata(0); expect(plan.remove).toHaveLength(3); expect(plan.afterBytes).toBeLessThan(plan.beforeBytes);
  f.store.confirmMetadata(plan); expect(f.store.retiredCount()).toBe(0); expect(f.store.revision(f.versions[0].revisionId)).toBeUndefined();
  const reopened = new RoomSyncStore(f.persistence, 'local-room', f.context); expect(reopened.records()).toEqual(active);
  expect(reopened.importMetadata(bundle)).toBeGreaterThan(0); expect(reopened.revision(f.versions[0].revisionId)).toEqual(f.versions[0]);
  expect(reopened.policy()).toEqual(policy); expect(reopened.heads()).toEqual(heads); expect(reopened.binding()).toBeNull(); expect(reopened.pendingRecordIds()).toEqual([]);
  expect(reopened.importMetadata(bundle)).toBe(0); expect(new RoomSyncStore(f.persistence, 'local-room', f.context).historyPage(f.entryId, 0).items).toHaveLength(4);
});
it('keeps the newest epochs and protects queued records, local sources, applied bases and open previews', () => {
  const f = fixture(); expect(f.store.prepareMetadata(2).remove).toHaveLength(1);
  f.store.bind(directory); f.store.markApplied(f.entryId, f.versions[0].revisionId, 'a'.repeat(64));
  const p = f.store.prepareMetadata(0); expect(p.epochs.some(e => e.reason === 'applied')).toBe(true); f.store.confirmMetadata(p);
  expect(f.store.revision(f.versions[0].revisionId)).toBeDefined();
  const g = fixture(); g.store.retainSource(g.versions[0].revisionId, { path: path.join(directory, 'cached'), metadata: 'YQ==' });
  expect(g.store.prepareMetadata(0).epochs.some(e => e.reason === 'source')).toBe(true);
  const h = fixture(); const preview = h.store.prepareMetadata(0, undefined, [h.versions[0].revisionId]); expect(preview.epochs.some(e => e.reason === 'recovery')).toBe(true);
  const queued = fixture(3, true), queuedPlan = queued.store.prepareMetadata(0);
  expect(queuedPlan.remove).toHaveLength(0); expect(queuedPlan.epochs.every(e => e.reason === 'pending')).toBe(true);
  queued.store.acknowledgeMany(queued.store.pendingRecordIds()); expect(queued.store.prepareMetadata(0).remove).toHaveLength(3);
});
it('preserves downloaded proof dependencies and can reload a downloaded archive after cleanup', () => {
  const f = fixture(), receiver = new RoomSyncStore(new Persistence(), 'receiver', f.context); receiver.acceptRecords(f.store.records());
  for (let i = 0; i < 3; i++) { const cp = receiver.nextHistoryCheckpoint()!; receiver.importHistory(cp.policyId, f.store.exportHistory(cp.checkpoint!.archiveDigest)!); }
  const bundle = receiver.metadataBundle(); receiver.retainSource(f.versions[0].revisionId, { path: path.join(directory, 'cached'), metadata: 'YQ==' });
  const protectedPlan = receiver.prepareMetadata(0); expect(protectedPlan.epochs.some(e => e.reason === 'source')).toBe(true); expect(protectedPlan.epochs.some(e => e.reason === 'chain')).toBe(true);
  receiver.forgetSources([f.versions[0].revisionId]); const plan = receiver.prepareMetadata(0); expect(plan.remove).toHaveLength(3); receiver.confirmMetadata(plan);
  expect(receiver.importedHistoryCount()).toBe(0); expect(receiver.importMetadata(bundle)).toBeGreaterThan(0); expect(receiver.historyPage(f.entryId, 0).items).toHaveLength(4);
});
it('rejects stale cleanup, changed protection and uncertain writes without damaging the original snapshot', () => {
  const f = fixture(), plan = f.store.prepareMetadata(0); f.store.setCacheLimit(0); expect(() => f.store.confirmMetadata(plan)).toThrow('changed');
  const fresh = f.store.prepareMetadata(0); expect(() => f.store.confirmMetadata(fresh, () => false)).toThrow('protection');
  f.persistence.fail = true; expect(() => f.store.confirmMetadata(fresh)).toThrow('Disk full'); expect(() => f.store.records()).toThrow('reopen');
  f.persistence.fail = false; expect(new RoomSyncStore(f.persistence, 'local-room', f.context).retiredCount()).toBe(3);
});
it('rejects foreign, oversized, malformed and forged archives atomically', () => {
  const f = fixture(), bundle = f.store.metadataBundle(); f.store.confirmMetadata(f.store.prepareMetadata(0)); const before = structuredClone(f.persistence.data);
  const foreign = { ...bundle, context: { ...bundle.context, scope: 'another room' } }; expect(() => f.store.importMetadata(foreign)).toThrow('foreign');
  const forged = structuredClone(bundle), records = unpackSyncLog(forged.retired[0]); records[1].value.pub = 'fake'; forged.retired[0] = packSyncLog(records);
  expect(() => f.store.importMetadata(forged)).toThrow();
  for (const change of [null, { ...bundle, localPath: directory }, { ...bundle, retired: Array(9).fill(bundle.retired[0]) }, { ...bundle, active: { ...bundle.active, bytes: 100 * 1024 ** 2 } }]) expect(() => f.store.importMetadata(change)).toThrow();
  expect(f.persistence.data).toEqual(before);
  const extended = structuredClone(bundle), unsigned = unpackSyncLog(extended.retired[0]);
  (unsigned[1].value as unknown as Record<string, unknown>).localPath = directory; extended.retired[0] = packSyncLog(unsigned);
  f.store.importMetadata(extended); expect(JSON.stringify(f.store.metadataBundle())).not.toContain(directory);
});
it('encrypts export bytes, requires the password and never overwrites an existing file', async () => {
  const f = fixture(), password = 'a fixture password 123', exported = await f.session.exportMetadata(password), file = path.join(directory, 'history.havvn-history');
  expect(exported.ciphertext).not.toContain('Sensitive history'); expect(exported.ciphertext).not.toContain('private.ini');
  await writeSyncHistoryExport(file, exported.ciphertext); expect(await readSyncHistoryExport(file)).toBe(exported.ciphertext);
  await expect(writeSyncHistoryExport(file, 'replace')).rejects.toThrow('already exists');
  await expect(openRoomBackup(exported.ciphertext, 'wrong password long enough')).rejects.toThrow('Incorrect password');
  const plain = await openRoomBackup(exported.ciphertext, password) as SyncMetadataBundle; expect(plain.format).toBe('havvn-file-sync-history');
  f.store.confirmMetadata(f.store.prepareMetadata(0)); expect(await f.session.importMetadata(exported.ciphertext, password)).toBeGreaterThan(0);
});
it('pins verified disk operations even after backup bytes are removed and refuses a changed disk preview', async () => {
  const f = fixture(), work = path.join(directory, 'work'); fs.mkdirSync(work); f.store.bind(work);
  const source = path.join(directory, 'source'); fs.writeFileSync(source, 'test'); const digest = crypto.createHash('sha256').update('test').digest('hex');
  await new RoomSyncApplier(work).apply({ source, relativePath: 'private.ini', revisionId: f.versions[0].revisionId, digest, expectedDigest: null });
  const proofs = await inspectMetadataRecovery(f.store), plan = await f.session.prepareMetadata(0); expect(proofs.apply).toHaveLength(1);
  expect(plan.plan.epochs.some(e => e.reason === 'recovery')).toBe(true);
  const operation = path.join(work, '.havvn-sync/transactions', fs.readdirSync(path.join(work, '.havvn-sync/transactions'))[0], 'receipt.json');
  fs.appendFileSync(operation, ' '); await expect(f.session.confirmMetadata(plan.plan, plan.recoveryStamp)).rejects.toThrow('recovery changed');
  const validate = (candidate: Parameters<typeof metadataRecoveryValid>[0]) => metadataRecoveryValid(candidate, proofs);
  f.store.confirmMetadata(f.store.prepareMetadata(0, validate), validate); expect(f.store.revision(f.versions[0].revisionId)).toBeDefined();
  await new RoomSyncApplier(work).recover(j => !!f.store.revision(j.revisionId)); expect(fs.readFileSync(path.join(work, 'private.ini'), 'utf8')).toBe('test');
});
it('preserves trash proof ancestry and blocks cleanup on unknown or unavailable recovery paths', async () => {
  const f = fixture(2), work = path.join(directory, 'work'); fs.mkdirSync(work); f.store.bind(work); fs.writeFileSync(path.join(work, 'private.ini'), 'test');
  const base = f.versions[0], deleted = signSyncRevision(f.context.scope, { ...f.versions[2], op: 'delete', blob: null, parents: [f.versions[2].revisionId] }, priv); f.store.acceptRevision(deleted);
  const digest = crypto.createHash('sha256').update('test').digest('hex');
  await new RoomSyncTrash(work).remove({ v: 1, revisionId: deleted.revisionId, baseRevisionId: base.revisionId, relativePath: 'private.ini', expectedDigest: digest }, () => true, () => true);
  const proofs = await inspectMetadataRecovery(f.store); expect(proofs.trash).toHaveLength(1); const plan = await f.session.prepareMetadata(0); expect(plan.plan.epochs.some(e => e.reason === 'recovery')).toBe(true);
  fs.writeFileSync(path.join(work, '.havvn-sync/trash', 'unexpected'), 'keep'); await expect(inspectMetadataRecovery(f.store)).rejects.toThrow('unknown');
  fs.renameSync(work, work + '-unavailable'); await expect(inspectMetadataRecovery(f.store)).rejects.toThrow();
});
it('preserves ancestry between old disk receipts and an applied version in a retired epoch', async () => {
  const f = fixture(5), work = path.join(directory, 'work'), source = path.join(directory, 'source'); fs.mkdirSync(work); fs.writeFileSync(source, 'test');
  f.store.bind(work); const digest = crypto.createHash('sha256').update('test').digest('hex'), applier = new RoomSyncApplier(work);
  await applier.apply({ source, relativePath: 'private.ini', revisionId: f.versions[0].revisionId, digest, expectedDigest: null });
  await applier.apply({ source, relativePath: 'private.ini', revisionId: f.versions[3].revisionId, digest, expectedDigest: digest });
  f.store.markApplied(f.entryId, f.versions[3].revisionId, digest);
  const preview = await f.session.prepareMetadata(0); expect(preview.plan.epochs.some(e => e.reason === 'recovery')).toBe(true);
  await f.session.confirmMetadata(preview.plan, preview.recoveryStamp); await expect(f.session.recoverApplied()).resolves.toBeDefined();
  expect(f.store.applied()[0].revisionId).toBe(f.versions[3].revisionId); expect(fs.readFileSync(path.join(work, 'private.ini'), 'utf8')).toBe('test');
});
it('keeps proof ancestry for a signed deletion that is still waiting to reach disk', async () => {
  const f = fixture(5), work = path.join(directory, 'work'); fs.mkdirSync(work); fs.writeFileSync(path.join(work, 'private.ini'), 'test'); f.store.bind(work);
  const digest = crypto.createHash('sha256').update('test').digest('hex'); f.store.markApplied(f.entryId, f.versions[0].revisionId, digest);
  const deleted = signSyncRevision(f.context.scope, { ...f.versions[5], op: 'delete', blob: null, parents: [f.versions[5].revisionId] }, priv); f.store.acceptRevision(deleted); f.store.setAutoApply(true);
  const preview = await f.session.prepareMetadata(0); expect(preview.plan.epochs.some(e => e.reason === 'recovery')).toBe(true);
  if (preview.plan.remove.length) await f.session.confirmMetadata(preview.plan, preview.recoveryStamp);
  await f.session.confirmDelete(await f.session.prepareDelete(f.entryId, true)); expect(fs.existsSync(path.join(work, 'private.ini'))).toBe(false);
  await expect(f.session.recoverApplied()).resolves.toBeDefined();
});
