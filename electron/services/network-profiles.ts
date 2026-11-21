/**
 * Smart network profiles.
 *
 * Detects which network the machine is on (keyed by the default gateway's MAC —
 * stable across reconnects, works wired and wireless) and, when a matching
 * profile exists, applies that profile's settings overlay LIVE: speed limits,
 * connection cap, adaptive throttle, DoH. The overlay is non-destructive — it
 * pushes effective values to the engine only and never overwrites the user's
 * base settings, so leaving the network (or a network with no profile) restores
 * the base automatically.
 *
 * Example: "Home → full speed; Phone hotspot → 200 KB/s + DoH on + no adaptive."
 * No mainstream client does per-network automation; this is unique to us.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { BrowserWindow } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../db/store';
import { logger } from '../utils';
import { NetworkInfo, NetworkProfile } from '../../shared/types';
import { getTorrentManager } from '../torrent';

const execAsync = promisify(exec);
const log = logger.child('NetworkProfiles');

const POLL_MS = 15000;

let timer: NodeJS.Timeout | null = null;
let mainWindow: BrowserWindow | null = null;
let lastKey: string | null = null;          // last network key we applied for
let activeProfileId: string | null = null;  // profile currently in effect ('' base)
let lastInfo: NetworkInfo = { key: '', label: '' };
let generation = 0;

export function setMainWindow(win: BrowserWindow): void { mainWindow = win; }

function normalizeMac(mac?: string | null): string {
  return (mac || '').toLowerCase().replace(/[^a-f0-9]/g, '');
}

// ── Detection (platform-specific; best-effort, never throws to the caller) ───
export async function detectNetwork(): Promise<NetworkInfo> {
  try {
    if (process.platform === 'win32') return await detectWindows();
    if (process.platform === 'darwin') return await detectMac();
    return await detectLinux();
  } catch (e) {
    log.warn('Network detection failed', { error: e instanceof Error ? e.message : String(e) });
    return { key: '', label: '' };
  }
}

async function detectWindows(): Promise<NetworkInfo> {
  const ps = [
    "$gw=(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop;",
    "$mac=$null; if($gw){$mac=(Get-NetNeighbor -IPAddress $gw -ErrorAction SilentlyContinue | Select-Object -First 1).LinkLayerAddress};",
    "$p=Get-NetConnectionProfile -ErrorAction SilentlyContinue | Select-Object -First 1;",
    "$ssid=$null; try{$l=(netsh wlan show interfaces | Select-String '^\\s*SSID\\s*:' | Select-Object -First 1); if($l){$ssid=($l.ToString() -split ':',2)[1].Trim()}}catch{};",
    "ConvertTo-Json -Compress @{gatewayIp=$gw;mac=$mac;name=$p.Name;iface=$p.InterfaceAlias;ssid=$ssid}",
  ].join(' ');
  const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`, { timeout: 8000, windowsHide: true });
  const j = JSON.parse(stdout.trim() || '{}');
  return toInfo(j.mac, j.ssid, j.name, j.iface, j.gatewayIp);
}

async function detectMac(): Promise<NetworkInfo> {
  const { stdout: route } = await execAsync('route -n get default 2>/dev/null', { timeout: 6000 });
  const gw = (route.match(/gateway:\s*([\d.]+)/) || [])[1];
  let mac: string | undefined;
  if (gw) {
    const { stdout: arp } = await execAsync(`arp -n ${gw} 2>/dev/null`, { timeout: 6000 });
    mac = (arp.match(/([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/i) || [])[1];
  }
  let ssid: string | undefined;
  try {
    const { stdout } = await execAsync("/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I 2>/dev/null", { timeout: 6000 });
    ssid = (stdout.match(/\bSSID:\s*(.+)/) || [])[1]?.trim();
  } catch { /* not on Wi-Fi */ }
  return toInfo(mac, ssid, undefined, undefined, gw);
}

