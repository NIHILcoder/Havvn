/**
 * Pure brain of the Havvn game-server supervisor — the state machine the process
 * wiring (electron/gameserver/supervisor.ts) drives, plus the validators that
 * stand between a module's plan and the filesystem. Dependency-free (no electron,
 * no node:fs, no node:child_process) so it imports unchanged in the main process
 * AND in node vitest, exactly like shared/lan-session-core.ts.
 *
 * WHAT LIVES HERE (and therefore is exhaustively testable without a JVM):
 *   • isSafeRelPath / validateInstallStep / validateLaunchPlan — the containment
 *     gate. Every path a module names is checked here BEFORE the core resolves it
 *     against a root, so "a module cannot write outside its instance" is a
 *     property of the type flow, not of module authors remembering.
 *   • ServerFsm — the status transitions, the restart budget, and the folding of
 *     GameEvents into live state (ready / players / fatal).
 *   • clampCommand / normalizeConsoleLine — the two bounds on untrusted-ish text
 *     crossing into stdin and into the console buffer.
 *
 * The supervisor itself owns only the effects: spawn, pipes, timers, kill.
 */
import {
  MAX_RESTARTS, RESTART_WINDOW_MS, MAX_COMMAND_LENGTH, MAX_CONSOLE_LINE,
} from './gameserver-types';
import type {
  ConfigField, GameEvent, InstallStep, LaunchPlan, RelPath, ServerFailReason, ServerStatus,
} from './gameserver-types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Path containment
// ─────────────────────────────────────────────────────────────────────────────

/** Longest relative path a plan may name. Real ones are far shorter; this only
 *  bounds a pathological value before it reaches path.resolve. */
export const MAX_REL_PATH = 240;

/** Characters that are illegal in a Windows path or meaningful to a shell. NUL
 *  is included explicitly: node truncates at it, so a path containing one can
 *  resolve to something other than what we validated. */
// eslint-disable-next-line no-control-regex
const REL_PATH_BAD = /[\u0000-\u001f<>:"|?*\\]/;

/** Windows reserved device names — a file called `CON` or `LPT1.jar` is not a
 *  file, and creating one behaves in surprising ways. */
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export type RelPathReject =
  | 'not-a-string' | 'too-long' | 'absolute' | 'traversal' | 'bad-chars' | 'reserved';

/**
 * HARD gate for a path that will be resolved under an instance/runtime root.
 * Pure, so it is unit-testable and runs identically wherever it is called.
 *
 * Requires: forward slashes only (a backslash is rejected rather than
 * normalised, so the validated string and the resolved string cannot diverge),
 * no drive letter, no leading slash, no '.' or '..' or empty segment, no
 * trailing dot/space (Win32 canonicalisation silently strips those, which would
 * again make the resolved path differ from the checked one), and no reserved
 * device name. The empty string IS legal and means "the root itself".
 */
export function isSafeRelPath(p: unknown): { ok: true; path: RelPath } | { ok: false; reason: RelPathReject } {
  if (typeof p !== 'string') return { ok: false, reason: 'not-a-string' };
  if (p === '') return { ok: true, path: '' };
  if (p.length > MAX_REL_PATH) return { ok: false, reason: 'too-long' };
  if (REL_PATH_BAD.test(p)) return { ok: false, reason: 'bad-chars' };
  if (p.startsWith('/')) return { ok: false, reason: 'absolute' };
  // A drive-relative path like 'C:foo' is caught by the ':' in REL_PATH_BAD.
  const segments = p.split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') return { ok: false, reason: 'traversal' };
    if (s !== s.trim() || s.endsWith('.')) return { ok: false, reason: 'bad-chars' };
    if (RESERVED_SEGMENT.test(s)) return { ok: false, reason: 'reserved' };
  }
  return { ok: true, path: p };
}

/** Lowercase hex digest of the expected length for its algorithm. */
export function isValidDigest(algo: 'sha1' | 'sha256' | 'sha512', hex: unknown): boolean {
  if (typeof hex !== 'string') return false;
  const want = algo === 'sha1' ? 40 : algo === 'sha256' ? 64 : 128;
  return hex.length === want && /^[0-9a-f]+$/.test(hex);
}

