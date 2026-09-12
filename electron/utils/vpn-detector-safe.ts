/**
 * Safe VPN detection without command injection vulnerabilities
 * Uses native Node.js APIs instead of shell commands where possible
 */

import os from 'os';
import https from 'https';
import fs from 'fs/promises';
import { logger } from './logger';
import { VPN_IFACE_PATTERNS, selectVpnIPv4, VpnIfaceAddr } from '../../shared/vpn-bind';
import { isLanSessionAddressStr } from '../../shared/lan-ip';
import { lanSubnets } from '../lan/lan-net-registry';

const log = logger.child('VPN-Detector');

export interface VPNDetectionResult {
  isVPNActive: boolean;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  indicators: {
    vpnInterface: boolean;
    vpnDNS: boolean;
    vpnRoutes: boolean;
  };
  details: {
    detectedInterfaces: string[];
    publicIP?: string;
    localIP?: string;
    vpnProvider?: string;
  };
}

/**
 * Main VPN detection function
 */
export async function detectVPN(): Promise<VPNDetectionResult> {
  const indicators = {
    vpnInterface: false,
    vpnDNS: false,
    vpnRoutes: false,
  };

  const details: VPNDetectionResult['details'] = {
    detectedInterfaces: [],
  };

  try {
    // Check 1: Network interfaces
    const interfaceResult = checkVPNInterfaces();
    indicators.vpnInterface = interfaceResult.hasVPN;
    details.detectedInterfaces = interfaceResult.vpnInterfaces;
    details.vpnProvider = interfaceResult.provider;

    // Check 2: Public IP (for display only, not used as VPN indicator)
    try {
      details.publicIP = await getPublicIP();
      details.localIP = getLocalIP();
    } catch (error) {
      log.warn('Failed to get public IP', { error: String(error) });
    }

    // Check 3: DNS servers (platform-specific, safe implementation)
    try {
      indicators.vpnDNS = await checkVPNDNSSafe();
    } catch (error) {
      log.warn('Failed to check DNS', { error: String(error) });
    }

    // Check 4: Network routes (read from system files instead of shell)
    try {
      indicators.vpnRoutes = await checkVPNRoutesSafe();
    } catch (error) {
      log.warn('Failed to check routes', { error: String(error) });
    }

    // Calculate confidence
    const { isVPNActive, confidence } = calculateConfidence(indicators);

    return {
      isVPNActive,
      confidence,
      indicators,
      details,
    };
  } catch (error) {
    log.error('VPN detection failed', { error: String(error) });
    return {
      isVPNActive: false,
      confidence: 'unknown',
      indicators,
      details,
    };
  }
}

/**
 * Check network interfaces for VPN adapters (safe, no shell commands)
 */
function checkVPNInterfaces(): {
  hasVPN: boolean;
  vpnInterfaces: string[];
  provider?: string;
} {
  const interfaces = os.networkInterfaces();
  const vpnInterfaces: string[] = [];
  let provider: string | undefined;

  const vpnPatterns = VPN_IFACE_PATTERNS;

  const providerPatterns: Record<string, RegExp> = {
    'NordVPN': /nordlynx|nordvpn/i,
    'Mullvad': /mullvad/i,
    'ProtonVPN': /proton/i,
    'ExpressVPN': /expressvpn/i,
    'Surfshark': /surfshark/i,
    'WireGuard': /^wg\d+/i,
    'OpenVPN': /^(tun|tap)\d+/i,
  };

  const lanRanges = lanSubnets.list();

  for (const [name, addrs] of Object.entries(interfaces)) {
    // Exclude our own virtual LAN adapter by IP range
    if (lanRanges.length && Array.isArray(addrs) && addrs.some((a) =>
      (a.family === 'IPv4' || (a.family as unknown as number) === 4) &&
      isLanSessionAddressStr(a.address, lanRanges)
    )) {
      continue;
    }

    for (const pattern of vpnPatterns) {
      if (pattern.test(name)) {
        vpnInterfaces.push(name);

        // Detect provider
        if (!provider) {
          for (const [providerName, providerPattern] of Object.entries(providerPatterns)) {
            if (providerPattern.test(name)) {
              provider = providerName;
              break;
            }
          }
        }
        break;
      }
    }
  }

  return {
    hasVPN: vpnInterfaces.length > 0,
    vpnInterfaces,
    provider,
  };
}

/**
 * Get public IP address (safe HTTPS request)
 */
async function getPublicIP(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Public IP fetch timeout'));
    }, 5000);

    https.get('https://api.ipify.org', (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timeout);
        resolve(data.trim());
      });
    }).on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Get local IP address (safe, no shell commands)
 */
function getLocalIP(): string | undefined {
  const interfaces = os.networkInterfaces();

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;

    // Skip VPN interfaces, loopback, and virtual adapters
    if (
      /^(tun|tap|wg|utun|ppp|lo|vmnet|veth|docker)/i.test(name) ||
      name.includes('Virtual')
    ) {
      continue;
    }

    for (const addr of addrs) {
      if ((addr.family === 'IPv4' || (addr.family as unknown as number) === 4) && !addr.internal) {
        if (isLanSessionAddressStr(addr.address, lanSubnets.list())) continue;
        return addr.address;
      }
    }
  }

  return undefined;
}

/**
 * IPv4 of the first detected VPN adapter
 */
export function getVpnInterfaceIPv4(): VpnIfaceAddr | null {
  return selectVpnIPv4(os.networkInterfaces(), lanSubnets.list());
}

/**
 * SAFE DNS check - reads from system files instead of shell commands
 */
