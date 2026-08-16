/**
 * Adversarial unit tests for LanSessionCore — the host-gated admission + vIP
 * routing state machine. No RTCPeerConnection is ever constructed (this is the
 * pure core; the RTC wiring is LanSession), mirroring how room-voice.test.ts
 * locks VoiceSession's gossip state machine without touching media.
 *
 * The attacks these lock down (plan §0.1):
 *   • genesis can ONLY pin the host the sessionId commits to (#7) — no host-spoof race;
 *   • a rostered-but-unadmitted member cannot be admitted or routed (#1);
 *   • a host-signed admit/evict from ANOTHER session cannot replay in (#1 domain confusion);
 *   • a forged vIP claim (vip != deriveVip) is rejected (#6);
 *   • replays of admit / evict / state are rejected (per-type floors, never shared);
 *   • an evicted member is terminally barred from re-admission;
 *   • the join-intent claim store is bounded and never drops an admitted member (#anti-DoS).
 */
import { describe, it, expect } from 'vitest';
import { LanSessionCore, MAX_LAN_PEERS, MAX_ANTIREPLAY, sessionHostPrefix } from './lan-session-core';
import { deriveVip } from './lan-ip';

const HOST = 'host00000000000000000000000000000';
// A sessionId is `${hostId}.${random}` — genesis binds `by` to this prefix (#7).
const SID = HOST + '.a1b2c3d4e5f60718';
const SID_OTHER = HOST + '.9988776655443322'; // SAME host, DIFFERENT session (cross-session replay)
const A = '0123456789abcdef0123456789abcdef';
const B = 'fedcba9876543210fedcba9876543210';
const SELF = 'self0000000000000000000000000000';

function claim(sessionId: string, memberId: string, gen: number, at: number, vip?: number) {
  return { sessionId, memberId, gen, at, vip: vip ?? deriveVip(sessionId, memberId, gen) };
}

/** Find two distinct members that genuinely derive the SAME vip at gen 0. */
function findCollision(sid: string): { low: string; high: string; vip: number } {
  const seen = new Map<number, string>();
  for (let i = 0; i < 200000; i++) {
    const id = 'm' + i;
    const vip = deriveVip(sid, id, 0);
    const prev = seen.get(vip);
    if (prev) {
      const [low, high] = prev < id ? [prev, id] : [id, prev];
      return { low, high, vip };
    }
    seen.set(vip, id);
  }
  throw new Error('no collision found in search space');
}

describe('sessionHostPrefix', () => {
  it('extracts the committed host, and is empty for a malformed id', () => {
    expect(sessionHostPrefix(SID)).toBe(HOST);
    expect(sessionHostPrefix('nohostprefix')).toBe('');
    expect(sessionHostPrefix('.leadingdot')).toBe('');
  });
});

describe('LanSessionCore — genesis pinning (must-fix #7)', () => {
  it('pins the committed host and is idempotent for a re-broadcast of the same host', () => {
    const c = new LanSessionCore(SID, SELF);
    expect(c.hostId()).toBeNull();
    expect(c.pinGenesis(HOST, SID, 100)).toBe(true);
    expect(c.hostId()).toBe(HOST);
    expect(c.pinGenesis(HOST, SID, 200)).toBe(true); // same host, re-served on hello
    expect(c.hostId()).toBe(HOST);
  });

  it('rejects a genesis whose host is NOT the sessionId prefix (host-spoof race, #7)', () => {
    const c = new LanSessionCore(SID, SELF);
    // Attacker A signs a valid genesis naming THEMSELVES as host for the real
    // session's id — must be refused even though it arrives first.
    expect(c.pinGenesis(A, SID, 1)).toBe(false);
    expect(c.hostId()).toBeNull();
    // The real host (== prefix) still pins.
    expect(c.pinGenesis(HOST, SID, 2)).toBe(true);
    expect(c.hostId()).toBe(HOST);
  });

  it('rejects a second genesis that names a DIFFERENT host (first-writer-wins)', () => {
    const c = new LanSessionCore(SID, SELF);
    expect(c.pinGenesis(HOST, SID, 100)).toBe(true);
    // A different host can't even be the prefix, so this is doubly rejected.
    expect(c.pinGenesis(A, SID, 999)).toBe(false);
    expect(c.hostId()).toBe(HOST);
  });

  it('rejects a genesis for a different sessionId', () => {
    const c = new LanSessionCore(SID, SELF);
    expect(c.pinGenesis(HOST, SID_OTHER, 100)).toBe(false);
    expect(c.hostId()).toBeNull();
  });
});

