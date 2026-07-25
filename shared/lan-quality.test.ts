import { describe, it, expect } from 'vitest';
import {
  LAN_QUALITY_POLL_MS, LAN_RTT_FAIR_MS, LAN_RTT_POOR_MS, LAN_LOSS_FAIR, LAN_LOSS_POOR,
  safeNum, normLoss, lossToPct,
  mapStatsToQuality, classifyLanQuality, isMeasured,
  normCandidateType, classifyCandidatePair, classifyPathDetail,
  summariseLink, evaluateLanDiagnostics, failingChecks,
  type LanDiagInput, type LanDiagPeer, type LanCheckId, type LanDiagReport,
  LAN_LOSS_WINDOW_MS, reduceLanStats, stunDelta, deriveStunLoss, windowedLoss,
  explainIceFailure, hasTurn, linkQualityChanged,
  type LanRawStat, type LanLinkQuality,
} from './lan-quality';

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds — these are a CONTRACT with room-voice.ts:172-177. If a future
// change makes this fail, the LAN dot and the voice dot stopped meaning the
// same thing to the user; that is a product decision, not a refactor.
// ─────────────────────────────────────────────────────────────────────────────
describe('thresholds mirror the voice mesh', () => {
  it('keeps voice cadence + RTT ladder, but a COARSER loss ladder', () => {
    expect(LAN_QUALITY_POLL_MS).toBe(3000);
    expect(LAN_RTT_FAIR_MS).toBe(200);
    expect(LAN_RTT_POOR_MS).toBe(400);
    // Loss deliberately DIVERGES from voice's 0.03/0.08: voice counts hundreds of
    // inbound-rtp packets per window, we count ICE consent checks (~6 per 15s), so
    // the smallest loss this proxy can express is ~1/6 ≈ 17%. Voice's ladder would
    // make 'fair' unreachable and turn one late consent reply into 'poor'.
    expect(LAN_LOSS_FAIR).toBe(0.15);
    expect(LAN_LOSS_POOR).toBe(0.30);
  });
});

