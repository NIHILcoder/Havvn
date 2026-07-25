/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Virtual-LAN Phase-1 transport: the named-pipe byte-bridge between the elevated
 * helper (server) and the engine window (client). Plan §1.1 / §5, must-fix #3/#4.
 *
 * WIRE — the frozen `shared/lan-frame` length-prefix ([uint16 len][payload]) is
 * left UNTOUCHED; a 1-byte in-payload CHANNEL discriminator (CH_DATA / CH_CONTROL)
 * rides as `payload[0]` so control and data share the ONE pipe (no second TCP
 * port → no bind→close→rebind TOCTOU gap across the UAC prompt). The data path
 * costs exactly +1 byte and never touches JSON.
 *
 * TWO ROLES:
 *  - LanPipeServer (HELPER, elevated) — creates the pipe via koffi CreateNamedPipeW
 *    with an explicit SDDL DACL scoped to the INTERACTIVE user's SID (must-fix #3;
 *    libuv's default High-IL label + admin-token DACL would ACCESS_DENY a medium-IL,
 *    possibly different-SID, engine — Node net.createServer can neither DACL nor
 *    relabel a pipe). FILE_FLAG_FIRST_PIPE_INSTANCE + PIPE_REJECT_REMOTE_CLIENTS
 *    close the name-squat window.
 *  - LanPipeClient (ENGINE window, sandbox:false → full Node) — a plain net.connect;
 *    no privilege is needed to connect a pipe DACL'd to us. Sends hello(token) as
 *    its FIRST frame.
 *
 * HANDSHAKE — the engine's first frame MUST be a CH_CONTROL hello carrying the
 * shared token + proto; a non-hello or mismatched-token first frame tears the pipe
 * down (belt-and-suspenders over the DACL, never the sole gate). The token itself
 * lives only in the 0o600 handshake FILE (written by main, path passed via argv) —
 * this module only compares it.
 *
 * BACKPRESSURE — DROP, never queue (a game tunnel wants drop; queueing degrades an
 * unreliable channel into reliable-with-lag). send() returns false when the pipe
 * cannot take the frame immediately.
 *
 * koffi (and every Win32 binding) is LAZY-required inside LanPipeServer so node
 * vitest can import this module and unit-test the pure codec / SDDL / handshake
 * without a driver, elevation, or the koffi prebuild (mirrors wintun.ts /
 * room-voice.ts). The engine-side client uses only node:net.
 */
import net from 'node:net';
import { encodeFrame, FrameReader, MAX_FRAME } from '../../shared/lan-frame';

// ── Protocol constants ───────────────────────────────────────────────────────

/** Bump on ANY change to the frame/channel/control shape. The engine and helper
 *  ride the same build, but hello still carries it so a mismatched relaunch fails
 *  fast rather than misparsing. */
export const LAN_PIPE_PROTO = 1;

/** In-payload channel discriminator — the FIRST byte of every lan-frame payload. */
export const CH_DATA = 0x00; // body = one raw IPv4 packet (hot path; +1 byte only)
export const CH_CONTROL = 0x01; // body = UTF-8 JSON LanControlMsg (rare)

/** Cap on a decoded CH_CONTROL body — control JSON is always tiny; anything larger
 *  is a corrupt/hostile peer and is FATAL (never a data frame misrouted here). */
export const MAX_CONTROL_BYTES = 64 * 1024;

/** DROP-backpressure high-water mark for the client socket's queued bytes. */
export const PIPE_HIGH_WATER = 256 * 1024;

// ── Control-plane messages (multiplexed over CH_CONTROL on the same pipe) ──────

export type LanHelperErrorCode =
  | 'not-elevated' // High-IL assertion failed
  | 'driver' // WintunCreateAdapter/StartSession failed
  | 'ip-config' // New-NetIPAddress / MTU / route step failed
  | 'firewall' // New-NetFirewallRule step failed
  | 'bad-token' // hello token mismatch (also destroys the pipe)
  | 'bad-adapter-name' // validateAdapterName rejected a VPN-ish name
  | 'bad-app-path'; // validateGameExePath rejected a renderer-supplied .exe path

/**
 * Phase-2A REQUEST/RESPONSE verbs ('allow-app', 'diag') carry a `id` correlation
 * number so the engine can resolve exactly one pending promise per request — the
 * Phase-1 verbs were all fire-and-forget and the pipe has no other correlation.
 * Ids are uint32 and validated with isControlId() on BOTH sides; an out-of-range
 * id is IGNORED (never answered), so a malformed verb cannot allocate state.
 *
 * NOTE: this union is additive over proto 1 — an older peer simply ignores the
 * new discriminators (helper `default:` / engine `else`), so LAN_PIPE_PROTO (and
 * lan-manager's HANDSHAKE_PROTO, which must move in lockstep) stay at 1.
 */
