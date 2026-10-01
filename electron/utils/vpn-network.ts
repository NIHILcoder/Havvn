import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { assessVpn, VPN_ROUTE_PROBES, VPN_IPV6_PROBES, type NetworkEvidence, type RouteEvidence } from '../../shared/vpn-status';
import type { ActiveLanSubnet } from '../../shared/lan-ip';

const execAsync = promisify(execFile);
const options = { timeout: 6000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' as const };

// Structured cmdlets avoid localized ipconfig/route output. This script is fixed,
// with no settings, addresses or other user-controlled shell interpolation.
const WINDOWS_SNAPSHOT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop)
$interfaces = @(Get-NetIPInterface -ErrorAction Stop)
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop)
$routes = @(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop)
$rows = @($interfaces | Where-Object AddressFamily -eq 'IPv4' | ForEach-Object {
  $i = $_
  $a = $adapters | Where-Object ifIndex -eq $i.InterfaceIndex | Select-Object -First 1
  $connected = @($interfaces | Where-Object { $_.InterfaceIndex -eq $i.InterfaceIndex -and $_.ConnectionState -eq 'Connected' }).Count -gt 0
  @{ name = $i.InterfaceAlias; description = [string]$a.InterfaceDescription; index = [int]$i.InterfaceIndex; up = $connected; metric = 0;
     ipv4 = @($ips | Where-Object { $_.InterfaceIndex -eq $i.InterfaceIndex -and $_.AddressState -eq 'Preferred' } | ForEach-Object IPAddress) }
})
$routeRows = @($routes | ForEach-Object {
  $r = $_
  $i = $interfaces | Where-Object { $_.InterfaceIndex -eq $r.InterfaceIndex -and $_.AddressFamily -eq $r.AddressFamily } | Select-Object -First 1
  @{ destination = $r.DestinationPrefix; index = [int]$r.InterfaceIndex; metric = ([int]$r.RouteMetric + [int]$i.InterfaceMetric) }
})
$proxy = $null
try {
  $p = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  $proxy = ($p.ProxyEnable -eq 1 -or [bool]$p.AutoConfigURL)
} catch {}
@{ adapters = $rows; routes = $routeRows; proxyConfigured = $proxy } | ConvertTo-Json -Depth 5 -Compress
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseWindowsEvidence(json: string): NetworkEvidence {
  const data: unknown = JSON.parse(json.replace(/^\uFEFF/, ''));
  if (!isRecord(data) || !Array.isArray(data.adapters) || !Array.isArray(data.routes)) throw new Error('Invalid network snapshot');
  return {
    adapters: data.adapters.flatMap((a: unknown) => {
      if (!isRecord(a) || typeof a.name !== 'string' || typeof a.index !== 'number' || !Number.isInteger(a.index) || !Array.isArray(a.ipv4)) return [];
      return [{ name: a.name, description: typeof a.description === 'string' ? a.description : '', index: a.index,
        up: a.up === true, metric: 0, ipv4: a.ipv4.filter((ip: unknown): ip is string => typeof ip === 'string') }];
    }),
    routes: data.routes.flatMap((r: unknown) => {
      if (!isRecord(r) || typeof r.destination !== 'string' || typeof r.index !== 'number' || !Number.isInteger(r.index) || typeof r.metric !== 'number' || !Number.isFinite(r.metric) || r.metric < 0) return [];
      return [{ destination: r.destination, index: r.index, metric: r.metric }];
    }),
    routesKnown: true, ipv6Known: true,
    proxyConfigured: typeof data.proxyConfigured === 'boolean' ? data.proxyConfigured : null,
  };
}

function fallbackEvidence(): NetworkEvidence {
  let interfaces: ReturnType<typeof os.networkInterfaces> = {};
  try { interfaces = os.networkInterfaces(); } catch { /* local evidence unavailable */ }
  const adapters = Object.entries(interfaces).map(([name, addresses], index) => ({
    name, description: '', index, metric: 0,
    up: !!addresses?.some(a => !a.internal),
    ipv4: (addresses ?? []).filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address),
  }));
  return { adapters, routes: [], routesKnown: false, ipv6Known: false, proxyConfigured: null };
}

async function collectPosix(evidence: NetworkEvidence): Promise<NetworkEvidence> {
  // route-get also respects Linux policy routing, unlike parsing only the main table.
  const results = await Promise.allSettled([...VPN_ROUTE_PROBES, ...VPN_IPV6_PROBES].map(async ip => {
    const v6 = ip.includes(':');
    let name: string | undefined;
    if (os.platform() === 'linux') {
      const { stdout } = await execAsync('ip', ['-j', v6 ? '-6' : '-4', 'route', 'get', ip], options);
      name = JSON.parse(stdout)[0]?.dev;
    } else {
      const { stdout } = await execAsync('/sbin/route', ['-n', 'get', ...(v6 ? ['-inet6'] : []), ip], options);
      name = stdout.match(/interface:\s*(\S+)/)?.[1];
    }
    const adapter = evidence.adapters.find(a => a.name === name);
    if (!adapter) throw new Error('Route interface unavailable');
    return { destination: `${ip}/${v6 ? 128 : 32}`, index: adapter.index, metric: 0 } satisfies RouteEvidence;
  }));
  const routes = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
  const noV6 = !Object.values(os.networkInterfaces()).some(addrs => addrs?.some(a => a.family === 'IPv6' && !a.internal && !/^fe80:/i.test(a.address)));
  return { ...evidence, routes, routesKnown: results.slice(0, VPN_ROUTE_PROBES.length).every(r => r.status === 'fulfilled'),
    ipv6Known: noV6 || results.slice(VPN_ROUTE_PROBES.length).every(r => r.status === 'fulfilled') };
}

async function collect(): Promise<NetworkEvidence> {
  try {
    if (os.platform() === 'win32') {
      const { stdout } = await execAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SNAPSHOT], options);
      return parseWindowsEvidence(stdout);
    }
    return await collectPosix(fallbackEvidence());
  } catch {
    // Missing permissions/tools are unknown, never a successful "no VPN" check.
    return fallbackEvidence();
  }
}

let cached: { evidence: NetworkEvidence; at: number } | undefined;
let pending: Promise<NetworkEvidence> | undefined;
export async function readNetworkEvidence(): Promise<NetworkEvidence> {
  if (cached && Date.now() - cached.at < 2000) return cached.evidence;
  if (!pending) pending = collect().then(evidence => {
    cached = { evidence, at: Date.now() };
    return evidence;
  }).finally(() => { pending = undefined; });
  return pending;
}

export async function getRoutedVpnIPv4(excluded: readonly ActiveLanSubnet[] = []) {
  return assessVpn(await readNetworkEvidence(), excluded).bind;
}
