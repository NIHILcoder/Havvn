/**
 * Pure state machine for a Havvn virtual-LAN session — the "brain" the RTC
 * wiring (electron/sharing/room-lan.ts) drives, and the ONLY place the
 * host-gated admission decision lives. Dependency-free (no electron, no browser
 * globals, no node:crypto) so it imports unchanged in the engine window, the
 * main process, AND node vitest — same contract as lan-ip.ts / lan-packet.ts /
 * lan-frame.ts.
 *
 * WHAT IT OWNS (plan §0.1, mesh contract):
 *   • genesis pinning — first-writer-wins per sessionId, the pinned hostId is the
 *     trust root every lan-admit / lan-evict verifies against (must-fix #7).
 *   • admittedSet — populated ONLY by a host-signed lan-admit whose `by` equals
 *     the pinned hostId (must-fix #1/#7). Roster membership is necessary but NOT
 *     sufficient: canAdmitPeer() is the gate ensurePeer consults, and it is FALSE
 *     for any member the host has not admitted.
 *   • TERMINAL-EVICT — evictedSet is sticky and beats admittedSet, so admit and
 *     evict keep SEPARATE per-member monotonic `at` floors (never a shared floor,
 *     the documented voice HIGH) and a replayed old admit can never re-admit.
 *   • the vIP claim table — every claim re-verified against deriveVip (must-fix
 *     #6); only ADMITTED members feed resolveVipOwners into the routing table.
 *   • per-type monotonic anti-replay floors (one map each, FIFO-capped 512).
 *   • per-peer inbound token buckets (pure; wall-clock refill).
 *
 * SECURITY: a signature proves "a member SAID this", never entitlement. The gate
 * is the host grant (admittedSet), and every vIP is a claim re-derived on
 * receipt — divergence from voice, which is open-to-all by design.
 */
import { deriveVip, verifyVipClaim, resolveVipOwners, type VipClaim } from './lan-ip';

/** Mesh cap: bounds fan-out AND how many peers a hostile keyholder can force us
 *  to build. Mirrored in the renderer next to VOICE_MESH_LIMIT. Enforced against
 *  live peers in LanSession.ensurePeer — the core exposes it, the wiring counts. */
export const MAX_LAN_PEERS = 8;
/** Per-peer ICE buffer (clone of the voice pendingIce cap). */
export const MAX_PENDING_ICE = 64;
/** FIFO cap per anti-replay floor map (clone of the voice discipline). */
export const MAX_ANTIREPLAY = 512;
/** SCTP no-fragment MTU (plan §0 dec.5 — >1192 fragments SCTP → doubled loss). */
export const LAN_MTU = 1280;

/** Per-peer inbound rate limit (plan §4). Pure token bucket; refilled by wall-clock. */
export interface TokenBucketCfg {
  pps: number;
  bytesPerSec: number;
  burstPackets: number;
  burstBytes: number;
}

/** Beta defaults — generous enough for LAN games, tight enough to bound a flood. */
export const DEFAULT_LAN_BUCKET: TokenBucketCfg = {
  pps: 4000,
  bytesPerSec: 4_000_000, // ~32 Mbps sustained
  burstPackets: 800,
  burstBytes: 800_000,
};

/**
 * Phase 2B — which budget a packet is charged to. Relayed traffic gets its OWN
 * buckets on BOTH sides of the hop so it can never eat into the proven per-peer
 * DIRECT budget (and vice versa):
 *   • 'direct'    — the Phase-1 per-peer inbound bucket. UNCHANGED key (the bare
 *                   memberId) and UNCHANGED cfg, so every existing call site is
 *                   byte-identical.
 *   • 'relay-in'  — RECEIVER side, keyed by the ORIGINATOR of a relayed frame.
 *   • 'relay-out' — RELAY side (our forwarding uplink), keyed by the originator,
 *                   which is free: the originator IS the channel the frame
 *                   arrived on, so the key is not attacker-chosen.
 *   • 'relay-wire' — WIRE level, keyed by the SENDING channel, charged BEFORE the
 *                   envelope is even decoded. Without it a relay-classified frame
 *                   (first byte 0x52) would reach the decoder having passed NO
 *                   budget at all: the 'relay-in'/'relay-out' buckets are keyed by
 *                   the envelope's ORIGINATOR, which the sender chooses, and are
 *                   charged only after a successful decode. This is the bucket that
 *                   bounds pure garbage.
 * Keys are namespaced (`${cls}:${memberId}`) so they can never collide.
 */
