/**
 * dockDrag — the tab-drag protocol for the room dock: the wire format, the pure
 * geometry, and the single module-level drag SESSION that paints hover feedback.
 *
 * ── Why a module singleton rather than a React context ───────────────────────
 * Chromium's protected-mode rule: during `dragover`, `dataTransfer.getData()`
 * returns `''` — only `dataTransfer.types` is readable. So while hovering we can
 * authorize the drag ("is it ours?") but we CANNOT read which panel is being
 * dragged. Hover feedback needs that id (grey the source tab, suppress a marker
 * on a no-op), so the id has to be remembered somewhere outside dataTransfer.
 *
 * That somewhere is a module variable, and it is correct rather than lazy:
 * an HTML5 drag cannot cross an Electron BrowserWindow boundary, and every
 * torn-off dock window is a PORTAL from the main renderer's single JS realm. One
 * module variable is therefore visible to every strip in every window and cannot
 * be stale-across-windows, because there is only one realm. A React context would
 * add a provider that some ancestor has to remember to mount — and the file that
 * would mount it is not the file that needs it.
 *
 * ── Why nothing here is React state (invariant C) ────────────────────────────
 * The room re-renders on every gossip push. A `setState` per `dragover` (~60Hz)
 * would stack on top of that. So hover lives in DOM ATTRIBUTES written through
 * `setAttrIfChanged` and read by CSS only; React never learns that a drag is in
 * flight. Each of the three attributes has exactly ONE writer with exactly one
 * live element ("last dragover wins"), which is what makes the whole thing immune
 * to dragenter/dragleave ordering — no depth counters, no flicker class.
 *
 * ── Cleanup ─────────────────────────────────────────────────────────────────
 * The one failure mode of imperative attributes is a stranded marker. `endDockDrag`
 * clears all three and is idempotent; it is called from BOTH `dragend` (which
 * always fires in the source window — including Esc-cancel and drop-outside) and
 * `drop`. One teardown path, called twice, rather than two paths.
 *
 * That double call is also load-bearing for the DRAG-OUT TEAR-OFF gesture: `drop`
 * runs before `dragend`, so a session that is still alive at `dragend` proves no
 * drop target of ours accepted the drag. A `dragend` handler therefore reads
 * `dockDragSnapshot()` BEFORE tearing down — see the ordering invariant there, and
 * `dockTearOff.ts` for the decision it feeds.
 *
 * DOM discipline: nothing here dereferences `document`/`window` at module scope,
 * and every DOM reach takes its element or document as an ARGUMENT. Renderer tests
 * run under plain node (renderToStaticMarkup, no jsdom), so a bare global would
 * throw at import time in every module that imports this one.
 */

/**
 * The one private drag type. LOWERCASE is mandatory, not style: Chromium
 * normalises `dataTransfer.types` on read, so a mixed-case type could never be
 * matched. The `text/` prefix mirrors RoomsPage's `FILE_DND_TYPE`
 * ('text/havvn-fileid') so one grep finds both of the app's drag protocols.
 *
 * NOTHING ELSE is put on the dataTransfer — in particular NO `text/plain`. That
 * omission is load-bearing: the room hosts a chat textarea and several inputs, and
 * a drag carrying text/plain is droppable into every one of them (and into the
 * OS), which would insert the tab's label as text. With a custom type alone, every
 * text field in the app is inert to a tab drag for free.
 */
export const DOCK_DND_TYPE = 'text/havvn-dockpanel';

/** Realm key for the main renderer window; dock windows use their frame name. */
export const DOCK_MAIN_WINDOW_KEY = 'main';

/** Wire tag. A payload without it is refused — the format fails closed. */
const DOCK_DRAG_TAG = 'havvn-dock';

export interface DockDragPayload {
  readonly t: typeof DOCK_DRAG_TAG;
  /** The panel being dragged. */
  readonly panel: string;
  /** Source zone — what distinguishes a reorder from a cross-zone move. */
  readonly zone: string;
  /** Source realm ('main' | a dock frame name). A foreign value is refused. */
  readonly win: string;
}

