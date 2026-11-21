import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db/secrets', () => ({ encryptSecret: () => { throw new Error('fixture'); }, decryptSecretStrict: () => { throw new Error('fixture'); } }));
import { RoomSyncStore } from '../db/room-sync-store';
import { RoomSyncSession } from './room-sync-session';
import { RoomSyncTrash } from './room-sync-trash';
import { confirmSyncTrash, type SyncTrashPruneStep, type SyncTrashRetentionOptions } from './room-sync-trash-retention';
import { deriveMemberId } from './room-crypto';
import { authorizedSyncTrashJournal } from './room-sync-apply-auth';
import { inspectMetadataRecovery } from './room-sync-metadata';
import { generateRoomSecret } from './room-e2e';
import { contentKeyEpoch } from './room-keyring';
import { signSyncRevision } from './room-sync-proofs';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-trash-retention-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
async function fixture(e2e = false, deleted = true) {
  const keys = crypto.generateKeyPairSync('ed25519'), identity = {
    pub: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const self = deriveMemberId(identity.pub), context = { rootId: crypto.randomUUID(), scope: 'trash-fixture', ownerId: self, e2e };
  let data: unknown;
  const store = new RoomSyncStore({ read: () => structuredClone(data), write: v => { data = structuredClone(v); } }, 'local', context);
  const folder = path.join(directory, 'working'); fs.mkdirSync(folder); store.bind(folder);
  const secret = e2e ? generateRoomSecret() : undefined;
  const session = new RoomSyncSession({ context, store, storage: path.join(directory, 'storage'), identity, isCurrent: () => true,
    contentSecret: () => secret!, resolveSecret: epoch => secret && epoch === contentKeyEpoch(secret) ? secret : undefined });
  session.createRoot('Fixture'); await session.changeWriters([self], session.rightsStamp(), true, true);
  const entries = [];
  for (const name of ['a.ini', 'b.ini']) {
    fs.writeFileSync(path.join(folder, name), 'body ' + name); const { revision } = await session.publish(name); entries.push(revision);
    if (deleted) await session.confirmDelete(await session.prepareDelete(revision.entryId));
  }
  store.acknowledgeMany(store.pendingRecordIds());
  const options = (session as unknown as { trashRetentionOptions(): SyncTrashRetentionOptions }).trashRetentionOptions();
  const trash = new RoomSyncTrash(folder), base = path.join(folder, '.havvn-sync', 'trash');
  const recover = () => trash.recover(j => authorizedSyncTrashJournal(store, j));
  return { store, session, folder, base, options, entries, recover, context, identity, self };
}
it.each([false, true])('cleans only reviewed duplicate bytes, keeps receipts and restores from verified content (E2E %s)', async e2e => {
  const f = await fixture(e2e), initial = await f.session.trashPreview(); expect(initial.summary.copies).toBe(2); expect(initial.selected).toHaveLength(0);
  expect(initial.rows.every(r => r.eligible)).toBe(true);
  const selected = initial.rows[0], plan = await f.session.trashPreview([selected.operationId]), before = initial.summary.bytes;
  expect(await f.session.trashConfirm(plan)).toMatchObject({ removedCopies: 1, removedBytes: selected.size });
  expect(fs.existsSync(path.join(f.base, selected.operationId, 'previous'))).toBe(false);
  expect(fs.readdirSync(path.join(f.base, selected.operationId)).sort()).toEqual(['journal.json', 'receipt.json']);
  const after = await f.session.trashPreview(); expect(after.summary.bytes).toBe(before - selected.size); expect(after.summary.copies).toBe(1);
  await f.recover(); await expect(inspectMetadataRecovery(f.store)).resolves.toHaveProperty('stamp');
  const entry = f.entries.find(e => e.relativePath === selected.path)!;
  const restore = await f.session.prepareRestore(entry.revisionId); await f.session.restoreRevision(restore);
  expect(fs.readFileSync(path.join(f.folder, entry.relativePath), 'utf8')).toBe('body ' + entry.relativePath);
});
it('rejects stale payloads, changed bindings and empty selections before deleting anything', async () => {
  const f = await fixture(), first = (await f.session.trashPreview()).rows[0], plan = await f.session.trashPreview([first.operationId]);
  fs.writeFileSync(path.join(f.base, first.operationId, 'previous'), 'late bytes');
  await expect(f.session.trashConfirm(plan)).rejects.toThrow('changed');
  expect((await f.session.trashPreview()).rows.find(r => r.operationId === first.operationId)?.reason).toBe('changed');
  const other = (await f.session.trashPreview()).rows.find(r => r.eligible)!, second = await f.session.trashPreview([other.operationId]);
  f.store.setExclusions(['unused.log']); await expect(f.session.trashConfirm(second)).rejects.toThrow('changed');
  await expect(f.session.trashConfirm(await f.session.trashPreview())).rejects.toThrow('changed');
});
it('protects missing or corrupt replicas, queued records, active recovery and hardlinked payloads', async () => {
  const f = await fixture(); const initial = await f.session.trashPreview(), first = initial.rows[0], second = initial.rows[1];
  const entry = f.entries.find(e => e.relativePath === first.path)!;
  f.store.forgetSources([entry.revisionId]); expect((await f.session.trashPreview()).rows.find(r => r.path === first.path)?.reason).toBe('unavailable');
  const other = f.entries.find(e => e.relativePath === second.path)!;
  const busy = { ...f.options, pins: () => [other.revisionId] };
  const { previewSyncTrash } = await import('./room-sync-trash-retention');
  expect((await previewSyncTrash(f.store, [], busy)).rows.find(r => r.path === second.path)?.reason).toBe('busy');
  const source = f.store.sources().find(s => s.revisionId === other.revisionId)!; fs.writeFileSync(source.path, 'corrupt replica');
  expect((await f.session.trashPreview()).rows.every(r => !r.eligible)).toBe(true);
  fs.linkSync(path.join(f.base, second.operationId, 'previous'), path.join(directory, 'outside-link'));
  expect((await f.session.trashPreview()).rows.find(r => r.path === second.path)?.eligible).toBe(false);
});
it('preserves unpublished local bytes even when a signed previous version is retained', async () => {
  const f = await fixture(false, false), base = f.entries[0]; fs.writeFileSync(path.join(f.folder, base.relativePath), 'unpublished local edits');
  const revision = signSyncRevision(f.context.scope, { v: 6, rootId: f.context.rootId, policyId: f.store.policy()!.policyId, entryId: base.entryId,
    parents: [base.revisionId], relativePath: base.relativePath, op: 'delete', blob: null, authorId: f.self, pub: f.identity.pub, createdAt: Date.now() }, f.identity.priv);
  f.store.acceptRevision(revision); await f.session.confirmDelete(await f.session.prepareDelete(base.entryId, true));
  const view = await f.session.trashPreview(); expect(view.rows[0].reason).toBe('different'); expect(view.summary.reclaimableBytes).toBe(0);
  await expect(f.session.trashPreview([view.rows[0].operationId])).rejects.toThrow('changed');
});
it.each(['intent', 'linked', 'moved', 'deleted'] as SyncTrashPruneStep[])('recovers interruption after %s without resuming deletion', async step => {
  const f = await fixture(), row = (await f.session.trashPreview()).rows[0], plan = await f.session.trashPreview([row.operationId]);
  const result = await confirmSyncTrash(f.store, plan, f.options, current => { if (current === step) throw new Error('crash'); });
  expect(result.error).toContain('crash'); await f.recover(); await f.recover();
  const previous = path.join(f.base, row.operationId, 'previous');
  expect(fs.existsSync(previous)).toBe(step !== 'deleted');
  if (step !== 'deleted') expect(fs.readFileSync(previous, 'utf8')).toBe('body ' + row.path);
  expect(fs.existsSync(path.join(f.folder, row.path))).toBe(false);
  expect(fs.existsSync(path.join(f.base, row.operationId, 'prune.json'))).toBe(false);
});
it('keeps a late write or the remaining payload when its recovery replica disappears mid-cleanup', async () => {
  const f = await fixture(), row = (await f.session.trashPreview()).rows[0], plan = await f.session.trashPreview([row.operationId]);
  const source = f.store.sources().find(s => s.revisionId === plan.selected[0].replica.revisionId)!;
  const result = await confirmSyncTrash(f.store, plan, f.options, (step, folder) => {
    if (step === 'moved') { fs.writeFileSync(path.join(folder, 'previous.pruning'), 'late trash edit'); fs.unlinkSync(source.path); }
  });
  expect(result.removedCopies).toBe(0); expect(result.error).toBeTruthy();
  await f.recover(); expect(fs.readFileSync(path.join(f.base, row.operationId, 'previous'), 'utf8')).toBe('late trash edit');
  expect((await f.session.trashPreview()).rows.find(r => r.operationId === row.operationId)?.reason).toBe('changed');
});
it('fails closed for missing roots, malformed markers, unknown files and forged receipts', async () => {
  const f = await fixture(), rows = (await f.session.trashPreview()).rows;
  fs.writeFileSync(path.join(f.base, rows[0].operationId, 'prune.json'), '{"v":0}');
  fs.writeFileSync(path.join(f.base, rows[1].operationId, 'receipt.json'), '{}');
  await f.recover().catch(() => {}); const view = await f.session.trashPreview(); expect(view.rows.every(r => !r.eligible)).toBe(true);
  expect(fs.existsSync(path.join(f.base, rows[0].operationId, 'previous'))).toBe(true);
  fs.renameSync(f.folder, path.join(directory, 'disconnected')); await expect(f.session.trashPreview()).rejects.toThrow();
});
it('stops cleanup if the only verified replica disappears after staging, retaining the original payload', async () => {
  const f = await fixture(), row = (await f.session.trashPreview()).rows[0], plan = await f.session.trashPreview([row.operationId]);
  const source = f.store.sources().find(s => s.revisionId === plan.selected[0].replica.revisionId)!;
  const result = await confirmSyncTrash(f.store, plan, f.options, step => { if (step === 'moved') fs.unlinkSync(source.path); });
  expect(result.removedCopies).toBe(0); expect(result.error).toContain('recovery copy'); await f.recover();
  expect(fs.readFileSync(path.join(f.base, row.operationId, 'previous'), 'utf8')).toBe('body ' + row.path);
});
it('protects a deletion that is still in the durable outgoing queue', async () => {
  const f = await fixture(false, false), base = f.entries[0]; await f.session.confirmDelete(await f.session.prepareDelete(base.entryId));
  expect((await f.session.trashPreview()).rows[0].reason).toBe('busy');
  f.store.acknowledgeMany(f.store.pendingRecordIds()); expect((await f.session.trashPreview()).rows[0].eligible).toBe(true);
});
it('stops on lifecycle cancellation and recovers staged bytes when the session restarts', async () => {
  const f = await fixture(), row = (await f.session.trashPreview()).rows[0], plan = await f.session.trashPreview([row.operationId]);
  let live = true;
  const result = await confirmSyncTrash(f.store, plan, { ...f.options, current: () => live }, step => { if (step === 'moved') live = false; });
  expect(result.removedCopies).toBe(0); expect(result.error).toBeTruthy(); await f.recover();
  expect(fs.readFileSync(path.join(f.base, row.operationId, 'previous'), 'utf8')).toBe('body ' + row.path);
});

it.each(['write', 'crash'])('retries trash pruning after incomplete metadata: %s', async mode => {
  const f = await fixture(), before = await f.session.trashPreview(), selected = before.rows[0], plan = await f.session.trashPreview([selected.operationId]);
  const payload = path.join(f.base, selected.operationId, 'previous'), original = fs.readFileSync(payload, 'utf8');
  if (mode === 'write') {
    const write = fs.promises.writeFile.bind(fs.promises);
    const fault = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      if (path.basename(String(file)).startsWith('prune.json')) { await write(file, '{"partial":', options); throw Object.assign(Error('No space left'), { code: 'ENOSPC' }); }
      return write(file, data, options);
    });
    const failed = await f.session.trashConfirm(plan); expect(failed.removedCopies).toBe(0); expect(failed.error).toContain('No space'); fault.mockRestore();
  } else fs.writeFileSync(path.join(f.base, selected.operationId, 'prune.json.tmp-' + crypto.randomUUID()), '{"partial":');
  const retried = await f.session.trashPreview(); expect(retried.rows.every(row => row.eligible)).toBe(true);
  expect(fs.readFileSync(payload, 'utf8')).toBe(original); expect(retried.summary.copies).toBe(before.summary.copies);
});
