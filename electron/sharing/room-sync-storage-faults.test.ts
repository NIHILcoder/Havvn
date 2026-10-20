import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoomSyncApplier } from './room-sync-apply';
import { RoomSyncTrash } from './room-sync-trash';

let root: string, source: string, receiver: string, target: string;
const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const request = () => ({ relativePath: 'project.csproj', revisionId: digest('revision'), source, digest: digest('new project'), expectedDigest: digest('old project') });
const full = () => Object.assign(new Error('No space left on test device'), { code: 'ENOSPC' });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-storage-faults-'));
  source = path.join(root, 'source'); receiver = path.join(root, 'receiver'); target = path.join(receiver, 'project.csproj');
  fs.mkdirSync(receiver); fs.writeFileSync(source, 'new project'); fs.writeFileSync(target, 'old project');
});
afterEach(() => {
  vi.restoreAllMocks(); expect(path.dirname(root)).toBe(fs.realpathSync(os.tmpdir())); expect(path.basename(root)).toMatch(/^havvn-storage-faults-/);
  fs.rmSync(root, { recursive: true, force: true });
});
function failRecord(prefix: string) {
  const write = fs.promises.writeFile.bind(fs.promises);
  return vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
    if (path.basename(String(file)).startsWith(prefix)) { await write(file, '{"partial":', options); throw full(); }
    return write(file, data, options);
  });
}
it('keeps the original when staging runs out of space and permits a clean retry', async () => {
  const copy = fs.promises.copyFile.bind(fs.promises);
  const fault = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, flags) => {
    if (String(to).endsWith(path.sep + 'next')) { fs.writeFileSync(to, 'partial'); throw full(); }
    return copy(from, to, flags);
  });
  await expect(new RoomSyncApplier(receiver).apply(request())).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(fs.readFileSync(target, 'utf8')).toBe('old project');
  expect(fs.readdirSync(path.join(receiver, '.havvn-sync/transactions'))).toEqual([]);
  fault.mockRestore(); expect((await new RoomSyncApplier(receiver).apply(request())).state).toBe('applied');
});
it('removes an incomplete journal without touching the old working file', async () => {
  const fault = failRecord('journal.json');
  await expect(new RoomSyncApplier(receiver).apply(request())).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(fs.readFileSync(target, 'utf8')).toBe('old project');
  expect(fs.readdirSync(path.join(receiver, '.havvn-sync/transactions'))).toEqual([]);
  fault.mockRestore(); expect((await new RoomSyncApplier(receiver).apply(request())).state).toBe('applied');
});
it('recovers a published file after disk-full interrupts its receipt, retaining the previous version', async () => {
  const fault = failRecord('receipt.json');
  await expect(new RoomSyncApplier(receiver).apply(request())).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(fs.readFileSync(target, 'utf8')).toBe('new project'); fault.mockRestore();
  const applier = new RoomSyncApplier(receiver), [receipt] = await applier.recover();
  expect(receipt.state).toBe('applied'); expect(fs.readFileSync(receipt.previousPath!, 'utf8')).toBe('old project');
  expect(await applier.recover()).toEqual([receipt]);
});
it('restores the original after access is denied between saving it and publishing the replacement', async () => {
  const link = fs.promises.link.bind(fs.promises);
  const fault = vi.spyOn(fs.promises, 'link').mockImplementation(async (from, to) => {
    if (String(to) === target) throw Object.assign(Error('Test access denied'), { code: 'EACCES' });
    return link(from, to);
  });
  await expect(new RoomSyncApplier(receiver).apply(request())).rejects.toMatchObject({ code: 'EACCES' });
  fault.mockRestore(); expect((await new RoomSyncApplier(receiver).recover())[0].state).toBe('rolled-back');
  expect(fs.readFileSync(target, 'utf8')).toBe('old project'); expect((await new RoomSyncApplier(receiver).apply(request())).state).toBe('applied');
});
it('preserves the working file if the source disappears before the copy', async () => {
  const copy = fs.promises.copyFile.bind(fs.promises);
  const fault = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, flags) => {
    fs.unlinkSync(source); return copy(from, to, flags);
  });
  await expect(new RoomSyncApplier(receiver).apply(request())).rejects.toMatchObject({ code: 'ENOENT' });
  expect(fs.readFileSync(target, 'utf8')).toBe('old project'); fault.mockRestore();
  fs.writeFileSync(source, 'new project'); expect((await new RoomSyncApplier(receiver).apply(request())).state).toBe('applied');
});
it('can retry recovery itself after disk space runs out while saving its receipt', async () => {
  await expect(new RoomSyncApplier(receiver).apply(request(), step => { if (step === 'published') throw Error('Fixture interrupted'); })).rejects.toThrow('interrupted');
  const fault = failRecord('receipt.json');
  await expect(new RoomSyncApplier(receiver).recover()).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(fs.readFileSync(target, 'utf8')).toBe('new project'); fault.mockRestore();
  const [receipt] = await new RoomSyncApplier(receiver).recover(); expect(receipt.state).toBe('applied');
  expect(fs.readFileSync(receipt.previousPath!, 'utf8')).toBe('old project');
});

