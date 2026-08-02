import { describe, it, expect } from 'vitest';
import { parseProperties, serializeProperties, propInt, propBool } from './properties';
import { parseMinecraftLine, stripPrefix } from './log-parser';
import { buildAnnouncePayload, MC_ANNOUNCE_HOST, MC_ANNOUNCE_PORT } from './announce';
import { minecraftModule } from './index';
import { coerceConfigValue } from '../../../../shared/gameserver-core';
import type { ConfigField } from '../../../../shared/gameserver-types';

describe('server.properties parsing', () => {
  it('reads the ordinary generated file', () => {
    const text = [
      '#Minecraft server properties',
      '#Sat Aug 01 12:00:00 UTC 2026',
      'server-port=25565',
      'motd=A Minecraft Server',
      'max-players=20',
      'online-mode=true',
    ].join('\n');
    const p = parseProperties(text);
    expect(p['server-port']).toBe('25565');
    expect(p.motd).toBe('A Minecraft Server');
    expect(p['online-mode']).toBe('true');
  });

  it('accepts every separator java.util.Properties accepts', () => {
    const p = parseProperties(['a=1', 'b:2', 'c 3', 'd = 4', 'e : 5'].join('\n'));
    expect(p).toEqual({ a: '1', b: '2', c: '3', d: '4', e: '5' });
  });

  it('ignores comments and blank lines, with either comment marker', () => {
    const p = parseProperties(['# hash', '! bang', '', '   ', 'k=v'].join('\n'));
    expect(p).toEqual({ k: 'v' });
  });

  it('decodes escapes, including the unicode form Minecraft writes', () => {
    const p = parseProperties(String.raw`motd=Hello\u0021 \n tab\there \: colon`);
    expect(p.motd).toBe('Hello! \n tab\there : colon');
  });

  it('joins continuation lines', () => {
    const p = parseProperties(['long=one\\', 'two'].join('\n'));
    expect(p.long).toBe('onetwo');
  });

  it('keeps an empty value rather than dropping the key', () => {
    const p = parseProperties(['level-seed=', 'resource-pack='].join('\n'));
    expect(p['level-seed']).toBe('');
    expect('resource-pack' in p).toBe(true);
  });

  it('reads typed helpers with fallbacks', () => {
    const p = { 'server-port': '25565', 'white-list': 'true', junk: 'abc' };
    expect(propInt(p, 'server-port', 1)).toBe(25565);
    expect(propInt(p, 'junk', 7)).toBe(7);
    expect(propInt(p, 'absent', 9)).toBe(9);
    expect(propBool(p, 'white-list', false)).toBe(true);
    expect(propBool(p, 'junk', true)).toBe(true);
  });
});

describe('server.properties round-trip', () => {
  const original = [
    '#Minecraft server properties',
    '#Sat Aug 01 12:00:00 UTC 2026',
    'server-port=25565',
    'motd=Old motd',
    '',
    '# a hand-written note',
    'some-plugin-setting=keep me',
  ].join('\n');

  it('preserves comments, order and unknown keys when saving', () => {
    // The failure this guards against: a user hand-edits a setting our schema
    // has never heard of, opens the form, saves, and the edit is gone.
    const parsed = parseProperties(original);
    const out = serializeProperties({ ...parsed, motd: 'New motd' }, original);
    expect(out).toContain('#Minecraft server properties');
    expect(out).toContain('# a hand-written note');
    expect(out).toContain('some-plugin-setting=keep me');
    expect(out).toContain('motd=New motd');
    expect(out).not.toContain('Old motd');
    // Order is unchanged.
    expect(out.indexOf('server-port')).toBeLessThan(out.indexOf('motd'));
  });

  it('appends genuinely new keys once, after a single blank line', () => {
    const out = serializeProperties({ ...parseProperties(original), 'white-list': 'true' }, original);
    expect(out).toContain('white-list=true');
    expect(out.match(/white-list=/g)?.length).toBe(1);
    expect(out.endsWith('\n')).toBe(true);
    expect(out).not.toMatch(/\n\n\n/);
  });

  it('leaves keys absent from the save untouched', () => {
    const out = serializeProperties({ motd: 'Only this' }, original);
    expect(out).toContain('server-port=25565');
    expect(out).toContain('motd=Only this');
  });

  it('escapes values that would otherwise corrupt the file', () => {
    const out = serializeProperties({ motd: 'line\nbreak\\slash' });
    expect(out).toBe('motd=line\\nbreak\\\\slash\n');
    expect(parseProperties(out).motd).toBe('line\nbreak\\slash');
  });

  it('produces a sorted file when there is no previous text', () => {
    expect(serializeProperties({ b: '2', a: '1' })).toBe('a=1\nb=2\n');
  });
});

