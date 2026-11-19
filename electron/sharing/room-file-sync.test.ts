import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db/secrets', () => ({ encryptSecret: () => { throw new Error('Use fixture persistence'); }, decryptSecretStrict: () => { throw new Error('Use fixture persistence'); } }));
import { RoomFileSync, type RoomFileSyncOptions, type SyncSeed } from './room-file-sync';
import { RoomSyncStore } from '../db/room-sync-store';
import { RoomSyncTrash } from './room-sync-trash';
import { deriveMemberId } from './room-crypto';
import type { SyncIndexContext } from '../../shared/room-file-sync';
import type { SyncWireBody, SyncWireVersion } from '../../shared/room-file-sync-protocol';
import { signSyncRevision } from './room-sync-proofs';
import { syncWorkQueue } from './room-sync-work';

it('exposes the resource wait and cancels a queued publication without committing a revision', async () => {
  const f = fixture(), rootId = await f.left.create('Queued folder', f.locals[0]);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'keep original');
  let finish!: () => void;
  const blocker = syncWorkQueue.run({ owner: {} }, () => new Promise<void>(resolve => { finish = resolve; }));
  const pending = f.left.publish(rootId, 'config.ini').catch(error => error.message);
  try {
    await vi.waitFor(() => expect(f.left.view()[0].work).toMatchObject({ waiting: 1, reason: 'resource-slot', position: 1 }));
    await f.left.action(rootId, 'cancel-work'); expect(await pending).toBe('Sync preparation canceled');
    expect(f.left.view()[0]).toMatchObject({ autoPublish: false, files: 0 }); expect(f.left.view()[0].work).toBeUndefined();
    expect(fs.readFileSync(path.join(f.locals[0], 'config.ini'), 'utf8')).toBe('keep original');
  } finally { finish(); await blocker; }
  await f.left.publish(rootId, 'config.ini'); expect(f.left.view()[0].files).toBe(1);
});

let directory: string;
const services: RoomFileSync[] = [];
it('switches device modes with writer checks and without granting read-only peers publication', async () => {
  const f = fixture(), rootId = await f.left.create('Modes', f.locals[0]); await f.pump(); await f.right.bind(rootId, f.locals[1]);
  await expect(f.right.action(rootId, 'mode-sync')).rejects.toThrow('authorized writer');
  expect(f.right.view()[0]).toMatchObject({ autoPublish: false, autoApply: false });
  await f.right.action(rootId, 'mode-receive'); expect(f.right.view()[0]).toMatchObject({ autoPublish: false, autoApply: true });
  await f.left.action(rootId, 'mode-sync'); expect(f.left.view()[0]).toMatchObject({ autoPublish: true, autoApply: true });
  await f.left.action(rootId, 'mode-manual'); expect(f.left.view()[0]).toMatchObject({ autoPublish: false, autoApply: false });
  const granted = f.left.rights(rootId, f.ids); await f.left.confirmRights(granted.previewId!); await f.pump();
  await f.right.action(rootId, 'mode-sync'); expect(f.right.view()[0]).toMatchObject({ publisher: true, autoPublish: true, autoApply: true });
  const revoked = f.left.rights(rootId, [f.ids[0]]); await f.left.confirmRights(revoked.previewId!); await f.pump();
  await expect(f.right.action(rootId, 'mode-sync')).rejects.toThrow('authorized writer');
  expect(f.right.view()[0]).toMatchObject({ publisher: false, autoPublish: false, autoApply: false, notice: 'rights-changed' });
});
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sync-service-')); });
afterEach(async () => { const closing = services.splice(0); closing.forEach(s => s.close()); await Promise.all(closing.map(s => s.settled())); fs.rmSync(directory, { recursive: true, force: true }); });
function identity() {
  const keys = crypto.generateKeyPairSync('ed25519');
  return { pub: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
function fixture(leftOverrides: Partial<RoomFileSyncOptions> = {}) {
  const identities = [identity(), identity()], ids = identities.map(i => deriveMemberId(i.pub));
  const context = { scope: 'coordinator-room-context', ownerId: ids[0], e2e: false };
  const bus: Array<{ from: number; to: string; body: SyncWireBody; version?: SyncWireVersion }> = [];
  const sources = new Map<string, SyncSeed>();
  const warnings: unknown[] = [];
  const locals = [0, 1].map(i => { const p = path.join(directory, 'working-' + i); fs.mkdirSync(p); return p; });
  const roots: SyncIndexContext[][] = [[], []];
  const saved = [new Map<string, unknown>(), new Map<string, unknown>()];
  const stores = [new Map<string, RoomSyncStore>(), new Map<string, RoomSyncStore>()];
  const fetch = vi.fn(async (_root: string, revisionId: string) => {
    const source = sources.get(revisionId); if (!source) throw new Error('Source missing');
    return { sourcePath: source.sourcePath, metadata: source.metadata };
  });
  const options = (i: number): RoomFileSyncOptions => ({ roomId: 'local-room-' + i, context, directory: path.join(directory, 'private-' + i),
    identity: identities[i], current: () => true,
    catalog: { roots: () => structuredClone(roots[i]), add: c => { roots[i].push(structuredClone(c)); } },
    openStore: c => {
      const store = new RoomSyncStore({ read: () => structuredClone(saved[i].get(c.rootId)), write: v => { saved[i].set(c.rootId, structuredClone(v)); } }, 'local-room-' + i, c);
      stores[i].set(c.rootId, store); return store;
    },
    send: async (to, body, version) => { bus.push({ from: i, to, body: structuredClone(body), version }); },
    writerCandidates: () => ids.map((memberId, n) => ({ memberId, name: 'Device ' + n, capable: true, moves: true, checkpoints: true, multipart: true })),
    seed: async (_root, source) => { sources.set(source.revisionId, source); }, fetch,
    warn: error => warnings.push(error),
  });
  const make = (i: number, overrides: Partial<RoomFileSyncOptions> = {}) => {
    const service = new RoomFileSync({ ...options(i), ...overrides }); services.push(service); return service;
  };
  const left = make(0, leftOverrides), right = make(1);
  const pump = async () => {
    for (let steps = 0; steps < 200; steps++) {
      const packet = bus.shift(); if (!packet) return;
      const destination = 1 - packet.from;
      if (packet.to && packet.to !== ids[destination]) throw new Error('Wrong destination');
      await (destination === 0 ? left : right).receive(ids[packet.from], packet.body, packet.version);
    }
    throw new Error('Metadata did not converge');
  };
  return { left, right, make, pump, locals, sources, stores, roots, warnings, context, options, fetch, ids, bus };
}

it('reviews colliding documents, binds one-use resolution tokens and delivers the chosen contents without changing the original path', async () => {
  const f = fixture(), rootId = await f.left.create('Path fixture', f.locals[0]); await f.pump();
  await f.right.bind(rootId, f.locals[1], true); fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'original content');
  await f.left.publish(rootId, 'config.ini'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); }, { timeout: 10_000 });
  const initial = f.left.files(rootId).items[0], rights = f.left.rights(rootId, f.ids, true); await f.left.confirmRights(rights.previewId!); await f.pump();
  await f.right.action(rootId, 'auto-apply', true);
  const leftStore = f.stores[0].get(rootId)!, rightStore = f.stores[1].get(rootId)!, first = leftStore.revision(initial.revisionId)!;
  const duplicate = signSyncRevision(f.context.scope, { ...first, v: 3, policyId: leftStore.policy()!.policyId, entryId: crypto.randomUUID(), parents: [], createdAt: Date.now() }, f.options(0).identity.priv);
  leftStore.acceptRevision(duplicate); rightStore.acceptRevision(duplicate);
  const source = leftStore.sources().find(s => s.revisionId === initial.revisionId)!; leftStore.retainSource(duplicate.revisionId, source);
  expect(f.left.files(rootId).items.every(row => row.pathResolvable)).toBe(true);
  const conflict = f.left.pathConflict(rootId, duplicate.entryId); expect(conflict.versions[0].revisionId).toBe(duplicate.revisionId); expect(conflict.others[0].entryId).toBe(initial.entryId);
  await expect(f.left.preparePathResolution(rootId, duplicate.entryId, initial.revisionId, 'copy.ini')).rejects.toThrow('Invalid');
  const preview = await f.left.preparePathResolution(rootId, duplicate.entryId, duplicate.revisionId, 'copy.ini');
  await f.left.confirmPathResolution(preview.previewId); await expect(f.left.confirmPathResolution(preview.previewId)).rejects.toThrow('expired'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items.find(r => r.entryId === duplicate.entryId)?.status).toBe('published'); }, { timeout: 10_000 });
  expect(fs.readFileSync(path.join(f.locals[0], 'config.ini'), 'utf8')).toBe('original content');
  expect(fs.readFileSync(path.join(f.locals[1], 'copy.ini'), 'utf8')).toBe('original content');
  expect(f.left.history(rootId, duplicate.entryId).items).toHaveLength(2); expect(leftStore.pathConflicts()).toEqual([]);
});

