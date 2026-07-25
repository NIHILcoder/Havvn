/**
 * Elevated helper entry for the Havvn Virtual-LAN feature (plan §1, §5).
 *
 * This process is relaunched as `Havvn.exe --lan-helper` via
 * `Start-Process -Verb RunAs` (one UAC prompt) and is the ONLY thing in the app
 * that holds an Administrator token. It is deliberately TRIVIAL — Wintun ring ⇄
 * named pipe, plus the single elevated net-config block — and carries ZERO
 * protocol/routing/classification logic (that is the engine window's routing
 * brain, plan §1). Minimal attack surface for an admin-token process.
 *
 * Startup order (§5, must-fix #3/#5), single UAC already granted:
 *   assertElevated → parse argv (SID + absolute handshake path + parent PID) →
 *   read the handshake file (the token lives ONLY there, never in argv) →
 *   idempotent orphanSweep(prefix) → startParentWatchdog(main PID) →
 *   LanPipeServer.listen() DACL'd to the interactive SID (pipe-first) →
 *   loadWintun + applyNetConfig (adapter/IP/MTU 1280/on-link routes/firewall) →
 *   sendControl('ready') → ring⇄pipe pump.
 *
 * Any setup failure → sendControl('error') (if the pipe is up) + revertNetConfig
 * + exit. runLanHelper NEVER throws to the top-level uncaught handler.
 *
 * HARD CONSTRAINTS:
 *  - Runs only in the elevated relaunch; wintun.ts refuses to load off-Windows
 *    and off-admin, so nothing here touches the driver until applyNetConfig.
 *  - The parent (main, medium IL) can only WATCH this PID, never kill it
 *    (medium→high IL is Access Denied); teardown is cooperative via the pipe
 *    CH_CONTROL 'shutdown' verb, or self-driven by the PID watchdog when main
 *    dies. Hence the watchdog is armed BEFORE any adapter work.
 *  - koffi is lazy-required (watchdog only) so a missing prebuild degrades to a
 *    tagged error, never an import-time crash (mirrors wintun.ts / global-ptt).
 */
/* eslint-disable @typescript-eslint/no-var-requires */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadWintun, resolveWintunDll, type WintunLib } from './wintun';
import { vipToString } from '../../shared/lan-ip';
import {
  LanPipeServer,
  LAN_PIPE_PROTO,
  type LanControlMsg,
  type LanHelperErrorCode,
} from './pipe-bridge';
// Type-only so the helper's import graph never pulls lan-manager's electron deps.
import type { LanSetupRequest, LanHandshakeFile } from './lan-manager';

/** Per-session adapter/firewall/sweep name prefix (must-fix #5). Every artifact
 *  this helper creates is named `Havvn LAN-<sessionId>`, so the prefix scopes
 *  the idempotent orphan-sweep without touching a live sibling session. */
export const LAN_NAME_PREFIX = 'Havvn LAN-';

/** The on-link groups we forward (per-destination /32 routes, NORMAL metric —
 *  never a blanket InterfaceMetric 1, which would hijack our own transmission
 *  LSD, plan §5 should-fix). Overridable via the handshake for future groups. */
const DEFAULT_FORWARD_ROUTES = ['255.255.255.255/32', '224.0.0.251/32', '239.255.255.250/32'];

/** VPN-ish tokens forbidden in the adapter name so the VPN-detector never trips
 *  on our own adapter by name (§5/§7); the real exclusion is by ADDRESS RANGE. */
const VPN_NAME_TOKENS = /(vpn|tun|tap|wg|ppp\d|ipsec|l2tp)/i;

