import { describe, it, expect } from 'vitest';
import { ipToNum, ipInRanges } from './ip-range';

describe('ipToNum', () => {
  it('parses dotted IPv4 to uint32', () => {
    expect(ipToNum('0.0.0.0')).toBe(0);
    expect(ipToNum('255.255.255.255')).toBe(4294967295);
    expect(ipToNum('192.168.1.1')).toBe(((192 << 24) | (168 << 16) | (1 << 8) | 1) >>> 0);
  });

  it('strips IPv4-mapped IPv6', () => {
    expect(ipToNum('::ffff:1.2.3.4')).toBe(ipToNum('1.2.3.4'));
  });

  it('rejects malformed / out-of-range input', () => {
    expect(ipToNum('1.2.3')).toBeNull();
    expect(ipToNum('256.1.1.1')).toBeNull();
    expect(ipToNum('not-an-ip')).toBeNull();
    expect(ipToNum('')).toBeNull();
  });
});

describe('ipInRanges', () => {
  const ranges: Array<[number, number]> = [
    [ipToNum('1.0.0.0')!, ipToNum('1.0.0.255')!],
    [ipToNum('10.0.0.0')!, ipToNum('10.255.255.255')!],
    [ipToNum('200.1.1.1')!, ipToNum('200.1.1.1')!],
  ];

  it('finds IPs inside ranges (incl. boundaries and single-IP ranges)', () => {
    expect(ipInRanges(ranges, ipToNum('1.0.0.0')!)).toBe(true);
    expect(ipInRanges(ranges, ipToNum('1.0.0.255')!)).toBe(true);
    expect(ipInRanges(ranges, ipToNum('10.5.5.5')!)).toBe(true);
    expect(ipInRanges(ranges, ipToNum('200.1.1.1')!)).toBe(true);
  });

  it('rejects IPs outside every range', () => {
    expect(ipInRanges(ranges, ipToNum('1.0.1.0')!)).toBe(false);
    expect(ipInRanges(ranges, ipToNum('9.255.255.255')!)).toBe(false);
    expect(ipInRanges(ranges, ipToNum('11.0.0.0')!)).toBe(false);
    expect(ipInRanges([], ipToNum('1.2.3.4')!)).toBe(false);
  });
});