describe('LanSessionCore — admission gate (must-fix #1)', () => {
  it('a rostered-but-unadmitted member (announced presence, no host grant) cannot be admitted or routed', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    expect(c.applyState(claim(SID, B, 0, 10))).toBe(true); // valid presence / join-intent
    expect(c.isAdmitted(B)).toBe(false);
    expect(c.canAdmitPeer(B)).toBe(false);               // ensurePeer would refuse to build a LanPeer
    expect(c.vipToMember(deriveVip(SID, B, 0))).toBeUndefined(); // never enters the routing table
    expect(c.memberVip(B)).toBeUndefined();
  });

  it('refuses admits before a genesis is pinned, and admits signed by a non-host', () => {
    const c = new LanSessionCore(SID, SELF);
    expect(c.applyAdmit(HOST, A, 5, SID)).toBe(false); // no pinned host yet
    c.pinGenesis(HOST, SID, 1);
    expect(c.applyAdmit(A, A, 5, SID)).toBe(false);    // `by` is not the pinned host — self-admit blocked
    expect(c.isAdmitted(A)).toBe(false);
    expect(c.applyAdmit(HOST, A, 5, SID)).toBe(true);  // host grant → admitted
    expect(c.isAdmitted(A)).toBe(true);
    expect(c.canAdmitPeer(A)).toBe(true);
  });

  it('rejects a host-signed admit from ANOTHER session (cross-session replay, #1)', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    // The SAME host admitted A in a past session SID_OTHER; the signature verifies
    // (host-signed) and the fresh core has no floor for A — but the sessionId gate
    // must reject it so A is NOT admitted into THIS session.
    expect(c.applyAdmit(HOST, A, 500, SID_OTHER)).toBe(false);
    expect(c.isAdmitted(A)).toBe(false);
    expect(c.canAdmitPeer(A)).toBe(false);
    // The in-session admit still works.
    expect(c.applyAdmit(HOST, A, 5, SID)).toBe(true);
    expect(c.isAdmitted(A)).toBe(true);
  });

  it('rejects a grant from a PREVIOUS RUN of the same session (persisted watermark)', () => {
    // The whole point of reusing a sessionId across restarts (stable vIPs) is that
    // it re-opens the door the sessionId gate closes above: a host-signed admit
    // issued last night carries THIS session's id, and a fresh core has no floor
    // for its target. The persisted watermark is what keeps that door shut.
    const c = new LanSessionCore(SID, SELF, Date.now, 1000);
    c.pinGenesis(HOST, SID, 1);
    expect(c.applyAdmit(HOST, A, 900, SID)).toBe(false);  // last night's grant
    expect(c.applyAdmit(HOST, A, 1000, SID)).toBe(false); // exactly the watermark
    expect(c.isAdmitted(A)).toBe(false);
    expect(c.applyAdmit(HOST, A, 1001, SID)).toBe(true);  // tonight's grant
    expect(c.isAdmitted(A)).toBe(true);
    // Same rule for evict, so a stale ban cannot replay in either.
    expect(c.applyEvict(HOST, B, 900, SID)).toBe(false);
    expect(c.applyEvict(HOST, B, 1001, SID)).toBe(true);
  });

  it('the seed is a floor for EVERY member, not a running maximum', () => {
    // A running maximum would let one member's admit raise the bar for another and
    // reject an older-but-legitimate grant that arrived out of order — gossip is an
    // unordered flood, so that reordering is normal, not exotic.
    const c = new LanSessionCore(SID, SELF, Date.now, 100);
    c.pinGenesis(HOST, SID, 1);
    expect(c.applyAdmit(HOST, A, 900, SID)).toBe(true);
    expect(c.applyAdmit(HOST, B, 200, SID)).toBe(true); // older than A's, still above the seed
    expect(c.isAdmitted(B)).toBe(true);
  });

  it('reports a watermark that covers every grant it applied', () => {
    const c = new LanSessionCore(SID, SELF, Date.now, 50);
    expect(c.authorityFloor()).toBe(50); // the seed, before anything is applied
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, A, 300, SID);
    c.applyEvict(HOST, B, 700, SID);
    c.applyAdmit(HOST, A, 500, SID); // rejected replay — must not lower it
    expect(c.authorityFloor()).toBe(700);
    // Persisting THIS and seeding a fresh core with it makes every grant above
    // un-replayable, which is the invariant the next run depends on.
    const next = new LanSessionCore(SID, SELF, Date.now, c.authorityFloor());
    next.pinGenesis(HOST, SID, 1);
    expect(next.applyAdmit(HOST, A, 300, SID)).toBe(false);
    expect(next.applyEvict(HOST, B, 700, SID)).toBe(false);
  });

  it('treats a junk watermark as no watermark rather than bricking the session', () => {
    for (const bad of [NaN, -5, Infinity]) {
      const c = new LanSessionCore(SID, SELF, Date.now, bad);
      c.pinGenesis(HOST, SID, 1);
      expect(c.authorityFloor()).toBe(0);
      expect(c.applyAdmit(HOST, A, 5, SID)).toBe(true);
    }
  });

  it('never treats self as an admittable peer even if self is somehow admitted', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, SELF, 5, SID);
    expect(c.canAdmitPeer(SELF)).toBe(false); // self is driven by join, not the mesh
  });
});

