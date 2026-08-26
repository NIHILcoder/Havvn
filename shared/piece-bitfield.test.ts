import { describe, it, expect } from 'vitest';
import { decodePieceBitfield, bucketHave, summarizePieces, EMPTY_PIECES } from './piece-bitfield';

describe('decodePieceBitfield', () => {
  it('reads MSB-first (piece 0 = 0x80 of the first byte)', () => {
    // 0x80 = 10000000 → piece 0 have, 1–7 missing
    const have = decodePieceBitfield(Buffer.from([0x80]).toString('base64'), 8);
    expect(Array.from(have)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('reads a full byte of haves', () => {
    const have = decodePieceBitfield(Buffer.from([0xff]).toString('base64'), 8);
    expect(Array.from(have)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });
  it('returns zeros for empty input', () => {
    expect(Array.from(decodePieceBitfield('', 4))).toEqual([0, 0, 0, 0]);
    expect(summarizePieces('', 0, 262144)).toEqual(EMPTY_PIECES);
  });
});

describe('bucketHave', () => {
  it('is identity when there are fewer pieces than buckets', () => {
    expect(bucketHave(Uint8Array.from([1, 0, 1]), 160)).toEqual([1, 0, 1]);
  });
  it('averages when collapsing', () => {
    expect(bucketHave(Uint8Array.from([1, 1, 0, 0]), 2)).toEqual([1, 0]);
  });
});