it('requires a current intact export before metadata cleanup, consumes tokens and imports history without changing shared files', async () => {
  const f = fixture(), rootId = await f.left.create('Archive fixture', f.locals[0]); await f.pump();
  await f.right.bind(rootId, f.locals[1], true);
  for (let n = 0; n < 3; n++) {
    fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'version ' + n); await f.left.publish(rootId, 'config.ini'); await f.pump();
    await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); }, { timeout: 10_000 });
    const cp = await f.left.previewCheckpoint(rootId); await f.left.confirmCheckpoint(cp.previewId); await f.pump();
    await f.right.action(rootId, 'auto-apply', true);
  }
  await vi.waitFor(async () => { await f.pump(); expect(f.stores[0].get(rootId)!.pendingRecordIds()).toHaveLength(0); }, { timeout: 10_000 });
  await f.left.cache(rootId, 0); const before = await f.left.previewMetadata(rootId, 0); expect(before.removed).toBeGreaterThan(0); expect(before.exported).toBe(false);
  await expect(f.left.confirmMetadata(before.previewId!)).rejects.toThrow('Export');
  const file = path.join(directory, 'history.havvn-history'), password = 'fixture archive password';
  await expect(f.left.exportMetadata(rootId, password, path.join(f.locals[0], 'backup'))).rejects.toThrow('outside');
  await f.left.exportMetadata(rootId, password, file); const ciphertext = fs.readFileSync(file, 'utf8');
  expect(ciphertext).not.toContain('config.ini'); expect(ciphertext).not.toContain(f.locals[0]);
  const stale = await f.left.previewMetadata(rootId, 0); fs.appendFileSync(file, ' ');
  await expect(f.left.confirmMetadata(stale.previewId!)).rejects.toThrow('changed'); fs.writeFileSync(file, ciphertext);
  const preview = await f.left.previewMetadata(rootId, 0), heads = f.stores[0].get(rootId)!.heads(); expect(preview.exported).toBe(true);
  await f.left.confirmMetadata(preview.previewId!); await expect(f.left.confirmMetadata(preview.previewId!)).rejects.toThrow('expired');
  expect(f.stores[0].get(rootId)!.retiredCount()).toBe(3 - preview.removed); expect(fs.readFileSync(path.join(f.locals[0], 'config.ini'), 'utf8')).toBe('version 2');
  await expect(f.left.importMetadata(rootId, 'another wrong password', file)).rejects.toThrow('Incorrect password');
  expect(await f.left.importMetadata(rootId, password, file)).toBeGreaterThan(0); expect(f.stores[0].get(rootId)!.heads()).toEqual(heads);
  expect(f.left.history(rootId, f.left.files(rootId).items[0].entryId).items).toHaveLength(3);
});