async function checkVPNDNSSafe(): Promise<boolean> {
  const platform = os.platform();

  try {
    let dnsServers: string[] = [];

    if (platform === 'linux') {
      // Read /etc/resolv.conf directly (safe, no shell)
      try {
        const content = await fs.readFile('/etc/resolv.conf', 'utf8');
        const matches = content.match(/nameserver\s+([\d.]+)/gi);
        if (matches) {
          dnsServers = matches.map(m => m.split(/\s+/)[1]);
        }
      } catch (error) {
        log.warn('Failed to read /etc/resolv.conf', { error: String(error) });
      }
    } else if (platform === 'win32') {
      // On Windows, use dns.getServers() from Node.js (safe)
      const dns = await import('dns').then(m => m.promises);
      try {
        dnsServers = dns.getServers();
      } catch (error) {
        log.warn('Failed to get DNS servers on Windows', { error: String(error) });
      }
    } else if (platform === 'darwin') {
      // On macOS, use dns.getServers() from Node.js (safe)
      const dns = await import('dns').then(m => m.promises);
      try {
        dnsServers = dns.getServers();
      } catch (error) {
        log.warn('Failed to get DNS servers on macOS', { error: String(error) });
      }
    }

    // Common VPN DNS servers
    const vpnDNSServers = [
      '10.', // Private network ranges commonly used by VPNs
      '172.16.', '172.17.', '172.18.', '172.19.', '172.20.',
      '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
      '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
      '192.168.',
      // Specific VPN DNS servers
      '103.86.96.', // NordVPN
      '103.86.99.', // NordVPN
      '10.8.0.',    // Common OpenVPN range
      '10.2.0.',    // ProtonVPN
    ];

    // Check if any DNS server matches VPN patterns
    for (const dns of dnsServers) {
      for (const vpnDNS of vpnDNSServers) {
        if (dns.startsWith(vpnDNS)) {
          return true;
        }
      }
    }
  } catch (error) {
    log.warn('Failed to check DNS servers', { error: String(error) });
  }

  return false;
}

/**
 * SAFE route check - reads from system files instead of shell commands
 */
async function checkVPNRoutesSafe(): Promise<boolean> {
  const platform = os.platform();

  try {
    let routeContent = '';

    if (platform === 'linux') {
      // Read /proc/net/route directly (safe, no shell)
      try {
        routeContent = await fs.readFile('/proc/net/route', 'utf8');
      } catch (error) {
        log.warn('Failed to read /proc/net/route', { error: String(error) });
        return false;
      }
    } else {
      // For Windows/macOS, we can't safely check routes without shell commands
      // Return false (don't use this indicator on these platforms)
      return false;
    }

    // Look for VPN-specific route patterns
    const vpnRoutePatterns = [
      /tun\d+/i,      // OpenVPN/WireGuard
      /tap\d+/i,      // OpenVPN bridged
      /ppp\d+/i,      // PPTP
      /wg\d+/i,       // WireGuard
    ];

    for (const pattern of vpnRoutePatterns) {
      if (pattern.test(routeContent)) {
        return true;
      }
    }
  } catch (error) {
    log.warn('Failed to check routes', { error: String(error) });
  }

  return false;
}

/**
 * Calculate VPN detection confidence
 */
function calculateConfidence(indicators: VPNDetectionResult['indicators']): {
  isVPNActive: boolean;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
} {
  const trueCount = Object.values(indicators).filter(Boolean).length;

  if (trueCount >= 2) {
    return { isVPNActive: true, confidence: 'high' };
  } else if (trueCount === 1) {
    return { isVPNActive: true, confidence: 'low' };
  } else {
    return { isVPNActive: false, confidence: 'high' };
  }
}

/**
 * Fetch IP geo info (safe HTTPS request)
 */
export function fetchIpGeo(ip: string): Promise<{
  country?: string;
  region?: string;
  city?: string;
  org?: string;
}> {
  return new Promise((resolve) => {
    const done = (v: { country?: string; region?: string; city?: string; org?: string }) => resolve(v);

    try {
      // Validate IP format to prevent injection
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
        log.warn('Invalid IP format', { ip });
        return done({});
      }

      const req = https.get(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, {
        headers: { 'User-Agent': 'Havvn', 'Accept': 'application/json' },
        timeout: 5000,
      }, (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          return done({});
        }

        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            done({
              country: j.country,
              region: j.region,
              city: j.city,
              org: j.org,
            });
          } catch {
            done({});
          }
        });
        res.on('error', () => done({}));
      });

      req.on('error', () => done({}));
      req.on('timeout', () => { req.destroy(); done({}); });
    } catch {
      done({});
    }
  });
}

/**
 * One-call privacy snapshot for the dashboard
 */
export async function getIpInfo(): Promise<{
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
  org?: string;
  vpnActive: boolean;
  vpnProvider?: string;
  confidence: VPNDetectionResult['confidence'];
  interfaces: string[];
  exposedIsp: boolean;
  fetchedAt: number;
}> {
  const vpn = await detectVPN();
  const ip = vpn.details.publicIP;
  const geo = ip ? await fetchIpGeo(ip) : {};
  const orgL = (geo.org || '').toLowerCase();

  const looksLikeVpnHost = /vpn|mullvad|nord|proton|express|hosting|datacenter|data center|m247|leaseweb|ovh|server|cloud|colo|host/.test(orgL);
  const vpnActive = vpn.isVPNActive || looksLikeVpnHost;
  const exposedIsp = !vpnActive && !!geo.org;

  return {
    ip,
    country: geo.country,
    region: geo.region,
    city: geo.city,
    org: geo.org,
    vpnActive,
    vpnProvider: vpn.details.vpnProvider,
    confidence: vpn.confidence,
    interfaces: vpn.details.detectedInterfaces,
    exposedIsp,
    fetchedAt: Date.now(),
  };
}
