/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Minimal koffi binding to the prebuilt signed wintun.dll (WireGuard LLC).
 *
 * This is BOTH the Phase-0 spike surface and the module the Phase-1 elevated
 * helper reuses, so the FFI prototypes below are the single highest-risk thing
 * the spike verifies against the real driver — treat any change here as a
 * re-spike (plan §11).
 *
 * HARD CONSTRAINTS:
 *  - Must run in a process holding an Administrator token (adapter create/open
 *    installs the driver on demand and the device is ACL'd to SYSTEM/Admins).
 *    So this NEVER loads in the hidden engine window / renderer — only main or
 *    a spawned elevated helper (plan §1, §5).
 *  - wintun.dll must be shipped BYTE-FOR-BYTE unmodified (Prebuilt Binaries
 *    License) and loaded from a real path (asarUnpack / extraResources), never
 *    from inside app.asar (LoadLibraryEx needs a file).
 *
 * koffi is typed loosely (`any`) on purpose: FFI is inherently untyped and we
 * don't want this file to depend on koffi's exact .d.ts surface, nor to break
 * typecheck of unrelated files before `npm install` pulls koffi in. It is
 * loaded lazily so a missing prebuild degrades to a thrown "LAN unavailable"
 * rather than an import-time crash (mirrors electron/utils/global-ptt.ts).
 */
import fs from 'node:fs';

/** Session ring capacity: power of two in [128 KiB, 64 MiB]. 4 MiB is ample for
 *  game traffic (small packets) with headroom against bursty broadcast fan-out. */
export const RING_CAPACITY = 0x400000;

/** WaitForSingleObject sentinel. */
const WAIT_TIMEOUT = 0x00000102;

/** The handful of Win32 error codes WintunCreateAdapter realistically returns. */
const WIN_ERR: Record<number, string> = {
  5: 'ERROR_ACCESS_DENIED — the process is NOT elevated (run from an Administrator terminal)',
  87: 'ERROR_INVALID_PARAMETER',
  577: 'ERROR_INVALID_IMAGE_HASH — driver signature rejected (is wintun.dll the official signed build?)',
  1275: 'ERROR_DRIVER_BLOCKED',
  1359: 'ERROR_INTERNAL_ERROR',
};
function winErr(code: number): string {
  return `GetLastError=${code}${WIN_ERR[code] ? ` (${WIN_ERR[code]})` : ''}`;
}

// Opaque handles are plain pointers across the boundary.
type Handle = unknown;

export interface WintunLib {
  /** Driver version packed as (major<<16)|minor, or 0 if the driver isn't running. */
  runningDriverVersion(): number;
  /** Create (and install-on-demand) an adapter. Throws if not elevated / dll bad. */
  createAdapter(name: string, tunnelType: string): Handle;
  /** Open an existing adapter by name, or null if absent. */
  openAdapter(name: string): Handle | null;
  closeAdapter(adapter: Handle): void;
  /** Start the packet session (ring). */
  startSession(adapter: Handle, capacity?: number): Handle;
  endSession(session: Handle): void;
  /** The Win32 event that signals when the receive ring becomes non-empty. */
  readWaitEvent(session: Handle): Handle;
  /** Block up to timeoutMs for the receive ring to have data. Returns true if
   *  signalled, false on timeout. */
  waitReadable(event: Handle, timeoutMs: number): boolean;
  /** Pop one inbound IP packet as a Buffer (a copy; the ring slot is released),
   *  or null when the ring is empty (then waitReadable) / on a terminal error. */
  receivePacket(session: Handle): Buffer | null;
  /** Inject one IP packet into the OS stack. Returns false if the send ring is
   *  full (caller drops — correct for an unreliable game tunnel). */
  sendPacket(session: Handle, packet: Buffer): boolean;
}

/**
 * Resolve wintun.dll: packaged (extraResources → resources/wintun) then dev
 * (vendor/wintun/win32-x64), mirroring electron/torrent/host/env.ts. Pass an
 * explicit path (the spike does) to skip resolution.
 */
export function resolveWintunDll(explicit?: string): string {
  if (explicit) return explicit;
  const path = require('node:path') as typeof import('node:path');
  const candidates: string[] = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'wintun', 'wintun.dll'));
  candidates.push(path.join(process.cwd(), 'vendor', 'wintun', 'win32-x64', 'wintun.dll'));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(
    `wintun.dll not found (looked in: ${candidates.join(', ')}). Run: node scripts/fetch-wintun.mjs`,
  );
}