it('reviews local trash cleanup, consumes its token and preserves content restoration on a reader device', async () => {
  const f = fixture(), rootId = await f.left.create('Trash storage fixture', f.locals[0]); await f.pump();
  const rights = f.left.rights(rootId, [f.ids[0]], true, true); await f.left.confirmRights(rights.previewId!); await f.pump();
  await f.right.bind(rootId, f.locals[1], true); fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'recoverable bytes');
  await f.left.publish(rootId, 'config.ini'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); }, { timeout: 10_000 });
  const file = f.left.files(rootId).items[0], deletion = await f.left.prepareDelete(rootId, file.entryId); await f.left.confirmDelete(deletion.previewId); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId, 0, true).items[0]?.status).toBe('deleted'); }, { timeout: 10_000 });
  const initial = await f.right.previewTrash(rootId); expect(initial.items[0].eligible).toBe(true);
  await expect(f.right.confirmTrash(initial.previewId)).rejects.toThrow('changed');
  const reviewed = await f.right.previewTrash(rootId, [initial.items[0].operationId]);
  expect(f.right.trashPage(reviewed.previewId).selectedCopies).toBe(1);
  await expect(f.right.confirmTrash(reviewed.previewId)).resolves.toMatchObject({ removedCopies: 1 });
  await expect(f.right.confirmTrash(reviewed.previewId)).rejects.toThrow('expired');
  expect((await f.right.previewTrash(rootId)).copies).toBe(0); expect(f.right.files(rootId, 0, true).items).toHaveLength(1);
  await f.right.cache(rootId, 0); expect(f.right.history(rootId, file.entryId).items.find(r => r.revisionId === file.revisionId)?.local).toBe(true);
  const restore = await f.left.prepareRestore(rootId, file.revisionId); await f.left.confirmRestore(restore.previewId); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('recoverable bytes'); }, { timeout: 10_000 });
});
it('binds export to the live preview, uses a trusted picker and consumes the token only after choosing a destination', async () => {
  const f = fixture(), rootId = await f.left.create('Export fixture', f.locals[0]); await f.pump();
  const rights = f.left.rights(rootId, [f.ids[0]], true, true); await f.left.confirmRights(rights.previewId!); await f.pump();
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'exported bytes'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  const file = f.left.files(rootId).items[0], deletion = await f.left.prepareDelete(rootId, file.entryId); await f.left.confirmDelete(deletion.previewId); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.stores[0].get(rootId)!.pendingRecordIds()).toHaveLength(0); });
  const initial = await f.left.previewTrash(rootId), row = initial.items[0], pick = vi.fn(async () => null);
  await expect(f.left.exportTrash(initial.previewId, '../escape', pick, path.join(directory, 'profile'))).rejects.toThrow('not exportable'); expect(pick).not.toHaveBeenCalled();
  expect(await f.left.exportTrash(initial.previewId, row.operationId, pick, path.join(directory, 'profile'))).toBeNull(); expect(pick).toHaveBeenCalledWith('config.ini');
  expect(f.left.trashPage(initial.previewId)).toHaveProperty('previewId', initial.previewId);
  const saved = path.join(directory, 'outside.ini'); await f.left.exportTrash(initial.previewId, row.operationId, async () => saved, path.join(directory, 'profile'));
  expect(fs.readFileSync(saved, 'utf8')).toBe('exported bytes'); expect((await f.left.previewTrash(rootId)).copies).toBe(1);
  await expect(f.left.exportTrash(initial.previewId, row.operationId, async () => saved, path.join(directory, 'profile'))).rejects.toThrow('expired');
  const latest = await f.left.previewTrash(rootId);
  await expect(f.left.exportTrash(latest.previewId, row.operationId, async () => { await f.left.previewTrash(rootId); return path.join(directory, 'stale.ini'); }, path.join(directory, 'profile'))).rejects.toThrow('expired');
  expect(fs.existsSync(path.join(directory, 'stale.ini'))).toBe(false);
  const live = await f.left.previewTrash(rootId);
  await expect(f.left.exportTrash(live.previewId, row.operationId, async () => { f.left.close(); return path.join(directory, 'closed.ini'); }, path.join(directory, 'profile'))).rejects.toThrow();
  expect(fs.existsSync(path.join(directory, 'closed.ini'))).toBe(false);
});
it('rejects trash exports into private storage and other room folders, including bindings added while choosing the destination', async () => {
  const foreign = path.join(directory, 'other-room'), library = path.join(directory, 'room-library'), profile = path.join(directory, 'profile');
  for (const folder of [foreign, library, profile]) fs.mkdirSync(folder);
  const bindings: string[] = [], f = fixture({ forbidden: [library], otherBindings: () => bindings });
  const rootId = await f.left.create('Export boundaries', f.locals[0]); await f.pump();
  const rights = f.left.rights(rootId, [f.ids[0]], true, true); await f.left.confirmRights(rights.previewId!); await f.pump();
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'keep local bytes'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  const file = f.left.files(rootId).items[0], deletion = await f.left.prepareDelete(rootId, file.entryId); await f.left.confirmDelete(deletion.previewId); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.stores[0].get(rootId)!.pendingRecordIds()).toHaveLength(0); });
  for (const folder of [foreign, library, profile, f.locals[0]]) {
    const preview = await f.left.previewTrash(rootId), row = preview.items[0], target = path.join(folder, 'saved.ini');
    await expect(f.left.exportTrash(preview.previewId, row.operationId, async () => { bindings.push(foreign); return target; }, profile)).rejects.toThrow('managed');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(path.join(f.locals[0], '.havvn-sync', 'trash', row.operationId, 'previous'), 'utf8')).toBe('keep local bytes');
    expect(f.stores[0].get(rootId)!.trashExports()).toHaveLength(0);
  }
});
it('does not restart publication watchers when the room closes during trash cleanup', async () => {
  const f = fixture(), rootId = await f.left.create('Closing trash fixture', f.locals[0]); await f.pump();
  const rights = f.left.rights(rootId, [f.ids[0]], true, true); await f.left.confirmRights(rights.previewId!); await f.pump();
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'keep these bytes'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  const file = f.left.files(rootId).items[0], deletion = await f.left.prepareDelete(rootId, file.entryId); await f.left.confirmDelete(deletion.previewId); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.stores[0].get(rootId)!.pendingRecordIds()).toHaveLength(0); }, { timeout: 10_000 });
  await f.left.action(rootId, 'auto-publish', true);
  const initial = await f.left.previewTrash(rootId), plan = await f.left.previewTrash(rootId, [initial.items[0].operationId]);
  const link = fs.promises.link.bind(fs.promises), nativeWatch = vi.spyOn(fs, 'watch');
  vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
    await link(source, destination); if (String(destination).endsWith(path.sep + 'previous.pruning')) f.left.close();
  });
  try { expect(await f.left.confirmTrash(plan.previewId)).toMatchObject({ removedCopies: 0, error: expect.any(String) }); expect(nativeWatch).not.toHaveBeenCalled(); }
  finally { vi.restoreAllMocks(); }
});

it('reviews external deletions individually, rejects changed previews and retains content with a zero cache budget', async () => {
  const f = fixture(), rootId = await f.left.create('External deletion fixture', f.locals[0]);
  const rights = f.left.rights(rootId, [f.ids[0]], true, true); await f.left.confirmRights(rights.previewId!);
  for (const name of ['a.ini', 'b.ini', 'keep.ini']) { fs.writeFileSync(path.join(f.locals[0], name), name); await f.left.publish(rootId, name); }
  const file = f.left.files(rootId).items.find(row => row.path === 'a.ini')!;
  await f.left.missing(rootId); fs.unlinkSync(path.join(f.locals[0], file.path));
  expect((await f.left.missing(rootId)).waiting).toBe(1);
  await vi.waitFor(async () => expect((await f.left.missing(rootId)).items).toHaveLength(1), { timeout: 6500, interval: 200 });
  const before = await f.left.missing(rootId), preview = await f.left.prepareMissingDelete(rootId, file.entryId, before.stamp, false);
  expect(preview.external).toBe(true); fs.writeFileSync(path.join(f.locals[0], file.path), 'new external bytes');
  await expect(f.left.confirmDelete(preview.previewId)).rejects.toThrow('changed');
  expect(f.left.files(rootId).items.find(row => row.entryId === file.entryId)?.deleted).toBe(false);
  fs.unlinkSync(path.join(f.locals[0], file.path)); await f.left.missing(rootId);
  await vi.waitFor(async () => expect((await f.left.missing(rootId)).items).toHaveLength(1), { timeout: 6500, interval: 200 });
  const current = await f.left.missing(rootId), accepted = await f.left.prepareMissingDelete(rootId, file.entryId, current.stamp, false);
  await f.left.confirmDelete(accepted.previewId); await expect(f.left.confirmDelete(accepted.previewId)).rejects.toThrow('expired');
  await f.left.cache(rootId, 0); expect(f.left.history(rootId, file.entryId).items.find(row => row.revisionId === file.revisionId)?.local).toBe(true);
  const restore = await f.left.prepareRestore(rootId, file.revisionId); await f.left.confirmRestore(restore.previewId);
  expect(fs.readFileSync(path.join(f.locals[0], file.path), 'utf8')).toBe('a.ini');
}, 20_000);

it('requires mass acknowledgement and rejects changes in the missing set or directory availability', async () => {
  const f = fixture(), rootId = await f.left.create('Mass deletion fixture', f.locals[0]);
  const rights = f.left.rights(rootId, [f.ids[0]], true, true); await f.left.confirmRights(rights.previewId!);
  for (const name of ['a.ini', 'b.ini', 'keep.ini']) { fs.writeFileSync(path.join(f.locals[0], name), name); await f.left.publish(rootId, name); }
  await f.left.missing(rootId); for (const name of ['a.ini', 'b.ini']) fs.unlinkSync(path.join(f.locals[0], name));
  await f.left.missing(rootId);
  await vi.waitFor(async () => expect((await f.left.missing(rootId)).items).toHaveLength(2), { timeout: 6500, interval: 200 });
  const view = await f.left.missing(rootId); expect(view.mass).toBe(true);
  await expect(f.left.prepareMissingDelete(rootId, view.items[0].entryId, view.stamp, false)).rejects.toThrow('changed');
  const accepted = await f.left.prepareMissingDelete(rootId, view.items[0].entryId, view.stamp, true);
  fs.renameSync(f.locals[0], path.join(directory, 'disconnected'));
  expect((await f.left.missing(rootId)).blocked).toBe('unavailable');
  await expect(f.left.confirmDelete(accepted.previewId)).rejects.toThrow('changed');
  expect(f.left.files(rootId, 0, true).items).toHaveLength(0);
}, 15_000);

