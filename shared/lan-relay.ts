/**
 * Pure ONE-HOP PEER RELAY layer for the Havvn virtual LAN (Phase 2B). When two
 * admitted members A and B both sit behind symmetric NAT with no TURN, their
 * direct leg latches terminal (Phase 2A) and they simply cannot play. This
 * module is the policy half of the fix: forward their frames through a third
 * admitted member C that has a working leg to BOTH.
 *
 * Dependency-free — no electron, no RTCPeerConnection, no node:crypto — exactly
 * like lan-router.ts / lan-session-core.ts / lan-quality.ts, so every decision
 * here is unit-testable under node vitest. NEVER throws on hostile bytes: a
 * malformed / truncated / oversized / spoofed frame returns a typed `drop`.
 *
 * ── THE FIVE INVARIANTS THIS MODULE ENFORCES ────────────────────────────────
 *
 * 1. ONE HOP, STRUCTURALLY. A relay may forward ONLY when the frame arrived on
 *    the channel of the member named in `origin` (fromMemberId === env.origin).
 *    A frame that has already travelled once necessarily arrives with
 *    fromMemberId === the relay !== origin, so its only legal fate is
 *    deliver-if-target-is-me. Multi-hop and loops are UNREPRESENTABLE, not
 *    merely budgeted — there is no hop counter for an attacker to max out.
 *    Nesting is dead too: an envelope inside an envelope fails parseIpv4
 *    (magic 0x52 → version nibble 5) and is dropped as `bad-inner`.
 *
 * 2. SAME SESSION, ADMITTED ONLY. Origin, target and the relay must all be in
 *    the core's admitted set (which an evict removes from, stickily). The vIP
 *    table those checks resolve through is rebuilt from ADMITTED claims only,
 *    so an evicted member's traffic loses attribution on the very next packet.
 *
 * 3. SOURCE AUTHORITY, CHECKED TWICE AND NEVER BY THE RELAY'S WORD. On the
 *    relay: the inner src must belong to the SENDER (the relay analog of
 *    acceptInbound). On the receiver: the inner src must belong to the CLAIMED
 *    ORIGINATOR — `view.vipOwners.get(inner.src) === env.origin` — and that
 *    origin must be admitted, must not be us, must not be the relay itself, and
 *    the relay must be in OUR OWN candidate set for that origin.
 *
 * 4. BUDGETS ARE THE CALLER'S, INJECTED. Relayed traffic gets its own token
 *    buckets (LanSessionCore), never the proven per-peer direct bucket. This
 *    module takes them as predicates so the policy stays pure and the buckets
 *    stay in one place.
 *
 * 5. DETERMINISTIC SELECTION, NO NEGOTIATION. relayCandidates() is computed
 *    from the SIGNED adverts alone and is symmetric in the pair, so both
 *    endpoints derive the identical set from the identical gossip. SEND takes
 *    the lexicographic argmin intersected with our own live legs; ACCEPT tests
 *    membership of the whole set, so an advert-lag window costs at most an
 *    asymmetric route (harmless for a UDP game tunnel), never a black hole.
 *
 * ── MTU REALITY (invariant 8) ───────────────────────────────────────────────
 * The adapter MTU stays 1280 and is NOT touched here. The 34-byte envelope only
 * raises the DATA-CHANNEL MESSAGE to ≤1314; the inner packet is still ≤1280, so
 * every parseIpv4 / LAN_MTU check on both hops is unchanged. SCTP fragments
 * above ~1192 bytes, so inner frames of 1159..1280 bytes become 2-fragment
 * messages once enveloped (whole-message drop semantics stay correct; loss
 * probability for that size band roughly doubles). Frames ≤1158 B — essentially
 * all game control traffic — are unaffected. Carrying BOTH member ids costs
 * nothing versus carrying one: an 18-byte and a 34-byte header cross the same
 * threshold, so the explicit origin-vs-src cross-check is free.
 *
 * ── PRIVACY (must ship in the UI, not only here) ────────────────────────────
 * DTLS is per LEG, so the relay is a PLAINTEXT WAYPOINT: C can read every IP
 * packet A and B exchange. That is materially different from a TURN server the
 * user chose, because C is another player. Both sides must see who is in the
 * path. A pairwise AEAD over the inner packet is the real closure and is
 * deliberately deferred (it costs ~28 more header bytes and widens the
 * fragmenting band).
 */

