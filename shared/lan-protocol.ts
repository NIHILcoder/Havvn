/**
 * Domain-tagged canonical builders + field clamps + shape/bounds validators for
 * the six signed Havvn virtual-LAN gossip types (plan §0.1, Phase 1 + 2B):
 *
 *   DURABLE authority triple — bound to sessionId (rekey-stable anchor; never
 *   re-signed on a topic rotation, so a host grant survives a kick — must-fix #2):
 *     lan-genesis  (pins the session host, first-writer-wins — must-fix #7)
 *     lan-admit    (host grant that populates the admittedSet — must-fix #1)
 *     lan-evict    (terminal host revocation)
 *
 *   TRANSIENT trio — bound to room.topic exactly like voice-state / voice-signal
 *   (survives rekey via re-announce on hello, NOT by re-signing):
 *     lan-state    (presence + vIP CLAIM — verified via lan-ip.verifyVipClaim)
 *     lan-signal   (offer / answer / ice for the LanPeer mesh; no anti-replay)
 *     lan-reach    (Phase 2B: connected-leg set + relay willingness — presence
 *                   class, grants nothing; the ONLY input the one-hop peer-relay
 *                   selector needs)
 *
 * Pure + dependency-free (Buffer plus the sibling type/const module lan-types,
 * zero electron / node:crypto imports) so node vitest imports it unchanged and no
 * browser global enters import-time — same contract as shared/lan-frame.ts,
 * shared/lan-ip.ts, shared/lan-packet.ts.
 * Mirrors the voiceStateCanonical / voiceSignalCanonical style in room-engine.ts.
 *
 * FROZEN-AT-v1 INVARIANT: the field ORDER inside every canonical below is frozen.
 * NEVER append a field to an existing tag — that silently breaks older peers'
 * signatures (the `deafened` / `prevSecrets` lesson). A v2 field rides a NEW tag
 * or travels OUTSIDE the signed canonical. The element[0] domain tags are also
 * mutually distinct so no two builders can ever collide on the same bytes.
 */
import { MAX_LAN_REACH } from './lan-types';

// ── Domain tags (element[0]) — FROZEN. Mutually distinct = domain separation. ──
export const LAN_GENESIS_TAG = 'th-lan-genesis:v1';
export const LAN_STATE_TAG = 'th-lan-state:v1';
export const LAN_SIGNAL_TAG = 'th-lan-signal:v1';
export const LAN_ADMIT_TAG = 'th-lan-admit:v1';
export const LAN_EVICT_TAG = 'th-lan-evict:v1';
/** Phase 2B reachability advert. Distinct from all five above (domain separation:
 *  a lan-state signature can never be replayed as a lan-reach and vice versa). */
export const LAN_REACH_TAG = 'th-lan-reach:v1';

export { MAX_LAN_REACH };

/** The offer/answer/ice kinds a lan-signal may carry. */
export const LAN_SIGNAL_KINDS = ['offer', 'answer', 'ice'] as const;
export type LanSignalKind = (typeof LAN_SIGNAL_KINDS)[number];

/** Field bounds — mirror room-engine's MAX_STR so a clamped copy stays inside the
 *  receiver-side gossip clamps and an out-of-range field simply breaks the
 *  sender's signature and dies at verify. */
export const MAX_LAN_STR = 1024; // ids, session ids, member ids, pub/sig
export const MAX_LAN_KIND = 16;  // 'offer' | 'answer' | 'ice'
export const GEN_MAX = 0xffff;   // 16 host bits — arbitration generation ceiling
export const VIP_MAX = 0xffffffff;

/** A memberId is exactly sha256(pub).digest('hex').slice(0, 32) — 32 LOWERCASE
 *  hex chars (electron/sharing/room-crypto.ts:123). Only ids of this exact shape
 *  may enter a lan-reach `reach` list: anything else can never name a real member,
 *  so admitting it would only be a way to inflate the array past its cap. */
const MEMBER_ID_RE = /^[0-9a-f]{32}$/;