it('reviews v6 deletion rights, consumes one-use tokens and sends tombstones without downloading content', async () => {
  const f = fixture(), rootId = await f.left.create('Delete fixture', f.locals[0]); await f.pump();
  await f.right.bind(rootId, f.locals[1], true); fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'shared content');
  await f.left.publish(rootId, 'config.ini'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); }, { timeout: 10_000 });
  const file = f.left.files(rootId).items[0]; expect(file.deletable).toBe(false);
  expect(() => f.left.rights(rootId, f.ids, true, true)).toThrow('compatible'); // The second fixture peer advertises v5 only.
  const review = f.left.rights(rootId, [f.ids[0]], true, true); await f.left.confirmRights(review.previewId!); await f.pump();
  expect(f.left.view()[0].deletes).toBe(true); expect(f.right.view()[0].autoApply).toBe(false);
  expect(() => f.left.rights(rootId, [f.ids[0]], true, false)).toThrow('downgrade');
  await f.right.action(rootId, 'auto-apply', true); f.fetch.mockClear();
  await expect(f.right.prepareDelete(rootId, file.entryId)).rejects.toThrow('authorized');
  const deletion = await f.left.prepareDelete(rootId, file.entryId); await f.left.confirmDelete(deletion.previewId);
  await expect(f.left.confirmDelete(deletion.previewId)).rejects.toThrow('expired'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId, 0, true).items[0]?.status).toBe('deleted'); }, { timeout: 10_000 });
  expect(f.left.files(rootId).items).toHaveLength(0); expect(f.right.files(rootId).items).toHaveLength(0);
  expect(f.right.view()[0]).toMatchObject({ files: 0, trash: 1 }); expect(f.fetch).not.toHaveBeenCalled();
  const history = f.left.history(rootId, file.entryId); expect(history.items.filter(r => r.deleted)).toHaveLength(1);
  const restore = await f.left.prepareRestore(rootId, file.revisionId); await f.left.confirmRestore(restore.previewId); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); }, { timeout: 10_000 });
  expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('shared content');
});
it('exposes a published deletion for explicit retry when the author file move fails with automatic receive off', async () => {
  const f = fixture(), rootId = await f.left.create('Locked author', f.locals[0]); await f.pump();
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'original'); await f.left.publish(rootId, 'config.ini');
  const file = f.left.files(rootId).items[0], rights = f.left.rights(rootId, [f.ids[0]], true, true); await f.left.confirmRights(rights.previewId!);
  const preview = await f.left.prepareDelete(rootId, file.entryId);
  const blocked = vi.spyOn(RoomSyncTrash.prototype, 'remove').mockRejectedValueOnce(new Error('EPERM: file locked'));
  try {
    await expect(f.left.confirmDelete(preview.previewId)).rejects.toThrow('locked');
    expect(f.left.files(rootId).items[0]).toMatchObject({ deleted: true, status: 'error', resolvable: true });
    expect(fs.readFileSync(path.join(f.locals[0], 'config.ini'), 'utf8')).toBe('original');
    const retry = await f.left.prepareDelete(rootId, file.entryId, true); await f.left.confirmDelete(retry.previewId);
    expect(fs.existsSync(path.join(f.locals[0], 'config.ini'))).toBe(false); expect(f.left.files(rootId, 0, true).items[0].status).toBe('deleted');
  } finally { blocked.mockRestore(); }
});

it('exchanges a compact checkpoint floor, preserves history and uses reviewed one-use owner tokens', async () => {
  const f = fixture(), rootId = await f.left.create('Checkpoint', f.locals[0]); await f.pump(); await f.right.bind(rootId, f.locals[1], true);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'first'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); }, { timeout: 10_000 });
  await expect(f.right.previewCheckpoint(rootId)).rejects.toThrow('owner');
  const stale = await f.left.previewCheckpoint(rootId); fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'second'); await f.left.publish(rootId, 'config.ini');
  await expect(f.left.confirmCheckpoint(stale.previewId)).rejects.toThrow('changed'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); }, { timeout: 10_000 });
  const reviewed = await f.left.previewCheckpoint(rootId); expect(reviewed).toMatchObject({ generation: 1, activeRecords: 3, heads: 1 });
  await f.left.confirmCheckpoint(reviewed.previewId); await f.pump(); await expect(f.left.confirmCheckpoint(reviewed.previewId)).rejects.toThrow('expired');
  expect(f.stores[0].get(rootId)!.records()).toHaveLength(1); expect(f.stores[1].get(rootId)!.records()).toHaveLength(1);
  expect(f.right.view()[0].autoApply).toBe(false); expect(f.left.history(rootId, f.left.files(rootId).items[0].entryId).items).toHaveLength(2);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'after checkpoint'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  await f.right.action(rootId, 'auto-apply', true);
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); }, { timeout: 10_000 });
  expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('after checkpoint');
});

it('fetches verified remote history into a fresh profile and restores its old bytes only after explicit writer review', async () => {
  const f = fixture(), rootId = await f.left.create('Remote history', f.locals[0]); await f.pump();
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'old bytes'); const first = await f.left.publish(rootId, 'config.ini'); await f.pump();
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'current bytes'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  await f.left.confirmCheckpoint((await f.left.previewCheckpoint(rootId)).previewId); await f.pump();
  // Replace the receiver's durable profile with a genuinely empty one; only the floor is exchanged.
  f.right.close(); f.roots[1].length = 0; f.stores[1].clear();
  const saved = new Map<string, unknown>(), roots: SyncIndexContext[] = [];
  const fresh = f.make(1, { catalog: { roots: () => structuredClone(roots), add: c => { roots.push(c); } },
    openStore: context => { const store = new RoomSyncStore({ read: () => saved.get(context.rootId), write: v => { saved.set(context.rootId, structuredClone(v)); } }, 'fresh-history', context); f.stores[1].set(context.rootId, store); return store; } });
  const pump = async () => {
    for (let steps = 0; steps < 300; steps++) { const packet = f.bus.shift(); if (!packet) return; await (packet.from === 0 ? fresh : f.left).receive(f.ids[packet.from], packet.body, packet.version); }
    throw Error('History integration did not converge');
  };
  f.bus.length = 0; await f.left.peer(f.ids[1]); await pump(); const entryId = fresh.files(rootId).items[0].entryId;
  expect(fresh.history(rootId, entryId)).toMatchObject({ canFetch: true }); expect(fresh.history(rootId, entryId).items).toHaveLength(1);
  const active = f.stores[1].get(rootId)!.records(), download = fresh.fetchHistory(rootId, entryId);
  await pump(); expect(await download).toEqual({ epochs: 1, state: 'complete' });
  expect(f.stores[1].get(rootId)!.records()).toEqual(active); expect(fresh.view()[0].path).toBeNull();
  expect(fresh.history(rootId, entryId).items.some(r => r.revisionId === first)).toBe(true);
  await expect(fresh.prepareRestore(rootId, first)).rejects.toThrow('bound writer');
  const rights = f.left.rights(rootId, f.ids); await f.left.confirmRights(rights.previewId!); await pump();
  await fresh.bind(rootId, f.locals[1], true);
  await vi.waitFor(async () => { await pump(); expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('current bytes'); expect(fresh.files(rootId).items[0].status).toBe('published'); }, { timeout: 10_000 });
  const restoreJob = fresh.prepareRestore(rootId, first); await vi.waitFor(async () => { await pump(); expect(f.stores[1].get(rootId)!.sources().some(s => s.revisionId === first)).toBe(true); });
  const reviewed = await restoreJob; await fresh.confirmRestore(reviewed.previewId); await pump();
  expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('old bytes');
  expect(f.stores[0].get(rootId)!.heads()).toEqual(f.stores[1].get(rootId)!.heads());
}, 20_000);