describe('number hygiene', () => {
  it('safeNum floors garbage to 0', () => {
    for (const v of [undefined, null, NaN, -1, -Infinity, 'abc', {}, [], false]) {
      expect(safeNum(v as unknown)).toBe(0);
    }
    expect(safeNum(Infinity)).toBe(0);   // not a plausible RTT — treat as unknown
    expect(safeNum('42')).toBe(42);      // getStats values can arrive stringified
    expect(safeNum(0)).toBe(0);
    expect(safeNum(12.7)).toBe(12.7);
  });

  it('normLoss clamps into 0..1', () => {
    expect(normLoss(undefined)).toBe(0);
    expect(normLoss(-0.5)).toBe(0);
    expect(normLoss(0.5)).toBe(0.5);
    expect(normLoss(1)).toBe(1);
    expect(normLoss(3)).toBe(1);         // someone passed a percent into a fraction
    expect(normLoss(NaN)).toBe(0);
  });

  it('lossToPct rounds to one decimal', () => {
    expect(lossToPct(0)).toBe(0);
    expect(lossToPct(1)).toBe(100);
    expect(lossToPct(0.0333)).toBe(3.3);
    expect(lossToPct(0.08)).toBe(8);
    expect(lossToPct(undefined)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Quality ladder
// ─────────────────────────────────────────────────────────────────────────────
describe('mapStatsToQuality', () => {
  it('classifies by RTT with strict > comparisons at the boundaries', () => {
    expect(mapStatsToQuality(0, 0)).toBe('good');
    expect(mapStatsToQuality(199, 0)).toBe('good');
    expect(mapStatsToQuality(200, 0)).toBe('good');   // boundary is inclusive-good
    expect(mapStatsToQuality(200.1, 0)).toBe('fair');
    expect(mapStatsToQuality(400, 0)).toBe('fair');   // boundary is inclusive-fair
    expect(mapStatsToQuality(400.1, 0)).toBe('poor');
    expect(mapStatsToQuality(5000, 0)).toBe('poor');
  });

  it('classifies by loss on the LAN ladder (exclusive boundaries)', () => {
    expect(mapStatsToQuality(10, 0.15)).toBe('good');  // at the bound = still good
    expect(mapStatsToQuality(10, 0.151)).toBe('fair');
    expect(mapStatsToQuality(10, 0.30)).toBe('fair');
    expect(mapStatsToQuality(10, 0.301)).toBe('poor');
    expect(mapStatsToQuality(10, 1)).toBe('poor');     // 100% loss
    // A single missed consent check in a ~6-sample window (~17%) is 'fair', not
    // the 'poor' that voice's ladder would have declared.
    expect(mapStatsToQuality(10, 1 / 6)).toBe('fair');
  });

  it('takes the worse of the two axes', () => {
    expect(mapStatsToQuality(5, 0.5)).toBe('poor');   // fast but lossy
    expect(mapStatsToQuality(900, 0)).toBe('poor');   // clean but slow
    expect(mapStatsToQuality(250, 0.05)).toBe('fair');
  });

  it('never throws on missing/garbage stats and reads them as 0', () => {
    expect(mapStatsToQuality(undefined, undefined)).toBe('good');
    expect(mapStatsToQuality(NaN, NaN)).toBe('good');
    expect(mapStatsToQuality(-5, -5)).toBe('good');
    // A percent accidentally passed as a fraction is clamped to 1 ⇒ poor, not good.
    expect(mapStatsToQuality(0, 100)).toBe('poor');
  });

  it('classifyLanQuality is the object-shaped alias, tolerant of a null sample', () => {
    expect(classifyLanQuality({ rttMs: 500, loss: 0 })).toBe('poor');
    expect(classifyLanQuality({})).toBe('good');
    expect(classifyLanQuality(null as never)).toBe('good');
  });
});

describe('isMeasured', () => {
  it('is false until an RTT or a STUN response exists', () => {
    expect(isMeasured(undefined)).toBe(false);
    expect(isMeasured(null)).toBe(false);
    expect(isMeasured({})).toBe(false);
    expect(isMeasured({ rttMs: 0, responsesReceived: 0 })).toBe(false);
    expect(isMeasured({ rttMs: NaN })).toBe(false);
    expect(isMeasured({ rttMs: 0.4 })).toBe(true);
    expect(isMeasured({ responsesReceived: 1 })).toBe(true);
  });

  it('is the gate that stops a brand-new pair reading as good', () => {
    const fresh = { rttMs: undefined, responsesReceived: 0 };
    expect(mapStatsToQuality(fresh.rttMs, 0)).toBe('good'); // by design…
    expect(isMeasured(fresh)).toBe(false);                  // …so the caller must not render it
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Candidate pairs
// ─────────────────────────────────────────────────────────────────────────────
describe('candidate classification', () => {
  it('normalises unknown/garbage candidate types', () => {
    expect(normCandidateType('host')).toBe('host');
    expect(normCandidateType('relay')).toBe('relay');
    expect(normCandidateType('prflx')).toBe('prflx');
    expect(normCandidateType('HOST')).toBe('unknown');  // getStats is lower-case
    expect(normCandidateType(undefined)).toBe('unknown');
    expect(normCandidateType(7)).toBe('unknown');
  });

  it('classifyCandidatePair: one relay end is enough to call it relayed', () => {
    expect(classifyCandidatePair('host', 'host')).toBe('direct');
    expect(classifyCandidatePair('srflx', 'srflx')).toBe('direct');
    expect(classifyCandidatePair('host', 'prflx')).toBe('direct');
    expect(classifyCandidatePair('relay', 'host')).toBe('relayed');
    expect(classifyCandidatePair('host', 'relay')).toBe('relayed');
    expect(classifyCandidatePair('relay', undefined)).toBe('relayed');
  });

  it('classifyCandidatePair: an unknown end without a relay is unknown, not direct', () => {
    expect(classifyCandidatePair(undefined, undefined)).toBe('unknown');
    expect(classifyCandidatePair('host', undefined)).toBe('unknown');
    expect(classifyCandidatePair('', 'srflx')).toBe('unknown');
  });

  it('classifyPathDetail separates same-LAN from hole-punched from relayed', () => {
    expect(classifyPathDetail('host', 'host')).toBe('local');
    expect(classifyPathDetail('host', 'srflx')).toBe('nat');
    expect(classifyPathDetail('srflx', 'prflx')).toBe('nat');
    expect(classifyPathDetail('relay', 'srflx')).toBe('relay');
    expect(classifyPathDetail('host', undefined)).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Display record
// ─────────────────────────────────────────────────────────────────────────────
describe('summariseLink', () => {
  it('folds a healthy direct link', () => {
    const s = summariseLink({ rttMs: 4.6, loss: 0.004, candidate: { local: 'host', remote: 'host' } });
    expect(s).toMatchObject({
      quality: 'good', measured: true, rttMs: 5, lossPct: 0.4,
      path: 'direct', detail: 'local', local: 'host', remote: 'host',
      relayed: false, reconnecting: false, dropPct: 0,
    });
  });

  it('survives a completely empty sample (unmeasured peer)', () => {
    const s = summariseLink({});
    expect(s.measured).toBe(false);
    expect(s.rttMs).toBe(0);
    expect(s.lossPct).toBe(0);
    expect(s.path).toBe('unknown');
    expect(s.detail).toBe('unknown');
    expect(s.quality).toBe('good'); // meaningless without `measured` — documented
  });

  it('survives undefined/null input', () => {
    expect(summariseLink(undefined).measured).toBe(false);
    expect(summariseLink(null).path).toBe('unknown');
  });

  it('accepts lossPct as an alternative unit and prefers `loss` when both exist', () => {
    expect(summariseLink({ lossPct: 100 }).lossPct).toBe(100);
    expect(summariseLink({ lossPct: 100 }).quality).toBe('poor');
    expect(summariseLink({ lossPct: 20 }).quality).toBe('fair'); // 20% > LAN_LOSS_FAIR (0.15)
    // `loss` (fraction) wins, even when it is 0 — no silent 100× error either way.
    expect(summariseLink({ loss: 0, lossPct: 90 }).lossPct).toBe(0);
    expect(summariseLink({ loss: 0.5, lossPct: 1 }).lossPct).toBe(50);
  });

  it('flags relay + reconnecting and reports our own drop rate separately', () => {
    const s = summariseLink({ rttMs: 180, loss: 0, drop: 0.25, candidate: { local: 'relay', remote: 'srflx' }, reconnecting: true });
    expect(s.relayed).toBe(true);
    expect(s.path).toBe('relayed');
    expect(s.detail).toBe('relay');
    expect(s.reconnecting).toBe(true);
    expect(s.dropPct).toBe(25);
    // Our local drop rate is display-only: it must NOT push the dot to poor.
    expect(s.quality).toBe('good');
  });

  it('clamps a 100%-loss link and a nonsense RTT', () => {
    const s = summariseLink({ rttMs: -9, loss: 4 });
    expect(s.rttMs).toBe(0);
    expect(s.lossPct).toBe(100);
    expect(s.quality).toBe('poor');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────
const peer = (p: Partial<LanDiagPeer> = {}): LanDiagPeer => ({
  memberId: 'aaaaaaaa', vip: '100.88.1.2', status: 'connected',
  channelState: 'open', rttMs: 8, loss: 0,
  localCandidate: 'host', remoteCandidate: 'host', ...p,
});

const healthy = (over: Partial<LanDiagInput> = {}): LanDiagInput => ({
  platformWin32: true, available: true, active: true,
  helperAlive: true,
  adapterName: 'Havvn LAN-abc', adapterPresent: true, adapterUp: true,
  selfVip: '100.88.0.7', subnet: '100.88.0.0/16',
  firewallRuleCount: 3, turnConfigured: true,
  peers: [peer()],
  ...over,
});

const level = (r: LanDiagReport, id: LanCheckId): string | undefined => r.checks.find((c) => c.check === id)?.level;

describe('evaluateLanDiagnostics — happy path', () => {
  it('reports every check ok, no cause', () => {
    const r = evaluateLanDiagnostics(healthy());
    expect(r.verdict).toBe('ok');
    expect(r.cause).toBeUndefined();
    expect(r.checks.every((c) => c.ok && c.level === 'ok')).toBe(true);
    expect(failingChecks(r)).toEqual([]);
  });

  it('keeps a stable, ordered check list', () => {
    const r = evaluateLanDiagnostics(healthy());
    expect(r.checks.map((c) => c.check)).toEqual([
      'platform', 'driver', 'session', 'helper', 'adapter', 'adapter-up',
      'vip', 'firewall', 'turn', 'peers',
    ]);
  });

  it('ok=true is exactly level==="ok" on every row', () => {
    const r = evaluateLanDiagnostics(healthy({ helperAlive: false, adapterUp: false, peers: [] }));
    for (const c of r.checks) expect(c.ok).toBe(c.level === 'ok');
  });

  it('a missing TURN server is not a problem while nothing has failed', () => {
    const r = evaluateLanDiagnostics(healthy({ turnConfigured: false }));
    expect(level(r, 'turn')).toBe('ok');
    expect(r.verdict).toBe('ok');
  });

  it('surfaces the subnet and vip as language-neutral detail', () => {
    const r = evaluateLanDiagnostics(healthy());
    expect(r.checks.find((c) => c.check === 'vip')?.detail).toBe('100.88.0.7 (100.88.0.0/16)');
    expect(r.checks.find((c) => c.check === 'firewall')?.detail).toBe('3');
  });
});

describe('evaluateLanDiagnostics — single most likely cause', () => {
  it('unsupported platform outranks everything else', () => {
    const r = evaluateLanDiagnostics(healthy({ platformWin32: false, active: false, available: false }));
    expect(r.verdict).toBe('fail');
    expect(r.cause).toBe('unsupported-platform');
    expect(level(r, 'driver')).toBe('unknown'); // not judged off-platform
  });

  it('a missing driver reports its reason', () => {
    const r = evaluateLanDiagnostics(healthy({ available: false, availableReason: 'wintun.dll not found' }));
    expect(r.cause).toBe('driver-missing');
    expect(r.checks.find((c) => c.check === 'driver')?.detail).toBe('wintun.dll not found');
  });

  it('an inactive session warns with not-started and leaves the rest unknown', () => {
    const r = evaluateLanDiagnostics(healthy({ active: false, peers: [] }));
    expect(r.verdict).toBe('warn');
    expect(r.cause).toBe('not-started');
    for (const id of ['helper', 'adapter', 'adapter-up', 'vip', 'firewall', 'peers'] as LanCheckId[]) {
      expect(level(r, id)).toBe('unknown');
    }
  });

  it('a blocked session (another room holds it) is its own cause', () => {
    const r = evaluateLanDiagnostics(healthy({ active: false, blocked: true, peers: [] }));
    expect(r.cause).toBe('session-blocked');
  });

  it('a kill-switch suspension outranks helper/adapter noise', () => {
    const r = evaluateLanDiagnostics(healthy({ suspended: true, helperAlive: false }));
    expect(r.cause).toBe('suspended');
    expect(level(r, 'session')).toBe('warn');
    expect(r.verdict).toBe('fail'); // helper is still a fail — verdict ≠ cause
  });

  it('a dead helper beats downstream adapter symptoms', () => {
    const r = evaluateLanDiagnostics(healthy({ helperAlive: false, adapterUp: false, selfVip: '' }));
    expect(r.cause).toBe('helper-dead');
  });

  it('a missing adapter suppresses the adapter-up verdict', () => {
    const r = evaluateLanDiagnostics(healthy({ adapterPresent: false, adapterUp: undefined }));
    expect(r.cause).toBe('adapter-missing');
    expect(level(r, 'adapter-up')).toBe('unknown');
  });

  it('an adapter that is present but down', () => {
    const r = evaluateLanDiagnostics(healthy({ adapterUp: false }));
    expect(r.cause).toBe('adapter-down');
    expect(r.checks.find((c) => c.check === 'adapter-up')?.detail).toBe('Down');
  });

  it('a blank or whitespace vip counts as unassigned', () => {
    expect(evaluateLanDiagnostics(healthy({ selfVip: '' })).cause).toBe('vip-missing');
    expect(evaluateLanDiagnostics(healthy({ selfVip: '   ' })).cause).toBe('vip-missing');
    expect(evaluateLanDiagnostics(healthy({ selfVip: undefined })).cause).toBe('vip-missing');
  });

  it('a stale OS-bound vip is a mismatch warning, not a failure', () => {
    const r = evaluateLanDiagnostics(healthy({ selfVip: '100.88.0.7', expectedVip: '100.88.0.9' }));
    expect(level(r, 'vip')).toBe('warn');
    expect(r.cause).toBe('vip-mismatch');
    expect(r.checks.find((c) => c.check === 'vip')?.detail).toBe('100.88.0.7 != 100.88.0.9');
  });

  it('zero firewall rules is a failure; an ungathered count is unknown', () => {
    expect(evaluateLanDiagnostics(healthy({ firewallRuleCount: 0 })).cause).toBe('firewall-missing');
    const r = evaluateLanDiagnostics(healthy({ firewallRuleCount: undefined }));
    expect(level(r, 'firewall')).toBe('unknown');
    expect(r.verdict).toBe('unknown'); // unknown alone never reads as ok
  });
});

describe('evaluateLanDiagnostics — peers', () => {
  it('a failed peer with no TURN configured points at TURN', () => {
    const r = evaluateLanDiagnostics(healthy({ turnConfigured: false, peers: [peer({ status: 'failed' })] }));
    expect(r.verdict).toBe('fail');
    expect(r.cause).toBe('needs-turn');
    expect(level(r, 'turn')).toBe('warn');
  });

  it('a failed peer WITH TURN configured is an unreachable peer, not a TURN problem', () => {
    const r = evaluateLanDiagnostics(healthy({ turnConfigured: true, peers: [peer({ status: 'failed' })] }));
    expect(r.cause).toBe('peer-unreachable');
    expect(level(r, 'turn')).toBe('ok');
  });

  it('a latched terminal peer counts as failed even while status oscillates back to connecting', () => {
    const r = evaluateLanDiagnostics(healthy({ turnConfigured: false, peers: [peer({ status: 'connecting', terminal: true })] }));
    expect(r.cause).toBe('needs-turn');
    expect(r.peerTally.failed).toBe(1);
    expect(r.peerTally.connecting).toBe(0);
  });

  it('an empty peer list on a live session warns instead of claiming health', () => {
    const r = evaluateLanDiagnostics(healthy({ peers: [] }));
    expect(r.verdict).toBe('warn');
    expect(r.cause).toBe('no-peers');
    expect(r.peerTally).toEqual({ total: 0, connected: 0, connecting: 0, reconnecting: 0, failed: 0, relayed: 0, poor: 0 });
  });

  it('tolerates a missing peers array entirely', () => {
    const r = evaluateLanDiagnostics({ ...healthy(), peers: undefined as never });
    expect(r.peerTally.total).toBe(0);
    expect(r.cause).toBe('no-peers');
  });

  it('still handshaking reads as peers-connecting, not as failure', () => {
    const r = evaluateLanDiagnostics(healthy({ peers: [peer({ status: 'connecting', rttMs: undefined, localCandidate: undefined, remoteCandidate: undefined })] }));
    expect(r.verdict).toBe('warn');
    expect(r.cause).toBe('peers-connecting');
    expect(r.peerTally).toMatchObject({ total: 1, connecting: 1, connected: 0 });
  });

  it('a reconnecting peer outranks a merely poor one', () => {
    const r = evaluateLanDiagnostics(healthy({
      peers: [peer({ status: 'reconnecting' }), peer({ memberId: 'bbbbbbbb', rttMs: 900 })],
    }));
    expect(r.cause).toBe('link-unstable');
    expect(r.peerTally.reconnecting).toBe(1);
    expect(r.peerTally.poor).toBe(1);
  });

  it('poor links warn once everything structural is fine', () => {
    const r = evaluateLanDiagnostics(healthy({ peers: [peer({ rttMs: 800, loss: 0.2 })] }));
    expect(r.verdict).toBe('warn');
    expect(r.cause).toBe('poor-links');
  });

  it('does not count an unmeasured connected peer as poor', () => {
    const r = evaluateLanDiagnostics(healthy({ peers: [peer({ rttMs: undefined, loss: undefined })] }));
    expect(r.peerTally.poor).toBe(0);
    expect(r.verdict).toBe('ok');
  });

  it('counts relayed peers without failing them', () => {
    const r = evaluateLanDiagnostics(healthy({ peers: [peer({ localCandidate: 'relay', remoteCandidate: 'srflx' })] }));
    expect(r.peerTally.relayed).toBe(1);
    expect(r.verdict).toBe('ok');
    expect(r.checks.find((c) => c.check === 'peers')?.detail).toContain('relayed=1');
  });

  it('tallies a mixed mesh exactly once per peer', () => {
    const r = evaluateLanDiagnostics(healthy({
      turnConfigured: true,
      peers: [
        peer({ memberId: 'a' }),
        peer({ memberId: 'b', status: 'connecting' }),
        peer({ memberId: 'c', status: 'reconnecting' }),
        peer({ memberId: 'd', status: 'failed' }),
        peer({ memberId: 'e', rttMs: 1200, localCandidate: 'relay' }),
      ],
    }));
    expect(r.peerTally).toEqual({ total: 5, connected: 2, connecting: 1, reconnecting: 1, failed: 1, relayed: 1, poor: 1 });
    expect(r.cause).toBe('peer-unreachable'); // the hard failure wins over the soft ones
  });
});

describe('evaluateLanDiagnostics — verdict algebra', () => {
  it('fail beats warn beats unknown beats ok', () => {
    expect(evaluateLanDiagnostics(healthy()).verdict).toBe('ok');
    expect(evaluateLanDiagnostics(healthy({ helperAlive: undefined })).verdict).toBe('unknown');
    expect(evaluateLanDiagnostics(healthy({ peers: [] })).verdict).toBe('warn');
    expect(evaluateLanDiagnostics(healthy({ adapterUp: false })).verdict).toBe('fail');
  });

  it('never reports a cause when the verdict is ok', () => {
    expect(evaluateLanDiagnostics(healthy()).cause).toBeUndefined();
  });

  it('failingChecks returns the non-ok rows in evaluation order', () => {
    const r = evaluateLanDiagnostics(healthy({ adapterUp: false, firewallRuleCount: 0, peers: [] }));
    expect(failingChecks(r).map((c) => c.check)).toEqual(['adapter-up', 'firewall', 'peers']);
  });

  it('is a pure function: same input twice, deep-equal output, input untouched', () => {
    const input = healthy({ adapterUp: false });
    const snapshot = JSON.stringify(input);
    const a = evaluateLanDiagnostics(input);
    const b = evaluateLanDiagnostics(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('emits no host-candidate addresses or member ids into check details', () => {
    // The report is pasted into bug threads — details carry counts/subnets only.
    const r = evaluateLanDiagnostics(healthy({ peers: [peer({ memberId: 'deadbeefcafe', vip: '100.88.9.9' })] }));
    const blob = r.checks.map((c) => c.detail ?? '').join('|');
    expect(blob).not.toContain('deadbeefcafe');
    expect(blob).not.toContain('100.88.9.9');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getStats reduction (section 7) — the rows below are shaped exactly like the
// reports Chromium emits for a DATA-CHANNEL-ONLY PeerConnection: transport,
// candidate-pair, local/remote-candidate, data-channel. Notably ABSENT:
// inbound-rtp — which is why loss here is the ICE-consent proxy, not RTP loss.
// ─────────────────────────────────────────────────────────────────────────────
function statRows(over: Record<string, unknown> = {}): LanRawStat[] {
  return [
    { type: 'transport', id: 'T', selectedCandidatePairId: 'P1', dtlsState: 'connected', iceState: 'connected', bytesSent: 10, bytesReceived: 20 },
    // A STALE nominated pair left over from an ICE restart — it must not win.
    { type: 'candidate-pair', id: 'P0', nominated: true, state: 'failed', localCandidateId: 'LC-old', remoteCandidateId: 'RC-old', currentRoundTripTime: 9 },
    {
      type: 'candidate-pair', id: 'P1', nominated: true, state: 'succeeded',
      localCandidateId: 'LC', remoteCandidateId: 'RC',
      currentRoundTripTime: 0.042, requestsSent: 10, consentRequestsSent: 4, responsesReceived: 12,
      bytesSent: 100, bytesReceived: 200,
      ...over,
    },
    { type: 'local-candidate', id: 'LC', candidateType: 'srflx' },
    { type: 'local-candidate', id: 'LC-old', candidateType: 'host' },
    { type: 'remote-candidate', id: 'RC', candidateType: 'srflx' },
    { type: 'data-channel', id: 'D', label: 'lan', state: 'open' },
  ];
}

describe('reduceLanStats', () => {
  it('reads RTT (seconds to ms), candidate types and channel state off the SELECTED pair', () => {
    const s = reduceLanStats(statRows());
    expect(s.havePair).toBe(true);
    expect(s.rttMs).toBeCloseTo(42, 6);   // 0.042 s — getStats reports SECONDS
    expect(s.local).toBe('srflx');
    expect(s.remote).toBe('srflx');
    expect(s.path).toBe('nat');
    expect(s.channelState).toBe('open');
    expect(s.anyPairSucceeded).toBe(true);
    expect(s.stun).toEqual({ requestsSent: 10, consentRequestsSent: 4, responsesReceived: 12 });
    expect(s.bytesSent).toBe(100);        // the pair's bytes win over the transport's
    expect(s.dtlsState).toBe('connected');
  });

  it('prefers transport.selectedCandidatePairId over a stale nominated pair', () => {
    const s = reduceLanStats(statRows());
    expect(s.rttMs).toBeLessThan(100);    // not P0's 9000 ms
    expect(s.local).not.toBe('host');
  });

  it('falls back to nominated+succeeded when no transport row names a pair', () => {
    const s = reduceLanStats(statRows().filter((r) => r.type !== 'transport'));
    expect(s.havePair).toBe(true);
    expect(s.rttMs).toBeCloseTo(42, 6);
  });

  it('averages totalRoundTripTime/responsesReceived when currentRoundTripTime is absent', () => {
    const s = reduceLanStats(statRows({ currentRoundTripTime: undefined, totalRoundTripTime: 1.2, responsesReceived: 10 }));
    expect(s.rttMs).toBeCloseTo(120, 6);
  });

  it('reports every GATHERED candidate type even when no pair exists (the failure case)', () => {
    const rows: LanRawStat[] = [
      { type: 'local-candidate', id: 'a', candidateType: 'host' },
      { type: 'local-candidate', id: 'b', candidateType: 'srflx' },
      { type: 'remote-candidate', id: 'c', candidateType: 'srflx' },
      { type: 'candidate-pair', id: 'p', state: 'in-progress' },
    ];
    const s = reduceLanStats(rows);
    expect(s.havePair).toBe(false);
    expect(s.anyPairSucceeded).toBe(false);
    expect(s.rttMs).toBe(0);
    expect([...s.localTypes].sort()).toEqual(['host', 'srflx']);
    expect(s.remoteTypes).toEqual(['srflx']);
    expect(s.path).toBe('unknown');
  });

  it('survives garbage: empty input, junk values, unknown candidate types', () => {
    expect(reduceLanStats([]).havePair).toBe(false);
    const s = reduceLanStats([
      { type: 'candidate-pair', id: 'P', nominated: true, currentRoundTripTime: NaN, requestsSent: 'x' },
      { type: 'local-candidate', id: 'L', candidateType: 'nonsense' },
    ]);
    expect(s.rttMs).toBe(0);
    expect(s.stun.requestsSent).toBe(0);
    expect(s.localTypes).toEqual(['unknown']);
  });
});

describe('consent-loss proxy', () => {
  const c = (requestsSent: number, consentRequestsSent: number, responsesReceived: number) =>
    ({ requestsSent, consentRequestsSent, responsesReceived });

  it('the FIRST sample contributes nothing (voice lastRtp rule)', () => {
    expect(stunDelta(null, c(10, 5, 15))).toEqual({ sent: 0, recv: 0 });
    expect(deriveStunLoss(null, c(10, 5, 0))).toBe(0);
  });

  it('measures the delta, not the lifetime ratio', () => {
    expect(stunDelta(c(10, 5, 15), c(12, 6, 16))).toEqual({ sent: 3, recv: 1 });
    expect(deriveStunLoss(c(10, 5, 15), c(12, 6, 16))).toBeCloseTo(2 / 3, 6);
  });

  it('clamps a counter reset (a rebuilt PC) to zero instead of a bogus rate', () => {
    expect(stunDelta(c(100, 50, 150), c(1, 0, 1))).toEqual({ sent: 0, recv: 0 });
  });

  it('smooths over the window so ONE missed consent check cannot flip the dot', () => {
    // Five polls, one of which lost its single check. Unsmoothed that one poll
    // reads as 100% loss; over the window it is the truthful 20%.
    const samples = [
      { at: 1000, sent: 1, recv: 1 }, { at: 4000, sent: 1, recv: 1 },
      { at: 7000, sent: 1, recv: 0 }, { at: 10000, sent: 1, recv: 1 },
      { at: 13000, sent: 1, recv: 1 },
    ];
    const w = windowedLoss(samples, 13000);
    expect(w.kept).toHaveLength(5);
    expect(w.loss).toBeCloseTo(0.2, 6);
    expect(deriveStunLoss(c(1, 0, 1), c(2, 0, 1))).toBe(1); // the unsmoothed strobe
  });

  it('drops samples older than the window and reports 0 when nothing was sent', () => {
    const old = { at: 0, sent: 10, recv: 0 };
    const fresh = { at: 30_000, sent: 4, recv: 4 };
    const w = windowedLoss([old, fresh], 30_000, LAN_LOSS_WINDOW_MS);
    expect(w.kept).toEqual([fresh]);
    expect(w.loss).toBe(0);
    expect(windowedLoss([], 1).loss).toBe(0);
  });
});

describe('explainIceFailure', () => {
  const base = { localTypes: ['host', 'srflx'] as const, remoteTypes: ['srflx'] as const, anyPairSucceeded: false };

  it('says needs-turn for the symmetric-NAT tail with no relay configured', () => {
    expect(explainIceFailure({ ...base })).toBe('needs-turn');
    expect(explainIceFailure({ ...base, turnConfigured: false })).toBe('needs-turn');
  });

  it('says symmetric-nat when TURN IS configured and a path still never came up', () => {
    expect(explainIceFailure({ ...base, turnConfigured: true })).toBe('symmetric-nat');
  });

  it('says no-udp when we never gathered a reflexive candidate of our own', () => {
    expect(explainIceFailure({ localTypes: ['host'], remoteTypes: ['srflx'], anyPairSucceeded: false })).toBe('no-udp');
  });

  it('says peer-unreachable when even a relayed candidate existed', () => {
    expect(explainIceFailure({ localTypes: ['srflx', 'relay'], remoteTypes: ['srflx'], anyPairSucceeded: false })).toBe('peer-unreachable');
  });

  it('refuses to guess: no facts at all, or a pair that DID succeed, is unknown', () => {
    expect(explainIceFailure({ localTypes: [], remoteTypes: [], anyPairSucceeded: false })).toBe('unknown');
    expect(explainIceFailure({ ...base, anyPairSucceeded: true })).toBe('unknown');
  });
});

describe('hasTurn', () => {
  it('detects turn:/turns: in either string or array urls, case-insensitively', () => {
    expect(hasTurn([{ urls: 'stun:stun.l.google.com:19302' }])).toBe(false);
    expect(hasTurn([{ urls: 'turn:relay.example:3478' }])).toBe(true);
    expect(hasTurn([{ urls: ['stun:a', 'TURNS:b'] }])).toBe(true);
    expect(hasTurn([])).toBe(false);
    expect(hasTurn(undefined)).toBe(false);
  });

  it('does not mistake a hostname containing "turn" for a relay', () => {
    expect(hasTurn([{ urls: 'stun:saturn.example.com' }])).toBe(false);
  });
});

describe('linkQualityChanged (the 3s-poll dirty check)', () => {
  const q = (over: Partial<LanLinkQuality> = {}): LanLinkQuality => ({
    level: 'good', rttMs: 40, loss: 0.01, dropPct: 0, path: 'nat',
    local: 'srflx', remote: 'srflx', reconnecting: false, ...over,
  });

  it('is true for a first reading and for any level/path/candidate change', () => {
    expect(linkQualityChanged(undefined, q())).toBe(true);
    expect(linkQualityChanged(q(), q({ level: 'fair' }))).toBe(true);
    expect(linkQualityChanged(q(), q({ path: 'relay' }))).toBe(true);
    expect(linkQualityChanged(q(), q({ remote: 'relay' }))).toBe(true);
    expect(linkQualityChanged(q(), q({ reconnecting: true }))).toBe(true);
  });

  it('ignores sub-display jitter so a steady link stops re-pushing RoomState', () => {
    expect(linkQualityChanged(q(), q())).toBe(false);
    expect(linkQualityChanged(q({ rttMs: 40 }), q({ rttMs: 42 }))).toBe(false);      // <10 ms
    expect(linkQualityChanged(q({ loss: 0.010 }), q({ loss: 0.012 }))).toBe(false);  // <1%
  });

  it('notices a change the DOT would show, and ignores mere number jitter', () => {
    // The gate exists to stop a 3s state storm: currentRoundTripTime is the last
    // STUN response's RTT (unsmoothed), so it jitters by tens of ms on any internet
    // link. Only a coarse RTT move — or something the dot itself renders — counts.
    expect(linkQualityChanged(q({ rttMs: 40 }), q({ rttMs: 200 }))).toBe(true);
    expect(linkQualityChanged(q({ rttMs: 40 }), q({ rttMs: 60 }))).toBe(false);  // jitter
    expect(linkQualityChanged(q({ dropPct: 0 }), q({ dropPct: 0.05 }))).toBe(false); // tooltip-only
    expect(linkQualityChanged(q({ level: 'good' }), q({ level: 'poor' }))).toBe(true);
    expect(linkQualityChanged(q({ path: 'direct' }), q({ path: 'relayed' }))).toBe(true);
  });
});