/** A setup/runtime failure tagged with the code the engine surfaces to the UI. */
export class LanHelperError extends Error {
  constructor(public readonly code: LanHelperErrorCode, message: string) {
    super(message);
    this.name = 'LanHelperError';
  }
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

/**
 * Append a timestamped line to `<handshakePath>.log`.
 *
 * The helper is launched via ShellExecute "runas", which inherits NO stdio — so
 * everything written to process.stderr is LOST and a failing helper dies silently
 * (the engine only ever sees "pipe closed" / "timed out"). A file beside the
 * handshake (an absolute path under the INTERACTIVE user's profile, pre-created by
 * main, so that user can read it back) is the only diagnostic channel that
 * survives the elevation boundary. Best-effort: never throws, never blocks start.
 */
let logPath: string | null = null;
function hlog(msg: string): void {
  try {
    if (!logPath) {
      const hs = process.argv.find((a) => a.startsWith('--handshake='))?.slice('--handshake='.length);
      if (!hs) return;
      logPath = hs + '.log';
    }
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`, { encoding: 'utf8' });
  } catch { /* diagnostics must never break the helper */ }
}

// ── PowerShell shell-out helpers ─────────────────────────────────────────────

/** Escape a value for a single-quoted PowerShell string — an un-doubled
 *  apostrophe ends the literal (the psq() pattern from spike-harness.ts). */
const psq = (s: string): string => s.replace(/'/g, "''");

/** Run one PowerShell command synchronously. Returns ok=false on a non-zero exit
 *  ($ErrorActionPreference='Stop' in the script turns a cmdlet failure into one). */
function psRun(script: string): { ok: boolean; out: string; code: number | null } {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), code: r.status };
}

// ── Fail-fast elevation assert (plan §5) ─────────────────────────────────────

/**
 * Throw (→ process.exit(3) at the call site) if this process is not running with
 * a High-integrity / Administrator token — a clean error beats a half-initialised
 * tunnel. Uses a single PowerShell IsInRole check (no FFI, one spawn at startup).
 */
export function assertElevated(): void {
  if (process.platform !== 'win32') {
    throw new LanHelperError('not-elevated', 'LAN helper is Windows-only');
  }
  const r = psRun(
    '[bool]([Security.Principal.WindowsPrincipal]' +
      '[Security.Principal.WindowsIdentity]::GetCurrent())' +
      '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  );
  if (!r.ok || !/true/i.test(r.out)) {
    throw new LanHelperError('not-elevated', `helper is not elevated (High-IL assertion failed: ${r.out || 'no output'})`);
  }
}

/**
 * Reject any adapter name containing a VPN-ish token so the VPN-detector cannot
 * mistake our own adapter for a VPN by name (§5/§7). Range-based exclusion
 * (must-fix #8) is the real guard; this is defence in depth.
 */
export function validateAdapterName(name: string): void {
  if (!name || !name.startsWith(LAN_NAME_PREFIX)) {
    throw new LanHelperError('bad-adapter-name', `adapter name must start with "${LAN_NAME_PREFIX}": ${name}`);
  }
  if (VPN_NAME_TOKENS.test(name)) {
    throw new LanHelperError('bad-adapter-name', `adapter name contains a VPN-ish token: ${name}`);
  }
}

// ── The single elevated net-config block (plan §5) ───────────────────────────

/** Handles held for teardown. closeAdapter drops the IP + routes with the device;
 *  endSession releases the ring. Kept at module scope so revertNetConfig works
 *  even after a partial setup or a watchdog-driven exit. */
interface HeldState {
  wintun: WintunLib | null;
  adapter: unknown;
  session: unknown;
  req: LanSetupRequest | null;
}
const held: HeldState = { wintun: null, adapter: null, session: null, req: null };

/**
 * Create the Wintun adapter and perform every elevated network mutation in one
 * place: adapter → IP (New-NetIPAddress) → MTU 1280 → per-destination on-link
 * routes → scoped firewall allow-rules → StartSession(ring). Returns the Wintun
 * session handle (also stashed in `held` for revert). Throws LanHelperError with
 * a 'driver' | 'ip-config' | 'firewall' code so the engine can map the failure.
 */
export async function applyNetConfig(w: WintunLib, req: LanSetupRequest): Promise<unknown> {
  validateAdapterName(req.adapterName);
  held.wintun = w;
  held.req = req;

  const name = req.adapterName;
  const nameQ = psq(name);
  const ip = vipToString(req.vip >>> 0);
  const prefix = req.prefix >>> 0;
  const mtu = req.mtu >>> 0;
  const routes = req.forwardRoutes && req.forwardRoutes.length ? req.forwardRoutes : DEFAULT_FORWARD_ROUTES;
  const remote = req.firewallRemote || '100.64.0.0/10';

  // 1. Driver: create the adapter + start the ring session (installs on demand).
  let adapter: unknown;
  let session: unknown;
  try {
    adapter = w.createAdapter(name, 'Havvn');
    held.adapter = adapter;
    session = w.startSession(adapter);
    held.session = session;
  } catch (e) {
    throw new LanHelperError('driver', `adapter/session create failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. IP config: address + MTU + on-link routes (all 'ip-config'-tagged). The
  //    interface exists once the session is started, so this runs after it.
  const routeLines = routes
    .map((r: string) => `New-NetRoute -InterfaceAlias '${nameQ}' -DestinationPrefix '${psq(r)}' -NextHop 0.0.0.0 -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Out-Null`)
    .join('\n');
  const ipScript = [
    "$ErrorActionPreference='Stop'",
    `Remove-NetIPAddress -InterfaceAlias '${nameQ}' -Confirm:$false -ErrorAction SilentlyContinue`,
    `New-NetIPAddress -InterfaceAlias '${nameQ}' -IPAddress ${ip} -PrefixLength ${prefix} | Out-Null`,
    `Set-NetIPInterface -InterfaceAlias '${nameQ}' -NlMtuBytes ${mtu}`,
    routeLines,
  ].join('\n');
  const ipRes = psRun(ipScript);
  if (!ipRes.ok) {
    throw new LanHelperError('ip-config', `IP/MTU/route config failed for ${ip}/${prefix}: ${ipRes.out}`);
  }

  // 3. Firewall: Public adapter + scoped allow-rules (In+Out) for the session
  //    range only, keeping the adapter out of the user's real zones (§5). The
  //    DisplayName carries the 'Havvn LAN-' prefix so the orphan-sweep finds it.
  const fwScript = [
    "$ErrorActionPreference='Stop'",
    `New-NetFirewallRule -DisplayName '${nameQ} In' -Direction Inbound -InterfaceAlias '${nameQ}' -RemoteAddress '${psq(remote)}' -Action Allow | Out-Null`,
    `New-NetFirewallRule -DisplayName '${nameQ} Out' -Direction Outbound -InterfaceAlias '${nameQ}' -RemoteAddress '${psq(remote)}' -Action Allow | Out-Null`,
  ].join('\n');
  const fwRes = psRun(fwScript);
  if (!fwRes.ok) {
    throw new LanHelperError('firewall', `firewall rule create failed: ${fwRes.out}`);
  }

  return session;
}

/**
 * Idempotent reverse of applyNetConfig for exactly this session. Safe to call
 * twice / after a partial setup / after the handles are already gone: it drops
 * the Wintun handles (which removes the IP + routes with the device) AND removes
 * the firewall rules + any lingering IP by name.
 */
export async function revertNetConfig(req: LanSetupRequest): Promise<void> {
  // Close the ring + adapter first — closing the adapter tears the device down
  // and takes its IP/routes with it.
  try { if (held.wintun && held.session) held.wintun.endSession(held.session); } catch { /* ignore */ }
  try { if (held.wintun && held.adapter) held.wintun.closeAdapter(held.adapter); } catch { /* ignore */ }
  held.session = null;
  held.adapter = null;

  const nameQ = psq(req.adapterName);
  psRun(
    [
      "$ErrorActionPreference='SilentlyContinue'",
      `Get-NetFirewallRule -DisplayName '${nameQ}*' | Remove-NetFirewallRule -ErrorAction SilentlyContinue`,
      `Remove-NetIPAddress -InterfaceAlias '${nameQ}' -Confirm:$false -ErrorAction SilentlyContinue`,
    ].join('\n'),
  );
}

/**
 * Change the assigned vIP in place on collision-arbitration loss (must-fix #6):
 * a brief address flap (Remove + New). Tagged 'ip-config' on failure.
 */
function applyReip(vip: number): void {
  if (!held.req) return;
  const nameQ = psq(held.req.adapterName);
  const ip = vipToString(vip >>> 0);
  const prefix = held.req.prefix >>> 0;
  const r = psRun(
    [
      "$ErrorActionPreference='Stop'",
      `Remove-NetIPAddress -InterfaceAlias '${nameQ}' -Confirm:$false -ErrorAction SilentlyContinue`,
      `New-NetIPAddress -InterfaceAlias '${nameQ}' -IPAddress ${ip} -PrefixLength ${prefix} | Out-Null`,
    ].join('\n'),
  );
  if (r.ok) held.req = { ...held.req, vip: vip >>> 0 };
}

// ── Idempotent orphan-sweep (plan §5, should-fix) ────────────────────────────

/**
 * Enumerate leftover `Havvn LAN-*` adapters + firewall rules and, when elevated,
 * remove them. Runs on helper ENABLE (elevated: detect+remove, before creating a
 * fresh adapter) and is reachable from app-startup (non-elevated: detect only —
 * actual removal needs admin and is deferred to a prompt-elevated pass). Scoped
 * by the name/DisplayName prefix (must-fix #5). Returns what was found/removed.
 */
export async function orphanSweep(opts: { prefix?: string; elevated: boolean }): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const prefix = opts.prefix || LAN_NAME_PREFIX;
  const pQ = psq(prefix);
  const found: string[] = [];

  // Detect leftover adapters + firewall rules by prefix (non-fatal on error).
  // NOTE: filter SERVER-SIDE (-Name / -DisplayName). Enumerating every rule and
  // filtering in PowerShell takes tens of seconds on a real machine — slow enough
  // to blow the engine's pipe-connect deadline when this ran before listen().
  const adapters = psRun(
    `Get-NetAdapter -Name '${pQ}*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name`,
  );
  const adapterNames = adapters.ok
    ? adapters.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [];
  const rules = psRun(
    `Get-NetFirewallRule -DisplayName '${pQ}*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty DisplayName`,
  );
  const ruleNames = rules.ok
    ? rules.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [];

  for (const n of adapterNames) found.push(`adapter:${n}`);
  for (const n of ruleNames) found.push(`firewall:${n}`);

  if (!opts.elevated) return found; // detect-only pass — removal is deferred

  // Remove firewall rules by prefix.
  if (ruleNames.length) {
    psRun(`Remove-NetFirewallRule -DisplayName '${pQ}*' -ErrorAction SilentlyContinue`);
  }
  // Remove leftover Wintun adapters by opening + immediately closing them (a
  // Wintun adapter with no open handle persists until re-opened + closed).
  if (adapterNames.length) {
    try {
      const w = loadWintun();
      for (const n of adapterNames) {
        try {
          const a = w.openAdapter(n);
          if (a) w.closeAdapter(a);
        } catch { /* best-effort */ }
      }
    } catch { /* koffi/dll unavailable — leave the adapters, firewall already cleared */ }
    // Drop any stale IP still bound to the (now-removed) alias.
    for (const n of adapterNames) {
      psRun(`Remove-NetIPAddress -InterfaceAlias '${psq(n)}' -Confirm:$false -ErrorAction SilentlyContinue`);
    }
  }
  return found;
}

// ── Parent PID watchdog (plan §5) ────────────────────────────────────────────

/**
 * Watch the interactive main process via koffi OpenProcess(SYNCHRONIZE) +
 * WaitForSingleObject(h, 0), polling every ~500ms — WAIT_OBJECT_0 ⇒ main died ⇒
 * onDead(). NOT process.kill(pid,0) polling (plan §5). If OpenProcess fails (main
 * already gone), onDead fires on the next tick. Returns a stop() that CloseHandles
 * and clears the interval.
 */
export function startParentWatchdog(parentPid: number, onDead: () => void): () => void {
  const SYNCHRONIZE = 0x00100000;
  const WAIT_OBJECT_0 = 0x00000000;

  let koffi: any;
  let k32: any;
  try {
    koffi = require('koffi');
    k32 = koffi.load('kernel32.dll');
  } catch {
    // No koffi → fall back to the weaker process.kill(pid,0) liveness probe so a
    // dead parent still tears the helper down (best-effort; never leak the tunnel).
    const timer = setInterval(() => {
      try { process.kill(parentPid, 0); } catch { fire(); }
    }, 500);
    let firedFallback = false;
    const fire = () => { if (firedFallback) return; firedFallback = true; clearInterval(timer); onDead(); };
    return () => clearInterval(timer);
  }

  const OpenProcess = k32.func('void* __stdcall OpenProcess(uint32, bool, uint32)');
  const WaitForSingleObject = k32.func('uint32 __stdcall WaitForSingleObject(void*, uint32)');
  const CloseHandle = k32.func('bool __stdcall CloseHandle(void*)');

  const handle = OpenProcess(SYNCHRONIZE, false, parentPid >>> 0);
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    clearInterval(timer);
    try { if (handle) CloseHandle(handle); } catch { /* ignore */ }
    onDead();
  };