export type LanControlMsg =
  | { t: 'hello'; token: string; proto: number } // engine→helper, MUST be the first frame
  | { t: 'ready'; adapter: string; vip: number; subnetBase: number; prefix: number } // helper→engine after net setup
  | { t: 'error'; code: LanHelperErrorCode; message: string } // helper→engine fatal error
  | { t: 'reip'; vip: number; gen: number } // engine→helper on vIP collision loss
  | { t: 'shutdown' } // engine→helper cooperative teardown
  | { t: 'ping' }
  | { t: 'pong' } // over-pipe heartbeat (independent of the PID watchdog)
  // ── Phase 2A (§11) — request/response, correlated by `id` ──────────────────
  /** engine→helper: scope an inbound+outbound allow-rule to ONE game executable.
   *  `exe` is advisory input only — the elevated side re-validates it with
   *  validateGameExePath() + a real stat() before it ever reaches PowerShell. */
  | { t: 'allow-app'; id: number; exe: string }
  | { t: 'allow-app-result'; id: number; ok: boolean; rule?: string; code?: LanHelperErrorCode; message?: string }
  /** engine→helper: collect elevated-side facts (adapter/IP/MTU/rules/driver).
   *  ZERO input — nothing renderer-supplied reaches a Get-* cmdlet. */
  | { t: 'diag'; id: number }
  | { t: 'diag-result'; id: number; facts: LanHelperFacts };

// ── Phase-2A verb bounds (pure; enforced on BOTH sides) ──────────────────────

/** Correlation-id domain for the request/response verbs. */
export function isControlId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}

/** MAX_PATH. A longer string is not a real picker result — reject, never truncate. */
export const MAX_APP_PATH = 260;

/** Firewall-rule DisplayName token cap (the sanitized exe basename). */
export const MAX_RULE_TOKEN = 64;

/** Clamp for every list inside a diag-result. ChannelReader.dispatch is FATAL on a
 *  control body over MAX_CONTROL_BYTES, so an unbounded Get-NetFirewallRule dump
 *  would tear down the very tunnel being diagnosed. */
export const MAX_DIAG_LIST = 32;
export const MAX_DIAG_STRING = 160;

/** Why a candidate .exe path was refused. */
export type AppPathReject =
  | 'not-a-string'
  | 'empty'
  | 'too-long'
  | 'bad-chars'
  | 'not-absolute'
  | 'traversal'
  | 'not-exe';

/** Characters refused outright in a game path: NUL/control/newline, quotes and
 *  backtick (PowerShell string terminators), the glob pair, and the characters
 *  Windows already forbids in a filename. Forward slash is refused too — a native
 *  picker always yields backslashes, so a `/` means the path was hand-fabricated. */
// eslint-disable-next-line no-control-regex -- refusing control characters IS the point
const APP_PATH_BAD = /[\x00-\x1f\x7f"'`*?<>|/]/;
/** A second ':' after the drive letter means an NTFS alternate-data-stream target
 *  ('game.exe:payload.exe' — which stat() happily resolves), or a fabricated
 *  'C:\a\C:\b'. Checked on the post-drive remainder only. */
const APP_PATH_COLON = /:/;
const APP_PATH_DRIVE = /^[A-Za-z]:\\/;

/**
 * HARD gate for a path that will reach an ELEVATED PowerShell as `-Program`.
 * Pure (no fs) so it is unit-testable and can also run engine-side as cheap
 * defence in depth; the helper re-runs it and additionally stat()s the file.
 *
 * Requires: a drive-absolute Windows path (so UNC `\\server\share` and the
 * `\\?\` / `\\.\` device namespaces are refused — an elevated process must never
 * be pointed at an attacker-named SMB host), no traversal or empty segments, a
 * `.exe` leaf, MAX_APP_PATH length, and none of APP_PATH_BAD. Escaping with
 * psq() + single quotes at the call site is REQUIRED on top of this, never
 * instead of it.
 */
export function validateGameExePath(p: unknown): { ok: true; path: string } | { ok: false; reason: AppPathReject } {
  if (typeof p !== 'string') return { ok: false, reason: 'not-a-string' };
  if (p.length === 0) return { ok: false, reason: 'empty' };
  if (p.length > MAX_APP_PATH) return { ok: false, reason: 'too-long' };
  if (APP_PATH_BAD.test(p)) return { ok: false, reason: 'bad-chars' };
  if (!APP_PATH_DRIVE.test(p)) return { ok: false, reason: 'not-absolute' };
  // Only the drive colon is legal; any further ':' is an ADS or a fabricated path.
  if (APP_PATH_COLON.test(p.slice(2))) return { ok: false, reason: 'bad-chars' };
  const segments = p.slice(3).split('\\');
  if (segments.length < 1) return { ok: false, reason: 'traversal' };
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') return { ok: false, reason: 'traversal' };
    // A trailing dot/space is stripped by Win32 path canonicalisation — refuse it
    // rather than let the stat()'d path differ from the -Program string.
    if (s !== s.trim() || s.endsWith('.')) return { ok: false, reason: 'bad-chars' };
  }
  const leaf = segments[segments.length - 1];
  if (leaf.length <= 4 || !/\.exe$/i.test(leaf)) return { ok: false, reason: 'not-exe' };
  return { ok: true, path: p };
}

