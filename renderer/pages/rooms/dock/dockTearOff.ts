/**
 * dockTearOff — the DRAG-OUT gesture, as pure functions.
 *
 * The gesture is the browser's: grab a tab, drag it off the app, let go, and it
 * becomes its own window under the cursor. It is decided in ONE event — `dragend`
 * on the drag SOURCE — which is spec-guaranteed to fire for every ending of a drag
 * (a drop, a drop outside any target, an Esc-cancel) and which this folder already
 * relies on for teardown.
 *
 * ── Why the whole decision lives here and not in the handler ─────────────────
 * A drag cannot be exercised in this repo's test harness: renderer tests render to
 * static markup under plain node, with no jsdom and certainly no drag loop. So every
 * rule that CAN be decided from data — is this an outside drop? did it clear the
 * distance threshold? where does the new window go? — is a function over a plain
 * object here, with a truth table beside it in dockTearOff.test.ts. The handlers in
 * DockTabStrip/DockSoloHandle are left with only what genuinely needs an event:
 * reading the snapshot, reading `dropEffect`/`buttons`, and calling back.
 *
 * ── The four gates, and what each one is for ────────────────────────────────
 *   1. A LIVE SESSION. `drop` fires before `dragend`, and every drop path of ours
 *      (`onStripDrop`, the zone body's native `onDrop`) calls `endDockDrag()`, which
 *      nulls the module session. A null session at `dragend` therefore means "one of
 *      our targets took it" — including a drop back on the ORIGIN strip that resolved
 *      to 'noop', which is precisely the cancelled gesture that must not spawn a
 *      window. This gate is free: it reads state the code already maintained.
 *   2. dropEffect === 'none'. Corroboration only, and never sufficient alone (an
 *      Esc-cancel reports 'none' too). It can only make the verdict MORE conservative.
 *   3. THE BUTTON, self-calibrating. Physical fact: Esc aborts a drag with the button
 *      still DOWN, whereas a drop-outside happens on RELEASE. Chromium is not
 *      contractually obliged to populate `buttons` on drag events, so the test is
 *      applied only when THIS drag proved the platform reports it (`sawButtonsDown`).
 *      On a platform that never reports it the branch simply never arms — no
 *      build-time assumption, no dead code path that silently kills the gesture.
 *   4. DISTANCE ≥ DOCK_TEAROFF_MIN_DISTANCE from the drag's start point. Kills the
 *      accidental jiggle off the strip, and in practice kills most Esc-cancels too
 *      (Chromium reports a cancelled drag's `dragend` at or near the origin).
 *
 * ── What this file deliberately does NOT decide ─────────────────────────────
 * Whether the release landed inside one of the app's OWN windows — over the room's
 * head bar, a splitter, another dock window, a pop-out this React tree never opened.
 * That test cannot be done honestly in the renderer: `screenX` is CSS pixels and the
 * app ships a UI-scale setting wired to `webFrame.setZoomFactor`, so a renderer
 * coordinate is not DIP and cannot be compared with window bounds; and a renderer can
 * only enumerate the windows it opened itself. It belongs to the main process, which
 * owns `screen` and sees every BrowserWindow. So the strip's callback is a PROPOSAL:
 * the owner confirms the release was outside the app and only then commits the model
 * op. See the `onTearOut` contract in DockTabStrip.
 *
 * RESIDUAL, stated rather than hidden: Esc pressed with the pointer far outside the
 * app, on a platform that does not report `buttons`, is indistinguishable from a
 * release outside — no listener can see the Esc, because Chromium's native drag loop
 * swallows key events. It costs one extra window, undone by the existing "Dock back"
 * button in one click, and the model's room-never-empty invariant still refuses to
 * empty the room. The alternative — refusing every outside release we cannot prove —
 * is a dead feature.
 */

import { isUsableDragPoint } from './dockDrag';
import type { DockDragSnapshot } from './dockDrag';

/**
 * How far the pointer must travel from the drag's start before a release outside
 * counts as a tear-off, in the source frame's CSS pixels.
 *
 * 64 is more than two tab heights (the strip is ~26px) and about a third of the
 * 180px rail minimum: unreachable by a twitch, trivially cleared by an intentional
 * pull. Measuring in CSS px rather than device px is deliberate — a user who scales
 * the UI up gets bigger tabs and bigger accidental drags, so the threshold should
 * scale with them.
 */
export const DOCK_TEAROFF_MIN_DISTANCE = 64;

/** Why a `dragend` did NOT mean "tear this panel off". */
export type DockTearOffRefusal =
  /** No drag in flight — a target consumed the drop, or there was never a drag. */
  | 'no-drag'
  /** The platform says a drop was accepted somewhere. */
  | 'dropped'
  /** A button was still down at `dragend`: an Esc-cancel, not a release. */
  | 'still-pressed'
  /** Neither `dragend` nor the tracked points gave a believable screen point. */
  | 'no-end-point'
  /** The pointer never travelled far enough to mean it. */
  | 'too-short';

