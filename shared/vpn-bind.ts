/**
 * VPN engine binding — pure decision logic shared by the main process
 * (vpn-guard monitor) and the torrent-host utilityProcess (native engine
 * startup). No Node/Electron imports, so vitest runs it directly and either
 * process can pull it in without dragging module side effects along.
 *
 * The bind itself is transmission's `bind-address-ipv4` settings.json key: the
 * daemon opens every peer socket from that address, so when the VPN drops the
 * sockets die at the OS level — traffic physically cannot fall back to the real
 * interface (unlike the reactive kill-switch, which detects and then pauses).
 */

import type { VpnBindStatus } from './types';
import { isLanSessionAddressStr, type ActiveLanSubnet } from './lan-ip';

/**
 * Interface-name patterns that identify VPN adapters. Single source of truth —
 * vpn-detector's interface check uses this same list, so detection and binding
 * can never disagree about what counts as a VPN adapter.
 */
export const VPN_IFACE_PATTERNS: readonly RegExp[] = [
  /^tun/i,        // OpenVPN, WireGuard
  /^tap/i,        // OpenVPN bridged mode
  /^wg/i,         // WireGuard
  /^utun/i,       // macOS VPN
  /^ppp/i,        // PPTP VPN
  /^ipsec/i,      // IPSec VPN
  /^l2tp/i,       // L2TP VPN
  /vpn/i,         // Generic VPN
  /nordlynx/i,    // NordVPN
  /mullvad/i,     // Mullvad VPN
  /proton/i,      // ProtonVPN
  /expressvpn/i,  // ExpressVPN
  /surfshark/i,   // Surfshark
];

export function isVpnIfaceName(name: string): boolean {
  return VPN_IFACE_PATTERNS.some((p) => p.test(name));
}

export interface VpnIfaceAddr {
  iface: string;
  address: string;
}

/** Shape-compatible with os.networkInterfaces() (family is 'IPv4' in modern Node, 4 in older). */
type IfaceMap = Record<string, ReadonlyArray<{ family: string | number; address: string; internal: boolean }> | undefined>;

/**
 * Pick the address transmission should bind to: the first non-internal IPv4 on
 * a VPN-pattern-matched interface. Null when no VPN adapter carries an IPv4 —
 * the caller then falls back to loopback (fail-closed), never to a real NIC.
 *
 * `excludeSubnets` (must-fix #8) are the ACTIVE LAN session /16s: an address
 * inside one is OUR virtual adapter, never a VPN — skip it so a renamed-VPN-ish
 * LAN adapter is not masked and our own 100.64 address is never picked as the
 * bind target. Default [] preserves the pre-LAN behaviour exactly.
 */
export function selectVpnIPv4(ifaces: IfaceMap, excludeSubnets: readonly ActiveLanSubnet[] = []): VpnIfaceAddr | null {
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs || !isVpnIfaceName(name)) continue;
    for (const a of addrs) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) {
        if (excludeSubnets.length && isLanSessionAddressStr(a.address, excludeSubnets)) continue; // our own LAN /16
        return { iface: name, address: a.address };
      }
    }
  }
  return null;
}

/**
 * settings.json keys for the bind (only while the feature is enabled).
 * IPv6 is pinned to loopback unconditionally: an IPv4-only bind would leave
 * IPv6 peers as a leak path around the VPN.
 */
export function resolveBindOverrides(vpn: { address: string } | null): Record<string, unknown> {
  return {
    'bind-address-ipv4': vpn?.address ?? '127.0.0.1',
    'bind-address-ipv6': '::1',
  };
}

export type BindAction = 'none' | 'rebind' | 'lost' | 'restored';

/**
 * One monitor-tick decision. `status` is what the RUNNING engine is bound to,
 * `currentIp` is the VPN adapter's IPv4 right now (null = no VPN detected),
 * `lostLatched` is the guard's "already warned about this outage" latch.
 *
 * - rebind:   a VPN IPv4 exists and differs from the bound one — covers both
 *             "VPN appeared after a loopback-fallback start" and "provider
 *             moved us to a new address". Requires an engine restart
 *             (bind-address-ipv4 is read only at daemon startup).
 * - lost:     bound to a real address that just vanished. Sockets are already
 *             dead (that is the feature working); warn once.
 * - restored: the same address came back after a loss. Outgoing sockets could
 *             bind again on their own, but the daemon's LISTENING socket died
 *             with the interface and is never re-bound mid-run — the guard
 *             restarts the engine for this case too; the distinct action only
 *             lets callers message it accurately.
 */
export function planBindAction(
  status: Pick<VpnBindStatus, 'enabled' | 'boundIp'> | null,
  currentIp: string | null,
  lostLatched: boolean,
): BindAction {
  if (!status?.enabled) return 'none';
  if (currentIp) {
    if (currentIp === status.boundIp) return lostLatched ? 'restored' : 'none';
    return 'rebind';
  }
  return status.boundIp && !lostLatched ? 'lost' : 'none';
}
