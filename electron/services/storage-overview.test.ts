import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { scanStorage, StorageOverviewController, type StorageRoot } from './storage-overview';
import type { StorageKind, StorageReport } from '../../shared/storage-overview';

let base: string;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-storage-census-')); });
afterEach(async () => {
  vi.restoreAllMocks(); const resolved = path.resolve(base);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('havvn-storage-census-')) throw Error('Unexpected fixture directory');
  await fs.promises.rm(resolved, { recursive: true, force: true });
});
const root = (candidate: string, kind: StorageKind, key?: string): StorageRoot => ({ path: candidate, kinds: [kind], key, locate: () => ({ kind }) });
const run = (roots: StorageRoot[], options = {}) => scanStorage('fixture', async () => ({ roots, issues: [] }), new AbortController().signal, () => {}, options);
const group = (report: StorageReport, kind: StorageKind) => report.groups.find(item => item.kind === kind)!;

it('enforces a time budget and reports cancellation before discovery as unknown', async () => {
  const timed = await scanStorage('time', async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { roots: [root(base, 'downloads')], issues: [] }; }, new AbortController().signal, () => {}, { durationMs: 1 });
  expect(timed.status).toBe('partial'); expect(timed.uniqueLogicalBytes).toBeNull();
  const canceled = new AbortController(); canceled.abort();
  const report = await scanStorage('canceled', async () => ({ roots: [], issues: [] }), canceled.signal);
  expect(report.status).toBe('canceled'); expect(report.uniqueLogicalBytes).toBeNull(); expect(group(report, 'downloads').issues).toContain('canceled');
});

it('deduplicates overlapping paths and hard links, marks shared bytes and never authorizes deletion', async () => {
  const data = path.join(base, 'data'); fs.mkdirSync(data); const source = path.join(data, 'one'); fs.writeFileSync(source, '1234567');
  fs.linkSync(source, path.join(data, 'two')); fs.writeFileSync(path.join(data, 'three'), 'abc');
  const write = vi.spyOn(fs.promises, 'writeFile'), remove = vi.spyOn(fs.promises, 'rm'), unlink = vi.spyOn(fs.promises, 'unlink');
  const report = await run([root(data, 'downloads', 'a'), root(source, 'downloads', 'b'), root(source, 'originals')]);
  expect(report.status).toBe('complete'); expect(report.uniqueLogicalBytes).toBe(10); expect(report.files).toBe(3);
  expect(group(report, 'downloads')).toMatchObject({ logicalBytes: 17, sharedBytes: 14, reclaimableBytes: null });
  expect(group(report, 'originals')).toMatchObject({ logicalBytes: 7, sharedBytes: 7, reclaimableBytes: null });
  expect(report.groups.every(item => item.reclaimableBytes === null)).toBe(true);
  expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(unlink).not.toHaveBeenCalled();
});
it('preserves both management targets for rooms sharing the same directory', async () => {
  fs.writeFileSync(path.join(base, 'copy'), '123');
  const roots = ['a', 'b'].map(id => ({ ...root(base, 'room-copies', id), locate: () => ({ kind: 'room-copies' as const, actions: [{ kind: 'room-data' as const, roomId: id, label: id }] }) }));
  const report = await run(roots); expect(report.uniqueLogicalBytes).toBe(3);
  expect(group(report, 'room-copies')).toMatchObject({ logicalBytes: 3, sharedBytes: 3 }); expect(group(report, 'room-copies').actions).toHaveLength(2);
});
it('stops at the time budget between ancestor reads before enumerating a root', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const stat = fs.promises.lstat.bind(fs.promises);
  const reads = vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.promises.lstat>) => {
    const result = await stat(...args); now += 20; return result;
  });
  const report = await run([root(base, 'downloads')], { durationMs: 10 });
  expect(reads).toHaveBeenCalledOnce(); expect(report.visited).toBe(0);
  expect(report.status).toBe('partial'); expect(group(report, 'downloads').logicalBytes).toBeNull();
});
it('does not follow a junction outside a managed root', async () => {
  const managed = path.join(base, 'managed'), outside = path.join(base, 'outside'); fs.mkdirSync(managed); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'original'), 'never count through a link'); fs.symlinkSync(outside, path.join(managed, 'link'), 'junction');
  const report = await run([root(managed, 'downloads')]);
  expect(report.status).toBe('partial'); expect(group(report, 'downloads')).toMatchObject({ logicalBytes: null, files: 0, issues: ['unsafe'] });
  expect(fs.readFileSync(path.join(outside, 'original'), 'utf8')).toBe('never count through a link');
});
it('reports access failures as unknown rather than zero', async () => {
  const open = fs.promises.opendir.bind(fs.promises);
  vi.spyOn(fs.promises, 'opendir').mockImplementation((...args: Parameters<typeof fs.promises.opendir>) => String(args[0]) === base ? Promise.reject(Object.assign(Error('denied'), { code: 'EACCES' })) : open(...args));
  const report = await run([root(base, 'downloads')]); expect(group(report, 'downloads')).toMatchObject({ logicalBytes: null, issues: ['access'] });
  expect(report.uniqueLogicalBytes).toBeNull(); expect(report.status).toBe('partial');
});
it('bounds enumeration, depth and registered roots', async () => {
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(base, 'file-' + i), 'x');
  const limited = await run([root(base, 'downloads')], { entries: 5 });
  expect(limited.visited).toBeLessThanOrEqual(5); expect(limited.status).toBe('partial'); expect(group(limited, 'downloads').issues).toContain('limit');
  const nested = path.join(base, 'nested', 'deeper'); fs.mkdirSync(nested, { recursive: true }); fs.writeFileSync(path.join(nested, 'x'), 'x');
  const depth = await run([root(path.join(base, 'nested'), 'backups')], { depth: 1 }); expect(group(depth, 'backups').issues).toContain('depth');
  const sources = await run([root(base, 'downloads'), root(base, 'originals')], { roots: 1 }); expect(group(sources, 'originals').logicalBytes).toBeNull();
});
it('cancels after the current read and prevents overlapping scans until it settles', async () => {
  const file = path.join(base, 'one'); fs.writeFileSync(file, 'x'); const stat = fs.promises.lstat.bind(fs.promises);
  let finish!: () => void, entered!: () => void;
  const pendingRead = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
  let blocked = false;
  vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.promises.lstat>) => {
    if (String(args[0]) === file && !blocked) { blocked = true; entered(); await gate; } return stat(...args);
  });
  const controller = new StorageOverviewController(async () => ({ roots: [root(base, 'downloads')], issues: [] }));
  const first = controller.scan('one'); await pendingRead; controller.cancel('wrong');
  await expect(controller.scan('two')).rejects.toThrow('already running'); controller.cancel('one');
  await expect(controller.scan('two')).rejects.toThrow('already running'); finish();
  expect((await first).status).toBe('canceled'); expect((await controller.scan('two')).status).toBe('complete');
});
it('marks a file disappearing after enumeration as changed', async () => {
  const file = path.join(base, 'gone'); fs.writeFileSync(file, 'x'); const stat = fs.promises.lstat.bind(fs.promises); let seen = false;
  vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.promises.lstat>) => {
    if (String(args[0]) === file && !seen) { seen = true; throw Object.assign(Error('gone'), { code: 'ENOENT' }); } return stat(...args);
  });
  const report = await run([root(base, 'downloads')]); expect(report.status).toBe('partial'); expect(group(report, 'downloads').issues).toContain('changed');
});
