import { describe, it, expect } from 'vitest';
import {
  isSafeRelPath, isValidDigest, isSafeArtifactUrl, validateInstallStep, validateInstallPlan,
  validateLaunchPlan, clampCommand, normalizeConsoleLine, splitLines, ServerFsm, isLive,
  coerceConfigValue, validateConfigValues, pickPort,
  MAX_EXEC_TIMEOUT_MS,
} from './gameserver-core';
import { MAX_RESTARTS, RESTART_WINDOW_MS, MAX_COMMAND_LENGTH, MAX_CONSOLE_LINE } from './gameserver-types';
import type { ConfigField, InstallStep, LaunchPlan } from './gameserver-types';

describe('isSafeRelPath (module plan → filesystem boundary)', () => {
  it('accepts ordinary relative paths and the empty root', () => {
    expect(isSafeRelPath('')).toEqual({ ok: true, path: '' });
    expect(isSafeRelPath('server.jar')).toEqual({ ok: true, path: 'server.jar' });
    expect(isSafeRelPath('mods/fabric-api.jar')).toEqual({ ok: true, path: 'mods/fabric-api.jar' });
    expect(isSafeRelPath('a/b/c/d.txt')).toEqual({ ok: true, path: 'a/b/c/d.txt' });
  });

  it('rejects non-strings and over-long paths', () => {
    expect(isSafeRelPath(undefined)).toEqual({ ok: false, reason: 'not-a-string' });
    expect(isSafeRelPath(7)).toEqual({ ok: false, reason: 'not-a-string' });
    expect(isSafeRelPath(`${'a'.repeat(300)}.jar`)).toEqual({ ok: false, reason: 'too-long' });
  });

  it('rejects absolute, drive and UNC forms', () => {
    expect(isSafeRelPath('/etc/passwd')).toEqual({ ok: false, reason: 'absolute' });
    // The drive colon is caught as a bad character before the absolute check.
    expect(isSafeRelPath('C:/Windows/System32/cmd.exe')).toEqual({ ok: false, reason: 'bad-chars' });
    expect(isSafeRelPath('C:foo')).toEqual({ ok: false, reason: 'bad-chars' });
    expect(isSafeRelPath('\\\\server\\share\\x.jar')).toEqual({ ok: false, reason: 'bad-chars' });
  });

  it('rejects traversal in every position', () => {
    expect(isSafeRelPath('../secrets')).toEqual({ ok: false, reason: 'traversal' });
    expect(isSafeRelPath('mods/../../x')).toEqual({ ok: false, reason: 'traversal' });
    expect(isSafeRelPath('mods/./x')).toEqual({ ok: false, reason: 'traversal' });
    expect(isSafeRelPath('mods//x')).toEqual({ ok: false, reason: 'traversal' });
    expect(isSafeRelPath('mods/')).toEqual({ ok: false, reason: 'traversal' });
  });

  it('rejects a backslash rather than normalising it', () => {
    // Normalising would make the validated string differ from the resolved one.
    expect(isSafeRelPath('mods\\evil.jar')).toEqual({ ok: false, reason: 'bad-chars' });
  });

  it('rejects NUL, wildcards and shell-meaningful characters', () => {
    for (const bad of ['a\u0000b', 'a<b', 'a>b', 'a|b', 'a?b', 'a*b', 'a"b']) {
      expect(isSafeRelPath(bad).ok).toBe(false);
    }
  });

  it('rejects trailing dot/space segments (Win32 canonicalisation drift)', () => {
    expect(isSafeRelPath('mods /x.jar')).toEqual({ ok: false, reason: 'bad-chars' });
    expect(isSafeRelPath('mods./x.jar')).toEqual({ ok: false, reason: 'bad-chars' });
    expect(isSafeRelPath('x.jar ')).toEqual({ ok: false, reason: 'bad-chars' });
  });

  it('rejects Windows reserved device names, with or without an extension', () => {
    expect(isSafeRelPath('CON')).toEqual({ ok: false, reason: 'reserved' });
    expect(isSafeRelPath('nul.jar')).toEqual({ ok: false, reason: 'reserved' });
    expect(isSafeRelPath('mods/LPT1.jar')).toEqual({ ok: false, reason: 'reserved' });
    expect(isSafeRelPath('console.jar').ok).toBe(true); // only the exact device names
  });
});

