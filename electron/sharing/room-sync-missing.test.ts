import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db/secrets', () => ({ encryptSecret: () => { throw new Error('fixture'); }, decryptSecretStrict: () => { throw new Error('fixture'); } }));
import { RoomSyncStore } from '../db/room-sync-store';
import { RoomSyncSession } from './room-sync-session';
import { RoomSyncMissing } from './room-sync-missing';
import { scanSyncFolder } from './room-sync-watcher';
import { deriveMemberId } from './room-crypto';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sync-missing-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
async function fixture(names = ['a.ini', 'b.ini', 'keep.ini']) {
  const keys = crypto.generateKeyPairSync('ed25519'), identity = {
    pub: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const self = deriveMemberId(identity.pub), rootId = crypto.randomUUID(), context = { rootId, scope: 'missing-fixture', ownerId: self, e2e: false };
  let data: unknown, now = 1000;
  const store = new RoomSyncStore({ read: () => structuredClone(data), write: v => { data = structuredClone(v); } }, 'local', context);
  const folder = path.join(directory, 'working'); fs.mkdirSync(folder); store.bind(folder);
  const session = new RoomSyncSession({ context, store, storage: path.join(directory, 'storage'), identity, isCurrent: () => true });
  session.createRoot('Fixture'); await session.changeWriters([self], session.rightsStamp(), true, true);
  for (const name of names) { fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true }); fs.writeFileSync(path.join(folder, name), name); await session.publish(name); }
  const detector = new RoomSyncMissing(rootId, store, self, () => now);
  const scan = async () => detector.update(await scanSyncFolder(folder, () => true, store.exclusions()));
  const advance = () => { now += 4000; };
  await scan();
  return { detector, scan, advance, store, session, folder };
}
it('requires two complete separated scans, forgets temporary absences and never publishes from scanning', async () => {
  const f = await fixture(), heads = f.store.heads(), target = path.join(f.folder, 'a.ini');
  fs.renameSync(target, target + '.tmp'); expect((await f.scan()).waiting).toBe(1); f.advance();
  fs.renameSync(target + '.tmp', target); expect((await f.scan()).items).toEqual([]);
  fs.unlinkSync(target); expect((await f.scan()).items).toEqual([]); f.advance();
  expect((await f.scan()).items.map(row => row.path)).toEqual(['a.ini']); expect(f.store.heads()).toEqual(heads);
});
it('blocks missing roots, incomplete scans and all-file loss; requires fresh observations after a failure', async () => {
  const f = await fixture(); fs.unlinkSync(path.join(f.folder, 'a.ini')); await f.scan(); f.advance(); expect((await f.scan()).items).toHaveLength(1);
  expect(f.detector.update(null).blocked).toBe('unavailable'); expect((await f.scan()).items).toEqual([]); f.advance();
  const scan = await scanSyncFolder(f.folder); expect(f.detector.update({ ...scan, complete: false }).blocked).toBe('incomplete');
  fs.unlinkSync(path.join(f.folder, 'b.ini')); fs.unlinkSync(path.join(f.folder, 'keep.ini'));
  expect((await f.scan()).blocked).toBe('all'); expect(f.detector.read().items).toEqual([]);
});
it('blocks the whole review when a subdirectory disappears, even with unrelated missing files', async () => {
  const f = await fixture(['sub/a.ini', 'b.ini', 'keep.ini']);
  fs.renameSync(path.join(f.folder, 'sub'), path.join(directory, 'moved-sub')); fs.unlinkSync(path.join(f.folder, 'b.ini'));
  expect((await f.scan()).blocked).toBe('directory'); f.advance(); expect((await f.scan()).items).toEqual([]);
});
it('detects replacement of the root and requires a new binding to establish its identity', async () => {
  const f = await fixture(); fs.renameSync(f.folder, path.join(directory, 'old-working')); fs.mkdirSync(f.folder); fs.writeFileSync(path.join(f.folder, 'keep.ini'), 'keep');
  expect((await f.scan()).blocked).toBe('changed'); f.advance(); expect((await f.scan()).blocked).toBe('changed');
  f.store.setExclusions(['unused.log']); expect((await f.scan()).blocked).toBe('changed');
  f.store.bind(null); f.detector.update(null); f.store.bind(f.folder); expect((await f.scan()).blocked).not.toBe('changed');
});
it('treats links, renamed case variants and excluded paths as occupied rather than deletions', async () => {
  const f = await fixture(); const target = path.join(f.folder, 'a.ini'), outside = path.join(directory, 'outside.ini');
  fs.writeFileSync(outside, 'outside'); fs.unlinkSync(target); fs.linkSync(outside, target);
  expect((await f.scan()).waiting).toBe(0); f.advance(); expect((await f.scan()).items).toEqual([]);
  fs.unlinkSync(target); f.store.setExclusions(['a.ini']); expect((await f.scan()).items).toEqual([]);
  f.store.setExclusions([]); fs.renameSync(path.join(f.folder, 'b.ini'), path.join(f.folder, 'B.INI'));
  await f.scan(); f.advance(); expect((await f.scan()).items.map(row => row.path)).toEqual(['a.ini']);
});
it('marks both absolute and proportional mass disappearances and excludes deferred or unapplied bases', async () => {
  const f = await fixture(['a.ini', 'b.ini', 'c.ini', 'd.ini', 'e.ini', 'f.ini', 'keep.ini']);
  fs.unlinkSync(path.join(f.folder, 'a.ini')); fs.unlinkSync(path.join(f.folder, 'b.ini')); await f.scan(); f.advance(); expect((await f.scan()).mass).toBe(true);
  const entry = f.store.heads().find(h => f.store.revision(h.revisionIds[0])?.relativePath === 'a.ini')!;
  f.store.defer(entry.entryId); await f.scan(); f.advance(); expect((await f.scan()).items.map(row => row.path)).toEqual(['b.ini']);
});
it('invalidates missing observations when the signed base or exclusions change', async () => {
  const f = await fixture(); fs.unlinkSync(path.join(f.folder, 'a.ini')); await f.scan(); f.advance(); const before = await f.scan(); expect(before.items).toHaveLength(1);
  f.store.setExclusions(['unused.log']); expect((await f.scan()).items).toEqual([]); f.advance(); const after = await f.scan(); expect(after.stamp).not.toBe(before.stamp);
});
it('guards root and parent identities and rejects reappearing files before signing a deletion', async () => {
  const f = await fixture(['sub/a.ini', 'keep.ini']), target = path.join(f.folder, 'sub/a.ini');
  fs.unlinkSync(target); await f.scan(); f.advance(); await f.scan(); const current = f.detector.diskGuard('sub/a.ini'); expect(current()).toBe(true);
  const entry = f.store.heads().find(h => f.store.revision(h.revisionIds[0])?.relativePath === 'sub/a.ini')!, guard = await f.session.prepareDelete(entry.entryId);
  fs.renameSync(path.join(f.folder, 'sub'), path.join(directory, 'old-sub')); fs.mkdirSync(path.join(f.folder, 'sub'));
  expect(current()).toBe(false); await expect(f.session.confirmDelete(guard, false, current)).rejects.toThrow('changed');
  expect(f.store.heads().find(h => h.entryId === entry.entryId)?.revisionIds).toEqual(entry.revisionIds);
});
