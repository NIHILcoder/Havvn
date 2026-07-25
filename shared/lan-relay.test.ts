/**
 * Adversarial tests for the pure ONE-HOP PEER RELAY layer (Phase 2B).
 *
 * Locks, in order: the envelope codec against hostile bytes (truncation,
 * oversize, bad magic/version/reserved-flags, non-hex ids, self-addressed) and
 * its MUTUAL EXCLUSION with raw IPv4; the reachability table (monotonic floor,
 * TTL expiry, normalisation); DETERMINISTIC selection (symmetry across the two
 * endpoints, argmin, re-selection when the chosen relay drops, willingness and
 * admission exclusion); the ONE-HOP gate (a twice-travelled frame can never
 * forward); and every rejection path of both data-plane decisions — forged inner
 * src, non-admitted / evicted originator, an unexpected relay, a dst outside the
 * session subnet, a misdirected unicast, and budget exhaustion.
 *
 * Nothing here may throw: every hostile input must return a typed drop.
 */
import { describe, it, expect } from 'vitest';
import {
  LAN_RELAY_MAGIC,
  LAN_RELAY_VER,
  LAN_RELAY_HEADER,
  MAX_RELAY_FRAME,
  LAN_REACH_TTL_MS,
  LanReachTable,
  encodeRelayFrame,
  decodeRelayFrame,
  isRelayFrame,
  relayCandidates,
  selectRelay,
  isRelayAllowed,
  relayEligible,
  planRelayForward,
  acceptRelayedInbound,
  type LanRelayView,
  type LanReachEntry,
  type RelayForwardCtx,
  type RelayAcceptCtx,
} from './lan-relay';
import { parseIpv4 } from './lan-packet';
import { LAN_MTU, type LanCoreView } from './lan-session-core';
import { isLanMemberId, normalizeReachList } from './lan-protocol';
import type { SubnetInfo } from './lan-ip';

// ── fixtures ────────────────────────────────────────────────────────────────
// memberIds are 32 LOWERCASE hex chars. Lexicographic order here is
//   C1('1') < C2('2') < SELF('a') < A('b') < B('c') < D('d')
// so the argmin among {C1, C2} is C1 — deterministic and tie-free.
const SELF = 'a'.repeat(32);
const A = 'b'.repeat(32);
const B = 'c'.repeat(32);
const C1 = '1'.repeat(32);
const C2 = '2'.repeat(32);
const D = 'd'.repeat(32); // never admitted

const SUBNET: SubnetInfo = {
  base: 0x64500000,
  prefix: 16,
  netmask: 0xffff0000,
  broadcast: 0x6450ffff,
};
const SELF_VIP = 0x64500001;
const A_VIP = 0x64500002;
const B_VIP = 0x64500003;
const C1_VIP = 0x64500004;
const C2_VIP = 0x64500005;
const FOREIGN = 0x08080808; // 8.8.8.8 — outside the session /16

const OWNERS = new Map<number, string>([
  [SELF_VIP, SELF],
  [A_VIP, A],
  [B_VIP, B],
  [C1_VIP, C1],
  [C2_VIP, C2],
]);
const ADMITTED = new Set([SELF, A, B, C1, C2]);

/** Minimal IPv4 frame (checksum irrelevant — parseIpv4 does not verify it). */
function ip(src: number, dst: number, payloadLen = 8): Buffer {
  const total = 20 + payloadLen;
  const b = Buffer.alloc(total);
  b[0] = 0x45; // version 4, IHL 5
  b.writeUInt16BE(total, 2);
  b[9] = 17; // UDP
  b.writeUInt32BE(src >>> 0, 12);
  b.writeUInt32BE(dst >>> 0, 16);
  return b;
}

function core(selfVip: number): LanCoreView {
  return { hostId: SELF, admitted: ADMITTED, vipOwners: OWNERS, selfVip };
}

function advert(peers: string[], over: Partial<LanReachEntry> = {}): LanReachEntry {
  return { at: 1, seenAt: 1_000, relay: true, peers: new Set(peers), ...over };
}

/** Both bridges see everyone; `now` sits well inside the TTL of seenAt=1000. */
function bridgeAdverts(): Map<string, LanReachEntry> {
  return new Map<string, LanReachEntry>([
    [C1, advert([SELF, A, B, C2])],
    [C2, advert([SELF, A, B, C1])],
  ]);
}

