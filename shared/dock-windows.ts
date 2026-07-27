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
 * Pool size, DERIVED rather than picked: the dock has five detachable panels
 * and the room-can-never-be-empty invariant pins at least one of them in the
 * main window, so at most `panels - 1 = 4` torn-off groups can ever exist —
 * even in the pathological one-panel-per-window case. The pool is therefore
 * never the binding constraint (the invariant refuses first, with a clearer
 * message), and a request for a slot beyond it means the renderer's allocator
 * is wrong, not that the user did something unusual.
 *
 * The renderer's dock registry asserts `DOCK_WINDOW_POOL_SIZE >= PANELS.length - 1`
 * so adding a sixth panel fails the suite instead of silently making tear-off
 * refusable in a legal state.
 */
export const DOCK_WINDOW_POOL_SIZE = 4;

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

/** True for a name that is an actual pool slot — `havvn-dock-5` is false, not "slot 5". */
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
 *                   allocator hands out a slot beyond the pool (`havvn-dock-5`).
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