it('compacts either peer locally with one-use reviewed tokens and keeps wire history and offline catch-up unchanged', async () => {
  const f = fixture(), rootId = await f.left.create('Journal', f.locals[0]); await f.pump(); await f.right.bind(rootId, f.locals[1], true);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'base'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); }, { timeout: 10_000 });
  const records = f.stores[0].get(rootId)!.records(), old = await f.left.previewLog(rootId);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'next'); await f.left.publish(rootId, 'config.ini');
  await expect(f.left.confirmLog(old.previewId!)).rejects.toThrow('changed');
  const plan = await f.left.previewLog(rootId); expect(plan.savedBytes).toBeGreaterThan(0); expect(plan).not.toHaveProperty('archive');
  const result = await f.left.confirmLog(plan.previewId!); expect(result).toMatchObject({ records: 3, archived: 3, pending: 0 });
  await expect(f.left.confirmLog(plan.previewId!)).rejects.toThrow('expired');
  expect(f.stores[0].get(rootId)!.records().slice(0, 2)).toEqual(records);
  expect((await f.left.previewLog(rootId)).previewId).toBeNull();
  await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); }, { timeout: 10_000 });
  expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('next');
  const receiver = await f.right.previewLog(rootId); await f.right.confirmLog(receiver.previewId!);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'after compaction'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); }, { timeout: 10_000 });
  expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('after compaction');
  expect(f.stores[0].get(rootId)!.heads()).toEqual(f.stores[1].get(rootId)!.heads());
});

it('reviews v3 opt-in and move tokens, transfers the same entry and rejects changed destinations', async () => {
  const f = fixture(), rootId = await f.left.create('Moves', f.locals[0]); await f.pump(); await f.right.bind(rootId, f.locals[1], true);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'base'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); }, { timeout: 10_000 });
  const rights = f.left.rights(rootId, f.ids, true); expect(rights.moves).toBe(true); await f.left.confirmRights(rights.previewId!); await f.pump();
  expect(() => f.left.rights(rootId, f.ids, false)).toThrow('downgrade');
  await f.right.action(rootId, 'auto-apply', true);
  const entry = f.left.files(rootId).items[0].entryId; expect(f.left.files(rootId).items[0].movable).toBe(true);
  const stale = await f.left.prepareMove(rootId, entry, 'taken.ini'); fs.writeFileSync(path.join(f.locals[0], 'taken.ini'), 'local');
  await expect(f.left.confirmMove(stale.previewId)).rejects.toThrow('changed');
  const reviewed = await f.left.prepareMove(rootId, entry, 'nested/new.ini'); expect(reviewed).toMatchObject({ fromPath: 'config.ini', toPath: 'nested/new.ini', entryId: entry });
  await f.left.confirmMove(reviewed.previewId); await f.pump();
  await expect(f.left.confirmMove(reviewed.previewId)).rejects.toThrow('expired');
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]).toMatchObject({ path: 'nested/new.ini', entryId: entry, status: 'published' }); }, { timeout: 10_000 });
  expect(fs.existsSync(path.join(f.locals[1], 'config.ini'))).toBe(false); expect(fs.readFileSync(path.join(f.locals[1], 'nested/new.ini'), 'utf8')).toBe('base');
  expect(f.left.history(rootId, entry).items).toHaveLength(2);
});

it('reviews owner-only writer grants, rejects stale tokens and exchanges v2 branches with explicit resolution', async () => {
  const f = fixture(), rootId = await f.left.create('Writers', f.locals[0]); await f.pump();
  await f.right.bind(rootId, f.locals[1], true);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'base'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); }, { timeout: 10_000 });
  expect(() => f.right.rights(rootId, f.ids)).toThrow('owner');
  expect(() => f.left.rights(rootId, [f.ids[1]])).toThrow('owner');
  expect(() => f.left.rights(rootId, [f.ids[0], 'f'.repeat(32)])).toThrow('known');
  const stale = f.left.rights(rootId, f.ids);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'new base'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  await expect(f.left.confirmRights(stale.previewId!)).rejects.toThrow('review again');
  await vi.waitFor(async () => {
    await f.pump(); expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('new base');
    expect(f.right.files(rootId).items[0]?.status).toBe('applied');
  }, { timeout: 10_000 });
  const reviewed = f.left.rights(rootId, f.ids); await f.left.confirmRights(reviewed.previewId!); await f.pump();
  await expect(f.left.confirmRights(reviewed.previewId!)).rejects.toThrow('expired');
  expect(f.right.view()[0]).toMatchObject({ multiWriter: true, publisher: true, autoApply: false });
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'left branch'); fs.writeFileSync(path.join(f.locals[1], 'config.ini'), 'right branch');
  const leftId = await f.left.publish(rootId, 'config.ini'), rightId = await f.right.publish(rootId, 'config.ini'); await f.pump();
  expect(f.stores[0].get(rootId)!.heads()[0].revisionIds).toEqual([leftId, rightId].sort());
  const calls = f.fetch.mock.calls.length, mergeJob = f.left.prepareRestore(rootId, rightId);
  await vi.waitFor(async () => { await f.pump(); expect(f.fetch.mock.calls.length).toBeGreaterThan(calls); });
  const merge = await mergeJob; expect(merge.branches).toBe(2);
  await f.left.confirmRestore(merge.previewId); await f.pump();
  await f.right.action(rootId, 'auto-apply', true);
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('published'); }, { timeout: 10_000 });
  expect(fs.readFileSync(path.join(f.locals[0], 'config.ini'), 'utf8')).toBe('right branch');
  expect(f.stores[0].get(rootId)!.heads()).toEqual(f.stores[1].get(rootId)!.heads());
}, 20_000);

it('answers v2 upgrade streams in v2 without switching a legacy root to v2 announcements', async () => {
  const f = fixture(), rootId = await f.left.create('Legacy', f.locals[0]); await f.pump();
  const store = f.stores[0].get(rootId)!;
  await f.right.receive(f.ids[0], { kind: 'offer', rootId, streamId: 'f'.repeat(64), total: store.records().length }, 2);
  expect(f.bus.find(p => p.from === 1 && p.body.kind === 'request')?.version).toBe(2); f.bus.length = 0;
  await f.right.peer(f.ids[0]);
  expect(f.bus.find(p => p.from === 1 && p.body.kind === 'offer')?.version).toBe(1);
  expect(store.policy()?.v).toBe(1);
});

