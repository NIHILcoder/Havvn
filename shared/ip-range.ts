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
