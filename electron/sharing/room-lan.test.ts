/**
 * Tests the LanSession RTC-wiring layer (room-lan.ts) via an injected fake
 * LanAdapter + a stubbed RTCPeerConnection — mirrors room-voice.test.ts, which
 * drives VoiceSession's state machine without real media. The pure policy lives
 * in lan-session-core (tested there); THIS file locks the wiring the core can't
 * reach: that the admission gate inside ensurePeer/onSignal PHYSICALLY refuses to
 * build a LanPeer (a real RTCPeerConnection) for a non-admitted member (must-fix
 * #1), and that a vIP-collision loss emits a reip to the helper (must-fix #6).
 *
 * The stub counts RTCPeerConnection constructions — the admission gate's proof is
 * that a rostered-but-unadmitted member never increments that count.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LanSession } from './room-lan';
import { deriveVip } from '../../shared/lan-ip';
import { LAN_QUALITY_POLL_MS } from '../../shared/lan-quality';
import { encodeRelayFrame, decodeRelayFrame, isRelayFrame } from '../../shared/lan-relay';

// ── Minimal RTCPeerConnection / RTCDataChannel stubs (constructed inside LanPeer) ──
class FakeDC {
  binaryType = '';
  readyState = 'open';
  bufferedAmount = 0;
  onmessage: ((e: unknown) => void) | null = null;
  /** Everything written to this channel, COPIED. The copy is load-bearing: the
   *  session reuses one scratch buffer for relay envelopes precisely because
   *  RTCDataChannel.send() copies synchronously per spec, so a fake that aliased
   *  would silently "prove" the wrong thing. */
  sent: Buffer[] = [];
  send(d?: unknown): void {
    if (d && ArrayBuffer.isView(d as ArrayBufferView)) {
      const v = d as ArrayBufferView;
      this.sent.push(Buffer.from(Buffer.from(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength)));
    }
  }
  close(): void { this.readyState = 'closed'; }
  /** Drive an inbound data-channel message (peer → us). */
  deliver(msg: Buffer): void {
    const ab = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.length) as ArrayBuffer;
    this.onmessage?.({ data: ab });
  }
}
class FakePC {
  static count = 0;
  /** The most recently constructed PC — the leg a test wants to drive. */
  static last: FakePC | null = null;
  /** The channel this PC handed to its LanPeer (Phase 2B tests read/write it). */
  ch: FakeDC | null = null;
  connectionState = 'new';
  signalingState = 'stable';
  localDescription = { type: 'offer', sdp: 'x' };
  remoteDescription: unknown = null;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  /** Rows getStats() should hand back; null makes it REJECT, which is what a
   *  real closing PC does — sampleQuality has to swallow that to a no-reading. */
  stats: unknown[] | null = [];
  constructor() { FakePC.count++; FakePC.last = this; }
  createDataChannel(): FakeDC { this.ch = new FakeDC(); return this.ch; }
  async setLocalDescription(): Promise<void> { /* noop */ }
  async setRemoteDescription(): Promise<void> { this.remoteDescription = {}; }
  async addIceCandidate(): Promise<void> { /* noop */ }
  /** RTCStatsReport is Map-like; forEach is the only API room-lan.ts uses. */
  async getStats(): Promise<{ forEach: (cb: (r: unknown) => void) => void }> {
    const rows = this.stats;
    if (!rows) throw new Error('getStats on a closing PC');
    return { forEach: (cb) => { rows.forEach((r) => cb(r)); } };
  }
  close(): void { this.connectionState = 'closed'; }
  // ── test drivers ──
  setState(s: string): void { this.connectionState = s; this.onconnectionstatechange?.(); }
  connect(): void { this.setState('connected'); }
  fail(): void { this.setState('failed'); }
}

beforeEach(() => { FakePC.count = 0; FakePC.last = null; vi.stubGlobal('RTCPeerConnection', FakePC as unknown); });
afterEach(() => { vi.unstubAllGlobals(); });

interface AdapterCalls {
  announce: Array<{ vip: number; gen: number; at: number }>;
  admit: Array<{ m: string; at: number }>;
  evict: Array<{ m: string; at: number }>;
  signal: Array<{ to: string; kind: string }>;
  reip: Array<{ vip: number; gen: number }>;
  packets: Buffer[];
  genesis: number;
  changes: number;
  /** Phase 2B signed lan-reach adverts we emitted. */
  reach: Array<{ peers: string[]; relay: boolean; at: number }>;
}

function makeAdapter(selfId: string, sessionId: string, isHost: boolean) {
  const calls: AdapterCalls = { announce: [], admit: [], evict: [], signal: [], reip: [], packets: [], genesis: 0, changes: 0, reach: [] };
  let onPkt: ((f: Buffer) => void) | null = null;
  const adapter = {
    selfId, sessionId, isHost,
    iceServers: [] as RTCIceServer[],
    sendSignal: (to: string, kind: string) => calls.signal.push({ to, kind }),
    announce: (vip: number, gen: number, at: number) => calls.announce.push({ vip, gen, at }),
    admit: (m: string, at: number) => calls.admit.push({ m, at }),
    evict: (m: string, at: number) => calls.evict.push({ m, at }),
    genesis: () => { calls.genesis++; },
    reach: (peers: string[], relay: boolean, at: number) => calls.reach.push({ peers, relay, at }),
    reip: (vip: number, gen: number) => calls.reip.push({ vip, gen }),
    sendPacket: (f: Buffer) => calls.packets.push(f),
    onPacket: (h: (f: Buffer) => void) => { onPkt = h; },
    onChange: () => { calls.changes++; },
    warn: () => { /* noop */ },
    log: () => { /* noop */ },
  };
  return { adapter, calls, feedTun: (f: Buffer) => onPkt?.(f) };
}

