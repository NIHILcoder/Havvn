import { describe, it, expect } from 'vitest';
import {
  lanGenesisCanonical, lanAdmitCanonical, lanEvictCanonical,
  lanStateCanonical, lanSignalCanonical, lanReachCanonical,
  clampLanStr, clampVip, clampGen, normalizeReachList,
  clampLanGenesis, clampLanAdmit, clampLanEvict, clampLanState, clampLanSignal, clampLanReach,
  isValidLanGenesis, isValidLanAdmit, isValidLanEvict, isValidLanState, isValidLanSignal,
  isValidLanReach, isNormalizedReach, isLanMemberId,
  isLanSignalKind,
  GEN_MAX, MAX_LAN_STR, MAX_LAN_REACH, MAX_REACH_SCAN,
  LAN_GENESIS_TAG, LAN_STATE_TAG, LAN_SIGNAL_TAG, LAN_ADMIT_TAG, LAN_EVICT_TAG, LAN_REACH_TAG,
} from './lan-protocol';

const SID = 'sess-1';
const TOPIC = 'topic-x';
const HOST = 'hostA';
const MEM = 'memB';

const creds = { pub: 'PUBKEYPEM', sig: 'SIGBYTES' };

/** Real-shaped memberIds (32 lowercase hex — sha256(pub).slice(0,32)), which the
 *  reach list requires. Declared ASCENDING so `[A, B, C]` is already canonical. */
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);