/**
 * Reduce an arbitrary string to the charset that is safe inside a firewall rule
 * DisplayName. The DisplayName is later matched with a PowerShell WILDCARD by
 * revertNetConfig (`'<adapterName>*'`) and orphanSweep (`'Havvn LAN-*'`), so a
 * `[`, `]`, `*` or `?` in a filename would make teardown globbing unpredictable
 * and could strand a permanent allow-rule on the user's machine.
 */
export function sanitizeRuleToken(s: string): string {
  const t = s
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RULE_TOKEN)
    .trim();
  return t || 'app';
}

/**
 * DisplayName base for a per-app rule. It MUST begin with the full adapter name
 * (`Havvn LAN-<sessionId>`) so BOTH revertNetConfig's `'<adapterName>*'` and
 * orphanSweep's `'Havvn LAN-*'` remove it on teardown — no sweep change needed.
 */
export function appRuleDisplayName(adapterName: string, exePath: string): string {
  const leaf = exePath.split(/[\\/]/).pop() || exePath;
  return `${adapterName} App ${sanitizeRuleToken(leaf)}`;
}

/**
 * Elevated-side facts only the helper can see (diag-result payload).
 *
 * DEDUPED: shared/lan-types.ts is the SINGLE source of truth. This module used to
 * carry a verbatim copy, which silently drifted the moment a field was added
 * (exactly what the old "duplicated verbatim, keep in lockstep" comment warned
 * about). shared/ may not import from electron/, but electron/ may import from
 * shared/, so the type lives there and is re-exported here for existing importers.
 */
export type { LanHelperFacts } from '../../shared/lan-types';
import type { LanHelperFacts } from '../../shared/lan-types';

/** Clamp every unbounded field of a diag-result before it is framed. */
export function clampHelperFacts(f: LanHelperFacts): LanHelperFacts {
  const list = (a: readonly string[] | undefined): string[] =>
    (a ?? []).slice(0, MAX_DIAG_LIST).map((s) => String(s).slice(0, MAX_DIAG_STRING));
  const str = (s: unknown): string => String(s ?? '').slice(0, MAX_DIAG_STRING);
  const num = (n: unknown): number => (Number.isFinite(n as number) ? Math.max(0, Math.floor(n as number)) : 0);
  return {
    adapterName: str(f.adapterName),
    adapterPresent: !!f.adapterPresent,
    adapterUp: !!f.adapterUp,
    adapterStatus: str(f.adapterStatus),
    ipAddresses: list(f.ipAddresses),
    expectedVip: str(f.expectedVip),
    subnet: str(f.subnet),
    mtu: num(f.mtu),
    firewallRules: list(f.firewallRules),
    appRules: list(f.appRules),
    driverVersion: str(f.driverVersion),
    ringActive: !!f.ringActive,
    helperPid: num(f.helperPid),
    uptimeMs: num(f.uptimeMs),
  };
}

// ── Handshake artifacts (main → helper) ──────────────────────────────────────
// main computes every field; the helper trusts none past its own validators
// (validateAdapterName; vip re-derivable via shared/lan-ip). The secret token
// lives ONLY in the 0o600 handshake FILE at an absolute argv-passed path — never
// in argv (command lines are world-readable). Must-fix #3.

/** The elevated network mutations the helper performs in its single UAC block. */
export interface LanSetupRequest {
  sessionId: string;
  /** `Havvn LAN-${sessionId}` — validateAdapterName() gate (§5, §7 deny-list). */
  adapterName: string;
  /** uint32; deriveVip(sessionId, selfId, gen) — the /16 host address to assign. */
  vip: number;
  /** uint32; sessionSubnet(sessionId).base (logging / scoping only). */
  subnetBase: number;
  /** 16 (SESSION_PREFIX). */
  prefix: number;
  /** 1280 fixed (plan §0 dec.5 — >1192 fragments SCTP). */
  mtu: number;
  /** Per-destination on-link forward routes, e.g. broadcast + mDNS + SSDP /32s. */
  forwardRoutes: string[];
  /** RemoteAddress scope for the allow-rules, e.g. '100.64.0.0/10'. */
  firewallRemote: string;
}

/** Written 0o600 by main at an ABSOLUTE path under the INTERACTIVE user's userData;
 *  path passed to the helper via argv. The token lives here and NOWHERE in argv. */
export interface LanHandshakeFile {
  proto: number; // === LAN_PIPE_PROTO
  token: string; // the engine echoes this in hello
  pipeName: string; // lanPipePath(sessionId) — per-session (must-fix #5)
  parentPid: number; // main's PID — helper watchdog target (also in argv)
  interactiveSid: string; // S-1-5-21-… of the interactive user (also in argv; DACL subject)
  setup: LanSetupRequest;
}

// ── Pure channel codec (fully unit-tested) ───────────────────────────────────

/** Wrap a raw IPv4 packet as [uint16 len][CH_DATA][packet]. */
export function encodeData(packet: Buffer): Buffer {
  const payload = Buffer.allocUnsafe(1 + packet.length);
  payload[0] = CH_DATA;
  packet.copy(payload, 1);
  return encodeFrame(payload);
}

