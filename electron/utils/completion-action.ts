/**
 * On-completion action (one-shot, NEVER persisted): "when all downloads
 * finish → sleep / shut down / quit Havvn".
 *
 * All state is in-memory module state, so every launch starts at 'none' —
 * startup false-positives are structurally impossible. Detection rides the
 * existing 3s tray tick (main.ts updateTrayTooltip), the only loop that keeps
 * running in closed-to-tray mode; the pure decision function lives in
 * shared/completion-action.ts under vitest.
 *
 * Execution (Windows commands per spec):
 * - shutdown: `shutdown /s /t 60` — the OS owns the 60s timer and shows its
 *   own session-ending banner; our Cancel runs `shutdown /a`.
 * - sleep:    15s in-app grace, then `rundll32 powrprof.dll,SetSuspendState
 *   0,1,0` (note the long-standing Windows quirk: hibernates instead of
 *   sleeping when hibernation is enabled — wording stays generic).
 * - quit:     15s in-app grace, then isQuitting=true + app.quit() so the
 *   close-to-tray hook doesn't swallow it and cleanup() runs.
 */

import { execFile } from 'node:child_process';
import { ipcMain, BrowserWindow } from 'electron';
import { logger } from './logger';
import { showOsNotification } from './os-notify';
import { getTorrentManager } from '../torrent';
import { t } from '../i18n';
import {
  CompletionAction, CompletionActionState, availableCompletionActions, evaluateTick,
} from '../../shared/completion-action';

const log = logger.child('CompletionAction');

const GRACE_MS = 15_000;          // in-app countdown for sleep/quit
const SHUTDOWN_OS_SECONDS = 60;   // OS-owned timer for shutdown

let action: CompletionAction = 'none';
let sawPending = false;
let pendingExec: { action: CompletionAction; deadline: number; timer: NodeJS.Timeout | null } | null = null;
let getWindow: (() => BrowserWindow | null) | null = null;
let quitApp: (() => void) | null = null;

export function initCompletionAction(opts: { getMainWindow: () => BrowserWindow | null; quitApp: () => void }): void {
  getWindow = opts.getMainWindow;
  quitApp = opts.quitApp;
  ipcMain.handle('app:getCompletionAction', async () => getCompletionActionState());
  ipcMain.handle('app:setCompletionAction', async (_e, next: CompletionAction) => {
    setCompletionAction(next);
    return { ok: true };
  });
}

export function getCompletionActionState(): CompletionActionState {
  return {
    action,
    available: availableCompletionActions(process.platform),
    pending: pendingExec ? { action: pendingExec.action, deadline: pendingExec.deadline } : null,
  };
}

/** Select the one-shot action; ANY change during a countdown cancels it first. */
export function setCompletionAction(next: CompletionAction): void {
  if (!availableCompletionActions(process.platform).includes(next)) next = 'none';
  // Switching during a countdown must stop the old execution — otherwise the
  // leftover timer (or the OS shutdown) still fires while the UI claims the
  // new selection replaced it.
  const hadCountdown = pendingExec !== null;
  if (hadCountdown) cancelPending();
  const prev = action;
  action = next;
  if (next === 'none') {
    sawPending = false;
  } else if (hadCountdown) {
    // Switching DURING a countdown: completion conditions were already met —
    // keep them met so the next tick fires the NEW action (fresh countdown)
    // instead of silently disarming.
    sawPending = true;
  } else if (prev === 'none') {
    // Fresh arm requires fresh activity: without this reset, re-arming after a
    // consumed episode would inherit the old latch and fire instantly on an
    // already-finished list. Active work re-latches on the next 3s tick.
    sawPending = false;
  }
  // prev armed → next armed with no countdown: keep the latch, so switching
  // the action right after the last download finished still fires on time.
  log.info('On-completion action set', { action });
  broadcastChanged();
}

/** Called from the 3s tray tick (runs even in closed-to-tray mode). */
export function tickCompletionAction(): void {
  let statuses: string[];
  try {
    statuses = getTorrentManager().getStats().map((s) => s.status);
  } catch {
    return;
  }
  const result = evaluateTick(
    { armed: action !== 'none', sawPending, countdownActive: pendingExec !== null },
    statuses,
  );
  if (result === 'saw-pending') {
    sawPending = true;
  } else if (result === 'abort-pending') {
    // New work joined during the countdown — RE-ARM the aborted action for it
    // ("when all downloads finish" now includes the newcomer) instead of
    // silently dropping the user's plan.
    const aborted = pendingExec!.action;
    log.info('New activity during the completion countdown — re-arming', { action: aborted });
    cancelPending();
    action = aborted;
    sawPending = true; // pending > 0 was observed this very tick
    broadcastChanged();
  } else if (result === 'fire') {
    fire();
  }
}