describe('LanSessionCore — forged vIP claims (must-fix #6)', () => {
  it('rejects a claim whose vip does not derive from (session, member, gen)', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, A, 2, SID);
    const victimVip = deriveVip(SID, B, 0);
    expect(c.applyState(claim(SID, A, 0, 10, victimVip))).toBe(false); // A claims B's address
    expect(c.vipToMember(victimVip)).toBeUndefined();
    expect(c.applyState(claim(SID, A, 0, 11))).toBe(true); // A's honest claim routes
    expect(c.vipToMember(deriveVip(SID, A, 0))).toBe(A);
  });

  it('rejects a claim for a different session', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, A, 2, SID);
    expect(c.applyState(claim(SID_OTHER, A, 0, 10))).toBe(false);
  });

  it('ignores our own relayed presence echo', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, SELF, 2, SID);
    expect(c.applyState(claim(SID, SELF, 0, 10))).toBe(false);
  });
});

describe('LanSessionCore — anti-replay floors (separate per type)', () => {
  it('rejects a replayed (stale-or-equal `at`) admit', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    expect(c.applyAdmit(HOST, A, 20, SID)).toBe(true);
    expect(c.applyAdmit(HOST, A, 20, SID)).toBe(false); // equal — replay
    expect(c.applyAdmit(HOST, A, 10, SID)).toBe(false); // older — replay
    expect(c.isAdmitted(A)).toBe(true);
  });

  it('rejects a replayed lan-state and never flips the routing table back', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, A, 2, SID);
    expect(c.applyState(claim(SID, A, 0, 10))).toBe(true);
    expect(c.applyState(claim(SID, A, 0, 10))).toBe(false); // equal — replay
    expect(c.applyState(claim(SID, A, 0, 5))).toBe(false);  // older — replay
    expect(c.vipToMember(deriveVip(SID, A, 0))).toBe(A);
  });

  it('keeps admit and evict on SEPARATE floors — an evict does not open an old-admit replay', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, A, 30, SID);   // admit floor = 30
    c.applyEvict(HOST, A, 5, SID);    // evict floor = 5, independent — still terminal
    expect(c.isAdmitted(A)).toBe(false);
    expect(c.applyAdmit(HOST, A, 20, SID)).toBe(false); // rejected by BOTH the floor and terminal-evict
    expect(c.isAdmitted(A)).toBe(false);
  });
});