const trashRequest = () => ({ v: 1 as const, relativePath: 'project.csproj', revisionId: digest('delete'), baseRevisionId: digest('base'), expectedDigest: digest('old project') });
const operation = (kind: string) => { const base = path.join(receiver, '.havvn-sync', kind); return path.join(base, fs.readdirSync(base)[0]); };
it.each(['journal.json', 'receipt.json'])('retries trash after disk-full interrupts %s', async record => {
  const fault = failRecord(record);
  await expect(new RoomSyncTrash(receiver).remove(trashRequest(), () => true, () => true)).rejects.toMatchObject({ code: 'ENOSPC' });
  fault.mockRestore(); const recovered = await new RoomSyncTrash(receiver).recover(() => true);
  if (record === 'journal.json') {
    expect(fs.readFileSync(target, 'utf8')).toBe('old project');
    expect(fs.readdirSync(path.join(receiver, '.havvn-sync', 'trash'))).toEqual([]);
    expect((await new RoomSyncTrash(receiver).remove(trashRequest(), () => true, () => true)).state).toBe('deleted');
  } else expect(recovered[0].state).toBe('deleted');
  expect(fs.readFileSync(path.join(operation('trash'), 'previous'), 'utf8')).toBe('old project');
});
async function interrupt(kind: string) {
  if (kind === 'apply') await expect(new RoomSyncApplier(receiver).apply(request(), step => { if (step === 'published') throw Error('Fixture exit'); })).rejects.toThrow('Fixture exit');
  else await expect(new RoomSyncTrash(receiver).remove(trashRequest(), () => true, () => true, async step => { if (step === 'previous-saved') throw Error('Fixture exit'); })).rejects.toThrow('Fixture exit');
  return operation(kind === 'apply' ? 'transactions' : 'trash');
}
it.each(['apply', 'trash'])('removes only generated partial record temps after %s process exit', async kind => {
  const directory = await interrupt(kind), staged = path.join(directory, 'receipt.json.tmp-' + crypto.randomUUID()), unrelated = path.join(directory, 'receipt.json.tmp-user-note');
  fs.writeFileSync(staged, '{"partial":'); fs.writeFileSync(unrelated, 'keep this note');
  if (kind === 'apply') expect((await new RoomSyncApplier(receiver).recover(() => true))[0].state).toBe('applied');
  else expect((await new RoomSyncTrash(receiver).recover(() => true))[0].state).toBe('deleted');
  expect(fs.existsSync(staged)).toBe(false); expect(fs.readFileSync(unrelated, 'utf8')).toBe('keep this note');
  expect(fs.readFileSync(path.join(directory, 'previous'), 'utf8')).toBe('old project');
});
it('removes an incomplete journal temp before publication while retaining unpublished bytes', async () => {
  const directory = path.join(receiver, '.havvn-sync', 'transactions', 'op-orphan'); fs.mkdirSync(directory, { recursive: true });
  const staged = path.join(directory, 'journal.json.tmp-' + crypto.randomUUID()); fs.writeFileSync(staged, '{'); fs.writeFileSync(path.join(directory, 'next'), 'unpublished');
  expect(await new RoomSyncApplier(receiver).recover()).toEqual([]); expect(fs.existsSync(staged)).toBe(false);
  expect(fs.readFileSync(path.join(directory, 'next'), 'utf8')).toBe('unpublished'); expect(fs.readFileSync(target, 'utf8')).toBe('old project');
});
it.each(['apply', 'trash'])('preserves staged records when the %s journal is unauthorized', async kind => {
  const directory = await interrupt(kind), staged = path.join(directory, 'receipt.json.tmp-' + crypto.randomUUID()); fs.writeFileSync(staged, '{');
  const recovery = kind === 'apply' ? new RoomSyncApplier(receiver).recover(() => false) : new RoomSyncTrash(receiver).recover(() => false);
  await expect(recovery).rejects.toThrow('authorized'); expect(fs.existsSync(staged)).toBe(true);
  expect(fs.readFileSync(path.join(directory, 'previous'), 'utf8')).toBe('old project');
});
it('preserves oversized generated-looking record temps for explicit review', async () => {
  const directory = await interrupt('apply'), staged = path.join(directory, 'receipt.json.tmp-' + crypto.randomUUID()); fs.writeFileSync(staged, Buffer.alloc(32768));
  await expect(new RoomSyncApplier(receiver).recover()).rejects.toThrow('Review invalid staged'); expect(fs.existsSync(staged)).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).toBe('new project'); expect(fs.readFileSync(path.join(directory, 'previous'), 'utf8')).toBe('old project');
});
