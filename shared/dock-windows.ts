/**
 * Dock window pool — the ONE source of truth for the frame names the room dock
 * may tear a panel group off into.
 *
 * `shared/**` is compiled by BOTH tsconfig.electron.json and
 * tsconfig.renderer.json, so the main-process allowlist (electron/main.ts
 * `POPOUTS`) and the renderer's dock model import the same array. That matters
 * because the two halves fail in opposite directions when they drift: a name
 * the renderer allocates but main does not allowlist is denied at
 * `setWindowOpenHandler`, and a name main allows but the renderer never uses is
 * a dead `popoutBounds` key nobody reads.
 *
 * No Node/Electron/DOM imports — pure data, so vitest runs it directly.
 */

/**
 * Pool size, DERIVED rather than picked: the dock has six detachable panels
 * (voice, lan, server, people, files, chat) and the room-can-never-be-empty
 * invariant pins at least one of them in the main window, so at most
 * `panels - 1 = 5` torn-off groups can ever exist — even in the pathological
 * one-panel-per-window case. The pool is therefore never the binding constraint
 * (the invariant refuses first, with a clearer message), and a request for a
 * slot beyond it means the renderer's allocator is wrong, not that the user did
 * something unusual.
 *
 * The renderer's dock registry asserts `DOCK_WINDOW_POOL_SIZE >= PANELS.length - 1`
 * so adding a seventh panel fails the suite instead of silently making tear-off
 * refusable in a legal state. The main-process allowlist is generated from
 * DOCK_WINDOW_FRAME_NAMES below, so it follows this number automatically.
 */
export const DOCK_WINDOW_POOL_SIZE = 5;

/**
 * Every frame name this app is willing to open as a pop-out shares this prefix.
 * It is what lets the window-open handler tell "our pop-out was refused" (worth
 * telling the renderer about) from an ordinary external link, which arrives with
 * frameName `''` or `'_blank'` and is routed to the default browser.
 */
export const POPOUT_FRAME_PREFIX = 'havvn-';

/** Prefix of a dock pool slot. Slots are numbered from 1, not 0, for the user-facing window title. */
export const DOCK_WINDOW_PREFIX = `${POPOUT_FRAME_PREFIX}dock-`;

/** Pool frame name for a 1-based slot index. Out-of-range indices return null. */
export function dockWindowFrameName(slot: number): string | null {
  if (!Number.isInteger(slot) || slot < 1 || slot > DOCK_WINDOW_POOL_SIZE) return null;
  return `${DOCK_WINDOW_PREFIX}${slot}`;
}

/**
 * Frame names in ALLOCATION order. The renderer allocates the lowest free slot,
 * so the overwhelmingly common single-torn-off-group case always reuses slot 1
 * and therefore always reopens at the size and monitor the user last parked it
 * on (bounds are persisted per frame name, i.e. per SLOT).
 */
export const DOCK_WINDOW_FRAME_NAMES: readonly string[] =
  Array.from({ length: DOCK_WINDOW_POOL_SIZE }, (_, i) => `${DOCK_WINDOW_PREFIX}${i + 1}`);

/** True for a name that is an actual pool slot — `havvn-dock-6` is false, not "slot 6". */
export function isDockWindowFrame(name: string): boolean {
  return DOCK_WINDOW_FRAME_NAMES.includes(name);
}

/** True for any name shaped like one of our pop-outs, allowlisted or not. */
export function isPopoutFrameName(name: string): boolean {
  return typeof name === 'string' && name.startsWith(POPOUT_FRAME_PREFIX);
}

/**
 * The room chat's bespoke pop-out, retired by the dock (chat is an ordinary
 * dock panel now). Kept ONLY as a bounds seed: a user who parked the detached
 * chat on a second monitor should find the first torn-off dock group there
 * rather than centred on the primary display. See `savedPopoutBounds` in
 * electron/main.ts.
 */
export const LEGACY_CHAT_FRAME_NAME = 'havvn-room-chat';

/**
 * Why the main process refused to open a pop-out. `window.open` already returns
 * null in the renderer, but null cannot say WHY — and the two cases want
 * different messages:
 *
 *  - `not-allowed`  the frame name is not in the allowlist. Reachable when a
 *                   stale renderer asks for a retired pop-out, or when a dock
 *                   allocator hands out a slot beyond the pool (`havvn-dock-6`).
 *  - `blocked-url`  the frame name IS allowlisted but the request carried a
 *                   real URL instead of `about:blank`. Our own code never does
 *                   this; it means something is trying to load content into a
 *                   window that inherits the preload bridge.
 */
