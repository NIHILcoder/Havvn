/**
 * Pure route planner for the Havvn virtual-LAN feature (plan §4). Decides, for a
 * raw IPv4 frame leaving the local TUN, which admitted session peers it must be
 * sent to — unicast via the verified vIP→memberId table, or replicated to every
 * peer for broadcast/multicast (the auto-discovery killer-feature). The ingress
 * counterpart (acceptInbound) src-checks a frame received over a peer's data
 * channel before it is injected into the local TUN.
 *
 * Dependency-free (no electron, no browser globals) — reuses shared/lan-packet.ts
 * for the hostile-input-safe header parse + classification and the LanCoreView
 * snapshot from shared/lan-session-core.ts. NEVER throws on hostile bytes: a
 * malformed / oversized / spoofed frame returns a 'drop' plan (egress) or false
 * (ingress). Same adversarial contract as ip-range.ts / profile.ts.
 */

import { parseIpv4, classifyDest } from './lan-packet';
import { LAN_MTU, type LanCoreView } from './lan-session-core';

/** What the router decided for one TUN-egress frame. `targets` are memberIds to
 *  DataChannel-send to (resolved to a LanPeer at send time by the caller); an
 *  empty list means drop. */
export interface RoutePlan {
  kind: 'unicast' | 'broadcast' | 'multicast' | 'drop';
  targets: string[];
  reason?: string; // 'no-route' | 'bad-header' | 'src-spoof' | 'oversize' | 'self'
}

/** Immutable inputs the pure planner needs (the session rebuilds this per frame). */
export interface RouteCtx {
  view: LanCoreView;
  subnetBroadcast: number; // sessionSubnet(sessionId).broadcast
  selfId: string;
  peerIds: string[]; // currently-connected LanPeer memberIds (admitted ∩ live)
}

const DROP = (reason: string): RoutePlan => ({ kind: 'drop', targets: [], reason });

/**
 * Decide where a TUN-egress frame goes. Parses + sanity-checks via lan-packet,
 * enforces src === OUR assigned vIP (anti-spoof — the local stack must only emit
 * frames from our own address), bounds the length to the SCTP no-fragment MTU,
 * then routes: unicast → the vIP's owning memberId (self-origin excluded);
 * broadcast / multicast → every connected peer except ourselves.
 */
export function planRoute(frame: Buffer, ctx: RouteCtx): RoutePlan {
  const h = parseIpv4(frame);
  if (!h) return DROP('bad-header');
  if (h.totalLength > LAN_MTU) return DROP('oversize');
  // Egress src-spoof guard: a frame the local stack emitted must carry OUR vIP.
  if (h.src !== (ctx.view.selfVip >>> 0)) return DROP('src-spoof');

  const cls = classifyDest(h.dst, ctx.subnetBroadcast);
  if (cls === 'unicast') {
    const owner = ctx.view.vipOwners.get(h.dst >>> 0);
    if (!owner) return DROP('no-route');
    if (owner === ctx.selfId) return DROP('self'); // never loop our own unicast back
    return { kind: 'unicast', targets: [owner] };
  }
  // Broadcast / multicast: replicate to every connected peer but ourselves
  // (self-origin drop — a replicated copy of our own frame must not return).
  const targets = ctx.peerIds.filter((id) => id !== ctx.selfId);
  if (targets.length === 0) return DROP('no-route');
  return { kind: cls, targets };
}

/**
 * Ingress guard: a frame received FROM `fromMemberId` over their data channel is
 * only injected into our TUN when its src equals that member's assigned vIP (the
 * routing table, already vIP-verified in the core). This rejects a peer spoofing
 * another member's source address and drops a self-origin echo. Returns
 * true = inject, false = drop. NEVER throws on hostile bytes.
 */
export function acceptInbound(frame: Buffer, fromMemberId: string, view: LanCoreView): boolean {
  const h = parseIpv4(frame);
  if (!h) return false;
  if (h.totalLength > LAN_MTU) return false;
  // The frame's source must be the vIP the routing table attributes to the peer
  // that sent it — otherwise it is spoofing another member's address.
  return view.vipOwners.get(h.src >>> 0) === fromMemberId;
}
