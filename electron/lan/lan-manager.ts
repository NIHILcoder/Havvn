/**
 * LanManager — main-process orchestrator for the Havvn Virtual-LAN feature
 * (plan §1, §5; contracts: helper-pipe / lifecycle). It is the ONLY place the
 * elevated helper's lifecycle lives; it is NEVER on the packet path.
 *
 * Responsibilities (this file, main process):
 *  1. Capture the INTERACTIVE user's SID (main runs as that user) and pass it —
 *     plus an ABSOLUTE handshake-file path and main's PID — to the helper via
 *     argv (plan §0.1 #3). The secret token lives ONLY in the 0o600 file at that
 *     path, never in argv (command lines are world-readable).
 *  2. Spawn the helper elevated via `powershell Start-Process -Verb RunAs
 *     -PassThru` (relaunch of Havvn.exe --lan-helper). Exactly one UAC prompt.
 *  3. Hand the engine window the pipe rendezvous (pipeName + token + subnet +
 *     selfVip) so it can dial the DACL'd named pipe as a plain net client. Main
 *     is not on the pipe — the engine window owns both the pipe client and the
 *     WebRTC mesh.
 *  4. Enforce the beta single-active-LAN-session invariant (plan §0.1 #5).
 *  5. Gate on the VPN kill-switch (netSuspended) BEFORE spawning AND again AFTER
 *     the UAC await resolves — the prompt is an unbounded window during which the
 *     VPN can drop (plan §7).
 *  6. Own teardown for every path (app-quit / engine-crash / VPN-suspend). Main
 *     CANNOT force-kill the helper (medium→high IL = Access Denied), so teardown
 *     is cooperative: request the engine to send the pipe `shutdown` control verb,
 *     and rely on the helper's own PID-watchdog (it self-reverts + exits when
 *     main dies). We only WATCH the helper PID for liveness.
 *
 * INTEGRATION SEAMS (wired in the integration phase — do NOT edit those files
 * here). See the block comment at the bottom of this file for exact anchors.
 *
 * Node/electron are lazy-required inside methods (not at import time) so a plain
 * `vitest` import of this module does not pull electron or koffi, mirroring
 * wintun.ts / room-voice.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

import { sessionSubnet, deriveVip, vipToString, SESSION_PREFIX } from '../../shared/lan-ip';
import { lanPipePath } from './pipe-bridge';
import { lanSubnets } from './lan-net-registry';

/** MUST equal pipe-bridge.ts LAN_PIPE_PROTO. Kept local so this module type-checks
 *  in isolation; integration should assert the two are identical. */
const HANDSHAKE_PROTO = 1;

/** Fixed tunnel MTU — >1192 fragments SCTP into two packets, doubling loss (plan
 *  §0 dec.5). */
const LAN_MTU = 1280;

/** Per-destination on-link routes the helper installs (NOT a blanket
 *  InterfaceMetric 1, which would hijack transmission's own LSD; plan §5).
 *
 *  MUST mirror helper-main.ts DEFAULT_FORWARD_ROUTES.
 *
 *  224.0.2.60 is Minecraft's LAN-discovery group. Unlike the announcer we send
 *  ourselves for a dedicated server (which pins the interface with
 *  setMulticastInterface and therefore needs no route), a vanilla client that
 *  "opens a world to LAN" sends to that group from a socket it never pins — so
 *  the datagram follows the ROUTE TABLE, and without an entry here it leaves via
 *  the physical adapter and never enters the tunnel. The router already
 *  replicates the whole of 224.0.0.0/4 (shared/lan-packet.ts classifyDest), so
 *  the receive half needs nothing; this is purely the egress half.
 *
 *  Kept as a literal rather than imported from the Minecraft module: the LAN
 *  transport must not depend on a game module (the dependency runs the other
 *  way — a module plans an announce, the tunnel carries it). */
const FORWARD_ROUTES = ['255.255.255.255/32', '224.0.0.251/32', '239.255.255.250/32', '224.0.2.60/32'];

/** Firewall RemoteAddress scope — only virtual traffic is opened (plan §5). */
const FIREWALL_REMOTE = '100.64.0.0/10';