describe('digest and url gates', () => {
  it('accepts only correctly sized lowercase hex', () => {
    expect(isValidDigest('sha1', 'a'.repeat(40))).toBe(true);
    expect(isValidDigest('sha256', 'f'.repeat(64))).toBe(true);
    expect(isValidDigest('sha256', 'F'.repeat(64))).toBe(false);
    expect(isValidDigest('sha256', 'a'.repeat(63))).toBe(false);
    expect(isValidDigest('sha1', 'a'.repeat(64))).toBe(false);
    expect(isValidDigest('sha256', undefined)).toBe(false);
  });

  it('accepts https only, and never credentials in the url', () => {
    expect(isSafeArtifactUrl('https://piston-data.mojang.com/server.jar')).toBe(true);
    expect(isSafeArtifactUrl('http://example.com/server.jar')).toBe(false);
    expect(isSafeArtifactUrl('file:///C:/x.jar')).toBe(false);
    expect(isSafeArtifactUrl('https://user:pass@example.com/x.jar')).toBe(false);
    expect(isSafeArtifactUrl('not a url')).toBe(false);
    expect(isSafeArtifactUrl(42)).toBe(false);
  });
});

describe('validateInstallStep', () => {
  const goodFetch: InstallStep = {
    t: 'fetch',
    url: 'https://example.com/server.jar',
    hash: { algo: 'sha256', hex: 'a'.repeat(64) },
    into: 'server.jar',
  };

  it('accepts a well-formed fetch', () => {
    expect(validateInstallStep(goodFetch)).toEqual({ ok: true });
  });

  it('refuses a fetch whose digest is malformed, including via the vendor arm', () => {
    expect(validateInstallStep({ ...goodFetch, hash: { algo: 'sha256', hex: 'nope' } }).ok).toBe(false);
    expect(validateInstallStep({
      ...goodFetch, hash: { algo: 'vendor', from: 'mojang', digest: 'sha1', hex: 'b'.repeat(40) },
    })).toEqual({ ok: true });
    expect(validateInstallStep({
      ...goodFetch, hash: { algo: 'vendor', from: 'mojang', digest: 'sha1', hex: 'b'.repeat(64) },
    }).ok).toBe(false);
  });

  it('refuses a fetch that targets the instance root instead of a file', () => {
    expect(validateInstallStep({ ...goodFetch, into: '' }).ok).toBe(false);
  });

  it('refuses a write that is too large or escapes the instance', () => {
    expect(validateInstallStep({ t: 'write', path: 'eula.txt', text: 'eula=true' })).toEqual({ ok: true });
    expect(validateInstallStep({ t: 'write', path: '../eula.txt', text: 'x' }).ok).toBe(false);
    expect(validateInstallStep({ t: 'write', path: 'big.txt', text: 'x'.repeat(1024 * 1024 + 1) }).ok).toBe(false);
  });

  it('bounds runtime-exec on every side', () => {
    const base = {
      t: 'runtime-exec' as const,
      runtime: { id: 'java', major: 21 },
      args: ['-jar', 'installer.jar', '--installServer'],
      cwd: '',
      timeoutMs: 60_000,
      produces: ['run.sh'],
    };
    expect(validateInstallStep(base)).toEqual({ ok: true });
    expect(validateInstallStep({ ...base, timeoutMs: MAX_EXEC_TIMEOUT_MS + 1 }).ok).toBe(false);
    expect(validateInstallStep({ ...base, timeoutMs: 0 }).ok).toBe(false);
    expect(validateInstallStep({ ...base, args: Array(100).fill('x') }).ok).toBe(false);
    expect(validateInstallStep({ ...base, args: ['a\u0000b'] }).ok).toBe(false);
    expect(validateInstallStep({ ...base, cwd: '../elsewhere' }).ok).toBe(false);
    // A step that declares no output cannot be checked for silent failure.
    expect(validateInstallStep({ ...base, produces: [] }).ok).toBe(false);
  });

  it('names the failing step index in a plan', () => {
    const plan: InstallStep[] = [goodFetch, { t: 'write', path: '../x', text: 'y' }];
    const r = validateInstallPlan(plan);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('step 1');
  });
});

