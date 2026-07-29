import { describe, it, expect } from 'vitest';

import {
  DOCK_TEAROFF_GRAB,
  DOCK_TEAROFF_MIN_DISTANCE,
  dockTearOffWindowBounds,
  planDockTearOff,
  tearOffEndPoint,
} from './dockTearOff';
import type { DockDragSnapshot } from './dockDrag';

/**
 * The gesture itself cannot be exercised — there is no jsdom here and no drag loop
 * anywhere — so the whole decision is a function over this object, and this file is
 * the only place the rules are checked. Every case below is a real thing a user does.
 */
const snap = (over: Partial<DockDragSnapshot> = {}): DockDragSnapshot => ({
  panel: 'chat',
  from: 'right',
  win: 'main',
  seq: 1,
  startX: 500,
  startY: 400,
  lastX: 500,
  lastY: 400,
  moved: false,
  sawButtonsDown: false,
  ...over,
});

/** A release 300px away, with the button up and nothing having taken the drop. */
const outside = (over: Partial<Parameters<typeof planDockTearOff>[0]> = {}) => planDockTearOff({
  snap: snap({ lastX: 800, lastY: 400, moved: true }),
  endX: 800,
  endY: 400,
  dropEffect: 'none',
  buttons: 0,
  ...over,
});

describe('planDockTearOff — the release that means "make this its own window"', () => {
  it('tears off a tab pulled well clear of the app and dropped on nothing', () => {
    expect(outside()).toEqual({
      tear: { panel: 'chat', from: 'right', win: 'main', screenX: 800, screenY: 400, distance: 300 },
    });
  });

  it('does NOTHING when a drop target of ours consumed the drag', () => {
    // `drop` fires before `dragend` and every drop path calls endDockDrag(), so a
    // null session IS the record that the tab landed somewhere legitimate. This is
    // also the drop-back-on-the-origin-strip case: it resolves to 'noop' and still
    // ends the session, so the gesture that changed nothing spawns nothing.
    expect(outside({ snap: null })).toEqual({ tear: null, why: 'no-drag' });
  });

  it('does nothing when the platform says a drop was accepted', () => {
    expect(outside({ dropEffect: 'move' }).why).toBe('dropped');
    expect(outside({ dropEffect: 'copy' }).why).toBe('dropped');
  });

  it('reads a still-pressed button as an ESC-cancel, not a release', () => {
    // Esc aborts the drag with the button down; letting go is what a drop-outside is.
    const s = snap({ lastX: 800, lastY: 400, moved: true, sawButtonsDown: true });
    expect(outside({ snap: s, buttons: 1 }).why).toBe('still-pressed');
    expect(outside({ snap: s, buttons: 0 }).tear).not.toBeNull();
  });

  it('SKIPS the button test on a platform that never reported one', () => {
    // Self-calibration: `sawButtonsDown` false means no drag event of this drag ever
    // populated `buttons`, so a 1 at dragend is noise, not evidence. Without this the
    // gesture would be silently dead wherever Chromium reports 0 throughout.
    const s = snap({ lastX: 800, lastY: 400, moved: true, sawButtonsDown: false });
    expect(outside({ snap: s, buttons: 1 }).tear).not.toBeNull();
  });

  it('ignores a twitch off the strip — the threshold is a real pull', () => {
    const at = (dx: number) => outside({
      snap: snap({ lastX: 500 + dx, lastY: 400, moved: true }),
      endX: 500 + dx,
    });
    expect(at(DOCK_TEAROFF_MIN_DISTANCE - 1).why).toBe('too-short');
    expect(at(DOCK_TEAROFF_MIN_DISTANCE).tear).not.toBeNull();
    expect(at(0).why).toBe('too-short'); // an Esc reported at the origin
  });

  it('measures diagonally, not per axis', () => {
    // 48,48 is 67.9px — over the line, though neither axis is.
    const s = snap({ lastX: 548, lastY: 448, moved: true });
    expect(outside({ snap: s, endX: 548, endY: 448 }).tear).not.toBeNull();
    // 40,40 is 56.6px — under it.
    const t = snap({ lastX: 540, lastY: 440, moved: true });
    expect(outside({ snap: t, endX: 540, endY: 440 }).why).toBe('too-short');
  });

  it('falls back to the tracked point when dragend reports 0,0', () => {
    // The documented Chromium quirk for a drop outside the window — the exact case
    // this gesture is about, so without the fallback the feature would never fire.
    const p = outside({ snap: snap({ lastX: 900, lastY: 700, moved: true }), endX: 0, endY: 0 });
    expect(p.tear).toMatchObject({ screenX: 900, screenY: 700 });
  });

  it('refuses rather than guessing when no point is believable at all', () => {
    // A window must never be placed at a coordinate nobody vouched for.
    expect(outside({ snap: snap(), endX: 0, endY: 0 }).why).toBe('no-end-point');
    expect(outside({ snap: snap({ moved: true, lastX: 0, lastY: 0 }), endX: NaN, endY: NaN }).why)
      .toBe('no-end-point');
  });

  it('fixes which reason a doubly-disqualified drag reports', () => {
    // A refusal reason that moves around under composition is a debugging trap.
    expect(outside({ snap: null, dropEffect: 'move' }).why).toBe('no-drag');
    expect(outside({ dropEffect: 'move', endX: 500, endY: 400 }).why).toBe('dropped');
    const s = snap({ moved: true, lastX: 501, lastY: 400, sawButtonsDown: true });
    expect(outside({ snap: s, endX: 501, buttons: 1 }).why).toBe('still-pressed');
  });

  it('carries the SOURCE zone, so the owner can route its refusal toast', () => {
    const s = snap({ from: 'left', win: 'havvn-dock-1', lastX: 800, moved: true });
    expect(outside({ snap: s })).toMatchObject({ tear: { from: 'left', win: 'havvn-dock-1' } });
  });
});

