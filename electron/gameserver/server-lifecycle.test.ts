/* eslint-disable @typescript-eslint/no-explicit-any -- Lifecycle doubles own no real processes or worlds. */
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => vi.fn());
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) } }));
vi.mock('electron', () => ({ app: { getPath: () => 'D:/synthetic-server-lifecycle' } }));
const grants = vi.hoisted(() => ({ allowed: true, clear: vi.fn() }));
vi.mock('../db/servers-store', () => ({ upsertInstance: writes, listOperators: () => grants.allowed ? ['operator'] : [], clearOperators: grants.clear, roleFor: () => 'host' }));
vi.mock('./runtime-store', () => ({}));
vi.mock('./host-resources', () => ({ freeBytes: () => null }));
import { ServerManager } from './server-manager';

function fixture() {
  const manager = new ServerManager(); const internal = manager as any;
  let available = true; let finish!: () => void;
  internal.deps = { isRoomAvailable: () => available, onRoomUpdate: vi.fn(), getSelfId: () => 'host' };
  const supervisor = Object.assign(new EventEmitter(), {
    status: 'running', autoRestart: true, pauseAutoRestart: vi.fn(function(this: any) { this.autoRestart = false; }),
    console: { system: vi.fn() }, sendCommand: vi.fn(() => ({ ok: true })),
    stopAndWait: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })),
    stop: vi.fn(() => ({ ok: true })), start: vi.fn(() => ({ ok: true })),
  });
  const entry = { runEpoch: 0, persisted: { instanceId: '1'.repeat(32), roomId: 'room', installed: true, autoRestart: true, name: 'Server', ref: {} },
    supervisor, announcer: { stop: vi.fn() }, probeTimer: null, installAbort: { abort: vi.fn() } };
  internal.entries.set(entry.persisted.instanceId, entry);
  internal.refreshView = vi.fn(); internal.startProbing = vi.fn();
  return { manager, internal, entry, supervisor, finish: () => finish(), setAvailable: (value: boolean) => { available = value; } };
}
afterEach(() => { writes.mockClear(); grants.allowed = true; grants.clear.mockClear(); });

it('stops room-bound processes, advertisements and installs and persists a manual restart latch', async () => {
  const f = fixture(); const paused = f.manager.onRoomUnavailable('room', 'left');
  let done = false; void paused.then(() => { done = true; });
  expect(f.entry.announcer.stop).toHaveBeenCalledOnce(); expect(f.entry.installAbort.abort).toHaveBeenCalledOnce();
  expect(f.supervisor.autoRestart).toBe(false); expect(writes).toHaveBeenCalledWith(expect.objectContaining({ lifecyclePaused: 'left' }));
  await Promise.resolve(); expect(done).toBe(false); f.finish(); await paused;
});

it('does not affect another room and refuses manual/scheduled starts while membership is unavailable', async () => {
  const f = fixture(); await f.manager.onRoomUnavailable('other-room', 'left');
  expect(f.supervisor.stopAndWait).not.toHaveBeenCalled(); f.setAvailable(false);
  expect(f.manager.start(f.entry.persisted.instanceId)).toEqual({ ok: false, reason: 'room-unavailable' });
  expect(f.supervisor.start).not.toHaveBeenCalled();
});

it('keeps schedules paused after recovery until a successful explicit start', async () => {
  const f = fixture(); const paused = f.manager.onRoomUnavailable('room', 'sleep'); f.finish(); await paused;
  f.supervisor.status = 'stopped';
  f.internal.applyScheduledAction = vi.fn(); Object.assign(f.entry.persisted, { scheduleEnabled: true, schedules: [{ id: 'start', enabled: true, action: 'start', days: [0,1,2,3,4,5,6], time: '00:00' }] });
  await f.internal.scheduleTick(); expect(f.internal.applyScheduledAction).not.toHaveBeenCalled();
  expect(f.manager.start(f.entry.persisted.instanceId)).toEqual({ ok: true });
  expect((f.entry.persisted as any).lifecyclePaused).toBeUndefined(); expect(f.supervisor.autoRestart).toBe(true);
});

