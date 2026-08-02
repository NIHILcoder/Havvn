/**
 * Every string the game-server surface can put on screen has to exist in BOTH
 * dictionaries.
 *
 * This is the guard for a bug that shipped twice. A module returns translation
 * KEYS rather than prose, precisely because the main process holds no dictionary —
 * but a key that was never added to en.json/ru.json renders as the key itself, and
 * nothing in the type system notices. The generic module shipped three such
 * fields, and the manager's refusals shipped as English sentences in a Russian UI.
 *
 * Reading the JSON directly rather than through the i18n runtime is deliberate:
 * the runtime falls back to English for a missing Russian key, which is exactly
 * the failure this test has to be able to see.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { minecraftModule } from './minecraft';
import { genericModule } from './generic';
import type { ConfigField, GameModule, InstanceView } from '../../../shared/gameserver-types';

const dict = (lang: 'en' | 'ru'): Record<string, string> =>
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'renderer', 'i18n', `${lang}.json`), 'utf8'));

const EN = dict('en');
const RU = dict('ru');

/** Every code the core can refuse with, read from the source so a code added
 *  without a translation fails here rather than in front of a user. */
function errorCodes(): string[] {
  const src = readFileSync(join(__dirname, '..', '..', '..', 'shared', 'gameserver-errors.ts'), 'utf8');
  const union = src.slice(src.indexOf('export type ServerErrorCode'), src.indexOf('export const SERVER_ERR_PREFIX'));
  return [...union.matchAll(/\|\s*'([a-z-]+)'/g)].map((m) => m[1]);
}

const view = (module: GameModule): InstanceView => ({
  instanceId: 'i',
  moduleId: module.id,
  roomId: 'r',
  name: 'n',
  ref: {
    id: 'x', label: 'l', flavour: 'vanilla', version: '1.21.4',
    runtime: { id: 'java', major: 21 }, stable: true,
  },
  config: {},
  installed: true,
  contentRev: 0,
});

/** Every key a single field can carry, including the option labels of a select. */
function keysOf(field: ConfigField): string[] {
  const keys = [field.labelKey, field.helpKey, field.warnKey];
  if (field.t === 'select') keys.push(...field.options.map((o) => o.labelKey));
  if (field.t === 'text') keys.push(field.placeholderKey);
  return keys.filter((k): k is string => typeof k === 'string' && k.length > 0);
}

const MODULES: GameModule[] = [minecraftModule, genericModule];

describe('the two dictionaries agree', () => {
  it('has no key in one and not the other', () => {
    expect(Object.keys(EN).filter((k) => !(k in RU))).toEqual([]);
    expect(Object.keys(RU).filter((k) => !(k in EN))).toEqual([]);
  });
});

describe.each(MODULES.map((m) => [m.id, m] as const))('%s module strings', (_id, module) => {
  it('settings form: every field key is translated in both languages', () => {
    const keys = module.configSchema(view(module)).flatMap(keysOf);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => !(k in EN))).toEqual([]);
    expect(keys.filter((k) => !(k in RU))).toEqual([]);
  });

  it('create form: every field key is translated in both languages', () => {
    const keys = (module.createSchema?.() ?? []).flatMap(keysOf);
    expect(keys.filter((k) => !(k in EN))).toEqual([]);
    expect(keys.filter((k) => !(k in RU))).toEqual([]);
  });

  it('content slots and the legal gate name themselves in both languages', () => {
    const keys = [
      ...(module.contentSlots?.(view(module)) ?? []).map((s) => s.labelKey),
      ...(module.legalGate ? [module.legalGate.labelKey] : []),
    ];
    expect(keys.filter((k) => !(k in EN))).toEqual([]);
    expect(keys.filter((k) => !(k in RU))).toEqual([]);
  });
});

describe('refusals from the main process', () => {
  const codes = errorCodes();

  it('reads the closed union out of the source', () => {
    // A sanity check on the parse itself: if this ever returns nothing, the test
    // below would pass vacuously and the guard would be gone.
    expect(codes.length).toBeGreaterThan(10);
    expect(codes).toContain('stop-first');
  });

  it('has a sentence for every code, in both languages', () => {
    const keys = codes.map((c) => `rooms.server.err.${c}`);
    expect(keys.filter((k) => !(k in EN))).toEqual([]);
    expect(keys.filter((k) => !(k in RU))).toEqual([]);
  });

  it('translates them, rather than shipping the English text twice', () => {
    // The bug this whole mechanism exists to fix was English prose in a Russian
    // UI, so an identical string here is almost certainly a forgotten translation.
    const same = codes.filter((c) => EN[`rooms.server.err.${c}`] === RU[`rooms.server.err.${c}`]);
    expect(same).toEqual([]);
  });
});