export type LanBucketClass = 'direct' | 'relay-in' | 'relay-out' | 'relay-wire';

/** Per-originator relayed budget, deliberately TIGHTER than direct: relaying
 *  spends someone else's uplink. ~1.5 MB/s (~12 Mbps) sustained per originator. */
export const DEFAULT_LAN_RELAY_BUCKET: TokenBucketCfg = {
  pps: 2000,
  bytesPerSec: 1_500_000,
  burstPackets: 400,
  burstBytes: 300_000,
};

/**
 * The session-wide FORWARDING ceiling every forward must additionally clear, so
 * that no combination of pairs can drain a willing relay's uplink (the per-
 * originator bucket alone only bounds ONE pair). ~3 MB/s (~24 Mbps) total.
 */
export const LAN_RELAY_TOTAL_BUCKET: TokenBucketCfg = {
  pps: 6000,
  bytesPerSec: 3_000_000,
  burstPackets: 1200,
  burstBytes: 600_000,
};

/** Reserved pseudo-member naming the session-wide 'relay-out' ceiling. A real
 *  memberId is 32 lowercase hex, so '*' can never collide with one. */
export const LAN_RELAY_TOTAL_MEMBER = '*';

/** The host memberId a sessionId commits to. sessionId is `${hostId}.${random}`;
 *  the prefix before the first '.' is the creator. Returns '' for a malformed id
 *  with no '.', which can never equal a real 32-hex memberId → genesis refused. */
export function sessionHostPrefix(sessionId: string): string {
  const dot = sessionId.indexOf('.');
  return dot > 0 ? sessionId.slice(0, dot) : '';
}

/** A presence + vIP claim from a member (already signature-verified in the engine). */
export interface LanStateClaim {
  memberId: string;
  sessionId: string;
  vip: number;
  gen: number;
  at: number;
}

/** Immutable snapshot the routing brain reads (all pure). */
export interface LanCoreView {
  hostId: string | null;
  admitted: ReadonlySet<string>;
  vipOwners: ReadonlyMap<number, string>;
  selfVip: number;
}

interface Bucket {
  tokens: number;
  bytes: number;
  last: number;
}

export class LanSessionCore {
  private _hostId: string | null = null;
  private _genesisAt = -1;

  private readonly admitted = new Set<string>();
  private readonly evicted = new Set<string>(); // sticky, terminal

  // Separate per-member monotonic anti-replay floors — NEVER shared between types.
  private readonly lastAdmitAt = new Map<string, number>();
  private readonly lastEvictAt = new Map<string, number>();
  private readonly lastStateAt = new Map<string, number>();

  // Verified presence claims (memberId → latest). Non-admitted claims are kept
  // (join-intent) but filtered OUT of the routing table until admitted.
  private readonly claims = new Map<string, LanStateClaim>();
  private vipOwners = new Map<number, string>();
  private memberToVip = new Map<string, number>();

  private selfGen = 0;
  private readonly buckets = new Map<string, Bucket>();

  /**
   * Seed for the admit/evict floors — the persisted watermark of a session this
   * install has run BEFORE (0 for a brand-new session). A member with no floor of
   * its own is compared against this instead of being treated as never-seen.
   *
   * WHY THIS IS SOUND, AND WHY IT IS LIMITED TO TWO TYPES. `lan-admit` and
   * `lan-evict` are only ever applied when `by === hostId`, and their floor is
   * keyed by the TARGET — so every value in those two maps comes from ONE clock,
   * the host's. A single scalar can therefore stand in for the whole map without
   * mixing clock domains. `lan-state` (and `lan-reach`) carry each announcer's OWN
   * clock, so seeding their floors from this number would reject a legitimate
   * member whose clock trails the host's. They are deliberately left un-seeded:
   * both are transient, topic-bound and grant nothing (a replayed presence claim
   * still has to re-derive its vIP and still routes only if the member is
   * admitted), so the durable authority is the half worth protecting.
   *
   * Kept SEPARATE from the running `_authorityFloor` below: this one never moves.
   * Using the running maximum as the per-member fallback would let member A's
   * admit raise the bar for member B and reject B's older-but-legitimate admit
   * arriving out of order in the same session.
   */
  private readonly floorSeed: number;

