/**
 * Failure codes for the game-server surface, and the marker that lets one
 * survive the trip through Electron IPC.
 *
 * ─ WHY A CODE AND NOT A SENTENCE ────────────────────────────────────────────
 * The modules were built entirely on translation keys, on the grounds that the
 * main process holds no dictionary and English prose returned from it would make
 * the settings form the one part of a Russian UI that stayed in English. The
 * MANAGER layer was not: it threw `new Error('stop the server before
 * reinstalling')` and the renderer toasted that string verbatim. Same bug, one
 * layer up.
 *
 * ─ WHY A MARKER INSIDE THE MESSAGE ──────────────────────────────────────────
 * A thrown Error does not cross ipcRenderer.invoke intact. Electron rebuilds it
 * on the far side with the message wrapped in its own text, roughly
 *
 *     Error invoking remote method 'rooms:srvCreate': Error: <message>
 *
 * so the renderer cannot switch on a class, a property, or even the whole
 * message — only on something recognisable INSIDE it. Hence a prefix: the code
 * travels as part of the message and `serverErrorCode` digs it back out. The
 * alternative, converting every throwing method to a tagged result type, changes
 * a dozen signatures and their call sites to solve a serialisation problem.
 *
 * Both halves live here, in shared, so the writer and the reader cannot drift
 * and the round trip is unit-testable without Electron.
 */

/**
 * Everything the core can refuse to do, as a code the renderer translates via
 * `rooms.server.err.<code>`.
 *
 * A closed union, so adding a refusal without adding its translation is a type
 * error rather than a raw code shown to a user.
 */
export type ServerErrorCode =
  // Lifecycle refusals
  | 'not-installed'          // start attempted before a successful install
  | 'install-running'        // an install is in flight
  | 'stop-first'             // the operation needs the process down
  | 'not-running'            // console command with no live process
  | 'no-console'             // module has no console capability
  | 'empty-command'
  | 'runtime-missing'        // the JRE went away after install
  // Permission
  | 'host-only'              // only the host may drive the console
  // Create-time refusals
  | 'legal-pending'          // licence gate not cleared
  | 'unknown-module'
  | 'unknown-version'        // refId is not in the module's own catalog
  | 'no-import-support'
  | 'import-expired'         // staging directory is gone
  | 'nothing-recognised'
  // Resource refusals
  | 'disk-space'             // not enough room to install
  | 'port-exhausted'         // every port in the module's range is claimed
  | 'files-busy'             // directory still locked (Windows ENOTEMPTY / EBUSY)
  | 'files-locked'           // permission denied deleting or writing
  | 'delete-failed'          // instance folder could not be removed
  | 'unknown-instance'       // id is not one we supervise
  // Update check
  | 'no-update-source'      // an imported instance has no upstream to check
  | 'no-content-bindings'   // sync with no folder bound to any slot
  | 'viewer-only';          // console is read-only for this role

/** Prefix that makes a code findable in a message Electron has rewrapped. Chosen
 *  to be something no upstream error text would ever contain by accident. */
export const SERVER_ERR_PREFIX = 'havvn-server-err:';

const CODES = new Set<string>([
  'not-installed', 'install-running', 'stop-first', 'not-running', 'no-console',
  'empty-command', 'runtime-missing', 'host-only', 'legal-pending',
  'unknown-module', 'unknown-version', 'no-import-support', 'import-expired',
  'nothing-recognised', 'disk-space', 'port-exhausted', 'files-busy',
  'files-locked', 'delete-failed', 'unknown-instance', 'no-update-source',
  'no-content-bindings', 'viewer-only',
]);

/**
 * A refusal the UI can phrase in the user's language.
 *
 * `detail` carries the unlocalisable specifics — a version id, a byte count, an
 * upstream message — and is shown beneath the translated sentence rather than
 * instead of it.
 */
export class ServerActionError extends Error {
  readonly code: ServerErrorCode;

  readonly detail: string | undefined;