it('keeps checkpoint-excluded offline files visible with history and a read-only text buffer', async () => {
  const f = fixture(), rootId = await f.left.create('Offline', f.locals[0]); await f.pump();
  const rights = f.left.rights(rootId, f.ids); await f.left.confirmRights(rights.previewId!); await f.pump();
  await f.right.bind(rootId, f.locals[1]); fs.writeFileSync(path.join(f.locals[1], 'offline.txt'), 'local offline creation');
  const offline = await f.right.publish(rootId, 'offline.txt');
  const revoke = f.left.rights(rootId, [f.ids[0]]); await f.left.confirmRights(revoke.previewId!); await f.pump();
  expect(f.right.files(rootId).items[0]).toMatchObject({ orphaned: true, status: 'deferred', editable: true, path: 'offline.txt' });
  const draft = await f.right.openEditor(rootId, f.right.files(rootId).items[0].entryId);
  expect(draft).toMatchObject({ writable: false, text: 'local offline creation' });
  expect(f.right.history(rootId, draft.entryId).items[0].revisionId).toBe(offline);
  f.right.close(); await f.right.settled(); const reopened = f.make(1); await reopened.restore();
  expect(reopened.files(rootId).items[0].orphaned).toBe(true); expect((await reopened.openEditor(rootId, draft.entryId)).text).toBe(draft.text);
});
it('uses one-use editor guards, keeps external bytes, and renews the guard after a signed save', async () => {
  const f = fixture(), rootId = await f.left.create('Editor', f.locals[0]); fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'base');
  await f.left.publish(rootId, 'config.ini'); const entryId = f.left.files(rootId).items[0].entryId;
  const stale = await f.left.openEditor(rootId, entryId); fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'external');
  await expect(f.left.saveEditor(stale.token, 'draft')).rejects.toThrow('externally');
  await expect(f.left.saveEditor(stale.token, 'draft')).rejects.toThrow('expired');
  expect(fs.readFileSync(path.join(f.locals[0], 'config.ini'), 'utf8')).toBe('external');
  const opened = await f.left.openEditor(rootId, entryId), saved = await f.left.saveEditor(opened.token, 'saved');
  expect(saved.draft).toMatchObject({ text: 'saved', writable: true }); expect(saved.draft!.token).not.toBe(opened.token);
  expect(f.left.history(rootId, entryId).items).toHaveLength(2);
  f.left.closeEditor(saved.draft!.token); await expect(f.left.saveEditor(saved.draft!.token, 'closed')).rejects.toThrow('expired');
});

it('requires a current one-use backup review to save settings and persists automatic cleanup consent across restart', async () => {
  const f = fixture(), rootId = await f.left.create('Backups', f.locals[0]); await f.pump();
  await f.right.bind(rootId, f.locals[1], true);
  const publish = async (number: number) => {
    fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'version-' + number); await f.left.publish(rootId, 'config.ini'); await f.pump();
    await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0]?.status).toBe('applied'); expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('version-' + number); }, { timeout: 10_000 });
  };
  for (let i = 1; i <= 4; i++) await publish(i);
  const store = f.stores[1].get(rootId)!, original = await f.right.previewBackups(rootId);
  expect(original.policy.enabled).toBe(false); expect(original.removeCopies).toBe(0);
  const policy = { enabled: true, keepVersions: 1, maxAgeDays: 0, limitBytes: 0 };
  const reviewed = await f.right.previewBackups(rootId, policy);
  expect(store.backupPolicy().enabled).toBe(false); expect(reviewed.removeCopies).toBe(2);
  expect(() => f.right.backupPage(original.previewId)).toThrow('expired');
  expect(f.right.backupPage(reviewed.previewId, 100).items).toEqual([]);
  expect(() => f.right.backupPage(reviewed.previewId, -1)).toThrow('Invalid');
  const done = await f.right.confirmBackups(reviewed.previewId); expect(done.removedCopies).toBe(2); expect(store.backupPolicy()).toEqual(policy);
  await expect(f.right.confirmBackups(reviewed.previewId)).rejects.toThrow('expired');
  await publish(5);
  const backupCount = () => fs.readdirSync(path.join(f.locals[1], '.havvn-sync', 'transactions')).filter(id => fs.existsSync(path.join(f.locals[1], '.havvn-sync', 'transactions', id, 'previous'))).length;
  expect(backupCount()).toBe(2);
  const due = Date.now() + 61_000, clockAuto = vi.spyOn(Date, 'now').mockReturnValue(due);
  try { await (f.right as unknown as { trimBackups(id: string): Promise<void> }).trimBackups(rootId); } finally { clockAuto.mockRestore(); }
  expect(backupCount()).toBe(1);
  f.right.close(); await f.right.settled();
  const reopened = f.make(1); await reopened.restore(); expect(f.stores[1].get(rootId)!.backupPolicy()).toEqual(policy);
  expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('version-5');
  const expired = await reopened.previewBackups(rootId), now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60_000);
  await expect(reopened.confirmBackups(expired.previewId)).rejects.toThrow('expired'); clock.mockRestore();
  await reopened.action(rootId, 'unbind'); expect(f.stores[1].get(rootId)!.backupPolicy().enabled).toBe(false);
}, 20_000);

it('reviews publisher exclusions without changing files or signed history, persists them and resets them for a new binding', async () => {
  const f = fixture(), rootId = await f.left.create('Filters', f.locals[0]);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'local config'); fs.writeFileSync(path.join(f.locals[0], 'debug.log'), 'local log');
  const publishedLog = await f.left.publish(rootId, 'debug.log');
  const store = f.stores[0].get(rootId)!, before = store.records();
  const original = await f.left.previewFilters(rootId), preview = await f.left.previewFilters(rootId, ['*.log']);
  expect(store.exclusions()).toEqual([]); expect(preview.items.find(r => r.path === 'debug.log')).toMatchObject({ reason: 'rule', change: 'exclude', rule: '*.log' });
  expect(() => f.left.filterPage(original.previewId)).toThrow('expired');
  preview.rules.push('**'); preview.items.length = 0; // Renderer-returned data cannot mutate the server plan.
  await f.left.confirmFilters(preview.previewId); expect(store.exclusions()).toEqual(['*.log']); expect(store.records()).toEqual(before);
  expect(fs.readFileSync(path.join(f.locals[0], 'debug.log'), 'utf8')).toBe('local log');
  await expect(f.left.publish(rootId, 'debug.log')).rejects.toThrow('excluded');
  await expect(f.left.prepareRestore(rootId, publishedLog)).rejects.toThrow('included'); expect(f.fetch).not.toHaveBeenCalled();
  await expect(f.left.confirmFilters(preview.previewId)).rejects.toThrow('expired');
  f.left.close(); await f.left.settled(); const reopened = f.make(0); await reopened.restore();
  expect(f.stores[0].get(rootId)!.exclusions()).toEqual(['*.log']); await reopened.bind(rootId, f.locals[1]); expect(f.stores[0].get(rootId)!.exclusions()).toEqual([]);
});
it('blocks an already fetched receiver version after saving exclusions and fetches the latest head when the rule is removed', async () => {
  const f = fixture(), rootId = await f.left.create('Receiver filters', f.locals[0]); await f.pump();
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'first shared'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  let release!: () => void, downloading = false; const gate = new Promise<void>(resolve => { release = resolve; });
  f.fetch.mockImplementationOnce(async (_root, id) => { downloading = true; await gate; const s = f.sources.get(id)!; return { sourcePath: s.sourcePath, metadata: s.metadata }; });
  try {
    await f.right.bind(rootId, f.locals[1], true);
    await vi.waitFor(async () => { await f.pump(); expect(downloading).toBe(true); });
    const reviewed = await f.right.previewFilters(rootId, ['config.ini']);
    expect(reviewed.items.find(r => r.source === 'shared')).toMatchObject({ reason: 'rule', change: 'exclude' });
    await f.right.confirmFilters(reviewed.previewId); release();
    await vi.waitFor(() => expect((f.right as unknown as { work: Set<string> }).work.size).toBe(0));
    expect(f.right.files(rootId).items[0].status).toBe('excluded'); expect(fs.existsSync(path.join(f.locals[1], 'config.ini'))).toBe(false);
    await f.right.confirmFilters((await f.right.previewFilters(rootId, [])).previewId);
    await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0].status).toBe('applied'); }, { timeout: 10_000 });
    expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('first shared');
    await f.right.confirmFilters((await f.right.previewFilters(rootId, ['config.ini'])).previewId);
    fs.writeFileSync(path.join(f.locals[1], 'config.ini'), 'independent local edits');
    fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'latest shared'); await f.left.publish(rootId, 'config.ini'); await f.pump();
    await f.right.confirmFilters((await f.right.previewFilters(rootId, [])).previewId);
    await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0].status).toBe('conflict'); }, { timeout: 10_000 });
    expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('independent local edits');
  } finally { release(); }
}, 30_000);
it.each(['file', 'head', 'rebind', 'expired'] as const)('rejects a filter preview after %s', async change => {
  const f = fixture(), rootId = await f.left.create('Stale filters', f.locals[0]); fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'one');
  const preview = await f.left.previewFilters(rootId, ['*.log']);
  if (change === 'file') fs.appendFileSync(path.join(f.locals[0], 'config.ini'), 'two');
  if (change === 'head') await f.left.publish(rootId, 'config.ini');
  if (change === 'rebind') await f.left.bind(rootId, f.locals[1]);
  const clock = change === 'expired' ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000) : null;
  try { await expect(f.left.confirmFilters(preview.previewId)).rejects.toThrow(); } finally { clock?.mockRestore(); }
  expect(f.stores[0].get(rootId)!.exclusions()).toEqual([]);
});
it('pages local filter inspection without transferring the full tree through every UI update', async () => {
  const f = fixture(), rootId = await f.left.create('Filter pages', f.locals[0]);
  for (let n = 0; n < 205; n++) fs.writeFileSync(path.join(f.locals[0], n + '.txt'), 'x');
  const preview = await f.left.previewFilters(rootId); expect(preview.items).toHaveLength(100); expect(preview.next).toBe(100);
  expect(f.left.filterPage(preview.previewId, 200).items).toHaveLength(5); expect(f.left.filterPage(preview.previewId, 200).next).toBeNull();
  expect(() => f.left.filterPage(preview.previewId, -1)).toThrow('Invalid');
});
it('keeps rules editable after an oversized scan, grants no token until a complete review and allows excluding the excess files', async () => {
  const f = fixture(), rootId = await f.left.create('Oversized folder', f.locals[0]);
  for (let n = 0; n < 2001; n++) fs.writeFileSync(path.join(f.locals[0], n + '.txt'), 'x');
  const blocked = await f.left.previewFilters(rootId); expect(blocked.scanError).toContain('2000 files'); expect(blocked.previewId).toBe(''); expect(blocked.items).toEqual([]);
  await expect(f.left.confirmFilters(blocked.previewId)).rejects.toThrow('expired'); expect(f.stores[0].get(rootId)!.exclusions()).toEqual([]);
  const reviewed = await f.left.previewFilters(rootId, ['*.txt']); expect(reviewed.scanError).toBeUndefined(); expect(reviewed.included).toBe(0); expect(reviewed.skipped).toBe(2001);
  await f.left.confirmFilters(reviewed.previewId); expect(f.stores[0].get(rootId)!.exclusions()).toEqual(['*.txt']);
  expect(fs.readdirSync(f.locals[0])).toHaveLength(2001);
}, 20_000);