  /** The highest admit/evict `at` this core has ever applied (never below the
   *  seed). This is what gets persisted, so the NEXT run of this session starts
   *  with every already-issued grant below its floor. */
  private _authorityFloor: number;

  constructor(
    private readonly sessionId: string,
    private readonly selfId: string,
    private readonly now: () => number = Date.now,
    authorityFloor = 0,
    private readonly bucketCfg: TokenBucketCfg = DEFAULT_LAN_BUCKET,
  ) {
    this.floorSeed = Number.isFinite(authorityFloor) && authorityFloor > 0 ? Math.floor(authorityFloor) : 0;
    this._authorityFloor = this.floorSeed;
  }

  /** The watermark to persist for this session (see `_authorityFloor`). */
  authorityFloor(): number {
    return this._authorityFloor;
  }

  // ── Genesis pinning (must-fix #7) — first-writer-wins per sessionId ─────────

  /** Pin the host from a VERIFIED lan-genesis. Rejects (false) a genesis for a
   *  different sessionId, one whose host is not the sessionId's own committed
   *  prefix, or a SECOND genesis naming a DIFFERENT host. Idempotent for a
   *  re-broadcast of the same host.
   *
   *  SECURITY (must-fix #7): sessionId is minted as `${hostId}.${random}`, so it
   *  already commits to the creator's memberId. Binding `by` to that prefix means
   *  ONLY the creator can ever pin genesis for its own sessionId — closing the
   *  first-writer-wins host-spoof race (an attacker forging a genesis for the
   *  victim's sessionId names a `by` that can never match the prefix). */
  pinGenesis(hostId: string, sessionId: string, at: number): boolean {
    if (sessionId !== this.sessionId) return false;
    if (hostId !== sessionHostPrefix(sessionId)) return false; // must be the committed creator
    if (this._hostId !== null) return this._hostId === hostId; // first-writer-wins
    this._hostId = hostId;
    this._genesisAt = at;
    return true;
  }

  hostId(): string | null {
    return this._hostId;
  }

  // ── Admission (must-fix #1/#2) — admittedSet ONLY from host-signed lan-admit ─

  /** Apply a VERIFIED lan-admit. Enforces THIS session's id + host pinned +
   *  by === hostId + a monotonic per-member `at` floor. TERMINAL-EVICT: an evicted
   *  member can never be re-admitted in this session (returns false).
   *
   *  SECURITY (must-fix #1/#7): the sessionId gate is mandatory. A host-signed
   *  admit from a PAST session (same host ⇒ same hostId, empty floors in a fresh
   *  core) would otherwise replay in and admit a member the host did NOT admit
   *  here — a cross-session domain confusion. Mirrors pinGenesis/applyState. */
  applyAdmit(by: string, target: string, at: number, sessionId: string): boolean {
    if (sessionId !== this.sessionId) return false;
    if (this._hostId === null || by !== this._hostId) return false;
    if (this.evicted.has(target)) return false; // terminal — sticky evict wins
    // A member with no floor of its own falls back to the persisted seed, so a
    // grant issued in a PREVIOUS run of this same session cannot replay in here.
    const floor = this.lastAdmitAt.get(target) ?? this.floorSeed;
    if (at <= floor) return false; // replay
    this.lastAdmitAt.set(target, at);
    this.capMap(this.lastAdmitAt);
    if (at > this._authorityFloor) this._authorityFloor = at;
    if (this.admitted.has(target)) return true; // floor advanced, no table change
    this.admitted.add(target);
    this.recomputeOwners(); // a stored claim from `target` may now route
    return true;
  }

  /** Apply a VERIFIED lan-evict (this session's id + by === hostId). Sticky +
   *  terminal: drops the member from admittedSet, releases their vIP claim, keeps
   *  its OWN floor. The sessionId gate blocks a captured old evict from replaying
   *  a permanent (terminal) ban into a fresh session (must-fix #1, DoS variant). */
  applyEvict(by: string, target: string, at: number, sessionId: string): boolean {
    if (sessionId !== this.sessionId) return false;
    if (this._hostId === null || by !== this._hostId) return false;
    const floor = this.lastEvictAt.get(target) ?? this.floorSeed;
    if (at <= floor) return false; // replay (same seeded-floor rule as applyAdmit)
    this.lastEvictAt.set(target, at);
    this.capMap(this.lastEvictAt);
    if (at > this._authorityFloor) this._authorityFloor = at;
    this.evicted.add(target);
    const wasAdmitted = this.admitted.delete(target);
    const hadClaim = this.claims.delete(target);
    if (wasAdmitted || hadClaim) this.recomputeOwners();
    return true;
  }

