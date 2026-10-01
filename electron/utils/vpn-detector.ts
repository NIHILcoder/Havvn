import type { IpInfo, VPNDetectionResult } from '../../shared/types';
import { assessVpn } from '../../shared/vpn-status';
import { lanSubnets } from '../lan/lan-net-registry';
import { readNetworkEvidence, getRoutedVpnIPv4 } from './vpn-network';
import { getDirectPublicIp, getSystemPublicIp, fetchIpGeo } from './ip-probe';

export type { VPNDetectionResult } from '../../shared/types';
export { fetchIpGeo } from './ip-probe';

/** Local-only: the guard must never depend on a remote IP/geo service. */
export async function detectVPN(): Promise<VPNDetectionResult> {
  const network = await readNetworkEvidence();
  const vpn = assessVpn(network, lanSubnets.list());
  return {
    state: vpn.state, isVPNActive: vpn.state === 'routed', confidence: vpn.confidence,
    indicators: { vpnInterface: vpn.interfaces.length > 0, vpnDNS: false, vpnRoutes: !!vpn.routedInterface },
    details: { detectedInterfaces: vpn.interfaces, routedInterface: vpn.routedInterface,
      ipv6Bypass: vpn.ipv6Bypass, proxyConfigured: network.proxyConfigured },
  };
}

export function getVpnInterfaceIPv4() {
  return getRoutedVpnIPv4(lanSubnets.list());
}

/** IP geography describes the observed exit address, never the user's home. */
export async function getIpInfo(): Promise<IpInfo> {
  const [vpn, ip] = await Promise.all([detectVPN(), getDirectPublicIp()]);
  const [geo, proxyIp] = await Promise.all([
    fetchIpGeo(ip ?? ''), vpn.details.proxyConfigured ? getSystemPublicIp() : undefined,
  ]);
  const proxyGeo = proxyIp === ip ? geo : await fetchIpGeo(proxyIp ?? '');
  return {
    ...geo, ip, state: vpn.state, vpnActive: vpn.isVPNActive, confidence: vpn.confidence,
    interfaces: vpn.details.detectedInterfaces, routedInterface: vpn.details.routedInterface,
    ipv6Bypass: vpn.details.ipv6Bypass, proxyConfigured: vpn.details.proxyConfigured,
    proxyIp, proxyCountry: proxyGeo.country, fetchedAt: Date.now(),
  };
}