  constructor(code: ServerErrorCode, detail?: string) {
    // The detail rides along after the code so a log line is still informative;
    // serverErrorCode stops at the code and the renderer never parses the rest.
    super(`${SERVER_ERR_PREFIX}${code}${detail ? ` ${detail}` : ''}`);
    this.name = 'ServerActionError';
    this.code = code;
    this.detail = detail;
  }
}

/** Is this string one of our codes? Used for the results that come back as a
 *  VALUE (`{ ok: false, reason }`) rather than being thrown through IPC, where
 *  there is no message to carry a prefix. */
export function isServerErrorCode(value: unknown): value is ServerErrorCode {
  return typeof value === 'string' && CODES.has(value);
}

/**
 * Recover a code from anything that reached the renderer — an Error, a rewrapped
 * IPC message, a bare code, a plain string. Returns null for a genuine upstream
 * failure (a socket reset, a 404 from a mirror), which the caller must then show
 * as-is: inventing a translated sentence for an unknown fault would be worse than
 * showing the technical one.
 */
export function serverErrorCode(err: unknown): ServerErrorCode | null {
  if (isServerErrorCode(err)) return err;
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const at = text.indexOf(SERVER_ERR_PREFIX);
  if (at < 0) return null;
  // Bounded at the first whitespace: the detail may contain anything at all.
  const code = text.slice(at + SERVER_ERR_PREFIX.length).split(/\s/)[0] ?? '';
  return CODES.has(code) ? (code as ServerErrorCode) : null;
}

/** The detail portion, when one was attached. Used for the small technical line
 *  under the translated message. */
export function serverErrorDetail(err: unknown): string | null {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const at = text.indexOf(SERVER_ERR_PREFIX);
  if (at < 0) return null;
  const rest = text.slice(at + SERVER_ERR_PREFIX.length);
  const space = rest.search(/\s/);
  if (space < 0) return null;
  return rest.slice(space + 1).trim() || null;
}

/**
 * Peel Electron's IPC wrapper and the repeated `Error:` prefixes off a message.
 *
 * Without this, every thrown Error arrives in the renderer looking like
 * `Error invoking remote method 'rooms:srvDelete': Error: ENOTEMPTY, …` — which
 * is three wrappers around the one useful clause, and the whole thing is what
 * used to overflow the toast.
 */
export function unwrapErrorMessage(err: unknown): string {
  let text = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '');
  text = text.replace(/^Error invoking remote method '[^']+':\s*/i, '');
  // Node sometimes rewraps once more as "Error: …"; strip every leading one.
  while (/^Error:\s*/i.test(text)) text = text.replace(/^Error:\s*/i, '');
  return text.trim();
}

/**
 * Map a raw Node / OS failure onto one of our codes when the shape is familiar.
 *
 * Returns null for everything else — a 404 from a mirror, a digest mismatch —
 * so those stay technical rather than becoming a wrong friendly sentence.
 */
export function classifySystemError(message: string): ServerErrorCode | null {
  if (/\bENOTEMPTY\b|\bEBUSY\b/i.test(message)) return 'files-busy';
  if (/\bEPERM\b|\bEACCES\b/i.test(message)) return 'files-locked';
  if (/\bno such server instance\b/i.test(message)) return 'unknown-instance';
  return null;
}

/**
 * Collapse absolute paths and hard-cap length so a toast can show the useful
 * part of a system error without blowing past the window edge.
 *
 * Paths are the usual offender: Windows `ENOTEMPTY` repeats the full
 * `\\?\C:\Users\…\AppData\Roaming\havvn\servers\…` twice in one message.
 */
export function clipErrorDetail(text: string, max = 180): string {
  const collapsed = text
    .replace(/\\\\\?\\/g, '')
    .replace(/[A-Za-z]:\\Users\\[^\\]+\\AppData\\Roaming\\havvn\\/gi, '…/')
    .replace(/[A-Za-z]:\\Users\\[^\\]+\\/gi, '…/')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}