export function encodeDockDrag(p: { panel: string; zone: string; win: string }): string {
  const payload: DockDragPayload = { t: DOCK_DRAG_TAG, panel: p.panel, zone: p.zone, win: p.win };
  return JSON.stringify(payload);
}

/** JSON.parse succeeds on scalars/null/arrays; only a plain object is safe to read. */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * try/catch + plain-object guard + field-by-field rebuild — the same discipline as
 * dockModel's `parseDockLayout`. Unknown tag / missing field / wrong type → null.
 * Never throws, so a hostile or truncated payload can only produce a refused drop.
 */
export function parseDockDragPayload(raw: string | null | undefined): DockDragPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.t !== DOCK_DRAG_TAG) return null;
  const { panel, zone, win } = parsed;
  if (typeof panel !== 'string' || !panel) return null;
  if (typeof zone !== 'string' || !zone) return null;
  if (typeof win !== 'string' || !win) return null;
  return { t: DOCK_DRAG_TAG, panel, zone, win };
}

/**
 * Type-only authorization — all that is readable during `dragover`.
 *
 * This is also the guard that keeps the strip from swallowing an OS file drop
 * meant for the room: 'Files' and 'text/havvn-fileid' both fall straight through,
 * so the strip never preventDefaults a drag it does not own. Loosening this to
 * "anything internal" would turn every tab strip into a black hole, and the
 * failure would be silent (the room's overlay would simply never light).
 *
 * Accepts an array or a DOMStringList — both are index-addressable with `.length`.
 */
export function isDockDrag(types: readonly string[] | DOMStringList | null | undefined): boolean {
  if (!types) return false;
  const n = (types as { length?: number }).length ?? 0;
  for (let i = 0; i < n; i += 1) {
    const v = (types as unknown as Record<number, unknown>)[i];
    if (typeof v === 'string' && v.toLowerCase() === DOCK_DND_TYPE) return true;
  }
  return false;
}

// ── geometry ────────────────────────────────────────────────────────────────

/** The only part of a tab rect the geometry needs. Keeps this DOM-free. */
export interface DockTabRect {
  left: number;
  width: number;
}

/**
 * Insertion index from the pointer and the strip's tab rects: the number of tabs
 * whose MIDPOINT is left of the pointer. Result is 0..rects.length, where
 * `rects.length` means "after the last tab".
 *
 * LTR only — the app ships en/ru. A future RTL locale flips the comparison.
 */
export function insertionIndexAt(rects: readonly DockTabRect[], clientX: number): number {
  let i = 0;
  for (const r of rects) if (r.left + r.width / 2 < clientX) i += 1;
  return i;
}

/**
 * Which tab element carries the insertion marker for an index, and on which side.
 * Index `count` (append) renders as `after` on the last tab, so a strip needs only
 * one marked element for every position. Empty strip → nothing to mark.
 */
export function markerTargetFor(
  index: number,
  count: number,
): { tabIndex: number; side: 'before' | 'after' } | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  const i = Math.max(0, Math.min(Math.trunc(index), count));
  return i >= count ? { tabIndex: count - 1, side: 'after' } : { tabIndex: i, side: 'before' };
}

// ── drop legality ───────────────────────────────────────────────────────────

export type DockDropKind =
  /** The panel comes from another zone. */
  | 'move'
  /** The panel is already here and changes position. */
  | 'reorder'
  /** Dropped where it already is — the caller must do NOTHING. */
  | 'noop';

export interface DockDropContext {
  /** The zone this drop target represents. */
  zone: string;
  /** The realm this drop target is rendered in. A foreign payload is refused. */
  win: string;
  /** Panel ids currently in this zone, in tab order. */
  panels: readonly string[];
  /** Insertion index from pointer geometry; `null` = append (a zone-body drop). */
  index: number | null;
}

export interface DockDropPlan {
  kind: DockDropKind;
  panel: string;
  /** Source zone as claimed by the payload (informational for the caller). */
  from: string;
  to: string;
  /** Destination index, or `null` to append. Meaningless when kind is 'noop'. */
  index: number | null;
}