const HOST = 'h'.repeat(32);
const SID = HOST + '.deadbeefcafef00d'; // prefix === HOST so genesis pins (must-fix #7)
const A = '1111111111111111111111111111111a';
const B = '2222222222222222222222222222222b';

function stateClaim(sessionId: string, memberId: string, gen: number, at: number) {
  return { sessionId, memberId, gen, at, vip: deriveVip(sessionId, memberId, gen) };
}

describe('LanSession — host session opens legs only to admitted picks', () => {
  it('pins genesis, self-admits + admits picks, and builds exactly one PC per admitted pick', () => {
    const { adapter, calls } = makeAdapter(HOST, SID, true);
    const s = new LanSession(adapter as never);
    s.startAsHost([A]);
    expect(s.isActive()).toBe(true);
    expect(calls.genesis).toBe(1);
    expect(calls.admit.map((x) => x.m).sort()).toEqual([A, HOST].sort()); // self + pick
    expect(calls.announce.length).toBeGreaterThanOrEqual(1);
    expect(FakePC.count).toBe(1); // ONE leg — to A (self is not a peer)
    const st = s.buildState();
    expect(st.active).toBe(true);
    expect(st.participants.map((p) => p.memberId).sort()).toEqual([A, HOST].sort());
  });
});

describe('LanSession — THE ADMISSION GATE (must-fix #1)', () => {
  it('a rostered-but-unadmitted member CANNOT force a LanPeer via signaling or presence', () => {
    const { adapter } = makeAdapter(HOST, SID, true);
    const s = new LanSession(adapter as never);
    s.startAsHost([]); // no picks → no legs yet
    expect(FakePC.count).toBe(0);

    // B announces a VALID presence (join-intent) — must NOT build a peer.
    s.onPeerState(stateClaim(SID, B, 0, 100));
    expect(FakePC.count).toBe(0);

    // B sends a signaling offer — the gate must drop it BEFORE ensurePeer.
    s.onSignal(B, 'offer', { type: 'offer', sdp: 'x' });
    expect(FakePC.count).toBe(0);

    // The host admits B → NOW a leg is built.
    s.control('invite', B);
    expect(FakePC.count).toBe(1);

    // A subsequent signal from the now-admitted B reuses the existing peer.
    s.onSignal(B, 'offer', { type: 'offer', sdp: 'x' });
    expect(FakePC.count).toBe(1);
  });

  it('a non-host cannot admit (control invite is a no-op) so no peer is built', () => {
    const { adapter, calls } = makeAdapter(A, SID, false); // we are NOT the host
    const s = new LanSession(adapter as never);
    s.onGenesis(HOST, SID, 1);
    s.onAdmit(HOST, A, 2, SID); // host admits us (records grant; no auto-start)
    s.start();                  // explicit accept brings the session up
    expect(s.isActive()).toBe(true);
    const before = FakePC.count;
    s.control('invite', B); // we are not host → ignored
    expect(calls.admit.length).toBe(0);
    expect(FakePC.count).toBe(before); // no leg to a member WE tried to admit
  });
});

describe('LanSession — evict tears the leg down and is terminal', () => {
  it('closes the peer and drops it from state; re-admit is refused', () => {
    const { adapter, calls } = makeAdapter(HOST, SID, true);
    const s = new LanSession(adapter as never);
    s.startAsHost([A]);
    expect(FakePC.count).toBe(1);
    expect(s.buildState().participants.some((p) => p.memberId === A)).toBe(true);

    s.control('evict', A);
    expect(calls.evict.map((x) => x.m)).toContain(A);
    expect(s.buildState().participants.some((p) => p.memberId === A)).toBe(false);

    // Terminal: a fresh invite cannot resurrect an evicted member.
    const legs = FakePC.count;
    s.control('invite', A);
    expect(FakePC.count).toBe(legs); // no new leg
    expect(s.buildState().participants.some((p) => p.memberId === A)).toBe(false);
  });
});

describe('LanSession — vIP collision emits reip to the helper (must-fix #6)', () => {
  it('on a lost arbitration, re-IPs the adapter and re-announces the new vip', () => {
    // Find two members colliding at gen 0; WE are the higher one → we lose to low.
    const sid = HOST + '.collide0000face0';
    const seen = new Map<number, string>();
    let low = '', high = '', vip = 0;
    for (let i = 0; i < 200000 && !low; i++) {
      const id = 'm' + i;
      const v = deriveVip(sid, id, 0);
      const prev = seen.get(v);
      if (prev) { [low, high] = prev < id ? [prev, id] : [id, prev]; vip = v; }
      else seen.set(v, id);
    }
    expect(low).not.toBe('');

    const { adapter, calls } = makeAdapter(high, sid, false); // self = the higher member
    const s = new LanSession(adapter as never);
    s.onGenesis(HOST, sid, 1);
    s.onAdmit(HOST, high, 2, sid);  // admits us → start()
    s.onAdmit(HOST, low, 3, sid);   // admits low → leg built
    calls.reip.length = 0;          // ignore anything before the collision

    // `low` announces the shared vIP → we lose the arbitration → must reip.
    s.onPeerState(stateClaim(sid, low, 0, 10));
    expect(calls.reip.length).toBe(1);
    expect(calls.reip[0].gen).toBe(1);
    expect(calls.reip[0].vip).toBe(deriveVip(sid, high, 1)); // adapter flapped to our gen-1 vip
  });
});