  /** True iff the host has admitted this member and NOT evicted them. The
   *  ensurePeer gate consults this — never roster membership. */
  isAdmitted(memberId: string): boolean {
    return this.admitted.has(memberId) && !this.evicted.has(memberId);
  }

  /** The decision predicate ensurePeer uses: a real, admitted, non-self peer we
   *  may build a LanPeer for. (The MAX_LAN_PEERS live-connection cap is enforced
   *  by ensurePeer against peers.size, not here.) */
  canAdmitPeer(memberId: string): boolean {
    return memberId !== this.selfId && this.isAdmitted(memberId);
  }

  admittedIds(): string[] {
    return [...this.admitted].filter((m) => !this.evicted.has(m));
  }

  // ── vIP table (must-fix #6) — reuses lan-ip verifyVipClaim/resolveVipOwners ──

  /** Apply a VERIFIED lan-state claim. Rejects a wrong-session claim, our own
   *  echo, a FORGED vip (claimed !== deriveVip), or a replay (`at` <= floor). The
   *  claim is stored on success; the routing table only ever includes ADMITTED
   *  members, so a non-admitted claim is remembered (join-intent) yet never routes. */
  applyState(c: LanStateClaim): boolean {
    if (c.sessionId !== this.sessionId) return false;
    if (c.memberId === this.selfId) return false; // ignore our own relayed presence
    if (!verifyVipClaim(c.sessionId, c.memberId, c.gen, c.vip)) return false; // forged
    const floor = this.lastStateAt.get(c.memberId);
    if (floor !== undefined && c.at <= floor) return false; // replay
    this.lastStateAt.set(c.memberId, c.at);
    this.capMap(this.lastStateAt);
    this.claims.set(c.memberId, { ...c, vip: c.vip >>> 0 });
    this.capClaims(); // bound the join-intent store against synthetic-key floods
    this.recomputeOwners();
    return true;
  }

  /** Routing lookup: which member owns this vIP (converged table). */
  vipToMember(vip: number): string | undefined {
    return this.vipOwners.get(vip >>> 0);
  }

  /** The vIP a member currently owns in the converged table (for display). */
  memberVip(memberId: string): number | undefined {
    return this.memberToVip.get(memberId);
  }

  /** Our own vIP for the session (current gen). */
  selfVip(): number {
    return deriveVip(this.sessionId, this.selfId, this.selfGen);
  }

  /** If a lower-memberId peer legitimately owns our derived vIP, bump `gen` and
   *  return the fresh {vip, gen} so the caller re-announces; else null. */
  bumpGenOnCollision(): { vip: number; gen: number } | null {
    const mine = deriveVip(this.sessionId, this.selfId, this.selfGen);
    const owner = this.vipOwners.get(mine);
    // owner is the min memberId among RECEIVED claimants of `mine` (our own claim
    // is not in that set); if it outranks us, we lost the arbitration → bump.
    if (owner !== undefined && owner !== this.selfId && owner < this.selfId) {
      this.selfGen = (this.selfGen + 1) & 0xffff;
      return { vip: deriveVip(this.sessionId, this.selfId, this.selfGen), gen: this.selfGen };
    }
    return null;
  }

  // ── Per-peer inbound rate limit (plan §4) — pure token bucket ───────────────

