/**
 * Pure virtual-LAN address math for the Havvn LAN feature — deterministic
 * per-session subnet + per-member virtual IP derivation inside 100.64.0.0/10
 * (CGNAT), plus the claim-verification and collision-arbitration rules.
 *
 * Kept dependency-free (no node:crypto, no electron) so it runs unchanged in
 * the engine window, the main process, the elevated helper, AND the renderer,
 * and is trivially unit-testable — same contract as ip-range.ts / vpn-bind.ts.
 *
 * SECURITY NOTE (plan §0.1 п.6/§4): memberId is ALREADY a cryptographic
 * commitment to the peer's Ed25519 pubkey (sha256(pub)[:32], room-crypto.ts).
 * The derivation therefore only needs determinism + good distribution, NOT
 * cryptographic unpredictability: an attacker who wants a specific vIP must
 * grind pubkeys (memberId = hash of pub) regardless of the mixing function, so
 * a fast non-crypto hash (FNV-1a) is sufficient and keeps this module free of
 * node:crypto (which the renderer bundle cannot use). Every vIP is VERIFIED
 * against its derivation on receipt (verifyVipClaim) — a signature alone proves
 * "a member said this", never entitlement to an address.
 */
import { numToIp, ipToNum } from './ip-range';

/** 100.64.0.0/10 — the CGNAT block LAN sessions carve subnets from. */
export const CGNAT_BASE = 0x64400000; // 100.64.0.0
export const CGNAT_PREFIX = 10;

/** Each session gets one /16 slice; 16 host bits ≈ 0.1% collision for 8 peers. */
export const SESSION_PREFIX = 16;

/** FNV-1a 32-bit. Deterministic across platforms/JS engines; NOT cryptographic
 *  (see module note). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface SubnetInfo {
  /** network address (uint32), e.g. 100.<64..127>.0.0 */
  base: number;
  prefix: number;
  /** directed-broadcast address, base | 0.0.255.255 */
  broadcast: number;
  netmask: number;
}

/**
 * The /16 a session occupies, chosen deterministically from its id. Second
 * octet ∈ [64,127] so the slice always lands inside 100.64.0.0/10.
 */
export function sessionSubnet(sessionId: string): SubnetInfo {
  const oct2 = 64 + (fnv1a('havvn-lan-subnet:v1|' + sessionId) % 64);
  const base = ((100 << 24) | (oct2 << 16)) >>> 0;
  const netmask = (0xffffffff << (32 - SESSION_PREFIX)) >>> 0;
  const broadcast = (base | (~netmask >>> 0)) >>> 0;
  return { base, prefix: SESSION_PREFIX, broadcast, netmask };
}

/**
 * The virtual IP (uint32) for a member in a session. `gen` is bumped by the
 * loser on a collision (arbitration below) so a fresh derivation is tried.
 * Host part avoids .0.0 (network) and .255.255 (broadcast) of the /16.
 */
export function deriveVip(sessionId: string, memberId: string, gen = 0): number {
  const { base } = sessionSubnet(sessionId);
  let host = fnv1a('havvn-lan-vip:v1|' + sessionId + '|' + memberId + '|' + gen) & 0xffff;
  if (host === 0x0000) host = 0x0001;
  else if (host === 0xffff) host = 0xfffe;
  return (base | host) >>> 0;
}

/** Recompute the expected vIP and compare — the ONLY defence against a member
 *  claiming someone else's address (plan §0.1 п.6). */
export function verifyVipClaim(sessionId: string, memberId: string, gen: number, claimedVip: number): boolean {
  return deriveVip(sessionId, memberId, gen) === (claimedVip >>> 0);
}

/** Whether an address is inside a session's /16. */
export function isInSubnet(ipNum: number, subnet: SubnetInfo): boolean {
  return ((ipNum >>> 0) & subnet.netmask) === subnet.base;
}

export interface VipClaim {
  memberId: string;
  gen: number;
  vip: number;
}

/**
 * Deterministic per-vIP owner among contending claims, applied IDENTICALLY at
 * every receiver so the routing table converges regardless of gossip-flood
 * order (plan §0.1 п.6). A claim only counts if its vIP actually derives from
 * (sessionId, memberId, gen); among valid claimants for the same vIP the lowest
 * memberId wins and the others must bump `gen`.
 *
 * Returns Map<vip, winningMemberId>.
 */
export function resolveVipOwners(sessionId: string, claims: VipClaim[]): Map<number, string> {
  const byVip = new Map<number, string>();
  for (const c of claims) {
    const vip = c.vip >>> 0;
    if (!verifyVipClaim(sessionId, c.memberId, c.gen, vip)) continue; // forged / stale gen
    const cur = byVip.get(vip);
    if (cur === undefined || c.memberId < cur) byVip.set(vip, c.memberId);
  }
  return byVip;
}

/** Dotted-quad for display (mono readout in the LAN panel). */
export function vipToString(ipNum: number): string {
  return numToIp(ipNum >>> 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// VPN-exclusion by ADDRESS RANGE (plan §0.1 #8). os.networkInterfaces() exposes
// no LUID and matching by adapter NAME is fragile (a rename masks a real VPN, or
// mistakes our own adapter for one). The correct test is: does the address fall
// inside an ACTIVE LAN session's /16? These pure predicates are the single source
// of truth every VPN/address surface (selectVpnIPv4, checkVPNInterfaces,
// getLocalIP, cast-server.lanAddress) consults against the live registry.
// ─────────────────────────────────────────────────────────────────────────────

/** An active LAN session's live /16, plus the session it scopes to. */
export interface ActiveLanSubnet {
  sessionId: string;
  subnet: SubnetInfo;
}

/** True when `ipNum` falls inside ANY active LAN session /16 — the ONLY correct
 *  VPN-exclusion test (must-fix #8). Never match by adapter name/LUID. */
export function isLanSessionAddress(ipNum: number, subnets: readonly ActiveLanSubnet[]): boolean {
  const n = ipNum >>> 0;
  for (const s of subnets) if (isInSubnet(n, s.subnet)) return true;
  return false;
}

/** String convenience (os.networkInterfaces() gives dotted-quad). False on unparseable input. */
export function isLanSessionAddressStr(addr: string, subnets: readonly ActiveLanSubnet[]): boolean {
  const n = ipToNum(addr);
  return n === null ? false : isLanSessionAddress(n, subnets);
}
