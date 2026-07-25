import { describe, it, expect } from 'vitest';
import { encodeFrame, FrameReader, FRAME_HEADER, MAX_FRAME } from './lan-frame';

const collect = (reader: FrameReader, chunks: Buffer[]): Buffer[] => {
  const out: Buffer[] = [];
  for (const c of chunks) reader.push(c, (p) => out.push(p));
  return out;
};

describe('encodeFrame', () => {
  it('prefixes a big-endian uint16 length', () => {
    const f = encodeFrame(Buffer.from([1, 2, 3]));
    expect(f.length).toBe(FRAME_HEADER + 3);
    expect(f.readUInt16BE(0)).toBe(3);
    expect([...f.subarray(2)]).toEqual([1, 2, 3]);
  });
  it('rejects a payload larger than the prefix can express', () => {
    expect(() => encodeFrame(Buffer.alloc(MAX_FRAME + 1))).toThrow();
  });
  it('round-trips an empty payload', () => {
    const out = collect(new FrameReader(), [encodeFrame(Buffer.alloc(0))]);
    expect(out.length).toBe(1);
    expect(out[0].length).toBe(0);
  });
});

describe('FrameReader', () => {
  const payloads = [Buffer.from('hello'), Buffer.from([0xde, 0xad, 0xbe, 0xef]), Buffer.from('a'.repeat(1280))];
  const stream = Buffer.concat(payloads.map(encodeFrame));

  it('reassembles frames delivered whole', () => {
    const out = collect(new FrameReader(), [stream]);
    expect(out.map((b) => b.length)).toEqual(payloads.map((p) => p.length));
    expect(out[0].toString()).toBe('hello');
    expect([...out[1]]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('reassembles across every byte boundary (headers + payloads split)', () => {
    for (let cut = 1; cut < stream.length; cut++) {
      const out = collect(new FrameReader(), [stream.subarray(0, cut), stream.subarray(cut)]);
      expect(out.length).toBe(3);
      expect(out[0].toString()).toBe('hello');
      expect(out[2].length).toBe(1280);
    }
  });

  it('reassembles one-byte-at-a-time', () => {
    const chunks = [...stream].map((b) => Buffer.from([b]));
    const out = collect(new FrameReader(), chunks);
    expect(out.length).toBe(3);
    expect(out[2].length).toBe(1280);
  });

  it('handles many frames coalesced into one chunk', () => {
    const many = Buffer.concat(Array.from({ length: 100 }, (_, i) => encodeFrame(Buffer.from([i]))));
    const out = collect(new FrameReader(), [many]);
    expect(out.length).toBe(100);
    expect(out[42][0]).toBe(42);
  });

  it('delivers a copy that survives later pushes (no aliasing)', () => {
    const r = new FrameReader();
    const held: Buffer[] = [];
    r.push(encodeFrame(Buffer.from([1, 1, 1])), (p) => held.push(p));
    r.push(encodeFrame(Buffer.from([2, 2, 2])), (p) => held.push(p));
    expect([...held[0]]).toEqual([1, 1, 1]); // not clobbered by the second frame
  });

  it('throws on an oversized length prefix (hostile transport)', () => {
    const r = new FrameReader(1000);
    const bad = Buffer.alloc(2);
    bad.writeUInt16BE(2000, 0); // claims 2000 > maxFrame 1000
    expect(() => r.push(bad, () => { /* noop */ })).toThrow(/oversized/);
  });
});