/** Wrap a control message as [uint16 len][CH_CONTROL][utf8(JSON)]. */
export function encodeControl(msg: LanControlMsg): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const payload = Buffer.allocUnsafe(1 + json.length);
  payload[0] = CH_CONTROL;
  json.copy(payload, 1);
  return encodeFrame(payload);
}

export interface ChannelHandlers {
  onData: (packet: Buffer) => void;
  onControl: (m: LanControlMsg) => void;
  /** Max decoded CH_CONTROL body (default MAX_CONTROL_BYTES). */
  maxControlBytes?: number;
}

/**
 * Demuxing reassembler over the frozen FrameReader. Splits each complete frame on
 * its channel byte. THROWS (fatal — tear the bridge down, never resync past it) on
 * an empty frame, an unknown channel byte, or a CONTROL body over the cap / not
 * valid JSON. FrameReader itself already throws on an oversized length prefix.
 */
export class ChannelReader {
  private readonly frames: FrameReader;
  private readonly maxControl: number;

  constructor(private readonly handlers: ChannelHandlers) {
    this.frames = new FrameReader(MAX_FRAME);
    this.maxControl = handlers.maxControlBytes ?? MAX_CONTROL_BYTES;
  }

  push(chunk: Buffer): void {
    this.frames.push(chunk, (payload) => this.dispatch(payload));
  }

  private dispatch(payload: Buffer): void {
    if (payload.length < 1) throw new Error('lan-pipe: empty frame (no channel byte)');
    const channel = payload[0];
    const body = payload.subarray(1);
    if (channel === CH_DATA) {
      // Copy so the consumer may retain the packet past this call.
      this.handlers.onData(Buffer.from(body));
      return;
    }
    if (channel === CH_CONTROL) {
      if (body.length > this.maxControl) {
        throw new Error(`lan-pipe: control body too large: ${body.length} > ${this.maxControl}`);
      }
      let msg: LanControlMsg;
      try {
        msg = JSON.parse(body.toString('utf8')) as LanControlMsg;
      } catch {
        throw new Error('lan-pipe: control body is not valid JSON');
      }
      if (!msg || typeof (msg as { t?: unknown }).t !== 'string') {
        throw new Error('lan-pipe: control message missing discriminator');
      }
      this.handlers.onControl(msg);
      return;
    }
    throw new Error(`lan-pipe: unknown channel byte 0x${channel.toString(16)}`);
  }
}

// ── SDDL for the pipe DACL (must-fix #3; pure + unit-tested) ──────────────────

/** A textual SID: S-<revision>-<authority>[-<subauth>…] (e.g. S-1-5-21-…-1001). */
const SID_RE = /^S-\d+(-\d+){1,15}$/i;

/**
 * SDDL granting exactly the INTERACTIVE user's SID + SYSTEM GENERIC_ALL, protected
 * (P — no inherited ACEs), with a Medium mandatory label carrying NoWriteUp so a
 * medium-IL engine may open a pipe created by a High-IL helper. The heart of
 * must-fix #3. Rejects a malformed SID (SDDL injection guard).
 */
export function buildPipeSddl(interactiveSid: string): string {
  if (!SID_RE.test(interactiveSid)) {
    throw new Error(`buildPipeSddl: not a valid SID string: ${JSON.stringify(interactiveSid)}`);
  }
  const sid = interactiveSid.toUpperCase();
  // D:P            protected DACL
  //  (A;;GA;;;SID) allow GENERIC_ALL to the interactive user
  //  (A;;GA;;;SY)  allow GENERIC_ALL to SYSTEM (SY)
  // S:(ML;;NW;;;ME) SACL mandatory label: Medium IL, NoWriteUp
  return `D:P(A;;GA;;;${sid})(A;;GA;;;SY)S:(ML;;NW;;;ME)`;
}