describe('minecraft log prefix', () => {
  it('handles the three shapes that occur on servers people actually run', () => {
    expect(stripPrefix('[12:34:56] [Server thread/INFO]: hello'))
      .toEqual({ thread: 'Server thread', level: 'INFO', message: 'hello' });
    expect(stripPrefix('[12:34:56] [Server thread/INFO] [minecraft/DedicatedServer]: hello'))
      .toEqual({ thread: 'Server thread', level: 'INFO', message: 'hello' });
    expect(stripPrefix('[12:34:56 INFO]: hello'))
      .toEqual({ thread: 'Server thread', level: 'INFO', message: 'hello' });
  });

  it('returns null for un-prefixed JVM output', () => {
    expect(stripPrefix('Error: Invalid or corrupt jarfile server.jar')).toBeNull();
  });
});

describe('parseMinecraftLine', () => {
  const line = (msg: string, level = 'INFO'): string => `[12:34:56] [Server thread/${level}]: ${msg}`;

  it('detects readiness and its duration', () => {
    expect(parseMinecraftLine(line('Done (12.345s)! For help, type "help"')))
      .toEqual([{ t: 'ready', tookMs: 12345 }]);
  });

  it('tracks joins and leaves', () => {
    expect(parseMinecraftLine(line('Steve joined the game'))).toEqual([{ t: 'player-join', name: 'Steve' }]);
    expect(parseMinecraftLine(line('Steve left the game'))).toEqual([{ t: 'player-leave', name: 'Steve' }]);
    expect(parseMinecraftLine(line('Steve lost connection: Disconnected')))
      .toEqual([{ t: 'player-leave', name: 'Steve' }]);
  });

  it('reads chat', () => {
    expect(parseMinecraftLine(line('<Steve> hello there')))
      .toEqual([{ t: 'chat', name: 'Steve', text: 'hello there' }]);
    expect(parseMinecraftLine(line('<Steve> '))).toEqual([{ t: 'chat', name: 'Steve', text: '' }]);
  });

  it('refuses to let a player forge events by typing them', () => {
    // Chat is matched first precisely so this cannot become a join event — or,
    // far worse, a fatal error that stops the server.
    expect(parseMinecraftLine(line('<Steve> Alex joined the game')))
      .toEqual([{ t: 'chat', name: 'Steve', text: 'Alex joined the game' }]);
    expect(parseMinecraftLine(line('<Steve> java.lang.OutOfMemoryError')))
      .toEqual([{ t: 'chat', name: 'Steve', text: 'java.lang.OutOfMemoryError' }]);
  });

  it('does not mistake log chatter for a player name', () => {
    expect(parseMinecraftLine(line('Some Mod Name joined the game'))).toEqual([]);
    expect(parseMinecraftLine(line('waaaaaaytoolongusername joined the game'))).toEqual([]);
  });

  it('reads spawn and mod-loading progress', () => {
    expect(parseMinecraftLine(line('Preparing spawn area: 42%')))
      .toEqual([{ t: 'progress', label: 'Preparing spawn area', pct: 42 }]);
    // The dimension id has its own colon, which must stay in the label.
    expect(parseMinecraftLine(line('Preparing start region for dimension minecraft:overworld: 7%')))
      .toEqual([{ t: 'progress', label: 'Preparing start region for dimension minecraft:overworld', pct: 7 }]);
  });

  it('maps levels to warn and error', () => {
    expect(parseMinecraftLine(line("Can't keep up! Is the server overloaded?", 'WARN')))
      .toEqual([{ t: 'warn', text: "Can't keep up! Is the server overloaded?" }]);
    expect(parseMinecraftLine(line('Something broke', 'ERROR')))
      .toEqual([{ t: 'error', text: 'Something broke' }]);
  });

  it('flags conditions that would recur on restart as fatal', () => {
    const cases: [string, string][] = [
      ['java.lang.OutOfMemoryError: Java heap space', 'out of memory'],
      ['**** FAILED TO BIND TO PORT!', 'port is already in use'],
      ['You need to agree to the EULA in order to run the server.', 'EULA'],
      ['java.lang.UnsupportedClassVersionError: bad class file version', 'newer Java'],
    ];
    for (const [text, expected] of cases) {
      const [event] = parseMinecraftLine(line(text, 'ERROR'));
      expect(event).toBeDefined();
      expect(event.t).toBe('error');
      if (event.t === 'error') {
        expect(event.fatal).toBe(true);
        expect(event.text).toContain(expected);
      }
    }
  });

  it('sees fatal JVM output that has no log prefix at all', () => {
    // These are printed before Minecraft's logger exists, so a parser that only
    // handled prefixed lines would restart three times into the same wall.
    const [event] = parseMinecraftLine('Error: Invalid or corrupt jarfile server.jar');
    expect(event.t).toBe('error');
    if (event.t === 'error') expect(event.fatal).toBe(true);
  });

  it('ignores ordinary informational noise', () => {
    expect(parseMinecraftLine(line('Starting minecraft server version 1.21.4'))).toEqual([]);
    expect(parseMinecraftLine(line('Loading properties'))).toEqual([]);
    expect(parseMinecraftLine('')).toEqual([]);
    expect(parseMinecraftLine('random unprefixed chatter')).toEqual([]);
  });
});