/**
 * The whole "is this drop legal, and what does it mean" decision, pure.
 *
 * Returns null when the drop must be IGNORED: an unreadable payload, or a payload
 * stamped with a different realm (cross-window tab drag is impossible, so such a
 * payload can only be stale or forged — it is refused rather than acted on).
 *
 * Membership beats the payload's `zone`: if the dragged panel is actually listed in
 * this zone, the drop is a reorder even when a stale payload says otherwise.
 *
 * The reorder arithmetic is the subtle part. `index` is an insertion point in the
 * list INCLUDING the dragged tab, so landing on either side of the tab's own slot
 * (`pos` or `pos + 1`) leaves the order unchanged — that is the 'noop', and it is
 * why the strip can accept every drop and resolve it here instead of refusing some
 * of them with `dropEffect = 'none'` (which suppresses the `drop` event in Chromium
 * and would split teardown across two code paths).
 */
export function resolveDockDrop(
  payload: DockDragPayload | null,
  ctx: DockDropContext,
): DockDropPlan | null {
  if (!payload) return null;
  if (payload.win !== ctx.win) return null;

  const count = ctx.panels.length;
  const raw = ctx.index === null ? count : Math.max(0, Math.min(Math.trunc(ctx.index), count));
  const pos = ctx.panels.indexOf(payload.panel);
  const base = { panel: payload.panel, from: payload.zone, to: ctx.zone };

  // Not in this zone: a cross-zone move. `null` is preserved so the model appends.
  if (pos < 0) return { ...base, kind: 'move', index: ctx.index === null ? null : raw };

  // Already here: a reorder, resolved against the tab's own slot.
  if (raw === pos || raw === pos + 1) return { ...base, kind: 'noop', index: pos };
  return { ...base, kind: 'reorder', index: raw > pos ? raw - 1 : raw };
}

// ── imperative feedback (no React state — invariant C) ──────────────────────

/**
 * Write an attribute only when it actually changes. `dragover` fires continuously
 * even when the pointer has not moved between tabs, so an unconditional write would
 * dirty the style system ~60 times a second for nothing.
 */