import { parseIpv4, classifyDest } from './lan-packet';
import { isInSubnet, type SubnetInfo } from './lan-ip';
import { LAN_MTU, MAX_ANTIREPLAY, type LanCoreView } from './lan-session-core';
import type { LanReachAdvert } from './lan-types';
// ONE implementation of the memberId shape + the canonical reach form, shared
// with the signed-gossip clamp. Duplicating either here would let the emitter and
// the receiver's normalising clamp drift apart, which shows up as silently
// unverifiable adverts rather than as a test failure.
import { isLanMemberId, normalizeReachList } from './lan-protocol';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Wire format — the envelope. Present ONLY on relayed frames; a direct send
//    stays a bare raw IPv4 packet, byte-for-byte identical to Phase 1/2A.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Magic first byte, 'R'. Its HIGH NIBBLE IS 5, which is neither IPv4 (4) nor
 * IPv6 (6), and parseIpv4 hard-rejects version !== 4 — so an envelope can never
 * be mistaken for a packet, a packet can never be mistaken for an envelope, and
 * a ≤2A peer receiving one feeds it to parseIpv4, gets null and drops it
 * harmlessly instead of injecting garbage. 0x6X is left free for a future IPv6
 * tunnel.
 */
export const LAN_RELAY_MAGIC = 0x52;

/** Envelope version, carried in the LOW nibble of byte 1. */
export const LAN_RELAY_VER = 1;

/** magic(1) + ver/flags(1) + origin(16) + target(16). FROZEN at v1. */
export const LAN_RELAY_HEADER = 34;

/** Largest legal data-channel message for a relayed frame (header + LAN_MTU). */
export const MAX_RELAY_FRAME = LAN_RELAY_HEADER + LAN_MTU; // 1314

/** A decoded relay envelope. `inner` ALIASES the input buffer (zero-copy) — copy
 *  it before retaining it past the current message. */
export interface LanRelayEnvelope {
  /** The member whose stack ORIGINATED the inner packet (a CLAIM, cross-checked
   *  against vipOwners.get(inner.src) by the receiver). */
  origin: string;
  /** The single member the relay may deliver to. Explicit, so the relay never
   *  parses a hostile IP header to route and never fans out (no amplification —
   *  the ORIGINATOR replicates broadcast, one envelope per destination). */
  target: string;
  /** The raw IPv4 packet, ≤ LAN_MTU. */
  inner: Buffer;
}

/**
 * Encode `inner` into a relay envelope. Returns null (never throws) on a
 * non-32-hex id, origin === target, an empty inner, or an inner over LAN_MTU.
 *
 * `out` is an optional caller-owned scratch buffer (RTCDataChannel.send copies
 * synchronously per spec, so one reusable MAX_RELAY_FRAME buffer per session is
 * safe and keeps the relay hop allocation-free). The returned Buffer is a
 * subarray of `out` when it is used.
 */
export function encodeRelayFrame(
  origin: string,
  target: string,
  inner: Buffer,
  out?: Buffer,
): Buffer | null {
  // memberId is exactly sha256(pub).slice(0,32) — 32 LOWERCASE hex chars, so the
  // 16-byte binary form written below is lossless.
  if (!isLanMemberId(origin) || !isLanMemberId(target)) return null;
  if (origin === target) return null;
  if (!isBuf(inner) || inner.length === 0 || inner.length > LAN_MTU) return null;

  const total = LAN_RELAY_HEADER + inner.length;
  const buf = out !== undefined && isBuf(out) && out.length >= total ? out : Buffer.alloc(total);
  buf[0] = LAN_RELAY_MAGIC;
  buf[1] = LAN_RELAY_VER; // high nibble = reserved flags, MUST stay zero at v1
  buf.write(origin, 2, 16, 'hex');
  buf.write(target, 18, 16, 'hex');
  inner.copy(buf, LAN_RELAY_HEADER);
  return buf.subarray(0, total);
}

/** One-byte classification of an inbound data-channel message. Everything that
 *  is NOT this takes the existing, unchanged direct path. */
export function isRelayFrame(buf: unknown): boolean {
  return isBuf(buf) && buf.length > 0 && buf[0] === LAN_RELAY_MAGIC;
}

