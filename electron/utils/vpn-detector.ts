/**
 * VPN Detection Module
 *
 * Detects if the user is connected to a VPN by analyzing:
 * 1. Network interfaces (looking for VPN adapters like tun, tap, wg)
 * 2. Public IP vs Local IP comparison
 * 3. DNS server configuration
 * 4. Network routes (VPN typically adds specific routes)
 */

import os from 'os';
import { dialog } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import https from 'https';
import { logger } from './logger';

const execAsync = promisify(exec);

export interface VPNDetectionResult {
  isVPNActive: boolean;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  indicators: {
    vpnInterface: boolean;
    ipMismatch: boolean;
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
    ipMismatch: false,
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

    // Check 2: Public IP vs Local IP
    try {
      const publicIP = await getPublicIP();
      const localIP = getLocalIP();
      details.publicIP = publicIP;
      details.localIP = localIP;

      // If IPs differ significantly, likely using VPN
      indicators.ipMismatch = publicIP !== localIP;
    } catch (error) {
      logger.warn('Failed to check IP mismatch:', error instanceof Error ? error.message : String(error));
    }

    // Check 3: DNS servers (VPN providers use specific DNS)
    try {
      indicators.vpnDNS = await checkVPNDNS();
    } catch (error) {
      logger.warn('Failed to check DNS:', error instanceof Error ? error.message : String(error));
    }

    // Check 4: Network routes (platform-specific)
    try {
      indicators.vpnRoutes = await checkVPNRoutes();
    } catch (error) {
      logger.warn('Failed to check routes:', error instanceof Error ? error.message : String(error));
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
    logger.error('VPN detection failed:', error instanceof Error ? error.message : String(error));
    return {
      isVPNActive: false,
      confidence: 'unknown',
      indicators,
      details,
    };
  }
}

/**
 * Check network interfaces for VPN adapters
 */
function checkVPNInterfaces(): {
  hasVPN: boolean;
  vpnInterfaces: string[];
  provider?: string;
} {
  const interfaces = os.networkInterfaces();
  const vpnInterfaces: string[] = [];
  let provider: string | undefined;

  // Common VPN interface patterns
  const vpnPatterns = [
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

  // VPN provider detection
  const providerPatterns: Record<string, RegExp> = {
    'NordVPN': /nordlynx|nordvpn/i,
    'Mullvad': /mullvad/i,
    'ProtonVPN': /proton/i,
    'ExpressVPN': /expressvpn/i,
    'Surfshark': /surfshark/i,
    'WireGuard': /^wg\d+/i,
    'OpenVPN': /^(tun|tap)\d+/i,
  };

  for (const [name] of Object.entries(interfaces)) {
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
 * Get public IP address
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
 * Get local IP address
 */
function getLocalIP(): string | undefined {
  const interfaces = os.networkInterfaces();

  // Try to get primary network interface IP
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
      // IPv4, not internal
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }

  return undefined;
}

/**
 * Check if VPN DNS servers are being used
 */
async function checkVPNDNS(): Promise<boolean> {
  const platform = os.platform();

  try {
    let dnsServers: string[] = [];

    if (platform === 'win32') {
      // Windows: Use ipconfig /all
      const { stdout } = await execAsync('ipconfig /all');
      const dnsMatches = stdout.match(/DNS Servers.*?:\s*([\d.]+)/gi);
      if (dnsMatches) {
        dnsServers = dnsMatches.map(m => m.split(':')[1].trim());
      }
    } else if (platform === 'darwin') {
      // macOS: Use scutil
      const { stdout } = await execAsync('scutil --dns');
      const dnsMatches = stdout.match(/nameserver\[\d+]\s*:\s*([\d.]+)/gi);
      if (dnsMatches) {
        dnsServers = dnsMatches.map(m => m.split(':')[1].trim());
      }
    } else if (platform === 'linux') {
      // Linux: Check /etc/resolv.conf
      const { stdout } = await execAsync('cat /etc/resolv.conf');
      const dnsMatches = stdout.match(/nameserver\s+([\d.]+)/gi);
      if (dnsMatches) {
        dnsServers = dnsMatches.map(m => m.split(/\s+/)[1]);
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
    logger.warn('Failed to check DNS servers:', error instanceof Error ? error.message : String(error));
  }

  return false;
}

/**
 * Check for VPN-specific routes
 */
async function checkVPNRoutes(): Promise<boolean> {
  const platform = os.platform();

  try {
    let routeOutput = '';

    if (platform === 'win32') {
      const { stdout } = await execAsync('route print');
      routeOutput = stdout;
    } else if (platform === 'darwin' || platform === 'linux') {
      const { stdout } = await execAsync('netstat -rn');
      routeOutput = stdout;
    }

    // Look for VPN-specific route patterns
    const vpnRoutePatterns = [
      /utun\d+/i,     // macOS VPN
      /tun\d+/i,      // OpenVPN/WireGuard
      /tap\d+/i,      // OpenVPN bridged
      /ppp\d+/i,      // PPTP
      /wg\d+/i,       // WireGuard
      /10\.8\.0\./,   // Common OpenVPN range
      /10\.2\.0\./,   // ProtonVPN
    ];

    for (const pattern of vpnRoutePatterns) {
      if (pattern.test(routeOutput)) {
        return true;
      }
    }
  } catch (error) {
    logger.warn('Failed to check routes:', error instanceof Error ? error.message : String(error));
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

  if (trueCount >= 3) {
    return { isVPNActive: true, confidence: 'high' };
  } else if (trueCount === 2) {
    return { isVPNActive: true, confidence: 'medium' };
  } else if (trueCount === 1) {
    return { isVPNActive: true, confidence: 'low' };
  } else {
    return { isVPNActive: false, confidence: 'high' };
  }
}

/**
 * Resolve geo/ISP details for a public IP via ipinfo.io (HTTPS, no key needed
 * for basic lookups). Best-effort — returns {} on any failure so the privacy
 * dashboard degrades gracefully. Only called when the user opens the Privacy
 * tab or hits Refresh, so it adds no background traffic.
 */
export function fetchIpGeo(ip: string): Promise<{ country?: string; region?: string; city?: string; org?: string }> {
  return new Promise((resolve) => {
    const done = (v: { country?: string; region?: string; city?: string; org?: string }) => resolve(v);
    try {
      const req = https.get(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, {
        headers: { 'User-Agent': 'TorrentHunt', 'Accept': 'application/json' },
        timeout: 5000,
      }, (res) => {
        if (!res.statusCode || res.statusCode >= 400) { res.resume(); return done({}); }
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            done({ country: j.country, region: j.region, city: j.city, org: j.org });
          } catch { done({}); }
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
 * One-call privacy snapshot for the dashboard: VPN detection + geo/ISP of the
 * public IP. `exposedIsp` flags the likely-leak case where the torrent-facing
 * IP resolves to a consumer ISP rather than a VPN/hosting provider while no VPN
 * is detected — most clients never surface this.
 */
export async function getIpInfo(): Promise<{
  ip?: string; country?: string; region?: string; city?: string; org?: string;
  vpnActive: boolean; vpnProvider?: string; confidence: VPNDetectionResult['confidence'];
  interfaces: string[]; exposedIsp: boolean; fetchedAt: number;
}> {
  const vpn = await detectVPN();
  const ip = vpn.details.publicIP;
  const geo = ip ? await fetchIpGeo(ip) : {};
  // Heuristic leak signal: no VPN detected AND the IP belongs to an org that
  // doesn't look like a VPN/hosting provider.
  const orgL = (geo.org || '').toLowerCase();
  const looksLikeVpnHost = /vpn|mullvad|nord|proton|express|hosting|datacenter|data center|m247|leaseweb|ovh|server|cloud|colo|host/.test(orgL);
  const exposedIsp = !vpn.isVPNActive && !!geo.org && !looksLikeVpnHost;
  return {
    ip,
    country: geo.country,
    region: geo.region,
    city: geo.city,
    org: geo.org,
    vpnActive: vpn.isVPNActive,
    vpnProvider: vpn.details.vpnProvider,
    confidence: vpn.confidence,
    interfaces: vpn.details.detectedInterfaces,
    exposedIsp,
    fetchedAt: Date.now(),
  };
}

/**
 * Show VPN warning dialog
 * Note: Translation keys are passed to renderer for i18n support
 */
export function showVPNWarning(result: VPNDetectionResult): void {

  // Send localized warning via IPC (translations handled in renderer)
  const warningData = {
    type: 'vpn-warning',
    result,
  };

  // For now, show English version (will be replaced with i18n in main process)
  const message = 'VPN not detected! Your real IP address may be visible to peers.';
  let detail = 'Consider using a VPN for better privacy when using BitTorrent.\n\n';

  if (result.details.publicIP) {
    detail += `Your public IP: ${result.details.publicIP}\n`;
  }

  detail += '\nRecommended VPN providers:\n';
  detail += '• Mullvad VPN (anonymous, no logs)\n';
  detail += '• ProtonVPN (secure, privacy-focused)\n';
  detail += '• IVPN (privacy-first)\n';

  dialog.showMessageBox({
    type: 'warning',
    title: 'Privacy Warning',
    message,
    detail,
    buttons: ['OK', 'Don\'t show again'],
    defaultId: 0,
    cancelId: 1,
  });
}
