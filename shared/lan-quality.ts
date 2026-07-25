/**
 * Pure link-quality + diagnostics evaluation for the Havvn virtual LAN
 * (Phase 2A). Dependency-free — no electron, no node:*, and above all NO
 * RTCPeerConnection / getStats: the RTC wiring (room-lan.ts) flattens a
 * getStats() report into plain numbers and calls in here, exactly the way
 * lan-router.ts / lan-session-core.ts keep the transport out of the policy.
 * That is what makes every threshold and every verdict unit-testable under
 * node vitest without a browser.
 *
 * THRESHOLDS ARE MIRRORED VERBATIM from the voice mesh (room-voice.ts:172-177)
 * on purpose: the LAN dot and the voice dot must mean the same thing to a user
 * looking at the same rail. Do not invent LAN-specific numbers here.
 *
 * LOSS UNIT (read this before wiring anything up): every threshold and every
 * `loss` argument in this module is a FRACTION in 0..1 (0.03 = 3%), same as
 * room-voice. Only the *display* record carries `lossPct` (0..100). The
 * summarise/quality entry points accept either and document the precedence.
 *
 * On a data-channel-only PeerConnection there is no inbound-rtp report, so the
 * caller's `loss` is NOT RTP loss — it is the STUN consent-check delta on the
 * selected candidate pair (see room-lan.ts). This module does not care where
 * the number came from; it only maps numbers to a verdict.
 */
import type { LanQuality, LanPeerStatus, LanIceFailReason } from './lan-types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Cadence + thresholds — copied from room-voice.ts:172-177, unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/** Poll cadence for the per-peer getStats sampler (ms). */
export const LAN_QUALITY_POLL_MS = 3000;
/** Round-trip time ladder (ms) on the selected candidate pair. */
export const LAN_RTT_FAIR_MS = 200;
export const LAN_RTT_POOR_MS = 400;
/**
 * Loss ladder as a FRACTION (0.15 = 15%).
 *
 * DELIBERATELY COARSER THAN VOICE (which uses 0.03/0.08). Voice measures real
 * inbound-rtp: hundreds of packets per window, so 3% is both meaningful and
 * expressible. Our proxy is ICE *consent checks* — roughly one every 2.5s, i.e.
 * ~6 per 15s window — so the smallest non-zero loss this metric can EVER produce
 * is ~1/6 ≈ 17%. Copying voice's ladder would mean the 'fair' band is unreachable
 * and one late consent reply instantly reads 'poor'. These thresholds are set to
 * what the sample density can actually express.
 */
export const LAN_LOSS_FAIR = 0.15;
export const LAN_LOSS_POOR = 0.30;
/**
 * STUN consent checks fire only every ~2.5s, so a single 3s poll sees roughly
 * one sample and one lost check reads as ~50% loss. Callers MUST smooth the
 * loss proxy over at least this window before handing it to us, or the dot
 * strobes good↔poor on a healthy link.
 */
export const LAN_LOSS_WINDOW_MS = 15_000;
/**
 * Minimum aggregate consent checks in the window before the loss figure is
 * trusted at all (below it, 1/n dominates and a single straggler looks
 * catastrophic). ~6 samples fit in a 15s window, so this floor is reachable while
 * still discarding the 1-2 sample noise right after a connect.
 */
export const LAN_LOSS_MIN_SAMPLES = 4;

// ─────────────────────────────────────────────────────────────────────────────
// 2. Number hygiene — every entry point is fed by getStats, which can hand back
//    undefined / NaN / negatives / stale counters. Nothing below ever throws.
// ─────────────────────────────────────────────────────────────────────────────

/** Finite, non-negative, or 0. Rejects NaN/Infinity/null/undefined/strings. */
export function safeNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** Loss fraction clamped into 0..1 (1 = total loss). */
export function normLoss(v: unknown): number {
  const n = safeNum(v);
  return n > 1 ? 1 : n;
}