async function detectLinux(): Promise<NetworkInfo> {
  const { stdout: route } = await execAsync('ip route get 1.1.1.1 2>/dev/null', { timeout: 6000 });
  const gw = (route.match(/via\s+([\d.]+)/) || [])[1];
  const dev = (route.match(/dev\s+(\S+)/) || [])[1];
  let mac: string | undefined;
  if (gw) {
    const { stdout: neigh } = await execAsync(`ip neigh show ${gw} 2>/dev/null`, { timeout: 6000 });
    mac = (neigh.match(/lladdr\s+([0-9a-f:]+)/i) || [])[1];
  }
  let ssid: string | undefined;
  try { const { stdout } = await execAsync('iwgetid -r 2>/dev/null', { timeout: 4000 }); ssid = stdout.trim() || undefined; } catch { /* not Wi-Fi */ }
  return toInfo(mac, ssid, undefined, dev, gw);
}

function toInfo(mac?: string, ssid?: string, name?: string, iface?: string, gatewayIp?: string): NetworkInfo {
  const key = normalizeMac(mac);
  const label = (ssid || name || iface || (gatewayIp ? `Network ${gatewayIp}` : 'Network')).toString();
  return { key, label, gatewayIp: gatewayIp || undefined, ssid: ssid || undefined, iface: iface || undefined };
}

// ── Apply ────────────────────────────────────────────────────────────────────
/** Push the effective (base + overlay) engine settings live. Never writes base. */
async function applyEffective(profile: NetworkProfile | null): Promise<void> {
  try {
    await getTorrentManager().setNetworkProfile(profile);
  } catch (e) {
    log.warn('Failed to apply effective settings', { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Re-evaluate the current network and apply the matching profile (or base). */
export async function applyForCurrentNetwork(force = false): Promise<void> {
  const revision = ++generation;
  const settings = await db.getSettings();
  const info = await detectNetwork();
  if (revision !== generation) return;
  lastInfo = info;

  if (settings.networkProfilesEnabled !== true) {
    // Feature off → ensure base settings are in effect, drop any active overlay.
    if (activeProfileId !== null) { activeProfileId = null; await applyEffective(null); broadcast(); }
    lastKey = info.key;
    return;
  }

  if (!force && info.key === lastKey) return; // same network, nothing to do
  lastKey = info.key;

  const profiles = db.getNetworkProfiles();
  const match = info.key ? profiles.find((p) => p.networkKey === info.key) || null : null;
  // Keep the matched profile's friendly label fresh for the UI.
  if (match && info.label && match.networkLabel !== info.label) {
    db.saveNetworkProfile({ ...match, networkLabel: info.label });
  }
  activeProfileId = match?.id ?? null;
  await applyEffective(match);
  log.info('Network profile applied', { network: info.label, profile: match?.name || '(base settings)' });
  broadcast();
}

function broadcast(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('network:profileChanged', { current: lastInfo, activeId: activeProfileId });
  }
}

// ── Lifecycle + public API ───────────────────────────────────────────────────
export function startNetworkProfiles(win: BrowserWindow): void {
  mainWindow = win;
  void applyForCurrentNetwork(true);
  if (!timer) timer = setInterval(() => void applyForCurrentNetwork(false), POLL_MS);
  log.info('Network-profile monitor started');
}

export function stopNetworkProfiles(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export async function getProfilesState(): Promise<{ profiles: NetworkProfile[]; activeId: string | null; current: NetworkInfo }> {
  const current = await detectNetwork();
  lastInfo = current;
  return { profiles: db.getNetworkProfiles(), activeId: activeProfileId, current };
}

export function saveProfile(p: NetworkProfile): NetworkProfile {
  const profile: NetworkProfile = { ...p, id: p.id || ('net-' + uuidv4().slice(0, 8)) };
  db.saveNetworkProfile(profile);
  void applyForCurrentNetwork(true);
  return profile;
}

export function deleteProfile(id: string): { ok: boolean } {
  db.deleteNetworkProfile(id);
  void applyForCurrentNetwork(true);
  return { ok: true };
}