/**
 * Load wintun.dll and bind the 10 exports we use plus kernel32!WaitForSingleObject.
 * All strings are UTF-16 (`str16` = LPCWSTR); handles are `void*`; the packet
 * pointers are decoded/encoded via koffi array views (a copy per packet — fine
 * at game rates; a zero-copy koffi.view fast path is a Phase-1 optimisation).
 */
export function loadWintun(dllPath?: string): WintunLib {
  if (process.platform !== 'win32') throw new Error('Wintun is Windows-only');
  const koffi: any = require('koffi');
  const dll = resolveWintunDll(dllPath);

  const lib = koffi.load(dll);
  const k32 = koffi.load('kernel32.dll');

  // WINAPI == __stdcall; on x64 it is ignored, but declared for correctness.
  const CreateAdapter = lib.func('void* __stdcall WintunCreateAdapter(str16, str16, void*)');
  const OpenAdapter = lib.func('void* __stdcall WintunOpenAdapter(str16)');
  const CloseAdapter = lib.func('void __stdcall WintunCloseAdapter(void*)');
  const RunningDriverVersion = lib.func('uint32 __stdcall WintunGetRunningDriverVersion()');
  const StartSession = lib.func('void* __stdcall WintunStartSession(void*, uint32)');
  const EndSession = lib.func('void __stdcall WintunEndSession(void*)');
  const GetReadWaitEvent = lib.func('void* __stdcall WintunGetReadWaitEvent(void*)');
  // _Out_ uint32* PacketSize — pass [0], read back index 0.
  const ReceivePacket = lib.func('void* __stdcall WintunReceivePacket(void*, _Out_ uint32*)');
  const ReleaseReceivePacket = lib.func('void __stdcall WintunReleaseReceivePacket(void*, void*)');
  const AllocateSendPacket = lib.func('void* __stdcall WintunAllocateSendPacket(void*, uint32)');
  const SendPacket = lib.func('void __stdcall WintunSendPacket(void*, void*)');
  const WaitForSingleObject = k32.func('uint32 __stdcall WaitForSingleObject(void*, uint32)');
  const GetLastError = k32.func('uint32 __stdcall GetLastError()');

  return {
    runningDriverVersion: () => RunningDriverVersion() >>> 0,

    createAdapter(name, tunnelType) {
      const a = CreateAdapter(name, tunnelType, null);
      if (!a) {
        const code = GetLastError() >>> 0; // read immediately, before any other FFI call clobbers it
        throw new Error(`WintunCreateAdapter failed — ${winErr(code)}`);
      }
      return a;
    },

    openAdapter(name) {
      return OpenAdapter(name) || null;
    },

    closeAdapter(adapter) { if (adapter) CloseAdapter(adapter); },

    startSession(adapter, capacity = RING_CAPACITY) {
      const s = StartSession(adapter, capacity);
      if (!s) throw new Error('WintunStartSession failed');
      return s;
    },

    endSession(session) { if (session) EndSession(session); },

    readWaitEvent(session) { return GetReadWaitEvent(session); },

    waitReadable(event, timeoutMs) {
      return WaitForSingleObject(event, timeoutMs >>> 0) !== WAIT_TIMEOUT;
    },

    receivePacket(session) {
      const sizeOut = [0];
      const ptr = ReceivePacket(session, sizeOut);
      if (!ptr) return null; // ring empty (ERROR_NO_MORE_ITEMS) or terminal — caller waits
      const size = sizeOut[0] >>> 0;
      const bytes: number[] = koffi.decode(ptr, koffi.array('uint8', size));
      ReleaseReceivePacket(session, ptr); // copy taken above — safe to release now
      return Buffer.from(bytes);
    },

    sendPacket(session, packet) {
      const ptr = AllocateSendPacket(session, packet.length >>> 0);
      if (!ptr) return false; // send ring full → drop (unreliable tunnel semantics)
      koffi.encode(ptr, koffi.array('uint8', packet.length), Array.from(packet));
      SendPacket(session, ptr);
      return true;
    },
  };
}
