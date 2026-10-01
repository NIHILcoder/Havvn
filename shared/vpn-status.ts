import { isVpnIfaceName, type VpnIfaceAddr } from './vpn-bind';
import { isLanSessionAddressStr, type ActiveLanSubnet } from './lan-ip';

export type VpnState = 'routed' | 'detected' | 'not-detected' | 'unknown';
export interface NetworkAdapterEvidence {
  name: string;
  description: string;
  index: number;
  up: boolean;
  metric: number;
  ipv4: string[];
}
export interface RouteEvidence { destination: string; index: number; metric: number }
export interface NetworkEvidence {
  adapters: NetworkAdapterEvidence[];
  routes: RouteEvidence[];
  routesKnown: boolean;
  ipv6Known: boolean;
  proxyConfigured: boolean | null;
}
export interface VpnAssessment {
  state: VpnState;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  interfaces: string[];
  routedInterface?: string;
  ipv6Bypass: boolean;
  bind: VpnIfaceAddr | null;
}

// These are route lookups, not network requests. Both IPv4 halves are checked.
export const VPN_ROUTE_PROBES = ['1.1.1.1', '9.9.9.9', '208.67.222.222'] as const;
export const VPN_IPV6_PROBES = ['2606:4700:4700::1111', '2620:fe::fe'] as const;

function addressBits(address: string): { bits: bigint; width: number } | null {
  const ip = address.split('%')[0];
  if (!ip.includes(':')) {
    const parts = ip.split('.');
    if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
    return { bits: parts.reduce((v, p) => (v << 8n) | BigInt(p), 0n), width: 32 };
  }
  let v6 = ip;
  if (v6.includes('.')) {
    const tail = v6.slice(v6.lastIndexOf(':') + 1);
    const v4 = addressBits(tail);
    if (!v4 || v4.width !== 32) return null;
    v6 = v6.slice(0, v6.lastIndexOf(':') + 1) + (v4.bits >> 16n).toString(16) + ':' + (v4.bits & 65535n).toString(16);
  }
  const halves = v6.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right];
  if (words.some(w => !/^[\da-f]{1,4}$/i.test(w))) return null;
  return { bits: words.reduce((v, w) => (v << 16n) | BigInt(parseInt(w, 16)), 0n), width: 128 };
}

/** Longest prefix first, then combined route/interface cost. Ties stay unknown. */
function bestRoute(evidence: NetworkEvidence, target: string): NetworkAdapterEvidence | null {
  const ip = addressBits(target)!;
  let prefix = -1;
  let cost = Infinity;
  let winners: NetworkAdapterEvidence[] = [];
  for (const route of evidence.routes) {
    const [network, length, extra] = route.destination.split('/');
    const subnet = addressBits(network);
    const n = Number(length);
    if (extra || length === undefined || !subnet || subnet.width !== ip.width || !Number.isInteger(n) || n < 0 || n > ip.width) continue;
    const shift = BigInt(ip.width - n);
    if ((ip.bits >> shift) !== (subnet.bits >> shift)) continue;
    const adapter = evidence.adapters.find(a => a.index === route.index && a.up);
    const c = route.metric + (adapter?.metric ?? 0);
    if (!adapter || !Number.isFinite(c) || c < 0) continue;
    if (n > prefix || (n === prefix && c < cost)) {
      prefix = n; cost = c; winners = [adapter];
    } else if (n === prefix && c === cost && !winners.includes(adapter)) winners.push(adapter);
  }
  return winners.length === 1 ? winners[0] : null;
}

export function isTunnelAdapter(adapter: NetworkAdapterEvidence): boolean {
  if (/havvn|torrenthunt/i.test(adapter.name + ' ' + adapter.description)) return false;
  return isVpnIfaceName(adapter.name) || /wireguard|wintun|openvpn|\btap\b|\btun\b|vpn|ikev2|sstp|pptp|l2tp|ipsec|neko(?:box|ray|tun)|sing[ -]?box|amnezia|hiddify/i.test(adapter.description);
}

/** Local routing evidence only: DNS, hosting ASN and IP country are not VPN signals. */
export function assessVpn(evidence: NetworkEvidence, excluded: readonly ActiveLanSubnet[] = []): VpnAssessment {
  const tunnels = evidence.adapters.filter(a => a.up && isTunnelAdapter(a) && !a.ipv4.some(ip => isLanSessionAddressStr(ip, excluded)) && a.ipv4.some(ip => {
    const parsed = addressBits(ip);
    return parsed?.width === 32 && !ip.startsWith('127.') && ip !== '0.0.0.0' && !isLanSessionAddressStr(ip, excluded);
  }));
  const base = { interfaces: tunnels.map(a => a.name), ipv6Bypass: false, bind: null };
  if (!evidence.routesKnown) return { ...base, state: tunnels.length ? 'detected' : 'unknown', confidence: tunnels.length ? 'low' : 'unknown' };
  const routes = VPN_ROUTE_PROBES.map(ip => bestRoute(evidence, ip));
  const selected = routes[0];
  const sameTunnel = !!selected && tunnels.includes(selected) && routes.every(a => a === selected);
  if (!sameTunnel) return { ...base, state: tunnels.length ? 'detected' : routes.every(Boolean) ? 'not-detected' : 'unknown', confidence: tunnels.length ? 'low' : routes.every(Boolean) ? 'medium' : 'unknown' };
  const v6 = VPN_IPV6_PROBES.map(ip => bestRoute(evidence, ip));
  const ipv6Bypass = v6.some(a => a && !isTunnelAdapter(a)) || (evidence.routes.some(r => r.destination === '::/0') && v6.some(a => !a));
  const address = selected.ipv4.find(ip => addressBits(ip)?.width === 32 && !ip.startsWith('127.') && ip !== '0.0.0.0' && !isLanSessionAddressStr(ip, excluded))!;
  return {
    ...base, routedInterface: selected.name, ipv6Bypass,
    state: evidence.ipv6Known && !ipv6Bypass ? 'routed' : 'detected',
    confidence: evidence.ipv6Known && !ipv6Bypass ? 'medium' : 'low',
    // Binding also blocks IPv6, so an IPv4 tunnel can still be used with a v6 bypass.
    bind: { iface: selected.name, address },
  };
}

export function shouldTripVpnGuard(state: VpnState, active: boolean): boolean {
  return state !== 'routed' && active;
}

export type PrivacyPosture = 'checking' | 'unknown' | 'protected' | 'caution' | 'exposed';
export function privacyPosture(state: VpnState | undefined, checking: boolean, killSwitch: boolean): PrivacyPosture {
  if (checking) return 'checking';
  if (!state || state === 'unknown') return 'unknown';
  if (state === 'not-detected') return 'exposed';
  return state === 'routed' && killSwitch ? 'protected' : 'caution';
}