function view(over: Partial<LanRelayView> = {}): LanRelayView {
  return {
    selfId: SELF,
    admitted: ADMITTED,
    legs: new Set([C1, C2]),
    adverts: bridgeAdverts(),
    now: 2_000,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Envelope codec
// ─────────────────────────────────────────────────────────────────────────────

describe('relay envelope — codec', () => {
  it('round-trips origin, target and the inner packet byte-for-byte', () => {
    const inner = ip(A_VIP, B_VIP);
    const f = encodeRelayFrame(A, B, inner)!;
    expect(f).not.toBeNull();
    expect(f.length).toBe(LAN_RELAY_HEADER + inner.length);
    expect(f[0]).toBe(LAN_RELAY_MAGIC);
    expect(f[1]).toBe(LAN_RELAY_VER);

    const env = decodeRelayFrame(f)!;
    expect(env.origin).toBe(A);
    expect(env.target).toBe(B);
    expect(Buffer.compare(env.inner, inner)).toBe(0);
  });

  it('writes into a caller-owned scratch buffer without allocating', () => {
    const scratch = Buffer.alloc(MAX_RELAY_FRAME);
    const inner = ip(A_VIP, B_VIP);
    const f = encodeRelayFrame(A, B, inner, scratch)!;
    expect(f.buffer).toBe(scratch.buffer); // a subarray of the scratch
    expect(decodeRelayFrame(f)!.origin).toBe(A);
  });

  it('falls back to a fresh buffer when the scratch is too small', () => {
    const f = encodeRelayFrame(A, B, ip(A_VIP, B_VIP), Buffer.alloc(4))!;
    expect(decodeRelayFrame(f)!.target).toBe(B);
  });

  it('NEVER confuses an envelope with a raw IPv4 packet, in either direction', () => {
    const packet = ip(A_VIP, B_VIP);
    const env = encodeRelayFrame(A, B, packet)!;
    // 0x52 has version nibble 5 — parseIpv4 hard-rejects it.
    expect(parseIpv4(env)).toBeNull();
    expect(isRelayFrame(env)).toBe(true);
    // and a bare packet (0x45) is never taken for an envelope.
    expect(isRelayFrame(packet)).toBe(false);
    expect(decodeRelayFrame(packet)).toBeNull();
  });

  it('rejects a non-32-hex / uppercase / empty id instead of throwing', () => {
    const inner = ip(A_VIP, B_VIP);
    expect(encodeRelayFrame('zz', B, inner)).toBeNull();
    expect(encodeRelayFrame(A.toUpperCase(), B, inner)).toBeNull();
    expect(encodeRelayFrame(A, 'a'.repeat(31), inner)).toBeNull();
    expect(encodeRelayFrame('', '', inner)).toBeNull();
    expect(isLanMemberId(A)).toBe(true);
    expect(isLanMemberId(A.toUpperCase())).toBe(false);
    expect(isLanMemberId(123 as unknown)).toBe(false);
  });

  it('rejects origin === target on encode AND on decode', () => {
    expect(encodeRelayFrame(A, A, ip(A_VIP, B_VIP))).toBeNull();
    const f = encodeRelayFrame(A, B, ip(A_VIP, B_VIP))!;
    Buffer.from(A, 'hex').copy(f, 18); // rewrite target = origin on the wire
    expect(decodeRelayFrame(f)).toBeNull();
  });

  it('rejects an empty or over-MTU inner packet', () => {
    expect(encodeRelayFrame(A, B, Buffer.alloc(0))).toBeNull();
    expect(encodeRelayFrame(A, B, Buffer.alloc(LAN_MTU + 1))).toBeNull();
    expect(encodeRelayFrame(A, B, Buffer.alloc(LAN_MTU))).not.toBeNull();
  });

  it('rejects truncated frames and a header with no payload', () => {
    const f = encodeRelayFrame(A, B, ip(A_VIP, B_VIP))!;
    for (const n of [0, 1, 2, 17, 33, LAN_RELAY_HEADER]) {
      expect(decodeRelayFrame(f.subarray(0, n))).toBeNull();
    }
  });

  it('rejects an oversized message (header + more than LAN_MTU)', () => {
    const big = Buffer.alloc(MAX_RELAY_FRAME + 1);
    big[0] = LAN_RELAY_MAGIC;
    big[1] = LAN_RELAY_VER;
    expect(decodeRelayFrame(big)).toBeNull();
  });

  it('rejects a bad magic, a wrong version and ANY reserved flag bit', () => {
    const good = encodeRelayFrame(A, B, ip(A_VIP, B_VIP))!;
    const bad = (mutate: (b: Buffer) => void) => {
      const c = Buffer.from(good);
      mutate(c);
      return decodeRelayFrame(c);
    };
    expect(bad((b) => { b[0] = 0x45; })).toBeNull(); // IPv4-looking magic
    expect(bad((b) => { b[0] = 0x00; })).toBeNull();
    expect(bad((b) => { b[1] = LAN_RELAY_VER + 1; })).toBeNull(); // future version
    expect(bad((b) => { b[1] = 0x00; })).toBeNull(); // version 0
    expect(bad((b) => { b[1] = 0x10 | LAN_RELAY_VER; })).toBeNull(); // reserved bit set
    expect(bad((b) => { b[1] = 0x80 | LAN_RELAY_VER; })).toBeNull();
  });

  it('never throws on non-Buffer / garbage input', () => {
    for (const junk of [undefined, null, 42, 'nope', {}, []]) {
      expect(decodeRelayFrame(junk)).toBeNull();
      expect(isRelayFrame(junk)).toBe(false);
    }
    expect(encodeRelayFrame(A, B, undefined as unknown as Buffer)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Reach vector normalisation + the advert table
// ─────────────────────────────────────────────────────────────────────────────

describe('reach vectors use the SHARED canonical normaliser', () => {
  // normalizeReachList itself is exhaustively covered in lan-protocol.test.ts;
  // what MUST be locked here is that the relay layer uses THAT function and not a
  // private copy — a second implementation would let the emitter and the
  // receiver's normalising clamp drift, producing adverts that silently fail
  // verify with no local symptom.
  it('the table stores exactly normalizeReachList(peers)', () => {
    const raw = [B, A, A, 'zz', 42, null, C1];
    const table = new LanReachTable(() => 1_000);
    table.apply({ memberId: C2, at: 1, relay: true, peers: raw });
    expect([...table.get(C2)!.peers].sort()).toEqual(normalizeReachList(raw));
  });
});

describe('LanReachTable — ingest, own monotonic floor, TTL expiry', () => {
  const mk = () => {
    let t = 1_000;
    const table = new LanReachTable(() => t);
    return { table, tick: (ms: number) => { t += ms; }, at: () => t };
  };

  it('ingests a normalised advert and coerces `relay` strictly', () => {
    const { table } = mk();
    expect(table.apply({ memberId: C1, at: 1, relay: 'true', peers: [B, A, A] })).toBe(true);
    const a = table.get(C1)!;
    expect(a.relay).toBe(false); // a string is NOT true
    expect([...a.peers].sort()).toEqual([A, B].sort());
    expect(table.apply({ memberId: C1, at: 2, relay: true, peers: [A] })).toBe(true);
    expect(table.get(C1)!.relay).toBe(true);
  });

  it('refuses a REPLAYED or equal advert (its OWN monotonic floor)', () => {
    const { table } = mk();
    expect(table.apply({ memberId: C1, at: 5, relay: true, peers: [A] })).toBe(true);
    expect(table.apply({ memberId: C1, at: 5, relay: true, peers: [A, B] })).toBe(false);
    expect(table.apply({ memberId: C1, at: 4, relay: true, peers: [A, B] })).toBe(false);
    expect([...table.get(C1)!.peers]).toEqual([A]); // unchanged by the replay
  });

  it('keeps the floor after forget(), so a captured advert cannot be replayed back', () => {
    const { table } = mk();
    table.apply({ memberId: C1, at: 9, relay: true, peers: [A] });
    table.forget(C1);
    expect(table.get(C1)).toBeUndefined();
    expect(table.apply({ memberId: C1, at: 9, relay: true, peers: [A] })).toBe(false);
    expect(table.apply({ memberId: C1, at: 10, relay: true, peers: [A] })).toBe(true);
  });

  it('expires an advert after the TTL — measured on OUR receipt clock, not theirs', () => {
    const { table, tick } = mk();
    // A wildly future remote clock must not buy extra freshness.
    table.apply({ memberId: C1, at: Number.MAX_SAFE_INTEGER - 1, relay: true, peers: [A] });
    expect(table.get(C1)).toBeDefined();
    tick(LAN_REACH_TTL_MS + 1);
    expect(table.get(C1)).toBeUndefined();
    expect(table.adverts().size).toBe(0);
  });

  it('drops a self-referential leg and rejects malformed ids / clocks', () => {
    const { table } = mk();
    table.apply({ memberId: C1, at: 1, relay: true, peers: [C1, A] });
    expect([...table.get(C1)!.peers]).toEqual([A]);
    expect(table.apply({ memberId: 'nope', at: 1, relay: true, peers: [] })).toBe(false);
    expect(table.apply({ memberId: C2, at: NaN, relay: true, peers: [] })).toBe(false);
    expect(table.apply({ memberId: C2, at: 'x' as unknown as number, relay: true, peers: [] })).toBe(false);
  });

  it('builds a view whose adverts are already pruned', () => {
    const { table, tick } = mk();
    table.apply({ memberId: C1, at: 1, relay: true, peers: [SELF, A] });
    tick(LAN_REACH_TTL_MS + 1);
    table.apply({ memberId: C2, at: 1, relay: true, peers: [SELF, A] });
    const v = table.view(SELF, ADMITTED, new Set([C1, C2]));
    expect([...v.adverts.keys()]).toEqual([C2]);
    expect(selectRelay(v, A)).toBe(C2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Deterministic selection
// ─────────────────────────────────────────────────────────────────────────────

describe('relayCandidates / selectRelay — determinism and convergence', () => {
  it('BOTH ENDPOINTS derive the identical candidate set from the same adverts', () => {
    // A's view of the pair (A,B) and B's view of the pair (A,B): same signed
    // adverts in, byte-identical list out. This is what removes negotiation.
    const vA = view({ selfId: A, legs: new Set([C1, C2]) });
    const vB = view({ selfId: B, legs: new Set([C1, C2]) });
    const setA = relayCandidates(vA, A, B);
    const setB = relayCandidates(vB, A, B);
    expect(setA).toEqual([C1, C2]);
    expect(setA).toEqual(setB);
    // …and the pair order does not matter (the predicate is symmetric).
    expect(relayCandidates(vA, B, A)).toEqual(setA);
    // Both therefore SEND over the same argmin — no handshake, no churn.
    expect(selectRelay(vA, B)).toBe(C1);
    expect(selectRelay(vB, A)).toBe(C1);
  });

  it('is stable under advert insertion order (argmin, not first-seen)', () => {
    const reversed = new Map([...bridgeAdverts()].reverse());
    expect(selectRelay(view({ selfId: A, adverts: reversed }), B)).toBe(C1);
  });

  it('RE-SELECTS the next argmin, identically on both ends, when the relay drops', () => {
    // C1's advert goes stale / it leaves the session → both fall to C2.
    const without = new Map(bridgeAdverts());
    without.delete(C1);
    const vA = view({ selfId: A, adverts: without });
    const vB = view({ selfId: B, adverts: without });
    expect(selectRelay(vA, B)).toBe(C2);
    expect(selectRelay(vB, A)).toBe(C2);

    // Same outcome via TTL expiry rather than departure: C1's advert goes stale
    // while C2 keeps refreshing, so the argmin walks to C2 on BOTH ends.
    const now = 1_000 + LAN_REACH_TTL_MS + 1;
    const stale = new Map(bridgeAdverts());
    stale.set(C1, advert([SELF, A, B, C2], { seenAt: 1_000 })); // last heard long ago
    stale.set(C2, advert([SELF, A, B, C1], { seenAt: now })); // refreshed
    expect(selectRelay(view({ selfId: A, adverts: stale, now }), B)).toBe(C2);
    expect(selectRelay(view({ selfId: B, adverts: stale, now }), A)).toBe(C2);
  });

  it('intersects the SEND choice with our own live legs (advert lag is harmless)', () => {
    // C1 still advertises reachability but OUR leg to it is gone.
    const v = view({ selfId: A, legs: new Set([C2]) });
    expect(relayCandidates(v, A, B)).toEqual([C1, C2]); // advert-only, unchanged
    expect(selectRelay(v, B)).toBe(C2); // …but we only send over a leg we hold
  });

  it('excludes an UNWILLING relay entirely (invariant 5: declining works)', () => {
    const m = bridgeAdverts();
    m.set(C1, advert([SELF, A, B, C2], { relay: false }));
    const v = view({ selfId: A, adverts: m });
    expect(relayCandidates(v, A, B)).toEqual([C2]);
    expect(selectRelay(v, B)).toBe(C2);
  });

  it('excludes a NON-ADMITTED / evicted candidate even with a perfect advert', () => {
    const m = bridgeAdverts();
    m.set(D, advert([SELF, A, B]));
    const v = view({ selfId: A, adverts: m }); // D is not in ADMITTED
    expect(relayCandidates(v, A, B)).toEqual([C1, C2]);

    // …and evicting C1 (removed from the admitted set) drops it immediately.
    const evicted = new Set(ADMITTED);
    evicted.delete(C1);
    expect(selectRelay(view({ selfId: A, admitted: evicted }), B)).toBe(C2);
  });

  it('excludes a candidate that does not bridge BOTH endpoints', () => {
    const m = bridgeAdverts();
    m.set(C1, advert([SELF, A])); // knows A but not B
    expect(relayCandidates(view({ selfId: A, adverts: m }), A, B)).toEqual([C2]);
  });

  it('never selects self, the pair members, a non-admitted or a DIRECT target', () => {
    const v = view({ selfId: A, legs: new Set([B, C1, C2]) });
    expect(selectRelay(v, B)).toBeNull(); // direct leg exists → direct always wins
    expect(selectRelay(v, A)).toBeNull(); // self
    expect(selectRelay(v, D)).toBeNull(); // not admitted
    expect(relayCandidates(v, A, A)).toEqual([]); // degenerate pair
    const m = bridgeAdverts();
    m.set(A, advert([SELF, B])); // A cannot be its own relay
    expect(relayCandidates(view({ selfId: A, adverts: m }), A, B)).toEqual([C1, C2]);
  });

  it('returns null when nothing qualifies (honest "no relay capacity")', () => {
    expect(selectRelay(view({ selfId: A, adverts: new Map() }), B)).toBeNull();
    expect(selectRelay(view({ selfId: A, legs: new Set() }), B)).toBeNull();
  });

  it('relayEligible lists exactly the targets reachable ONLY via a relay', () => {
    const v = view({ selfId: A, legs: new Set([C1, C2]) });
    expect(relayEligible(v, [B, C1, D, A])).toEqual([B]);
  });

  it('isRelayAllowed accepts the WHOLE candidate set, not just our argmin', () => {
    const v = view(); // self = SELF, origin A
    expect(isRelayAllowed(v, A, C1)).toBe(true);
    expect(isRelayAllowed(v, A, C2)).toBe(true); // advert-lag window is not a black hole
    expect(isRelayAllowed(v, A, D)).toBe(false);
    expect(isRelayAllowed(v, A, A)).toBe(false);
    expect(isRelayAllowed(v, A, SELF)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Relay side — planRelayForward (the ONE-HOP gate lives here)
// ─────────────────────────────────────────────────────────────────────────────

/** Context as seen by the RELAY C1: it holds legs to everyone. */
function fwdCtx(over: Partial<RelayForwardCtx> = {}): RelayForwardCtx {
  return {
    view: view({ selfId: C1, legs: new Set([SELF, A, B, C2]) }),
    core: core(C1_VIP),
    subnet: SUBNET,
    willing: true,
    ...over,
  };
}

const AtoB = () => encodeRelayFrame(A, B, ip(A_VIP, B_VIP))!;

describe('planRelayForward — the one-hop gate', () => {
  it('forwards A→B exactly once, byte-identical (amplification gain 1.0)', () => {
    const f = AtoB();
    const r = planRelayForward(f, A, fwdCtx());
    expect(r).toMatchObject({ kind: 'forward', to: B, origin: A });
    if (r.kind !== 'forward') throw new Error('unreachable');
    expect(Buffer.compare(r.frame, f)).toBe(0); // nothing rewritten, nothing added
  });

  it('REFUSES to re-relay a frame that already travelled (from !== origin)', () => {
    // C1 forwarded A→B; C2 now receives it from C1 and must never forward again.
    const f = AtoB();
    const asC2 = fwdCtx({ view: view({ selfId: C2, legs: new Set([SELF, A, B, C1]) }) });
    expect(planRelayForward(f, C1, asC2)).toEqual({ kind: 'drop', reason: 'not-origin' });
    // The gate holds for ANY non-origin sender — loops are unrepresentable.
    expect(planRelayForward(f, B, fwdCtx()).kind).toBe('drop');
    expect(planRelayForward(f, SELF, fwdCtx()).kind).toBe('drop');
  });

  it('refuses a NESTED envelope (an envelope smuggled as the inner packet)', () => {
    const nested = encodeRelayFrame(A, B, AtoB().subarray(0, LAN_MTU))!;
    expect(planRelayForward(nested, A, fwdCtx())).toEqual({ kind: 'drop', reason: 'bad-inner' });
  });

  it('forwards nothing at all when this install declines to relay', () => {
    expect(planRelayForward(AtoB(), A, fwdCtx({ willing: false }))).toEqual({
      kind: 'drop',
      reason: 'not-willing',
    });
  });

  it('refuses a sender spoofing ANOTHER member as the inner src', () => {
    // A wraps a frame carrying B's vIP — the relay analog of acceptInbound.
    const forged = encodeRelayFrame(A, B, ip(B_VIP, B_VIP))!;
    expect(planRelayForward(forged, A, fwdCtx())).toEqual({ kind: 'drop', reason: 'src-spoof' });
    // …and an unknown/unrouted src is equally refused.
    const unknown = encodeRelayFrame(A, B, ip(0x6450dead, B_VIP))!;
    expect(planRelayForward(unknown, A, fwdCtx()).kind).toBe('drop');
  });

  it('refuses a non-admitted or evicted origin / target', () => {
    const fromD = encodeRelayFrame(D, B, ip(A_VIP, B_VIP))!;
    expect(planRelayForward(fromD, D, fwdCtx())).toEqual({
      kind: 'drop',
      reason: 'origin-not-admitted',
    });
    const evicted = new Set(ADMITTED);
    evicted.delete(B);
    const ctx = fwdCtx({ view: view({ selfId: C1, admitted: evicted, legs: new Set([SELF, A, B]) }) });
    expect(planRelayForward(AtoB(), A, ctx)).toEqual({ kind: 'drop', reason: 'target-not-admitted' });
  });

  it('refuses a target we hold no leg to, ourselves, and a bounce-back', () => {
    const noLeg = fwdCtx({ view: view({ selfId: C1, legs: new Set([A]) }) });
    expect(planRelayForward(AtoB(), A, noLeg)).toEqual({ kind: 'drop', reason: 'target-unreachable' });

    const toSelf = encodeRelayFrame(A, C1, ip(A_VIP, C1_VIP))!;
    expect(planRelayForward(toSelf, A, fwdCtx())).toEqual({ kind: 'drop', reason: 'target-is-self' });

    const back = encodeRelayFrame(A, A, ip(A_VIP, A_VIP)); // encode refuses outright
    expect(back).toBeNull();
  });

  it('refuses a unicast whose inner dst is NOT the envelope target (misdirection)', () => {
    const misdirected = encodeRelayFrame(A, B, ip(A_VIP, C2_VIP))!; // says B, aimed at C2
    expect(planRelayForward(misdirected, A, fwdCtx())).toEqual({
      kind: 'drop',
      reason: 'dst-mismatch',
    });
  });

  it('refuses a dst OUTSIDE the session subnet (no exfiltration through the relay)', () => {
    const out = encodeRelayFrame(A, B, ip(A_VIP, FOREIGN))!;
    expect(planRelayForward(out, A, fwdCtx())).toEqual({ kind: 'drop', reason: 'off-subnet' });
  });

  it('forwards broadcast / multicast 1-in-1-out (the ORIGINATOR replicates)', () => {
    for (const dst of [0xffffffff, SUBNET.broadcast, 0xe00000fb, 0xeffffffa]) {
      const f = encodeRelayFrame(A, B, ip(A_VIP, dst >>> 0))!;
      expect(planRelayForward(f, A, fwdCtx())).toMatchObject({ kind: 'forward', to: B });
    }
  });

  it('refuses an over-MTU inner packet and every hostile byte string', () => {
    const over = Buffer.alloc(LAN_RELAY_HEADER + 40);
    over[0] = LAN_RELAY_MAGIC;
    over[1] = LAN_RELAY_VER;
    Buffer.from(A, 'hex').copy(over, 2);
    Buffer.from(B, 'hex').copy(over, 18);
    const inner = ip(A_VIP, B_VIP, 20);
    inner.writeUInt16BE(LAN_MTU + 1, 2); // lying totalLength
    inner.copy(over, LAN_RELAY_HEADER);
    expect(planRelayForward(over, A, fwdCtx()).kind).toBe('drop');

    for (const junk of [undefined, null, Buffer.alloc(0), Buffer.alloc(3), ip(A_VIP, B_VIP), 'x']) {
      expect(planRelayForward(junk, A, fwdCtx())).toEqual({ kind: 'drop', reason: 'bad-envelope' });
    }
  });

  it('respects the forwarding budget, charged to the ORIGINATOR', () => {
    const seen: Array<[string, string, number]> = [];
    const ctx = fwdCtx({
      budget: (o, t, n) => {
        seen.push([o, t, n]);
        return seen.length <= 1; // the second frame is over budget
      },
    });
    expect(planRelayForward(AtoB(), A, ctx).kind).toBe('forward');
    expect(planRelayForward(AtoB(), A, ctx)).toEqual({ kind: 'drop', reason: 'budget' });
    expect(seen[0][0]).toBe(A); // keyed by the originator, which IS the channel
    expect(seen[0][1]).toBe(B);
    expect(seen[0][2]).toBe(LAN_RELAY_HEADER + 28);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Receiver side — acceptRelayedInbound (source authority vs the CLAIM)
// ─────────────────────────────────────────────────────────────────────────────

/** Context as seen by the RECEIVER SELF, whose direct leg to A is terminal. */
function accCtx(over: Partial<RelayAcceptCtx> = {}): RelayAcceptCtx {
  return {
    view: view({ selfId: SELF, legs: new Set([C1, C2]) }),
    core: core(SELF_VIP),
    subnet: SUBNET,
    ...over,
  };
}

const AtoSelf = (src = A_VIP, dst = SELF_VIP) => encodeRelayFrame(A, SELF, ip(src, dst))!;

describe('acceptRelayedInbound — source authority', () => {
  it('accepts a frame from a genuine bridge and reports the ORIGINATOR', () => {
    const r = acceptRelayedInbound(AtoSelf(), C1, accCtx());
    expect(r).toMatchObject({ kind: 'accept', origin: A });
    if (r.kind !== 'accept') throw new Error('unreachable');
    expect(parseIpv4(r.inner)!.src).toBe(A_VIP);
  });

  it('REJECTS a relay forging the inner src as another member', () => {
    // C1 claims the frame came from A but stamped B's vIP inside.
    const forged = encodeRelayFrame(A, SELF, ip(B_VIP, SELF_VIP))!;
    expect(acceptRelayedInbound(forged, C1, accCtx())).toEqual({ kind: 'drop', reason: 'src-spoof' });
    // …and an unrouted / out-of-table src is equally refused.
    const unknown = encodeRelayFrame(A, SELF, ip(0x6450dead, SELF_VIP))!;
    expect(acceptRelayedInbound(unknown, C1, accCtx()).kind).toBe('drop');
    // The claim itself is not enough: origin must OWN the src.
    const swapped = encodeRelayFrame(B, SELF, ip(A_VIP, SELF_VIP))!;
    expect(acceptRelayedInbound(swapped, C1, accCtx())).toEqual({ kind: 'drop', reason: 'src-spoof' });
  });

  it('rejects a non-admitted / evicted originator', () => {
    const fromD = encodeRelayFrame(D, SELF, ip(A_VIP, SELF_VIP))!;
    expect(acceptRelayedInbound(fromD, C1, accCtx())).toEqual({
      kind: 'drop',
      reason: 'origin-not-admitted',
    });
    const evicted = new Set(ADMITTED);
    evicted.delete(A);
    const ctx = accCtx({ view: view({ selfId: SELF, admitted: evicted, legs: new Set([C1, C2]) }) });
    expect(acceptRelayedInbound(AtoSelf(), C1, ctx)).toEqual({
      kind: 'drop',
      reason: 'origin-not-admitted',
    });
  });

  it('rejects delivery from a peer that is NOT a candidate for that originator', () => {
    // B has a leg to us but never advertised bridging A → it may not inject as A.
    expect(acceptRelayedInbound(AtoSelf(), B, accCtx())).toEqual({
      kind: 'drop',
      reason: 'relay-not-allowed',
    });
    // An UNWILLING relay is likewise not in the candidate set.
    const m = bridgeAdverts();
    m.set(C1, advert([SELF, A, B, C2], { relay: false }));
    const ctx = accCtx({ view: view({ selfId: SELF, adverts: m, legs: new Set([C1, C2]) }) });
    expect(acceptRelayedInbound(AtoSelf(), C1, ctx)).toEqual({
      kind: 'drop',
      reason: 'relay-not-allowed',
    });
    // …and a STALE advert stops qualifying the moment the TTL passes.
    const stale = accCtx({
      view: view({ selfId: SELF, legs: new Set([C1, C2]), now: 1_000 + LAN_REACH_TTL_MS + 1 }),
    });
    expect(acceptRelayedInbound(AtoSelf(), C1, stale).kind).toBe('drop');
  });

  it('rejects a relay laundering its OWN traffic through the relayed budget', () => {
    const own = encodeRelayFrame(C1, SELF, ip(C1_VIP, SELF_VIP))!;
    expect(acceptRelayedInbound(own, C1, accCtx())).toEqual({
      kind: 'drop',
      reason: 'origin-is-relay',
    });
  });

  it('rejects a self-echo and a frame addressed to somebody else', () => {
    const echo = encodeRelayFrame(SELF, A, ip(SELF_VIP, A_VIP))!;
    expect(acceptRelayedInbound(echo, C1, accCtx())).toEqual({ kind: 'drop', reason: 'not-for-me' });
    const forB = encodeRelayFrame(A, B, ip(A_VIP, B_VIP))!;
    expect(acceptRelayedInbound(forB, C1, accCtx())).toEqual({ kind: 'drop', reason: 'not-for-me' });
  });

  it('rejects a unicast that was not addressed to our own stack', () => {
    const wrong = encodeRelayFrame(A, SELF, ip(A_VIP, B_VIP))!;
    expect(acceptRelayedInbound(wrong, C1, accCtx())).toEqual({
      kind: 'drop',
      reason: 'wrong-inner-dst',
    });
    const out = encodeRelayFrame(A, SELF, ip(A_VIP, FOREIGN))!;
    expect(acceptRelayedInbound(out, C1, accCtx())).toEqual({ kind: 'drop', reason: 'off-subnet' });
  });

  it('accepts relayed broadcast / multicast — LAN game discovery survives', () => {
    for (const dst of [0xffffffff, SUBNET.broadcast, 0xe00000fb, 0xeffffffa]) {
      const f = encodeRelayFrame(A, SELF, ip(A_VIP, dst >>> 0))!;
      expect(acceptRelayedInbound(f, C1, accCtx())).toMatchObject({ kind: 'accept', origin: A });
    }
  });

  it('optionally refuses relayed traffic from an originator we can reach DIRECTLY', () => {
    const direct = view({ selfId: SELF, legs: new Set([A, C1, C2]) });
    expect(acceptRelayedInbound(AtoSelf(), C1, accCtx({ view: direct })).kind).toBe('accept');
    expect(acceptRelayedInbound(AtoSelf(), C1, accCtx({ view: direct, strictDirect: true }))).toEqual({
      kind: 'drop',
      reason: 'direct-available',
    });
  });

  it('respects the receiver-side relayed budget, keyed by the ORIGINATOR', () => {
    const seen: Array<[string, number]> = [];
    const ctx = accCtx({
      budget: (o, n) => {
        seen.push([o, n]);
        return seen.length <= 1;
      },
    });
    expect(acceptRelayedInbound(AtoSelf(), C1, ctx).kind).toBe('accept');
    expect(acceptRelayedInbound(AtoSelf(), C1, ctx)).toEqual({ kind: 'drop', reason: 'budget' });
    expect(seen[0][0]).toBe(A); // NOT the relay — a relay cannot drain a peer's budget key
  });

  it('never throws on hostile bytes', () => {
    for (const junk of [undefined, null, Buffer.alloc(0), Buffer.alloc(LAN_RELAY_HEADER), 'x', {}]) {
      expect(acceptRelayedInbound(junk, C1, accCtx())).toEqual({ kind: 'drop', reason: 'bad-envelope' });
    }
    const badInner = encodeRelayFrame(A, SELF, Buffer.from([0x00, 0x01, 0x02]))!;
    expect(acceptRelayedInbound(badInner, C1, accCtx())).toEqual({ kind: 'drop', reason: 'bad-inner' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. End-to-end: the full A → C1 → SELF path, and the loop that cannot happen
// ─────────────────────────────────────────────────────────────────────────────

describe('one-hop path — end to end', () => {
  it('A picks C1, C1 forwards once, SELF accepts, and nobody forwards again', () => {
    // 1. A selects the relay for the terminal leg to SELF.
    const vA = view({ selfId: A, legs: new Set([C1, C2]) });
    const via = selectRelay(vA, SELF);
    expect(via).toBe(C1);

    // 2. A envelopes its frame.
    const frame = encodeRelayFrame(A, SELF, ip(A_VIP, SELF_VIP))!;

    // 3. C1 forwards it exactly once.
    const atC1 = planRelayForward(frame, A, fwdCtx());
    expect(atC1).toMatchObject({ kind: 'forward', to: SELF });

    // 4. SELF accepts it and attributes it to A — never to C1.
    const atSelf = acceptRelayedInbound(frame, C1, accCtx());
    expect(atSelf).toMatchObject({ kind: 'accept', origin: A });

    // 5. The very same bytes, offered to ANY relay by a non-origin sender, die.
    for (const hop of [C1, C2, B, SELF]) {
      const ctx = fwdCtx({ view: view({ selfId: C2, legs: new Set([SELF, A, B, C1]) }) });
      if (hop === C2) continue; // C2 cannot receive from itself
      expect(planRelayForward(frame, hop, ctx)).toEqual({ kind: 'drop', reason: 'not-origin' });
    }
  });

  it('the relayed pair reverts to DIRECT the instant the leg comes back', () => {
    const relayed = view({ selfId: A, legs: new Set([C1, C2]) });
    expect(selectRelay(relayed, SELF)).toBe(C1);
    const recovered = view({ selfId: A, legs: new Set([SELF, C1, C2]) });
    expect(selectRelay(recovered, SELF)).toBeNull();
    expect(relayEligible(recovered, [SELF, B])).toEqual([B]);
  });
});
