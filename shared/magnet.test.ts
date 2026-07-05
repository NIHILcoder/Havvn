import { describe, it, expect } from 'vitest';
import { base32ToHex, extractInfoHashFromMagnet } from './magnet';

// Real 20-byte infohash in both encodings (RFC 4648 base32 <-> hex).
const HEX = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';
const B32 = '3WBFL3G4PSSV7MF37AJSHWDQMLNR63I4';

describe('base32ToHex', () => {
  it('decodes a 32-char base32 infohash to 40-char lowercase hex', () => {
    expect(base32ToHex(B32)).toBe(HEX);
  });
  it('is case-insensitive on input', () => {
    expect(base32ToHex(B32.toLowerCase())).toBe(HEX);
  });
  it('returns null on an invalid alphabet char', () => {
    expect(base32ToHex('0'.repeat(32))).toBeNull(); // 0,1,8,9 are not in base32
  });
  it('returns null when the decode is not exactly 20 bytes', () => {
    expect(base32ToHex('ABCDEFGH')).toBeNull();
  });
});

describe('extractInfoHashFromMagnet', () => {
  it('passes a 40-hex xt through, lowercased', () => {
    expect(extractInfoHashFromMagnet(`magnet:?xt=urn:btih:${HEX.toUpperCase()}&dn=x`)).toBe(HEX);
  });
  it('normalizes a base32 xt to the SAME hex — the dedup invariant', () => {
    const fromHex = extractInfoHashFromMagnet(`magnet:?xt=urn:btih:${HEX}`);
    const fromB32 = extractInfoHashFromMagnet(`magnet:?xt=urn:btih:${B32}`);
    expect(fromHex).toBe(HEX);
    expect(fromB32).toBe(HEX);
    expect(fromB32).toBe(fromHex); // same content, same encoding-independent hash
  });
  it('returns null when there is no btih xt', () => {
    expect(extractInfoHashFromMagnet('magnet:?dn=nothing')).toBeNull();
    expect(extractInfoHashFromMagnet('not a magnet')).toBeNull();
  });
  it('returns null for a malformed hash length', () => {
    expect(extractInfoHashFromMagnet('magnet:?xt=urn:btih:deadbeef')).toBeNull();
  });
});
