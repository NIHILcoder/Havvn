import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db/secrets', () => ({ encryptSecret: () => { throw new Error('fixture'); }, decryptSecretStrict: () => { throw new Error('fixture'); } }));
import { RoomSyncStore } from '../db/room-sync-store';
import { RoomSyncSession } from './room-sync-session';
import { deriveMemberId } from './room-crypto';
import { signSyncRevision } from './room-sync-proofs';
import { generateRoomSecret } from './room-e2e';
import { contentKeyEpoch } from './room-keyring';
import { exportSyncTrash, type SyncTrashExportStep } from './room-sync-trash-export';
import { confirmSyncTrash, type SyncTrashRetentionOptions } from './room-sync-trash-retention';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-trash-export-')); });
afterEach(() => {
  vi.restoreAllMocks(); const target = path.resolve(directory), base = path.resolve(os.tmpdir());
  if (path.dirname(target) !== base || !path.basename(target).startsWith('havvn-trash-export-') || fs.lstatSync(target).isSymbolicLink()) throw new Error('Invalid fixture cleanup target');
  fs.rmSync(target, { recursive: true, force: true });
});
async function fixture(e2e = false, body = Buffer.from('unpublished local edits\0\r\n')) {
  const keys = crypto.generateKeyPairSync('ed25519'), identity = { pub: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const self = deriveMemberId(identity.pub), context = { rootId: crypto.randomUUID(), scope: 'trash-export-test', ownerId: self, e2e };
  let data: unknown, fail = false, live = true;
  const persistence = { read: () => structuredClone(data), write: (value: unknown) => { if (fail) throw new Error('disk full'); data = structuredClone(value); } };
  const folder = path.join(directory, 'working'), storage = path.join(directory, 'storage'); fs.mkdirSync(folder);
  const secret = e2e ? generateRoomSecret() : undefined;
  const makeSession = (store: RoomSyncStore) => new RoomSyncSession({ context, store, storage, identity, isCurrent: () => live,
    contentSecret: () => secret!, resolveSecret: epoch => secret && epoch === contentKeyEpoch(secret) ? secret : undefined });
  const store = new RoomSyncStore(persistence, 'local', context); store.bind(folder); const session = makeSession(store);
  session.createRoot('Test'); await session.changeWriters([self], session.rightsStamp(), true, true);
  const file = path.join(folder, 'config.ini'); fs.writeFileSync(file, 'shared contents'); const { revision: base } = await session.publish('config.ini');
  fs.writeFileSync(file, body);
  const deletion = signSyncRevision(context.scope, { v: 6, rootId: context.rootId, policyId: store.policy()!.policyId, entryId: base.entryId, parents: [base.revisionId],
    relativePath: base.relativePath, op: 'delete', blob: null, authorId: self, pub: identity.pub, createdAt: Date.now() }, identity.priv);
  store.acceptRevision(deletion); await session.confirmDelete(await session.prepareDelete(base.entryId, true)); store.acknowledgeMany(store.pendingRecordIds());
  const plan = await session.trashPreview(), row = plan.rows[0], previous = path.join(folder, '.havvn-sync/trash', row.operationId, 'previous'), target = path.join(directory, 'saved.ini');
  const options = (session as unknown as { trashRetentionOptions(): SyncTrashRetentionOptions }).trashRetentionOptions();
  const restart = () => { const reopened = new RoomSyncStore(persistence, 'local', context); return { store: reopened, session: makeSession(reopened) }; };
  return { store, session, plan, row, previous, target, body, folder, storage, options, restart, context, saved: () => structuredClone(data), fail: () => { fail = true; }, stop: () => { live = false; } };
}
it.each([false, true])('exports exact local bytes without changing trash or shared history, and permits reviewed cleanup after restart (E2E %s)', async e2e => {
  const f = await fixture(e2e); expect(f.row).toMatchObject({ reason: 'different', exportable: true, eligible: false });
  const history = f.store.records(), heads = f.store.heads();
  const result = await f.session.exportTrash(f.plan, f.row.operationId, f.target, [f.storage]);
  expect(result).toEqual({ path: f.target, bytes: f.body.length, digest: crypto.createHash('sha256').update(f.body).digest('hex') });
  expect(fs.readFileSync(f.target)).toEqual(f.body); expect(fs.readFileSync(f.previous)).toEqual(f.body); expect(f.store.records()).toEqual(history); expect(f.store.heads()).toEqual(heads);
  const restarted = f.restart(), fresh = await restarted.session.trashPreview(); expect(fresh.rows[0]).toMatchObject({ reason: 'exported', eligible: true }); expect(fresh.selected).toHaveLength(0);
  const reviewed = await restarted.session.trashPreview([f.row.operationId]); expect((await restarted.session.trashConfirm(reviewed)).removedCopies).toBe(1);
  expect(fs.existsSync(f.previous)).toBe(false); expect(fs.readFileSync(f.target)).toEqual(f.body);
  expect(restarted.store.trashExports()).toHaveLength(0);
});
it.each([Buffer.alloc(0), Buffer.from(Array.from({ length: 180000 }, (_, i) => i % 256))])('copies empty and multi-chunk binary data without text conversion', async body => {
  const f = await fixture(false, body); await f.session.exportTrash(f.plan, f.row.operationId, f.target, []); expect(fs.readFileSync(f.target)).toEqual(body);
});
it('never replaces an existing destination and rejects shared or private storage paths', async () => {
  const f = await fixture(); fs.writeFileSync(f.target, 'keep this file');
  await expect(f.session.exportTrash(f.plan, f.row.operationId, f.target, [])).rejects.toThrow('already exists'); expect(fs.readFileSync(f.target, 'utf8')).toBe('keep this file');
  for (const target of [path.join(f.folder, 'export.ini'), path.join(f.storage, 'export.ini')]) await expect(f.session.exportTrash(f.plan, f.row.operationId, target, [f.storage])).rejects.toThrow('managed');
  expect(fs.readFileSync(f.previous)).toEqual(f.body); expect(f.store.trashExports()).toHaveLength(0);
});
it('protects the original when a saved export is removed, modified, replaced or hardlinked', async () => {
  for (const mutation of ['remove', 'modify', 'replace', 'link']) {
    const f = await fixture(); const target = path.join(directory, mutation + '.ini'); await f.session.exportTrash(f.plan, f.row.operationId, target, []);
    const plan = await f.session.trashPreview([f.row.operationId]);
    if (mutation === 'remove') fs.unlinkSync(target);
    if (mutation === 'modify') fs.writeFileSync(target, 'changed');
    if (mutation === 'replace') { fs.unlinkSync(target); fs.writeFileSync(target, f.body); }
    if (mutation === 'link') fs.linkSync(target, target + '.linked');
    await expect(f.session.trashConfirm(plan)).rejects.toThrow('changed'); expect(fs.readFileSync(f.previous)).toEqual(f.body);
    expect((await f.session.trashPreview()).rows[0].eligible).toBe(false);
    // Each fixture uses a separate binding directory for this loop.
    fs.renameSync(f.folder, path.join(directory, 'retired-' + mutation));
  }
});
it('retains trash if the independent exported file disappears after cleanup staging', async () => {
  const f = await fixture(); await f.session.exportTrash(f.plan, f.row.operationId, f.target, []);
  const plan = await f.session.trashPreview([f.row.operationId]);
  const result = await confirmSyncTrash(f.store, plan, f.options, step => { if (step === 'moved') fs.unlinkSync(f.target); });
  expect(result.removedCopies).toBe(0); expect(result.error).toBeTruthy(); await f.session.trashPreview(); expect(fs.readFileSync(f.previous)).toEqual(f.body);
});
it.each(['opened', 'copied', 'verified'] as SyncTrashExportStep[])('does not record an export interrupted after %s', async step => {
  const f = await fixture();
  await expect(exportSyncTrash(f.store, f.plan, f.row.operationId, f.target, f.options, [], at => { if (at === step) throw new Error('interrupted'); })).rejects.toThrow('interrupted');
  expect(f.store.trashExports()).toHaveLength(0); expect(fs.readFileSync(f.previous)).toEqual(f.body); expect((await f.session.trashPreview()).rows[0].eligible).toBe(false);
});
it('keeps the saved file and the original if persisting the export receipt fails', async () => {
  const f = await fixture(); f.fail(); await expect(f.session.exportTrash(f.plan, f.row.operationId, f.target, [])).rejects.toThrow('receipt failed');
  expect(fs.readFileSync(f.target)).toEqual(f.body); expect(fs.readFileSync(f.previous)).toEqual(f.body); expect(f.restart().store.trashExports()).toHaveLength(0);
});
it('rejects stale previews, forged operation IDs and lifecycle changes without granting cleanup', async () => {
  const f = await fixture(); await expect(f.session.exportTrash(f.plan, 'op-unknown', f.target, [])).rejects.toThrow('not exportable');
  f.store.setExclusions(['ignore.tmp']); await expect(f.session.exportTrash(f.plan, f.row.operationId, f.target, [])).rejects.toThrow('changed'); expect(fs.existsSync(f.target)).toBe(false);
  const plan = await f.session.trashPreview();
  await expect(exportSyncTrash(f.store, plan, f.row.operationId, f.target, f.options, [], step => { if (step === 'copied') f.stop(); })).rejects.toThrow('changed');
  expect(fs.readFileSync(f.previous)).toEqual(f.body); expect(f.restart().store.trashExports()).toHaveLength(0);
});
it('rejects changed source data during an export', async () => {
  const f = await fixture();
  await expect(exportSyncTrash(f.store, f.plan, f.row.operationId, f.target, f.options, [], step => { if (step === 'copied') fs.writeFileSync(f.previous, 'late edit'); })).rejects.toThrow('changed');
  expect(fs.readFileSync(f.previous, 'utf8')).toBe('late edit'); expect(f.store.trashExports()).toHaveLength(0);
});
it('detects destination tampering before recording a recovery copy', async () => {
  const f = await fixture();
  await expect(exportSyncTrash(f.store, f.plan, f.row.operationId, f.target, f.options, [], step => { if (step === 'copied') fs.writeFileSync(f.target, 'tampered'); })).rejects.toThrow('write failed');
  expect(fs.readFileSync(f.previous)).toEqual(f.body); expect(f.store.trashExports()).toHaveLength(0);
});
it('rejects malformed or duplicate protected export receipts on reload', async () => {
  const f = await fixture(); await f.session.exportTrash(f.plan, f.row.operationId, f.target, []);
  for (const patch of [{ digest: 'not-a-hash' }, { path: 'relative.ini' }, { operationId: '../escape' }, { size: -1 }, { identity: '' }]) {
    const raw = f.saved() as { trashExports: Record<string, unknown>[] }; Object.assign(raw.trashExports[0], patch);
    expect(() => new RoomSyncStore({ read: () => raw, write: () => {} }, 'local', f.context)).toThrow('Invalid');
  }
  const raw = f.saved() as { trashExports: unknown[] }; raw.trashExports.push(raw.trashExports[0]);
  expect(() => new RoomSyncStore({ read: () => raw, write: () => {} }, 'local', f.context)).toThrow('Invalid');
});
