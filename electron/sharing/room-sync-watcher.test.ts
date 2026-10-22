import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoomSyncWatcher, scanSyncFolder, excludedSyncPath } from './room-sync-watcher';
import { syncFileDigest } from './room-sync-snapshot';

let folder: string;
const watchers: RoomSyncWatcher[] = [];
beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sync-watch-'));
  // Exercise the mandatory scan fallback, independent of OS native-event timing.
  vi.spyOn(fs, 'watch').mockImplementation(() => { throw new Error('Native watcher unavailable'); });
});
afterEach(async () => {
  watchers.forEach(w => w.close()); await Promise.all(watchers.splice(0).map(w => w.idle()));
  vi.restoreAllMocks(); fs.rmSync(folder, { recursive: true, force: true });
});
function fixture() {
  const pending = new Set<string>(), digests = new Map<string, string>(), published: string[] = [], issues: unknown[] = [];
  let fail = false;
  const options = { folder, current: () => true, settleMs: 30, intervalMs: 60,
    pending: () => [...pending], enqueue: (names: string[]) => { names.forEach(p => pending.add(p)); }, complete: (p: string) => { pending.delete(p); },
    digest: (p: string) => digests.get(p),
    publish: vi.fn(async (p: string, current: () => boolean) => {
      if (fail) throw new Error('temporary disk failure');
      if (!current()) throw new Error('canceled');
      digests.set(p, await syncFileDigest(path.join(folder, ...p.split('/')))); published.push(p);
    }),
    issue: (error: unknown) => { issues.push(error); } };
  const start = () => { const w = new RoomSyncWatcher(options); watchers.push(w); return w; };
  return { start, options, pending, digests, published, issues, failure: (value: boolean) => { fail = value; } };
}
const eventually = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: 10_000, interval: 20 });

it('publishes stable initial files, deduplicates unchanged bytes and detects rename-based saves without native events', async () => {
  const file = path.join(folder, 'config.ini'); fs.writeFileSync(file, 'first');
  const f = fixture(), w = f.start(); await eventually(() => expect(f.published).toEqual(['config.ini']));
  fs.writeFileSync(file, 'first'); w.rescan(true);
  await eventually(() => expect(f.pending.size).toBe(0));
  const temporary = path.join(folder, 'config.ini.tmp'); fs.writeFileSync(temporary, 'second');
  fs.renameSync(temporary, file); w.rescan();
  await eventually(() => expect(f.published).toEqual(['config.ini', 'config.ini']));
  fs.unlinkSync(file); w.rescan(); await new Promise(resolve => setTimeout(resolve, 120));
  expect(f.published).toHaveLength(2); expect(f.pending.size).toBe(0);
}, 15_000);

it('reconstructs and retries durable work after a watcher restart', async () => {
  fs.writeFileSync(path.join(folder, 'config.ini'), 'pending save');
  const f = fixture(); f.failure(true); const first = f.start();
  await eventually(() => expect(f.issues.some(e => String(e).includes('disk failure'))).toBe(true));
  expect([...f.pending]).toEqual(['config.ini']); first.close(); await first.idle();
  f.failure(false); f.start();
  await eventually(() => expect(f.published).toEqual(['config.ini'])); expect(f.pending.size).toBe(0);
}, 15_000);

it('closing the watcher before the stability window prevents any publication', async () => {
  fs.writeFileSync(path.join(folder, 'config.ini'), 'do not publish');
  const f = fixture(), w = f.start(); w.close(); await w.idle();
  await new Promise(resolve => setTimeout(resolve, 90)); expect(f.published).toEqual([]); expect(f.pending.size).toBe(0);
});

it('continues publishing other files when one file cannot be prepared', async () => {
  fs.writeFileSync(path.join(folder, 'a.ini'), 'a'); fs.writeFileSync(path.join(folder, 'b.ini'), 'b');
  const f = fixture(); f.options.publish.mockImplementation(async p => { if (p === 'a.ini') throw new Error('locked'); f.published.push(p); });
  f.start(); await eventually(() => expect(f.published).toContain('b.ini'));
  expect(f.pending.has('a.ini')).toBe(true);
});

it('does not publish files excluded from the reviewed folder, or follow junctions', async () => {
  fs.mkdirSync(path.join(folder, '.git')); fs.writeFileSync(path.join(folder, '.git', 'config'), 'private');
  fs.writeFileSync(path.join(folder, '.env'), 'secret'); fs.writeFileSync(path.join(folder, '~$budget.docx'), 'lock');
  fs.mkdirSync(path.join(folder, 'configs')); fs.writeFileSync(path.join(folder, 'configs', 'game.ini'), 'safe');
  const outside = path.join(folder, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.key'), 'secret');
  fs.symlinkSync(outside, path.join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await scanSyncFolder(folder);
  expect(result.files.map(f => f.path)).toEqual(['configs/game.ini']); expect(result.skipped).toBeGreaterThanOrEqual(5);
});

it.each(['.env', '.env.local', 'id_ed25519', 'key.pem', 'a.pfx', 'bin/app.exe', 'obj/project.csproj', '.havvn-sync/transactions/a', 'node_modules/x/index.js', 'data.tmp', '~$file.docx'])('excludes %s', relative => {
  expect(excludedSyncPath(relative)).toBe(true);
});

it('retains normal document, solution and configuration files', () => {
  for (const name of ['README.md', 'a.docx', 'b.xlsx', 'project.sln', 'src/project.csproj', 'config/game.ini', 'config.json']) expect(excludedSyncPath(name)).toBe(false);
});
it('previews why files and whole directories are excluded and publishes only custom-rule survivors', async () => {
  fs.mkdirSync(path.join(folder, 'cache')); fs.writeFileSync(path.join(folder, 'cache/private.ini'), 'local');
  fs.writeFileSync(path.join(folder, 'debug.log'), 'log'); fs.writeFileSync(path.join(folder, 'config.ini'), 'config');
  fs.writeFileSync(path.join(folder, '.env'), 'synthetic');
  const rules = ['*.log', 'cache/**'], scanned = await scanSyncFolder(folder, () => true, rules, true);
  expect(scanned.files.map(f => f.path)).toEqual(['config.ini']); expect(scanned.skipped).toBe(3);
  expect(scanned.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'cache', reason: 'rule', rule: 'cache/**', directory: true }),
    expect.objectContaining({ path: 'debug.log', reason: 'rule', rule: '*.log' }), expect.objectContaining({ path: '.env', reason: 'default' }),
  ]));
  const f = fixture(), w = new RoomSyncWatcher({ ...f.options, rules }); watchers.push(w);
  await eventually(() => expect(f.published).toEqual(['config.ini']));
});

it('rejects more than 2000 included files before publication', async () => {
  for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(folder, i + '.ini'), 'x');
  await expect(scanSyncFolder(folder)).rejects.toThrow('2000 files');
}, 20_000);
