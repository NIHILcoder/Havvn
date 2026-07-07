/**
 * Pure IPv4 range helpers, shared by the IP-blocklist parsing (main) and the
 * peer filtering (torrent host). Kept dependency-free so it's trivially testable.
 */

/** Parse a dotted IPv4 string to a uint32, or null if malformed. Accepts
 *  IPv4-mapped IPv6 (e.g. "::ffff:1.2.3.4"). */
export function ipToNum(ip: string): number | null {
  const stripped = ip.replace(/^::ffff:/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(stripped);
  if (!m) return null;
  const p = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (p.some((n) => n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/** Whether `ipNum` falls inside any range, via binary search. `ranges` MUST be
 *  sorted ascending by start and non-overlapping (the blocklist merges them). */
export function ipInRanges(ranges: ReadonlyArray<readonly [number, number]>, ipNum: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (ipNum < ranges[mid][0]) hi = mid - 1;
    else if (ipNum > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** uint32 → dotted-quad IPv4 string. */
export function numToIp(n: number): string {
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

/**
 * Addresses the geo/country lookup should skip: private, loopback, link-local,
 * CGNAT, "this network", and any non-dotted-quad (IPv6/hostname). Returns true
 * to mean "don't try to locate this".
 */
export function isPrivateOrReservedIPv4(addr: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return true; // not a dotted-quad → don't try to locate it
  const a = +m[1], b = +m[2];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;      // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}