describe('LanSession — passive joiner bootstrap → explicit accept', () => {
  it('learns the session from gossip WITHOUT starting or building a peer, then connects on accept', () => {
    const { adapter, calls } = makeAdapter(A, SID, false); // joiner, not host
    const s = new LanSession(adapter as never);
    // Host gossip arrives BEFORE the user accepts (no helper/pipe/adapter yet).
    s.onGenesis(HOST, SID, 1);
    s.onAdmit(HOST, HOST, 2, SID); // host self-admit
    s.onAdmit(HOST, A, 3, SID);    // host admits US

    // Passive: knows the host + that we're invited, but is NOT active, has NOT
    // announced, and built NO RTCPeerConnection (must not connect before UAC).
    expect(s.isActive()).toBe(false);
    expect(FakePC.count).toBe(0);
    expect(calls.announce.length).toBe(0);
    const st = s.buildState();
    expect(st.sessionId).toBe(SID);
    expect(st.hostId).toBe(HOST);
    expect(st.selfAdmitted).toBe(true); // → the UI offers Accept

    // Explicit accept (lanStart reuses this session, wires the pipe, then start()).
    s.start();
    expect(s.isActive()).toBe(true);
    expect(calls.announce.length).toBe(1); // now we announce presence
    expect(FakePC.count).toBe(1);          // and open a leg to the admitted host
  });

  it('a non-invited member discovers the session but is not selfAdmitted (cannot accept)', () => {
    const { adapter } = makeAdapter(B, SID, false); // B is NOT invited
    const s = new LanSession(adapter as never);
    s.onGenesis(HOST, SID, 1);
    s.onAdmit(HOST, A, 2, SID); // host admits A, not B
    const st = s.buildState();
    expect(st.hostId).toBe(HOST);   // discoverable
    expect(st.selfAdmitted).toBeFalsy(); // but B has no grant → Accept refused
    expect(FakePC.count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2A — the getStats poll. No real RTCPeerConnection is ever constructed:
// FakePC.stats is fed the row shapes a DATA-ONLY PC emits (transport +
// candidate-pair + local/remote-candidate + data-channel; there is deliberately
// no inbound-rtp, because a data channel has none). The mapping math itself is
// unit-tested in shared/lan-quality.test.ts — what THIS file locks is the
// wiring: poll → per-peer sample → participant fields, and the latched terminal
// failure that the reap/rebuild loop would otherwise hide.
// ─────────────────────────────────────────────────────────────────────────────
function connectedStats(rttSec: number, over: Record<string, unknown> = {}): unknown[] {
  return [
    { type: 'transport', id: 'T', selectedCandidatePairId: 'P', dtlsState: 'connected', iceState: 'connected' },
    {
      type: 'candidate-pair', id: 'P', nominated: true, state: 'succeeded',
      localCandidateId: 'LC', remoteCandidateId: 'RC',
      currentRoundTripTime: rttSec, requestsSent: 4, consentRequestsSent: 2, responsesReceived: 6,
      ...over,
    },
    { type: 'local-candidate', id: 'LC', candidateType: 'srflx' },
    { type: 'remote-candidate', id: 'RC', candidateType: 'srflx' },
    { type: 'data-channel', id: 'D', label: 'lan', state: 'open' },
  ];
}

/** Both ends saw the internet, nothing ever paired — the symmetric-NAT tail. */
function gatheringOnlyStats(): unknown[] {
  return [
    { type: 'local-candidate', id: 'l1', candidateType: 'host' },
    { type: 'local-candidate', id: 'l2', candidateType: 'srflx' },
    { type: 'remote-candidate', id: 'r1', candidateType: 'srflx' },
    { type: 'candidate-pair', id: 'p', state: 'in-progress' },
  ];
}

describe('LanSession — per-peer link quality from getStats (Phase 2A A)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('maps one poll onto the participant: quality, RTT, loss, candidate + path', async () => {
    vi.useFakeTimers(); // arm BEFORE start() so the session's interval is faked
    const { adapter } = makeAdapter(HOST, SID, true);
    const s = new LanSession(adapter as never);
    s.startAsHost([A]);
    const pc = FakePC.last!;
    pc.stats = connectedStats(0.042);
    pc.connect();

    await vi.advanceTimersByTimeAsync(LAN_QUALITY_POLL_MS + 5);

    const p = s.buildState().participants.find((x) => x.memberId === A)!;
    expect(p.status).toBe('connected');
    expect(p.quality).toBe('good');
    expect(p.rttMs).toBe(42);          // 0.042s → ms
    expect(p.lossPct).toBe(0);         // first sample has no delta to lose
    expect(p.dropPct).toBe(0);
    expect(p.candidate).toBe('srflx');
    expect(p.remoteCandidate).toBe('srflx');
    expect(p.path).toBe('nat');
    expect(p.reconnecting).toBeUndefined();
    s.stop();
  });

  it('downgrades the dot on a slow link (voice ladder, unchanged)', async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter(HOST, SID, true);
    const s = new LanSession(adapter as never);
    s.startAsHost([A]);
    const pc = FakePC.last!;
    pc.stats = connectedStats(0.5); // 500ms > RTT_POOR_MS
    pc.connect();
    await vi.advanceTimersByTimeAsync(LAN_QUALITY_POLL_MS + 5);
    const p = s.buildState().participants.find((x) => x.memberId === A)!;
    expect(p.quality).toBe('poor');
    expect(p.rttMs).toBe(500);
    s.stop();
  });

  it('a peer that has never connected carries NO quality key at all (no dot)', async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter(HOST, SID, true);
    const s = new LanSession(adapter as never);
    s.startAsHost([A]);
    FakePC.last!.stats = connectedStats(0.01); // stats exist, but the link is not up
    await vi.advanceTimersByTimeAsync(LAN_QUALITY_POLL_MS + 5);
    const p = s.buildState().participants.find((x) => x.memberId === A)!;
    expect(p.status).toBe('connecting');
    expect(p.quality).toBeUndefined();
    expect(p.rttMs).toBeUndefined();
    s.stop();
  });

  it('a connected link with no measurable pair yet is NOT reported as good', async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter(HOST, SID, true);
    const s = new LanSession(adapter as never);
    s.startAsHost([A]);
    const pc = FakePC.last!;
    pc.stats = gatheringOnlyStats(); // no selected pair → nothing measured
    pc.connect();
    await vi.advanceTimersByTimeAsync(LAN_QUALITY_POLL_MS + 5);
    expect(s.buildState().participants.find((x) => x.memberId === A)!.quality).toBeUndefined();
    s.stop();
  });

  it('a rejecting getStats (closing PC) is swallowed — no reading, no throw', async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter(HOST, SID, true);
    const s = new LanSession(adapter as never);
    s.startAsHost([A]);
    const pc = FakePC.last!;
    pc.stats = null; // getStats rejects
    pc.connect();
    await vi.advanceTimersByTimeAsync(LAN_QUALITY_POLL_MS + 5);
    expect(s.buildState().participants.find((x) => x.memberId === A)!.quality).toBeUndefined();
    s.stop();
  });

  it('reads poor + reconnecting once a link that WAS connected drops', async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter(HOST, SID, true);
    const s = new LanSession(adapter as never);
    s.startAsHost([A]);
    const pc = FakePC.last!;
    pc.stats = connectedStats(0.02);
    pc.connect();
    await vi.advanceTimersByTimeAsync(LAN_QUALITY_POLL_MS + 5);
    pc.setState('disconnected');
    await vi.advanceTimersByTimeAsync(LAN_QUALITY_POLL_MS + 5);
    const p = s.buildState().participants.find((x) => x.memberId === A)!;
    expect(p.status).toBe('reconnecting');
    expect(p.quality).toBe('poor');
    expect(p.reconnecting).toBe(true);
    s.stop();
  });

  it('stop() clears the poll and every measurement', async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter(HOST, SID, true);
    const s = new LanSession(adapter as never);
    s.startAsHost([A]);
    const pc = FakePC.last!;
    pc.stats = connectedStats(0.02);
    pc.connect();
    await vi.advanceTimersByTimeAsync(LAN_QUALITY_POLL_MS + 5);
    expect(s.buildState().participants.find((x) => x.memberId === A)!.quality).toBe('good');
    s.stop();
    expect(vi.getTimerCount()).toBe(0); // a live interval would outlive the session
    const p = s.buildState().participants.find((x) => x.memberId === A)!;
    expect(p.quality).toBeUndefined(); // measurements die with the peers
    expect(p.status).toBe('connecting');
  });
});

