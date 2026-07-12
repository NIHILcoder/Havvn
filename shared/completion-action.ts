/**
 * On-completion action — pure decision logic (no Node/Electron imports).
 *
 * The feature is ONE-SHOT and never persisted: every launch starts at 'none',
 * which makes startup false-positives structurally impossible. The armed
 * action fires only after the sawPending latch has observed real activity
 * (pending > 0), so arming while idle — or an empty-stats blip while the
 * engine restores — can never trigger a shutdown.
 */

export type CompletionAction = 'none' | 'sleep' | 'shutdown' | 'quit';

export interface CompletionPending {
  action: CompletionAction;
  deadline: number; // epoch ms when the action executes
}

/** app:getCompletionAction reply. */
export interface CompletionActionState {
  action: CompletionAction;
  available: CompletionAction[];
  pending: CompletionPending | null;
}

/** Sleep/shutdown shell out to Windows-only commands; other platforms keep none/quit. */
export function availableCompletionActions(platform: string): CompletionAction[] {
  return platform === 'win32' ? ['none', 'sleep', 'shutdown', 'quit'] : ['none', 'quit'];
}

export interface CompletionTickState {
  armed: boolean;           // action !== 'none'
  sawPending: boolean;      // pending > 0 was observed since arming
  countdownActive: boolean; // an execution countdown is running
}

export type CompletionTickResult = 'noop' | 'saw-pending' | 'fire' | 'abort-pending';

/**
 * One 3s-tick decision over the torrent status snapshot.
 *
 * - pending = downloading/queued count. Seeing it arms the sawPending latch.
 * - fire only when armed, latched, pending is 0, and every torrent is in a
 *   TERMINAL state: completed / seeding / error. 'error' counts as terminal
 *   (a dead tracker must not keep the machine on all night); 'paused' does
 *   NOT — the disk/VPN guards auto-pause, and powering off then would strand
 *   recoverable downloads. An empty snapshot never fires (engine-restore blip).
 * - during a countdown, new pending work aborts the pending action.
 */
export function evaluateTick(state: CompletionTickState, statuses: readonly string[]): CompletionTickResult {
  const pending = statuses.reduce((n, s) => (s === 'downloading' || s === 'queued' ? n + 1 : n), 0);
  if (state.countdownActive) return pending > 0 ? 'abort-pending' : 'noop';
  if (!state.armed) return 'noop';
  if (pending > 0) return state.sawPending ? 'noop' : 'saw-pending';
  if (!state.sawPending || statuses.length === 0) return 'noop';
  const allTerminal = statuses.every((s) => s === 'completed' || s === 'seeding' || s === 'error');
  return allTerminal ? 'fire' : 'noop';
}
