import { describe, it, expect } from 'vitest';
import {
  parseIpv4, ipChecksum, classifyDest, shouldReplicate,
  LIMITED_BROADCAST, MDNS_ADDR, SSDP_ADDR, IP_PROTO_UDP,
} from './lan-packet';

// Canonical Wikipedia IPv4 header example; bytes 10-11 are the checksum (b861).
function hdr(withChecksum: boolean): Buffer {
  const b = Buffer.from('45000073000040004011b861c0a80001c0a800c7', 'hex');
  if (!withChecksum) b.writeUInt16BE(0, 10);
  return b;
}

describe('ipChecksum', () => {
  it('reproduces the known IPv4 header checksum', () => {
    expect(ipChecksum(hdr(false), 0, 20)).toBe(0xb861);
  });

  it('checksums a valid header back to 0', () => {
    expect(ipChecksum(hdr(true), 0, 20)).toBe(0x0000);
  });

  it('handles an odd-length range', () => {
    // deterministic, just exercises the trailing-byte branch without throwing
    const b = Buffer.from([0x12, 0x34, 0x56]);
    expect(ipChecksum(b, 0, 3)).toBeTypeOf('number');
  });
});

describe('parseIpv4', () => {
  it('parses a well-formed header', () => {
    // totalLength (0x73) declares the full packet — pad the frame to match, or
    // the truncation guard (correctly) rejects it.
    const frame = Buffer.concat([hdr(true), Buffer.alloc(0x73 - 20)]);
    const h = parseIpv4(frame)!;
    expect(h).not.toBeNull();
    expect(h.version).toBe(4);
    expect(h.ihl).toBe(20);
    expect(h.proto).toBe(IP_PROTO_UDP); // 0x11
    expect(h.totalLength).toBe(0x73);
    expect(h.src >>> 0).toBe(0xc0a80001); // 192.168.0.1
    expect(h.dst >>> 0).toBe(0xc0a800c7); // 192.168.0.199
  });

  it('rejects hostile / malformed input', () => {
    expect(parseIpv4(Buffer.alloc(10))).toBeNull();            // too short
    expect(parseIpv4(Buffer.alloc(20))).toBeNull();            // version 0
    const badIhl = hdr(true); badIhl[0] = 0x44;                 // ihl=16 (<20)
    expect(parseIpv4(badIhl)).toBeNull();
    const badLen = hdr(true); badLen.writeUInt16BE(9999, 2);    // totalLength > frame
    expect(parseIpv4(badLen)).toBeNull();
    const shortLen = hdr(true); shortLen.writeUInt16BE(10, 2);  // totalLength < ihl
    expect(parseIpv4(shortLen)).toBeNull();
  });
});

describe('classifyDest / shouldReplicate', () => {
  const subnetBcast = 0x6450ffff >>> 0; // 100.80.255.255

  it('classifies limited + directed broadcast', () => {
    expect(classifyDest(LIMITED_BROADCAST)).toBe('broadcast');
    expect(classifyDest(subnetBcast, subnetBcast)).toBe('broadcast');
    expect(classifyDest(subnetBcast)).toBe('unicast'); // not broadcast without subnet ctx
  });

  it('classifies mDNS + SSDP + generic multicast', () => {
    expect(classifyDest(MDNS_ADDR)).toBe('multicast');
    expect(classifyDest(SSDP_ADDR)).toBe('multicast');
    expect(classifyDest(0xe0000001)).toBe('multicast'); // 224.0.0.1
    expect(classifyDest(0xefffffff)).toBe('multicast'); // 239.255.255.255 (top of 224/4)
  });

  it('classifies ordinary unicast', () => {
    expect(classifyDest(0x08080808)).toBe('unicast'); // 8.8.8.8
    expect(classifyDest(0x64500001)).toBe('unicast'); // a peer vIP
  });

  it('replicates everything that is not unicast', () => {
    expect(shouldReplicate(LIMITED_BROADCAST)).toBe(true);
    expect(shouldReplicate(MDNS_ADDR)).toBe(true);
    expect(shouldReplicate(subnetBcast, subnetBcast)).toBe(true);
    expect(shouldReplicate(0x08080808)).toBe(false);
  });
});
