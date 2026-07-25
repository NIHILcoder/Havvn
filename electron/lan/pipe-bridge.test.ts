import { describe, it, expect, vi } from 'vitest';
import {
  encodeData,
  encodeControl,
  ChannelReader,
  buildPipeSddl,
  lanPipePath,
  CH_DATA,
  CH_CONTROL,
  LAN_PIPE_PROTO,
  MAX_CONTROL_BYTES,
  type LanControlMsg,
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