// ─────────────────────────────────────────────────────────────────────────────
// Golden bytes — the v1 field order is FROZEN. If any of these change, older
// peers' signatures break. A failure here means someone appended/reordered a
// field (the `deafened` regression) — do NOT "fix" by updating the golden.
// ─────────────────────────────────────────────────────────────────────────────
describe('canonical golden bytes (frozen v1 field order)', () => {
  it('lan-genesis = [tag, sessionId, by, at]', () => {
    expect(lanGenesisCanonical(SID, { by: HOST, at: 100 }).toString('utf8'))
      .toBe('["th-lan-genesis:v1","sess-1","hostA",100]');
  });
  it('lan-admit = [tag, sessionId, by, member, at]', () => {
    expect(lanAdmitCanonical(SID, { by: HOST, member: MEM, at: 100 }).toString('utf8'))
      .toBe('["th-lan-admit:v1","sess-1","hostA","memB",100]');
  });
  it('lan-evict = [tag, sessionId, by, member, at]', () => {
    expect(lanEvictCanonical(SID, { by: HOST, member: MEM, at: 100 }).toString('utf8'))
      .toBe('["th-lan-evict:v1","sess-1","hostA","memB",100]');
  });
  it('lan-state = [tag, topic, memberId, sessionId, at, vip, gen]', () => {
    expect(lanStateCanonical(TOPIC, { memberId: MEM, sessionId: SID, vip: 42, gen: 3, at: 100 }).toString('utf8'))
      .toBe('["th-lan-state:v1","topic-x","memB","sess-1",100,42,3]');
  });
  it('lan-signal = [tag, topic, memberId, to, kind, data]', () => {
    expect(lanSignalCanonical(TOPIC, { memberId: MEM, to: 'memC', kind: 'offer', data: { sdp: 'x' } }).toString('utf8'))
      .toBe('["th-lan-signal:v1","topic-x","memB","memC","offer",{"sdp":"x"}]');
  });
  it('lan-reach = [tag, topic, memberId, sessionId, at, relay, reach]', () => {
    expect(lanReachCanonical(TOPIC, { memberId: MEM, sessionId: SID, at: 100, relay: true, reach: [A, B] }).toString('utf8'))
      .toBe(`["th-lan-reach:v1","topic-x","memB","sess-1",100,true,["${A}","${B}"]]`);
  });
  it('lan-reach relay flag is IN the signed bytes (willingness cannot be flipped in transit)', () => {
    const on = lanReachCanonical(TOPIC, { memberId: MEM, sessionId: SID, at: 1, relay: true, reach: [] });
    const off = lanReachCanonical(TOPIC, { memberId: MEM, sessionId: SID, at: 1, relay: false, reach: [] });
    expect(on.equals(off)).toBe(false);
  });
  it('lan-reach reach ORDER is load-bearing (why the emitter must pre-normalise)', () => {
    const sorted = lanReachCanonical(TOPIC, { memberId: MEM, sessionId: SID, at: 1, relay: true, reach: [A, B] });
    const unsorted = lanReachCanonical(TOPIC, { memberId: MEM, sessionId: SID, at: 1, relay: true, reach: [B, A] });
    // A sender emitting [B, A] signs different bytes than the receiver rebuilds
    // after clampLanReach normalises to [A, B] → its signature fails. Deliberate.
    expect(sorted.equals(unsorted)).toBe(false);
  });

  it('builders are deterministic (same input → identical bytes)', () => {
    const a = lanAdmitCanonical(SID, { by: HOST, member: MEM, at: 7 });
    const b = lanAdmitCanonical(SID, { by: HOST, member: MEM, at: 7 });
    expect(a.equals(b)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Domain separation — the five element[0] tags are mutually distinct, so no two
// builders can ever produce the same signed bytes for related inputs (a signature
// on one type can never be replayed as another).
// ─────────────────────────────────────────────────────────────────────────────
describe('domain separation', () => {
  it('the six tags are distinct', () => {
    const tags = [
      LAN_GENESIS_TAG, LAN_STATE_TAG, LAN_SIGNAL_TAG,
      LAN_ADMIT_TAG, LAN_EVICT_TAG, LAN_REACH_TAG,
    ];
    expect(new Set(tags).size).toBe(6);
  });

  it('lan-reach never collides with lan-state (same topic anchor, same id prefix)', () => {
    // Both are topic-anchored and both start [tag, topic, memberId, sessionId, at]
    // — only the domain tag keeps a lan-state signature from being replayed as a
    // lan-reach. Prove the tag is what separates them.
    const s = lanStateCanonical(TOPIC, { memberId: MEM, sessionId: SID, vip: 0, gen: 0, at: 1 }).toString('utf8');
    const r = lanReachCanonical(TOPIC, { memberId: MEM, sessionId: SID, at: 1, relay: false, reach: [] }).toString('utf8');
    expect(s).not.toBe(r);
    expect(r.startsWith(`["${LAN_REACH_TAG}"`)).toBe(true);
    expect(s.startsWith(`["${LAN_STATE_TAG}"`)).toBe(true);
  });

  it('genesis vs admit vs evict never collide even with overlapping fields', () => {
    // genesis(by) and admit(by, member) and evict(by, member) all bind sessionId.
    const g = lanGenesisCanonical(SID, { by: HOST, at: 1 }).toString('utf8');
    const a = lanAdmitCanonical(SID, { by: HOST, member: HOST, at: 1 }).toString('utf8');
    const e = lanEvictCanonical(SID, { by: HOST, member: HOST, at: 1 }).toString('utf8');
    expect(new Set([g, a, e]).size).toBe(3);
  });

  it('state and signal never collide with each other', () => {
    const s = lanStateCanonical(TOPIC, { memberId: MEM, sessionId: SID, vip: 1, gen: 0, at: 1 }).toString('utf8');
    const sig = lanSignalCanonical(TOPIC, { memberId: MEM, to: SID, kind: 'ice', data: 1 }).toString('utf8');
    expect(s).not.toBe(sig);
  });

  it('every builder output starts with its own tag', () => {
    expect(lanGenesisCanonical(SID, { by: HOST, at: 1 }).toString('utf8')).toContain(LAN_GENESIS_TAG);
    expect(lanAdmitCanonical(SID, { by: HOST, member: MEM, at: 1 }).toString('utf8')).toContain(LAN_ADMIT_TAG);
    expect(lanEvictCanonical(SID, { by: HOST, member: MEM, at: 1 }).toString('utf8')).toContain(LAN_EVICT_TAG);
    expect(lanStateCanonical(TOPIC, { memberId: MEM, sessionId: SID, vip: 1, gen: 0, at: 1 }).toString('utf8')).toContain(LAN_STATE_TAG);
    expect(lanSignalCanonical(TOPIC, { memberId: MEM, to: 'x', kind: 'ice', data: null }).toString('utf8')).toContain(LAN_SIGNAL_TAG);
    expect(lanReachCanonical(TOPIC, { memberId: MEM, sessionId: SID, at: 1, relay: true, reach: [] }).toString('utf8')).toContain(LAN_REACH_TAG);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// must-fix #7 — lan-genesis binds sessionId (the pinned trust root).
// ─────────────────────────────────────────────────────────────────────────────
describe('must-fix #7: lan-genesis binds sessionId', () => {
  it('a different sessionId yields different signed bytes', () => {
    const a = lanGenesisCanonical('sess-1', { by: HOST, at: 5 });
    const b = lanGenesisCanonical('sess-2', { by: HOST, at: 5 });
    expect(a.equals(b)).toBe(false);
  });

  it('a different host (by) yields different bytes (first-writer-wins keys on by)', () => {
    const a = lanGenesisCanonical(SID, { by: 'hostA', at: 5 });
    const b = lanGenesisCanonical(SID, { by: 'hostB', at: 5 });
    expect(a.equals(b)).toBe(false);
  });

  it('takes NO topic parameter — cannot accidentally bind a rotating topic', () => {
    expect(lanGenesisCanonical.length).toBe(2); // (sessionId, m)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// must-fix #2 — lan-admit is rekey-stable: it binds sessionId, NOT room.topic.
// A topic rotation (kick/rekey) must NOT change an admit's signed bytes, so a
// host grant survives without re-signing.
// ─────────────────────────────────────────────────────────────────────────────
describe('must-fix #2: lan-admit is rekey-stable (binds sessionId, not topic)', () => {
  it('admit signed bytes are independent of any topic', () => {
    // The builder takes no topic at all: the same (sessionId, by, member, at)
    // produces identical bytes no matter how many times the room topic rotates.
    const before = lanAdmitCanonical(SID, { by: HOST, member: MEM, at: 9 });
    const after = lanAdmitCanonical(SID, { by: HOST, member: MEM, at: 9 });
    expect(before.equals(after)).toBe(true);
    expect(lanAdmitCanonical.length).toBe(2); // (sessionId, m) — no topic param
  });

  it('a different sessionId does change the bytes (grant is scoped to its session)', () => {
    const a = lanAdmitCanonical('sess-1', { by: HOST, member: MEM, at: 9 });
    const b = lanAdmitCanonical('sess-2', { by: HOST, member: MEM, at: 9 });
    expect(a.equals(b)).toBe(false);
  });

  it('evict is likewise sessionId-bound (terminal grant is rekey-stable)', () => {
    expect(lanEvictCanonical.length).toBe(2);
    const a = lanEvictCanonical('sess-1', { by: HOST, member: MEM, at: 9 });
    const b = lanEvictCanonical('sess-2', { by: HOST, member: MEM, at: 9 });
    expect(a.equals(b)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Transient pair binds room.topic (survives rekey via re-announce, like voice).
// ─────────────────────────────────────────────────────────────────────────────
describe('transient pair binds room.topic', () => {
  it('lan-state bytes change with topic', () => {
    const a = lanStateCanonical('topic-1', { memberId: MEM, sessionId: SID, vip: 1, gen: 0, at: 1 });
    const b = lanStateCanonical('topic-2', { memberId: MEM, sessionId: SID, vip: 1, gen: 0, at: 1 });
    expect(a.equals(b)).toBe(false);
  });
  it('lan-signal bytes change with topic', () => {
    const a = lanSignalCanonical('topic-1', { memberId: MEM, to: 'x', kind: 'offer', data: null });
    const b = lanSignalCanonical('topic-2', { memberId: MEM, to: 'x', kind: 'offer', data: null });
    expect(a.equals(b)).toBe(false);
  });
  it('lan-state still binds sessionId inside the canonical (vIP claim scope)', () => {
    const a = lanStateCanonical(TOPIC, { memberId: MEM, sessionId: 'sess-1', vip: 1, gen: 0, at: 1 });
    const b = lanStateCanonical(TOPIC, { memberId: MEM, sessionId: 'sess-2', vip: 1, gen: 0, at: 1 });
    expect(a.equals(b)).toBe(false);
  });

  // ── Phase 2B: lan-reach joins the transient trio. It is PRESENCE class (it
  //    grants nothing — admission still comes only from a host-signed lan-admit),
  //    so it takes the topic anchor and survives rekey by re-announcing.
  it('lan-reach bytes change with topic (transient anchor, not sessionId)', () => {
    const a = lanReachCanonical('topic-1', { memberId: MEM, sessionId: SID, at: 1, relay: true, reach: [A] });
    const b = lanReachCanonical('topic-2', { memberId: MEM, sessionId: SID, at: 1, relay: true, reach: [A] });
    expect(a.equals(b)).toBe(false);
  });

  it('lan-reach still binds sessionId INSIDE the canonical (no cross-session advert)', () => {
    const a = lanReachCanonical(TOPIC, { memberId: MEM, sessionId: 'sess-1', at: 1, relay: true, reach: [A] });
    const b = lanReachCanonical(TOPIC, { memberId: MEM, sessionId: 'sess-2', at: 1, relay: true, reach: [A] });
    expect(a.equals(b)).toBe(false);
  });

  it('lan-reach takes a topic parameter (it is NOT in the durable sessionId class)', () => {
    expect(lanReachCanonical.length).toBe(2); // (topic, m) — same shape as lan-state
    // and unlike admit/evict, the first arg really is the rotating anchor:
    const t1 = lanReachCanonical('t1', { memberId: MEM, sessionId: SID, at: 1, relay: false, reach: [] });
    const t2 = lanReachCanonical('t2', { memberId: MEM, sessionId: SID, at: 1, relay: false, reach: [] });
    expect(t1.equals(t2)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Field clamps.
// ─────────────────────────────────────────────────────────────────────────────
describe('field clamps', () => {
  it('clampLanStr truncates and rejects non-strings', () => {
    expect(clampLanStr('abcdef', 3)).toBe('abc');
    expect(clampLanStr(123 as any)).toBe('');
    expect(clampLanStr(undefined)).toBe('');
    expect(clampLanStr('x'.repeat(MAX_LAN_STR + 10)).length).toBe(MAX_LAN_STR);
  });

  it('clampVip coerces to uint32', () => {
    expect(clampVip(0x64410001)).toBe(0x64410001);
    expect(clampVip(-1)).toBe(0xffffffff);
    expect(clampVip('nope')).toBe(0);
    expect(clampVip(NaN)).toBe(0);
    expect(clampVip(4.9)).toBe(4); // >>> truncates toward zero
  });

  it('clampGen bounds to [0, 0xffff] and rounds', () => {
    expect(clampGen(3)).toBe(3);
    expect(clampGen(-5)).toBe(0);
    expect(clampGen(999999)).toBe(GEN_MAX);
    expect(clampGen(2.6)).toBe(3);
    expect(clampGen('bad')).toBe(0);
    expect(clampGen(Infinity)).toBe(0);
  });

  it('clampLanState mutates fields in place', () => {
    const msg: any = { t: 'lan-state', memberId: MEM, sessionId: SID, vip: -1, gen: 1e9, pub: 'p', sig: 's' };
    const out = clampLanState(msg);
    expect(out).toBe(msg); // same object (in-place)
    expect(msg.vip).toBe(0xffffffff);
    expect(msg.gen).toBe(GEN_MAX);
  });

  it('clampLanSignal leaves data raw but clamps kind to 16 chars', () => {
    const data = { sdp: 'blob' };
    const msg: any = { t: 'lan-signal', memberId: MEM, to: 'x', kind: 'x'.repeat(50), data, pub: 'p', sig: 's' };
    clampLanSignal(msg);
    expect(msg.kind.length).toBe(16);
    expect(msg.data).toBe(data); // untouched reference
  });

  it('the authority clampers coerce non-object input without throwing', () => {
    expect(() => clampLanGenesis(null)).not.toThrow();
    expect(() => clampLanAdmit(undefined)).not.toThrow();
    expect(() => clampLanEvict(42 as any)).not.toThrow();
    expect(clampLanGenesis(null)).toBe(null);
  });

  it('clampLanAdmit/Evict clamp member + by', () => {
    const a: any = { member: 'y'.repeat(2000), by: 'z'.repeat(2000), sessionId: 's' };
    clampLanAdmit(a);
    expect(a.member.length).toBe(MAX_LAN_STR);
    expect(a.by.length).toBe(MAX_LAN_STR);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2B — lan-reach: the NORMALISING clamp. Unlike the other clamps this one
// rewrites `reach` and forces `relay` to a real boolean, so that exactly one wire
// representation of an advert can ever verify.
// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeReachList', () => {
  it('sorts ascending', () => {
    expect(normalizeReachList([C, A, B])).toEqual([A, B, C]);
  });

  it('dedupes', () => {
    expect(normalizeReachList([B, A, B, A, B])).toEqual([A, B]);
  });

  it('drops anything that is not a 32-lowercase-hex memberId', () => {
    expect(normalizeReachList([
      A,
      'memB',                 // too short / not hex
      A.toUpperCase(),        // uppercase hex is NOT a memberId
      'g'.repeat(32),         // not hex
      'a'.repeat(31),         // one char short
      'a'.repeat(33),         // one char long
      '',
      null, undefined, 42, {}, [], { toString: () => A },
    ])).toEqual([A]);
  });

  it('caps at MAX_LAN_REACH, keeping the lowest ids (deterministic truncation)', () => {
    const many = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(32, '0'));
    const out = normalizeReachList([...many].reverse());
    expect(out.length).toBe(MAX_LAN_REACH);
    expect(out).toEqual(many.slice(0, MAX_LAN_REACH));
  });

  it('is TOTAL: non-arrays and hostile input reduce to [] without throwing', () => {
    expect(normalizeReachList(undefined)).toEqual([]);
    expect(normalizeReachList(null)).toEqual([]);
    expect(normalizeReachList('abc')).toEqual([]);
    expect(normalizeReachList(42)).toEqual([]);
    expect(normalizeReachList({ 0: A, length: 1 })).toEqual([]); // array-LIKE is not an array
    expect(() => normalizeReachList([[A], [[B]]])).not.toThrow();
    expect(normalizeReachList([[A]])).toEqual([]);
  });

  it('bounds the WORK, not just the result (a huge array costs O(MAX_REACH_SCAN))', () => {
    const huge = new Array(50_000).fill('nope');
    huge[MAX_REACH_SCAN + 10] = A; // past the scan window → never seen
    expect(normalizeReachList(huge)).toEqual([]);
  });

  it('is IDEMPOTENT — the emitter and the receiver-side clamp agree exactly', () => {
    // MANDATORY invariant: the sender signs normalize(x); the receiver clamps the
    // arriving array with the same function and re-canonicalises. If these ever
    // disagreed every advert would fail verify and relaying would silently die.
    for (const input of [[C, A, B], [B, B, A], [A], [], [C, 'junk', A, A]]) {
      const once = normalizeReachList(input);
      expect(normalizeReachList(once)).toEqual(once);
      expect(isNormalizedReach(once)).toBe(true);
    }
  });

  it('isLanMemberId is shape-only and rejects uppercase', () => {
    expect(isLanMemberId(A)).toBe(true);
    expect(isLanMemberId(A.toUpperCase())).toBe(false);
    expect(isLanMemberId('memB')).toBe(false);
    expect(isLanMemberId(null)).toBe(false);
  });
});

describe('clampLanReach', () => {
  it('mutates in place and normalises reach', () => {
    const msg: any = {
      t: 'lan-reach', memberId: MEM, sessionId: SID, at: 5,
      relay: true, reach: [C, A, B, A, 'junk'], ...creds,
    };
    const out = clampLanReach(msg);
    expect(out).toBe(msg); // same object (in-place, like the other clampers)
    expect(msg.reach).toEqual([A, B, C]);
  });

  it('forces relay to a REAL boolean (a truthy string must not pass as true)', () => {
    const t = (relay: unknown) => { const m: any = { relay }; clampLanReach(m); return m.relay; };
    expect(t(true)).toBe(true);
    expect(t(false)).toBe(false);
    expect(t('true')).toBe(false);  // would otherwise break the signature silently
    expect(t(1)).toBe(false);
    expect(t(undefined)).toBe(false);
    expect(t({})).toBe(false);
  });

  it('truncates an oversized reach (a member cannot hold more legs than the cap)', () => {
    const msg: any = { reach: Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(32, '0')) };
    clampLanReach(msg);
    expect(msg.reach.length).toBe(MAX_LAN_REACH);
  });

  it('leaves `at` raw (the handler owns the future-cutoff + its OWN floor)', () => {
    const msg: any = { at: 1e15, relay: true, reach: [] };
    clampLanReach(msg);
    expect(msg.at).toBe(1e15);
  });

  it('coerces non-object input without throwing', () => {
    expect(() => clampLanReach(null)).not.toThrow();
    expect(() => clampLanReach(undefined)).not.toThrow();
    expect(clampLanReach(null)).toBe(null);
    expect(clampLanReach(7 as any)).toBe(7);
  });

  it('clamps the id/cred strings like every other arm', () => {
    const msg: any = { memberId: 'm'.repeat(4000), sessionId: 's'.repeat(4000), pub: 'p'.repeat(5000), sig: 'g'.repeat(5000) };
    clampLanReach(msg);
    expect(msg.memberId.length).toBe(MAX_LAN_STR);
    expect(msg.sessionId.length).toBe(MAX_LAN_STR);
    expect(msg.pub.length).toBe(MAX_LAN_STR * 2);
    expect(msg.sig.length).toBe(MAX_LAN_STR * 2);
  });

  it('a clamped message always satisfies isValidLanReach when the ids survive', () => {
    const msg: any = {
      t: 'lan-reach', memberId: MEM, sessionId: SID, at: 3,
      relay: 'yes', reach: [B, A, B, 'junk'], ...creds,
    };
    clampLanReach(msg);
    expect(isValidLanReach(msg)).toBe(true);
    expect(msg.relay).toBe(false); // ...but the willingness bit is now false, so
    expect(msg.reach).toEqual([A, B]); //  the sender's signature will not verify
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shape / bounds validators.
// ─────────────────────────────────────────────────────────────────────────────
describe('validators', () => {
  it('isValidLanGenesis', () => {
    expect(isValidLanGenesis({ t: 'lan-genesis', sessionId: SID, by: HOST, at: 1, ...creds })).toBe(true);
    expect(isValidLanGenesis({ t: 'lan-genesis', sessionId: '', by: HOST, at: 1, ...creds })).toBe(false); // empty sid
    expect(isValidLanGenesis({ t: 'lan-genesis', sessionId: SID, by: HOST, at: 'x', ...creds })).toBe(false); // at not number
    expect(isValidLanGenesis({ t: 'lan-admit', sessionId: SID, by: HOST, at: 1, ...creds })).toBe(false); // wrong t
    expect(isValidLanGenesis({ t: 'lan-genesis', sessionId: SID, by: HOST, at: 1 })).toBe(false); // no creds
    expect(isValidLanGenesis(null)).toBe(false);
  });

  it('isValidLanAdmit / isValidLanEvict require member', () => {
    const base = { sessionId: SID, by: HOST, member: MEM, at: 1, ...creds };
    expect(isValidLanAdmit({ t: 'lan-admit', ...base })).toBe(true);
    expect(isValidLanEvict({ t: 'lan-evict', ...base })).toBe(true);
    expect(isValidLanAdmit({ t: 'lan-admit', ...base, member: '' })).toBe(false);
    expect(isValidLanEvict({ t: 'lan-evict', ...base, at: NaN })).toBe(false);
  });

  it('isValidLanState checks uint32 vip + gen range', () => {
    const base = { t: 'lan-state', memberId: MEM, sessionId: SID, vip: 42, gen: 0, at: 1, ...creds };
    expect(isValidLanState(base)).toBe(true);
    expect(isValidLanState({ ...base, vip: 1.5 })).toBe(false); // not a uint32
    expect(isValidLanState({ ...base, vip: -1 })).toBe(false);  // not a uint32
    expect(isValidLanState({ ...base, gen: GEN_MAX + 1 })).toBe(false);
    expect(isValidLanState({ ...base, gen: -1 })).toBe(false);
    expect(isValidLanState({ ...base, memberId: '' })).toBe(false);
  });

  it('isValidLanState accepts a clamped high vip (post-clamp uint32)', () => {
    const msg: any = { t: 'lan-state', memberId: MEM, sessionId: SID, vip: -1, gen: 0, at: 1, ...creds };
    clampLanState(msg);
    expect(isValidLanState(msg)).toBe(true); // vip is now 0xffffffff, a valid uint32
  });

  it('isValidLanSignal restricts kind and needs data but NOT at', () => {
    const base = { t: 'lan-signal', memberId: MEM, to: 'x', kind: 'offer', data: { sdp: 'y' }, ...creds };
    expect(isValidLanSignal(base)).toBe(true);
    expect(isValidLanSignal({ ...base, at: undefined })).toBe(true); // at is irrelevant
    expect(isValidLanSignal({ ...base, kind: 'renegotiate' })).toBe(false);
    expect(isValidLanSignal({ ...base, data: undefined })).toBe(false);
    expect(isValidLanSignal({ ...base, to: '' })).toBe(false);
    expect(isValidLanSignal({ ...base, data: null })).toBe(true); // null is a valid (present) blob
  });

  it('isLanSignalKind narrows exactly the three kinds', () => {
    expect(isLanSignalKind('offer')).toBe(true);
    expect(isLanSignalKind('answer')).toBe(true);
    expect(isLanSignalKind('ice')).toBe(true);
    expect(isLanSignalKind('candidate')).toBe(false);
    expect(isLanSignalKind(0)).toBe(false);
  });

  // ── Phase 2B ───────────────────────────────────────────────────────────────
  it('isNormalizedReach demands strictly-ascending 32-hex within the cap', () => {
    expect(isNormalizedReach([])).toBe(true);
    expect(isNormalizedReach([A, B, C])).toBe(true);
    expect(isNormalizedReach([B, A])).toBe(false);       // unsorted
    expect(isNormalizedReach([A, A])).toBe(false);       // duplicate
    expect(isNormalizedReach([A, 'junk'])).toBe(false);  // not a memberId
    expect(isNormalizedReach([A.toUpperCase()])).toBe(false);
    expect(isNormalizedReach('nope')).toBe(false);
    expect(isNormalizedReach(null)).toBe(false);
    expect(isNormalizedReach(
      Array.from({ length: MAX_LAN_REACH + 1 }, (_, i) => i.toString(16).padStart(32, '0')),
    )).toBe(false); // over the cap even though sorted + deduped
  });

  it('isValidLanReach requires t / ids / finite at / real boolean relay / creds', () => {
    const base = { t: 'lan-reach', memberId: MEM, sessionId: SID, at: 1, relay: true, reach: [A, B], ...creds };
    expect(isValidLanReach(base)).toBe(true);
    expect(isValidLanReach({ ...base, relay: false })).toBe(true);
    expect(isValidLanReach({ ...base, reach: [] })).toBe(true);

    expect(isValidLanReach({ ...base, t: 'lan-state' })).toBe(false); // wrong t
    expect(isValidLanReach({ ...base, memberId: '' })).toBe(false);
    expect(isValidLanReach({ ...base, sessionId: '' })).toBe(false);  // must name a session
    expect(isValidLanReach({ ...base, at: undefined })).toBe(false);  // unlike lan-signal, `at` is REQUIRED
    expect(isValidLanReach({ ...base, at: NaN })).toBe(false);
    expect(isValidLanReach({ ...base, relay: 'true' })).toBe(false);  // strict boolean
    expect(isValidLanReach({ ...base, relay: 1 })).toBe(false);
    expect(isValidLanReach({ ...base, reach: undefined })).toBe(false);
    expect(isValidLanReach({ ...base, reach: [B, A] })).toBe(false);  // non-canonical order
    expect(isValidLanReach({ ...base, pub: '', sig: '' })).toBe(false);
    expect(isValidLanReach(null)).toBe(false);
    expect(isValidLanReach('lan-reach')).toBe(false);
  });

  it('isValidLanReach rejects an advert claiming more legs than the mesh allows', () => {
    const tooMany = Array.from({ length: MAX_LAN_REACH + 1 }, (_, i) => i.toString(16).padStart(32, '0'));
    const msg: any = { t: 'lan-reach', memberId: MEM, sessionId: SID, at: 1, relay: true, reach: tooMany, ...creds };
    expect(isValidLanReach(msg)).toBe(false);
    // ...and the clamp truncates rather than throwing, which then breaks the
    // liar's signature at verify instead of letting an inflated set through.
    clampLanReach(msg);
    expect(msg.reach.length).toBe(MAX_LAN_REACH);
    expect(isValidLanReach(msg)).toBe(true);
  });
});