describe('validateLaunchPlan', () => {
  const good: LaunchPlan = { runtime: { id: 'java', major: 21 }, args: ['-jar', 'server.jar'], cwd: '' };

  it('accepts a well-formed plan', () => {
    expect(validateLaunchPlan(good)).toEqual({ ok: true });
  });

  it('rejects a bad cwd, bad argv and malformed env', () => {
    expect(validateLaunchPlan({ ...good, cwd: '../..' }).ok).toBe(false);
    expect(validateLaunchPlan({ ...good, args: ['ok', 'bad\u0000'] }).ok).toBe(false);
    expect(validateLaunchPlan({ ...good, env: { 'BAD NAME': 'x' } }).ok).toBe(false);
    expect(validateLaunchPlan({ ...good, env: { GOOD_NAME: 'x' } }).ok).toBe(true);
  });
});

describe('clampCommand (UI → stdin boundary)', () => {
  it('flattens embedded newlines so one command cannot become two', () => {
    // Without this, a future operator allow-list would be trivially bypassed.
    expect(clampCommand('say hi\nstop')).toBe('say hi stop');
    expect(clampCommand('say hi\r\nop attacker')).toBe('say hi  op attacker');
  });

  it('trims, caps and rejects empties', () => {
    expect(clampCommand('  list  ')).toBe('list');
    expect(clampCommand('')).toBeNull();
    expect(clampCommand('   ')).toBeNull();
    expect(clampCommand(undefined)).toBeNull();
    expect(clampCommand('x'.repeat(MAX_COMMAND_LENGTH + 50))?.length).toBe(MAX_COMMAND_LENGTH);
  });
});