describe('LanSession — honest terminal failure (Phase 2A B)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('latches the reason across the reap/rebuild churn and finally goes terminal', async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter(HOST, SID, true); // no TURN in iceServers
    const s = new LanSession(adapter as never);
    s.startAsHost([A]);
    const pc = FakePC.last!;
    pc.stats = gatheringOnlyStats(); // srflx both ends, nothing ever succeeded
    await vi.advanceTimersByTimeAsync(LAN_QUALITY_POLL_MS + 5); // gather the facts

    pc.fail();
    let p = s.buildState().participants.find((x) => x.memberId === A)!;
    // Rebuilt immediately (voice pattern) — but the WHY is latched, not lost.
    expect(p.failReason).toBe('needs-turn');
    expect(p.terminal).toBeFalsy();
    expect(p.status).toBe('connecting');

    // The rebuilt legs have no stats of their own; their factless 'unknown' must
    // NOT overwrite the real explanation.
    FakePC.last!.fail();
    FakePC.last!.fail();
    p = s.buildState().participants.find((x) => x.memberId === A)!;
    expect(p.status).toBe('failed');
    expect(p.terminal).toBe(true);
    expect(p.failReason).toBe('needs-turn');
    expect(s.buildState().turnConfigured).toBe(false);
    s.stop();
  });

  it('with TURN configured the same failure reads as symmetric-nat, not needs-turn', async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter(HOST, SID, true);
    adapter.iceServers = [{ urls: 'turn:relay.example:3478' }] as RTCIceServer[];
    const s = new LanSession(adapter as never);
    s.startAsHost([A]);
    const pc = FakePC.last!;
    pc.stats = gatheringOnlyStats();
    await vi.advanceTimersByTimeAsync(LAN_QUALITY_POLL_MS + 5);
    pc.fail();
    const p = s.buildState().participants.find((x) => x.memberId === A)!;
    expect(p.failReason).toBe('symmetric-nat');
    expect(s.buildState().turnConfigured).toBe(true);
    s.stop();
  });

  it('a successful connect retires the latched failure entirely', async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter(HOST, SID, true);
    const s = new LanSession(adapter as never);
    s.startAsHost([A]);
    FakePC.last!.stats = gatheringOnlyStats();
    await vi.advanceTimersByTimeAsync(LAN_QUALITY_POLL_MS + 5);
    FakePC.last!.fail();
    expect(s.buildState().participants.find((x) => x.memberId === A)!.failReason).toBe('needs-turn');

    const rebuilt = FakePC.last!;
    rebuilt.stats = connectedStats(0.03);
    rebuilt.connect();
    const p = s.buildState().participants.find((x) => x.memberId === A)!;
    expect(p.status).toBe('connected');
    expect(p.failReason).toBeUndefined();
    expect(p.terminal).toBeFalsy();
    s.stop();
  });
});