/** Only https, and no embedded credentials (a `user:pass@host` url in a plan is
 *  either a mistake or an exfiltration attempt, never a legitimate artifact). */
export function isSafeArtifactUrl(u: unknown): boolean {
  if (typeof u !== 'string' || u.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  return true;
}

export type StepReject =
  | { ok: true }
  | { ok: false; reason: string };

/** Bounds on a runtime-exec argv: no NUL, no absurd length, bounded count. A
 *  first-party module builds these, so this is defence in depth rather than the
 *  primary control — but it is what makes a future preset-driven argv provably
 *  impossible to introduce by accident. */
const MAX_EXEC_ARGS = 64;
const MAX_EXEC_ARG_LEN = 1024;
export const MAX_EXEC_TIMEOUT_MS = 30 * 60_000;

/** Validate ONE install step. The installer refuses the whole plan if any step
 *  fails, rather than executing a prefix and leaving a half-built instance. */
export function validateInstallStep(step: InstallStep): StepReject {
  switch (step.t) {
    case 'fetch': {
      if (!isSafeArtifactUrl(step.url)) return { ok: false, reason: 'fetch: url must be https without credentials' };
      const into = isSafeRelPath(step.into);
      if (!into.ok) return { ok: false, reason: `fetch: into ${into.reason}` };
      if (into.path === '') return { ok: false, reason: 'fetch: into must name a file' };
      const h = step.hash;
      const algo = h.algo === 'vendor' ? h.digest : h.algo;
      if (!isValidDigest(algo, h.hex)) return { ok: false, reason: 'fetch: malformed digest' };
      return { ok: true };
    }
    case 'unzip': {
      const from = isSafeRelPath(step.from);
      if (!from.ok || from.path === '') return { ok: false, reason: 'unzip: bad from' };
      const into = isSafeRelPath(step.into);
      if (!into.ok) return { ok: false, reason: `unzip: into ${into.reason}` };
      if (step.strip !== undefined && (!Number.isInteger(step.strip) || step.strip < 0 || step.strip > 8)) {
        return { ok: false, reason: 'unzip: strip out of range' };
      }
      return { ok: true };
    }
    case 'write': {
      const p = isSafeRelPath(step.path);
      if (!p.ok || p.path === '') return { ok: false, reason: 'write: bad path' };
      if (typeof step.text !== 'string' || step.text.length > 1024 * 1024) {
        return { ok: false, reason: 'write: text missing or too large' };
      }
      return { ok: true };
    }
    case 'remove': {
      const p = isSafeRelPath(step.path);
      if (!p.ok || p.path === '') return { ok: false, reason: 'remove: bad path' };
      return { ok: true };
    }
    case 'runtime-exec': {
      const cwd = isSafeRelPath(step.cwd);
      if (!cwd.ok) return { ok: false, reason: `runtime-exec: cwd ${cwd.reason}` };
      if (!step.runtime || typeof step.runtime.id !== 'string' || !Number.isInteger(step.runtime.major)) {
        return { ok: false, reason: 'runtime-exec: bad runtime ref' };
      }
      if (!Array.isArray(step.args) || step.args.length > MAX_EXEC_ARGS) {
        return { ok: false, reason: 'runtime-exec: too many args' };
      }
      for (const a of step.args) {
        if (typeof a !== 'string' || a.length > MAX_EXEC_ARG_LEN || a.includes('\u0000')) {
          return { ok: false, reason: 'runtime-exec: bad arg' };
        }
      }
      if (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0 || step.timeoutMs > MAX_EXEC_TIMEOUT_MS) {
        return { ok: false, reason: 'runtime-exec: bad timeout' };
      }
      if (!Array.isArray(step.produces) || step.produces.length === 0) {
        return { ok: false, reason: 'runtime-exec: must declare what it produces' };
      }
      for (const p of step.produces) {
        const r = isSafeRelPath(p);
        if (!r.ok || r.path === '') return { ok: false, reason: 'runtime-exec: bad produces entry' };
      }
      return { ok: true };
    }
    default: {
      // Exhaustiveness: a new arm must be validated before it can be executed.
      const never: never = step;
      return { ok: false, reason: `unknown step ${JSON.stringify(never)}` };
    }
  }
}

/** Validate a whole plan, returning the FIRST problem (with its index, so the
 *  error names the failing step rather than the whole install). */
export function validateInstallPlan(steps: InstallStep[]): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(steps)) return { ok: false, reason: 'plan is not an array' };
  if (steps.length > 64) return { ok: false, reason: 'plan too long' };
  for (let i = 0; i < steps.length; i++) {
    const r = validateInstallStep(steps[i]);
    if (!r.ok) return { ok: false, reason: `step ${i} (${steps[i]?.t}): ${r.reason}` };
  }
  return { ok: true };
}

