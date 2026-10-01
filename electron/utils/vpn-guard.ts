/**
 * VPN Kill-Switch / Guard + engine VPN-bind monitor.
 *
 * Kill-switch (PrivacyConfig.vpnKillSwitch): periodically re-checks VPN status
 * while torrents are active. If tunnel routing is missing or uncertain it pauses
 * ALL active torrents and room networking, fires an OS
 * notification, and tells the renderer to show a warning banner. Resume is
 * manual by design (the user decides when it's safe).
 *
 * Bind monitor (PrivacyConfig.vpnBindEngine, native engine only): the engine's
 * peer sockets are hard-bound to the VPN adapter's IPv4 (see shared/vpn-bind).
 * The daemon reads bind-address-* once at startup, so ANY address change —
 * including the same address coming back after a drop, which does NOT revive
 * the daemon's listening socket — is applied via a full engine restart
 * (manager.restartEngine), debounced against VPN flaps. Losing the route also
 * restarts into loopback fallback: an adapter can remain up after losing routes.
 */

import { BrowserWindow } from 'electron';
import { detectVPN, getVpnInterfaceIPv4 } from './vpn-detector';
import { planBindAction } from '../../shared/vpn-bind';
import { shouldTripVpnGuard } from '../../shared/vpn-status';
import { logger } from './logger';
import { showOsNotification } from './os-notify';
import * as db from '../db/store';
import { getTorrentManager } from '../torrent';
import { getRoomManager } from '../sharing/room-manager';
import { t } from '../i18n';

const log = logger.child('VPNGuard');

const CHECK_INTERVAL_MS = 5_000;
// Re-bind debounce: the new address must survive 2 consecutive ticks, and
// engine restarts are at least a minute apart — a flapping VPN reconnect must
// not turn into a restart storm that kills active streams over and over.
const REBIND_MIN_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let generation = 0;
let mainWindowRef: BrowserWindow | null = null;

// Kill-switch state
let killSwitchOn = false;
let tripped = false;                       // already auto-paused this outage

// Bind-monitor state
let bindOn = false;
let bindLost = false;                      // warned about the current outage
let pendingRebindIp: string | null = null; // debounce: candidate IP from the previous tick
let lastRebindAt = 0;
let rebindInProgress = false;

export function initVpnGuard(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow;
  // Re-evaluate whenever settings might have changed or on start
  void restartGuardFromConfig();
}

/** (Re)start or stop the guard loop based on the persisted privacy config. */
export async function restartGuardFromConfig(): Promise<void> {
  stopVpnGuard();
  const revision = generation;
  let killSwitch = false;
  let bind = false;
  try {
    const cfg = await db.getPrivacyConfig();
    killSwitch = cfg.vpnKillSwitch === true;
    // Monitor the bind when the RUNNING engine is bound (the truth for this
    // session — survives the toggle being flipped off before a restart), OR
    // when the toggle is on for the native engine (covers a host crash-respawn
    // silently adopting the new config mid-session).
    const runningBound = getTorrentManager().getVpnBindStatus()?.enabled === true;
    bind = runningBound || (cfg.vpnBindEngine === true && db.getEngineChoice() === 'native');
  } catch (error) {
    killSwitch = killSwitchOn;
    bind = bindOn;
    log.error('Privacy config unavailable — preserving running guard settings', { error: String(error) });
  }

  if (revision !== generation) return;
  const killSwitchChanged = killSwitch !== killSwitchOn;
  const bindChanged = bind !== bindOn;
  killSwitchOn = killSwitch;
  bindOn = bind;
  // Kill-switch turned OFF: the user opted out of protection, so un-freeze any
  // rooms the switch had suspended — otherwise they stay dark forever (the guard
  // that would revive them on VPN-restore is now gone). Idempotent: no-op if
  // nothing is suspended. Also clear the trip latch so it re-arms cleanly if
  // re-enabled.
  if (killSwitchChanged && !killSwitch) {
    tripped = false;
    try { await getRoomManager().resumeNetworking(); } catch (e) { log.error('Room resume on kill-switch disable failed', { error: e instanceof Error ? e.message : String(e) }); }
  }
  if (revision !== generation) return;
  if (!killSwitchOn && !bindOn) {
    log.info('VPN guard disabled');
    return;
  }

  log.info('VPN guard enabled', { killSwitch: killSwitchOn, bind: bindOn });
  // Reset per-feature state only when that feature's enablement flipped —
  // toggling one must not wipe the other's in-progress outage latch (a tripped
  // kill-switch would otherwise re-pause / lose its "restored" edge).
  if (killSwitchChanged) {
    tripped = false;
  }
  if (bindChanged) {
    bindLost = false;
    pendingRebindIp = null;
  }
  // Never let two ticks overlap: a slow detectVPN() could otherwise let a later
  // tick's resume run before an earlier tick's suspend finishes, leaving a room
  // in the wrong state. runTick serializes them.
  timer = setInterval(() => { void runTick(); }, CHECK_INTERVAL_MS);
  // Run one check shortly after enabling
  initialTimer = setTimeout(() => { initialTimer = null; void runTick(); }, 2_000);
}

