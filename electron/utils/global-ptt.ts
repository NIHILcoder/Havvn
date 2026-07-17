/**
 * Global push-to-talk — an OS-level key hook (uiohook-napi) so PTT works while
 * the app is unfocused. Electron's globalShortcut cannot do this: it has no
 * key-UP event, and hold-to-talk needs both edges.
 *
 * Privacy contract: the hook runs ONLY while it has a reason to — the user is in
 * a voice channel, in push-to-talk mode, with the global toggle on. RoomManager
 * owns that decision (decideGlobalPtt below, re-evaluated on every room-state
 * push) and start()/stop() are cheap to cycle. The hook observes the one
 * configured keycode and never suppresses or records anything else.
 *
 * uiohook-napi is a native N-API module (prebuilt, ABI-stable — no rebuild
 * pipeline needed) but load it defensively: if the binary is missing the feature
 * reports unavailable instead of crashing the main process. shutdown() MUST run
 * on will-quit — a live hook thread would keep the process from exiting.
 */
import { logger } from './logger';
import { domCodeToUiohookName, decideGlobalPtt } from '../../shared/uiohook-keymap';

export { decideGlobalPtt };

const log = logger.child('GlobalPtt');

type UiohookModule = typeof import('uiohook-napi');

let mod: UiohookModule | null | undefined; // undefined = not probed yet, null = unavailable
let listenersWired = false;
let running = false;
let activeKeycode = 0;
let held = false;
let onDown: (() => void) | null = null;
let onUp: (() => void) | null = null;

function getModule(): UiohookModule | null {
  if (mod === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('uiohook-napi') as UiohookModule;
    } catch (e) {
      mod = null;
      log.warn('uiohook-napi unavailable — global PTT disabled', { err: String(e) });
    }
  }
  return mod;
}

export function isGlobalPttAvailable(): boolean {
  return getModule() !== null;
}

/** Resolve a DOM KeyboardEvent.code to a uiohook keycode (null = not expressible). */
export function resolveUiohookKeycode(domCode: string): number | null {
  const m = getModule();
  if (!m) return null;
  const name = domCodeToUiohookName(domCode);
  if (!name) return null;
  const keycode = (m.UiohookKey as Record<string, number>)[name];
  return typeof keycode === 'number' ? keycode : null;
}

function wireListeners(m: UiohookModule): void {
  if (listenersWired) return;
  listenersWired = true;
  m.uIOhook.on('keydown', (e) => {
    // OS auto-repeat re-fires keydown while held — the `held` edge filter makes
    // this a clean press/release pair.
    if (!running || e.keycode !== activeKeycode || held) return;
    held = true;
    try { onDown?.(); } catch { /* ignore */ }
  });
  m.uIOhook.on('keyup', (e) => {
    if (!running || e.keycode !== activeKeycode || !held) return;
    held = false;
    try { onUp?.(); } catch { /* ignore */ }
  });
}

/** Start (or retune) the hook for one keycode. Returns false if unavailable. */
export function startGlobalPtt(keycode: number, down: () => void, up: () => void): boolean {
  const m = getModule();
  if (!m) return false;
  wireListeners(m);
  // Retune: release a key held under the OLD binding/room before switching.
  if (held) { held = false; try { onUp?.(); } catch { /* ignore */ } }
  activeKeycode = keycode;
  onDown = down;
  onUp = up;
  if (!running) {
    try { m.uIOhook.start(); } catch (e) { log.warn('hook start failed', { err: String(e) }); return false; }
    running = true;
    log.info('global PTT hook started');
  }
  return true;
}

export function stopGlobalPtt(): void {
  if (held) { held = false; try { onUp?.(); } catch { /* ignore */ } }
  onDown = null;
  onUp = null;
  activeKeycode = 0;
  if (running) {
    running = false;
    try { getModule()?.uIOhook.stop(); } catch { /* ignore */ }
    log.info('global PTT hook stopped');
  }
}

/** app 'will-quit': make sure the hook thread can't keep the process alive. */
export function shutdownGlobalPtt(): void {
  stopGlobalPtt();
}