describe('normalizeConsoleLine / splitLines', () => {
  it('strips ANSI colour and control characters', () => {
    expect(normalizeConsoleLine('\u001b[32mDone\u001b[0m')).toBe('Done');
    expect(normalizeConsoleLine('a\u0007b')).toBe('ab');
    expect(normalizeConsoleLine('plain')).toBe('plain');
  });

  it('caps a long line with a marker', () => {
    const out = normalizeConsoleLine('x'.repeat(MAX_CONSOLE_LINE + 10));
    expect(out.length).toBe(MAX_CONSOLE_LINE + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('splits on LF, CRLF and lone CR, carrying the partial', () => {
    expect(splitLines('', 'a\nb\r\nc')).toEqual({ lines: ['a', 'b'], carry: 'c' });
    expect(splitLines('c', 'd\n')).toEqual({ lines: ['cd'], carry: '' });
    expect(splitLines('', 'progress\rmore\r')).toEqual({ lines: ['progress', 'more'], carry: '' });
  });

  it('flushes a runaway partial instead of buffering it forever', () => {
    const huge = 'x'.repeat(MAX_CONSOLE_LINE + 1);
    const r = splitLines('', huge);
    expect(r.carry).toBe('');
    expect(r.lines).toEqual([huge]);
  });
});

describe('ServerFsm', () => {
  it('walks the happy path idle → starting → running → stopped', () => {
    const fsm = new ServerFsm(0);
    expect(fsm.status).toBe('idle');
    expect(fsm.beginStart(100)).toBe(true);
    expect(fsm.status).toBe('starting');
    fsm.applyEvent({ t: 'ready', tookMs: 12_000 }, 200);
    expect(fsm.status).toBe('running');
    expect(fsm.ready).toBe(true);
    expect(fsm.beginStop(300)).toBe(true);
    expect(fsm.status).toBe('stopping');
    expect(fsm.exited({ expected: true, code: 0, signal: null, autoRestart: true }, 400)).toBe('stopped');
    expect(fsm.status).toBe('stopped');
  });

  it('refuses a start while a process is live and a stop while it is not', () => {
    const fsm = new ServerFsm(0);
    fsm.beginStart(10);
    expect(fsm.beginStart(20)).toBe(false);
    expect(fsm.beginInstall(20)).toBe(false); // an install must never race a live process
    const idle = new ServerFsm(0);
    expect(idle.beginStop(10)).toBe(false);
  });

  it('tracks players and lets a probe replace the set authoritatively', () => {
    const fsm = new ServerFsm(0);
    fsm.beginStart(0);
    fsm.applyEvent({ t: 'ready' }, 1);
    fsm.applyEvent({ t: 'player-join', name: 'Steve' }, 2);
    fsm.applyEvent({ t: 'player-join', name: 'Alex' }, 3);
    fsm.applyEvent({ t: 'player-leave', name: 'Steve' }, 4);
    expect(fsm.snapshot().players).toEqual(['Alex']);
    // A probe wins: log lines can be missed, the SLP response cannot be stale.
    fsm.setPlayers(['Alex', 'Notch']);
    expect(fsm.snapshot().players.sort()).toEqual(['Alex', 'Notch']);
  });

  it('restarts an unexpected exit until the budget runs out, then reports crash-loop', () => {
    const fsm = new ServerFsm(0);
    for (let i = 0; i < MAX_RESTARTS; i++) {
      fsm.beginStart(i * 10);
      expect(fsm.exited({ expected: false, code: 1, signal: null, autoRestart: true }, i * 10 + 1)).toBe('restart');
    }
    fsm.beginStart(1000);
    expect(fsm.exited({ expected: false, code: 1, signal: null, autoRestart: true }, 1001)).toBe('crashed');
    expect(fsm.snapshot().failReason).toBe('crash-loop');
  });

  it('parks a restarting instance in starting so Start cannot double-spawn it', () => {
    const fsm = new ServerFsm(0);
    fsm.beginStart(0);
    expect(fsm.exited({ expected: false, code: 1, signal: null, autoRestart: true }, 1)).toBe('restart');
    expect(fsm.status).toBe('starting');
    // A user pressing Start during the restart delay is refused.
    expect(fsm.beginStart(2)).toBe(false);
    // prepareRestart is the only way out, and it keeps the crash budget — the
    // whole point, since clearing it would make a crash loop invisible.
    expect(fsm.prepareRestart(3)).toBe(true);
    expect(fsm.status).toBe('idle');
    expect(fsm.snapshot().restarts).toBe(1);
    expect(fsm.beginStart(4)).toBe(true);
  });

  it('refuses prepareRestart outside a restart', () => {
    const fsm = new ServerFsm(0);
    expect(fsm.prepareRestart(1)).toBe(false);
  });

  it('forgets old crashes once they age out of the window', () => {
    const fsm = new ServerFsm(0);
    for (let i = 0; i < MAX_RESTARTS; i++) {
      fsm.beginStart(i);
      fsm.exited({ expected: false, code: 1, signal: null, autoRestart: true }, i + 1);
    }
    const later = RESTART_WINDOW_MS * 2;
    fsm.beginStart(later);
    expect(fsm.exited({ expected: false, code: 1, signal: null, autoRestart: true }, later + 1)).toBe('restart');
  });

  it('clears the budget after a start that actually reached ready', () => {
    const fsm = new ServerFsm(0);
    fsm.beginStart(0);
    fsm.exited({ expected: false, code: 1, signal: null, autoRestart: true }, 1);
    expect(fsm.snapshot().restarts).toBe(1);
    fsm.beginStart(2);
    fsm.applyEvent({ t: 'ready' }, 3);
    expect(fsm.snapshot().restarts).toBe(0);
  });

  it('goes terminal immediately on a fatal log line instead of burning restarts', () => {
    // Restarting into an OutOfMemoryError three times only delays the real
    // message, which is "raise -Xmx".
    const fsm = new ServerFsm(0);
    fsm.beginStart(0);
    fsm.applyEvent({ t: 'error', text: 'java.lang.OutOfMemoryError: Java heap space', fatal: true }, 1);
    expect(fsm.exited({ expected: false, code: 1, signal: null, autoRestart: true }, 2)).toBe('crashed');
    expect(fsm.snapshot().failReason).toBe('fatal-log');
    expect(fsm.snapshot().failDetail).toContain('OutOfMemoryError');
  });

  it('does not restart when auto-restart is off', () => {
    const fsm = new ServerFsm(0);
    fsm.beginStart(0);
    expect(fsm.exited({ expected: false, code: 1, signal: null, autoRestart: false }, 1)).toBe('crashed');
    expect(fsm.snapshot().failReason).toBe('exited-early');
  });

  it('distinguishes an early death from a crash under load', () => {
    const early = new ServerFsm(0);
    early.beginStart(0);
    early.exited({ expected: false, code: 1, signal: null, autoRestart: false }, 1);
    expect(early.snapshot().failReason).toBe('exited-early');

    const late = new ServerFsm(0);
    late.beginStart(0);
    late.applyEvent({ t: 'ready' }, 1);
    late.exited({ expected: false, code: null, signal: 'SIGKILL', autoRestart: false }, 2);
    expect(late.snapshot().failReason).toBe('unknown');
    expect(late.snapshot().failDetail).toContain('SIGKILL');
  });

  it('reports a kill after a stop timeout', () => {
    const fsm = new ServerFsm(0);
    fsm.beginStart(0);
    fsm.applyEvent({ t: 'ready' }, 1);
    fsm.beginStop(2);
    fsm.killed(3);
    expect(fsm.status).toBe('stopped');
    expect(fsm.snapshot().failReason).toBe('stop-timeout');
  });

  it('tracks install progress and failure', () => {
    const fsm = new ServerFsm(0);
    expect(fsm.beginInstall(0)).toBe(true);
    fsm.installProgress(42.6);
    expect(fsm.snapshot().installPct).toBe(43);
    fsm.installProgress(200);
    expect(fsm.snapshot().installPct).toBe(100);
    fsm.installFailed('digest mismatch', 5);
    expect(fsm.status).toBe('crashed');
    expect(fsm.snapshot().failReason).toBe('install-failed');
    expect(fsm.snapshot().installPct).toBeUndefined();
  });

  it('lets the user clear a terminal failure and try again', () => {
    const fsm = new ServerFsm(0);
    fsm.beginStart(0);
    fsm.exited({ expected: false, code: 1, signal: null, autoRestart: false }, 1);
    expect(fsm.status).toBe('crashed');
    fsm.clearFailure(2);
    expect(fsm.status).toBe('idle');
    expect(fsm.snapshot().failReason).toBeUndefined();
    expect(fsm.beginStart(3)).toBe(true);
  });

  it('isLive covers exactly the statuses with a process attached', () => {
    expect(isLive('starting')).toBe(true);
    expect(isLive('running')).toBe(true);
    expect(isLive('stopping')).toBe(true);
    expect(isLive('idle')).toBe(false);
    expect(isLive('installing')).toBe(false);
    expect(isLive('stopped')).toBe(false);
    expect(isLive('crashed')).toBe(false);
  });
});

// ── settings coercion (renderer → game config file) ─────────────────────────
describe('coerceConfigValue', () => {
  const port: ConfigField = { key: 'server-port', t: 'int', labelKey: 'k', min: 1024, max: 65535 };
  const motd: ConfigField = { key: 'motd', t: 'text', labelKey: 'k', maxLength: 59 };
  const mode: ConfigField = {
    key: 'gamemode', t: 'select', labelKey: 'k',
    options: [{ value: 'survival', labelKey: 'a' }, { value: 'creative', labelKey: 'b' }],
  };
  const pvp: ConfigField = { key: 'pvp', t: 'bool', labelKey: 'k' };

  it('normalises an int instead of storing what was typed', () => {
    expect(coerceConfigValue(port, ' 25566 ')).toEqual({ ok: true, value: '25566' });
    expect(coerceConfigValue(port, 25566)).toEqual({ ok: true, value: '25566' });
  });

  it('refuses a number with trailing junk rather than parsing a prefix', () => {
    // Number.parseInt('25565abc') is 25565, which would accept a typo as a port.
    expect(coerceConfigValue(port, '25565abc').ok).toBe(false);
    expect(coerceConfigValue(port, '1.5').ok).toBe(false);
    expect(coerceConfigValue(port, '').ok).toBe(false);
  });

  it('enforces the field range, which is what used to be clamped only at read time', () => {
    expect(coerceConfigValue(port, '99999')).toEqual({ ok: false, reason: 'above 65535' });
    expect(coerceConfigValue(port, '80')).toEqual({ ok: false, reason: 'below 1024' });
  });

  it('canonicalises booleans and rejects anything else', () => {
    expect(coerceConfigValue(pvp, 'TRUE')).toEqual({ ok: true, value: 'true' });
    expect(coerceConfigValue(pvp, false)).toEqual({ ok: true, value: 'false' });
    expect(coerceConfigValue(pvp, 'yes').ok).toBe(false);
    expect(coerceConfigValue(pvp, 1).ok).toBe(false);
  });

  it('accepts only options the module itself offered', () => {
    expect(coerceConfigValue(mode, 'creative')).toEqual({ ok: true, value: 'creative' });
    expect(coerceConfigValue(mode, 'hardcore')).toEqual({ ok: false, reason: 'not an offered option' });
  });

  it('rejects text with a line break, which would forge a second config key', () => {
    expect(coerceConfigValue(motd, 'hi\nrcon.password=x').ok).toBe(false);
    expect(coerceConfigValue(motd, 'a\r\nb').ok).toBe(false);
    expect(coerceConfigValue(motd, 'a'.repeat(60))).toEqual({ ok: false, reason: 'longer than 59' });
    expect(coerceConfigValue(motd, '  Welcome  ')).toEqual({ ok: true, value: 'Welcome' });
  });
});

describe('validateConfigValues', () => {
  const schema: ConfigField[] = [
    { key: 'server-port', t: 'int', labelKey: 'k', min: 1024, max: 65535 },
    { key: 'motd', t: 'text', labelKey: 'k', maxLength: 59 },
  ];

  it('reports the described values that are out of range and keeps the rest', () => {
    const res = validateConfigValues(schema, { 'server-port': '99999', motd: 'hello' });
    expect(res.values).toEqual({ motd: 'hello' });
    expect(res.rejected).toEqual([{ key: 'server-port', reason: 'above 65535' }]);
  });

  it('carries unmodelled keys through, because the form round-trips the whole file', () => {
    // Minecraft's server.properties has dozens of keys we do not model; failing
    // the save because one of them exists would make settings unusable.
    const res = validateConfigValues(schema, { 'enable-jmx-monitoring': 'false' });
    expect(res.values).toEqual({ 'enable-jmx-monitoring': 'false' });
    expect(res.rejected).toEqual([]);
  });

  it('drops a key whose NAME could not appear in a config file', () => {
    const res = validateConfigValues(schema, { 'a=b\nc': 'x', 'ok-key': 'y' });
    expect(res.values).toEqual({ 'ok-key': 'y' });
  });
});

describe('pickPort', () => {
  const plan = { base: 25565, span: 4 };

  it('hands out the base port when nothing holds it', () => {
    expect(pickPort(plan, [])).toBe(25565);
  });

  it('steps past siblings, which is the collision the feature shipped with', () => {
    expect(pickPort(plan, [25565])).toBe(25566);
    expect(pickPort(plan, [25565, 25566, 25567])).toBe(25568);
  });

  it('returns null rather than reusing the base once the range is full', () => {
    expect(pickPort(plan, [25565, 25566, 25567, 25568])).toBeNull();
  });

  it('ignores non-integers in the taken set and never exceeds 65535', () => {
    expect(pickPort(plan, [Number.NaN, undefined as unknown as number])).toBe(25565);
    expect(pickPort({ base: 65535, span: 10 }, [65535])).toBeNull();
  });
});
