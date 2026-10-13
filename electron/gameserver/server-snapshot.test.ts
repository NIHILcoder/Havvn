import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const H = vi.hoisted(() => ({ dir: '', free: null as number | null }));
vi.mock('electron', () => ({ app: { getPath: () => H.dir } }));
vi.mock('./host-resources', () => ({ freeBytes: () => H.free }));
import { instancePaths, ensureInstanceDirs } from './paths';
import { hasInterruptedMaintenance } from './maintenance-files';
import { createServerSnapshot, listServerSnapshots, restoreServerSnapshot, type ServerSnapshotState } from './server-snapshot';
const ID = '1'.repeat(32);
const state: ServerSnapshotState = { moduleId: 'minecraft', ref: { id: 'paper-old', label: 'Paper old', flavour: 'paper', version: '1.21', runtime: { id: 'java', major: 21 }, stable: true },
  config: { gamemode: 'survival', 'havvn-memory-mb': '2048' }, installed: true, useSystemJava: false, contentRev: 0 };
const write = (name: string, text: string) => { const file = path.join(instancePaths(ID).root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (name: string) => fs.readFileSync(path.join(instancePaths(ID).root, name), 'utf8');
beforeEach(() => { H.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-snapshot-test-')); H.free = null; ensureInstanceDirs(ID); write('world/level.dat', 'old world'); write('server.jar', 'old server'); write('mods/a.jar', 'old mod'); write('server.properties', '# preserved\ngamemode=survival'); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(H.dir, { recursive: true, force: true }); });
it('restores the complete tree and version metadata, including removal of files added after the backup', async () => {
  const backup = await createServerSnapshot(ID, state, 'Before update', true);
  write('world/level.dat', 'new world'); write('server.jar', 'new server'); write('mods/new.jar', 'new mod');
  const commit = vi.fn(), rollback = vi.fn();
  await restoreServerSnapshot(ID, backup.id, state, commit, rollback);
  expect(read('server.jar')).toBe('old server'); expect(read('world/level.dat')).toBe('old world'); expect(read('mods/a.jar')).toBe('old mod');
  expect(fs.existsSync(path.join(instancePaths(ID).root, 'mods/new.jar'))).toBe(false);
  expect(commit).toHaveBeenCalledWith(state); expect(rollback).not.toHaveBeenCalled();
  expect(await listServerSnapshots(ID)).toEqual([expect.objectContaining({ kind: 'server', version: 'Paper old', auto: true })]);
});
it('keeps the current tree when damaged backup data or insufficient disk space is detected', async () => {
  const backup = await createServerSnapshot(ID, state);
  write('server.jar', 'current');
  const stored = path.join(instancePaths(ID).base, 'backups', backup.id, 'root', 'server.jar');
  fs.writeFileSync(stored, 'damaged');
  await expect(restoreServerSnapshot(ID, backup.id, state, vi.fn(), vi.fn())).rejects.toThrow('backup-damaged');
  expect(read('server.jar')).toBe('current');
  H.free = 0;
  await expect(createServerSnapshot(ID, state)).rejects.toThrow('disk-space');
  expect(read('world/level.dat')).toBe('old world');
});
it('rolls back a failed directory publication and a failed metadata commit', async () => {
  const backup = await createServerSnapshot(ID, state);
  write('server.jar', 'current');
  const rename = fsp.rename.bind(fsp); let failed = false;
  vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
    if (!failed && String(from).endsWith(path.sep + 'next')) { failed = true; throw Error('injected publish failure'); }
    return rename(from, to);
  });
  await expect(restoreServerSnapshot(ID, backup.id, state, vi.fn(), vi.fn())).rejects.toThrow('publish failure');
  expect(read('server.jar')).toBe('current'); expect(hasInterruptedMaintenance(instancePaths(ID).root)).toBe(false);
  vi.restoreAllMocks();
  const rollback = vi.fn();
  await expect(restoreServerSnapshot(ID, backup.id, state, () => { throw Error('store unavailable'); }, rollback)).rejects.toThrow('store unavailable');
  expect(rollback).toHaveBeenCalledOnce(); expect(read('server.jar')).toBe('current');
});
it('recognizes recovery material even if the live root disappeared, and refuses linked trees', async () => {
  const paths = instancePaths(ID), stage = path.join(paths.base, '.server-restore-interrupted');
  fs.mkdirSync(stage); fs.renameSync(paths.root, path.join(stage, 'previous'));
  expect(hasInterruptedMaintenance(paths.root)).toBe(true);
  fs.renameSync(path.join(stage, 'previous'), paths.root); fs.rmSync(stage, { recursive: true });
  const external = path.join(H.dir, 'external'); fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(paths.root, 'linked'), 'junction');
  await expect(createServerSnapshot(ID, state)).rejects.toThrow('files-locked');
});
