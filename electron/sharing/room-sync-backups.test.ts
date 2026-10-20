import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db/secrets', () => ({ encryptSecret: () => { throw new Error('Use fixture persistence'); }, decryptSecretStrict: () => { throw new Error('Use fixture persistence'); } }));
import { RoomSyncStore, type SyncPersistence } from '../db/room-sync-store';
import { RoomSyncSession } from './room-sync-session';
import { RoomSyncApplier, withSyncApplyLock } from './room-sync-apply';
import { deriveMemberId } from './room-crypto';
import { previewSyncBackups, confirmSyncBackups, recoverSyncBackupPrunes, type SyncPruneStep } from './room-sync-backups';
import { DEFAULT_SYNC_BACKUP_POLICY, type SyncBackupPolicy } from '../../shared/room-file-sync-backups';

const pair = crypto.generateKeyPairSync('ed25519');
const identity = { pub: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
class Persistence implements SyncPersistence {
  data: unknown; fail = false;
  read() { return structuredClone(this.data); }
  write(value: unknown) { if (this.fail) throw new Error('disk full'); this.data = structuredClone(value); }
}
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-backup-test-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
const policy: SyncBackupPolicy = { enabled: false, keepVersions: 1, maxAgeDays: 0, limitBytes: 0 };
async function fixture(count = 4) {
  const context = { scope: 'backup-test', rootId: crypto.randomUUID(), ownerId: deriveMemberId(identity.pub), e2e: false };
  const out = new Persistence(), incoming = new Persistence();
  const source = path.join(directory, 'publisher'), folder = path.join(directory, 'receiver'); fs.mkdirSync(source); fs.mkdirSync(folder);
  const senderStore = new RoomSyncStore(out, 'sender', context), store = new RoomSyncStore(incoming, 'receiver', context);
  senderStore.bind(source); store.bind(folder); store.setAutoApply(true);
  const sender = new RoomSyncSession({ context, store: senderStore, storage: path.join(directory, 'out'), identity, isCurrent: () => true });
  const options = { context, store, storage: path.join(directory, 'in'), identity, isCurrent: () => true };
  const receiver = new RoomSyncSession(options);
  sender.createRoot('Backup fixture'); store.acceptPolicy(senderStore.policy());
  const base = path.join(folder, '.havvn-sync', 'transactions'); let order = 0;
  const add = async (value: string, name = 'config.ini') => {
    fs.writeFileSync(path.join(source, name), value); const published = await sender.publish(name);
    store.acceptRevision(published.revision);
    const receipt = await receiver.applyReceived(published.revision.revisionId, published.snapshot!.sourcePath, published.snapshot!.metadata);
    // Explicit timestamps give a stable ordering even on coarse-resolution file systems.
    const date = new Date(Date.now() + ++order * 1000); fs.utimesSync(path.join(base, receipt.operationId, 'receipt.json'), date, date);
    return published;
  };
  for (let i = 1; i <= count; i++) await add('version-' + i);
  const receipts = await new RoomSyncApplier(folder).recover(() => true);
  const preview = (p = policy, now?: number) => previewSyncBackups(store, p, () => true, now);
  return { folder, source, store, senderStore, sender, incoming, options, receiver, add, base, receipts, preview };
}

it('counts move backups by stable entry and never authorizes a forged old path', async () => {
  const f = await fixture(1), entryId = f.senderStore.heads()[0].entryId;
  await f.sender.changeWriters([deriveMemberId(identity.pub)], f.sender.rightsStamp(), true);
  f.store.acceptRecords(f.senderStore.records()); f.store.setAutoApply(true);
  for (const toPath of ['first.ini', 'nested/second.ini', 'third.ini']) {
    const move = await f.sender.moveFile(await f.sender.prepareMove(entryId, toPath));
    f.store.acceptRevision(move.revision); await f.receiver.applyReceived(move.revision.revisionId, move.snapshot.sourcePath, move.snapshot.metadata);
  }
  const plan = await f.preview(); expect(plan.summary.copies).toBe(3); expect(plan.selected).toHaveLength(2);
  const oldest = plan.rows.find(r => r.remove)!, journalPath = path.join(f.base, oldest.operationId, 'journal.json');
  const original = fs.readFileSync(journalPath, 'utf8'), forged = JSON.parse(original); forged.fromPath = 'unrelated.ini'; fs.writeFileSync(journalPath, JSON.stringify(forged));
  const tampered = await f.preview(); expect(tampered.rows.find(r => r.operationId === oldest.operationId)).toMatchObject({ remove: false, reason: 'unverified' });
  await expect(f.receiver.recoverApplied()).rejects.toThrow('authorized');
  fs.writeFileSync(journalPath, original);
  const clean = await f.preview(), result = await confirmSyncBackups(f.store, clean, () => true); expect(result.removedCopies).toBe(2);
  expect(fs.readFileSync(path.join(f.folder, 'third.ini'), 'utf8')).toBe('version-1');
  expect((await f.receiver.recoverApplied()).every(r => r.state === 'applied')).toBe(true);
});

it('prunes only reviewed old payloads, preserves journals and the latest copy, then recovers and accepts a future update', async () => {
  const f = await fixture(), separate = path.join(f.folder, '.havvn-local', 'mine.ini');
  fs.mkdirSync(path.dirname(separate)); fs.writeFileSync(separate, 'my local work');
  const plan = await f.preview(); expect(plan.selected).toHaveLength(2); expect(plan.summary.copies).toBe(3);
  expect(plan.rows.filter(r => !r.remove)).toHaveLength(1); expect(plan.rows[0].reason).toBe('current');
  const result = await confirmSyncBackups(f.store, plan, () => true);
  expect(result).toMatchObject({ removedCopies: 2, removedBytes: 18 }); expect(result.error).toBeUndefined();
  expect(fs.readFileSync(path.join(f.folder, 'config.ini'), 'utf8')).toBe('version-4'); expect(fs.readFileSync(separate, 'utf8')).toBe('my local work');
  for (const receipt of f.receipts) { expect(fs.existsSync(path.join(f.base, receipt.operationId, 'journal.json'))).toBe(true); expect(fs.existsSync(path.join(f.base, receipt.operationId, 'receipt.json'))).toBe(true); }
  expect((await new RoomSyncSession(f.options).recoverApplied()).filter(r => r.state === 'applied')).toHaveLength(4);
  await f.add('version-5'); expect(fs.readFileSync(path.join(f.folder, 'config.ini'), 'utf8')).toBe('version-5');
  expect((await f.preview()).selected).toHaveLength(1);
});
it('applies count, age and budget limits while keeping a minimum backup per file', async () => {
  const f = await fixture(); await f.add('other-1', 'other.ini'); await f.add('other-2', 'other.ini');
  const roomy = { ...policy, keepVersions: 10, limitBytes: 1024 ** 3 };
  expect((await f.preview(roomy)).selected).toHaveLength(0);
  const byCount = await f.preview({ ...roomy, keepVersions: 2 }); expect(byCount.selected).toHaveLength(1); expect(byCount.rows.some(r => r.reason === 'count')).toBe(true);
  const byAge = await f.preview({ ...roomy, maxAgeDays: 1 }, Date.now() + 10 * 86400_000);
  expect(byAge.selected).toHaveLength(2); expect(byAge.rows.filter(r => r.remove).every(r => r.reason === 'age')).toBe(true);
  const byBudget = await f.preview({ ...roomy, limitBytes: 0 }); expect(byBudget.selected).toHaveLength(2);
  expect(new Set(byBudget.rows.filter(r => !r.remove).map(r => r.path))).toEqual(new Set(['config.ini', 'other.ini']));
  expect(byBudget.summary.protectedBytes).toBeGreaterThan(0);
});
it.each(['unfinished', 'rolled-back', 'unknown', 'unverified', 'linked'] as const)('preserves %s operations and reports incomplete inventories', async kind => {
  const f = await fixture(), initial = await f.preview(), old = initial.rows.find(r => r.remove)!;
  const dir = path.join(f.base, old.operationId), file = path.join(dir, 'previous');
  const original = fs.readFileSync(file, 'utf8');
  if (kind === 'unfinished') fs.unlinkSync(path.join(dir, 'receipt.json'));
  if (kind === 'rolled-back') { const p = path.join(dir, 'receipt.json'), receipt = JSON.parse(fs.readFileSync(p, 'utf8')); receipt.state = 'rolled-back'; fs.writeFileSync(p, JSON.stringify(receipt)); }
  if (kind === 'unknown') fs.mkdirSync(path.join(dir, 'editor-data'));
  if (kind === 'unverified') fs.writeFileSync(path.join(dir, 'journal.json'), '{}');
  if (kind === 'linked') fs.linkSync(file, path.join(directory, 'external-link'));
  const plan = await f.preview(); expect(plan.rows.find(r => r.operationId === old.operationId)?.remove).toBe(false);
  await confirmSyncBackups(f.store, plan, () => true); expect(fs.readFileSync(file, 'utf8')).toBe(original);
  if (kind === 'unknown') expect(plan.summary.unscanned).toBeGreaterThan(0);
});
it('protects edited payloads and promotes an older valid anchor if the latest backup changed', async () => {
  const f = await fixture(), initial = await f.preview(), latest = initial.rows.find(r => !r.remove)!;
  fs.writeFileSync(path.join(f.base, latest.operationId, 'previous'), 'edited backup');
  const plan = await f.preview(); expect(plan.rows.find(r => r.operationId === latest.operationId)).toMatchObject({ remove: false, reason: 'changed' });
  expect(plan.rows.filter(r => r.reason === 'latest')).toHaveLength(1); expect(plan.selected).toHaveLength(1);
  await confirmSyncBackups(f.store, plan, () => true); expect(fs.readFileSync(path.join(f.base, latest.operationId, 'previous'), 'utf8')).toBe('edited backup');
});
it('never follows a junction outside the backup directory', async () => {
  const f = await fixture(), external = path.join(directory, 'external'); fs.mkdirSync(external);
  const keep = path.join(external, 'previous'); fs.writeFileSync(keep, 'external user data');
  fs.symlinkSync(external, path.join(f.base, 'op-foreign'), process.platform === 'win32' ? 'junction' : 'dir');
  const plan = await f.preview(); expect(plan.summary.unscanned).toBeGreaterThan(0);
  await confirmSyncBackups(f.store, plan, () => true); expect(fs.readFileSync(keep, 'utf8')).toBe('external user data');
});
it.each(['payload', 'binding', 'settings', 'head', 'cancel'] as const)('rejects a stale review after %s before deleting anything', async change => {
  const f = await fixture(), plan = await f.preview(), victim = path.join(f.base, plan.selected[0].operationId, 'previous');
  if (change === 'payload') fs.writeFileSync(victim, 'changed');
  if (change === 'binding') { f.store.bind(null); f.store.bind(f.folder); }
  if (change === 'settings') f.store.setBackupPolicy({ ...DEFAULT_SYNC_BACKUP_POLICY });
  if (change === 'head') await f.add('version-5');
  // The default stored policy already differs from the review policy; force an actual settings change.
  if (change === 'settings') f.store.setBackupPolicy({ ...policy, keepVersions: 7 });
  await expect(confirmSyncBackups(f.store, plan, () => change !== 'cancel')).rejects.toThrow();
  expect(fs.existsSync(victim)).toBe(true); expect(fs.existsSync(path.join(path.dirname(victim), 'prune.json'))).toBe(false);
});
it('does not delete any payload if durable policy persistence fails', async () => {
  const f = await fixture(), plan = await f.preview(); f.incoming.fail = true;
  await expect(confirmSyncBackups(f.store, plan, () => true)).rejects.toThrow('disk full');
  for (const copy of plan.selected) expect(fs.existsSync(path.join(f.base, copy.operationId, 'previous'))).toBe(true);
});
it('stops if an editor changes the protected last copy during cleanup', async () => {
  const f = await fixture(), plan = await f.preview(), anchor = plan.selected[0].anchor; let staged = '';
  const result = await confirmSyncBackups(f.store, plan, () => true, (step, dir) => {
    if (step === 'moved') { staged = dir; fs.writeFileSync(path.join(f.base, anchor.operationId, 'previous'), 'late editor change'); }
  });
  expect(result.removedCopies).toBe(0); expect(result.error).toContain('last backup changed');
  expect(fs.existsSync(path.join(staged, 'previous.pruning'))).toBe(true);
  await recoverSyncBackupPrunes(f.store, () => true); expect(fs.existsSync(path.join(staged, 'previous'))).toBe(true);
});
it.each(['intent', 'linked', 'moved', 'deleted'] as SyncPruneStep[])('recovers pruning interrupted at %s, retaining recovery metadata', async stop => {
  const f = await fixture(), plan = await f.preview(); let interrupted = '';
  const result = await confirmSyncBackups(f.store, plan, () => true, (step, dir) => { if (step === stop) { interrupted = dir; throw new Error('simulated crash'); } });
  expect(result.error).toBe('simulated crash'); expect(fs.existsSync(path.join(interrupted, 'prune.json'))).toBe(true);
  await recoverSyncBackupPrunes(f.store, () => true);
  expect(fs.existsSync(path.join(interrupted, 'prune.json'))).toBe(false); expect(fs.existsSync(path.join(interrupted, 'previous.pruning'))).toBe(false);
  expect(fs.existsSync(path.join(interrupted, 'previous'))).toBe(stop !== 'deleted');
  expect(fs.existsSync(path.join(interrupted, 'journal.json'))).toBe(true); expect(fs.existsSync(path.join(interrupted, 'receipt.json'))).toBe(true);
  expect(result.removedCopies).toBe(stop === 'deleted' ? 1 : 0);
  await new RoomSyncSession(f.options).recoverApplied(); await f.add('version-5');
});
it('returns edited staged bytes on recovery and never overwrites a competing previous file', async () => {
  const f = await fixture(), plan = await f.preview(); let dir = '';
  await confirmSyncBackups(f.store, plan, () => true, (step, location) => { if (step === 'moved') { dir = location; fs.writeFileSync(path.join(dir, 'previous.pruning'), 'editor changed staged copy'); throw new Error('interrupt'); } });
  await recoverSyncBackupPrunes(f.store, () => true);
  expect(fs.readFileSync(path.join(dir, 'previous'), 'utf8')).toBe('editor changed staged copy');
  const next = await f.preview();
  await confirmSyncBackups(f.store, next, () => true, (step, location) => { if (step === 'moved') { dir = location; fs.writeFileSync(path.join(dir, 'previous'), 'competing file'); throw new Error('interrupt'); } });
  await recoverSyncBackupPrunes(f.store, () => true);
  expect(fs.readFileSync(path.join(dir, 'previous'), 'utf8')).toBe('competing file'); expect(fs.existsSync(path.join(dir, 'previous.pruning'))).toBe(true);
  expect((await f.preview()).rows.find(r => r.operationId === path.basename(dir))?.remove).toBe(false);
});
it('shares the per-folder lock with apply operations', async () => {
  const f = await fixture(); let unlock!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const locked = withSyncApplyLock(f.folder, async () => { started(); await new Promise<void>(resolve => { unlock = resolve; }); }); await entered;
  let finished = false; const job = f.preview().then(p => { finished = true; return p; });
  await new Promise(resolve => setTimeout(resolve, 20)); expect(finished).toBe(false); unlock(); await locked; await job; expect(finished).toBe(true);
});

it.each(['write', 'crash'])('retries backup pruning after incomplete metadata: %s', async mode => {
  const f = await fixture(), plan = await f.preview(), saved = new Map(plan.selected.map(copy => [copy.operationId, fs.readFileSync(path.join(f.base, copy.operationId, 'previous'), 'utf8')]));
  if (mode === 'write') {
    const write = fs.promises.writeFile.bind(fs.promises);
    const fault = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      if (path.basename(String(file)).startsWith('prune.json')) { await write(file, '{"partial":', options); throw Object.assign(Error('No space left'), { code: 'ENOSPC' }); }
      return write(file, data, options);
    });
    const failed = await confirmSyncBackups(f.store, plan, () => true); expect(failed.removedCopies).toBe(0); expect(failed.error).toContain('No space'); fault.mockRestore();
  } else fs.writeFileSync(path.join(f.base, plan.selected[0].operationId, 'prune.json.tmp-' + crypto.randomUUID()), '{"partial":');
  const retried = await f.preview(); expect(retried.selected).toHaveLength(plan.selected.length);
  for (const [id, content] of saved) expect(fs.readFileSync(path.join(f.base, id, 'previous'), 'utf8')).toBe(content);
  expect(fs.readFileSync(path.join(f.folder, 'config.ini'), 'utf8')).toBe('version-4');
});