/** Per-session identity prefix; orphan-sweep + single-session scope key off it
 *  (plan §0.1 #5). */
const ADAPTER_PREFIX = 'Havvn LAN-';

/** UAC cancel surfaces as this Win32 code (ERROR_CANCELLED). */
const ERROR_CANCELLED = 1223;

/**
 * Absolute path to a Windows system tool.
 *
 * NEVER invoke these by bare name. The PATH is inherited from whoever launched
 * the app, and a Git Bash / MSYS / Cygwin environment puts its own POSIX
 * `whoami.exe` ahead of System32. That one treats `/user` as an operand and
 * exits 1, so the SID lookup silently returns '', the helper is spawned with
 * `--sid=`, refuses to start, and the ONLY thing the user is shown is the
 * engine's pipe connect timing out twenty seconds later — a symptom three layers
 * away from the cause. (Found exactly that way; the helper's own log named it.)
 */
export function systemToolPath(exe: string): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', exe);
}

/**
 * Pull the account SID out of `whoami /user /fo csv /nh`, whose one line reads
 * `"hostname\user","S-1-5-21-…"`. Returns '' for anything else — including a
 * POSIX whoami's bare username, which is the failure this exists to survive.
 */
export function parseUserSid(out: string): string {
  const m = /S-1-[0-9-]+/.exec(String(out || ''));
  return m ? m[0] : '';
}

/** How long stop() waits for the (elevated) helper to actually exit before it
 *  gives up and leaves the PID-watchdog / orphan-sweep as the backstop. */
const HELPER_EXIT_GRACE_MS = 4000;

// ────────────────────────────────────────────────────────────────────────────
// Public shapes
// ────────────────────────────────────────────────────────────────────────────

/** Parameters the engine (via RoomManager) hands us to start a session. The
 *  sessionId/hostId are engine-owned (pinned lan-genesis root, plan §0.1 #7);
 *  selfMemberId derives our vIP. */
export interface LanStartParams {
  roomId: string;
  sessionId: string;
  hostId: string;
  selfMemberId: string;
  /** Collision-arbitration generation for our own vIP (0 unless we lost). */
  gen?: number;
}

/** What start() returns — everything the engine window needs to dial the pipe and
 *  render the panel. `token`+`pipeName` are the rendezvous the engine connects to;
 *  `selfVip` is our assigned dotted-quad. */
export interface LanHelperHandle {
  roomId: string;
  sessionId: string;
  pipeName: string;   // \\.\pipe\havvn-lan-<token> — engine connects as client
  token: string;      // handshake secret (also written 0o600 to the argv path)
  subnet: string;     // '100.<64..127>.0.0/16' for display
  selfVip: string;    // our dotted-quad virtual IP
  helperPid: number;  // elevated helper PID (liveness watch only; unkillable from main)
}

/** The elevated network mutations the helper performs in its one UAC block. Every
 *  field is main-computed; the helper re-validates none-past its own gates. */
export interface LanSetupRequest {
  sessionId: string;
  adapterName: string;        // `Havvn LAN-${sessionId}` — helper deny-list-gates the name
  vip: number;                // uint32; deriveVip(sessionId, selfMemberId, gen)
  subnetBase: number;         // uint32; sessionSubnet(sessionId).base
  prefix: number;             // SESSION_PREFIX (16)
  mtu: number;                // LAN_MTU (1280)
  forwardRoutes: string[];
  firewallRemote: string;
}

/** Written 0o600 at an absolute path under the INTERACTIVE user's userData; the
 *  path is passed to the helper via argv. The token lives here and NOWHERE in
 *  argv. */
export interface LanHandshakeFile {
  proto: number;              // === HANDSHAKE_PROTO
  token: string;
  pipeName: string;           // \\.\pipe\havvn-lan-<token>
  parentPid: number;          // main's PID — helper OpenProcess(SYNCHRONIZE) watchdog target
  interactiveSid: string;     // S-1-5-21-… — the DACL subject the helper grants
  setup: LanSetupRequest;
}

/** Optional wiring the integration phase supplies (kept out of the constructor so
 *  the singleton stays trivially constructible / node-testable). */