export function setAttrIfChanged(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

export interface DockDragSession {
  readonly panel: string;
  readonly from: string;
  readonly win: string;
  /**
   * Bumped once per drag. Strips key their cached tab rects on it, so a drag
   * measures each strip once instead of once per pointer move.
   */
  readonly seq: number;
  /**
   * The `dragstart` point in SCREEN coordinates, as the source frame reports them.
   *
   * Only ever compared against another point from the SAME frame (see
   * dockTearOff's distance test), and never handed to Electron: `screenX` is CSS
   * pixels, and this app ships a UI-scale setting wired to `webFrame.setZoomFactor`,
   * so CSS px is not DIP whenever the user has scaled the UI — and a strip inside a
   * torn-off window is a different frame with its own zoom. A difference of two
   * points from one frame is consistent under any zoom; an absolute coordinate
   * crossing into the main process is not.
   */
  readonly startX: number;
  readonly startY: number;
}

/**
 * What the SOURCE observed while the drag was in flight. Separate from the session
 * because it is rewritten continuously and the session is not — and because the two
 * have different lifetimes conceptually: the session is "what is being dragged", this
 * is "what the platform told us about the pointer".
 */
export interface DockDragTracking {
  /**
   * The last usable point seen on a source `drag` event. `dragend` is documented to
   * report screenX/screenY of 0,0 on some outside drops in Chromium, so the tear-off
   * planner falls back to this.
   */
  readonly lastX: number;
  readonly lastY: number;
  /** False until any `drag` event reported a usable point. */
  readonly moved: boolean;
  /**
   * True once ANY drag event of this drag reported a pressed button — platform
   * calibration, not an assumption. Chromium is not contractually obliged to
   * populate `buttons` on drag events, so the tear-off planner only applies the
   * "button must be released" test when this drag proved the platform reports it.
   */
  readonly sawButtonsDown: boolean;
}

/** Everything a `dragend` handler needs to decide what the drag MEANT. */
export type DockDragSnapshot = DockDragSession & DockDragTracking;

let session: DockDragSession | null = null;
let tracking: DockDragTracking = { lastX: 0, lastY: 0, moved: false, sawButtonsDown: false };
let seq = 0;

/**
 * Is this screen point worth believing?
 *
 * Chromium reports 0,0 for `dragend` (and occasionally for `drag`) when the pointer
 * is outside the window — the exact situation a tear-off cares about. Treating that
 * as a real coordinate would both invent a huge drag distance and place a window in
 * the top-left corner of the primary display, so a 0,0 reading is discarded instead.
 *
 * The cost is that a release at the literal screen origin refuses to tear off. That
 * is the right direction to fail: the menu path still works, and no window appears
 * where the user did not point.
 */
export function isUsableDragPoint(x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return !(x === 0 && y === 0);
}

// Exactly one live element per attribute — that is the "single writer" rule that
// removes the need for dragleave bookkeeping.
let draggingTabEl: Element | null = null;
let overStripEl: Element | null = null;
let insertEl: Element | null = null;

/**
 * Start a drag. Returns the session so the caller can read its `seq`.
 *
 * The start point is REQUIRED rather than optional: it is the origin of the
 * tear-off distance test, and a caller that forgot it would get a gesture that is
 * either silently dead or measured from nowhere. A type error is the loud version
 * of both.
 */
export function beginDockDrag(
  s: { panel: string; from: string; win: string; startX: number; startY: number },
): DockDragSession {
  endDockDrag();
  seq += 1;
  session = { panel: s.panel, from: s.from, win: s.win, seq, startX: s.startX, startY: s.startY };
  tracking = { lastX: s.startX, lastY: s.startY, moved: false, sawButtonsDown: false };
  return session;
}

/** The drag in flight, or null. Reading this NEVER triggers a render. */
export function currentDockDrag(): DockDragSession | null {
  return session;
}

/**
 * Record where the pointer is and whether a button is down. Called from the SOURCE
 * element's `drag` event, which fires while the drag is in flight.
 *
 * Invariant C: this writes two numbers and two booleans into a module record. No
 * React state, no attribute writes, no layout reads — `drag` fires at roughly the
 * same rate as `dragover`, and this runs in addition to it.
 *
 * A no-op with no drag in flight, so a stray event after teardown cannot resurrect
 * tracking for a drag that has already been decided.
 */
export function noteDockDragPoint(x: number, y: number, buttons: number): void {
  if (!session) return;
  const down = Number.isFinite(buttons) && (buttons & 1) !== 0;
  const usable = isUsableDragPoint(x, y);
  if (!usable && !down) return;
  tracking = {
    lastX: usable ? x : tracking.lastX,
    lastY: usable ? y : tracking.lastY,
    moved: tracking.moved || usable,
    sawButtonsDown: tracking.sawButtonsDown || down,
  };
}

/**
 * The whole drag as one value, or null when there is no drag in flight.
 *
 * ORDERING INVARIANT — a `dragend` handler MUST read this BEFORE calling
 * `endDockDrag()`, which is the reverse of the obvious teardown-first shape.
 *
 * That ordering is what makes "did one of our drop targets take this?" free: `drop`
 * fires before `dragend`, and every accepted drop path (the strip's `onStripDrop`,
 * the zone body's native `onDrop`) already calls `endDockDrag()` itself. So a null
 * session at `dragend` MEANS a target consumed the drop — including a drop back on
 * the origin strip that resolved to 'noop', which is exactly the cancelled-gesture
 * case a tear-off must not fire on. No new bookkeeping, no second flag that could
 * disagree with the session.
 */
export function dockDragSnapshot(): DockDragSnapshot | null {
  return session ? { ...session, ...tracking } : null;
}

/** Dim the source tab. Single writer: the previous one is cleared. */
export function setDockDragTab(el: Element | null): void {
  if (draggingTabEl === el) return;
  if (draggingTabEl) setAttrIfChanged(draggingTabEl, 'data-dock-dragging', null);
  draggingTabEl = el;
  if (el) setAttrIfChanged(el, 'data-dock-dragging', '');
}

/**
 * Wash the hovered drop target. ONE element at a time across every zone and every
 * window, which is what makes this immune to dragenter/dragleave ordering: the
 * pointer crossing from one strip to another (or from a strip down onto a zone
 * body) clears the previous one as a side effect of marking the new one, so no
 * depth counting and no leave handler are needed anywhere.
 *
 * `value` distinguishes the kinds of target for CSS (the strip writes '', a zone
 * body writes 'zone'); both are selected by attribute PRESENCE, so a rule can
 * match either or discriminate.
 */
export function setDockDragOver(el: Element | null, value = ''): void {
  if (overStripEl === el) {
    if (el) setAttrIfChanged(el, 'data-dock-over', value);
    return;
  }
  if (overStripEl) setAttrIfChanged(overStripEl, 'data-dock-over', null);
  overStripEl = el;
  if (el) setAttrIfChanged(el, 'data-dock-over', value);
}

/** Place the one insertion rule. Passing null clears it. */
export function setDockInsertMarker(el: Element | null, side: 'before' | 'after' | null): void {
  if (insertEl && insertEl !== el) setAttrIfChanged(insertEl, 'data-dock-insert', null);
  insertEl = side === null ? null : el;
  if (insertEl) setAttrIfChanged(insertEl, 'data-dock-insert', side as string);
  else if (el) setAttrIfChanged(el, 'data-dock-insert', null);
}

/**
 * End the drag and clear every mark. IDEMPOTENT, and called from both `dragend`
 * and `drop` — a cancelled drag (Esc, drop outside the window) only ever fires
 * `dragend`, and a completed drop fires both.
 *
 * Nulling `session` is load-bearing beyond cleanup: it is the record that a drop
 * target consumed this drag (see `dockDragSnapshot`). A `dragend` handler that
 * wants to know what the drag meant must snapshot first.
 */
export function endDockDrag(): void {
  setDockInsertMarker(null, null);
  setDockDragOver(null);
  setDockDragTab(null);
  session = null;
  tracking = { lastX: 0, lastY: 0, moved: false, sawButtonsDown: false };
}

/**
 * Build the drag image. NOT optional polish: with no `setDragImage`, Chromium
 * snapshots the source element, which inside the rail's `overflow: hidden` frame at
 * the 180px minimum is a clipped, ellipsized sliver.
 *
 * `doc.body` is the ONLY correct parent. `.dock-zone` and `.popout-root` both set
 * `container-type: inline-size`, which makes them containing blocks for
 * `position: fixed` descendants — a ghost appended inside one would be positioned
 * against THAT box, landing on screen and getting clipped, which yields a blank or
 * half-empty bitmap. The body is a sibling of `.popout-root`, never a descendant of
 * a container-typed element, and resolving `doc` from the tab (rather than the
 * module-scope `document`) is what makes a strip in a torn-off window build its
 * ghost in its OWN window.
 *
 * The clone must be RENDERED at snapshot time — `display:none`/`visibility:hidden`
 * produce an empty drag image — hence off-screen positioning, done in CSS
 * (`.dock-drag-ghost`). Identity attributes are stripped so the clone cannot
 * duplicate a DOM id or expose a second `role="tab"` to assistive tech.
 */
export function buildDockDragGhost(el: HTMLElement, doc: Document): HTMLElement | null {
  try {
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.removeAttribute('id');
    ghost.removeAttribute('role');
    ghost.removeAttribute('aria-selected');
    ghost.removeAttribute('aria-controls');
    ghost.removeAttribute('aria-haspopup');
    ghost.removeAttribute('data-dock-tab');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.tabIndex = -1;
    ghost.className = 'dock-tab dock-drag-ghost';
    const r = el.getBoundingClientRect();
    // The body is not the strip: without explicit sizing the clone would reflow to
    // its content width and the bitmap would not match what the user grabbed.
    ghost.style.width = `${Math.round(r.width)}px`;
    ghost.style.height = `${Math.round(r.height)}px`;
    doc.body.appendChild(ghost);
    return ghost;
  } catch {
    return null; // a missing body (a window mid-close) must not break the drag
  }
}