/** How many elements of a peer-supplied `reach` array normalizeReachList will
 *  even look at. Well above MAX_LAN_REACH so an honest advert is never cut, low
 *  enough that a hostile array cannot buy CPU. */
export const MAX_REACH_SCAN = 256;

/** Is `v` a syntactically well-formed memberId (32 lowercase hex)? Shape only —
 *  says nothing about admission, existence, or the ban-gate. */
export function isLanMemberId(v: unknown): v is string {
  return typeof v === 'string' && MEMBER_ID_RE.test(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical builders — Buffer(JSON([tag, anchor, ...ordered fields])).
// element[1] is the BINDING anchor: sessionId for the durable authority triple,
// room.topic for the transient pair.
// ─────────────────────────────────────────────────────────────────────────────

/** DURABLE — bound to sessionId (must-fix #7). Bytes the host signs to pin the
 *  session genesis / trust root. `by` becomes the pinned hostId. */
export function lanGenesisCanonical(sessionId: string, m: { by: string; at: number }): Buffer {
  return Buffer.from(JSON.stringify([LAN_GENESIS_TAG, sessionId, m.by, m.at]), 'utf8');
}

/** DURABLE — bound to sessionId (rekey-stable authority; must-fix #2). Bytes the
 *  host signs to admit `member` into the session. */
export function lanAdmitCanonical(sessionId: string, m: { by: string; member: string; at: number }): Buffer {
  return Buffer.from(JSON.stringify([LAN_ADMIT_TAG, sessionId, m.by, m.member, m.at]), 'utf8');
}

/** DURABLE — bound to sessionId. Bytes the host signs to terminally evict
 *  `member` from the session. */
export function lanEvictCanonical(sessionId: string, m: { by: string; member: string; at: number }): Buffer {
  return Buffer.from(JSON.stringify([LAN_EVICT_TAG, sessionId, m.by, m.member, m.at]), 'utf8');
}

/** TRANSIENT — bound to topic (survives rekey via re-announce, like voice-state).
 *  Bytes a member signs over their presence + vIP claim. The vip is a CLAIM,
 *  re-derived on receipt via lan-ip.verifyVipClaim(sessionId, memberId, gen, vip). */
export function lanStateCanonical(
  topic: string,
  m: { memberId: string; sessionId: string; vip: number; gen: number; at: number },
): Buffer {
  return Buffer.from(
    JSON.stringify([LAN_STATE_TAG, topic, m.memberId, m.sessionId, m.at, m.vip, m.gen]),
    'utf8',
  );
}

/** TRANSIENT — bound to topic (like voice-signal). Bytes a member signs over one
 *  WebRTC signaling blob addressed to `to`. Carries NO `at` — perfect-negotiation
 *  + DTLS make a replayed offer/answer/ice inert, exactly like voice-signal. */
export function lanSignalCanonical(
  topic: string,
  m: { memberId: string; to: string; kind: string; data: unknown },
): Buffer {
  return Buffer.from(
    JSON.stringify([LAN_SIGNAL_TAG, topic, m.memberId, m.to, m.kind, m.data]),
    'utf8',
  );
}

/**
 * TRANSIENT — bound to topic (Phase 2B). Bytes a member signs over "the admitted
 * members I currently hold a connected direct leg to, plus whether I am willing
 * to forward for others". `sessionId` rides INSIDE the canonical so a cross-
 * session advert cannot be replayed into another session's relay selection, while
 * the topic anchor keeps this in the presence class (it grants nothing, so it
 * needs no rekey-stable anchor and survives a rekey by re-announcing).
 *
 * FROZEN AT v1 — field order [tag, topic, memberId, sessionId, at, relay, reach].
 *
 * `m.reach` MUST already be in canonical form (ascending, deduped, 32-lowercase-
 * hex, ≤ MAX_LAN_REACH) — run it through normalizeReachList BEFORE signing. The
 * receiver's clampLanReach normalises, so any other representation yields bytes
 * the verifier cannot reproduce and the signature fails. That is deliberate: one
 * representation on the wire means no signature malleability and no duplicate
 * gossip ids for what is semantically the same advert.
 */
export function lanReachCanonical(
  topic: string,
  m: { memberId: string; sessionId: string; at: number; relay: boolean; reach: readonly string[] },
): Buffer {
  return Buffer.from(
    JSON.stringify([LAN_REACH_TAG, topic, m.memberId, m.sessionId, m.at, m.relay, m.reach]),
    'utf8',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Field clamps — the primitives room-engine's clampGossip calls IN-PLACE (the
// clamp bounds the RELAYED copy too — anti-DoS, not hygiene). Out-of-range fields
// simply break the sender's signature and die at verify.
// ─────────────────────────────────────────────────────────────────────────────

/** Truncate to a string of at most n chars; non-strings → ''. Mirrors clampStr. */
export function clampLanStr(v: unknown, n: number = MAX_LAN_STR): string {
  return typeof v === 'string' ? v.slice(0, n) : '';
}

/** Coerce any peer-supplied value to a uint32 vIP. NaN / non-number → 0. */
export function clampVip(v: unknown): number {
  return (Number(v) || 0) >>> 0;
}

/**
 * Reduce any peer-supplied value to THE canonical reach list: keep only
 * well-formed memberIds (32 lowercase hex), dedupe, sort ascending, then cap at
 * MAX_LAN_REACH. Total and never throws — a non-array, a nested array, a
 * getter-bomb-free hostile blob all reduce to [].
 *
 * NORMALISING BY DESIGN: this rewrites the array rather than merely bounding it,
 * so a sender that emitted a different order / duplicates / junk entries produces
 * bytes the verifier will not reproduce and its signature dies at verify. One
 * wire representation, no malleability. The EMITTER must therefore call this too,
 * before signing — normalize(normalize(x)) === normalize(x), asserted in the test.
 *
 * The cap is applied LAST, after the sort, so truncation is deterministic (the
 * numerically lowest ids survive) rather than dependent on arrival order.
 */
export function normalizeReachList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  // Bound the WORK before bounding the result: only the first MAX_REACH_SCAN
  // elements are ever examined, so a hostile million-element array costs O(256)
  // rather than O(n) on a RELAYABLE (fan-out) message. This can never cost an
  // honest advert a signature — an advert big enough to reach the scan window
  // already exceeds MAX_LAN_REACH, so its signed bytes could not be reproduced
  // from the clamped copy either way. The cut is still a pure function of the
  // input, so sender and receiver never disagree on a well-formed advert.
  const scan = v.length > MAX_REACH_SCAN ? v.slice(0, MAX_REACH_SCAN) : v;
  const seen = new Set<string>();
  for (const e of scan) if (isLanMemberId(e)) seen.add(e);
  const out = Array.from(seen).sort();
  return out.length > MAX_LAN_REACH ? out.slice(0, MAX_LAN_REACH) : out;
}

/** Coerce a collision-arbitration generation into [0, GEN_MAX]. Non-finite → 0. */
export function clampGen(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(GEN_MAX, Math.max(0, Math.round(n)));
}

/**
 * In-place field clamps for each arm, matching the clampGossip contract. Each
 * mutates and returns `msg`. `at` and lan-signal.data are deliberately left raw:
 * the handler enforces the future-cutoff on `at`, and `data` is the structured
 * SDP/ICE blob bounded by the pre-decrypt MAX_FRAME_CHARS. `by`/`memberId`/`to`/
 * `pub`/`sig` are clamped here too (they are clamped generically upstream, but
 * clamping them again is idempotent and keeps each arm self-contained/testable).
 */
export function clampLanGenesis(msg: any): any {
  if (!msg || typeof msg !== 'object') return msg;
  msg.sessionId = clampLanStr(msg.sessionId);
  msg.by = clampLanStr(msg.by);
  msg.pub = clampLanStr(msg.pub, MAX_LAN_STR * 2);
  msg.sig = clampLanStr(msg.sig, MAX_LAN_STR * 2);
  return msg;
}

export function clampLanAdmit(msg: any): any {
  if (!msg || typeof msg !== 'object') return msg;
  msg.sessionId = clampLanStr(msg.sessionId);
  msg.by = clampLanStr(msg.by);
  msg.member = clampLanStr(msg.member);
  msg.pub = clampLanStr(msg.pub, MAX_LAN_STR * 2);
  msg.sig = clampLanStr(msg.sig, MAX_LAN_STR * 2);
  return msg;
}

export function clampLanEvict(msg: any): any {
  if (!msg || typeof msg !== 'object') return msg;
  msg.sessionId = clampLanStr(msg.sessionId);
  msg.by = clampLanStr(msg.by);
  msg.member = clampLanStr(msg.member);
  msg.pub = clampLanStr(msg.pub, MAX_LAN_STR * 2);
  msg.sig = clampLanStr(msg.sig, MAX_LAN_STR * 2);
  return msg;
}

export function clampLanState(msg: any): any {
  if (!msg || typeof msg !== 'object') return msg;
  msg.memberId = clampLanStr(msg.memberId);
  msg.sessionId = clampLanStr(msg.sessionId);
  msg.vip = clampVip(msg.vip);
  msg.gen = clampGen(msg.gen);
  msg.pub = clampLanStr(msg.pub, MAX_LAN_STR * 2);
  msg.sig = clampLanStr(msg.sig, MAX_LAN_STR * 2);
  return msg;
}

export function clampLanSignal(msg: any): any {
  if (!msg || typeof msg !== 'object') return msg;
  msg.memberId = clampLanStr(msg.memberId);
  msg.to = clampLanStr(msg.to);
  msg.kind = clampLanStr(msg.kind, MAX_LAN_KIND);
  msg.pub = clampLanStr(msg.pub, MAX_LAN_STR * 2);
  msg.sig = clampLanStr(msg.sig, MAX_LAN_STR * 2);
  // msg.data left raw (structured SDP/ICE, bounded by MAX_FRAME_CHARS upstream).
  return msg;
}

/**
 * Phase 2B. NOTE this is a NORMALISING clamp, not just a bounding one: `reach` is
 * rewritten to its canonical form and `relay` is forced to a REAL boolean
 * (`=== true`, so a `"true"` string becomes false). Both rewrites are deliberate
 * — a sender whose bytes differ from what we re-canonicalise simply fails verify,
 * which is how we get exactly one wire representation per advert.
 *
 * ⚠ FIELD-NAME COLLISION NOTE: room-engine's clampGossip applies some clamps by
 * FIELD NAME across every message arm. `relay` and `reach` are collision-free
 * across the current arms — if a future message type reuses either name it will
 * silently inherit (or lose) this reshaping. Keep this dispatch arm-scoped.
 */
export function clampLanReach(msg: any): any {
  if (!msg || typeof msg !== 'object') return msg;
  msg.memberId = clampLanStr(msg.memberId);
  msg.sessionId = clampLanStr(msg.sessionId);
  msg.relay = msg.relay === true;
  msg.reach = normalizeReachList(msg.reach);
  msg.pub = clampLanStr(msg.pub, MAX_LAN_STR * 2);
  msg.sig = clampLanStr(msg.sig, MAX_LAN_STR * 2);
  // msg.at left raw — the handler enforces the future-cutoff and the OWN
  // per-member monotonic floor (never shared with lastLanStateAt).
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape / bounds validators — cheap structural gates for the onMessage boundary,
// run BEFORE the (expensive) signature verify to reject malformed frames early.
// They check presence + primitive type + range only; they do NOT verify the
// signature, the vIP derivation, the pinned host, or anti-replay floors — those
// are the handler's job (verifySignedBy / verifyVipClaim / per-type at-floor).
// ─────────────────────────────────────────────────────────────────────────────

function isNonEmptyStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
/** Fields every signed arm carries: a memberId-hash-committing pub + a sig. */
function hasCreds(m: any): boolean {
  return isNonEmptyStr(m.pub) && isNonEmptyStr(m.sig);
}

export function isValidLanGenesis(m: any): boolean {
  return (
    !!m && typeof m === 'object' &&
    m.t === 'lan-genesis' &&
    isNonEmptyStr(m.sessionId) &&
    isNonEmptyStr(m.by) &&
    isFiniteNum(m.at) &&
    hasCreds(m)
  );
}

export function isValidLanAdmit(m: any): boolean {
  return (
    !!m && typeof m === 'object' &&
    m.t === 'lan-admit' &&
    isNonEmptyStr(m.sessionId) &&
    isNonEmptyStr(m.by) &&
    isNonEmptyStr(m.member) &&
    isFiniteNum(m.at) &&
    hasCreds(m)
  );
}

export function isValidLanEvict(m: any): boolean {
  return (
    !!m && typeof m === 'object' &&
    m.t === 'lan-evict' &&
    isNonEmptyStr(m.sessionId) &&
    isNonEmptyStr(m.by) &&
    isNonEmptyStr(m.member) &&
    isFiniteNum(m.at) &&
    hasCreds(m)
  );
}

export function isValidLanState(m: any): boolean {
  return (
    !!m && typeof m === 'object' &&
    m.t === 'lan-state' &&
    isNonEmptyStr(m.memberId) &&
    isNonEmptyStr(m.sessionId) &&
    isFiniteNum(m.vip) && (m.vip >>> 0) === m.vip && // already a uint32 (post-clamp)
    isFiniteNum(m.gen) && m.gen >= 0 && m.gen <= GEN_MAX &&
    isFiniteNum(m.at) &&
    hasCreds(m)
  );
}

/** Narrowing helper: is `k` one of the three signaling kinds. */
export function isLanSignalKind(k: unknown): k is LanSignalKind {
  return k === 'offer' || k === 'answer' || k === 'ice';
}

export function isValidLanSignal(m: any): boolean {
  return (
    !!m && typeof m === 'object' &&
    m.t === 'lan-signal' &&
    isNonEmptyStr(m.memberId) &&
    isNonEmptyStr(m.to) &&
    isLanSignalKind(m.kind) &&
    m.data !== undefined &&
    hasCreds(m)
    // NOTE: intentionally NO `at` — lan-signal is transient (like voice-signal).
  );
}

/** Is `reach` already in THE canonical form the wire allows: strictly ascending
 *  (⇒ deduped) 32-lowercase-hex ids, at most MAX_LAN_REACH of them? Equivalent to
 *  `normalizeReachList(reach)` deep-equalling `reach`, but without allocating. */
export function isNormalizedReach(reach: unknown): reach is string[] {
  if (!Array.isArray(reach) || reach.length > MAX_LAN_REACH) return false;
  let prev = '';
  for (const e of reach) {
    if (!isLanMemberId(e)) return false;
    if (e <= prev) return false; // strictly ascending ⇒ sorted AND deduped
    prev = e;
  }
  return true;
}

/**
 * Phase 2B shape gate. Deliberately STRICTER than the other validators: it also
 * demands the wire-canonical `reach` form, because clampLanReach normalises and
 * a non-canonical advert therefore could not have verified anyway — rejecting it
 * here just stops it before the expensive signature check. `relay` must be a real
 * boolean (post-clamp it always is); `at` is required (unlike lan-signal) because
 * lan-reach carries its own monotonic anti-replay floor.
 */
export function isValidLanReach(m: any): boolean {
  return (
    !!m && typeof m === 'object' &&
    m.t === 'lan-reach' &&
    isNonEmptyStr(m.memberId) &&
    isNonEmptyStr(m.sessionId) &&
    isFiniteNum(m.at) &&
    typeof m.relay === 'boolean' &&
    isNormalizedReach(m.reach) &&
    hasCreds(m)
  );
}