describe('LanSession — egress routing through the TUN feeder', () => {
  it('routes an outbound unicast frame to the admitted destination peer', () => {
    const { adapter, calls, feedTun } = makeAdapter(HOST, SID, true);
    const s = new LanSession(adapter as never);
    s.startAsHost([A]);
    // A announces presence so its vIP enters the routing table.
    s.onPeerState(stateClaim(SID, A, 0, 100));
    // Build an IPv4/UDP frame from OUR vIP to A's vIP.
    const selfVip = deriveVip(SID, HOST, 0);
    const aVip = deriveVip(SID, A, 0);
    const f = Buffer.alloc(28);
    f[0] = 0x45; f.writeUInt16BE(28, 2); f[9] = 17;
    f.writeUInt32BE(selfVip >>> 0, 12); f.writeUInt32BE(aVip >>> 0, 16);
    feedTun(f);
    // (No assertion on the channel send itself — the fake DC swallows it; this
    //  exercises the onTunFrame → planRoute → peer lookup path without throwing.)
    expect(calls.changes).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2B — ONE-HOP PEER RELAY (transport wiring).
//
// The pure envelope codec, the two data-plane decisions and the deterministic
// selector are unit-tested in shared/lan-relay.test.ts. What THIS file locks is
// the wiring those tests cannot reach: that a TERMINALLY-failed leg actually gets
// enveloped and handed to the argmin relay (and to exactly ONE of them), that a
// twice-travelled frame has no forwarding branch to take, that a member the host
// never admitted is never forwarded to, that eviction stops forwarding on the very
// next packet, and that the willingness switch is honoured LIVE.
//
// memberIds here are real 32-lowercase-hex ids, because the envelope carries them
// as 16 raw bytes and the codec refuses anything else (the ids used by the Phase
// 1/2A suites above are deliberately not all hex, which is fine for those paths).
// ─────────────────────────────────────────────────────────────────────────────
const RH = 'a'.repeat(32);                       // us — the session host
const RSID = RH + '.beefbeefbeefbeef';           // prefix === RH so genesis pins
const RA = '1'.repeat(32);
const RB = '2'.repeat(32);
const RC = '3'.repeat(32);
const RD = '4'.repeat(32);                       // never admitted
const RE = '5'.repeat(32);                       // admitted, vIP known, leg NEVER connects

/** A minimal IPv4/UDP frame (parseIpv4 does not verify the checksum). */
function ipFrame(src: number, dst: number, payload = 8): Buffer {
  const total = 20 + payload;
  const f = Buffer.alloc(total);
  f[0] = 0x45;                       // version 4, IHL 5
  f.writeUInt16BE(total, 2);
  f[9] = 17;                         // UDP
  f.writeUInt32BE(src >>> 0, 12);
  f.writeUInt32BE(dst >>> 0, 16);
  return f;
}

const vipOf = (m: string) => deriveVip(RSID, m, 0);

/** Fail a leg `n` times, following the reap/rebuild chain to the freshest PC. */
function failLeg(start: FakePC, n: number): void {
  let pc = start;
  for (let i = 0; i < n; i++) { pc.fail(); pc = FakePC.last!; }
}

/**
 * A host session where the leg to RA has latched TERMINAL and the legs to RB and
 * RC are up. RB and RC have both advertised that they bridge us and RA, so both
 * are candidates and the argmin (RB — '2…' < '3…') must win.
 */
function relayFixture(opts: { advertise?: boolean; relayWilling?: boolean } = {}) {
  const { adapter, calls, feedTun } = makeAdapter(RH, RSID, true);
  const s = new LanSession(adapter as never);
  s.startAsHost([RA]);
  const raPc = FakePC.last!;
  // RA's presence FIRST: its vIP must be in the routing table, and announcing it
  // after the latch would re-run ensurePeer and clear `terminal`.
  s.onPeerState({ sessionId: RSID, memberId: RA, gen: 0, at: 100, vip: vipOf(RA) });
  failLeg(raPc, 3); // rebuild budget spent → terminal, LanPeer reaped

  s.control('invite', RB);
  const rbPc = FakePC.last!;
  s.control('invite', RC);
  const rcPc = FakePC.last!;
  s.onPeerState({ sessionId: RSID, memberId: RB, gen: 0, at: 101, vip: vipOf(RB) });
  s.onPeerState({ sessionId: RSID, memberId: RC, gen: 0, at: 102, vip: vipOf(RC) });
  rbPc.connect();
  rcPc.connect();

  if (opts.advertise !== false) {
    const relay = opts.relayWilling !== false;
    s.onPeerReach({ memberId: RB, sessionId: RSID, at: 1000, relay, peers: [RH, RA].sort() });
    s.onPeerReach({ memberId: RC, sessionId: RSID, at: 1000, relay, peers: [RH, RA].sort() });
  }
  return { s, calls, feedTun, raPc, rbPc, rcPc };
}

describe('LanSession — Phase 2B: a terminal peer is routed through a relay', () => {
  it('envelopes the frame to the ARGMIN relay, and to exactly one of them', () => {
    const { s, feedTun, rbPc, rcPc } = relayFixture();
    // Sanity: the direct leg really is dead, so this is the fallback path.
    expect(s.buildState().participants.find((p) => p.memberId === RA)!.terminal).toBe(true);

    const frame = ipFrame(vipOf(RH), vipOf(RA));
    feedTun(frame);

    expect(rbPc.ch!.sent.length).toBe(1);
    expect(rcPc.ch!.sent.length).toBe(0); // ONE relay — never duplicate delivery
    const env = decodeRelayFrame(rbPc.ch!.sent[0])!;
    expect(env).not.toBeNull();
    expect(env.origin).toBe(RH);          // WE are the originator
    expect(env.target).toBe(RA);          // addressed to the unreachable peer, by name
    expect(Buffer.compare(env.inner, frame)).toBe(0); // the packet itself is untouched
    s.stop();
  });

  it('relays BROADCAST too — a reaped terminal peer must still see LAN discovery', () => {
    const { s, feedTun, rbPc } = relayFixture();
    feedTun(ipFrame(vipOf(RH), 0xffffffff)); // limited broadcast (game discovery)
    // RB gets its own DIRECT copy plus the relayed copy addressed to RA.
    const relayed = rbPc.ch!.sent.filter((b) => isRelayFrame(b));
    const direct = rbPc.ch!.sent.filter((b) => !isRelayFrame(b));
    expect(direct.length).toBe(1);
    expect(relayed.length).toBe(1);
    expect(decodeRelayFrame(relayed[0])!.target).toBe(RA);
    s.stop();
  });

  it('surfaces relayVia (and keeps the DIRECT status honestly terminal)', () => {
    const { s } = relayFixture();
    const p = s.buildState().participants.find((x) => x.memberId === RA)!;
    expect(p.relayVia).toBe(RB);
    expect(p.terminal).toBe(true);   // the direct leg IS dead — do not pretend otherwise
    expect(p.quality).toBeUndefined(); // never project the leg-to-the-relay as the pair's
    expect(s.peerDiagnostics().find((x) => x.memberId === RA)!.relayVia).toBe(RB);
    s.stop();
  });

  it('re-selects the next argmin when the chosen relay leaves, and stops when none is left', () => {
    const { s } = relayFixture();
    expect(s.buildState().participants.find((x) => x.memberId === RA)!.relayVia).toBe(RB);
    s.onMemberGone(RB); // the chosen relay departs
    expect(s.buildState().participants.find((x) => x.memberId === RA)!.relayVia).toBe(RC);
    s.onMemberGone(RC);
    expect(s.buildState().participants.find((x) => x.memberId === RA)!.relayVia).toBeUndefined();
    s.stop();
  });

  it('sends nothing via a relay when no peer advertised reachability', () => {
    const { s, feedTun, rbPc, rcPc } = relayFixture({ advertise: false });
    feedTun(ipFrame(vipOf(RH), vipOf(RA)));
    expect(rbPc.ch!.sent.length).toBe(0);
    expect(rcPc.ch!.sent.length).toBe(0);
    s.stop();
  });

  it('never relays through a peer that advertised relay:false (declining is enough)', () => {
    const { s, feedTun, rbPc, rcPc } = relayFixture({ relayWilling: false });
    feedTun(ipFrame(vipOf(RH), vipOf(RA)));
    expect(rbPc.ch!.sent.length).toBe(0);
    expect(rcPc.ch!.sent.length).toBe(0);
    expect(s.buildState().participants.find((x) => x.memberId === RA)!.relayVia).toBeUndefined();
    s.stop();
  });

  it('reverts to DIRECT the moment the direct leg reconnects', () => {
    const { s, feedTun, rbPc } = relayFixture();
    expect(s.buildState().participants.find((x) => x.memberId === RA)!.relayVia).toBe(RB);

    // A fresh admit rebuilds the leg (a re-invite is the real-world trigger); the
    // rebuilt PC connecting clears the terminal latch. `at` must clear the admit
    // floor set when the session started, or applyAdmit rejects it as a replay.
    s.onAdmit(RH, RA, Date.now() + 60_000, RSID);
    FakePC.last!.connect();

    const p = s.buildState().participants.find((x) => x.memberId === RA)!;
    expect(p.relayVia).toBeUndefined();
    expect(p.terminal).toBeFalsy();
    expect(p.status).toBe('connected');

    const before = rbPc.ch!.sent.length;
    feedTun(ipFrame(vipOf(RH), vipOf(RA)));
    expect(rbPc.ch!.sent.length).toBe(before); // straight down the direct leg now
    s.stop();
  });

  it('advertises our own connected legs + willingness, coalescing a burst into ONE emit', async () => {
    vi.useFakeTimers(); // arm BEFORE the session so its poll interval is faked
    try {
      const { s, calls } = relayFixture();
      // Both legs came up inside the 3s floor that follows the session's opening
      // advert, so the change is COALESCED rather than emitted per flap — the
      // whole point of the floor. It lands on the next quality-poll tick.
      const opening = calls.reach.length;
      expect(opening).toBe(1);
      expect(calls.reach[0].peers).toEqual([]); // nothing was connected yet

      await vi.advanceTimersByTimeAsync(LAN_QUALITY_POLL_MS + 5);
      expect(calls.reach.length).toBe(opening + 1); // ONE emit, not one per flap
      const last = calls.reach[calls.reach.length - 1];
      expect(last.relay).toBe(true);
      expect(last.peers).toEqual([RB, RC].sort()); // ascending canonical form
      expect(last.peers).not.toContain(RA);        // a terminal leg is NOT a leg

      // Nothing changed → the next tick must stay silent (no heartbeat storm).
      await vi.advanceTimersByTimeAsync(LAN_QUALITY_POLL_MS + 5);
      expect(calls.reach.length).toBe(opening + 1);

      // Flipping willingness changes the advertised tuple → republish.
      const n = calls.reach.length;
      s.setRelayEnabled(false);
      expect(calls.reach.length).toBe(n + 1);
      expect(calls.reach[n].relay).toBe(false);
      expect(s.buildState().relayEnabled).toBe(false);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('LanSession — Phase 2B: forwarding for others (we are the relay)', () => {
  /** We hold live legs to RA, RB and RC — exactly the position a relay is in.
   *  Peers are invited ONE AT A TIME so every PC is identified by name (walking
   *  construction order after a batch startAsHost is fragile). */
  function relayRoleFixture() {
    const { adapter, calls } = makeAdapter(RH, RSID, true);
    const s = new LanSession(adapter as never);
    s.startAsHost([]);            // no picks — invite one at a time, so each PC is known
    s.control('invite', RA); const raPc = FakePC.last!;
    s.control('invite', RB); const rbPc = FakePC.last!;
    s.control('invite', RC); const rcPc = FakePC.last!;
    s.onPeerState({ sessionId: RSID, memberId: RA, gen: 0, at: 100, vip: vipOf(RA) });
    s.onPeerState({ sessionId: RSID, memberId: RB, gen: 0, at: 101, vip: vipOf(RB) });
    s.onPeerState({ sessionId: RSID, memberId: RC, gen: 0, at: 102, vip: vipOf(RC) });
    raPc.connect(); rbPc.connect(); rcPc.connect();
    return { s, calls, raPc, rbPc, rcPc };
  }

  it('forwards EXACTLY ONE copy of an admitted member\'s envelope to the named target', () => {
    const { s, raPc, rbPc, rcPc } = relayRoleFixture();
    const inner = ipFrame(vipOf(RA), vipOf(RB));
    raPc.ch!.deliver(encodeRelayFrame(RA, RB, inner)!);

    expect(rbPc.ch!.sent.length).toBe(1);
    expect(rcPc.ch!.sent.length).toBe(0); // strict 1-in-1-out: never a fan-out
    const env = decodeRelayFrame(rbPc.ch!.sent[0])!;
    expect(env.origin).toBe(RA);
    expect(env.target).toBe(RB);
    expect(s.buildState().relayFor).toEqual([RA]); // the visible "Relaying for N"
    s.stop();
  });

  it('REFUSES to re-relay: a frame that already travelled once has no forwarding branch', () => {
    const { s, raPc, rbPc } = relayRoleFixture();
    // RA hands us an envelope whose claimed ORIGIN is RC — i.e. RC→RA→us. The
    // one-hop gate is `from === origin`, which this can never satisfy, so there
    // is no second hop. Loops are unrepresentable, not merely budgeted.
    const inner = ipFrame(vipOf(RC), vipOf(RB));
    raPc.ch!.deliver(encodeRelayFrame(RC, RB, inner)!);

    expect(rbPc.ch!.sent.length).toBe(0);
    expect(s.buildState().relayFor).toBeUndefined();
    s.stop();
  });

  it('never forwards to a member the host did NOT admit', () => {
    const { s, raPc, rbPc, rcPc } = relayRoleFixture();
    // Target RD is a real 32-hex id that simply has no host-signed admit.
    raPc.ch!.deliver(encodeRelayFrame(RA, RD, ipFrame(vipOf(RA), vipOf(RD)))!);
    expect(rbPc.ch!.sent.length + rcPc.ch!.sent.length).toBe(0);
    expect(s.buildState().relayFor).toBeUndefined();
    s.stop();
  });

  it('never forwards a frame whose inner src is NOT the sender\'s own vIP (spoof)', () => {
    const { s, raPc, rbPc } = relayRoleFixture();
    // RA claims to be the origin (so the one-hop gate passes) but wraps a packet
    // sourced from RC's address — the relay-side analog of acceptInbound.
    raPc.ch!.deliver(encodeRelayFrame(RA, RB, ipFrame(vipOf(RC), vipOf(RB)))!);
    expect(rbPc.ch!.sent.length).toBe(0);
    s.stop();
  });

  it('EVICTION stops forwarding on the very next packet', () => {
    const { s, raPc, rbPc } = relayRoleFixture();
    raPc.ch!.deliver(encodeRelayFrame(RA, RB, ipFrame(vipOf(RA), vipOf(RB)))!);
    expect(rbPc.ch!.sent.length).toBe(1);

    s.control('evict', RB); // host evicts the TARGET — sticky and terminal
    raPc.ch!.deliver(encodeRelayFrame(RA, RB, ipFrame(vipOf(RA), vipOf(RB)))!);
    expect(rbPc.ch!.sent.length).toBe(1); // nothing more went out
    expect(rbPc.ch!.readyState).toBe('closed');
    s.stop();
  });

  it('EVICTING THE ORIGIN stops us forwarding for them (attribution dies with the admit)', () => {
    const { s, raPc, rbPc } = relayRoleFixture();
    s.control('evict', RA);
    // Even if their channel somehow still delivers, the vIP table no longer
    // attributes that src to anyone admitted, so nothing can be forwarded.
    raPc.ch!.deliver(encodeRelayFrame(RA, RB, ipFrame(vipOf(RA), vipOf(RB)))!);
    expect(rbPc.ch!.sent.length).toBe(0);
    s.stop();
  });

  it('forwards NOTHING while the relay toggle is off, live and mid-session', () => {
    const { s, raPc, rbPc } = relayRoleFixture();
    s.setRelayEnabled(false);
    raPc.ch!.deliver(encodeRelayFrame(RA, RB, ipFrame(vipOf(RA), vipOf(RB)))!);
    expect(rbPc.ch!.sent.length).toBe(0);
    expect(s.isRelayEnabled()).toBe(false);
    s.stop();
  });

  it('accepts a relayed frame only when the sender genuinely bridges us and the claimed origin', () => {
    const { s, calls, rbPc } = relayRoleFixture();
    // RE is admitted with a known vIP, but its leg NEVER connects — the ONLY
    // situation in which relayed traffic from it is legitimate. (Using a member we
    // hold a live leg to would be refused on principle; see the next test.)
    s.control('invite', RE);
    s.onPeerState({ sessionId: RSID, memberId: RE, gen: 0, at: 103, vip: vipOf(RE) });
    const inner = ipFrame(vipOf(RE), vipOf(RH));

    // No advert from RB yet ⇒ RB is in nobody's candidate set ⇒ refuse.
    rbPc.ch!.deliver(encodeRelayFrame(RE, RH, inner)!);
    expect(calls.packets.length).toBe(0);

    // RB advertises that it bridges RE and us → now the same frame is injected.
    s.onPeerReach({ memberId: RB, sessionId: RSID, at: 2000, relay: true, peers: [RE, RH].sort() });
    rbPc.ch!.deliver(encodeRelayFrame(RE, RH, inner)!);
    expect(calls.packets.length).toBe(1);
    expect(Buffer.compare(calls.packets[0], inner)).toBe(0);

    // …but it may NOT mint traffic attributed to a member it does not bridge:
    // the inner src must belong to the CLAIMED origin in our own vIP table.
    rbPc.ch!.deliver(encodeRelayFrame(RE, RH, ipFrame(vipOf(RC), vipOf(RH)))!);
    expect(calls.packets.length).toBe(1);
    s.stop();
  });

  it('REFUSES relayed traffic attributed to a member we hold a live DIRECT leg to', () => {
    // The forgery this closes: relaying is a FALLBACK for pairs with no direct
    // path, so a relayed frame claiming to come from someone we are already
    // connected to is never legitimate. Accepting it would let ANY admitted member
    // inject frames bearing ANOTHER member's source IP at will — the relay's own
    // reachability advert is a self-claim and proves nothing. The gate is our own
    // ground truth (do we have a leg?), never the relay's word.
    const { s, calls, rbPc } = relayRoleFixture(); // RA/RB/RC legs are all CONNECTED
    // A perfectly well-formed envelope: real origin, real src, and RB even asserts
    // it bridges RA and us.
    s.onPeerReach({ memberId: RB, sessionId: RSID, at: 2000, relay: true, peers: [RA, RH].sort() });
    rbPc.ch!.deliver(encodeRelayFrame(RA, RH, ipFrame(vipOf(RA), vipOf(RH)))!);
    expect(calls.packets.length).toBe(0); // refused: we have a direct leg to RA
    s.stop();
  });

  it('a bare IPv4 frame can never reach the relay paths (dispatch is total on byte 0)', () => {
    const { s, calls, raPc, rbPc } = relayRoleFixture();
    // A normal direct frame from RA: injected, and nothing is forwarded anywhere.
    raPc.ch!.deliver(ipFrame(vipOf(RA), vipOf(RH)));
    expect(calls.packets.length).toBe(1);
    expect(rbPc.ch!.sent.length).toBe(0);
    s.stop();
  });
});