export type PopoutDenyReason = 'not-allowed' | 'blocked-url';

/** Payload of the `win:popoutDenied` push. */
export interface PopoutDeniedEvent {
  readonly frameName: string;
  readonly url: string;
  readonly reason: PopoutDenyReason;
}

/** Payload of the `win:popoutClosed` push. */
export interface PopoutClosedEvent {
  readonly frameName: string;
}

// ── tear-off placement: "open this one under the cursor" ────────────────────
//
// The drag-out gesture ends with a window that must appear WHERE THE USER LET GO,
// and the renderer cannot say where that is: `screenX` on a drag event is CSS
// pixels, and this app scales its UI through `webFrame.setZoomFactor`, so a
// renderer coordinate is not DIP and would land the window somewhere the user
// never pointed. Main owns `screen`, where the cursor point, the display pick and
// window bounds are all DIP in one process.
//
// So the renderer sends a FLAG, not a coordinate: `window.open`'s features string
// carries `havvnAtCursor=1`, which arrives as `details.features` in
// `setWindowOpenHandler`, and main resolves the rect itself. The flag is parsed by
// the strict reader below rather than by Electron's own feature interpretation,
// which is version-dependent and not a contract we want to rest on.

/** The feature flag a tear-off sets to ask for cursor placement. */
export const DOCK_AT_CURSOR_FEATURE = 'havvnAtCursor';

/** The whole features string for a tear-off open. */
export const DOCK_AT_CURSOR_FEATURE_STR = `${DOCK_AT_CURSOR_FEATURE}=1`;

/** Strictly: did the opener ask for cursor placement? Unknown keys are ignored. */
export function wantsCursorPlacement(features: string | undefined | null): boolean {
  if (typeof features !== 'string' || features === '') return false;
  return features.split(',').some((part) => {
    const [k, v] = part.split('=');
    return k?.trim() === DOCK_AT_CURSOR_FEATURE && (v === undefined || v.trim() === '1');
  });
}

/** A screen rectangle. Matches Electron's `Rectangle` field-for-field. */
export interface DockScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the cursor sits inside the new window, in DIP.
 *
 * The window is anchored so the pointer lands on its TITLE area rather than its
 * top-left corner — the same feel as a browser tab tear-off, where the tab you are
 * holding stays under your finger. 120 across is roughly half a tab; 16 down puts
 * the cursor inside the titlebar rather than on its edge.
 */
export const DOCK_TEAROFF_GRAB = { x: 120, y: 16 };

/**
 * PURE: the bounds a torn-off window should get for a release at `cursor`.
 *
 * `cursor` and `workArea` must already be in the SAME coordinate space — the caller
 * is the main process, where `screen.getCursorScreenPoint()` and
 * `screen.getDisplayNearestPoint(...).workArea` are both DIP.
 *
 * Clamping into the work area is what makes a second monitor and a taskbar edge
 * correct by construction rather than by luck (including a display whose origin is
 * NEGATIVE — a monitor to the left of the primary), and the size clamp handles the
 * case that actually bites on small laptop displays: a window taller than the work
 * area would otherwise be positioned with its titlebar off-screen and unreachable.
 */
export function dockWindowBoundsAtCursor(
  cursor: { x: number; y: number },
  size: { width: number; height: number },
  workArea: DockScreenRect,
  grab: { x: number; y: number } = DOCK_TEAROFF_GRAB,
): DockScreenRect {
  const width = Math.max(1, Math.min(Math.round(size.width), Math.round(workArea.width)));
  const height = Math.max(1, Math.min(Math.round(size.height), Math.round(workArea.height)));
  const wantX = Math.round(cursor.x - grab.x);
  const wantY = Math.round(cursor.y - grab.y);
  const maxX = Math.round(workArea.x + workArea.width) - width;
  const maxY = Math.round(workArea.y + workArea.height) - height;
  return {
    x: Math.max(Math.round(workArea.x), Math.min(wantX, maxX)),
    y: Math.max(Math.round(workArea.y), Math.min(wantY, maxY)),
    width,
    height,
  };
}