describe('LanSessionCore — terminal evict', () => {
  it('evict is sticky: an admitted member is dropped and cannot be re-admitted in this session', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, A, 2, SID);
    c.applyState(claim(SID, A, 0, 3));
    expect(c.vipToMember(deriveVip(SID, A, 0))).toBe(A);

    expect(c.applyEvict(HOST, A, 4, SID)).toBe(true);
    expect(c.isAdmitted(A)).toBe(false);
    expect(c.vipToMember(deriveVip(SID, A, 0))).toBeUndefined(); // vIP released everywhere

    expect(c.applyAdmit(HOST, A, 99, SID)).toBe(false); // a newer admit can't resurrect an evicted member
    expect(c.isAdmitted(A)).toBe(false);
  });

  it('rejects a cross-session evict replay (permanent-ban DoS variant, #1)', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, A, 2, SID);
    // A captured host-signed evict from a PAST session must not terminally ban A here.
    expect(c.applyEvict(HOST, A, 500, SID_OTHER)).toBe(false);
    expect(c.isAdmitted(A)).toBe(true); // still admitted in THIS session
  });

  it('a non-host evict is rejected and a replayed evict is rejected', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, A, 2, SID);
    expect(c.applyEvict(A, A, 5, SID)).toBe(false);  // not the host
    expect(c.isAdmitted(A)).toBe(true);
    expect(c.applyEvict(HOST, A, 10, SID)).toBe(true);
    expect(c.applyEvict(HOST, A, 10, SID)).toBe(false); // replay
    expect(c.applyEvict(HOST, A, 7, SID)).toBe(false);  // older replay
  });
});

describe('LanSessionCore — routing table & join-before-admit ordering', () => {
  it('a claim that arrives BEFORE the admit routes as soon as the admit lands', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    expect(c.applyState(claim(SID, A, 0, 10))).toBe(true); // presence floods first
    expect(c.vipToMember(deriveVip(SID, A, 0))).toBeUndefined(); // not admitted yet
    expect(c.applyAdmit(HOST, A, 11, SID)).toBe(true);
    expect(c.vipToMember(deriveVip(SID, A, 0))).toBe(A);   // now routes without re-announce
    expect(c.memberVip(A)).toBe(deriveVip(SID, A, 0));
  });

  it('onMemberGone releases the route/admit but KEEPS the floors (no replay resurrection)', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, A, 5, SID);
    c.applyState(claim(SID, A, 0, 10));
    expect(c.vipToMember(deriveVip(SID, A, 0))).toBe(A);

    c.onMemberGone(A);
    expect(c.isAdmitted(A)).toBe(false);
    expect(c.vipToMember(deriveVip(SID, A, 0))).toBeUndefined();

    expect(c.applyState(claim(SID, A, 0, 10))).toBe(false); // stale state replay rejected (floor kept)
    expect(c.applyAdmit(HOST, A, 5, SID)).toBe(false);      // stale admit replay rejected (floor kept)
    expect(c.applyAdmit(HOST, A, 6, SID)).toBe(true);       // genuinely-newer admit re-admits
    expect(c.isAdmitted(A)).toBe(true);
  });
});

describe('LanSessionCore — collision arbitration', () => {
  it('converges on the lowest memberId among admitted claimants of a shared vIP', () => {
    const { low, high, vip } = findCollision(SID);
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, high, 1, SID);
    c.applyAdmit(HOST, low, 1, SID);
    expect(c.applyState(claim(SID, high, 0, 10))).toBe(true);
    expect(c.applyState(claim(SID, low, 0, 10))).toBe(true);
    expect(c.vipToMember(vip)).toBe(low); // lowest memberId wins at every receiver
  });

  it('bumpGenOnCollision bumps only when a lower-memberId peer owns our derived vIP', () => {
    const { low, high, vip } = findCollision(SID);
    const c = new LanSessionCore(SID, high); // we are the HIGHER member → we lose to `low`
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, low, 1, SID);
    expect(c.selfVip()).toBe(vip);
    c.applyState(claim(SID, low, 0, 10));
    const bumped = c.bumpGenOnCollision();
    expect(bumped).not.toBeNull();
    expect(bumped!.gen).toBe(1);
    expect(bumped!.vip).toBe(deriveVip(SID, high, 1));
    expect(c.selfVip()).toBe(deriveVip(SID, high, 1));
    expect(c.bumpGenOnCollision()).toBeNull(); // no further collision at the new gen
  });

  it('does not bump when no admitted peer contests our vIP', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    expect(c.bumpGenOnCollision()).toBeNull();
  });
});

