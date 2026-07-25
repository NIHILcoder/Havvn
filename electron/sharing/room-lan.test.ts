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

// ── Minimal RTCPeerConnection / RTCDataChannel stubs (constructed inside LanPeer) ──
class FakeDC {
  binaryType = '';
  readyState = 'open';
  bufferedAmount = 0;
  onmessage: ((e: unknown) => void) | null = null;
  send(): void { /* noop */ }
  close(): void { this.readyState = 'closed'; }
}
class FakePC {
  static count = 0;
  connectionState = 'new';
  signalingState = 'stable';
  localDescription = { type: 'offer', sdp: 'x' };
  remoteDescription: unknown = null;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() { FakePC.count++; }
  createDataChannel(): FakeDC { return new FakeDC(); }
  async setLocalDescription(): Promise<void> { /* noop */ }
  async setRemoteDescription(): Promise<void> { this.remoteDescription = {}; }
  async addIceCandidate(): Promise<void> { /* noop */ }
  close(): void { this.connectionState = 'closed'; }
}

beforeEach(() => { FakePC.count = 0; vi.stubGlobal('RTCPeerConnection', FakePC as unknown); });
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
}

function makeAdapter(selfId: string, sessionId: string, isHost: boolean) {
  const calls: AdapterCalls = { announce: [], admit: [], evict: [], signal: [], reip: [], packets: [], genesis: 0, changes: 0 };
  let onPkt: ((f: Buffer) => void) | null = null;
  const adapter = {
    selfId, sessionId, isHost,
    iceServers: [] as RTCIceServer[],
    sendSignal: (to: string, kind: string) => calls.signal.push({ to, kind }),
    announce: (vip: number, gen: number, at: number) => calls.announce.push({ vip, gen, at }),
    admit: (m: string, at: number) => calls.admit.push({ m, at }),
    evict: (m: string, at: number) => calls.evict.push({ m, at }),
    genesis: () => { calls.genesis++; },
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
