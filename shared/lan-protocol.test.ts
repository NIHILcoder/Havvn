import { describe, it, expect } from 'vitest';
import {
  lanGenesisCanonical, lanAdmitCanonical, lanEvictCanonical,
  lanStateCanonical, lanSignalCanonical,
  clampLanStr, clampVip, clampGen,
  clampLanGenesis, clampLanAdmit, clampLanEvict, clampLanState, clampLanSignal,
  isValidLanGenesis, isValidLanAdmit, isValidLanEvict, isValidLanState, isValidLanSignal,
  isLanSignalKind,
  GEN_MAX, MAX_LAN_STR,
  LAN_GENESIS_TAG, LAN_STATE_TAG, LAN_SIGNAL_TAG, LAN_ADMIT_TAG, LAN_EVICT_TAG,
} from './lan-protocol';

const SID = 'sess-1';
const TOPIC = 'topic-x';
const HOST = 'hostA';
const MEM = 'memB';

const creds = { pub: 'PUBKEYPEM', sig: 'SIGBYTES' };

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
  it('the five tags are distinct', () => {
    const tags = [LAN_GENESIS_TAG, LAN_STATE_TAG, LAN_SIGNAL_TAG, LAN_ADMIT_TAG, LAN_EVICT_TAG];
    expect(new Set(tags).size).toBe(5);
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
});
