/**
 * Upload ceilings for the native (transmission) engine — pure composition of the
 * manual caps with the adaptive bufferbloat cap. No Node/Electron imports, so
 * vitest runs it directly.
 *
 * ── WHY THIS IS NOT INLINE IN applySessionSettings ──────────────────────────
 * `applySessionSettings` used to write `speed-limit-up` straight from
 * `s.maxUpKbps`. The moment an adaptive throttle also writes that key, the two
 * fight: the throttle re-caps every 2 s, any settings update stomps it back to
 * the manual value, and the cap visibly flaps. The webtorrent manager already
 * solved this with `currentUpBytes()` ("most restrictive positive wins"); this
 * is the same rule, in the units transmission speaks, pulled out where it can be
 * attacked by a test.
 *
 * ── WHY BOTH KNOBS ARE ALWAYS DRIVEN ────────────────────────────────────────
 * transmission has two upload ceilings and `alt-speed-enabled` picks which one
 * the daemon honours: `speed-limit-up` normally, `alt-speed-up` in alt
 * ("turbo"/turtle) mode — the alt value OVERRIDES the normal one rather than
 * combining with it. So an adaptive cap written only to `speed-limit-up` is
 * silently ignored the instant the user hits turbo.
 *
 * The fix is to compute BOTH knobs on every apply, each carrying its own mode's
 * composed ceiling. Then flipping `alt-speed-enabled` is instantaneous and
 * correct with no window where the cap is stale, and this function never needs
 * to know which mode is active — it is not an input. Whoever owns
 * `alt-speed-enabled` keeps owning it.
 *
 * Bufferbloat protection deliberately survives alt mode: the link does not stop
 * being a link because the user pressed turbo, and "most restrictive wins" means
 * a manual alt cap tighter than the adaptive one still wins on its own merit.
 *
 * ── THE ZERO TRAP ───────────────────────────────────────────────────────────
 * transmission reads these keys as kB/s, where 0 means "0 kB/s" — a full stop,
 * NOT "unlimited". Unlimited is expressed by `speed-limit-up-enabled: false` /
 * by leaving the key alone. That is the same trap the webtorrent manager
 * documents for `downloadLimit` (-1 = unlimited, 0 would stall all traffic), and
 * it is why every positive ceiling here floors at 1 rather than at 0: a sub-1 kB
 * adaptive cap must throttle hard, never wedge the transfer shut.
 */

/** Adaptive caps arrive in bytes/sec; transmission wants kB/s. */
const BYTES_PER_KB = 1024;

export interface UploadLimitInput {
  /** Manual normal-mode ceiling, kB/s. 0 (or absent) = unlimited. */
  maxUpKbps: number;
  /** Manual alt-mode ceiling, kB/s. 0 (or absent) = unlimited. */
  altUpKbps: number;
  /**
   * The adaptive throttle's current ceiling in BYTES/sec, or -1 for "no adaptive
   * cap" (its UNLIMITED sentinel). Anything <= 0 is treated as no cap — a 0 here
   * is the throttle being off, never a request to stop uploading.
   */
  adaptiveUpBytes: number;
}

/**
 * The `session-set` arguments that express these ceilings. Keys are omitted
 * rather than zeroed when a ceiling is unlimited, because 0 is a real (and
 * catastrophic) value to transmission — see THE ZERO TRAP above.
 */
export interface UploadLimitArgs {
  'speed-limit-up-enabled': boolean;
  'speed-limit-up'?: number;
  'alt-speed-up'?: number;
}

/**
 * The tighter of a manual kB/s ceiling and the adaptive one, or null when both
 * are unlimited. Null is "no ceiling", which is why it is not 0.
 */
function tighter(manualKbps: number, adaptiveKbps: number | null): number | null {
  const manual = manualKbps > 0 ? manualKbps : null;
  if (manual === null) return adaptiveKbps;
  if (adaptiveKbps === null) return manual;
  return Math.min(manual, adaptiveKbps);
}

/**
 * Compose the manual and adaptive upload ceilings into transmission's two knobs.
 *
 * `speed-limit-up-enabled` follows the NORMAL-mode ceiling only. That is what
 * makes an adaptive cap work for a user who never set a manual limit: the old
 * code enabled the limiter from `maxUpKbps > 0`, so with no manual cap the
 * limiter stayed off and any adaptive value written beside it was inert.
 */
export function composeUploadLimits(i: UploadLimitInput): UploadLimitArgs {
  const adaptiveKbps = i.adaptiveUpBytes > 0
    // Floor at 1: rounding a sub-kB cap down to 0 would mean "stop", not "slow".
    ? Math.max(1, Math.floor(i.adaptiveUpBytes / BYTES_PER_KB))
    : null;

  const normal = tighter(i.maxUpKbps ?? 0, adaptiveKbps);
  const alt = tighter(i.altUpKbps ?? 0, adaptiveKbps);

  const args: UploadLimitArgs = { 'speed-limit-up-enabled': normal !== null };
  if (normal !== null) args['speed-limit-up'] = normal;
  if (alt !== null) args['alt-speed-up'] = alt;
  return args;
}