export interface LanManagerConfig {
  /** Reads RoomManager.networkSuspended — re-checked AFTER the UAC await. */
  isNetSuspended?: () => boolean;
  /** Asks the engine window to send the pipe `shutdown` control verb to the
   *  helper (main is not on the pipe). Cooperative teardown of a live session. */
  requestEngineShutdown?: (sessionId: string) => void;
  /** Surface a transient warning to the UI (UAC cancelled, helper crashed, …). */
  onWarning?: (msg: string) => void;
  /** Structured logging sink. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;
}

interface ActiveSession extends LanHelperHandle {
  handshakePath: string;
  adapterName: string;
  watchTimer: NodeJS.Timeout | null;
}

// ────────────────────────────────────────────────────────────────────────────
// LanManager
// ────────────────────────────────────────────────────────────────────────────

export class LanManager {
  private active: ActiveSession | null = null;
  private cfg: LanManagerConfig = {};
  /** Cached availability probe (koffi + wintun.dll resolvable). */
  private availability: { ok: boolean; reason?: string } | null = null;

  /** Wire integration-supplied hooks. Idempotent; merges over previous config. */
  configure(cfg: LanManagerConfig): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  // ── availability + single-session gate ────────────────────────────────────

  /** koffi + wintun.dll resolvable AND win32 → Start is offerable. Cheap and
   *  cached; never throws. */
  available(): { ok: boolean; reason?: string } {
    if (this.availability) return this.availability;
    let result: { ok: boolean; reason?: string };
    if (process.platform !== 'win32') {
      result = { ok: false, reason: 'windows-only' };
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('koffi');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { resolveWintunDll } = require('./wintun') as typeof import('./wintun');
        resolveWintunDll(); // throws if the dll isn't shipped/fetched
        result = { ok: true };
      } catch (e) {
        result = { ok: false, reason: e instanceof Error ? e.message : 'unavailable' };
      }
    }
    this.availability = result;
    return result;
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  activeSessionId(): string | null {
    return this.active?.sessionId ?? null;
  }

  activeRoomId(): string | null {
    return this.active?.roomId ?? null;
  }

  /** Beta single-global-session gate: a room may start only if nothing is active
   *  or the active session is already ITS own (idempotent restart). */
  canStart(roomId: string): boolean {
    return this.active === null || this.active.roomId === roomId;
  }

  // ── start ─────────────────────────────────────────────────────────────────