/** Per-session pipe path. Kept in one place so server/client cannot drift. */
export function lanPipePath(sessionId: string): string {
  return `\\\\.\\pipe\\havvn-lan-${sessionId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER side — LanPipeServer (koffi CreateNamedPipeW, DACL'd, overlapped I/O)
// ─────────────────────────────────────────────────────────────────────────────

export interface PipeServerOptions {
  /** Full pipe path, e.g. lanPipePath(sessionId). */
  pipeName: string;
  /** The interactive user's SID the pipe DACL is scoped to (must-fix #3). */
  interactiveSid: string;
  /** Shared handshake secret — the engine's hello.token must equal this. */
  token: string;
  /** CH_DATA from the engine → inject into the Wintun ring (helper-main wires this). */
  onData: (packet: Buffer) => void;
  /** CH_CONTROL from the engine (reip / shutdown / ping). */
  onControl: (m: LanControlMsg) => void;
  /** The engine disconnected / the bridge died — begin teardown. Fires once. */
  onClose: (err?: Error) => void;
  /** Poll interval for the overlapped read/write pump (ms). Default 1. */
  pollMs?: number;
  /** How long listen() waits for the engine to connect + say hello (ms). Default 20_000. */
  connectTimeoutMs?: number;
}

// Win32 constants.
const PIPE_ACCESS_DUPLEX = 0x00000003;
const FILE_FLAG_OVERLAPPED = 0x40000000;
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
const PIPE_TYPE_BYTE = 0x00000000;
const PIPE_READMODE_BYTE = 0x00000000;
const PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
const PIPE_MAX_INSTANCES = 1; // nMaxInstances — exactly one client
const SDDL_REVISION_1 = 1;
const PIPE_BUF = 1 << 20; // 1 MiB in/out kernel buffers
const READ_CHUNK = 64 * 1024;

const ERROR_IO_PENDING = 997;
const ERROR_PIPE_CONNECTED = 535;
const WAIT_OBJECT_0 = 0x00000000;
const WAIT_TIMEOUT = 0x00000102;
const INVALID_HANDLE = 0xffffffffffffffffn;

interface Win32 {
  koffi: any;
  OVERLAPPED: any;
  SECURITY_ATTRIBUTES: any;
  CreateNamedPipeW: (...a: unknown[]) => unknown;
  ConnectNamedPipe: (...a: unknown[]) => number;
  ReadFile: (...a: unknown[]) => number;
  WriteFile: (...a: unknown[]) => number;
  CreateEventW: (...a: unknown[]) => unknown;
  GetOverlappedResult: (...a: unknown[]) => number;
  WaitForSingleObject: (...a: unknown[]) => number;
  DisconnectNamedPipe: (h: unknown) => number;
  CloseHandle: (h: unknown) => number;
  GetLastError: () => number;
  ConvertStringSD: (...a: unknown[]) => number;
  LocalFree: (p: unknown) => unknown;
}

/** Lazy-load koffi + bind the Win32 surface the DACL'd overlapped pipe needs.
 *  Kept out of module import-time so vitest can import the pure exports. */
function loadWin32(): Win32 {
  if (process.platform !== 'win32') throw new Error('LanPipeServer is Windows-only');
  const koffi: any = require('koffi');
  const k32 = koffi.load('kernel32.dll');
  const adv = koffi.load('advapi32.dll');

  // WINAPI == __stdcall (ignored on x64, declared for correctness).
  const OVERLAPPED = koffi.struct('LAN_OVERLAPPED', {
    Internal: 'uintptr_t',
    InternalHigh: 'uintptr_t',
    Offset: 'uint32',
    OffsetHigh: 'uint32',
    hEvent: 'void*',
  });
  const SECURITY_ATTRIBUTES = koffi.struct('LAN_SECURITY_ATTRIBUTES', {
    nLength: 'uint32',
    lpSecurityDescriptor: 'void*',
    bInheritHandle: 'int',
  });

  return {
    koffi,
    OVERLAPPED,
    SECURITY_ATTRIBUTES,
    CreateNamedPipeW: k32.func(
      'void* __stdcall CreateNamedPipeW(str16, uint32, uint32, uint32, uint32, uint32, uint32, void*)',
    ),
    ConnectNamedPipe: k32.func('int __stdcall ConnectNamedPipe(void*, void*)'),
    ReadFile: k32.func('int __stdcall ReadFile(void*, _Out_ void*, uint32, _Out_ uint32*, void*)'),
    WriteFile: k32.func('int __stdcall WriteFile(void*, void*, uint32, _Out_ uint32*, void*)'),
    CreateEventW: k32.func('void* __stdcall CreateEventW(void*, int, int, str16)'),
    GetOverlappedResult: k32.func('int __stdcall GetOverlappedResult(void*, void*, _Out_ uint32*, int)'),
    WaitForSingleObject: k32.func('uint32 __stdcall WaitForSingleObject(void*, uint32)'),
    DisconnectNamedPipe: k32.func('int __stdcall DisconnectNamedPipe(void*)'),
    CloseHandle: k32.func('int __stdcall CloseHandle(void*)'),
    GetLastError: k32.func('uint32 __stdcall GetLastError()'),
    ConvertStringSD: adv.func(
      'int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32, _Out_ void**, _Out_ uint32*)',
    ),
    LocalFree: k32.func('void* __stdcall LocalFree(void*)'),
  };
}

/**
 * Elevated-side pipe server. A dumb byte pump: it owns exactly one client, frames
 * via ChannelReader, and enforces the hello handshake. It runs overlapped I/O on a
 * Node poll timer (the helper event loop stays alive; a single in-flight read and a
 * single in-flight write give natural DROP backpressure).
 */
export class LanPipeServer {
  private w: Win32 | null = null;
  private pipe: unknown = null;
  private readEvent: unknown = null;
  private writeEvent: unknown = null;
  private readOv: unknown = null; // stable OVERLAPPED memory for the read
  private writeOv: unknown = null; // stable OVERLAPPED memory for the write
  private readBuf: unknown = null; // stable buffer ReadFile fills
  private readPending = false;
  private writePending = false;
  private helloOk = false;
  private closed = false;
  private poll: NodeJS.Timeout | null = null;
  private reader: ChannelReader;
  private sdToFree: unknown = null;

  constructor(private readonly opts: PipeServerOptions) {
    this.reader = new ChannelReader({
      maxControlBytes: MAX_CONTROL_BYTES,
      onData: (packet) => {
        if (!this.helloOk) throw new Error('lan-pipe: data before hello');
        this.opts.onData(packet);
      },
      onControl: (m) => this.handleControl(m),
    });
  }

  /** Create the DACL'd pipe, await one connection, verify the first frame is
   *  hello(token). Rejects (destroy + throw) on token mismatch, a non-hello first
   *  frame, or timeout. On success the steady-state pump is already running. */
  async listen(): Promise<void> {
    const w = (this.w = loadWin32());
    const { koffi } = w;

    // 1. Build the security descriptor from the SID-scoped SDDL.
    const sddl = buildPipeSddl(this.opts.interactiveSid);
    const sdOut: unknown[] = [null];
    const okSd = w.ConvertStringSD(sddl, SDDL_REVISION_1, sdOut, [0]);
    if (!okSd || !sdOut[0]) {
      throw new Error(`lan-pipe: ConvertStringSecurityDescriptor failed — GetLastError=${w.GetLastError()}`);
    }
    this.sdToFree = sdOut[0];

    const sa = koffi.alloc(w.SECURITY_ATTRIBUTES, 1);
    koffi.encode(sa, w.SECURITY_ATTRIBUTES, {
      nLength: koffi.sizeof(w.SECURITY_ATTRIBUTES),
      lpSecurityDescriptor: sdOut[0],
      bInheritHandle: 0,
    });

    // 2. Create the pipe: exactly one instance, first-instance + reject-remote to
    //    close the name-squat window, overlapped, byte stream (we length-prefix).
    const openMode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE;
    const pipeMode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_REJECT_REMOTE_CLIENTS;
    const pipe = w.CreateNamedPipeW(
      this.opts.pipeName,
      openMode,
      pipeMode,
      PIPE_MAX_INSTANCES,
      PIPE_BUF,
      PIPE_BUF,
      0,
      sa,
    );
    // The SD is copied into the kernel pipe object; free our SDDL allocation now.
    this.freeSd();
    if (!pipe || BigInt(koffi.address(pipe)) === INVALID_HANDLE) { // normalize: koffi.address may return number OR bigint
      const code = w.GetLastError();
      this.pipe = null;
      throw new Error(`lan-pipe: CreateNamedPipeW failed — GetLastError=${code}`);
    }
    this.pipe = pipe;

    // 3. Overlapped I/O scaffolding (manual-reset events + stable OVERLAPPED mem).
    this.readEvent = w.CreateEventW(null, 1, 0, null);
    this.writeEvent = w.CreateEventW(null, 1, 0, null);
    this.readOv = koffi.alloc(w.OVERLAPPED, 1);
    this.writeOv = koffi.alloc(w.OVERLAPPED, 1);
    this.readBuf = koffi.alloc('uint8', READ_CHUNK);

    // 4. Wait for the single client to connect.
    await this.awaitConnect();

    // 5. Verify the hello handshake before returning; steady-state pump keeps running.
    await this.awaitHello();
  }

  private async awaitConnect(): Promise<void> {
    const w = this.w!;
    const { koffi } = w;
    const connectOv = koffi.alloc(w.OVERLAPPED, 1);
    koffi.encode(connectOv, w.OVERLAPPED, { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: this.readEvent });

    const ok = w.ConnectNamedPipe(this.pipe, connectOv);
    if (ok) return; // rare: connected synchronously
    const code = w.GetLastError();
    if (code === ERROR_PIPE_CONNECTED) return; // client beat us to it — already connected
    if (code !== ERROR_IO_PENDING) {
      throw new Error(`lan-pipe: ConnectNamedPipe failed — GetLastError=${code}`);
    }
    // Pending: poll the connect event until signalled or timeout.
    const deadline = Date.now() + (this.opts.connectTimeoutMs ?? 20_000);
    for (;;) {
      if (this.closed) throw new Error('lan-pipe: closed while awaiting connection');
      const r = w.WaitForSingleObject(this.readEvent, 50);
      if (r === WAIT_OBJECT_0) return;
      if (r !== WAIT_TIMEOUT) throw new Error(`lan-pipe: connect wait failed — WaitForSingleObject=${r}`);
      if (Date.now() > deadline) throw new Error('lan-pipe: timed out waiting for the engine to connect');
      await delay(20);
    }
  }

  private awaitHello(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.onHelloSettled = null;
        err ? reject(err) : resolve();
      };
      // handleControl / close paths signal via onHelloSettled.
      this.onHelloSettled = done;
      // Start the steady-state pump; it drives the reads that carry hello.
      this.startPump();
      // Backstop timeout in case the client connects but never speaks.
      const deadline = Date.now() + (this.opts.connectTimeoutMs ?? 20_000);
      const t = setInterval(() => {
        if (settled) { clearInterval(t); return; }
        if (this.helloOk) { clearInterval(t); done(); return; }
        if (this.closed) { clearInterval(t); done(new Error('lan-pipe: closed before hello')); return; }
        if (Date.now() > deadline) { clearInterval(t); this.fail('bad-token', 'no hello before timeout'); }
      }, 25);
    });
  }

  private onHelloSettled: ((err?: Error) => void) | null = null;

  private handleControl(m: LanControlMsg): void {
    if (!this.helloOk) {
      if (m.t === 'hello' && m.token === this.opts.token && m.proto === LAN_PIPE_PROTO) {
        this.helloOk = true;
        this.onHelloSettled?.();
        return;
      }
      this.fail('bad-token', `bad first frame: ${m.t}`);
      return;
    }
    this.opts.onControl(m);
  }

  /** Start the overlapped read/write poll loop. Idempotent. */
  private startPump(): void {
    if (this.poll || this.closed) return;
    const interval = this.opts.pollMs ?? 1;
    this.issueRead();
    this.poll = setInterval(() => this.pumpTick(), interval);
    // Don't keep the helper alive solely for this timer.
    (this.poll as unknown as { unref?: () => void }).unref?.();
  }

  private pumpTick(): void {
    if (this.closed) return;
    try {
      this.pollRead();
      this.pollWrite();
    } catch (e) {
      this.fatal(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private issueRead(): void {
    if (this.closed || this.readPending) return;
    const w = this.w!;
    const { koffi } = w;
    koffi.encode(this.readOv, w.OVERLAPPED, { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: this.readEvent });
    const bytesRead = [0];
    const ok = w.ReadFile(this.pipe, this.readBuf, READ_CHUNK, bytesRead, this.readOv);
    if (ok) {
      this.deliverRead(bytesRead[0] >>> 0);
      // Loop again next tick (avoid unbounded recursion under a fast stream).
      return;
    }
    const code = w.GetLastError();
    if (code === ERROR_IO_PENDING) {
      this.readPending = true;
      return;
    }
    throw new Error(`lan-pipe: ReadFile failed — GetLastError=${code}`);
  }

  private pollRead(): void {
    if (!this.readPending) {
      this.issueRead();
      return;
    }
    const w = this.w!;
    const got = [0];
    const ok = w.GetOverlappedResult(this.pipe, this.readOv, got, 0); // don't wait
    if (!ok) {
      const code = w.GetLastError();
      if (code === ERROR_IO_PENDING || code === 996 /* IO_INCOMPLETE */) return;
      throw new Error(`lan-pipe: read GetOverlappedResult failed — GetLastError=${code}`);
    }
    this.readPending = false;
    this.deliverRead(got[0] >>> 0);
    this.issueRead();
  }

  private deliverRead(n: number): void {
    if (n === 0) return;
    const w = this.w!;
    const bytes: number[] = w.koffi.decode(this.readBuf, w.koffi.array('uint8', n));
    this.reader.push(Buffer.from(bytes));
  }

  private pollWrite(): void {
    if (!this.writePending) return;
    const w = this.w!;
    const got = [0];
    const ok = w.GetOverlappedResult(this.pipe, this.writeOv, got, 0);
    if (!ok) {
      const code = w.GetLastError();
      if (code === ERROR_IO_PENDING || code === 996) return;
      throw new Error(`lan-pipe: write GetOverlappedResult failed — GetLastError=${code}`);
    }
    this.writePending = false;
  }

  /** Frame a raw packet as CH_DATA and write it. Returns false (DROPPED) when a
   *  previous write is still in flight — never queues (unreliable-tunnel semantics). */
  send(packet: Buffer): boolean {
    return this.writeFrame(encodeData(packet));
  }

  sendControl(m: LanControlMsg): void {
    // Control is rare and must not be silently dropped by the single-write gate;
    // if a write is in flight, wait briefly for it to drain, then send.
    const frame = encodeControl(m);
    if (!this.writeFrame(frame) && !this.closed) {
      const w = this.w!;
      // Bounded synchronous drain so shutdown/ready/error are not lost.
      w.WaitForSingleObject(this.writeEvent, 100);
      this.pollWrite();
      this.writeFrame(frame);
    }
  }

  private writeFrame(frame: Buffer): boolean {
    if (this.closed || !this.w || this.writePending) return false;
    const w = this.w!;
    const { koffi } = w;
    koffi.encode(this.writeOv, w.OVERLAPPED, { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: this.writeEvent });
    const buf = koffi.alloc('uint8', frame.length);
    koffi.encode(buf, koffi.array('uint8', frame.length), Array.from(frame));
    const written = [0];
    const ok = w.WriteFile(this.pipe, buf, frame.length >>> 0, written, this.writeOv);
    if (ok) return true; // completed synchronously
    const code = w.GetLastError();
    if (code === ERROR_IO_PENDING) {
      this.writePending = true;
      return true; // accepted; completion tracked on the poll tick
    }
    // A hard write error means the bridge is dead.
    this.fatal(new Error(`lan-pipe: WriteFile failed — GetLastError=${code}`));
    return false;
  }

  private fail(code: LanHelperErrorCode, message: string): void {
    // Best-effort notify the engine, then tear down.
    try { if (this.helloOk) this.sendControl({ t: 'error', code, message }); } catch { /* ignore */ }
    this.fatal(new Error(`lan-pipe: ${code} — ${message}`));
  }

  private fatal(err: Error): void {
    if (this.closed) return;
    this.onHelloSettled?.(err);
    this.close(err);
  }

  private freeSd(): void {
    if (this.sdToFree && this.w) {
      try { this.w.LocalFree(this.sdToFree); } catch { /* ignore */ }
    }
    this.sdToFree = null;
  }

  /** DisconnectNamedPipe + CloseHandle(s). Idempotent. */
  close(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    const w = this.w;
    if (w) {
      try { if (this.pipe) w.DisconnectNamedPipe(this.pipe); } catch { /* ignore */ }
      try { if (this.pipe) w.CloseHandle(this.pipe); } catch { /* ignore */ }
      try { if (this.readEvent) w.CloseHandle(this.readEvent); } catch { /* ignore */ }
      try { if (this.writeEvent) w.CloseHandle(this.writeEvent); } catch { /* ignore */ }
    }
    this.freeSd();
    this.pipe = null;
    this.readEvent = this.writeEvent = null;
    try { this.opts.onClose(err); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENGINE side — LanPipeClient (plain node:net; connects a pipe DACL'd to us)
// ─────────────────────────────────────────────────────────────────────────────

export interface PipeClientOptions {
  pipeName: string;
  token: string;
  /** CH_DATA from the helper (came off the Wintun ring) → route to the LanPeer mesh. */
  onData: (packet: Buffer) => void;
  /** CH_CONTROL from the helper (ready / error / pong). */
  onControl: (m: LanControlMsg) => void;
  onClose: (err?: Error) => void;
  /** DROP-backpressure high-water mark (bytes). Default PIPE_HIGH_WATER. */
  highWater?: number;
}

/**
 * Engine-window pipe client. The engine window is sandbox:false → full Node, so a
 * plain net.connect suffices (no privilege needed to connect a pipe DACL'd to us).
 * Sends hello(token) as its FIRST frame. DROP backpressure — never queue.
 */
export class LanPipeClient {
  private sock: net.Socket | null = null;
  private reader: ChannelReader;
  private closed = false;
  private readonly highWater: number;

  constructor(private readonly opts: PipeClientOptions) {
    this.highWater = opts.highWater ?? PIPE_HIGH_WATER;
    this.reader = new ChannelReader({
      maxControlBytes: MAX_CONTROL_BYTES,
      onData: (packet) => this.opts.onData(packet),
      onControl: (m) => this.opts.onControl(m),
    });
  }

  /** Retry net.connect (250 ms cadence) up to timeoutMs — the connect retry IS the
   *  readiness poll (the helper's pipe may not exist yet during the UAC prompt). On
   *  connect, immediately send hello(token) as the first frame. */
  connect(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise<void>((resolve, reject) => {
      const attempt = () => {
        if (this.closed) { reject(new Error('lan-pipe: client closed')); return; }
        const sock = net.connect(this.opts.pipeName);
        let opened = false;
        sock.once('connect', () => {
          opened = true;
          this.sock = sock;
          sock.setNoDelay(true);
          sock.on('data', (chunk: Buffer) => {
            try { this.reader.push(chunk); }
            catch (e) { this.fatal(e instanceof Error ? e : new Error(String(e))); }
          });
          sock.on('error', (e: Error) => this.fatal(e));
          sock.on('close', () => this.fatal());
          // First frame MUST be hello.
          try { sock.write(encodeControl({ t: 'hello', token: this.opts.token, proto: LAN_PIPE_PROTO })); }
          catch (e) { this.fatal(e instanceof Error ? e : new Error(String(e))); return; }
          resolve();
        });
        sock.once('error', () => {
          if (opened) return; // handled by the steady-state error handler
          sock.destroy();
          if (Date.now() >= deadline) { reject(new Error('lan-pipe: timed out connecting to the helper')); return; }
          setTimeout(attempt, 250);
        });
      };
      attempt();
    });
  }

  /** Frame a raw packet as CH_DATA. Returns false (DROPPED) when the socket is gone
   *  or its send queue is over the high-water mark — never queues. */
  send(packet: Buffer): boolean {
    const sock = this.sock;
    if (this.closed || !sock || sock.destroyed) return false;
    if (sock.writableLength > this.highWater) return false; // DROP, don't queue
    return sock.write(encodeData(packet));
  }

  sendControl(m: LanControlMsg): void {
    const sock = this.sock;
    if (this.closed || !sock || sock.destroyed) return;
    try { sock.write(encodeControl(m)); } catch { /* ignore */ }
  }

  private fatal(err?: Error): void {
    if (this.closed) return;
    this.close(err);
  }

  close(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    try { this.sock?.destroy(); } catch { /* ignore */ }
    this.sock = null;
    try { this.opts.onClose(err); } catch { /* ignore */ }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