it('invalidates a delayed user restart on a network interruption', async () => {
  const f = fixture(); f.manager.restart(f.entry.persisted.instanceId);
  const paused = f.manager.onRoomUnavailable('room', 'vpn'); f.finish(); await paused;
  f.supervisor.emit('exit'); expect(f.supervisor.start).not.toHaveBeenCalled();
});

it('does not create a replacement while a timed-out child has not actually exited', async () => {
  const { Supervisor } = await import('./supervisor');
  const supervisor = new Supervisor({} as never, {} as never, { logsDir: 'synthetic', instanceRoot: 'synthetic', resolveRuntime: () => null, onChange: vi.fn(), onEvent: vi.fn() });
  const internal = supervisor as any; internal.child = { pid: 1234 }; internal.fsm.killed(Date.now());
  expect(supervisor.start()).toEqual({ ok: false, reason: 'stop-first' }); internal.child = null;
});

it('keeps an explicitly detached live process manageable and cuts room grants, announcements and schedules', async () => {
  const f = fixture(); Object.assign(f.entry.persisted, { scheduleEnabled: true, schedules: [{ id: 'keep' }], contentBindings: { mods: 'folder' }, contentAutoSync: true });
  const capturedBySupervisor = f.entry.persisted;
  await f.manager.onRoomUnavailable('room', 'left-local');
  expect(f.entry.persisted).toBe(capturedBySupervisor); expect(capturedBySupervisor.roomId).toBe('');
  expect(f.supervisor.stopAndWait).not.toHaveBeenCalled(); expect(f.entry.persisted.roomId).toBe('');
  expect(f.supervisor.pauseAutoRestart).toHaveBeenCalledOnce(); expect(grants.clear).toHaveBeenCalledWith(f.entry.persisted.instanceId);
  expect(f.entry.persisted).toMatchObject({ scheduleEnabled: false, autoRestart: false, contentBindings: {}, contentAutoSync: false });
  expect((f.entry.persisted as any).schedules).toHaveLength(1); expect((f.entry.persisted as any).lifecyclePaused).toBeUndefined();
  expect(f.entry.announcer.stop).toHaveBeenCalled(); expect(f.internal.deps.onRoomUpdate).toHaveBeenCalledWith('');
  f.setAvailable(false); expect(f.manager.start(f.entry.persisted.instanceId)).toEqual({ ok: true });
});
it('defaults to confirmed stop before converting kept worlds to local instances', async () => {
  const f = fixture(); const leaving = f.manager.onRoomUnavailable('room', 'left');
  expect(f.entry.persisted.roomId).toBe('room'); f.finish(); await leaving;
  expect(f.entry.persisted.roomId).toBe(''); expect((f.entry.persisted as any).lifecyclePaused).toBe('detached');
});
it('refuses background detachment while installation is in progress and leaves other rooms alone', async () => {
  const f = fixture(); (f.entry as any).installing = true;
  await expect(f.manager.onRoomUnavailable('room', 'left-local')).rejects.toThrow('install-running');
  expect(f.entry.persisted.roomId).toBe('room'); expect(grants.clear).not.toHaveBeenCalled();
  await f.manager.onRoomUnavailable('other', 'left-local'); expect(f.supervisor.pauseAutoRestart).not.toHaveBeenCalled();
});
it('checks the current room and operator grant before dedup and writes stdin only once', () => {
  const f = fixture(); const r = { by: 'operator', hostId: 'host', instanceId: f.entry.persisted.instanceId, command: 'stop', commandId: 'command-0000000001', at: Date.now(), expiresAt: Date.now() + 30000 };
  expect(f.manager.handleRemoteCommand(r.by, 'other', r.instanceId, r.command, r)).toMatchObject({ reason: 'unknown-instance' });
  expect(f.manager.handleRemoteCommand(r.by, 'room', r.instanceId, r.command, r).ok).toBe(true);
  expect(f.manager.handleRemoteCommand(r.by, 'room', r.instanceId, r.command, { ...r, at: r.at + 1 }).ok).toBe(true);
  expect(f.supervisor.sendCommand).toHaveBeenCalledOnce(); grants.allowed = false;
  expect(f.manager.handleRemoteCommand(r.by, 'room', r.instanceId, r.command, r)).toMatchObject({ reason: 'viewer-only' });
  expect(f.supervisor.sendCommand).toHaveBeenCalledOnce();
});