  /**
   * Spawn the elevated helper (1 UAC), write the handshake, and return the pipe
   * rendezvous for the engine. Throws:
   *   'busy'              another room holds the single session
   *   'unavailable'       koffi/wintun.dll missing (with reason)
   *   'net-suspended'     VPN kill-switch active (checked before AND after UAC)
   *   'no-user-sid'       the account SID lookup failed (checked BEFORE the UAC
   *                       prompt — the helper cannot DACL its pipe without it)
   *   'elevation-denied'  UAC cancelled (exit 1223 / "canceled by the user")
   *   'spawn-failed'      Start-Process error
   */
  async start(p: LanStartParams): Promise<LanHelperHandle> {
    if (!this.canStart(p.roomId)) throw new Error('busy');
    if (this.active && this.active.roomId === p.roomId) return this.active; // idempotent

    const avail = this.available();
    if (!avail.ok) throw new Error(`unavailable: ${avail.reason ?? ''}`.trim());

    // Gate #1: refuse to even prompt while the VPN is down (plan §7).
    if (this.cfg.isNetSuspended?.()) throw new Error('net-suspended');

    const { app } = this.electron();
    const sessionId = p.sessionId;
    const gen = p.gen ?? 0;

    const token = crypto.randomBytes(32).toString('base64url');
    // Name the pipe from the NON-secret sessionId (hex.hex), NOT the token:
    // named-pipe names are world-enumerable (Get-ChildItem \\.\pipe\), so a
    // token in the name would leak the very secret the 0o600 handshake protects
    // (must-fix #3, HIGH). The token stays file-only and gates the hello.
    const pipeName = lanPipePath(sessionId);
    const adapterName = `${ADAPTER_PREFIX}${sessionId}`;
    const subnet = sessionSubnet(sessionId);
    const vipNum = deriveVip(sessionId, p.selfMemberId, gen);
    const subnetStr = `${vipToString(subnet.base)}/${SESSION_PREFIX}`;

    const interactiveSid = this.getInteractiveUserSid();
    // FAIL FAST, and BEFORE the UAC prompt. The helper DACLs its pipe to this SID
    // and exits immediately without one, so continuing would burn an elevation
    // prompt on a process doomed to die and then report the engine's 20 s pipe
    // timeout — a message that sends the reader looking at the network.
    if (!interactiveSid) throw new Error('no-user-sid: could not determine this Windows account\'s SID, so the LAN helper cannot secure its pipe');

    const handshake: LanHandshakeFile = {
      proto: HANDSHAKE_PROTO,
      token,
      pipeName,
      parentPid: process.pid,
      interactiveSid,
      setup: {
        sessionId,
        adapterName,
        vip: vipNum >>> 0,
        subnetBase: subnet.base >>> 0,
        prefix: SESSION_PREFIX,
        mtu: LAN_MTU,
        forwardRoutes: FORWARD_ROUTES.slice(),
        firewallRemote: FIREWALL_REMOTE,
      },
    };

    const handshakePath = this.writeHandshake(app.getPath('userData'), sessionId, handshake);

    let helperPid: number;
    try {
      helperPid = await this.spawnHelper(sessionId, interactiveSid, handshakePath);
    } catch (e) {
      this.safeUnlink(handshakePath);
      throw e; // 'elevation-denied' | 'spawn-failed'
    }

    // Gate #2: the UAC prompt is an unbounded await — re-check the kill-switch and
    // revert the just-spawned helper if the VPN dropped during it (plan §7).
    if (this.cfg.isNetSuspended?.()) {
      this.safeUnlink(handshakePath);
      // The helper is elevated and self-reverts when main asks it to shut down OR
      // when its PID-watchdog sees main die; we cannot kill it here. Best effort:
      // leave the handshake removed and let the engine never connect → the helper
      // times out its connect-wait and reverts. Also flag for orphan-sweep.
      this.cfg.log?.('warn', 'LAN start aborted: VPN dropped during UAC prompt');
      throw new Error('net-suspended');
    }

    const session: ActiveSession = {
      roomId: p.roomId,
      sessionId,
      pipeName,
      token,
      subnet: subnetStr,
      selfVip: vipToString(vipNum),
      helperPid,
      handshakePath,
      adapterName,
      watchTimer: null,
    };
    this.active = session;
    // Register the /16 so every VPN/address surface excludes it BY RANGE
    // (must-fix #8) — our own adapter must never read as a VPN or be advertised.
    lanSubnets.set(sessionId);
    this.watchHelper(session);
    this.cfg.log?.('info', 'LAN session started', { roomId: p.roomId, sessionId, helperPid, vip: session.selfVip });
    return session;
  }

  // ── stop / teardown ───────────────────────────────────────────────────────

  /** Cooperative stop of a session (default: the active one). Asks the engine to
   *  send the pipe `shutdown` verb; the helper reverts adapter/route/firewall and
   *  exits on its own (or via its PID-watchdog if the engine is already gone).
   *  Main cannot force-kill the elevated helper. */
  async stop(sessionId?: string): Promise<void> {
    const s = this.active;
    if (!s) return;
    if (sessionId && s.sessionId !== sessionId) return; // not the active one

    this.cfg.log?.('info', 'Stopping LAN session', { sessionId: s.sessionId });
    if (s.watchTimer) { clearInterval(s.watchTimer); s.watchTimer = null; }

    // Ask the engine window to send the cooperative `shutdown` control verb.
    try { this.cfg.requestEngineShutdown?.(s.sessionId); } catch { /* engine may be gone */ }

    // Wait (bounded) for the helper to actually exit — it reverts before exiting.
    await this.awaitHelperExit(s.helperPid, HELPER_EXIT_GRACE_MS);

    this.safeUnlink(s.handshakePath);
    lanSubnets.clear(s.sessionId); // stop excluding a torn-down /16 (never hide a real VPN)
    if (this.active === s) this.active = null;

    // Backstop: if it did not exit in time (engine gone AND watchdog slow), the
    // orphan-sweep on next enable/startup cleans the adapter/firewall by prefix.
  }

