import { describe, it, expect, vi } from 'vitest';
import {
  encodeData,
  encodeControl,
  ChannelReader,
  buildPipeSddl,
  lanPipePath,
  appRuleDisplayName,
  clampHelperFacts,
  isControlId,
  sanitizeRuleToken,
  validateGameExePath,
  CH_DATA,
  CH_CONTROL,
  LAN_PIPE_PROTO,
  MAX_APP_PATH,
  MAX_CONTROL_BYTES,
  MAX_DIAG_LIST,
  MAX_DIAG_STRING,
  MAX_RULE_TOKEN,
  type LanControlMsg,
  type LanHelperFacts,
} from './pipe-bridge';
import { encodeFrame } from '../../shared/lan-frame';

// A collecting reader harness: feed chunks, return what was demuxed.
function makeReader(maxControlBytes?: number) {
  const data: Buffer[] = [];
  const control: LanControlMsg[] = [];
  const reader = new ChannelReader({
    maxControlBytes,
    onData: (p) => data.push(p),
    onControl: (m) => control.push(m),
  });
  return { reader, data, control };
}

describe('encodeData', () => {
  it('frames a raw packet as [uint16 len][CH_DATA][packet]', () => {
    const packet = Buffer.from([0x45, 0x00, 0xde, 0xad]);
    const frame = encodeData(packet);
    expect(frame.readUInt16BE(0)).toBe(1 + packet.length);
    expect(frame[2]).toBe(CH_DATA);
    expect([...frame.subarray(3)]).toEqual([...packet]);
  });

  it('round-trips an empty packet (channel byte still present)', () => {
    const { reader, data } = makeReader();
    reader.push(encodeData(Buffer.alloc(0)));
    expect(data.length).toBe(1);
    expect(data[0].length).toBe(0);
  });
});

describe('encodeControl', () => {
  it('frames a control message as [uint16 len][CH_CONTROL][utf8 json]', () => {
    const frame = encodeControl({ t: 'ping' });
    expect(frame[2]).toBe(CH_CONTROL);
    expect(JSON.parse(frame.subarray(3).toString('utf8'))).toEqual({ t: 'ping' });
  });

  it('preserves utf8 payloads (cyrillic in an error message)', () => {
    const msg: LanControlMsg = { t: 'error', code: 'driver', message: 'сбой драйвера' };
    const { reader, control } = makeReader();
    reader.push(encodeControl(msg));
    expect(control[0]).toEqual(msg);
  });
});