it('discovers authenticated roots without binding; explicit binding applies versions and preserves local edits', async () => {
  const f = fixture(), rootId = await f.left.create('Configs', f.locals[0]); await f.pump();
  expect(f.right.list()).toEqual([{ rootId, name: 'Configs', paused: false, binding: null }]);
  const source = path.join(f.locals[0], 'config.ini'), target = path.join(f.locals[1], 'config.ini');
  fs.writeFileSync(source, 'version one'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  expect(f.fetch).not.toHaveBeenCalled(); expect(fs.existsSync(target)).toBe(false);
  await f.right.bind(rootId, f.locals[1], true);
  await vi.waitFor(async () => { await f.pump(); expect(fs.readFileSync(target, 'utf8')).toBe('version one'); });
  await vi.waitFor(() => expect(f.stores[1].get(rootId)!.applied()).toEqual(f.stores[0].get(rootId)!.applied()), { timeout: 10_000 });
  await f.right.bind(rootId, f.locals[1], false);
  await f.right.bind(rootId, f.locals[1], true);
  fs.writeFileSync(source, 'version two'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(fs.readFileSync(target, 'utf8')).toBe('version two'); });
  await vi.waitFor(() => expect(f.stores[1].get(rootId)!.applied()).toEqual(f.stores[0].get(rootId)!.applied()), { timeout: 10_000 });
  fs.writeFileSync(target, 'local edit'); fs.writeFileSync(source, 'version three');
  await f.left.publish(rootId, 'config.ini'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.warnings.some(w => String(w).includes('local changes'))).toBe(true); }, { timeout: 10_000 });
  expect(fs.readFileSync(target, 'utf8')).toBe('local edit');
  f.right.close();
  const restored = f.make(1); await restored.restore();
  expect(restored.list()[0].binding).toEqual({ path: f.locals[1], autoApply: true });
  expect(fs.readFileSync(target, 'utf8')).toBe('local edit');
}, 20_000);