  /** VPN kill-switch: tear the active session down with the rest of networking. */
  onVpnSuspend(): void {
    if (!this.active) return;
    this.cfg.log?.('warn', 'VPN suspend — tearing down LAN session');
    void this.stop();
  }

  /** Engine window crashed (render-process-gone): the LanSession object is gone
   *  but the adapter/firewall/helper survive. Trigger teardown so the helper
   *  reverts (its watchdog also self-reverts once the engine pipe closes). */
  onEngineGone(roomId?: string): void {
    if (!this.active) return;
    if (roomId && this.active.roomId !== roomId) return;
    this.cfg.log?.('warn', 'Engine gone — tearing down LAN session');
    void this.stop();
  }

  /** App-quit teardown hook (main.ts cleanup). Stop the active session within the
   *  quit budget, then a best-effort non-elevated orphan detect. */
  async shutdown(): Promise<void> {
    try { await this.stop(); } catch (e) { this.cfg.log?.('warn', 'LAN shutdown stop failed', e); }
    // Main is exiting: the helper's PID-watchdog fires on our death and reverts.
  }

  // ── orphan sweep ──────────────────────────────────────────────────────────

  /**
   * Idempotent, NON-elevated detect of leftover `Havvn LAN-*` adapters (crash of
   * BOTH processes). Actual removal needs admin and is deferred to the next
   * elevated helper run (which sweeps by prefix on enable) — here we only detect
   * and warn (plan §5). Returns the adapter names found.
   */
  async sweepOrphans(): Promise<string[]> {
    if (process.platform !== 'win32') return [];
    const names = await this.detectOrphanAdapters();
    if (names.length) {
      this.cfg.log?.('warn', 'LAN orphan adapters detected (elevated cleanup deferred)', { names });
    }
    return names;
  }

  // ── private: interactive SID ──────────────────────────────────────────────
  //
  // (systemToolPath / parseUserSid are module-level + exported so the two rules
  // that matter here are pinned by tests without shelling out at all.)

  /**
   * The interactive user's SID (= main's own; main runs as that user), parsed
   * from `whoami /user /fo csv /nh`. Returns '' on any failure — and the caller
   * must treat that as FATAL, not as a soft degrade: the helper DACLs its pipe to
   * this SID and refuses to start without one.
   */
  getInteractiveUserSid(): string {
    if (process.platform !== 'win32') return '';
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      const out = execFileSync(systemToolPath('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
      return parseUserSid(out);
    } catch (e) {
      this.cfg.log?.('warn', 'getInteractiveUserSid failed', e);
      return '';
    }
  }

  // ── private: handshake file ───────────────────────────────────────────────

  /** Write the 0o600 handshake JSON at an ABSOLUTE path under the interactive
   *  user's userData; return that path (passed to the helper via --handshake). */
  private writeHandshake(userData: string, sessionId: string, hs: LanHandshakeFile): string {
    const dir = path.join(userData, 'lan');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `handshake-${this.safeFileToken(sessionId)}.json`);
    fs.writeFileSync(file, JSON.stringify(hs), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* windows sets read-only only; per-user dir is the real guard */ }
    return file;
  }

  private safeFileToken(s: string): string {
    return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  }

  private safeUnlink(file: string): void {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }

  // ── private: elevated spawn ───────────────────────────────────────────────