/** Clear our timers on shutdown. An OS-scheduled `shutdown /s` is deliberately
 *  left alone: the user armed it, Windows shows its own cancel UI, and our
 *  Cancel button already ran `shutdown /a` when used. */
export function stopCompletionAction(): void {
  if (pendingExec?.timer) clearTimeout(pendingExec.timer);
  pendingExec = null;
}

function fire(): void {
  const act = action;
  // Consume the one-shot selection before executing.
  action = 'none';
  sawPending = false;
  broadcastChanged();
  log.info('All downloads finished — executing completion action', { action: act });

  const showWindow = () => {
    const w = getWindow?.();
    if (w && !w.isDestroyed()) {
      w.show();
      w.focus();
    }
  };

  if (act === 'shutdown') {
    execFile('shutdown', ['/s', '/t', String(SHUTDOWN_OS_SECONDS)], (err) => {
      if (err) {
        // exit code 1190 = a shutdown is already scheduled; group policy can
        // also block it. Clear our countdown so the feature doesn't wedge on a
        // shutdown that will never happen.
        log.error('shutdown /s failed — clearing the completion countdown', { error: err.message });
        if (pendingExec?.action === 'shutdown') {
          if (pendingExec.timer) clearTimeout(pendingExec.timer);
          pendingExec = null;
          broadcastPending();
        }
      }
    });
    // Backstop: the OS owns the real timer, but if the machine is still alive
    // past the deadline (shutdown aborted externally via `shutdown /a`, or it
    // failed) we must not stay in "countdown running" forever — that would
    // block every future completion action this session.
    const deadline = Date.now() + SHUTDOWN_OS_SECONDS * 1000;
    const timer = setTimeout(() => {
      if (pendingExec?.action !== 'shutdown') return;
      log.warn('OS shutdown deadline passed but we are still running — clearing the completion state');
      pendingExec = null;
      broadcastPending();
    }, SHUTDOWN_OS_SECONDS * 1000 + 5_000);
    pendingExec = { action: act, deadline, timer };
    showOsNotification(t('notify.onDone.shutdownTitle'), t('notify.onDone.shutdownBody'), { critical: true, onClick: showWindow });
    broadcastPending();
    return;
  }

  if (act === 'sleep' || act === 'quit') {
    const deadline = Date.now() + GRACE_MS;
    const timer = setTimeout(() => {
      pendingExec = null;
      broadcastPending();
      if (act === 'sleep') {
        execFile('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], (err) => {
          if (err) log.error('sleep via SetSuspendState failed', { error: err.message });
        });
      } else {
        quitApp?.();
      }
    }, GRACE_MS);
    pendingExec = { action: act, deadline, timer };
    showOsNotification(
      t(act === 'sleep' ? 'notify.onDone.sleepTitle' : 'notify.onDone.quitTitle'),
      t(act === 'sleep' ? 'notify.onDone.sleepBody' : 'notify.onDone.quitBody'),
      { onClick: showWindow },
    );
    broadcastPending();
  }
}

function cancelPending(): void {
  if (!pendingExec) return;
  const wasOsShutdown = pendingExec.action === 'shutdown';
  if (pendingExec.timer) clearTimeout(pendingExec.timer);
  pendingExec = null;
  if (wasOsShutdown) {
    execFile('shutdown', ['/a'], (err) => {
      if (err) log.warn('shutdown /a failed (may already be past the point of no return)', { error: err.message });
    });
  }
  log.info('Completion countdown cancelled');
  broadcastPending();
}

function broadcastChanged(): void {
  send('app:completionActionChanged', action);
}

function broadcastPending(): void {
  // NOT gated on window visibility: a window opened later (e.g. from the
  // notification click) must find the mirror already correct.
  send('app:completionActionPending', pendingExec ? { action: pendingExec.action, deadline: pendingExec.deadline } : null);
}

function send(channel: string, payload: unknown): void {
  const w = getWindow?.();
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}
