/**
 * Pure IPv4 packet helpers for the Havvn LAN router — header parse, the
 * ones-complement checksum, and the broadcast/multicast classification that
 * decides which frames get replicated to every session peer (the auto-discovery
 * killer-feature, plan §4). Dependency-free + adversarially testable, same
 * contract as ip-range.ts / profile.ts (hostile binary input).
 *
 * The router (engine window) is the "routing brain": it parses dst, verifies
 * src == the sender's assigned vIP, looks up vIP→memberId, and replicates
 * broadcast/multicast to all peers. The elevated helper stays a dumb shovel.
 */

export const IP_PROTO_ICMP = 1;
export const IP_PROTO_UDP = 17;

export const LIMITED_BROADCAST = 0xffffffff >>> 0; // 255.255.255.255
export const MDNS_ADDR = 0xe00000fb >>> 0;         // 224.0.0.251
export const SSDP_ADDR = 0xeffffffa >>> 0;         // 239.255.255.250

export type DestClass = 'unicast' | 'broadcast' | 'multicast';

export interface Ipv4Header {
  version: number;
  ihl: number;        // header length in bytes (>=20)
  totalLength: number;
  proto: number;
  src: number;        // uint32
  dst: number;        // uint32
}

/**
 * Parse (and sanity-check) an IPv4 header. Returns null for anything that is
 * not a well-formed IPv4 packet — the router must drop those, never trust a
 * peer-supplied frame past this gate.
 */
export function parseIpv4(buf: Buffer): Ipv4Header | null {
  if (buf.length < 20) return null;
  const version = buf[0] >>> 4;
  if (version !== 4) return null;
  const ihl = (buf[0] & 0x0f) * 4;
  if (ihl < 20 || buf.length < ihl) return null;
  const totalLength = buf.readUInt16BE(2);
  // totalLength must cover at least the header and not exceed the frame.
  if (totalLength < ihl || totalLength > buf.length) return null;
  return {
    version,
    ihl,
    totalLength,
    proto: buf[9],
    src: buf.readUInt32BE(12) >>> 0,
    dst: buf.readUInt32BE(16) >>> 0,
  };
}

/**
 * Internet checksum (RFC 1071): ones-complement sum of 16-bit big-endian words
 * over [offset, offset+length). Used for the IPv4 header and ICMP. A correct,
 * in-place checksum verifies back to 0 over its own range.
 */
export function ipChecksum(buf: Buffer, offset = 0, length = buf.length - offset): number {
  let sum = 0;
  const end = offset + length;
  let i = offset;
  for (; i + 1 < end; i += 2) sum += buf.readUInt16BE(i);
  if (i < end) sum += buf[i] << 8; // final odd byte, padded low-zero
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

/**
 * Classify a destination for routing. `subnetBroadcast` (the session /16's
 * directed broadcast, from lan-ip.sessionSubnet) is matched as broadcast when
 * provided. Multicast = 224.0.0.0/4 (covers mDNS 224.0.0.251 + SSDP
 * 239.255.255.250 and the 224.0.0.0/4 escape-hatch).
 */
export function classifyDest(dst: number, subnetBroadcast?: number): DestClass {
  const d = dst >>> 0;
  if (d === LIMITED_BROADCAST) return 'broadcast';
  if (subnetBroadcast !== undefined && d === (subnetBroadcast >>> 0)) return 'broadcast';
  if ((d >>> 28) === 0xe) return 'multicast'; // 1110b top nibble → 224.0.0.0/4
  return 'unicast';
}

/** Whether a frame must be replicated to every session peer (vs unicast-routed). */
export function shouldReplicate(dst: number, subnetBroadcast?: number): boolean {
  return classifyDest(dst, subnetBroadcast) !== 'unicast';
}