  /**
   * Relaunch Havvn.exe --lan-helper elevated via `Start-Process -Verb RunAs
   * -PassThru`, returning the elevated helper PID. The token is NOT here — it is
   * in the 0o600 handshake file at handshakePath (plan §0.1 #3).
   *
   * In dev (`process.defaultApp`), process.execPath is electron.exe, so the app
   * entry script must ride as the first ArgumentList element and --app-path lets
   * the helper resolve resources (mirrors the protocol-registration dev args).
   */
  private spawnHelper(sessionId: string, interactiveSid: string, handshakePath: string): Promise<number> {
    const { app } = this.electron();
    const isDev = Boolean((process as unknown as { defaultApp?: boolean }).defaultApp);

    const helperArgs: string[] = [
      '--lan-helper',
      `--session=${sessionId}`,
      `--sid=${interactiveSid}`,
      `--handshake=${handshakePath}`,
      `--parent-pid=${process.pid}`,
    ];
    const argList: string[] = [];
    if (isDev) {
      // electron.exe <mainScript> --lan-helper …  + resource resolution hint
      if (process.argv[1]) argList.push(process.argv[1]);
      argList.push(...helperArgs, `--app-path=${app.getAppPath()}`);
    } else {
      argList.push(...helperArgs);
    }

    // TWO levels of quoting are required, and missing the inner one is a real bug:
    // Start-Process joins -ArgumentList with spaces and does NOT re-quote, so an
    // argument containing a space — e.g. --handshake=C:\Users\First Last\AppData\...
    // — reaches the child SPLIT into two argv entries (observed: the helper read
    // 'C:\Users\PROXY' and died with ENOENT before it could create the pipe).
    //   inner: wrap in double quotes for the child's CommandLineToArgvW parser
    //   outer: single-quote for PowerShell's own string literal
    const psArgList = argList
      .map((a) => {
        const forChild = `"${a.replace(/"/g, '\\"')}"`;
        return `'${forChild.replace(/'/g, "''")}'`;
      })
      .join(',');
    const exe = process.execPath.replace(/'/g, "''");
    // -PassThru gives the elevated process object; emit only its Id on stdout.
    const psScript =
      `$ErrorActionPreference='Stop';` +
      `$p = Start-Process -FilePath '${exe}' -Verb RunAs -PassThru -ArgumentList ${psArgList};` +
      `[Console]::Out.Write($p.Id)`;

    return new Promise<number>((resolve, reject) => {
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        { windowsHide: true, timeout: 120_000 },
        (err, stdout, stderr) => {
          const out = String(stdout || '').trim();
          const errText = String(stderr || '') + (err ? String(err.message || '') : '');
          if (/1223|canceled by the user|cancelled by the user|The operation was canceled/i.test(errText)) {
            this.cfg.onWarning?.('elevation-denied');
            return reject(new Error('elevation-denied'));
          }
          const pid = parseInt(out, 10);
          if (!Number.isFinite(pid) || pid <= 0) {
            this.cfg.log?.('error', 'LAN helper spawn failed', { errText, out });
            return reject(new Error('spawn-failed'));
          }
          resolve(pid);
        },
      );
    });
  }

  // ── private: liveness watch (WATCH only — cannot kill) ────────────────────