it('keeps prior roots paused after a room context change', async () => {
  const f = fixture(), rootId = await f.left.create('Configs', f.locals[0]); await f.pump();
  await f.right.bind(rootId, f.locals[1], true); f.right.close();
  const changed = f.make(1, { context: { ...f.context, scope: 'new-room-context' } });
  expect(changed.list()).toEqual([{ rootId, name: 'Sync folder', paused: true, binding: null }]);
  await expect(changed.bind(rootId, f.locals[1], true)).rejects.toThrow('paused');
  expect(f.fetch).not.toHaveBeenCalled();
});
it('defers one receiver file across restart while other files update, then resolves with a one-use token', async () => {
  const f = fixture(), rootId = await f.left.create('Conflicts', f.locals[0]); await f.pump();
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'one'); await f.left.publish(rootId, 'config.ini'); await f.pump(); await f.right.bind(rootId, f.locals[1], true);
  await vi.waitFor(async () => { await f.pump(); expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('one'); expect(f.right.files(rootId).items[0].status).toBe('applied'); });
  fs.writeFileSync(path.join(f.locals[1], 'config.ini'), 'local edit');
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'two'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(f.right.files(rootId).items[0].resolvable).toBe(true); });
  const entryId = f.right.files(rootId).items[0].entryId; f.right.deferFile(rootId, entryId);
  expect(f.right.files(rootId).items[0].status).toBe('deferred');
  fs.writeFileSync(path.join(f.locals[0], 'other.ini'), 'other file'); await f.left.publish(rootId, 'other.ini'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(fs.readFileSync(path.join(f.locals[1], 'other.ini'), 'utf8')).toBe('other file'); });
  expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('local edit');
  f.right.close(); await f.right.settled(); const reopened = f.make(1); await reopened.restore();
  expect(reopened.files(rootId).items.find(r => r.entryId === entryId)?.status).toBe('deferred');
  const preview = await reopened.prepareConflict(rootId, entryId); expect(preview.diff.kind).toBe('text');
  const result = await reopened.resolveConflict(preview.previewId, 'keep-both');
  expect(fs.readFileSync(path.join(f.locals[1], result.copyPath!), 'utf8')).toBe('local edit');
  expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('two');
  expect(reopened.files(rootId).items.find(r => r.entryId === entryId)?.status).toBe('applied');
  await expect(reopened.resolveConflict(preview.previewId, 'accept')).rejects.toThrow('expired');
});
it('lists history and restores with a one-use review token as an update for the receiver', async () => {
  const f = fixture(), rootId = await f.left.create('History', f.locals[0]); await f.pump();
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'first'); const first = await f.left.publish(rootId, 'config.ini'); await f.pump();
  await f.right.bind(rootId, f.locals[1], true);
  await vi.waitFor(async () => { await f.pump(); expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('first'); expect(f.right.files(rootId).items[0].status).toBe('applied'); }, { timeout: 10_000 });
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'second'); const second = await f.left.publish(rootId, 'config.ini'); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('second'); expect(f.right.files(rootId).items[0].status).toBe('applied'); }, { timeout: 10_000 });
  const entryId = f.left.files(rootId).items[0].entryId, history = f.left.history(rootId, entryId);
  expect(history.items.map(r => r.revisionId)).toEqual([second, first]); expect(history.canRestore).toBe(true);
  expect(f.right.history(rootId, entryId).canRestore).toBe(false);
  await expect(f.right.prepareRestore(rootId, first)).rejects.toThrow('writer');
  const preview = await f.left.prepareRestore(rootId, first); await f.left.confirmRestore(preview.previewId); await f.pump();
  await vi.waitFor(async () => { await f.pump(); expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('first'); expect(f.right.files(rootId).items[0].status).toBe('applied'); }, { timeout: 10_000 });
  expect(f.left.history(rootId, entryId).items).toHaveLength(3);
  await expect(f.left.confirmRestore(preview.previewId)).rejects.toThrow('expired');
}, 20_000);
it('shares a metadata wait with conflict preview and retries discovery when the first hint was lost', async () => {
  const f = fixture(), rootId = await f.left.create('Reconnect', f.locals[0]);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'shared'); await f.left.publish(rootId, 'config.ini'); await f.pump();
  fs.writeFileSync(path.join(f.locals[1], 'config.ini'), 'local edits'); await f.right.bind(rootId, f.locals[1], true);
  await vi.waitFor(() => expect(f.bus.some(p => p.body.kind === 'blob-request')).toBe(true));
  f.bus.splice(f.bus.findIndex(p => p.body.kind === 'blob-request'), 1);
  const entryId = f.right.files(rootId).items[0].entryId; f.right.deferFile(rootId, entryId);
  const pending = f.right.prepareConflict(rootId, entryId);
  await vi.waitFor(async () => { await f.pump(); expect(f.fetch).toHaveBeenCalled(); }, { timeout: 8000 });
  const preview = await pending;
  expect(preview.diff.kind).toBe('text'); expect(fs.readFileSync(path.join(f.locals[1], 'config.ini'), 'utf8')).toBe('local edits');
}, 15_000);
it('expires restore tokens and cleans only acknowledged old cached sources with an explicit limit', async () => {
  const f = fixture(), service = f.make(0, { release: async () => true }), rootId = await service.create('Cache', f.locals[0]);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'first'); const first = await service.publish(rootId, 'config.ini');
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'second'); await service.publish(rootId, 'config.ini');
  const entryId = service.files(rootId).items[0].entryId, preview = await service.prepareRestore(rootId, first);
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60_000);
  await expect(service.confirmRestore(preview.previewId)).rejects.toThrow('expired'); vi.restoreAllMocks();
  f.stores[0].get(rootId)!.acknowledge(first);
  const before = await service.cache(rootId); expect(before.removableBytes).toBe(5);
  const after = await service.cache(rootId, 0); expect(after.freedBytes).toBe(5);
  expect(service.history(rootId, entryId).items.find(r => r.revisionId === first)?.local).toBe(false);
  expect(fs.readFileSync(path.join(f.locals[0], 'config.ini'), 'utf8')).toBe('second');
});

it('rejects unauthenticated genesis before reserving a root or writing local metadata', async () => {
  const f = fixture(); await f.left.create('Configs', f.locals[0]);
  const offer = f.bus.shift()!; await f.right.receive(f.ids[0], offer.body);
  const request = f.bus.shift()!; await f.left.receive(f.ids[1], request.body);
  const page = f.bus.shift()!; if (page.body.kind !== 'page') throw new Error('Missing page');
  page.body.records[0].value.sig = Buffer.alloc(64).toString('base64');
  await expect(f.right.receive(f.ids[0], page.body)).rejects.toThrow();
  expect(f.right.list()).toEqual([]); expect(f.stores[1].size).toBe(0);
  expect(f.fetch).not.toHaveBeenCalled(); expect(fs.readdirSync(f.locals[1])).toEqual([]);
});

it('refuses overlapping local folders and stops further network operations on close', async () => {
  const f = fixture(); await f.left.create('Configs', f.locals[0]);
  await expect(f.left.create('Duplicate', f.locals[0])).rejects.toThrow('Overlapping');
  fs.mkdirSync(path.join(directory, 'private-0'), { recursive: true });
  await expect(f.left.create('Private storage', path.join(directory, 'private-0'))).rejects.toThrow('Overlapping');
  f.left.close(); await expect(f.left.peer(f.ids[1])).rejects.toThrow('paused');
});

it('does not suppress metadata discovery when resuming a source torrent fails', async () => {
  const f = fixture(), rootId = await f.left.create('Configs', f.locals[0]);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'source'); await f.left.publish(rootId, 'config.ini');
  f.left.close(); f.bus.length = 0;
  const restored = f.make(0, { seed: async () => { throw new Error('transient seed error'); } });
  await restored.peer(f.ids[1]);
  expect(f.bus.some(p => p.body.kind === 'offer')).toBe(true);
  expect(f.warnings.some(w => String(w).includes('transient'))).toBe(true);
});

it('uses an expiring reviewed folder token; confirmation starts with both automatic modes off', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'reviewed');
  fs.writeFileSync(path.join(f.locals[0], '.env'), 'excluded');
  const preview = await f.left.preview(f.locals[0], { kind: 'create', name: 'Reviewed' });
  expect(preview.localFiles).toBe(1); expect(preview.skipped).toBe(1); expect(f.left.view()).toEqual([]);
  await f.left.confirm(preview.previewId);
  expect(f.left.view()[0]).toMatchObject({ path: f.locals[0], autoPublish: false, autoApply: false, files: 0 });
  await expect(f.left.confirm(preview.previewId)).rejects.toThrow('expired');
});

it('requires a new review if the folder contents change before confirmation', async () => {
  const f = fixture(), preview = await f.left.preview(f.locals[0], { kind: 'create', name: 'Reviewed' });
  fs.writeFileSync(path.join(f.locals[0], 'new.ini'), 'not reviewed');
  await expect(f.left.confirm(preview.previewId)).rejects.toThrow('changed'); expect(f.left.view()).toEqual([]);
});

it('publishes file saves through the persistent watcher and restores the local mode', async () => {
  const f = fixture(), rootId = await f.left.create('Watched', f.locals[0]);
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'automatic save');
  await f.left.action(rootId, 'auto-publish', true);
  await vi.waitFor(() => expect(f.left.view()[0].files).toBe(1), { timeout: 15_000 });
  f.left.close(); await f.left.settled();
  const reopened = f.make(0); await reopened.restore(); expect(reopened.view()[0].autoPublish).toBe(true);
  const review = await reopened.preview(f.locals[0], { kind: 'bind', rootId });
  await reopened.confirm(review.previewId);
  expect(reopened.view()[0]).toMatchObject({ autoPublish: false, autoApply: false });
  fs.writeFileSync(path.join(f.locals[0], 'config.ini'), 'later save');
  await new Promise(resolve => setTimeout(resolve, 50)); expect(reopened.view()[0].files).toBe(1);
  await reopened.action(rootId, 'unbind'); expect(reopened.view()[0].path).toBeNull();
  expect(fs.readFileSync(path.join(f.locals[0], 'config.ini'), 'utf8')).toBe('later save');
}, 20_000);