describe('LAN announce payload', () => {
  it('builds the packet a client scans for', () => {
    // A dedicated server never sends this; only a singleplayer world opened to
    // LAN does. Havvn sends it on the server's behalf, which is what makes the
    // server appear in the LAN list without anyone typing an address.
    expect(buildAnnouncePayload('My Server', 25565).toString('utf8'))
      .toBe('[MOTD]My Server[/MOTD][AD]25565[/AD]');
    expect(MC_ANNOUNCE_HOST).toBe('224.0.2.60');
    expect(MC_ANNOUNCE_PORT).toBe(4445);
  });

  it('strips characters that would break the delimiters or the client parser', () => {
    expect(buildAnnouncePayload('a[/MOTD]b', 25565).toString('utf8'))
      .toBe('[MOTD]aMOTDb[/MOTD][AD]25565[/AD]');
    expect(buildAnnouncePayload('line\nbreak', 25565).toString('utf8'))
      .toBe('[MOTD]line break[/MOTD][AD]25565[/AD]');
  });

  it('caps a long motd and falls back for an empty one', () => {
    const long = buildAnnouncePayload('x'.repeat(200), 25565).toString('utf8');
    expect(long.length).toBeLessThan(120);
    expect(buildAnnouncePayload('   ', 25565).toString('utf8'))
      .toBe('[MOTD]Havvn server[/MOTD][AD]25565[/AD]');
  });

  it('rejects an out-of-range port rather than announcing nonsense', () => {
    expect(() => buildAnnouncePayload('x', 0)).toThrow();
    expect(() => buildAnnouncePayload('x', 70000)).toThrow();
  });
});

describe('the create form the module asks for', () => {
  const create = minecraftModule.createSchema?.() ?? [];
  const settings = minecraftModule.configSchema({
    instanceId: 'i', moduleId: 'minecraft', roomId: 'r', name: 'n',
    ref: { id: 'vanilla:1.21.4', label: 'l', flavour: 'vanilla', version: '1.21.4', runtime: { id: 'java', major: 21 }, stable: true },
    config: {}, installed: true, contentRev: 0,
  });

  it('asks the four settings that are painful to change afterwards, in that order', () => {
    // Port first because it is the one the core pre-fills and the one that used to
    // break the second server in a room silently.
    expect(create.map((f) => f.key)).toEqual(['server-port', 'havvn-memory-mb', 'motd', 'max-players']);
  });

  it('is a strict subset of the settings form, field for field', () => {
    // Same key AND same descriptor: a field that drifted would validate one way at
    // creation and another way in settings, on the same file. `advanced` is the one
    // permitted difference — it is a settings-form affordance for hiding things.
    const shape = ({ advanced: _a, ...rest }: ConfigField & { advanced?: boolean }): unknown => rest;
    const byKey = new Map(settings.map((f) => [f.key, f]));
    for (const f of create) {
      const match = byKey.get(f.key);
      expect(match).toBeDefined();
      expect(shape(match as ConfigField)).toEqual(shape(f));
    }
  });

  it('hides nothing behind the advanced toggle, which the create form has no room for', () => {
    expect(create.some((f) => f.advanced)).toBe(false);
  });

  it('leaves the many settings that are changeable later out of it', () => {
    const asked = new Set(create.map((f) => f.key));
    for (const key of ['difficulty', 'gamemode', 'pvp', 'level-seed', 'white-list', 'online-mode']) {
      expect(asked.has(key)).toBe(false);
    }
  });

  it('names the port field the port plan fills in', () => {
    // If these two disagree, every new instance is created on the default port and
    // the collision the plan exists to prevent comes straight back.
    expect(minecraftModule.portPlan?.configKey).toBe('server-port');
    expect(create.some((f) => f.key === minecraftModule.portPlan?.configKey)).toBe(true);
    expect(minecraftModule.portPlan?.base).toBe(25565);
  });

  it('bounds every field it asks, so a typed value cannot reach the file unchecked', () => {
    for (const f of create) {
      if (f.t === 'int') {
        expect(Number.isInteger(f.min)).toBe(true);
        expect(Number.isInteger(f.max)).toBe(true);
      }
      if (f.t === 'text') expect(coerceConfigValue(f, 'a\nb').ok).toBe(false);
    }
  });
});
