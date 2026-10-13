/* eslint-disable @typescript-eslint/no-explicit-any -- Controller fixture uses real snapshot files and isolated dependencies. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const H = vi.hoisted(() => ({ dir: '', writes: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => H.dir } }));
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) } }));
vi.mock('../db/servers-store', () => ({ upsertInstance: H.writes }));
vi.mock('./host-resources', () => ({ freeBytes: () => null }));
import { instancePaths, ensureInstanceDirs } from './paths';
import { ServerManager } from './server-manager';
import { listServerSnapshots } from './server-snapshot';
const ID = '2'.repeat(32), ref = { id: 'old', label: 'Old build', flavour: 'paper', version: '1.21', runtime: { id: 'java', major: 21 }, stable: true };
beforeEach(() => { H.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-update-test-')); ensureInstanceDirs(ID); fs.writeFileSync(path.join(instancePaths(ID).root, 'server.jar'), 'old binary'); H.writes.mockClear(); });
afterEach(() => { fs.rmSync(H.dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
function fixture() {
  const manager = new ServerManager(), internal = manager as any;
  const entry = { persisted: { instanceId: ID, moduleId: 'minecraft', roomId: 'current-room', name: 'Server', ref, config: {}, contentRev: 0, installed: true, autoRestart: true },
    pendingUpdate: { ...ref, id: 'new', label: 'New build' }, supervisor: { status: 'stopped', pid: undefined, pauseAutoRestart: vi.fn(), console: { system: vi.fn() } }, runEpoch: 0 };
  internal.entries.set(ID, entry); internal.refreshView = vi.fn(); internal.deps = { onRoomUpdate: vi.fn() };
  internal.snapshotState = (e: typeof entry) => ({ moduleId: 'minecraft', ref: e.persisted.ref, config: e.persisted.config, contentRev: 0, installed: e.persisted.installed, useSystemJava: false });
  return { manager, internal, entry };
}
it('holds maintenance through installation and restores files and metadata after an install failure', async () => {
  const f = fixture();
  let startResult: unknown, backupError = '';
  f.internal.installEntry = vi.fn(async () => {
    startResult = f.manager.start(ID);
    try { await f.manager.createBackup(ID); } catch (error) { backupError = String(error); }
    fs.writeFileSync(path.join(instancePaths(ID).root, 'server.jar'), 'partial new binary');
    fs.mkdirSync(path.join(instancePaths(ID).root, 'mods')); fs.writeFileSync(path.join(instancePaths(ID).root, 'mods/new.jar'), 'new mod');
    throw Error('injected installer failure');
  });
  await expect(f.manager.applyUpdate(ID)).rejects.toThrow('update-rolled-back');
  expect(startResult).toEqual({ ok: false, reason: 'not-installed' });
  expect(backupError).toContain('maintenance-busy');
  expect(f.entry.persisted.ref.id).toBe('old'); expect(f.entry.persisted.installed).toBe(true);
  expect(f.entry.persisted.roomId).toBe('current-room');
  expect(fs.readFileSync(path.join(instancePaths(ID).root, 'server.jar'), 'utf8')).toBe('old binary');
  expect(fs.existsSync(path.join(instancePaths(ID).root, 'mods/new.jar'))).toBe(false);
  expect(f.internal.maintenance.size).toBe(0);
  expect(await listServerSnapshots(ID)).toEqual([expect.objectContaining({ auto: true, kind: 'server', version: 'Old build' })]);
});
it('leaves a full recovery snapshot after a successful update without launching the server', async () => {
  const f = fixture();
  f.internal.installEntry = vi.fn(async () => { fs.writeFileSync(path.join(instancePaths(ID).root, 'server.jar'), 'new binary'); f.entry.persisted.installed = true; });
  await f.manager.applyUpdate(ID);
  expect(f.entry.persisted.ref.id).toBe('new'); expect(f.entry.pendingUpdate).toBeUndefined();
  expect(f.entry.supervisor.status).toBe('stopped');
  expect((await listServerSnapshots(ID))[0].version).toBe('Old build');
});
it('restores a pinned assembly without changing room membership or enabling automatic content replacement', async () => {
  const f = fixture();
  Object.assign(f.entry.persisted, { contentBindings: { mods: 'current-room-folder' }, contentAutoSync: true });
  const backup = await f.manager.createBackup(ID, 'Pinned pack', 'server');
  Object.assign(f.entry.persisted, { ref: { ...ref, id: 'new' }, contentRev: 9 });
  Object.assign(f.entry, { contentSync: 'conflict', contentPending: [{ sha256: 'new-content' }] });
  fs.writeFileSync(path.join(instancePaths(ID).root, 'server.jar'), 'new binary');
  await f.manager.restoreBackup(ID, backup.id);
  expect(f.entry.persisted.ref.id).toBe('old');
  expect(f.entry.persisted).toMatchObject({ roomId: 'current-room', contentAutoSync: false, contentPinned: true, autoRestart: true });
  expect(f.entry).toMatchObject({ contentSync: 'ok', contentPending: [] });
});
it('does not rebind a departed room or undo a network pause during automatic rollback', async () => {
  const f = fixture();
  f.internal.installEntry = vi.fn(async () => {
    Object.assign(f.entry.persisted, { roomId: '', lifecyclePaused: 'left', autoRestart: false, scheduleEnabled: false });
    fs.writeFileSync(path.join(instancePaths(ID).root, 'server.jar'), 'partial');
    throw Error('cancelled on room exit');
  });
  await expect(f.manager.applyUpdate(ID)).rejects.toThrow('update-rolled-back');
  expect(f.entry.persisted).toMatchObject({ roomId: '', lifecyclePaused: 'left', autoRestart: false, scheduleEnabled: false });
  expect(f.entry.persisted.ref.id).toBe('old');
});