  /**
   * Consume one packet of `bytes` from a bucket; false = over budget (drop).
   * Buckets refill by wall-clock and are capped at the configured burst.
   *
   * `cls` defaults to 'direct', whose KEY (the bare memberId) and CFG are exactly
   * what Phase 1 used — so the existing call site is byte-identical and the proven
   * direct budget provably cannot be affected by Phase 2B. The relay classes get
   * NAMESPACED keys and their own, tighter configs, so relayed traffic and direct
   * traffic can never drain one another.
   */
  allowPacket(memberId: string, bytes: number, cls: LanBucketClass = 'direct'): boolean {
    const key = cls === 'direct' ? memberId : `${cls}:${memberId}`;
    const cfg = cls === 'direct'
      ? this.bucketCfg
      // The reserved '*' key is the SESSION-WIDE ceiling for whichever relay class
      // charges it (forward and receive each keep their own '*' bucket, since the
      // key is namespaced by class), so it always gets the larger aggregate cfg.
      : memberId === LAN_RELAY_TOTAL_MEMBER
        ? LAN_RELAY_TOTAL_BUCKET
        : DEFAULT_LAN_RELAY_BUCKET;
    return this.consume(key, bytes, cfg);
  }

  /** The shared token-bucket math (extracted verbatim from the Phase-1 inline
   *  body so all classes use the one proven implementation). */
  private consume(key: string, bytes: number, cfg: TokenBucketCfg): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: cfg.burstPackets, bytes: cfg.burstBytes, last: t };
      this.buckets.set(key, b);
      this.capMap(this.buckets as unknown as Map<string, number>);
    }
    const elapsed = Math.max(0, t - b.last) / 1000;
    b.last = t;
    b.tokens = Math.min(cfg.burstPackets, b.tokens + elapsed * cfg.pps);
    b.bytes = Math.min(cfg.burstBytes, b.bytes + elapsed * cfg.bytesPerSec);
    if (b.tokens < 1 || b.bytes < bytes) return false;
    b.tokens -= 1;
    b.bytes -= bytes;
    return true;
  }

  // ── Departure / teardown ────────────────────────────────────────────────────

  /** A member left the ROOM (leave/kick). Release their vIP + admission and drop
   *  their bucket, but KEEP the anti-replay floors so a captured old signed frame
   *  can't resurrect them. Does NOT touch evictedSet (sticky). */
  onMemberGone(memberId: string): void {
    const wasAdmitted = this.admitted.delete(memberId);
    const hadClaim = this.claims.delete(memberId);
    this.buckets.delete(memberId);
    // Phase 2B: the namespaced relay budgets die with the member too, or a
    // re-invited member would inherit a drained bucket for the session's life.
    this.buckets.delete(`relay-in:${memberId}`);
    this.buckets.delete(`relay-out:${memberId}`);
    this.buckets.delete(`relay-wire:${memberId}`);
    if (wasAdmitted || hadClaim) this.recomputeOwners();
  }

  /** Immutable snapshot for the router (references typed Readonly — do not mutate). */
  view(): LanCoreView {
    return {
      hostId: this._hostId,
      admitted: this.admitted,
      vipOwners: this.vipOwners,
      selfVip: this.selfVip(),
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Rebuild vipOwners/memberToVip from ADMITTED claims only, applying the shared
   *  lowest-memberId arbitration so every receiver converges on the same table. */
  private recomputeOwners(): void {
    const list: VipClaim[] = [];
    for (const [mid, c] of this.claims) {
      if (this.isAdmitted(mid)) list.push({ memberId: mid, gen: c.gen, vip: c.vip });
    }
    this.vipOwners = resolveVipOwners(this.sessionId, list);
    const rev = new Map<string, number>();
    for (const [vip, mid] of this.vipOwners) rev.set(mid, vip);
    this.memberToVip = rev;
  }

  /** Bound the `claims` store (fed by ANY valid keyholder — a synthetic-key flood
   *  would otherwise grow it without limit). FIFO-evict the OLDEST NON-admitted
   *  claim so admitted members' routing is never dropped; admitted ≤ MAX_LAN_PEERS
   *  (8) ≪ cap, so a non-admitted victim always exists above the ceiling. */
  private capClaims(): void {
    while (this.claims.size > MAX_ANTIREPLAY) {
      let victim: string | undefined;
      for (const k of this.claims.keys()) { if (!this.isAdmitted(k)) { victim = k; break; } }
      if (victim === undefined) break; // all admitted (unreachable given the cap)
      this.claims.delete(victim);
    }
  }

  /** FIFO-cap a bookkeeping map at MAX_ANTIREPLAY (Map preserves insertion order). */
  private capMap(m: Map<string, unknown>): void {
    while (m.size > MAX_ANTIREPLAY) {
      const first = m.keys().next().value as string | undefined;
      if (first === undefined) break;
      m.delete(first);
    }
  }
}