export interface DockTearOffInput {
  /** `dockDragSnapshot()` read BEFORE `endDockDrag()`. Null ⇒ a target took it. */
  snap: DockDragSnapshot | null;
  /** `dragend`'s screenX/screenY, believed only when usable (see isUsableDragPoint). */
  endX: number;
  endY: number;
  /** `dragend`'s `dataTransfer.dropEffect`. */
  dropEffect: string;
  /** `dragend`'s `buttons` bitmask. */
  buttons: number;
  /** Override for tests; defaults to DOCK_TEAROFF_MIN_DISTANCE. */
  minDistance?: number;
}

/** Where the panel goes and where the pointer was when the user let go. */
export interface DockTearOff {
  panel: string;
  /** The zone the panel is leaving — the owner needs it to route its toast. */
  from: string;
  /** The realm the drag started in ('main' or a dock window's frame name). */
  win: string;
  /** The release point, in the SOURCE frame's screen (CSS px) coordinates. */
  screenX: number;
  screenY: number;
  /** How far the pointer travelled. Informational; the threshold is already applied. */
  distance: number;
}

export type DockTearOffPlan =
  | { tear: DockTearOff; why?: undefined }
  | { tear: null; why: DockTearOffRefusal };

/**
 * The release point: `dragend`'s own coordinates when they are believable, else the
 * last point the source's `drag` events reported.
 *
 * The fallback is not defensive padding. Chromium is known to report `dragend` at
 * 0,0 when the drop happened outside the window — the exact case this gesture is
 * about — so without it the distance test would fail on every genuine tear-off on
 * the affected platforms, and the feature would be silently dead.
 *
 * Returns null when NEITHER point is usable, which the planner turns into a refusal:
 * a window must never be placed at a coordinate nobody vouched for.
 */
export function tearOffEndPoint(
  i: { endX: number; endY: number; lastX: number; lastY: number; moved: boolean },
): { x: number; y: number } | null {
  if (isUsableDragPoint(i.endX, i.endY)) return { x: i.endX, y: i.endY };
  if (i.moved && isUsableDragPoint(i.lastX, i.lastY)) return { x: i.lastX, y: i.lastY };
  return null;
}

/**
 * The whole gesture decision. See the file header for what each gate is for.
 *
 * Gate order is cheapest-and-most-decisive first, and it fixes which refusal a
 * doubly-disqualified drag reports — the tests pin that order, because a refusal
 * reason that moves around is a debugging trap.
 */
export function planDockTearOff(i: DockTearOffInput): DockTearOffPlan {
  const { snap } = i;
  // (1) A drop target of ours already ended this drag.
  if (!snap) return { tear: null, why: 'no-drag' };
  // (2) The platform accepted a drop somewhere.
  if (i.dropEffect !== 'none') return { tear: null, why: 'dropped' };
  // (3) Still pressed ⇒ Esc-cancel. Only trusted when this drag proved the platform
  //     reports `buttons` at all.
  if (snap.sawButtonsDown && Number.isFinite(i.buttons) && (i.buttons & 1) !== 0) {
    return { tear: null, why: 'still-pressed' };
  }
  // (4) A believable release point...
  const end = tearOffEndPoint({ endX: i.endX, endY: i.endY, lastX: snap.lastX, lastY: snap.lastY, moved: snap.moved });
  if (!end) return { tear: null, why: 'no-end-point' };
  // ...far enough from where the drag began.
  const dx = end.x - snap.startX;
  const dy = end.y - snap.startY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const min = i.minDistance ?? DOCK_TEAROFF_MIN_DISTANCE;
  if (!(distance >= min)) return { tear: null, why: 'too-short' };
  return {
    tear: { panel: snap.panel, from: snap.from, win: snap.win, screenX: end.x, screenY: end.y, distance },
  };
}

// ── where the new window goes ───────────────────────────────────────────────
//
// The arithmetic lives in `shared/dock-windows.ts` — next to the window pool it
// places windows into — because the process that RUNS it is the main one:
// `screen.getCursorScreenPoint()` and `getDisplayNearestPoint(...).workArea` are
// both DIP there, and `shared/**` is compiled by both tsconfigs so main can import
// exactly what this folder's test suite exercises. Re-exported here so the gesture
// reads as one thing and the sibling test keeps covering the single implementation.
export type { DockScreenRect } from '../../../../shared/dock-windows';
export {
  DOCK_TEAROFF_GRAB,
  dockWindowBoundsAtCursor as dockTearOffWindowBounds,
} from '../../../../shared/dock-windows';
