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
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { systemToolPath, parseUserSid } from './lan-manager';

const savedRoot = process.env.SystemRoot;
const savedWindir = process.env.windir;

afterEach(() => {
  if (savedRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = savedRoot;
  if (savedWindir === undefined) delete process.env.windir; else process.env.windir = savedWindir;
});

describe('systemToolPath', () => {
  it('resolves under SystemRoot\\System32, never through PATH', () => {
    process.env.SystemRoot = 'C:\\Windows';
    expect(systemToolPath('whoami.exe')).toBe(path.join('C:\\Windows', 'System32', 'whoami.exe'));
    // The whole point: an absolute path, so PATH order cannot choose the binary.
    expect(path.isAbsolute(systemToolPath('whoami.exe'))).toBe(true);
  });

  it('honours a relocated Windows install, then windir, then the default', () => {
    process.env.SystemRoot = 'D:\\Win';
    expect(systemToolPath('whoami.exe')).toBe(path.join('D:\\Win', 'System32', 'whoami.exe'));
    delete process.env.SystemRoot;
    process.env.windir = 'E:\\Win';
    expect(systemToolPath('whoami.exe')).toBe(path.join('E:\\Win', 'System32', 'whoami.exe'));
    delete process.env.windir;
    expect(systemToolPath('whoami.exe')).toBe(path.join('C:\\Windows', 'System32', 'whoami.exe'));
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