describe('ChannelReader demux', () => {
  it('splits data and control off the SAME stream in order', () => {
    const { reader, data, control } = makeReader();
    const stream = Buffer.concat([
      encodeControl({ t: 'hello', token: 'abc', proto: LAN_PIPE_PROTO }),
      encodeData(Buffer.from([1, 2, 3])),
      encodeData(Buffer.from([4, 5])),
      encodeControl({ t: 'ready', adapter: 'Havvn LAN-x', vip: 1, subnetBase: 0, prefix: 16 }),
    ]);
    reader.push(stream);
    expect(control.map((m) => m.t)).toEqual(['hello', 'ready']);
    expect(data.map((d) => [...d])).toEqual([[1, 2, 3], [4, 5]]);
  });

  it('reassembles across every byte boundary', () => {
    const stream = Buffer.concat([
      encodeControl({ t: 'ping' }),
      encodeData(Buffer.from('a'.repeat(300))),
    ]);
    for (let cut = 1; cut < stream.length; cut++) {
      const { reader, data, control } = makeReader();
      reader.push(stream.subarray(0, cut));
      reader.push(stream.subarray(cut));
      expect(control.map((m) => m.t)).toEqual(['ping']);
      expect(data.length).toBe(1);
      expect(data[0].length).toBe(300);
    }
  });

  it('delivers a data copy that survives later pushes (no aliasing)', () => {
    const { reader, data } = makeReader();
    reader.push(encodeData(Buffer.from([1, 1, 1])));
    reader.push(encodeData(Buffer.from([2, 2, 2])));
    expect([...data[0]]).toEqual([1, 1, 1]);
  });

  it('throws (fatal) on an unknown channel byte', () => {
    const { reader } = makeReader();
    const bad = encodeFrame(Buffer.from([0x7f, 0x00])); // channel 0x7f
    expect(() => reader.push(bad)).toThrow(/unknown channel/);
  });

  it('throws on an empty frame (missing channel byte)', () => {
    const { reader } = makeReader();
    expect(() => reader.push(encodeFrame(Buffer.alloc(0)))).toThrow(/empty frame/);
  });

  it('throws on a control body that is not valid JSON', () => {
    const { reader } = makeReader();
    const payload = Buffer.concat([Buffer.from([CH_CONTROL]), Buffer.from('{not json', 'utf8')]);
    expect(() => reader.push(encodeFrame(payload))).toThrow(/not valid JSON/);
  });

  it('throws on a control message with no discriminator', () => {
    const { reader } = makeReader();
    const payload = Buffer.concat([Buffer.from([CH_CONTROL]), Buffer.from('{"x":1}', 'utf8')]);
    expect(() => reader.push(encodeFrame(payload))).toThrow(/missing discriminator/);
  });

  it('throws when a control body exceeds the cap', () => {
    const { reader } = makeReader(16); // tiny cap
    expect(() => reader.push(encodeControl({ t: 'error', code: 'driver', message: 'x'.repeat(200) }))).toThrow(/too large/);
  });

  it('accepts a control body up to the default cap boundary', () => {
    // Sanity: a normal-sized control message is well under MAX_CONTROL_BYTES.
    expect(encodeControl({ t: 'reip', vip: 0xffffffff, gen: 3 }).length).toBeLessThan(MAX_CONTROL_BYTES);
  });
});

describe('buildPipeSddl', () => {
  it('grants the interactive SID + SYSTEM GENERIC_ALL with a Medium NoWriteUp label', () => {
    const sddl = buildPipeSddl('S-1-5-21-1111111111-2222222222-3333333333-1001');
    expect(sddl).toBe('D:P(A;;GA;;;S-1-5-21-1111111111-2222222222-3333333333-1001)(A;;GA;;;SY)S:(ML;;NW;;;ME)');
  });

  it('uppercases the SID (SDDL is case-insensitive but we normalize)', () => {
    expect(buildPipeSddl('s-1-5-18')).toContain('S-1-5-18');
  });

  it('rejects a malformed SID (SDDL injection guard)', () => {
    expect(() => buildPipeSddl('not-a-sid')).toThrow(/valid SID/);
    expect(() => buildPipeSddl('S-1')).toThrow(/valid SID/);
    expect(() => buildPipeSddl('S-1-5-18)(A;;GA;;;WD')).toThrow(/valid SID/); // injection attempt
    expect(() => buildPipeSddl('')).toThrow(/valid SID/);
  });
});

describe('lanPipePath', () => {
  it('is per-session and uses the havvn-lan- prefix', () => {
    expect(lanPipePath('alice.deadbeefdeadbeef')).toBe('\\\\.\\pipe\\havvn-lan-alice.deadbeefdeadbeef');
  });
});