describe('tearOffEndPoint', () => {
  it('prefers dragend\'s own coordinates', () => {
    expect(tearOffEndPoint({ endX: 12, endY: 34, lastX: 90, lastY: 90, moved: true }))
      .toEqual({ x: 12, y: 34 });
  });

  it('will not fall back to a point no drag event ever produced', () => {
    // `moved` false means lastX/lastY are still the seeded dragstart point; using it
    // would report a zero-distance release as if it had been observed.
    expect(tearOffEndPoint({ endX: 0, endY: 0, lastX: 500, lastY: 400, moved: false })).toBeNull();
  });
});

describe('dockTearOffWindowBounds — where the new window lands', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 460, height: 700 };

  it('anchors the TITLE area under the cursor, like a browser tab tear-off', () => {
    // The tab you are holding stays under your finger instead of the window's corner
    // jumping there. Well clear of every edge, so nothing is clamped.
    expect(dockTearOffWindowBounds({ x: 800, y: 200 }, size, work)).toEqual({
      x: 800 - DOCK_TEAROFF_GRAB.x, y: 200 - DOCK_TEAROFF_GRAB.y, width: 460, height: 700,
    });
  });

  it('keeps the whole window inside the work area', () => {
    // Bottom-right: the window would hang off the screen and the taskbar edge.
    expect(dockTearOffWindowBounds({ x: 1900, y: 1030 }, size, work))
      .toEqual({ x: 1460, y: 340, width: 460, height: 700 });
    // Top-left: the grab offset would push it negative, hiding the titlebar.
    expect(dockTearOffWindowBounds({ x: 4, y: 2 }, size, work))
      .toEqual({ x: 0, y: 0, width: 460, height: 700 });
  });

  it('works on a display that is not the primary one', () => {
    // A second monitor to the LEFT has negative coordinates; nothing here assumes
    // the origin is at 0,0, which is the whole reason the work area is a parameter.
    const left = { x: -1920, y: -200, width: 1920, height: 1040 };
    expect(dockTearOffWindowBounds({ x: -1000, y: 100 }, size, left))
      .toEqual({ x: -1120, y: 84, width: 460, height: 700 });
    expect(dockTearOffWindowBounds({ x: -1910, y: -190 }, size, left))
      .toEqual({ x: -1920, y: -200, width: 460, height: 700 });
  });

  it('shrinks a window that cannot fit rather than hanging it off the edge', () => {
    // A small laptop display with the taskbar showing: a 700px-tall window pinned at
    // full height would put its titlebar out of reach.
    const small = { x: 0, y: 0, width: 400, height: 600 };
    expect(dockTearOffWindowBounds({ x: 200, y: 300 }, size, small))
      .toEqual({ x: 0, y: 0, width: 400, height: 600 });
  });

  it('rounds to whole pixels — a fractional DIP rect is not a valid window', () => {
    const r = dockTearOffWindowBounds({ x: 800.6, y: 500.4 }, { width: 460.5, height: 700.2 }, work);
    for (const v of [r.x, r.y, r.width, r.height]) expect(Number.isInteger(v)).toBe(true);
  });
});