  /** Poll the elevated helper PID for liveness. From medium IL we can only WATCH,
   *  never kill: process.kill(pid,0) → EPERM means alive (elevated), ESRCH means
   *  it exited. On exit, clear state (the helper reverted before exiting). */
  private watchHelper(s: ActiveSession): void {
    if (s.watchTimer) clearInterval(s.watchTimer);
    s.watchTimer = setInterval(() => {
      if (!this.isPidAlive(s.helperPid)) {
        this.cfg.log?.('warn', 'LAN helper exited', { sessionId: s.sessionId, helperPid: s.helperPid });
        if (s.watchTimer) { clearInterval(s.watchTimer); s.watchTimer = null; }
        this.safeUnlink(s.handshakePath);
        lanSubnets.clear(s.sessionId); // helper gone → its /16 is no longer active
        if (this.active === s) {
          this.active = null;
          this.cfg.onWarning?.('helper-exited');
        }
      }
    }, 1000);
    // Don't keep the event loop alive purely for this poll.
    if (typeof s.watchTimer.unref === 'function') s.watchTimer.unref();
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;        // signalled fine → alive
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'EPERM'; // EPERM = alive but not ours to signal (elevated); ESRCH = gone
    }
  }

  /** Resolve once the helper PID is gone or the grace window elapses. */
  private awaitHelperExit(pid: number, graceMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.isPidAlive(pid)) return resolve();
      const deadline = Date.now() + graceMs;
      const timer = setInterval(() => {
        if (!this.isPidAlive(pid) || Date.now() >= deadline) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  // ── private: orphan detect (non-elevated) ─────────────────────────────────

  private detectOrphanAdapters(): Promise<string[]> {
    return new Promise<string[]>((resolve) => {
      const psScript =
        `Get-NetAdapter -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.Name -like '${ADAPTER_PREFIX}*' } | ` +
        `Select-Object -ExpandProperty Name`;
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        { windowsHide: true, timeout: 15_000 },
        (_err, stdout) => {
          const names = String(stdout || '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          resolve(names);
        },
      );
    });
  }

  // ── private: lazy electron ────────────────────────────────────────────────

  private electron(): typeof import('electron') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('electron') as typeof import('electron');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Singleton
// ────────────────────────────────────────────────────────────────────────────

let singleton: LanManager | null = null;

/** Process-global LanManager (main process). */
export function getLanManager(): LanManager {
  if (!singleton) singleton = new LanManager();
  return singleton;
}

/**
 * Non-blocking startup orphan detect — call fire-and-forget from initializeApp.
 * A crash of BOTH processes can strand an adapter/firewall; removal needs admin,
 * so this only detects + warns (elevated removal happens on the next helper run).
 */
export async function startupOrphanSweep(): Promise<void> {
  try { await getLanManager().sweepOrphans(); } catch { /* best effort */ }
}

/*
 * ── INTEGRATION REGISTRATION POINTS (do NOT edit those files here) ───────────
 *
 * 1. electron/main.ts — initializeApp() (~line 798): fire-and-forget
 *      import('./lan/lan-manager').then(m => m.startupOrphanSweep());
 *
 * 2. electron/main.ts — cleanup() (~line 1173, before getRoomManager().destroy()):
 *      try { const { getLanManager } = await import('./lan/lan-manager');
 *            await getLanManager().shutdown(); } catch { }
 *
 * 3. electron/sharing/room-manager.ts — constructor: wire the config hooks
 *      getLanManager().configure({
 *        isNetSuspended: () => this.networkSuspended,
 *        requestEngineShutdown: (sid) => this.call('lanStop', { sessionId: sid }),
 *        onWarning: (msg) => this.mainWindow?.webContents.send('rooms:lanWarn', msg),
 *        log: (lvl, m, x) => log[lvl]?.(m, x),
 *      });
 *
 * 4. electron/sharing/room-manager.ts — suspendNetworking() (~1124, after
 *    networkSuspended=true): getLanManager().onVpnSuspend();
 *    resumeNetworking() MUST NOT auto-restart LAN (membership is explicit).
 *
 * 5. electron/sharing/room-manager.ts — render-process-gone (~363):
 *      getLanManager().onEngineGone();
 *
 * 6. electron/sharing/room-manager.ts — destroy() (~1163):
 *      void getLanManager().shutdown();
 *
 * 7. electron/sharing/room-manager.ts — the lanStart delegate:
 *      assertNotSuspended();
 *      const handle = await getLanManager().start({ roomId, sessionId, hostId, selfMemberId });
 *      then push room-cmd 'lanConnect' { pipeName: handle.pipeName, token: handle.token,
 *        subnet: handle.subnet, selfVip: handle.selfVip } to the engine window so it
 *        dials the pipe (LanPipeClient) and wires the LanSession mesh.
 *
 * 8. The `requestEngineShutdown` hook should map to the engine's room-cmd 'lanStop',
 *    which triggers LanSession to send the pipe `shutdown` control verb (main is not
 *    on the pipe). The helper reverts adapter/route/firewall and exits; its own
 *    PID-watchdog is the backstop if the engine is already gone.
 *
 * 9. HANDSHAKE_PROTO here MUST equal pipe-bridge.ts LAN_PIPE_PROTO — dedupe by
 *    importing it from pipe-bridge once that module lands.
 *
 * 10. LanSetupRequest / LanHandshakeFile are ALSO expected by helper-main.ts from
 *     pipe-bridge.ts. Unify to a single home at integration (import them here from
 *     pipe-bridge and drop the local copies) so the helper reads the exact shape
 *     this manager writes. Field names/values must match byte-for-byte.
 */
