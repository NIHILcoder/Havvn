/**
 * Adversarial tests for the pure LAN route planner (plan §4). Locks the egress
 * src-spoof guard, self-origin drop, MTU bound, broadcast/multicast replication,
 * and the ingress src-check — all on hostile/edge byte input, never throwing.
 */
import { describe, it, expect } from 'vitest';
import { planRoute, acceptInbound, type RouteCtx } from './lan-router';
import type { LanCoreView } from './lan-session-core';

const SELF_VIP = 0x64500001; // 100.80.0.1
const A_VIP = 0x64500002;
const B_VIP = 0x64500003;
const SUBNET_BCAST = 0x6450ffff; // 100.80.255.255
const MDNS = 0xe00000fb;
const SSDP = 0xeffffffa;

/** Minimal IPv4 frame (checksum irrelevant — parseIpv4 doesn't verify it). */
function ip(src: number, dst: number, opts: { proto?: number; payloadLen?: number; totalLength?: number } = {}): Buffer {
  const payloadLen = opts.payloadLen ?? 0;
  const total = 20 + payloadLen;
  const b = Buffer.alloc(total);
  b[0] = 0x45; // version 4, IHL 5
  b.writeUInt16BE(opts.totalLength ?? total, 2);
  b[9] = opts.proto ?? 17; // UDP
  b.writeUInt32BE(src >>> 0, 12);
  b.writeUInt32BE(dst >>> 0, 16);
  return b;
}

const view: LanCoreView = {
  hostId: 'host',
  admitted: new Set(['A', 'B']),
  vipOwners: new Map<number, string>([[A_VIP, 'A'], [B_VIP, 'B'], [SELF_VIP, 'SELF']]),
  selfVip: SELF_VIP,
};
const ctx: RouteCtx = { view, subnetBroadcast: SUBNET_BCAST, selfId: 'SELF', peerIds: ['A', 'B'] };

describe('planRoute — egress guards', () => {
  it('drops a malformed / non-IPv4 frame', () => {
    expect(planRoute(Buffer.alloc(5), ctx).reason).toBe('bad-header');
    expect(planRoute(Buffer.alloc(20), ctx).reason).toBe('bad-header'); // version 0
  });

  it('drops a frame whose src is not OUR vIP (src-spoof)', () => {
    expect(planRoute(ip(0xdeadbeef, A_VIP), ctx)).toMatchObject({ kind: 'drop', reason: 'src-spoof' });
  });

  it('drops an over-MTU frame', () => {
    const big = ip(SELF_VIP, A_VIP, { payloadLen: 1380 }); // total 1400 > LAN_MTU 1280
    expect(planRoute(big, ctx).reason).toBe('oversize');
  });
});

describe('planRoute — unicast', () => {
  it('routes to the vIP owner', () => {
    expect(planRoute(ip(SELF_VIP, A_VIP), ctx)).toEqual({ kind: 'unicast', targets: ['A'] });
  });
  it('drops unicast to an unknown vIP', () => {
    expect(planRoute(ip(SELF_VIP, 0x6450dead), ctx).reason).toBe('no-route');
  });
  it('never loops our own unicast back (self-origin drop)', () => {
    expect(planRoute(ip(SELF_VIP, SELF_VIP), ctx).reason).toBe('self');
  });
});

describe('planRoute — broadcast / multicast replication', () => {
  it('replicates limited broadcast to every peer but self', () => {
    expect(planRoute(ip(SELF_VIP, 0xffffffff), ctx)).toEqual({ kind: 'broadcast', targets: ['A', 'B'] });
  });
  it('replicates the subnet-directed broadcast', () => {
    expect(planRoute(ip(SELF_VIP, SUBNET_BCAST), ctx)).toEqual({ kind: 'broadcast', targets: ['A', 'B'] });
  });
  it('replicates mDNS + SSDP multicast (LAN game discovery)', () => {
    expect(planRoute(ip(SELF_VIP, MDNS), ctx)).toEqual({ kind: 'multicast', targets: ['A', 'B'] });
    expect(planRoute(ip(SELF_VIP, SSDP), ctx)).toEqual({ kind: 'multicast', targets: ['A', 'B'] });
  });
  it('drops broadcast when no peer is connected (excluding self)', () => {
    const solo: RouteCtx = { ...ctx, peerIds: ['SELF'] };
    expect(planRoute(ip(SELF_VIP, 0xffffffff), solo).reason).toBe('no-route');
  });
});

describe('acceptInbound — ingress src-check', () => {
  it('accepts a frame whose src is the sender peer\'s vIP', () => {
    expect(acceptInbound(ip(A_VIP, SELF_VIP), 'A', view)).toBe(true);
  });
  it('rejects a peer spoofing ANOTHER member\'s src address', () => {
    expect(acceptInbound(ip(B_VIP, SELF_VIP), 'A', view)).toBe(false); // A sends B's src
  });
  it('rejects an unknown / unrouted src', () => {
    expect(acceptInbound(ip(0x6450dead, SELF_VIP), 'A', view)).toBe(false);
  });
  it('rejects malformed and over-MTU frames without throwing', () => {
    expect(acceptInbound(Buffer.alloc(4), 'A', view)).toBe(false);
    expect(acceptInbound(ip(A_VIP, SELF_VIP, { payloadLen: 1380 }), 'A', view)).toBe(false);
  });
});