export function stopVpnGuard(): void {
  generation++;
  if (initialTimer) { clearTimeout(initialTimer); initialTimer = null; }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

let tickRunning = false;
/** Serialize ticks so suspend/resume can never interleave out of order. */
async function runTick(): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try { await tick(generation); } finally { tickRunning = false; }
}

async function tick(revision: number): Promise<void> {
  // Both checks use the same short-lived local route snapshot, with no geo lookup.
  if (bindOn) {
    try {
      await tickBind(revision);
    } catch (e) {
      log.error('VPN bind tick failed', { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (killSwitchOn && revision === generation) {
    try {
      await tickKillSwitch(revision);
    } catch (e) {
      log.error('VPN guard tick failed', { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ── Kill-switch ──────────────────────────────────────────────────────────────
async function tickKillSwitch(revision: number): Promise<void> {
  // Only act when there is something to protect
  const manager = getTorrentManager();
  const downloads = await manager.getDownloads();
  const hasActive = downloads.some(
    d => d.status === 'downloading' || d.status === 'queued' || d.status === 'seeding'
  );

  const result = await detectVPN();
  // The kill-switch could have been disabled WHILE this tick awaited detectVPN()
  // (restartGuardFromConfig runs on a settings change and already resumed rooms +
  // reset the latches). A stale tick must not act on that reset state and
  // re-suspend rooms with no timer left to ever revive them.
  if (!killSwitchOn || revision !== generation) return;
  const vpnActive = result.isVPNActive;

  // Tunnel route missing or unconfirmed, with activity to protect.
  // Rooms seed over their OWN WebTorrent clients in a separate engine window, so
  // pausing torrents alone still leaks the real IP through every active room —
  // check for room activity too, not just downloads.
  const hasRooms = (() => { try { return db.getPersistedRooms().length > 0; } catch { return false; } })();

  // Also pause activity started/resumed while the route was already unsafe.
  if (shouldTripVpnGuard(result.state, hasActive || hasRooms) && (hasActive || !tripped)) {
    tripped = true;
    const count = await manager.pauseAllActive();
    // The kill-switch may have been disabled DURING pauseAllActive() (a manual
    // toggle racing this drop). If so, don't suspend rooms — the disable path
    // already ran resumeNetworking() as a no-op (nothing was suspended yet) and
    // cleared the timer, so suspending here would freeze rooms with nothing left
    // to ever revive them. Torrents already paused is harmless (manual resume).
    if (!killSwitchOn || revision !== generation) return;
    // Fail closed: also tear down every room's networking (the kill-switch used
    // to cover only the torrent engine).
    try { await getRoomManager().suspendNetworking(); } catch (e) { log.error('Room suspend on VPN drop failed', { error: e instanceof Error ? e.message : String(e) }); }
    if (revision !== generation) return;
    log.warn('Tunnel route unconfirmed — paused torrents + suspended rooms', { paused: count, state: result.state });
    showOsNotification(
      t('notify.vpnLost.title'),
      count > 0
        ? t(count === 1 ? 'notify.vpnLost.bodyOne' : 'notify.vpnLost.bodyMany', { count })
        : hasRooms ? t('notify.vpnLost.bodyRooms') : t('notify.vpnLost.bodyNone'),
      { critical: true },
    );
    sendToRenderer('app:vpnDropped', { paused: count, rooms: hasRooms, state: result.state });
  }

  // VPN restored: clear the tripped latch so a future drop trips again.
  // Torrent resume stays MANUAL (the user decides when it's safe), but rooms
  // auto-revive — the VPN is confirmed back here, so it's safe, and a room left
  // dark with no obvious "reconnect" is worse than a paused download.
  if (result.state === 'routed' && vpnActive && tripped) {
    tripped = false;
    try { await getRoomManager().resumeNetworking(); } catch (e) { log.error('Room resume on VPN restore failed', { error: e instanceof Error ? e.message : String(e) }); }
    log.info('VPN restored — torrents stay paused (manual), rooms revived');
    sendToRenderer('app:vpnRestored', {});
  }

}

// ── Engine bind monitor ──────────────────────────────────────────────────────
async function tickBind(revision: number): Promise<void> {
  if (rebindInProgress) return;
  const manager = getTorrentManager();
  const status = manager.getVpnBindStatus(); // running engine's bind, mirrored from the host
  if (!status?.enabled) return;              // nothing bound — skip the interface scan
  const current = await getVpnInterfaceIPv4();
  if (revision !== generation || !bindOn) return;
  const action = planBindAction(status, current?.address ?? null, bindLost);

  switch (action) {
    // 'restored' (same address back after a loss) restarts too: the daemon's
    // LISTENING socket died with the interface and is never re-bound mid-run,
    // so without a restart incoming peer connections would stay dead.
    case 'rebind':
    case 'restored': {
      const ip = current!.address;
      if (pendingRebindIp !== ip) { pendingRebindIp = ip; return; } // 1st sighting — confirm next tick
      if (Date.now() - lastRebindAt < REBIND_MIN_INTERVAL_MS) return;
      pendingRebindIp = null;
      // Fire and forget: the restart takes seconds and must not stall the
      // kill-switch half of this tick; rebindInProgress guards re-entry.
      void rebindEngine(ip);
      return;
    }
    case 'lost': {
      pendingRebindIp = null;
      bindLost = true;
      log.warn('Routed tunnel unconfirmed — restarting bound engine into fallback');
      showOsNotification(t('notify.vpnBindLost.title'), t('notify.vpnBindLost.body'), { critical: true });
      sendToRenderer('app:vpnBindStatus', { kind: 'lost' });
      // An adapter may still have its address despite routes moving elsewhere.
      // Re-read at startup and use loopback when no routed tunnel is available.
      void rebindEngine(null);
      return;
    }
    default:
      pendingRebindIp = null;
  }
}

async function rebindEngine(newIp: string | null): Promise<void> {
  rebindInProgress = true;
  try {
    log.info('VPN address changed — restarting the engine to re-bind', { ip: newIp });
    const manager = getTorrentManager();
    await manager.restartEngine();
    lastRebindAt = Date.now();
    // Trust the engine's own report, not our intent: the VPN may have vanished
    // again mid-restart, leaving the fresh engine in loopback fallback — then
    // nothing is bound and announcing success would be a lie. Leave the lost
    // latch as-is and let the next tick drive a new re-bind attempt.
    const status = manager.getVpnBindStatus();
    if (status?.enabled && status.boundIp) {
      bindLost = false;
      log.info('Engine re-bound to the VPN', { ip: status.boundIp });
      showOsNotification(t('notify.vpnRebound.title'), t('notify.vpnRebound.body', { ip: status.boundIp }));
      // Note: if the kill-switch also tripped during this outage, torrents STAY
      // paused — its resume is manual by design; the rebound toast must not
      // imply downloads resumed.
      sendToRenderer('app:vpnBindStatus', { kind: 'rebound', boundIp: status.boundIp });
    } else {
      log.warn('Engine restarted but is not bound to a VPN (loopback fallback) — will retry when an adapter appears');
    }
  } catch (e) {
    log.error('Engine re-bind failed', { error: e instanceof Error ? e.message : String(e) });
  } finally {
    rebindInProgress = false;
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, payload);
  }
}