  if (!handle) {
    // Main is already gone (or unopenable) — tear down on the next tick.
    setImmediate(fire);
    return () => { fired = true; };
  }

  const timer = setInterval(() => {
    try {
      if (WaitForSingleObject(handle, 0) === WAIT_OBJECT_0) fire();
    } catch {
      fire();
    }
  }, 500);

  return () => {
    if (fired) return;
    fired = true;
    clearInterval(timer);
    try { CloseHandle(handle); } catch { /* ignore */ }
  };
}

// ── argv + handshake ─────────────────────────────────────────────────────────

interface HelperArgs {
  handshakePath: string;
  parentPid: number;
  interactiveSid: string;
  sessionId: string;
  appPath?: string;
}

function argValue(name: string): string | undefined {
  const pre = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pre));
  return hit ? hit.slice(pre.length) : undefined;
}

function parseHelperArgs(): HelperArgs {
  const handshakePath = argValue('handshake');
  const parentPid = Number(argValue('parent-pid'));
  const interactiveSid = argValue('sid');
  const sessionId = argValue('session');
  if (!handshakePath || !path.isAbsolute(handshakePath)) {
    throw new LanHelperError('bad-token', `--handshake must be an absolute path (got: ${handshakePath ?? 'none'})`);
  }
  if (!Number.isFinite(parentPid) || parentPid <= 0) {
    throw new LanHelperError('bad-token', `--parent-pid missing or invalid (got: ${argValue('parent-pid') ?? 'none'})`);
  }
  if (!interactiveSid) {
    throw new LanHelperError('bad-token', '--sid (interactive user SID) is required');
  }
  if (!sessionId) {
    throw new LanHelperError('bad-token', '--session (sessionId) is required');
  }
  return { handshakePath, parentPid, interactiveSid, sessionId, appPath: argValue('app-path') };
}