describe('hello handshake shape', () => {
  it('is a CH_CONTROL frame carrying token + proto', () => {
    const frame = encodeControl({ t: 'hello', token: 'secret', proto: LAN_PIPE_PROTO });
    expect(frame[2]).toBe(CH_CONTROL);
    const { reader, control } = makeReader();
    reader.push(frame);
    expect(control[0]).toEqual({ t: 'hello', token: 'secret', proto: LAN_PIPE_PROTO });
  });

  it('a mismatched token is detectable by value comparison', () => {
    const { reader, control } = makeReader();
    reader.push(encodeControl({ t: 'hello', token: 'wrong', proto: LAN_PIPE_PROTO }));
    const hello = control[0] as Extract<LanControlMsg, { t: 'hello' }>;
    expect(hello.token === 'expected').toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2A — request/response verbs, their bounds, and the privilege-boundary
// path validator. These verbs are the ONLY renderer-influenced input that ever
// reaches the elevated helper, so their bounds are load-bearing security, not
// hygiene.
// ─────────────────────────────────────────────────────────────────────────────

const FACTS: LanHelperFacts = {
  adapterName: 'Havvn LAN-alice.deadbeef',
  adapterPresent: true,
  adapterUp: true,
  adapterStatus: 'Up',
  ipAddresses: ['100.88.4.7'],
  expectedVip: '100.88.4.7',
  subnet: '100.88.0.0/16',
  mtu: 1280,
  firewallRules: ['Havvn LAN-alice.deadbeef In', 'Havvn LAN-alice.deadbeef Out'],
  appRules: [],
  driverVersion: '0.14',
  ringActive: true,
  helperPid: 4242,
  uptimeMs: 12_000,
};

describe('isControlId (correlation-id domain)', () => {
  it('accepts uint32', () => {
    expect(isControlId(0)).toBe(true);
    expect(isControlId(1)).toBe(true);
    expect(isControlId(0xffffffff)).toBe(true);
  });

  it('rejects anything that is not an in-range integer', () => {
    for (const bad of [-1, 1.5, 0x1_0000_0000, NaN, Infinity, '1', null, undefined, {}, []]) {
      expect(isControlId(bad)).toBe(false);
    }
  });
});

describe('Phase-2A verbs round-trip over the SAME channel codec', () => {
  it('carries allow-app / allow-app-result / diag / diag-result with their ids', () => {
    const msgs: LanControlMsg[] = [
      { t: 'allow-app', id: 7, exe: 'C:\\Games\\Minecraft\\launcher.exe' },
      { t: 'allow-app-result', id: 7, ok: true, rule: 'Havvn LAN-x App launcher.exe' },
      { t: 'diag', id: 8 },
      { t: 'diag-result', id: 8, facts: FACTS },
    ];
    const { reader, control, data } = makeReader();
    reader.push(Buffer.concat(msgs.map(encodeControl)));
    expect(control).toEqual(msgs);
    expect(data.length).toBe(0);
  });

  it('reports a refusal as allow-app-result (never as {t:error}, which is fatal)', () => {
    const { reader, control } = makeReader();
    reader.push(encodeControl({ t: 'allow-app-result', id: 3, ok: false, code: 'bad-app-path', message: 'rejected exe path (not-exe)' }));
    const m = control[0] as Extract<LanControlMsg, { t: 'allow-app-result' }>;
    expect(m.t).toBe('allow-app-result');
    expect(m.ok).toBe(false);
    expect(m.code).toBe('bad-app-path');
  });

  it('a fully-saturated diag-result still fits under the FATAL control cap', () => {
    const saturated: LanHelperFacts = {
      ...FACTS,
      ipAddresses: Array.from({ length: 64 }, () => 'x'.repeat(400)),
      firewallRules: Array.from({ length: 64 }, () => 'r'.repeat(400)),
      appRules: Array.from({ length: 64 }, () => 'a'.repeat(400)),
    };
    const frame = encodeControl({ t: 'diag-result', id: 1, facts: clampHelperFacts(saturated) });
    expect(frame.length).toBeLessThan(MAX_CONTROL_BYTES);
    // …and the UNclamped version is exactly what would have killed the bridge.
    const { reader } = makeReader(4096);
    expect(() => reader.push(encodeControl({ t: 'diag-result', id: 1, facts: saturated }))).toThrow(/too large/);
  });
});

describe('clampHelperFacts', () => {
  it('caps list length and per-string length', () => {
    const c = clampHelperFacts({
      ...FACTS,
      firewallRules: Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(500, 'x')),
      ipAddresses: Array.from({ length: 100 }, () => '1.2.3.4'),
      appRules: Array.from({ length: 100 }, () => 'a'),
    });
    expect(c.firewallRules.length).toBe(MAX_DIAG_LIST);
    expect(c.ipAddresses.length).toBe(MAX_DIAG_LIST);
    expect(c.appRules.length).toBe(MAX_DIAG_LIST);
    expect(c.firewallRules[0].length).toBe(MAX_DIAG_STRING);
  });

  it('coerces hostile/absent scalars instead of propagating them', () => {
    const c = clampHelperFacts({
      ...FACTS,
      mtu: NaN,
      helperPid: -5,
      uptimeMs: Infinity,
      adapterPresent: 1 as unknown as boolean,
      ipAddresses: undefined as unknown as string[],
    });
    expect(c.mtu).toBe(0);
    expect(c.helperPid).toBe(0);
    expect(c.uptimeMs).toBe(0);
    expect(c.adapterPresent).toBe(true);
    expect(c.ipAddresses).toEqual([]);
  });
});

describe('validateGameExePath (renderer → ELEVATED PowerShell boundary)', () => {
  it('accepts a plain drive-absolute .exe path', () => {
    expect(validateGameExePath('C:\\Program Files (x86)\\Steam\\steam.exe')).toEqual({
      ok: true,
      path: 'C:\\Program Files (x86)\\Steam\\steam.exe',
    });
    expect(validateGameExePath('D:\\g.EXE')).toEqual({ ok: true, path: 'D:\\g.EXE' });
  });

  it('rejects non-strings and empties', () => {
    expect(validateGameExePath(undefined)).toEqual({ ok: false, reason: 'not-a-string' });
    expect(validateGameExePath(42)).toEqual({ ok: false, reason: 'not-a-string' });
    expect(validateGameExePath({ path: 'C:\\a.exe' })).toEqual({ ok: false, reason: 'not-a-string' });
    expect(validateGameExePath('')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects a path longer than MAX_APP_PATH (never truncates)', () => {
    const long = `C:\\${'a'.repeat(MAX_APP_PATH)}\\x.exe`;
    expect(validateGameExePath(long)).toEqual({ ok: false, reason: 'too-long' });
  });

  it('rejects quotes, backticks, newlines, NUL and glob characters', () => {
    for (const bad of [
      "C:\\Games\\Assassin's Creed\\ac.exe", // apostrophe would need psq — refuse outright
      'C:\\Games\\a"b\\x.exe',
      'C:\\Games\\a`b\\x.exe',
      'C:\\Games\\a\nb\\x.exe',
      'C:\\Games\\a\r\\x.exe',
      'C:\\Games\\a\u0000b\\x.exe',
      'C:\\Games\\*\\x.exe',
      'C:\\Games\\?\\x.exe',
      'C:\\Games\\<x>\\x.exe',
      'C:\\Games\\a|b\\x.exe',
    ]) {
      expect(validateGameExePath(bad)).toEqual({ ok: false, reason: 'bad-chars' });
    }
  });

  it('rejects UNC and device paths — an elevated -Program must never be an SMB host', () => {
    expect(validateGameExePath('\\\\evil-server\\share\\game.exe')).toEqual({ ok: false, reason: 'not-absolute' });
    expect(validateGameExePath('\\\\?\\C:\\game.exe')).toEqual({ ok: false, reason: 'bad-chars' });
    expect(validateGameExePath('\\\\.\\pipe\\x.exe')).toEqual({ ok: false, reason: 'not-absolute' });
  });

  it('rejects relative, rootless and forward-slash paths', () => {
    expect(validateGameExePath('game.exe')).toEqual({ ok: false, reason: 'not-absolute' });
    expect(validateGameExePath('\\Games\\game.exe')).toEqual({ ok: false, reason: 'not-absolute' });
    expect(validateGameExePath('C:game.exe')).toEqual({ ok: false, reason: 'not-absolute' });
    expect(validateGameExePath('C:/Games/game.exe')).toEqual({ ok: false, reason: 'bad-chars' });
  });

  it('rejects traversal and empty segments', () => {
    expect(validateGameExePath('C:\\Games\\..\\Windows\\System32\\cmd.exe')).toEqual({ ok: false, reason: 'traversal' });
    expect(validateGameExePath('C:\\Games\\.\\g.exe')).toEqual({ ok: false, reason: 'traversal' });
    expect(validateGameExePath('C:\\Games\\\\g.exe')).toEqual({ ok: false, reason: 'traversal' });
    expect(validateGameExePath('C:\\')).toEqual({ ok: false, reason: 'traversal' });
  });

  it('rejects trailing-dot / trailing-space segments (Win32 canonicalisation drift)', () => {
    expect(validateGameExePath('C:\\Games \\g.exe')).toEqual({ ok: false, reason: 'bad-chars' });
    expect(validateGameExePath('C:\\Games.\\g.exe')).toEqual({ ok: false, reason: 'bad-chars' });
  });

  it('rejects anything that is not a .exe leaf', () => {
    expect(validateGameExePath('C:\\Games\\game.bat')).toEqual({ ok: false, reason: 'not-exe' });
    expect(validateGameExePath('C:\\Games\\game.exe.txt')).toEqual({ ok: false, reason: 'not-exe' });
    expect(validateGameExePath('C:\\Games\\game')).toEqual({ ok: false, reason: 'not-exe' });
    expect(validateGameExePath('C:\\Games\\.exe')).toEqual({ ok: false, reason: 'not-exe' });
    expect(validateGameExePath('C:\\Games\\dir.exe\\')).toEqual({ ok: false, reason: 'traversal' });
  });
});

describe('sanitizeRuleToken / appRuleDisplayName (teardown-sweep compatibility)', () => {
  it('keeps the full adapter name as the prefix so BOTH sweep globs match', () => {
    const adapter = 'Havvn LAN-alice.deadbeefdeadbeef';
    const name = appRuleDisplayName(adapter, 'C:\\Games\\Minecraft\\launcher.exe');
    expect(name).toBe(`${adapter} App launcher.exe`);
    // revertNetConfig matches '<adapterName>*'; orphanSweep matches 'Havvn LAN-*'.
    expect(name.startsWith(adapter)).toBe(true);
    expect(name.startsWith('Havvn LAN-')).toBe(true);
  });

  it('strips PowerShell wildcard metacharacters from the exe basename', () => {
    const name = appRuleDisplayName('Havvn LAN-x', 'C:\\g\\we[i]rd.exe');
    expect(name).toBe('Havvn LAN-x App we_i_rd.exe');
    expect(/[[\]*?']/.test(name)).toBe(false);
  });

  it('caps the token and never yields an empty one', () => {
    expect(sanitizeRuleToken('x'.repeat(500)).length).toBe(MAX_RULE_TOKEN);
    expect(sanitizeRuleToken('')).toBe('app');
    expect(sanitizeRuleToken('   ')).toBe('app');
    expect(sanitizeRuleToken('!!!')).toBe('___');
  });

  it('takes the basename regardless of separator style', () => {
    expect(appRuleDisplayName('A', 'C:\\a\\b\\c.exe')).toBe('A App c.exe');
    expect(appRuleDisplayName('A', 'c.exe')).toBe('A App c.exe');
  });
});

describe('module import safety (no koffi at import-time)', () => {
  it('importing the module does not require koffi', async () => {
    // A fresh import must not touch koffi (vitest has no koffi prebuild / no win32).
    const spy = vi.fn();
    vi.doMock('koffi', () => { spy(); return {}; });
    vi.resetModules();
    await import('./pipe-bridge');
    expect(spy).not.toHaveBeenCalled();
    vi.doUnmock('koffi');
  });
});
