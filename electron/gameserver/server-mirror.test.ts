/**
 * The gossiped server mirror: console cursors, role authority, and the
 * fingerprint that keeps an unchanged mirror off the wire.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMirrorPayload, mirrorFingerprint, mirroredRole, parseMirrorBody,
  serializeMirrorBody, trimConsoleTail, type ConsoleTailSample,
} from './server-mirror';
import type { MirroredServerInstance, RoomServerInstance } from '../../shared/gameserver-types';

const instance = (over: Partial<RoomServerInstance> = {}): RoomServerInstance => ({
  instanceId: 'inst-1',
  moduleId: 'minecraft',
  name: 'Survival',
  version: '1.21',
  hostId: 'host-a',
  isHost: true,
  role: 'host',
  status: 'running',
  since: 1_000,
  contentRev: 0,
  autoRestart: false,
  updatable: true,
  operators: [],
  ...over,
} as RoomServerInstance);

const tail = (lines: string[], lastSeq: number): Record<string, ConsoleTailSample> => ({
  'inst-1': { lines, lastSeq },
});

/** Round-trip a payload the way gossip does. */
const roundTrip = (state: ReturnType<typeof buildMirrorPayload>) =>
  parseMirrorBody(serializeMirrorBody(state));

describe('console tail cursors', () => {
  it('carries the host sequence of the last line, so earlier lines count back', () => {
    const payload = buildMirrorPayload('host-a', [instance()], tail(['a', 'b', 'c'], 42));
    const row = roundTrip(payload)!.instances[0];
    expect(row.consoleTail).toEqual(['a', 'b', 'c']);
    expect(row.consoleTailSeq).toBe(42);
    // 'a' is seq 40, 'b' 41, 'c' 42 — the receiver derives them from the anchor.
    expect(row.consoleTailSeq! - (row.consoleTail!.length - 1)).toBe(40);
  });

  it('keeps the anchor correct when the tail is trimmed', () => {
    // Trimming drops the OLDEST lines, so the last line — and its seq — survives.
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const payload = buildMirrorPayload('host-a', [instance()], tail(lines, 120));
    const row = payload.instances[0];
    expect(row.consoleTail).toHaveLength(8);
    expect(row.consoleTail![7]).toBe('line 19');
    expect(row.consoleTailSeq).toBe(120);
  });

  it('drops a tail that arrives without a usable sequence', () => {
    // Renumbering it from 1 is what produced duplicate lines forever; showing
    // nothing is the honest outcome for a peer on an older build.
    const body = JSON.stringify({
      hostId: 'host-a',
      at: Date.now(),
      instances: [{ instanceId: 'inst-1', operators: [], consoleTail: ['a', 'b'] }],
    });
    const row = parseMirrorBody(body)!.instances[0];
    expect(row.consoleTail).toBeUndefined();
    expect(row.consoleTailSeq).toBeUndefined();
  });

  it('truncates an over-long line rather than shipping it whole', () => {
    const payload = buildMirrorPayload('host-a', [instance()], tail(['x'.repeat(500)], 7));
    expect(payload.instances[0].consoleTail![0]).toHaveLength(241); // 240 + ellipsis
  });

  it('trimConsoleTail keeps the newest lines', () => {
    expect(trimConsoleTail(['1', '2', '3', '4', '5', '6', '7', '8', '9'])).toEqual(
      ['2', '3', '4', '5', '6', '7', '8', '9'],
    );
  });
});

describe('mirroredRole', () => {
  const row = (operators: string[]): MirroredServerInstance => ({
    instanceId: 'inst-1', moduleId: 'minecraft', name: 'S', version: '1.21',
    status: 'running', since: 0, operators, autoRestart: false,
  });

  it('reads the grant from the list the HOST published, not any local store', () => {
    // The grant lives on the host's machine. This is the only copy the operator
    // ever sees, and treating it as authoritative is what makes the feature work
    // at all — deciding locally returned `viewer` for everyone, forever.
    expect(mirroredRole('host-a', row(['me']), 'me')).toBe('operator');
    expect(mirroredRole('host-a', row(['someone-else']), 'me')).toBe('viewer');
    expect(mirroredRole('host-a', row([]), 'me')).toBe('viewer');
  });

  it('calls our own instances host, whatever the list says', () => {
    expect(mirroredRole('me', row([]), 'me')).toBe('host');
  });
});

describe('mirrorFingerprint', () => {
  it('ignores the timestamp, so an unchanged mirror is not re-flooded', () => {
    const a = buildMirrorPayload('host-a', [instance()], tail(['x'], 1));
    const b = buildMirrorPayload('host-a', [instance()], tail(['x'], 1));
    // Two probe ticks a minute apart say the same thing at different times.
    a.at = 1_000;
    b.at = 61_000;
    expect(a.at).not.toBe(b.at);
    expect(mirrorFingerprint(a)).toBe(mirrorFingerprint(b));
  });

  it('changes when anything a viewer would see changes', () => {
    const base = mirrorFingerprint(buildMirrorPayload('host-a', [instance()], tail(['x'], 1)));
    const stopped = mirrorFingerprint(buildMirrorPayload('host-a', [instance({ status: 'stopped' })], tail(['x'], 1)));
    const players = mirrorFingerprint(buildMirrorPayload(
      'host-a', [instance({ players: { online: 2, max: 10 } })], tail(['x'], 1),
    ));
    const newLine = mirrorFingerprint(buildMirrorPayload('host-a', [instance()], tail(['x', 'y'], 2)));
    const opGranted = mirrorFingerprint(buildMirrorPayload('host-a', [instance({ operators: ['bo'] })], tail(['x'], 1)));

    expect(new Set([base, stopped, players, newLine, opGranted]).size).toBe(5);
  });

  it('distinguishes an empty mirror from one with a server', () => {
    // "My last server is gone" has to be a distinguishable payload, or the
    // publish dedup would swallow it and peers would keep a ghost forever.
    const empty = mirrorFingerprint(buildMirrorPayload('host-a', [], {}));
    const one = mirrorFingerprint(buildMirrorPayload('host-a', [instance()], {}));
    expect(empty).not.toBe(one);
  });
});

describe('parseMirrorBody hardening', () => {
  it('rejects a body that is not a mirror', () => {
    expect(parseMirrorBody('not json')).toBeNull();
    expect(parseMirrorBody(JSON.stringify({ hostId: 'a' }))).toBeNull();
    expect(parseMirrorBody(JSON.stringify({ hostId: 'a', at: 'soon', instances: [] }))).toBeNull();
    expect(parseMirrorBody(JSON.stringify({ at: 1, instances: [] }))).toBeNull();
  });

  it('accepts an empty instance list — that is how a host says it has none', () => {
    const parsed = parseMirrorBody(JSON.stringify({ hostId: 'a', at: 1, instances: [] }));
    expect(parsed).toEqual({ hostId: 'a', at: 1, instances: [] });
  });

  it('caps the instance list and the operator list', () => {
    const body = JSON.stringify({
      hostId: 'a',
      at: 1,
      instances: Array.from({ length: 40 }, (_, i) => ({
        instanceId: `i${i}`,
        operators: Array.from({ length: 200 }, (_, k) => `op${k}`),
      })),
    });
    const parsed = parseMirrorBody(body)!;
    expect(parsed.instances).toHaveLength(16);
    expect(parsed.instances[0].operators).toHaveLength(64);
  });
});
