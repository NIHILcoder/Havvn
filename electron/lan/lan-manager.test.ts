/**
 * LanManager — the two rules behind the account-SID lookup.
 *
 * Both exist because of one live failure on a packaged build: the app was
 * launched from a Git Bash shell, `whoami` resolved to that shell's POSIX
 * `/usr/bin/whoami` instead of System32's, `/user` came back as "extra operand",
 * and the SID lookup returned ''. The helper — which DACLs its pipe to that SID —
 * refused to start, and the only thing the user ever saw was the engine's pipe
 * connect timing out twenty seconds later:
 *
 *     LAN helper connection failed: lan-pipe: timed out connecting to the helper
 *
 * Nothing in that message points at a PATH lookup three layers below it, which is
 * why both halves are pinned here rather than left to review: resolve system
 * tools absolutely, and never read a bare username as a SID.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { LanManager, systemToolPath, parseUserSid } from './lan-manager';

const savedRoot = process.env.SystemRoot;
const savedWindir = process.env.windir;

afterEach(() => {
  if (savedRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = savedRoot;
  if (savedWindir === undefined) delete process.env.windir; else process.env.windir = savedWindir;
});

describe('systemToolPath', () => {
  it('resolves under SystemRoot\\System32, never through PATH', () => {
    process.env.SystemRoot = 'C:\\Windows';
    expect(systemToolPath('whoami.exe')).toBe(path.win32.join('C:\\Windows', 'System32', 'whoami.exe'));
    // The whole point: an absolute path, so PATH order cannot choose the binary.
    expect(path.win32.isAbsolute(systemToolPath('whoami.exe'))).toBe(true);
  });

  it('honours a relocated Windows install, then windir, then the default', () => {
    process.env.SystemRoot = 'D:\\Win';
    expect(systemToolPath('whoami.exe')).toBe(path.win32.join('D:\\Win', 'System32', 'whoami.exe'));
    delete process.env.SystemRoot;
    process.env.windir = 'E:\\Win';
    expect(systemToolPath('whoami.exe')).toBe(path.win32.join('E:\\Win', 'System32', 'whoami.exe'));
    delete process.env.windir;
    expect(systemToolPath('whoami.exe')).toBe(path.win32.join('C:\\Windows', 'System32', 'whoami.exe'));
  });
});

describe('parseUserSid', () => {
  it('reads the SID out of whoami /user /fo csv /nh', () => {
    expect(parseUserSid('"desktop-c1r0o21\\prxnhl","S-1-5-21-2464781006-1119262646-3497129453-1002"'))
      .toBe('S-1-5-21-2464781006-1119262646-3497129453-1002');
  });

  it('returns nothing for a POSIX whoami, which prints only the user name', () => {
    // THE bug: this output used to flow on as an empty SID instead of an error.
    expect(parseUserSid('prxnhl\n')).toBe('');
    expect(parseUserSid("whoami: extra operand '/user'\n")).toBe('');
  });

  it('returns nothing for empty or junk input rather than a partial SID', () => {
    for (const bad of ['', '   ', 'S-1', 'no sid here', undefined as unknown as string]) {
      expect(parseUserSid(bad)).toBe('');
    }
  });
});

// No elevation, adapters or filesystem operations: exercise the UAC await boundary.
function lifecycleFixture() {
  const manager = new LanManager(); let finish!: (pid: number) => void;
  const internals = manager as unknown as { electron(): unknown; writeHandshake(): string; spawnHelper(): Promise<number>; watchHelper(): void; isPidAlive(): boolean; safeUnlink(): void; awaitHelperExit(): Promise<void> };
  vi.spyOn(manager, 'available').mockReturnValue({ ok: true }); vi.spyOn(manager, 'getInteractiveUserSid').mockReturnValue('S-1-5-21-123-1001');
  vi.spyOn(internals, 'electron').mockReturnValue({ app: { getPath: () => 'synthetic' } });
  vi.spyOn(internals, 'writeHandshake').mockReturnValue('synthetic-handshake');
  vi.spyOn(internals, 'spawnHelper').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.spyOn(internals, 'isPidAlive').mockReturnValue(false);
  vi.spyOn(internals, 'watchHelper').mockImplementation(() => {}); vi.spyOn(internals, 'safeUnlink').mockImplementation(() => {});
  vi.spyOn(internals, 'awaitHelperExit').mockResolvedValue(undefined);
  const id = '1'.repeat(32), params = { roomId: 'room', sessionId: id + '.1234567890abcdef', selfMemberId: id, hostId: id };
  return { manager, internals, params, finish: () => finish(1234) };
}

it('coalesces helper launch and excludes another room while elevation is pending', async () => {
  const f = lifecycleFixture(); const first = f.manager.start(f.params), second = f.manager.start(f.params);
  expect(first).toBe(second); expect(f.manager.canStart('other')).toBe(false);
  await expect(f.manager.start({ ...f.params, roomId: 'other' })).rejects.toThrow('busy');
  f.finish(); await first; await f.manager.stopRoom('other'); expect(f.manager.activeRoomId()).toBe('room');
  await f.manager.stopRoom('room'); expect(f.manager.activeRoomId()).toBeNull();
});

it('cancels a delayed helper result after leaving the room without attaching its adapter', async () => {
  const f = lifecycleFixture(); const started = f.manager.start(f.params);
  await f.manager.stopRoom('room'); f.finish(); await expect(started).rejects.toThrow('start-cancelled');
  expect(f.manager.activeRoomId()).toBeNull(); expect(f.internals.watchHelper).not.toHaveBeenCalled();
  expect(f.internals.safeUnlink).toHaveBeenCalledWith('synthetic-handshake');
});

it('rejects a helper whose elevation finishes after a VPN suspension', async () => {
  const f = lifecycleFixture(); let suspended = false; f.manager.configure({ isNetSuspended: () => suspended });
  const started = f.manager.start(f.params); suspended = true; f.manager.onVpnSuspend(); f.finish();
  await expect(started).rejects.toThrow(/cancelled|suspended/); expect(f.manager.activeRoomId()).toBeNull();
});

it('retains a slow elevated helper until its exit instead of overlapping adapters', async () => {
  const f = lifecycleFixture(); const started = f.manager.start(f.params); f.finish(); await started;
  vi.mocked(f.internals.isPidAlive).mockReturnValue(true);
  await f.manager.stopRoom('room'); expect(f.manager.activeRoomId()).toBe('room');
  expect(f.manager.canStart('room')).toBe(false); await expect(f.manager.start(f.params)).rejects.toThrow('busy');
  vi.mocked(f.internals.isPidAlive).mockReturnValue(false); await f.manager.stopRoom('room');
  expect(f.manager.activeRoomId()).toBeNull(); expect(f.manager.canStart('room')).toBe(true);
});
