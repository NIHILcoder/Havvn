/**
 * Domain-tagged canonical builders + field clamps + shape/bounds validators for
 * the five signed Havvn virtual-LAN gossip types (plan §0.1, Phase 1):
 *
 *   DURABLE authority triple — bound to sessionId (rekey-stable anchor; never
 *   re-signed on a topic rotation, so a host grant survives a kick — must-fix #2):
 *     lan-genesis  (pins the session host, first-writer-wins — must-fix #7)
 *     lan-admit    (host grant that populates the admittedSet — must-fix #1)
 *     lan-evict    (terminal host revocation)
 *
 *   TRANSIENT pair — bound to room.topic exactly like voice-state / voice-signal
 *   (survives rekey via re-announce on hello, NOT by re-signing):
 *     lan-state    (presence + vIP CLAIM — verified via lan-ip.verifyVipClaim)
 *     lan-signal   (offer / answer / ice for the LanPeer mesh; no anti-replay)
 *
 * Pure + dependency-free (Buffer only, zero electron / node:crypto imports) so
 * node vitest imports it unchanged and no browser global enters import-time —
 * same contract as shared/lan-frame.ts, shared/lan-ip.ts, shared/lan-packet.ts.
 * Mirrors the voiceStateCanonical / voiceSignalCanonical style in room-engine.ts.
 *
 * FROZEN-AT-v1 INVARIANT: the field ORDER inside every canonical below is frozen.
 * NEVER append a field to an existing tag — that silently breaks older peers'
 * signatures (the `deafened` / `prevSecrets` lesson). A v2 field rides a NEW tag
 * or travels OUTSIDE the signed canonical. The element[0] domain tags are also
 * mutually distinct so no two builders can ever collide on the same bytes.
 */

// ── Domain tags (element[0]) — FROZEN. Mutually distinct = domain separation. ──
export const LAN_GENESIS_TAG = 'th-lan-genesis:v1';
export const LAN_STATE_TAG = 'th-lan-state:v1';
export const LAN_SIGNAL_TAG = 'th-lan-signal:v1';
export const LAN_ADMIT_TAG = 'th-lan-admit:v1';
export const LAN_EVICT_TAG = 'th-lan-evict:v1';

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