/** Loss fraction → percent, one decimal (display only). */
export function lossToPct(loss: unknown): number {
  return Math.round(normLoss(loss) * 1000) / 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Quality mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map one sample to the tile dot. `loss` is a FRACTION 0..1 (see module note).
 *
 * Deliberately identical to room-voice's inline ladder:
 *   poor if rtt > 400ms OR loss > 8%; fair if rtt > 200ms OR loss > 3%; else good.
 *
 * A missing/zero RTT does NOT mean a fast link — it means "no STUN response has
 * landed yet". This function cannot tell the difference, so the caller must gate
 * on isMeasured() and emit NO quality at all for an unmeasured peer (voice's
 * "never connected ⇒ no dot" rule). Feeding it 0/0 yields 'good' by design.
 */
export function mapStatsToQuality(rttMs?: number, loss?: number): LanQuality {
  const rtt = safeNum(rttMs);
  const l = normLoss(loss);
  if (rtt > LAN_RTT_POOR_MS || l > LAN_LOSS_POOR) return 'poor';
  if (rtt > LAN_RTT_FAIR_MS || l > LAN_LOSS_FAIR) return 'fair';
  return 'good';
}

/** Object-shaped alias of mapStatsToQuality (the call shape used by LanSession). */
export function classifyLanQuality(s: { rttMs?: number; loss?: number }): LanQuality {
  return mapStatsToQuality(s?.rttMs, s?.loss);
}

/**
 * Has this link produced a usable measurement yet? True once an RTT has been
 * observed OR at least one STUN response came back on the selected pair.
 * A brand-new pair (rtt undefined, no responses) is NOT measured and must not
 * be rendered as 'good'.
 */
export function isMeasured(s: { rttMs?: number; responsesReceived?: number; havePair?: boolean } | null | undefined): boolean {
  if (!s) return false;
  return safeNum(s.rttMs) > 0 || safeNum(s.responsesReceived) > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Candidate-pair classification — WHY a link looks the way it does.
// ─────────────────────────────────────────────────────────────────────────────

/** getStats candidateType, plus 'unknown' for absent/unrecognised values. */
export type LanCandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

/** Coarse path used by the UI: is traffic going peer-to-peer or through TURN? */
export type LanLinkPath = 'direct' | 'relayed' | 'unknown';

/** Finer read of the same pair, for the diagnostics report. */
export type LanPathDetail = 'local' | 'nat' | 'relay' | 'unknown';

const CANDIDATE_TYPES: readonly string[] = ['host', 'srflx', 'prflx', 'relay'];

/** Normalise anything getStats (or a stale cache) hands us to a known type. */
export function normCandidateType(v: unknown): LanCandidateType {
  return typeof v === 'string' && CANDIDATE_TYPES.includes(v) ? (v as LanCandidateType) : 'unknown';
}

/**
 * 'relayed' when EITHER end is a TURN relay candidate (one relayed end is
 * enough to inflate RTT and burn relay bandwidth), 'direct' when both ends are
 * known and neither is a relay, 'unknown' when either end is unknown.
 */
export function classifyCandidatePair(localType?: unknown, remoteType?: unknown): LanLinkPath {
  const l = normCandidateType(localType);
  const r = normCandidateType(remoteType);
  if (l === 'relay' || r === 'relay') return 'relayed';
  if (l === 'unknown' || r === 'unknown') return 'unknown';
  return 'direct';
}

/**
 * Same inputs, finer answer: both host ⇒ 'local' (same physical LAN, best case),
 * any reflexive ⇒ 'nat' (hole-punched through NAT), any relay ⇒ 'relay'.
 */
export function classifyPathDetail(localType?: unknown, remoteType?: unknown): LanPathDetail {
  const l = normCandidateType(localType);
  const r = normCandidateType(remoteType);
  if (l === 'relay' || r === 'relay') return 'relay';
  if (l === 'unknown' || r === 'unknown') return 'unknown';
  if (l === 'host' && r === 'host') return 'local';
  return 'nat';
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Display record — one compact, already-rounded object per peer tile.
// ─────────────────────────────────────────────────────────────────────────────

export interface LanLinkInput {
  rttMs?: number;
  /** Loss FRACTION 0..1. Takes precedence over lossPct when both are given. */
  loss?: number;
  /** Loss PERCENT 0..100 — accepted so a UI-side caller cannot silently be off by 100×. */
  lossPct?: number;
  candidate?: { local?: unknown; remote?: unknown };
  /** OUR local drop fraction (send-HWM + token bucket). Display only — never a threshold input. */
  drop?: number;
  reconnecting?: boolean;
}

/** Everything a tile/tooltip needs, pre-rounded and unit-fixed. */
export interface LanLinkSummary {
  quality: LanQuality;
  /** false ⇒ nothing has been measured yet; render NO dot (voice's rule). */
  measured: boolean;
  /** Rounded ms; 0 means "not measured yet", never "0ms". */
  rttMs: number;
  /** 0..100, one decimal. */
  lossPct: number;
  /** OUR own drop rate, 0..100, one decimal. */
  dropPct: number;
  path: LanLinkPath;
  detail: LanPathDetail;
  local: LanCandidateType;
  remote: LanCandidateType;
  relayed: boolean;
  reconnecting: boolean;
}

/**
 * Fold one sample into the display record. Never throws, accepts a completely
 * empty object (an unmeasured peer), and normalises both loss units.
 */
export function summariseLink(input?: LanLinkInput | null): LanLinkSummary {
  const i = input ?? {};
  const loss = i.loss !== undefined && i.loss !== null ? normLoss(i.loss) : normLoss(safeNum(i.lossPct) / 100);
  const rttMs = safeNum(i.rttMs);
  const local = normCandidateType(i.candidate?.local);
  const remote = normCandidateType(i.candidate?.remote);
  const path = classifyCandidatePair(local, remote);
  const measured = isMeasured({ rttMs });
  return {
    quality: mapStatsToQuality(rttMs, loss),
    measured,
    rttMs: Math.round(rttMs),
    lossPct: lossToPct(loss),
    dropPct: lossToPct(i.drop),
    path,
    detail: classifyPathDetail(local, remote),
    local,
    remote,
    relayed: path === 'relayed',
    reconnecting: i.reconnecting === true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Diagnostics — pure evaluation of gathered facts into ordered checks, one
//    overall verdict, and the SINGLE most likely cause.
//
//    `check` and `cause` are stable ids the UI maps to i18n keys
//    (rooms.lan.diag.<check> / rooms.lan.diag.cause.<cause>); `detail` carries
//    language-neutral values (an address, a count, a compact k=v tally) so the
//    report reads the same in every locale and is safe to paste into a bug
//    report. Nothing here formats prose.
// ─────────────────────────────────────────────────────────────────────────────

export type LanCheckLevel = 'ok' | 'warn' | 'fail' | 'unknown';

export type LanCheckId =
  | 'platform' | 'driver' | 'session' | 'helper' | 'adapter' | 'adapter-up'
  | 'vip' | 'firewall' | 'turn' | 'peers';

export interface LanDiagCheck {
  check: LanCheckId;
  /** true only when level === 'ok' — the simple boolean the panel renders. */
  ok: boolean;
  level: LanCheckLevel;
  /** Language-neutral value(s): an IP, a count, `connected=2 failed=1`. */
  detail?: string;
}

export type LanDiagCause =
  | 'unsupported-platform' | 'driver-missing' | 'session-blocked' | 'not-started'
  | 'suspended' | 'helper-dead' | 'adapter-missing' | 'adapter-down'
  | 'vip-missing' | 'vip-mismatch' | 'firewall-missing'
  | 'needs-turn' | 'peer-unreachable' | 'peers-connecting' | 'link-unstable'
  | 'poor-links' | 'no-peers';

export interface LanDiagPeer {
  memberId: string;
  vip?: string;
  status: LanPeerStatus;
  /** Data-channel readyState; 'unknown' when the peer object is gone. */
  channelState?: 'connecting' | 'open' | 'closing' | 'closed' | 'unknown';
  rttMs?: number;
  /** Loss FRACTION 0..1. */
  loss?: number;
  localCandidate?: unknown;
  remoteCandidate?: unknown;
  /** Retries exhausted — the honest terminal state, latched by the session. */
  terminal?: boolean;
  /** Phase 2B: this leg has no direct channel but IS carried by a one-hop peer
   *  relay. Present ⇒ `terminal` above describes the DIRECT path only and the
   *  pair is actually playable — a report must not read it as unreachable. */
  relayVia?: string;
}

export interface LanDiagInput {
  platformWin32: boolean;
  /** koffi + wintun.dll probe (LanManager.available). */
  available: boolean;
  availableReason?: string;
  active: boolean;
  blocked?: boolean;
  suspended?: boolean;
  helperAlive?: boolean;
  adapterName?: string;
  adapterPresent?: boolean;
  adapterUp?: boolean;
  selfVip?: string;
  /** Independently derived expectation — a mismatch means the OS kept a stale IP. */
  expectedVip?: string;
  subnet?: string;
  mtu?: number;
  /** Count of `Havvn LAN-<sid>*` firewall rules found. undefined = not gathered. */
  firewallRuleCount?: number;
  /** A turn:/turns: entry exists in the room's iceServers. undefined = unknown. */
  turnConfigured?: boolean;
  peers: readonly LanDiagPeer[];
}

export interface LanDiagReport {
  checks: LanDiagCheck[];
  verdict: LanCheckLevel;
  /** Absent when the verdict is 'ok'. */
  cause?: LanDiagCause;
  /** Compact per-peer tally, handy for the copy-paste block. */
  peerTally: { total: number; connected: number; connecting: number; reconnecting: number; failed: number; relayed: number; poor: number };
}

const LEVEL_RANK: Record<LanCheckLevel, number> = { ok: 0, unknown: 1, warn: 2, fail: 3 };

/** Most-specific / most-actionable first: the first triggered cause wins. */
const CAUSE_PRIORITY: readonly LanDiagCause[] = [
  'unsupported-platform', 'driver-missing', 'session-blocked', 'not-started', 'suspended',
  'helper-dead', 'adapter-missing', 'adapter-down', 'vip-missing', 'vip-mismatch',
  'firewall-missing', 'needs-turn', 'peer-unreachable', 'no-peers', 'peers-connecting',
  'link-unstable', 'poor-links',
];

function worst(levels: readonly LanCheckLevel[]): LanCheckLevel {
  let out: LanCheckLevel = 'ok';
  for (const l of levels) if (LEVEL_RANK[l] > LEVEL_RANK[out]) out = l;
  return out;
}

/**
 * Turn gathered facts into an ordered check list + one verdict + the single
 * most likely cause. Tolerates a completely empty/partial input: anything not
 * gathered reports level 'unknown' (never a false 'ok' and never a false alarm).
 */
export function evaluateLanDiagnostics(input: LanDiagInput): LanDiagReport {
  const i: LanDiagInput = { ...(input ?? ({} as LanDiagInput)) };
  const peers: readonly LanDiagPeer[] = Array.isArray(i.peers) ? i.peers : [];
  const checks: LanDiagCheck[] = [];
  const causes = new Set<LanDiagCause>();

  const push = (check: LanCheckId, level: LanCheckLevel, detail?: string): void => {
    checks.push({ check, ok: level === 'ok', level, ...(detail ? { detail } : {}) });
  };

  // 1. Platform — everything downstream is Windows-only.
  push('platform', i.platformWin32 ? 'ok' : 'fail', i.platformWin32 ? 'win32' : 'unsupported');
  if (!i.platformWin32) causes.add('unsupported-platform');

  // 2. Driver probe (koffi + wintun.dll).
  if (!i.platformWin32) push('driver', 'unknown');
  else if (i.available) push('driver', 'ok');
  else { push('driver', 'fail', i.availableReason); causes.add('driver-missing'); }

  // 3. Session state.
  if (i.active && i.suspended) { push('session', 'warn', 'suspended'); causes.add('suspended'); }
  else if (i.active) push('session', 'ok', i.subnet);
  else if (i.blocked) { push('session', 'warn', 'blocked'); causes.add('session-blocked'); }
  else { push('session', 'warn', 'inactive'); causes.add('not-started'); }

  // Everything below only means something while a session is running.
  const live = i.active === true;

  // 4. Elevated helper.
  if (!live || i.helperAlive === undefined) push('helper', 'unknown');
  else if (i.helperAlive) push('helper', 'ok');
  else { push('helper', 'fail'); causes.add('helper-dead'); }

  // 5. Wintun adapter present.
  if (!live || i.adapterPresent === undefined) push('adapter', 'unknown', i.adapterName);
  else if (i.adapterPresent) push('adapter', 'ok', i.adapterName);
  else { push('adapter', 'fail', i.adapterName); causes.add('adapter-missing'); }

  // 6. Adapter link state.
  if (!live || i.adapterPresent === false || i.adapterUp === undefined) push('adapter-up', 'unknown');
  else if (i.adapterUp) push('adapter-up', 'ok', 'Up');
  else { push('adapter-up', 'fail', 'Down'); causes.add('adapter-down'); }

  // 7. Virtual IP actually bound.
  const vip = typeof i.selfVip === 'string' ? i.selfVip.trim() : '';
  if (!live) push('vip', 'unknown');
  else if (!vip) { push('vip', 'fail'); causes.add('vip-missing'); }
  else if (i.expectedVip && i.expectedVip !== vip) {
    push('vip', 'warn', `${vip} != ${i.expectedVip}`); causes.add('vip-mismatch');
  } else push('vip', 'ok', i.subnet ? `${vip} (${i.subnet})` : vip);

  // 8. Scoped firewall rules.
  if (!live || i.firewallRuleCount === undefined) push('firewall', 'unknown');
  else if (i.firewallRuleCount > 0) push('firewall', 'ok', String(i.firewallRuleCount));
  else { push('firewall', 'fail', '0'); causes.add('firewall-missing'); }

  // 9. Peer tally — computed before the TURN check, which depends on it.
  const tally = { total: peers.length, connected: 0, connecting: 0, reconnecting: 0, failed: 0, relayed: 0, poor: 0 };
  for (const p of peers) {
    const failed = p.terminal === true || p.status === 'failed';
    if (failed) tally.failed++;
    else if (p.status === 'connected') tally.connected++;
    else if (p.status === 'reconnecting') tally.reconnecting++;
    else tally.connecting++;
    if (classifyCandidatePair(p.localCandidate, p.remoteCandidate) === 'relayed') tally.relayed++;
    if (p.status === 'connected' && isMeasured({ rttMs: p.rttMs }) && mapStatsToQuality(p.rttMs, p.loss) === 'poor') tally.poor++;
  }

  // 10. TURN relay — only actionable when a direct path has actually failed.
  if (i.turnConfigured === undefined) push('turn', 'unknown');
  else if (i.turnConfigured) push('turn', 'ok', 'configured');
  else push('turn', tally.failed > 0 ? 'warn' : 'ok', 'none');

  // 11. Peers.
  const peerDetail = `total=${tally.total} connected=${tally.connected} connecting=${tally.connecting} reconnecting=${tally.reconnecting} failed=${tally.failed} relayed=${tally.relayed} poor=${tally.poor}`;
  if (!live) push('peers', 'unknown');
  else if (tally.failed > 0) {
    push('peers', 'fail', peerDetail);
    // No TURN configured ⇒ the fix is a TURN server. With TURN configured and
    // still failing, the peer itself is unreachable.
    causes.add(i.turnConfigured === true ? 'peer-unreachable' : 'needs-turn');
  } else if (tally.total === 0) { push('peers', 'warn', peerDetail); causes.add('no-peers'); }
  else if (tally.reconnecting > 0) { push('peers', 'warn', peerDetail); causes.add('link-unstable'); }
  else if (tally.connected === 0) { push('peers', 'warn', peerDetail); causes.add('peers-connecting'); }
  else if (tally.poor > 0) { push('peers', 'warn', peerDetail); causes.add('poor-links'); }
  else push('peers', 'ok', peerDetail);

  const verdict = worst(checks.map((c) => c.level));
  const cause = verdict === 'ok' ? undefined : CAUSE_PRIORITY.find((c) => causes.has(c));
  return { checks, verdict, ...(cause ? { cause } : {}), peerTally: tally };
}

/** Convenience for the panel: the checks that are not 'ok', in evaluation order. */
export function failingChecks(report: LanDiagReport): LanDiagCheck[] {
  return report.checks.filter((c) => c.level === 'fail' || c.level === 'warn');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. getStats reduction — the RTC-facing half of the mapper, still 100% pure.
//
//    room-lan.ts flattens a real RTCStatsReport into plain rows (report.forEach)
//    and hands the array here; nothing in this file ever touches an RTC object,
//    so every branch below is drivable from a fixture under node vitest.
//
//    WHICH REPORTS EXIST ON A DATA-ONLY PeerConnection: transport,
//    candidate-pair, local-candidate / remote-candidate, data-channel,
//    peer-connection. NOT inbound-rtp / outbound-rtp — which is why `loss` here
//    is the ICE-consent proxy and never RTP loss (see the module header).
// ─────────────────────────────────────────────────────────────────────────────

/** One flattened RTCStats row. Structural on purpose — never RTCStatsReport. */
export interface LanRawStat { type: string; id: string; [k: string]: unknown }

/** RTCDataChannelState plus 'unknown' ("the report carried no data-channel"). */
export type LanChannelState = 'connecting' | 'open' | 'closing' | 'closed' | 'unknown';

/** STUN / consent counters of the selected pair — the loss-proxy source. */
export interface LanStunCounters {
  requestsSent: number;
  consentRequestsSent: number;
  responsesReceived: number;
}

/** Everything ONE getStats pass tells us about one LAN leg. The same snapshot
 *  feeds the quality dot (A), the honest failure reason (B) and the diagnostics
 *  report (C) — one poll serves all three, nothing else calls getStats. */
export interface LanStatsSnapshot {
  /** Selected-pair RTT in MILLISECONDS (getStats reports SECONDS); 0 = unmeasured. */
  rttMs: number;
  /** A selected/nominated candidate pair was resolvable at all. */
  havePair: boolean;
  local: LanCandidateType;
  remote: LanCandidateType;
  path: LanPathDetail;
  /** EVERY gathered candidate type — what explains a failure when no pair exists. */
  localTypes: LanCandidateType[];
  remoteTypes: LanCandidateType[];
  /** Some candidate pair reached 'succeeded' (a working path did exist). */
  anyPairSucceeded: boolean;
  channelState: LanChannelState;
  bytesSent: number;
  bytesReceived: number;
  stun: LanStunCounters;
  dtlsState?: string;
  iceState?: string;
}

function chanState(v: unknown): LanChannelState {
  return v === 'connecting' || v === 'open' || v === 'closing' || v === 'closed' ? v : 'unknown';
}

/**
 * Fold a flattened stats report into one snapshot.
 *
 * The active pair is resolved from `transport.selectedCandidatePairId` FIRST:
 * voice's `nominated` heuristic can match a pair that is no longer selected after
 * an ICE restart, and a failing link has no nominated pair at all — which is
 * precisely when the gathered candidate TYPES have to answer instead.
 */
export function reduceLanStats(reports: readonly LanRawStat[]): LanStatsSnapshot {
  const byId = new Map<string, LanRawStat>();
  const pairs: LanRawStat[] = [];
  const localTypes = new Set<LanCandidateType>();
  const remoteTypes = new Set<LanCandidateType>();
  let selectedId = '';
  let anyPairSucceeded = false;
  let channelState: LanChannelState = 'unknown';
  let dtlsState: string | undefined;
  let iceState: string | undefined;
  let tSent = 0, tRecv = 0;

  for (const r of reports ?? []) {
    if (!r || typeof r.type !== 'string') continue;
    if (typeof r.id === 'string') byId.set(r.id, r);
    switch (r.type) {
      case 'transport':
        if (typeof r.selectedCandidatePairId === 'string') selectedId = r.selectedCandidatePairId;
        if (typeof r.dtlsState === 'string') dtlsState = r.dtlsState;
        if (typeof r.iceState === 'string') iceState = r.iceState;
        tSent = safeNum(r.bytesSent); tRecv = safeNum(r.bytesReceived);
        break;
      case 'candidate-pair':
        pairs.push(r);
        if (r.state === 'succeeded') anyPairSucceeded = true;
        break;
      case 'local-candidate':
        localTypes.add(normCandidateType(r.candidateType));
        break;
      case 'remote-candidate':
        remoteTypes.add(normCandidateType(r.candidateType));
        break;
      case 'data-channel':
        // Our one channel is labelled 'lan'; prefer it, else take whatever is there.
        if (r.label === 'lan' || channelState === 'unknown') channelState = chanState(r.state);
        break;
      default:
        break;
    }
  }

  let sel: LanRawStat | undefined = selectedId ? byId.get(selectedId) : undefined;
  if (sel && sel.type !== 'candidate-pair') sel = undefined;
  if (!sel) sel = pairs.find((p) => p.nominated === true && p.state === 'succeeded');
  if (!sel) sel = pairs.find((p) => p.nominated === true);

  let rttMs = 0;
  let local: LanCandidateType = 'unknown';
  let remote: LanCandidateType = 'unknown';
  let bytesSent = tSent, bytesReceived = tRecv;
  const stun: LanStunCounters = { requestsSent: 0, consentRequestsSent: 0, responsesReceived: 0 };

  if (sel) {
    const cur = safeNum(sel.currentRoundTripTime);
    if (cur > 0) rttMs = cur * 1000;
    else {
      // currentRoundTripTime is undefined until the first consent response lands;
      // the running average is the honest fallback (also SECONDS → ×1000).
      const tot = safeNum(sel.totalRoundTripTime), resp = safeNum(sel.responsesReceived);
      if (tot > 0 && resp > 0) rttMs = (tot / resp) * 1000;
    }
    const lc = typeof sel.localCandidateId === 'string' ? byId.get(sel.localCandidateId) : undefined;
    const rc = typeof sel.remoteCandidateId === 'string' ? byId.get(sel.remoteCandidateId) : undefined;
    local = normCandidateType(lc?.candidateType);
    remote = normCandidateType(rc?.candidateType);
    if (sel.bytesSent !== undefined) bytesSent = safeNum(sel.bytesSent);
    if (sel.bytesReceived !== undefined) bytesReceived = safeNum(sel.bytesReceived);
    stun.requestsSent = safeNum(sel.requestsSent);
    stun.consentRequestsSent = safeNum(sel.consentRequestsSent);
    stun.responsesReceived = safeNum(sel.responsesReceived);
  }

  return {
    rttMs,
    havePair: !!sel,
    local,
    remote,
    path: classifyPathDetail(local, remote),
    localTypes: [...localTypes],
    remoteTypes: [...remoteTypes],
    anyPairSucceeded,
    channelState,
    bytesSent,
    bytesReceived,
    stun,
    ...(dtlsState ? { dtlsState } : {}),
    ...(iceState ? { iceState } : {}),
  };
}

// ── Loss proxy: consent deltas, smoothed over a window ───────────────────────

/** One poll's worth of consent traffic — a DELTA, never a lifetime total. */
export interface LanLossSample { at: number; sent: number; recv: number }

/** Delta between two counter reads. The FIRST read (prev === null) contributes
 *  nothing (voice's lastRtp rule), and a counter reset — a fresh PC after a reap —
 *  clamps to 0 instead of producing a bogus negative/huge sample. */
export function stunDelta(prev: LanStunCounters | null | undefined, cur: LanStunCounters): { sent: number; recv: number } {
  if (!prev) return { sent: 0, recv: 0 };
  const sent = (safeNum(cur.requestsSent) + safeNum(cur.consentRequestsSent))
    - (safeNum(prev.requestsSent) + safeNum(prev.consentRequestsSent));
  const recv = safeNum(cur.responsesReceived) - safeNum(prev.responsesReceived);
  if (sent < 0 || recv < 0) return { sent: 0, recv: 0 };
  return { sent, recv };
}

/** Loss fraction of a single delta pair (0 when nothing was sent). Unsmoothed —
 *  see windowedLoss for the value that is actually allowed to move the dot. */
export function deriveStunLoss(prev: LanStunCounters | null | undefined, cur: LanStunCounters): number {
  const { sent, recv } = stunDelta(prev, cur);
  if (sent <= 0) return 0;
  return normLoss((sent - recv) / sent);
}

/**
 * Roll `samples` forward: drop everything older than `windowMs`, then report the
 * aggregate loss over what remains. Returning `kept` keeps the caller (LanPeer) a
 * dumb accumulator and this module the only place that owns the math.
 */
export function windowedLoss(
  samples: readonly LanLossSample[],
  nowMs: number,
  windowMs: number = LAN_LOSS_WINDOW_MS,
): { kept: LanLossSample[]; loss: number } {
  const kept = (samples ?? []).filter((s) => !!s && nowMs - s.at <= windowMs);
  let sent = 0, recv = 0;
  for (const s of kept) { sent += safeNum(s.sent); recv += safeNum(s.recv); }
  // MIN-SAMPLE GATE. Unlike voice (hundreds of RTP packets per window), this
  // proxy counts ICE consent checks — only ~1 every 2.5s. Below the floor the
  // smallest expressible loss is 1/n (e.g. 1/3 = 33%), so a single late reply
  // would read as catastrophic. Report 0 until the window is statistically
  // meaningful; the RTT half of the ladder still reacts immediately.
  if (sent < LAN_LOSS_MIN_SAMPLES) return { kept, loss: 0 };
  return { kept, loss: sent > 0 ? normLoss((sent - recv) / sent) : 0 };
}

// ── Failure explanation + TURN detection ─────────────────────────────────────

/**
 * WHY a leg has no usable path (see LanIceFailReason in lan-types for the full
 * decision table). Reads the GATHERED candidate types, because a failed link has
 * no selected pair left to inspect.
 */
export function explainIceFailure(i: {
  localTypes: readonly LanCandidateType[];
  remoteTypes: readonly LanCandidateType[];
  anyPairSucceeded: boolean;
  /** A turn:/turns: entry is present in the room's iceServers. */
  turnConfigured?: boolean;
}): LanIceFailReason {
  const localTypes = i?.localTypes ?? [];
  const remoteTypes = i?.remoteTypes ?? [];
  if (i?.anyPairSucceeded) return 'unknown';                 // a path DID work — not an ICE failure
  if (localTypes.length === 0 && remoteTypes.length === 0) return 'unknown'; // never sampled — do not guess
  if (localTypes.includes('relay') || remoteTypes.includes('relay')) return 'peer-unreachable';
  const reflexive = (t: readonly LanCandidateType[]): boolean => t.includes('srflx') || t.includes('prflx');
  if (localTypes.length > 0 && !reflexive(localTypes)) return 'no-udp'; // STUN never got out
  return i?.turnConfigured ? 'symmetric-nat' : 'needs-turn';
}

/** A turn:/turns: entry is configured — decides between "add a TURN server" and
 *  "TURN is configured and the path still failed". */
export function hasTurn(iceServers: ReadonlyArray<{ urls?: string | string[] }> | undefined | null): boolean {
  for (const s of iceServers ?? []) {
    const u = s?.urls;
    const list = Array.isArray(u) ? u : u ? [u] : [];
    for (const one of list) if (/^turns?:/i.test(String(one))) return true;
  }
  return false;
}

// ── Poll dirty-check ─────────────────────────────────────────────────────────

/** What LanSession stores per member between polls and buildState() projects. */
export interface LanLinkQuality {
  level: LanQuality;
  /** Selected-pair RTT, ms. */
  rttMs: number;
  /** Smoothed consent loss, FRACTION 0..1. */
  loss: number;
  /** OUR own send-drop rate, FRACTION 0..1 (display only). */
  dropPct: number;
  path: LanPathDetail;
  local: LanCandidateType;
  remote: LanCandidateType;
  reconnecting: boolean;
}

/**
 * Dirty-check for the 3s poll: pushing RoomState every tick would re-render the
 * whole rooms page forever. Voice compares only the level; the LAN tooltip shows
 * raw numbers, so RTT/loss/drop are compared at DISPLAY resolution (10 ms / 1%) —
 * fine enough that the tooltip stays live, coarse enough that a steady link stops
 * re-pushing.
 */
export function linkQualityChanged(prev: LanLinkQuality | undefined, next: LanLinkQuality): boolean {
  if (!prev) return true;
  // Compare ONLY what the UI actually renders as a state change. `currentRoundTripTime`
  // is the RTT of the LAST STUN response (not a smoothed average), so it jitters by
  // tens of ms on any internet link: a /10 quantum was true on nearly every 3s tick,
  // which re-pushed the ENTIRE room snapshot to the renderer — exactly the storm this
  // gate exists to prevent. The tooltip numbers ride along with the next genuine
  // change (or the next natural state push); they need not drive one themselves.
  return prev.level !== next.level
    || prev.reconnecting !== next.reconnecting
    || prev.path !== next.path
    || prev.local !== next.local
    || prev.remote !== next.remote
    || Math.round(prev.rttMs / 50) !== Math.round(next.rttMs / 50);
}
