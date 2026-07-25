/**
 * Process-global registry of the currently-active virtual-LAN /16 subnets — the
 * ONE mutable bridge between the LAN feature and every VPN/address surface
 * (plan §0.1 #8). Written ONLY by LanManager on session start/stop; read
 * (never written) by shared/vpn-bind's callers (vpn-detector, cast-server) so a
 * running LAN session's 100.64 address is excluded BY RANGE — never mistaken for
 * a VPN (which would suspend networking) and never advertised as a reachable IP.
 *
 * Beta holds ≤1 entry (single-active-session invariant), but the shape is a list
 * so Phase-2 N-adapters is a non-break. Plain node module — no browser globals at
 * import time — so it is safe to import from main and from vitest.
 */
import { sessionSubnet, type ActiveLanSubnet } from '../../shared/lan-ip';

export type { ActiveLanSubnet };

const active = new Map<string, ActiveLanSubnet>();

export const lanSubnets = {
  /** Immutable snapshot for the VPN/address readers. */
  list(): readonly ActiveLanSubnet[] {
    return Array.from(active.values());
  },
  /** Register (idempotent by sessionId) a session's /16 as active. */
  set(sessionId: string): void {
    if (!sessionId) return;
    active.set(sessionId, { sessionId, subnet: sessionSubnet(sessionId) });
  },
  /** Drop one session's /16. */
  clear(sessionId: string): void {
    active.delete(sessionId);
  },
  /** Teardown backstop (cleanup/destroy/suspend) — a crashed start must never
   *  leave a phantom exclusion that hides a real VPN. */
  clearAll(): void {
    active.clear();
  },
};