it('turning off restart cancels an already queued ticket and a detached server cannot enable room content sync', async () => {
  const f = fixture(); f.manager.setAutoRestart(f.entry.persisted.instanceId, false);
  expect(f.supervisor.pauseAutoRestart).toHaveBeenCalledOnce();
  await f.manager.onRoomUnavailable('room', 'left-local');
  expect(() => f.manager.setContentAutoSync(f.entry.persisted.instanceId, true)).toThrow('no-content-bindings');
});

it('refuses maintenance while a child is stopping or is still alive after timeout', async () => {
  const f = fixture(); const id = f.entry.persisted.instanceId;
  f.supervisor.status = 'stopping';
  await expect(f.manager.createBackup(id)).rejects.toThrow('stop-first');
  f.supervisor.status = 'stopped'; (f.supervisor as any).pid = 1234;
  await expect(f.manager.restoreBackup(id, 'backup')).rejects.toThrow('stop-first');
});

it('blocks starts, deletes, installs and parallel maintenance until the copy completes', async () => {
  const f = fixture(); f.supervisor.status = 'stopped'; const id = f.entry.persisted.instanceId;
  let finish!: () => void;
  const work = f.internal.withMaintenance(f.entry, () => new Promise<void>(resolve => { finish = resolve; }));
  expect(f.manager.start(id)).toMatchObject({ reason: 'maintenance-busy' });
  await expect(f.manager.createBackup(id)).rejects.toThrow('maintenance-busy');
  await expect(f.manager.deleteInstance(id, { deleteFiles: true })).rejects.toThrow('maintenance-busy');
  await expect(f.manager.install(id)).rejects.toThrow('maintenance-busy');
  const files = await import('./maintenance-files');
  const scratch = vi.spyOn(files, 'hasInterruptedMaintenance').mockReturnValue(true);
  try { await expect(f.manager.install(id)).rejects.toThrow('maintenance-busy'); }
  finally { scratch.mockRestore(); }
  expect(() => f.manager.saveConfig(id, {})).toThrow('maintenance-busy');
  expect(f.supervisor.pauseAutoRestart).toHaveBeenCalledOnce();
  finish(); await work; expect(f.manager.start(id).ok).toBe(true);
});

it('releases maintenance after an error but refuses to execute pending mods', async () => {
  const f = fixture(); f.supervisor.status = 'stopped'; const id = f.entry.persisted.instanceId;
  await expect(f.internal.withMaintenance(f.entry, () => Promise.reject(new Error('ENOSPC')))).rejects.toThrow('ENOSPC');
  (f.entry as any).contentSync = 'conflict';
  expect(f.manager.start(id)).toMatchObject({ reason: 'content-pending' });
  expect(f.supervisor.start).not.toHaveBeenCalled();
  (f.entry as any).contentSync = 'ok'; expect(f.manager.start(id).ok).toBe(true);
});

it('does not generate a new world over files retained after interrupted maintenance', async () => {
  const f = fixture(); f.supervisor.status = 'stopped'; const id = f.entry.persisted.instanceId;
  const files = await import('./maintenance-files');
  const check = vi.spyOn(files, 'hasInterruptedMaintenance').mockReturnValue(true);
  try {
    expect(f.manager.start(id)).toMatchObject({ reason: 'maintenance-recovery' });
    await expect(f.manager.createBackup(id)).rejects.toThrow('maintenance-recovery');
    await expect(f.manager.install(id)).rejects.toThrow('maintenance-recovery');
    expect(f.supervisor.start).not.toHaveBeenCalled();
  } finally { check.mockRestore(); }
});
