import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { scanSyncFolder, excludedSyncPath } from '../electron/sharing/room-sync-watcher';
import { assertSyncPlainPath, syncFileDigest } from '../electron/sharing/room-sync-snapshot';
import { validSyncRelativePath } from '../shared/room-file-sync';
const api = { scanSyncFolder, excludedSyncPath, assertSyncPlainPath, syncFileDigest, validSyncRelativePath };
const kit = createRequire(import.meta.url)('./room-sync-acceptance.cjs') as {
  prepare(folder: string, api: typeof api): { publisher: string; receiver: string; reports: string };
  manifest(folder: string, output: string, api: typeof api): Promise<{ files: Array<{ path: string; size: number; sha256: string }>; skipped: number }>;
  compare(left: string, right: string, api: typeof api): { equal: boolean; differences: Array<{ path: string; reason: string }> };
};
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sync-acceptance-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
it('prepares seven real payloads and three synthetic exclusions without writing into the receiver', async () => {
  const f = kit.prepare(path.join(root, 'new-pilot'), api);
  expect(fs.readdirSync(f.receiver)).toEqual([]);
  const report = await kit.manifest(f.publisher, path.join(f.reports, 'publisher.json'), api);
  expect(report.files).toHaveLength(7); expect(report.skipped).toBe(3);
  expect(report.files.find(f => f.path === 'empty.txt')?.size).toBe(0);
  expect(report.files.some(f => f.path.includes('Папка с пробелами'))).toBe(true);
  expect(() => kit.prepare(path.join(root, 'new-pilot'), api)).toThrow();
});
it('detects exact content equality, changed bytes and missing files', async () => {
  const f = kit.prepare(path.join(root, 'pilot'), api), left = path.join(f.reports, 'a.json'), right = path.join(f.reports, 'b.json');
  fs.cpSync(f.publisher, f.receiver, { recursive: true }); await kit.manifest(f.publisher, left, api); await kit.manifest(f.receiver, right, api);
  expect(kit.compare(left, right, api).equal).toBe(true);
  fs.writeFileSync(path.join(f.receiver, 'config.ini'), 'local independent edits'); fs.unlinkSync(path.join(f.receiver, 'empty.txt'));
  const changed = path.join(f.reports, 'changed.json'); await kit.manifest(f.receiver, changed, api);
  expect(kit.compare(left, changed, api)).toMatchObject({ equal: false, differences: [{ path: 'config.ini', reason: 'content' }, { path: 'empty.txt', reason: 'missing-right' }] });
});
it('refuses overwritten reports and reports placed inside the working folder', async () => {
  const f = kit.prepare(path.join(root, 'pilot'), api), output = path.join(f.reports, 'report.json');
  fs.writeFileSync(output, 'existing evidence');
  await expect(kit.manifest(f.publisher, output, api)).rejects.toThrow(); expect(fs.readFileSync(output, 'utf8')).toBe('existing evidence');
  await expect(kit.manifest(f.publisher, path.join(f.publisher, 'report.json'), api)).rejects.toThrow('outside');
});
it('refuses an unstable snapshot and never traverses a junction', async () => {
  const f = kit.prepare(path.join(root, 'pilot'), api), external = path.join(root, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'secret.txt'), 'outside');
  fs.symlinkSync(external, path.join(f.publisher, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const safe = await kit.manifest(f.publisher, path.join(f.reports, 'safe.json'), api); expect(safe.files).toHaveLength(7);
  let changed = false;
  await expect(kit.manifest(f.publisher, path.join(f.reports, 'unstable.json'), { ...api, syncFileDigest: async file => {
    const result = await syncFileDigest(file); if (!changed) { changed = true; fs.appendFileSync(file, 'late editor save'); } return result;
  } })).rejects.toThrow('changed');
  expect(fs.existsSync(path.join(f.reports, 'unstable.json'))).toBe(false);
});
it('rejects traversal and duplicate paths in supplied manifests', () => {
  const a = path.join(root, 'a.json'), b = path.join(root, 'b.json');
  const file = { path: '../outside', size: 1, sha256: 'a'.repeat(64) };
  fs.writeFileSync(a, JSON.stringify({ v: 1, kind: 'havvn-sync-content', files: [file] })); fs.copyFileSync(a, b);
  expect(() => kit.compare(a, b, api)).toThrow('Invalid');
  fs.writeFileSync(a, JSON.stringify({ v: 1, kind: 'havvn-sync-content', files: [{ ...file, path: 'a.txt' }, { ...file, path: 'A.txt' }] }));
  expect(() => kit.compare(a, b, api)).toThrow('Duplicate');
});