function readHandshake(p: string): LanHandshakeFile {
  const raw = fs.readFileSync(p, 'utf8');
  const hs = JSON.parse(raw) as LanHandshakeFile;
  if (hs.proto !== LAN_PIPE_PROTO) {
    throw new LanHelperError('bad-token', `handshake proto mismatch: file ${hs.proto} !== helper ${LAN_PIPE_PROTO}`);
  }
  if (!hs.token || !hs.pipeName || !hs.setup) {
    throw new LanHelperError('bad-token', 'handshake file is missing token/pipeName/setup');
  }
  return hs;
}

/** Resolve wintun.dll, honouring the dev --app-path (where resources live under
 *  <appPath>/vendor/wintun/win32-x64) since a RunAs relaunch may not share cwd. */
function resolveDll(appPath?: string): string | undefined {
  if (appPath) {
    const dev = path.join(appPath, 'vendor', 'wintun', 'win32-x64', 'wintun.dll');
    if (fs.existsSync(dev)) return dev;
  }
  try {
    return resolveWintunDll();
  } catch {
    return undefined; // let loadWintun surface the tagged failure over the pipe
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Elevated-helper main. Wired at main.ts (`app.whenReady().then(runLanHelper)`)
 * when `--lan-helper` is present. Never throws to the top-level uncaught handler:
 * every failure is turned into a tagged control error (if the pipe is up) + a
 * best-effort revert + a non-zero exit.
 */
export async function runLanHelper(): Promise<void> {
  hlog(`helper start pid=${process.pid} argv=${JSON.stringify(process.argv.slice(1))}`);
  // 1. Fail-fast elevation assert — a clean error beats a half-init tunnel.
  try {
    assertElevated();
  } catch (e) {
    hlog(`FATAL not elevated: ${e instanceof Error ? e.message : e}`);
    process.exit(3);
    return;
  }

  let args: HelperArgs;
  let hs: LanHandshakeFile;
  try {
    args = parseHelperArgs();
    hs = readHandshake(args.handshakePath);
  } catch (e) {
    hlog(`FATAL handshake error: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
    return;
  }
  hlog(`handshake ok: pipe=${hs.pipeName} adapter=${hs.setup?.adapterName} parentPid=${args.parentPid}`);

  const req = hs.setup;
  let pipe: LanPipeServer | null = null;
  let stopWatchdog: (() => void) | null = null;
  let tornDown = false;
  let running = true;

  const teardown = async (reason: string, code: number): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    running = false;
    hlog(`teardown (${reason})`);
    try { stopWatchdog?.(); } catch { /* ignore */ }
    try { await revertNetConfig(req); } catch { /* ignore */ }
    try { pipe?.close(); } catch { /* ignore */ }
    process.exit(code);
  };

  // Never leave the tunnel/adapter behind on an unexpected crash.
  process.on('uncaughtException', (err) => {
    hlog(`FATAL uncaught: ${err?.message}\n${err?.stack ?? ''}`);
    void teardown('uncaught', 1);
  });
  process.on('SIGTERM', () => void teardown('sigterm', 143));
  process.on('SIGINT', () => void teardown('sigint', 130));

  // 2. Arm the PID watchdog BEFORE any adapter work: if main dies during setup we
  //    still self-revert (main cannot kill us medium→high IL).
  stopWatchdog = startParentWatchdog(args.parentPid, () => void teardown('parent-died', 0));

  // 3. TRULY pipe-first: bring the named pipe up as the very first slow step. The
  //    engine's connect deadline starts ticking the moment we are spawned, and it
  //    can only connect once CreateNamedPipeW has run — so NOTHING slow may precede
  //    it. (The orphan-sweep used to run here and its Get-NetFirewallRule
  //    enumeration alone could outlast the whole connect budget → the engine saw
  //    "timed out connecting to the helper". The sweep now runs after the hello,
  //    still before any adapter work, preserving its clean-before-create contract.)
  try {
    pipe = new LanPipeServer({
      pipeName: hs.pipeName,
      interactiveSid: args.interactiveSid || hs.interactiveSid,
      token: hs.token,
      onData: (packet: Buffer) => {
        // CH_DATA from the engine → inject straight into the Wintun send ring.
        // Drop silently if the ring is full (unreliable game-tunnel semantics).
        if (running && held.wintun && held.session) held.wintun.sendPacket(held.session, packet);
      },
      onControl: (m: LanControlMsg) => handleControl(m),
      onClose: () => void teardown('engine-disconnected', 0),
    });
    hlog('pipe: creating + awaiting engine hello');
    await pipe.listen();
    hlog('pipe: engine connected + hello accepted');
  } catch (e) {
    hlog(`FATAL pipe listen failed: ${e instanceof Error ? e.message : e}`);
    await teardown('pipe-failed', 1);
    return;
  }

  // 4. Idempotent orphan-sweep — now that the engine is attached, clean any stale
  //    adapter/firewall left by a crashed prior pair BEFORE we create our own.
  try {
    const swept = await orphanSweep({ prefix: LAN_NAME_PREFIX, elevated: true });
    if (swept.length) hlog(`orphan-sweep removed: ${swept.join(', ')}`);
  } catch (e) { hlog(`orphan-sweep failed (non-fatal): ${e instanceof Error ? e.message : e}`); }

  const sendError = (code: LanHelperErrorCode, message: string): void => {
    try { pipe?.sendControl({ t: 'error', code, message }); } catch { /* ignore */ }
  };

  function handleControl(m: LanControlMsg): void {
    switch (m.t) {
      case 'shutdown':
        void teardown('shutdown', 0);
        break;
      case 'ping':
        try { pipe?.sendControl({ t: 'pong' }); } catch { /* ignore */ }
        break;
      case 'reip':
        try { applyReip(m.vip); } catch (e) { sendError('ip-config', e instanceof Error ? e.message : String(e)); }
        break;
      default:
        // 'hello' is consumed by LanPipeServer.listen(); other engine→helper
        // verbs are unknown — ignore (belt; the reader already bounds them).
        break;
    }
  }

  // 5. The single elevated net-config block. loadWintun here so a missing koffi/
  //    dll surfaces as a tagged 'driver' error over the (now-open) pipe.
  let session: unknown;
  try {
    hlog(`net-config: loading wintun (dll=${resolveDll(args.appPath) ?? 'auto'})`);
    const w = loadWintun(resolveDll(args.appPath));
    session = await applyNetConfig(w, req);
    hlog(`net-config ok: adapter='${req.adapterName}' vip=${vipToString(req.vip >>> 0)}/${req.prefix}`);
  } catch (e) {
    const code: LanHelperErrorCode = e instanceof LanHelperError ? e.code : 'driver';
    const message = e instanceof Error ? e.message : String(e);
    hlog(`FATAL net-config failed (${code}): ${message}`);
    sendError(code, message);
    await teardown('net-config-failed', 1);
    return;
  }

  // 6. Ready — hand the engine the adapter facts it needs.
  const sub = req.subnetBase >>> 0;
  try {
    pipe.sendControl({ t: 'ready', adapter: req.adapterName, vip: req.vip >>> 0, subnetBase: sub, prefix: req.prefix >>> 0 });
  } catch { /* ignore */ }
  hlog('READY — pump starting');

  // 7. Ring→pipe pump. The pipe→ring direction is event-driven via onData above,
  //    so we only actively drain the Wintun receive ring here (non-blocking drain
  //    then a short blocking wait when idle — the spike-harness pump pattern).
  const readEvent = held.wintun!.readWaitEvent(session);
  const pump = (): void => {
    if (!running) return;
    let drained = 0;
    for (;;) {
      const pkt = held.wintun!.receivePacket(session);
      if (!pkt) break;
      pipe!.send(pkt); // CH_DATA to engine; false = write ring full → drop
      if (++drained >= 512) break;
    }
    // Short idle wait only: a longer block would stall the pipe-poll timer and add
    // that much jitter to engine→ring (TX) whenever RX is idle but TX is busy
    // (e.g. a mostly-uploading peer). 1ms keeps TX latency tight (plan §11 budget).
    if (drained === 0) held.wintun!.waitReadable(readEvent, 1);
    setImmediate(pump);
  };
  setImmediate(pump);
}