describe('LanSessionCore — per-peer token bucket', () => {
  it('admits up to the burst then drops, and refills over wall-clock', () => {
    let clock = 1000;
    const c = new LanSessionCore(SID, SELF, () => clock, 0, {
      pps: 3, bytesPerSec: 100_000, burstPackets: 3, burstBytes: 100_000,
    });
    expect(c.allowPacket(A, 100)).toBe(true);
    expect(c.allowPacket(A, 100)).toBe(true);
    expect(c.allowPacket(A, 100)).toBe(true);
    expect(c.allowPacket(A, 100)).toBe(false); // burst exhausted
    clock += 1000;
    expect(c.allowPacket(A, 100)).toBe(true);
  });

  it('drops when the byte budget is exhausted even if packets remain', () => {
    let clock = 0;
    const c = new LanSessionCore(SID, SELF, () => clock, 0, {
      pps: 1000, bytesPerSec: 1000, burstPackets: 1000, burstBytes: 150,
    });
    expect(c.allowPacket(A, 100)).toBe(true);  // 50 bytes left
    expect(c.allowPacket(A, 100)).toBe(false); // not enough byte budget
  });

  it('meters peers independently', () => {
    let clock = 0;
    const c = new LanSessionCore(SID, SELF, () => clock, 0, {
      pps: 1, bytesPerSec: 1000, burstPackets: 1, burstBytes: 1000,
    });
    expect(c.allowPacket(A, 10)).toBe(true);
    expect(c.allowPacket(A, 10)).toBe(false);
    expect(c.allowPacket(B, 10)).toBe(true); // B has its own bucket
  });
});

describe('LanSessionCore — bounds & view', () => {
  it('exposes the mesh cap', () => {
    expect(MAX_LAN_PEERS).toBe(8);
  });

  it('FIFO-caps the anti-replay floor maps against fabricated identities', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    for (let i = 0; i < MAX_ANTIREPLAY + 50; i++) c.applyAdmit(HOST, 'fake-' + i, i + 1, SID);
    expect(c.applyAdmit(HOST, 'fake-0', 1, SID)).toBe(true); // early floor was evicted (bounded memory)
  });

  it('bounds the join-intent claim store WITHOUT dropping an admitted member (anti-DoS)', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    // A is admitted early and claims a routable vIP.
    c.applyAdmit(HOST, A, 1, SID);
    expect(c.applyState(claim(SID, A, 0, 2))).toBe(true);
    expect(c.vipToMember(deriveVip(SID, A, 0))).toBe(A);
    // Flood the claim store with many synthetic NON-admitted claimants (> cap).
    for (let i = 0; i < MAX_ANTIREPLAY + 100; i++) c.applyState(claim(SID, 'flood-' + i, 0, 3 + i));
    // The admitted member's route MUST survive (capClaims only evicts non-admitted).
    expect(c.vipToMember(deriveVip(SID, A, 0))).toBe(A);
    expect(c.isAdmitted(A)).toBe(true);
  });

  it('view() reports the pinned host, admitted set, and self vIP', () => {
    const c = new LanSessionCore(SID, SELF);
    c.pinGenesis(HOST, SID, 1);
    c.applyAdmit(HOST, A, 2, SID);
    const v = c.view();
    expect(v.hostId).toBe(HOST);
    expect(v.admitted.has(A)).toBe(true);
    expect(v.selfVip).toBe(deriveVip(SID, SELF, 0));
  });
});