export function validateLaunchPlan(plan: LaunchPlan): { ok: true } | { ok: false; reason: string } {
  if (!plan || typeof plan !== 'object') return { ok: false, reason: 'no plan' };
  if (!plan.runtime || typeof plan.runtime.id !== 'string' || !Number.isInteger(plan.runtime.major)) {
    return { ok: false, reason: 'bad runtime ref' };
  }
  const cwd = isSafeRelPath(plan.cwd);
  if (!cwd.ok) return { ok: false, reason: `cwd ${cwd.reason}` };
  if (!Array.isArray(plan.args) || plan.args.length > MAX_EXEC_ARGS) return { ok: false, reason: 'bad args' };
  for (const a of plan.args) {
    if (typeof a !== 'string' || a.length > MAX_EXEC_ARG_LEN || a.includes('\u0000')) {
      return { ok: false, reason: 'bad arg' };
    }
  }
  for (const [k, v] of Object.entries(plan.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return { ok: false, reason: `bad env name ${k}` };
    if (typeof v !== 'string' || v.length > 4096 || v.includes('\u0000')) return { ok: false, reason: `bad env value for ${k}` };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1b. Settings and ports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce ONE settings value to something the schema allows, or reject it.
 *
 * This exists because the renderer is not a trust boundary. `saveConfig` used to
 * sanitise key SHAPE (no odd characters, bounded length) and then write whatever
 * value arrived, so `server-port=99999` reached server.properties and only got
 * clamped later, at read time, by the module — meaning the file on disk said one
 * thing and the running server did another.
 *
 * Returns the value to store, which is not always the value passed: an int is
 * normalised (' 25565 ' → '25565') and a bool is canonicalised, because the
 * game's own config format has one spelling and a form can produce several.
 */
export function coerceConfigValue(
  field: ConfigField,
  raw: unknown,
): { ok: true; value: string } | { ok: false; reason: string } {
  const text = raw === undefined || raw === null ? '' : String(raw).trim();

  switch (field.t) {
    case 'int': {
      if (text === '') return { ok: false, reason: 'empty' };
      // Integer only, and parsed strictly: Number.parseInt('25565abc') is 25565,
      // which would silently accept a typo as a port.
      if (!/^-?\d{1,10}$/.test(text)) return { ok: false, reason: 'not an integer' };
      const n = Number(text);
      if (field.min !== undefined && n < field.min) return { ok: false, reason: `below ${field.min}` };
      if (field.max !== undefined && n > field.max) return { ok: false, reason: `above ${field.max}` };
      return { ok: true, value: String(n) };
    }
    case 'bool': {
      const lowered = text.toLowerCase();
      if (lowered === 'true' || lowered === 'false') return { ok: true, value: lowered };
      return { ok: false, reason: 'not a boolean' };
    }
    case 'select': {
      if (!field.options.some((o) => o.value === text)) return { ok: false, reason: 'not an offered option' };
      return { ok: true, value: text };
    }
    case 'text': {
      const max = field.maxLength ?? 256;
      if (text.length > max) return { ok: false, reason: `longer than ${max}` };
      // A newline would end the line in a line-oriented config file and turn the
      // remainder into a key of its own.
      // eslint-disable-next-line no-control-regex
      if (/[\r\n\u0000]/.test(text)) return { ok: false, reason: 'contains a line break' };
      return { ok: true, value: text };
    }
    default: {
      const never: never = field;
      return { ok: false, reason: `unknown field ${JSON.stringify(never)}` };
    }
  }
}

/**
 * Filter a settings submission down to values the schema vouches for.
 *
 * Keys the schema does not describe are DROPPED rather than rejected: the form
 * round-trips the whole parsed config, which for Minecraft includes the dozens of
 * server.properties keys we do not model, and failing the save because one of
 * them exists would make the form unusable. Values that ARE described and are out
 * of range are reported, so the UI can say which field is wrong.
 */
export function validateConfigValues(
  schema: readonly ConfigField[],
  values: Readonly<Record<string, unknown>>,
): { values: Record<string, string>; rejected: { key: string; reason: string }[] } {
  const byKey = new Map(schema.map((f) => [f.key, f]));
  const out: Record<string, string> = {};
  const rejected: { key: string; reason: string }[] = [];

  for (const [key, raw] of Object.entries(values)) {
    const field = byKey.get(key);
    if (!field) {
      // Unmodelled key: keep it, bounded, so a hand-edited setting survives.
      if (/^[A-Za-z0-9_.-]{1,64}$/.test(key)) out[key] = String(raw ?? '').slice(0, 2048);
      continue;
    }
    const coerced = coerceConfigValue(field, raw);
    if (coerced.ok) out[key] = coerced.value;
    else rejected.push({ key, reason: coerced.reason });
  }

  return { values: out, rejected };
}

/**
 * First port in `plan`'s range that nothing in `taken` holds.
 *
 * Pure, so the interesting part — "the Nth server in a room gets a port of its
 * own" — is unit-testable without binding a socket. The caller adds the OS's
 * opinion by probing the returned candidate; this only guarantees we do not hand
 * out a port a sibling instance already claims.
 *
 * WHY THIS EXISTS: every instance used to be created with an empty config, so
 * every instance answered `server-port` with the module default. The first server
 * in a room worked and the second one died at bind time, reported as a generic
 * early exit — a full evening's debugging for a number we could have picked.
 *
 * Returns null when the whole range is claimed, which the caller must surface
 * rather than falling back to the base port and recreating the collision.
 */
export function pickPort(
  plan: { base: number; span: number },
  taken: Iterable<number>,
): number | null {
  const used = new Set<number>();
  for (const p of taken) if (Number.isInteger(p)) used.add(p);
  for (let port = plan.base; port < plan.base + plan.span; port++) {
    if (port > 65535) break;
    if (!used.has(port)) return port;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Text bounds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make a UI-supplied string safe to write as ONE stdin line. Embedded newlines
 * are the whole risk: without this, "say hi\nstop" is two commands, which turns
 * a future operator allow-list into decoration. Returns null when nothing usable
 * remains.
 */
export function clampCommand(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const flattened = input.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!flattened) return null;
  return flattened.slice(0, MAX_COMMAND_LENGTH);
}

/** Strip control characters and cap length for one buffered console line. ANSI
 *  colour sequences are removed here so the renderer never has to interpret
 *  them (and cannot be driven by escape codes from game output). */
export function normalizeConsoleLine(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const noAnsi = raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  // eslint-disable-next-line no-control-regex
  const clean = noAnsi.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return clean.length > MAX_CONSOLE_LINE ? `${clean.slice(0, MAX_CONSOLE_LINE)}…` : clean;
}

/**
 * Split a chunk of process output into complete lines, returning the trailing
 * partial for the caller to prepend next time. Handles CRLF and lone CR (some
 * launchers emit progress with carriage returns), and bounds the carry so a
 * process that never emits a newline cannot grow it without limit.
 */
export function splitLines(carry: string, chunk: string): { lines: string[]; carry: string } {
  const lines = (carry + chunk).split(/\r\n|\n|\r/);
  let rest = lines.pop() ?? '';
  if (rest.length > MAX_CONSOLE_LINE) {
    // Flush the runaway partial as its own line instead of carrying it forever:
    // a process that emits a giant unterminated line must not grow our buffer.
    lines.push(rest);
    rest = '';
  }
  return { lines, carry: rest };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The state machine
// ─────────────────────────────────────────────────────────────────────────────

/** What the supervisor should do after the process exited. */
export type ExitDisposition = 'stopped' | 'restart' | 'crashed';

export interface FsmSnapshot {
  status: ServerStatus;
  since: number;
  ready: boolean;
  installPct?: number;
  players: string[];
  failReason?: ServerFailReason;
  failDetail?: string;
  /** Unexpected exits inside the current window (visible so a flapping server is
   *  obvious BEFORE the budget runs out). */
  restarts: number;
}

/**
 * Status transitions plus the restart budget. Every method takes `now` rather
 * than reading the clock, so the whole thing is deterministic under test — the
 * same discipline the LAN anti-replay floors use.
 *
 * Transitions are guarded and idempotent-ish: a request that does not apply
 * returns false instead of throwing, because these are driven by UI actions and
 * by process events that can legitimately race (a stop request arriving just as
 * the process died on its own).
 */
export class ServerFsm {
  private _status: ServerStatus = 'idle';
  private _since = 0;
  private _ready = false;
  private _installPct: number | undefined;
  private _players = new Set<string>();
  private _failReason: ServerFailReason | undefined;
  private _failDetail: string | undefined;
  /** Timestamps of unexpected exits, pruned to RESTART_WINDOW_MS. */
  private _crashes: number[] = [];
  /** Set when a module reported a fatal log line: restarting would hit the same
   *  wall, so the budget must not be spent on it. */
  private _fatalSeen = false;

  constructor(now = 0, status: ServerStatus = 'idle') {
    this._status = status;
    this._since = now;
  }

  get status(): ServerStatus { return this._status; }
  get ready(): boolean { return this._ready; }

  snapshot(): FsmSnapshot {
    return {
      status: this._status,
      since: this._since,
      ready: this._ready,
      ...(this._installPct !== undefined ? { installPct: this._installPct } : {}),
      players: [...this._players],
      ...(this._failReason ? { failReason: this._failReason } : {}),
      ...(this._failDetail ? { failDetail: this._failDetail } : {}),
      restarts: this._crashes.length,
    };
  }

  private to(status: ServerStatus, now: number): void {
    this._status = status;
    this._since = now;
  }

  /** Legal only from a settled state — an install must never race a live process. */
  beginInstall(now: number): boolean {
    if (this._status !== 'idle' && this._status !== 'stopped' && this._status !== 'crashed') return false;
    this._failReason = undefined;
    this._failDetail = undefined;
    this._installPct = 0;
    this.to('installing', now);
    return true;
  }

  installProgress(pct: number): void {
    if (this._status !== 'installing') return;
    this._installPct = Math.max(0, Math.min(100, Math.round(pct)));
  }

  installDone(now: number): void {
    if (this._status !== 'installing') return;
    this._installPct = undefined;
    this.to('idle', now);
  }

  installFailed(detail: string, now: number): void {
    if (this._status !== 'installing') return;
    this._installPct = undefined;
    this._failReason = 'install-failed';
    this._failDetail = detail;
    this.to('crashed', now);
  }

  /** Caller has validated the plan and is about to spawn. */
  beginStart(now: number): boolean {
    if (this._status !== 'idle' && this._status !== 'stopped' && this._status !== 'crashed') return false;
    this._ready = false;
    this._players.clear();
    this._fatalSeen = false;
    this._failReason = undefined;
    this._failDetail = undefined;
    this.to('starting', now);
    return true;
  }

  /** The spawn itself failed (missing runtime, EACCES) — never reached a pid. */
  startFailed(reason: ServerFailReason, detail: string, now: number): void {
    this._failReason = reason;
    this._failDetail = detail;
    this.to('crashed', now);
  }

  /** Fold one structured event from the module's parseLine. */
  applyEvent(e: GameEvent, now: number): void {
    switch (e.t) {
      case 'ready':
        if (this._status === 'starting') {
          this._ready = true;
          this.to('running', now);
          // A clean start clears the crash budget: the previous failures were
          // evidently transient, and holding them against a server that has been
          // up for hours would make the Nth legitimate restart look like a loop.
          this._crashes = [];
        }
        break;
      case 'player-join':
        this._players.add(e.name);
        break;
      case 'player-leave':
        this._players.delete(e.name);
        break;
      case 'error':
        if (e.fatal) {
          this._fatalSeen = true;
          this._failDetail = e.text;
        }
        break;
      case 'progress':
      case 'warn':
      case 'chat':
        break;
      default: {
        const never: never = e;
        void never;
      }
    }
  }

  /** Authoritative population from an out-of-band probe (SLP), which survives
   *  missed log lines. */
  setPlayers(names: string[]): void {
    this._players = new Set(names);
  }

  /** A graceful stop was requested. */
  beginStop(now: number): boolean {
    if (this._status !== 'starting' && this._status !== 'running') return false;
    this.to('stopping', now);
    return true;
  }

  /**
   * The process exited. Returns what the supervisor should do next.
   *
   * `expected` is true when WE asked it to stop. An unexpected exit spends one
   * unit of the restart budget — except when the module flagged a fatal log
   * line, which goes terminal immediately, because burning three restarts on an
   * OutOfMemoryError only delays telling the user to raise -Xmx.
   */
  exited(opts: { expected: boolean; code: number | null; signal: string | null; autoRestart: boolean }, now: number): ExitDisposition {
    const { expected, code, signal, autoRestart } = opts;
    this._ready = false;
    this._players.clear();

    if (expected) {
      this.to('stopped', now);
      return 'stopped';
    }

    const how = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
    // Never reached 'ready': almost always a configuration problem (port taken,
    // bad jar, too little memory at boot) rather than a crash under load.
    const early = this._status === 'starting';

    if (this._fatalSeen) {
      this._failReason = 'fatal-log';
      this._failDetail = this._failDetail ?? how;
      this.to('crashed', now);
      return 'crashed';
    }

    this._crashes = this._crashes.filter((t) => now - t < RESTART_WINDOW_MS);
    this._crashes.push(now);

    if (!autoRestart || this._crashes.length > MAX_RESTARTS) {
      this._failReason = this._crashes.length > MAX_RESTARTS ? 'crash-loop' : (early ? 'exited-early' : 'unknown');
      this._failDetail = how;
      this.to('crashed', now);
      return 'crashed';
    }

    this._failReason = early ? 'exited-early' : 'unknown';
    this._failDetail = how;
    this.to('starting', now);
    return 'restart';
  }

  /**
   * Arm the FSM for the automatic restart that exited() just asked for.
   *
   * exited() deliberately parks a restarting instance in 'starting' rather than
   * 'idle' so nothing else can claim the slot during the restart delay — a user
   * pressing Start in that window must not produce two processes. This is the
   * one legal way back out, and it PRESERVES the crash budget: clearFailure()
   * would reset it, which is exactly how a crash loop becomes invisible.
   */
  prepareRestart(now: number): boolean {
    if (this._status !== 'starting') return false;
    this.to('idle', now);
    return true;
  }

  /** The graceful stop timed out and the process had to be killed. */
  killed(now: number): void {
    this._ready = false;
    this._players.clear();
    this._failReason = 'stop-timeout';
    this._failDetail = 'the process did not exit in time and was terminated';
    this.to('stopped', now);
  }

  /** Clear a terminal failure so the user can try again. */
  clearFailure(now: number): void {
    if (this._status !== 'crashed') return;
    this._failReason = undefined;
    this._failDetail = undefined;
    this._crashes = [];
    this._fatalSeen = false;
    this.to('idle', now);
  }
}

/** Whether a status means a process is (or should be) alive. */
export function isLive(status: ServerStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'stopping';
}