/**
 * Decode a relay envelope. Returns null (never throws) on hostile bytes:
 * truncation, an empty inner, an oversized message, a bad magic, a wrong
 * version, ANY reserved flag bit set, or origin === target.
 */
export function decodeRelayFrame(buf: unknown): LanRelayEnvelope | null {
  if (!isBuf(buf)) return null;
  if (buf.length <= LAN_RELAY_HEADER) return null; // header-only / truncated / empty inner
  if (buf.length > MAX_RELAY_FRAME) return null;
  if (buf[0] !== LAN_RELAY_MAGIC) return null;
  if ((buf[1] & 0xf0) !== 0) return null; // reserved flags must be zero at v1
  if ((buf[1] & 0x0f) !== LAN_RELAY_VER) return null;
  const origin = buf.toString('hex', 2, 18);
  const target = buf.toString('hex', 18, LAN_RELAY_HEADER);
  if (origin === target) return null; // a self-addressed envelope is nonsense
  return { origin, target, inner: buf.subarray(LAN_RELAY_HEADER) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Reachability adverts (the `lan-reach` signed gossip arm, presence-class).
//    Cadence: emit on CHANGE with a hard floor, plus an unconditional refresh
//    well under the TTL so a live member never expires.
// ─────────────────────────────────────────────────────────────────────────────

/** Hard floor between two adverts; a change inside the floor schedules ONE
 *  trailing coalesced emit (the room.profileAnnounce pattern). Matches the
 *  Phase-2A quality-poll tick so a rebuild storm costs at most one advert. */
export const LAN_REACH_MIN_INTERVAL_MS = 3_000;

/** Unconditional re-emit, so a member with a stable leg set never expires. */
export const LAN_REACH_REFRESH_MS = 30_000;

/** An advert is stale after this long WITHOUT a refresh (3 missed refreshes). */
export const LAN_REACH_TTL_MS = 90_000;

/**
 * A stored advert = the shared LanReachAdvert spec ({at, relay, peers}) PLUS our
 * own receipt timestamp.
 *
 * WHY seenAt EXISTS (read before "simplifying" it away): `at` is the SENDER's
 * monotonic clock. It is exactly right as an anti-replay floor and exactly wrong
 * as a freshness stamp — a peer whose clock runs fast (or is simply set to next
 * year) would be permanently fresh, and one running slow permanently expired,
 * with no signature check able to notice. TTL is therefore measured against the
 * moment WE accepted the advert, which no remote party can influence.
 */
export interface LanReachEntry extends LanReachAdvert {
  /** OUR LOCAL receipt timestamp — the ONLY input to freshness. */
  seenAt: number;
}

/** The raw advert the engine hands over AFTER verifySignedBy + clamp. */
export interface LanReachInput {
  memberId: string;
  at: number;
  relay: unknown;
  peers: unknown;
}

/**
 * The reachability VIEW: ingests signed adverts, enforces a per-member monotonic
 * floor of its OWN (never shared with any other message type), and expires stale
 * entries. Pure — the clock is injected.
 *
 * The floor map is kept even after an advert expires or a member is forgotten,
 * so a captured old advert can never be replayed back in.
 */
export class LanReachTable {
  private readonly adv = new Map<string, LanReachEntry>();
  /** Its OWN monotonic anti-replay floor. NEVER shared with lastStateAt et al. */
  private readonly floor = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = LAN_REACH_TTL_MS,
    private readonly cap: number = MAX_ANTIREPLAY,
    /**
     * Admission oracle used ONLY when the store is over cap, to decide who gets
     * evicted first. Adverts are accepted from non-admitted members on purpose
     * (a member can be a relay candidate the moment it is admitted), but a plain
     * FIFO would let anyone mint unlimited keypairs — every one of them passing
     * verifySignedBy, since memberId is just sha256(pub) — and push the REAL
     * members' adverts out, silently disabling relay selection. Defaults to
     * "nobody is admitted", which degrades to the old FIFO.
     */
    private readonly isAdmitted: (memberId: string) => boolean = () => false,
  ) {}

  /**
   * Apply a VERIFIED advert. Returns false for a non-canonical memberId, a
   * non-finite clock, or a replay (`at` <= floor). `relay` is coerced STRICTLY
   * (=== true) and `peers` is normalised, so a hostile shape stores nothing odd.
   */
  apply(a: LanReachInput): boolean {
    if (!isLanMemberId(a.memberId)) return false;
    if (typeof a.at !== 'number' || !Number.isFinite(a.at)) return false;
    const f = this.floor.get(a.memberId);
    if (f !== undefined && a.at <= f) return false; // replay
    this.floor.set(a.memberId, a.at);
    capMap(this.floor, this.cap);
    const peers = new Set(normalizeReachList(a.peers));
    peers.delete(a.memberId); // a member cannot have a leg to itself
    this.adv.set(a.memberId, { at: a.at, seenAt: this.now(), relay: a.relay === true, peers });
    this.pruneStore();
    return true;
  }

  /** The member's live advert, or undefined when absent OR expired. */
  get(memberId: string): LanReachEntry | undefined {
    const a = this.adv.get(memberId);
    if (a === undefined) return undefined;
    return this.now() - a.seenAt > this.ttlMs ? undefined : a;
  }

  /** Every UNEXPIRED advert (expired entries are dropped as a side effect). */
  adverts(): ReadonlyMap<string, LanReachEntry> {
    this.prune();
    return this.adv;
  }

  /** Drop a departed / evicted member's advert. Keeps the anti-replay floor. */
  forget(memberId: string): void {
    this.adv.delete(memberId);
  }

  /** Drop every expired advert. */
  prune(): void {
    const t = this.now();
    for (const [id, a] of this.adv) if (t - a.seenAt > this.ttlMs) this.adv.delete(id);
  }

  /** Assemble the immutable snapshot the selector reads. */
  view(selfId: string, admitted: ReadonlySet<string>, legs: ReadonlySet<string>): LanRelayView {
    return {
      selfId,
      admitted,
      legs,
      adverts: this.adverts(),
      now: this.now(),
      ttlMs: this.ttlMs,
    };
  }

  /**
   * Bound the advert store: expired entries first, then the oldest NON-ADMITTED
   * advert, and only as a last resort the oldest admitted one.
   *
   * A plain FIFO here was a real hole: adverts are accepted from non-admitted
   * members, anyone holding the room code can mint unlimited valid identities
   * (memberId === sha256(pub), so every forgery verifies as "some member"), and
   * each fresh id pushed a REAL member's advert out — quietly starving relay
   * selection of the very candidates it needs. Admitted members are capped at
   * MAX_LAN_PEERS (8) ≪ cap, so a non-admitted victim essentially always exists.
   */
  private pruneStore(): void {
    if (this.adv.size <= this.cap) return;
    this.prune();
    while (this.adv.size > this.cap) {
      let victim: string | undefined;
      for (const id of this.adv.keys()) { if (!this.isAdmitted(id)) { victim = id; break; } }
      if (victim === undefined) victim = this.adv.keys().next().value as string | undefined;
      if (victim === undefined) break;
      this.adv.delete(victim);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Deterministic selection — advert-only, symmetric, no negotiation.
// ─────────────────────────────────────────────────────────────────────────────

/** Immutable inputs the selector reads. Rebuilt on invalidation, NEVER per frame. */
export interface LanRelayView {
  selfId: string;
  /**
   * The core's admitted set. Evicted members are already removed from it
   * (applyEvict deletes), so "admitted" here means admitted ∖ evicted.
   */
  admitted: ReadonlySet<string>;
  /** OUR currently-CONNECTED direct legs — local ground truth, used by SEND only. */
  legs: ReadonlySet<string>;
  /** memberId → its latest signed advert. */
  adverts: ReadonlyMap<string, LanReachEntry>;
  now: number;
  /** Defaults to LAN_REACH_TTL_MS. */
  ttlMs?: number;
}

function fresh(a: LanReachEntry, v: LanRelayView): boolean {
  return v.now - a.seenAt <= (v.ttlMs ?? LAN_REACH_TTL_MS);
}

/**
 * The candidate set for the pair (a, b): every member that could carry their
 * traffic. ADVERT-ONLY and SYMMETRIC in (a, b), so both endpoints derive the
 * IDENTICAL list from the identical flooded adverts — that is what makes
 * selection converge with no handshake. Returned ASCENDING.
 *
 * c qualifies iff: c ∉ {a, b}; c is admitted; c's advert is fresh; c advertised
 * `relay: true` (willingness — a peer that declines is simply never a
 * candidate); and c's advert lists BOTH a and b.
 *
 * NOTE this deliberately does NOT consult v.legs. Our own leg state is applied
 * only when SENDING (as an intersection), because it can only ever remove a
 * candidate whose advert already contradicts reality.
 */
export function relayCandidates(v: LanRelayView, a: string, b: string): string[] {
  if (a === b) return [];
  const out: string[] = [];
  for (const [id, adv] of v.adverts) {
    if (id === a || id === b) continue;
    if (!v.admitted.has(id)) continue;
    if (!adv.relay) continue;
    if (!fresh(adv, v)) continue;
    if (!adv.peers.has(a) || !adv.peers.has(b)) continue;
    out.push(id);
  }
  return out.sort();
}

/**
 * SEND choice for `target`: argmin(candidates ∩ our own live legs). Returns null
 * when the target is us, is not admitted, is DIRECTLY reachable (direct always
 * wins), or has no candidate we can actually reach.
 *
 * memberIds are unique 32-hex, so the lexicographic minimum is total and
 * tie-free — no coin flip, no churn.
 */
export function selectRelay(v: LanRelayView, target: string): string | null {
  if (target === v.selfId) return null;
  if (!v.admitted.has(target)) return null;
  if (v.legs.has(target)) return null; // a working direct leg always wins
  for (const c of relayCandidates(v, v.selfId, target)) if (v.legs.has(c)) return c;
  return null;
}

/**
 * ACCEPT rule: may `via` deliver traffic ORIGINATED by `origin` to us? This is
 * the FULL candidate set, deliberately wider than selectRelay's argmin: during
 * an advert-lag window the two ends may briefly pick different relays, and a
 * strict accept-only-my-argmin rule would black-hole that window for no security
 * gain. The real bound is unchanged — `via` may only inject as `origin` when it
 * genuinely bridges `origin` and us.
 */
export function isRelayAllowed(v: LanRelayView, origin: string, via: string): boolean {
  return relayCandidates(v, origin, v.selfId).includes(via);
}

/** Members we can reach ONLY through a relay — the session unions these into
 *  RouteCtx.peerIds so planRoute's BROADCAST fan-out stops silently excluding a
 *  peer whose LanPeer was reaped when its leg latched terminal. */
export function relayEligible(v: LanRelayView, targets: Iterable<string>): string[] {
  const out: string[] = [];
  for (const t of targets) if (selectRelay(v, t) !== null) out.push(t);
  return out.sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The two data-plane decisions. Both are TOTAL functions over hostile bytes.
// ─────────────────────────────────────────────────────────────────────────────

export type RelayDropReason =
  // envelope / bytes
  | 'bad-envelope'
  | 'bad-inner'
  | 'oversize'
  // relay side
  | 'not-willing'
  | 'not-origin' // ONE-HOP GATE: the sender is not the claimed originator
  | 'origin-is-self'
  | 'target-is-self'
  | 'reflect'
  | 'origin-not-admitted'
  | 'target-not-admitted'
  | 'target-unreachable'
  | 'src-spoof'
  | 'off-subnet'
  | 'dst-mismatch'
  // receiver side
  | 'not-for-me'
  | 'origin-is-relay'
  | 'relay-not-allowed'
  | 'direct-available'
  | 'wrong-inner-dst'
  // both
  | 'budget';

export type RelayForward =
  | { kind: 'forward'; to: string; origin: string; frame: Buffer }
  | { kind: 'drop'; reason: RelayDropReason };

export type RelayAccept =
  | { kind: 'accept'; origin: string; inner: Buffer }
  | { kind: 'drop'; reason: RelayDropReason };

const drop = (reason: RelayDropReason): { kind: 'drop'; reason: RelayDropReason } => ({ kind: 'drop', reason });

/** What the two decisions need besides the frame. */
export interface RelayDecisionCtx {
  /** Advert-derived reachability + our own legs. */
  view: LanRelayView;
  /** The core's converged, vIP-re-derived routing table. */
  core: LanCoreView;
  /** sessionSubnet(sessionId) — the /16 every legal address lives in. */
  subnet: SubnetInfo;
}

/** Relay-side context: willingness (the user's switch, read LIVE) + the
 *  FORWARDING budget, which is separate from the direct per-peer bucket and is
 *  keyed by the ORIGINATOR (free — the originator IS the channel the frame
 *  arrived on) plus a session-wide cap the caller folds in. */
export interface RelayForwardCtx extends RelayDecisionCtx {
  willing: boolean;
  budget?: (origin: string, target: string, bytes: number) => boolean;
}

/** Receiver-side context. `strictDirect` additionally refuses relayed traffic
 *  from an originator we currently hold a LIVE DIRECT leg to — it closes a
 *  budget-bypass (wrap a frame to dodge your own direct bucket) at the cost of a
 *  few hundred ms of loss exactly when a link recovers. Default OFF. */
export interface RelayAcceptCtx extends RelayDecisionCtx {
  budget?: (origin: string, bytes: number) => boolean;
  strictDirect?: boolean;
}

/**
 * RELAY SIDE. May we forward this data-channel message that arrived from
 * `fromMemberId`, and to whom?
 *
 * THE ONE-HOP GATE is check 3: `fromMemberId === env.origin`. A frame we already
 * forwarded once arrives at the next hop with fromMemberId === us !== origin, so
 * it can never satisfy this and there is no second forward. No counter, no TTL,
 * nothing an attacker can set.
 *
 * Amplification is structurally impossible: exactly one message in produces at
 * most one message out, to the single member named in `target`. Broadcast
 * survives because the ORIGINATOR replicates (one envelope per destination) —
 * the relay never fans out and never parses a hostile dst to decide who to copy
 * to.
 */
export function planRelayForward(
  frame: unknown,
  fromMemberId: string,
  ctx: RelayForwardCtx,
): RelayForward {
  // 0. Willingness first — the cheapest check, and a declining install must stop
  //    forwarding MID-SESSION, not at the next advert.
  if (!ctx.willing) return drop('not-willing');

  const env = decodeRelayFrame(frame);
  if (env === null) return drop('bad-envelope');

  const { view, core, subnet } = ctx;

  // 1. ONE HOP. Everything else is defence; this is the invariant.
  if (fromMemberId !== env.origin) return drop('not-origin');

  // 2. Sanity: we are neither end of this leg.
  if (env.origin === view.selfId) return drop('origin-is-self');
  if (env.target === view.selfId) return drop('target-is-self'); // deliver, never forward
  if (env.target === fromMemberId) return drop('reflect'); // no bounce-back

  // 3. Same session, admitted only (an evict removes from `admitted`).
  if (!view.admitted.has(env.origin)) return drop('origin-not-admitted');
  if (!view.admitted.has(env.target)) return drop('target-not-admitted');

  // 4. We must actually hold a live leg to the target, or there is nothing to do.
  if (!view.legs.has(env.target)) return drop('target-unreachable');

  // 5. Inner packet sanity (bounded exactly like the direct path).
  const h = parseIpv4(env.inner);
  if (h === null) return drop('bad-inner'); // covers a NESTED envelope (version 5)
  if (h.totalLength > LAN_MTU) return drop('oversize');

  // 6. SOURCE AUTHORITY, relay analog of acceptInbound: the sender may only ever
  //    hand us frames carrying its OWN table-verified vIP. A relay therefore
  //    cannot launder another member's traffic through us.
  if (core.vipOwners.get(h.src >>> 0) !== fromMemberId) return drop('src-spoof');

  // 7. The destination must be a real in-session address, and for unicast it must
  //    be the member named in the envelope — an envelope may not misdirect.
  const cls = classifyDest(h.dst >>> 0, subnet.broadcast);
  if (cls === 'unicast') {
    if (!isInSubnet(h.dst >>> 0, subnet)) return drop('off-subnet');
    if (core.vipOwners.get(h.dst >>> 0) !== env.target) return drop('dst-mismatch');
  }
  // broadcast / multicast: the ORIGINATOR already replicated one envelope per
  // destination, so `target` is the explicit single recipient. Nothing to fan out.

  // 8. Forwarding budget — someone else's bandwidth, charged to the originator.
  const bytes = (frame as Buffer).length;
  if (ctx.budget !== undefined && !ctx.budget(env.origin, env.target, bytes)) return drop('budget');

  return { kind: 'forward', to: env.target, origin: env.origin, frame: frame as Buffer };
}

/**
 * RECEIVER SIDE. May this relayed message, handed to us by `fromMemberId`, be
 * injected into our TUN — and whose traffic is it?
 *
 * The load-bearing check is 6: `vipOwners.get(inner.src) === env.origin`. The
 * envelope's `origin` is a CLAIM; the vIP table is host-signed authority with
 * every claim re-derived. Requiring them to agree is the exact relay analog of
 * acceptInbound's src-check, resolved against the CLAIMED ORIGINATOR rather than
 * against the peer that happened to hand us the bytes.
 *
 * RESIDUAL RISK, ACCEPTED AND DOCUMENTED: a member C that genuinely bridges A
 * and us can still MINT frames carrying A's vIP toward us, because only C is on
 * that path. It is bounded — C must be host-admitted, willing, fresh, and
 * genuinely bridge the pair, and we only ever consider a relay for a pair with
 * no other path — but it is strictly weaker than the direct-leg guarantee. The
 * only real closure is a per-packet MAC/AEAD keyed pairwise from the room
 * secret; deferred, not forgotten.
 */
export function acceptRelayedInbound(
  frame: unknown,
  fromMemberId: string,
  ctx: RelayAcceptCtx,
): RelayAccept {
  const env = decodeRelayFrame(frame);
  if (env === null) return drop('bad-envelope');

  const { view, core, subnet } = ctx;

  // 1. Addressed to US, by name.
  if (env.target !== view.selfId) return drop('not-for-me');
  // 2. Never re-inject our own traffic (a relayed self-echo).
  if (env.origin === view.selfId) return drop('origin-is-self');
  // 3. A relay must not launder its OWN traffic through the relayed budget — it
  //    demonstrably has a direct leg to us, so it must use it.
  if (env.origin === fromMemberId) return drop('origin-is-relay');
  // 4. The claimed originator must be an admitted member of THIS session.
  if (!view.admitted.has(env.origin)) return drop('origin-not-admitted');
  // 5. Optional: if we hold a live direct leg to the originator, relayed frames
  //    from them are anomalous (and would dodge the direct bucket).
  if (ctx.strictDirect === true && view.legs.has(env.origin)) return drop('direct-available');
  // 6. The sender must be in OUR OWN candidate set for that originator — i.e. an
  //    admitted, willing, fresh peer that genuinely bridges them and us.
  if (!isRelayAllowed(view, env.origin, fromMemberId)) return drop('relay-not-allowed');

  // 7. Inner packet sanity.
  const h = parseIpv4(env.inner);
  if (h === null) return drop('bad-inner'); // covers a NESTED envelope (version 5)
  if (h.totalLength > LAN_MTU) return drop('oversize');

  // 8. SOURCE AUTHORITY — the claim must match the host-signed, re-derived table.
  if (core.vipOwners.get(h.src >>> 0) !== env.origin) return drop('src-spoof');

  // 9. And it must actually have been addressed to our stack.
  const cls = classifyDest(h.dst >>> 0, subnet.broadcast);
  if (cls === 'unicast') {
    if (!isInSubnet(h.dst >>> 0, subnet)) return drop('off-subnet');
    if ((h.dst >>> 0) !== (core.selfVip >>> 0)) return drop('wrong-inner-dst');
  }

  // 10. Receiver-side relayed budget, keyed by the ORIGINATOR and separate from
  //     the proven per-peer direct bucket.
  const bytes = (frame as Buffer).length;
  if (ctx.budget !== undefined && !ctx.budget(env.origin, bytes)) return drop('budget');

  return { kind: 'accept', origin: env.origin, inner: env.inner };
}

// ─────────────────────────────────────────────────────────────────────────────
// internals
// ─────────────────────────────────────────────────────────────────────────────

function isBuf(v: unknown): v is Buffer {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(v);
}

/** FIFO-cap a bookkeeping map (Map preserves insertion order). */
function capMap(m: Map<string, unknown>, cap: number): void {
  while (m.size > cap) {
    const first = m.keys().next().value as string | undefined;
    if (first === undefined) break;
    m.delete(first);
  }
}
