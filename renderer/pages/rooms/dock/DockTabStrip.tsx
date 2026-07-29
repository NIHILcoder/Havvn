/**
 * DockTabStrip — the tab bar of a dock zone (P1 of the rooms docking work, plus
 * P3's drag source, drop target and "Move to" menu).
 *
 * WHY NOT components/Tabs.tsx: that one is a 33-line stateless button row with
 * no ARIA roles, no roving tabindex and no keyboard handling — every button is a
 * tab stop, and a screen reader hears three unrelated buttons instead of a tab
 * set. It is also consumed by the Stage (RoomsPage.tsx) and re-exported from
 * components/index.ts, so growing it would ripple. This is a sibling, with its
 * own `dock-tab*` class prefix so the `.room-col-stage .tab-button` compaction
 * rules can never leak in either direction.
 *
 * ACCESSIBILITY (WAI-ARIA tabs pattern, automatic activation):
 *   - role="tablist" on the strip (named via `ariaLabel`), role="tab" on each
 *     button, aria-selected on all of them, aria-controls pointing at the panel
 *     DockZone renders with the matching id (see dockTabDomId/dockPanelDomId).
 *   - Roving tabindex: exactly ONE tab is in the page tab order (the selected
 *     one); the rest are tabIndex={-1} and reachable only by arrow keys. So Tab
 *     moves into the strip and then straight on into the panel body.
 *   - ArrowLeft/ArrowRight wrap and move focus AND selection; Home/End jump to
 *     the ends; Ctrl+PageUp/Ctrl+PageDown cycle. All key math lives in the pure
 *     `nextDockTabIndex` reducer below so it can be unit-tested without a DOM
 *     (the renderer test setup is renderToStaticMarkup — there is no jsdom).
 *
 * NARROW-RAIL BEHAVIOUR — decided, not accidental: the rail clamps to 180px
 * (RAIL_MIN), which leaves ~148px of content box; three natural-width tabs need
 * more than that. The strip COMPRESSES rather than scrolls (a scroller would
 * hide tabs behind a gesture and force scroll-into-view bookkeeping for keyboard
 * focus, for a zone that holds three fixed panels). Each tab is `flex: 1 1 auto`
 * with `min-width: 0`; the icon and the badge never shrink, the label truncates
 * with an ellipsis, and `title` carries the full text. CSS truncation does not
 * change the accessible name, so assistive tech still hears the whole label.
 *
 * ── P3: MOVING A PANEL ───────────────────────────────────────────────────────
 * Everything below is behind the optional `dock` prop. ABSENT = exactly the P1
 * strip: no draggable, no handlers, no menu, no extra markup. That is the shape of
 * the contract on purpose — a caller that has not wired the model yet cannot get a
 * half-working drag.
 *
 * TWO PATHS, and the menu is the primary one:
 *   1. DRAG a tab into another zone's strip. Positional: the drop index comes from
 *      the pointer against the tab midpoints, so reorder-within-zone and
 *      move-across-zones are the same gesture.
 *   2. The per-tab "Move to" MENU — right-click, Shift+F10 / the ContextMenu key on
 *      the focused tab, or the decorative ⋮ hint. This is the accessible path, and
 *      for a panel in a torn-off window it is the ONLY path: an HTML5 drag cannot
 *      cross an Electron BrowserWindow boundary, so dragging back is not merely
 *      unpolished, it is impossible.
 *   3. DRAG A TAB OUT of the app entirely and let go — the browser gesture, wired
 *      through the optional `onTearOut`. It is an addition, not a replacement: the
 *      menu keeps every route it had, remains the accessible one, and remains the
 *      ONLY one that can bring a panel back across a window boundary. The decision
 *      is made at `dragend` from data (see dockTearOff.ts) and handed to the owner
 *      as a PROPOSAL, because "was that release inside one of our own windows?" is a
 *      question only the main process can answer honestly.
 *
 * PERFORMANCE (invariant C) — during a drag this component performs ZERO state
 * updates. Not throttled, not batched: zero. The room re-renders on every gossip
 * push, and a `setState` per `dragover` (~60Hz) would stack on top of that. Hover,
 * the insertion marker and the source-tab dimming are DOM attributes written by
 * dockDrag.ts and read by CSS; the drag session is a module variable. The only
 * state here is `menu` (once per menu open) — an interaction, not a pointer move.
 *
 * NOT TRIPPING THE ROOM'S FILE-DROP OVERLAY (invariant D), three belts:
 *   1. TYPE. RoomsPage's `isFileDrag` requires `types.includes('Files')`, which
 *      only the OS sets — a tab drag can never satisfy it. This is the belt that
 *      actually holds, and it needs no code here.
 *   2. `.room-detail-inner`'s onDragStartCapture already sets `internalDrag` for
 *      any dragstart in the room's REACT tree (synthetic events propagate along the
 *      React tree, so this covers a strip portalled into a child window too).
 *      Deliberately NOT stopped here: a capture-phase handler cannot be stopped
 *      from a bubble handler anyway, and its effect is wanted.
 *   3. stopPropagation on our own ACCEPTED dragover/drop, exactly as the room's
 *      section drop targets do. The room's `onDropCapture` reset still runs — it is
 *      capture-phase, which precedes our stop.
 *   The reverse hazard is guarded by the same single check: the strip only ever
 *   preventDefaults a drag carrying DOCK_DND_TYPE, so 'Files' and 'text/havvn-fileid'
 *   fall straight through and the strip never swallows a file drop meant for the room.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHostWindow, resolveHostWindow, portalTargetFor } from '../../../utils/hostWindow';
import { useAnnounce } from '../../../utils/liveAnnouncer';
import { DockTabMenu } from './DockTabMenu';
import type { DockMenuItem } from './DockTabMenu';
import {
  DOCK_DND_TYPE,
  DOCK_MAIN_WINDOW_KEY,
  beginDockDrag,
  buildDockDragGhost,
  currentDockDrag,
  dockDragSnapshot,
  encodeDockDrag,
  endDockDrag,
  insertionIndexAt,
  isDockDrag,
  markerTargetFor,
  noteDockDragPoint,
  parseDockDragPayload,
  resolveDockDrop,
  setDockDragTab,
  setDockInsertMarker,
  setDockDragOver,
} from './dockDrag';
import type { DockTabRect } from './dockDrag';
import { planDockTearOff } from './dockTearOff';
import './DockTabStrip.css';

export interface DockTabItem {
  id: string;
  /** Already-translated, user-visible label. Truncates at narrow rail widths. */
  label: string;
  icon?: React.ReactNode;
  /** Compact affix (a count, a live dot). Never shrinks; joins the tab's name. */
  badge?: React.ReactNode;
  /** Native tooltip; defaults to `label` since the label can be truncated. */
  title?: string;
}

/** One destination in the "Move to" group. The CURRENT zone is listed too. */
export interface DockTabMoveTarget {
  /** Destination zone id, handed straight back to `onMovePanel`. */
  zone: string;
  /** Already-translated zone name. */
  label: string;
  /**
   * Non-null ⇒ listed but refused, and this string says why (it becomes the
   * item's tooltip and description). A refusal must be visible with its reason —
   * a disabled item with no explanation is the silent no-op this design forbids.
   */
  refusal?: string | null;
  /** True for the zone the panel is in right now: marked and refused. */
  current?: boolean;
}

/** An action below the group — "Open in new window", "Dock back". */
export interface DockTabAction {
  key: string;
  /** Already-translated. */
  label: string;
  onSelect: () => void;
  /** Non-null ⇒ listed but refused, with the reason (pool exhausted, last group). */
  refusal?: string | null;
}

/**
 * Everything the strip needs to MOVE a panel. Optional as a whole: absent means
 * the P1 strip (selection only).
 */
export interface DockStripInteractions {
  /** The zone this strip belongs to — the drag payload's source and destination. */
  zoneId: string;
  /**
   * Which OS window this strip is rendered in: 'main', or the dock window's frame
   * name. It is stamped onto the payload and re-checked on drop, so a payload
   * claiming a different realm is refused rather than acted on.
   */
  windowKey?: string;
  /** The "Move to" group for one tab. Include the CURRENT zone, marked. */
  moveTargets: (panelId: string) => readonly DockTabMoveTarget[];
  /** Items under the group. */
  actions?: (panelId: string) => readonly DockTabAction[];
  /**
   * THE commit — called once per drop and once per menu pick, never during a drag.
   * `toIndex` is an insertion index in the destination's tab order, or null to
   * append. A drop that resolves to a no-op does not call this at all.
   */
  onMovePanel: (panelId: string, toZone: string, toIndex: number | null) => void;
  /**
   * What to SAY when that move lands, ALREADY TRANSLATED (e.g. "Chat moved to
   * Centre column"). Return null to say nothing.
   *
   * A move is a purely visual change: the panel is gone from one column and present
   * in another, and a screen reader is told nothing beyond whatever the focus move
   * happens to announce. `useDockMove` delivers this through the realm-routed
   * announcer, so the message is spoken in the window the gesture happened in — a
   * region in the main tree says nothing to a reader working on the second monitor.
   */
  announceMove?: (panelId: string, toZone: string) => string | null;
  /** Already-translated menu chrome. The strip never calls t(). */
  labels: {
    /** The group header, e.g. "Move to". */
    moveTo: string;
    /** Accessible name for the menu, e.g. "Panel actions". */
    tabMenu: string;
  };
  /**
   * PROPOSED tear-off: the user dragged this tab out and released it with no drop
   * target of ours taking it. Optional — absent means the strip keeps today's
   * behaviour and a drag that lands nowhere simply snaps back.
   *
   * It is a proposal, not a commit, and the split is deliberate. This folder decides
   * everything decidable from the drag itself (see dockTearOff.ts: a live session, a
   * refused drop, a released button, a distance ≥ 64px). What it CANNOT decide is
   * whether the release landed inside one of the app's own windows — over the room's
   * head bar, another dock window, a pop-out this tree never opened. `screenX` is CSS
   * pixels and the app scales its UI through `webFrame.setZoomFactor`, so a renderer
   * coordinate is not DIP and cannot be tested against window bounds; and a renderer
   * cannot enumerate windows it did not open. THE OWNER must make that check (a
   * main-process cursor-vs-windows probe) before committing the model op.
   *
   * `at` is the release point in the SOURCE frame's screen coordinates — enough to
   * know which way the user pulled, but not a value to hand to Electron as a window
   * position for the same CSS-px reason. The window's actual rect is main's job; the
   * arithmetic is `dockTearOffWindowBounds` in dockTearOff.ts.
   *
   * Called at most ONCE per drag, and never during one.
   */
  onTearOut?: (panelId: string, at: { screenX: number; screenY: number }) => void;
  /**
   * Focus this tab once it lands in this strip — the owner sets it to the panel it
   * just moved. Without it, focus falls to <body> after every move and the keyboard
   * path (the one that must work) is unusable in practice. Set it back to null
   * between moves so the same panel moving twice focuses twice.
   */
  focusPanelId?: string | null;
}

export interface DockTabStripProps {
  tabs: DockTabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Accessible name for the tablist (a translated string from the caller). */
  ariaLabel?: string;
  /** Namespaces the generated DOM ids so several zones can coexist. */
  idPrefix?: string;
  className?: string;
  /** P3 drag + menu wiring. Absent ⇒ P1 behaviour (selection only). */
  dock?: DockStripInteractions;
}

/** DOM id of a tab button — DockZone pairs panels to tabs through these. */
export const dockTabDomId = (prefix: string, tabId: string): string => `${prefix}-tab-${tabId}`;
/** DOM id of the panel a tab controls; must be set on the rendered panel. */
export const dockPanelDomId = (prefix: string, tabId: string): string => `${prefix}-panel-${tabId}`;

/** The subset of a KeyboardEvent the reducer reads (so tests need no DOM). */
export interface DockTabKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Pure keyboard reducer: which tab index should become focused+selected.
 * Returns null when the key is not ours — the caller must then NOT
 * preventDefault, or it would eat the browser's own shortcuts.
 *
 * `current` may be out of range (nothing selected yet): "previous" then means
 * the last tab and "next" the first, instead of a modulo on a bogus index.
 */
export function nextDockTabIndex(
  ev: DockTabKeyEvent,
  current: number,
  count: number,
): number | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  const inRange = Number.isInteger(current) && current >= 0 && current < count;
  const prev = () => (inRange ? (current - 1 + count) % count : count - 1);
  const next = () => (inRange ? (current + 1) % count : 0);
  // Arrows/Home/End must stay plain: Ctrl+Arrow, Alt+Arrow and Shift+Home all
  // mean something else to the OS, the app or a text field.
  const plain = !ev.altKey && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey;
  const cycler = (ev.ctrlKey === true || ev.metaKey === true) && ev.altKey !== true;

  switch (ev.key) {
    case 'ArrowLeft': return plain ? prev() : null;
    case 'ArrowRight': return plain ? next() : null;
    case 'Home': return plain ? 0 : null;
    case 'End': return plain ? count - 1 : null;
    case 'PageUp': return cycler ? prev() : null;
    case 'PageDown': return cycler ? next() : null;
    default: return null;
  }
}

/**
 * The CYCLER half of the ladder — Ctrl/Cmd+PageUp/PageDown only, never arrows.
 *
 * The zone root attaches this, because the tab strip is a SIBLING of the panels,
 * not their ancestor: a handler on the tablist alone only fires while a tab button
 * has focus, which defeats the whole point of a cycle shortcut (you use it while
 * working INSIDE a panel). Arrows deliberately stay strip-only — inside a panel
 * they belong to lists, text fields and sliders.
 */
export function dockCycleIndex(ev: DockTabKeyEvent, current: number, count: number): number | null {
  if (ev.key !== 'PageUp' && ev.key !== 'PageDown') return null;
  // A zone with ONE panel has nothing to cycle to. Without this it would still
  // return 0 — `(0 ± 1) % 1 === 0` — and the zone would preventDefault +
  // stopPropagation for a no-op, swallowing Ctrl/Cmd+PageUp/PageDown inside the
  // files list and the chat composer (where it did nothing before the dock) and
  // blocking any future app-level binding. `nextDockTabIndex` already declines
  // `count <= 0`, so this only adds the one-panel case.
  if (!Number.isInteger(count) || count <= 1) return null;
  return nextDockTabIndex(ev, current, count);
}

/**
 * Pure: a cheap signature of everything in `tabs` that can change a tab's WIDTH.
 * The per-drag rect cache is keyed on it, so a gossip push that flips People from
 * `9/10` to `10/10` (or makes LAN's badge appear) re-measures instead of serving
 * midpoints from the previous layout.
 *
 * A non-primitive badge collapses to a single `#`: an element badge is a fixed-size
 * dot in practice, and stringifying React nodes on the drag path would cost more
 * than the re-measure it saves. Labels are included because a re-render can change
 * them too (a room rename, a language switch mid-drag).
 */
export function dockTabSignature(tabs: readonly DockTabItem[]): string {
  return tabs
    .map((t) => {
      const b = t.badge;
      const text = b === null || b === undefined || b === false
        ? ''
        : (typeof b === 'string' || typeof b === 'number') ? String(b) : '#';
      return `${t.id} ${t.label} ${text}`;
    })
    .join('');
}

/**
 * THE one way to commit a move from anywhere in this folder: commit, then announce
 * in the caller's OWN window.
 *
 * Every path — a drop on a strip, a drop on a zone body, a "Move to ▸" pick, a solo
 * handle's menu — goes through this, so a move can never land silently for a screen
 * reader in one place and be announced in another. `useAnnounce` reads its realm
 * from `useHostWindow()` at CALL time, which for a strip inside a torn-off window
 * (or for a zone in one) is that window.
 *
 * Returns a stable callback so it is safe in a dependency array, and it is a no-op
 * without `dock` — the P1 zone has no move to commit.
 */
export function useDockMove(
  dock?: DockStripInteractions,
): (panelId: string, toZone: string, toIndex: number | null) => void {
  const announce = useAnnounce();
  return useCallback((panelId: string, toZone: string, toIndex: number | null) => {
    if (!dock) return;
    dock.onMovePanel(panelId, toZone, toIndex);
    const said = dock.announceMove?.(panelId, toZone);
    if (said) announce(said);
  }, [dock, announce]);
}

/**
 * Pure: the "Move to ▸" menu's contents for one panel, built from the interaction
 * surface. Shared by the tab menu and by `DockSoloHandle` (the affordance a
 * strip-less solo zone gets instead), so the two can never offer different moves.
 *
 * `onMove` defaults to `dock.onMovePanel`, but every component in this folder hands
 * it `useDockMove(dock)` so the menu path announces exactly like the drag path.
 *
 * The panel's CURRENT zone is LISTED, marked and disabled rather than omitted: a
 * stable menu shape needs no branching for the one-zone case (single-column mode,
 * or inside a torn-off window), and it tells the user where the panel is instead of
 * making the feature look absent.
 *
 * A menu move APPENDS — there is no pointer, so there is no meaningful insertion
 * index to infer. The destination makes it active either way.
 */
export function buildDockMenuItems(
  dock: DockStripInteractions,
  panel: string,
  onMove: (panelId: string, toZone: string, toIndex: number | null) => void = dock.onMovePanel,
): { targets: DockMenuItem[]; actions: DockMenuItem[] } {
  const targets: DockMenuItem[] = dock.moveTargets(panel).map((t) => ({
    key: t.zone,
    label: t.label,
    checked: t.current,
    disabled: t.current === true,
    refusal: t.refusal ?? null,
    onSelect: () => onMove(panel, t.zone, null),
  }));
  const actions: DockMenuItem[] = (dock.actions?.(panel) ?? []).map((a) => ({
    key: a.key,
    label: a.label,
    refusal: a.refusal ?? null,
    onSelect: a.onSelect,
  }));
  return { targets, actions };
}

/**
 * Pure: does this key open the tab menu? Shift+F10 is the WAI-ARIA-conformant
 * keyboard equivalent of a right-click, and the ContextMenu key is the dedicated
 * one; both are checked here so the strip's onKeyDown stays a lookup.
 * Deliberately disjoint from `nextDockTabIndex`, which owns arrows/Home/End/PageUp.
 */
export function isDockMenuKey(ev: DockTabKeyEvent): boolean {
  if (ev.key === 'ContextMenu') return true;
  return ev.key === 'F10' && ev.shiftKey === true && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
}

interface DockTabButtonProps {
  tab: DockTabItem;
  selected: boolean;
  tabDomId: string;
  panelDomId: string;
  onSelect: (id: string) => void;
  /** P3: present ⇒ the tab is a drag source and carries the ⋮ menu hint. */
  draggable?: boolean;
  onTabDragStart?: (e: React.DragEvent<HTMLButtonElement>, id: string) => void;
  /**
   * `drag` on the SOURCE — the only event that keeps reporting the pointer once the
   * OS drag loop has taken over. It feeds the tear-off's fallback point and the
   * platform's button-reporting calibration; it writes no React state.
   */
  onTabDrag?: (e: React.DragEvent<HTMLButtonElement>) => void;
  onTabDragEnd?: (e: React.DragEvent<HTMLButtonElement>) => void;
  /** Opens the "Move to" menu at a point in the tab's own window. */
  onOpenMenu?: (id: string, x: number, y: number) => void;
  /** Marks the tab while its menu is open (CSS keeps the ⋮ hint visible). */
  menuOpen?: boolean;
}

/**
 * One tab. Kept a standalone forwardRef component so the strip can hand its DOM
 * node to the drag source (which needs it for the ghost and for measuring) without
 * touching the a11y wiring.
 *
 * The ⋮ hint is a decorative `<span aria-hidden>`, NOT a button: a `<button>` inside
 * `role="tab"` is nested-interactive (invalid) and would add a second tab stop per
 * tab, breaking the roving tabindex above. Its click is routed through the tab's own
 * onClick via `closest('.dock-tab-menu-hint')` — the same dispatch trick the room's
 * file rows already use.
 */
export const DockTabButton = React.forwardRef<HTMLButtonElement, DockTabButtonProps>(
  ({
    tab, selected, tabDomId, panelDomId, onSelect,
    draggable, onTabDragStart, onTabDrag, onTabDragEnd, onOpenMenu, menuOpen,
  }, ref) => (
    <button
      ref={ref}
      type="button"
      role="tab"
      id={tabDomId}
      data-dock-tab={tab.id}
      aria-selected={selected}
      aria-controls={panelDomId}
      // Announces the "Move to" menu without adding a focus stop. The visible ⋮ is
      // aria-hidden, so this is the only thing that tells a screen reader it exists.
      aria-haspopup={onOpenMenu ? 'menu' : undefined}
      data-menu-open={menuOpen ? '' : undefined}
      tabIndex={selected ? 0 : -1}
      className={`dock-tab${selected ? ' selected' : ''}`}
      title={tab.title ?? tab.label}
      draggable={draggable || undefined}
      onDragStart={onTabDragStart ? (e) => onTabDragStart(e, tab.id) : undefined}
      onDrag={onTabDrag}
      onDragEnd={onTabDragEnd}
      onContextMenu={onOpenMenu ? (e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenMenu(tab.id, e.clientX, e.clientY);
      } : undefined}
      onClick={(e) => {
        // The ⋮ hint lives inside the button; a click on it opens the menu instead
        // of selecting, anchored to the hint so the menu lands under the glyph.
        const hint = onOpenMenu
          ? (e.target as HTMLElement).closest?.('.dock-tab-menu-hint') as HTMLElement | null
          : null;
        if (hint && onOpenMenu) {
          e.preventDefault();
          e.stopPropagation();
          const r = hint.getBoundingClientRect();
          onOpenMenu(tab.id, r.left, r.bottom + 2);
          return;
        }
        if (!selected) onSelect(tab.id);
      }}
    >
      {tab.icon !== undefined && tab.icon !== null && (
        <span className="dock-tab-icon" aria-hidden="true">{tab.icon}</span>
      )}
      <span className="dock-tab-label">{tab.label}</span>
      {tab.badge !== undefined && tab.badge !== null && (
        <span className="dock-tab-badge">{tab.badge}</span>
      )}
      {onOpenMenu && <span className="dock-tab-menu-hint" aria-hidden="true">⋮</span>}
    </button>
  ),
);
DockTabButton.displayName = 'DockTabButton';

export const DockTabStrip: React.FC<DockTabStripProps> = ({
  tabs,
  activeId,
  onSelect,
  ariaLabel,
  idPrefix = 'dock',
  className,
  dock,
}) => {
  // Keyed by tab id, not index: the map survives a panel being added or moved
  // between zones.
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const stripRef = useRef<HTMLDivElement>(null);
  const host = useHostWindow();
  // Commit + announce, in this strip's own window. Every move path uses it.
  const move = useDockMove(dock);
  const activeIndex = tabs.findIndex((t) => t.id === activeId);
  const windowKey = dock?.windowKey ?? DOCK_MAIN_WINDOW_KEY;

  // The ONLY state in this component. Opening a menu is an interaction (once), not
  // a pointer move (~60Hz) — see the performance note in the file header.
  const [menu, setMenu] = useState<{ panel: string; x: number; y: number } | null>(null);

  // Mirrored in a ref so closeMenu can stay identity-stable (it is a dependency of
  // the menu's own effects) and so the focus restore below is not a side effect
  // inside a state updater, which StrictMode is free to run twice.
  const openPanelRef = useRef<string | null>(null);
  const openMenu = useCallback((panel: string, x: number, y: number) => {
    openPanelRef.current = panel;
    setMenu({ panel, x, y });
  }, []);
  const closeMenu = useCallback(() => {
    const panel = openPanelRef.current;
    openPanelRef.current = null;
    setMenu(null);
    // Return focus to the tab the menu belongs to: a menu that closes onto <body>
    // strands a keyboard user exactly as a move without focus would. Skipped when
    // the tab has left this strip — the destination's focusPanelId owns that case.
    const el = panel ? btnRefs.current[panel] : null;
    if (el && el.isConnected) el.focus();
  }, []);

  // Tab rects, measured once per drag per strip PER LAYOUT. `dragover` fires ~60Hz
  // and each measurement is a forced layout, so caching is not optional — but the
  // strip is NOT static during a drag: the room re-renders on every gossip push
  // (~700ms at best) and two tabs carry width-changing badges (People renders
  // `${online}/${total}`, LAN's appears and disappears). A push mid-drag re-lays
  // out the strip, and rects cached on the session seq alone would leave the
  // insertion marker pointing at one gap while `insertionIndexAt` computed another.
  // So the key is the seq AND a cheap signature of what can change the widths.
  // Each rect carries its tab id: a tab whose ref has not landed contributes no
  // rect, so rect index and `tabs` index are not interchangeable and the marker
  // must be looked up by id rather than by position.
  const rectsRef = useRef<{ key: string; rects: (DockTabRect & { id: string })[] } | null>(null);
  const tabRects = useCallback((): (DockTabRect & { id: string })[] => {
    const key = `${currentDockDrag()?.seq ?? -1}|${dockTabSignature(tabs)}`;
    const cached = rectsRef.current;
    if (cached && cached.key === key) return cached.rects;
    const rects: (DockTabRect & { id: string })[] = [];
    for (const t of tabs) {
      const el = btnRefs.current[t.id];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      rects.push({ id: t.id, left: r.left, width: r.width });
    }
    rectsRef.current = { key, rects };
    return rects;
  }, [tabs]);

  // ── drag source ───────────────────────────────────────────────────────────
  const onTabDragStart = useCallback((e: React.DragEvent<HTMLButtonElement>, id: string) => {
    if (!dock) return;
    const el = btnRefs.current[id];
    const dt = e.dataTransfer;
    // ONE type, no text/plain — see DOCK_DND_TYPE. Without that omission every
    // input in the room (and the OS) would accept a tab drag as text.
    dt.setData(DOCK_DND_TYPE, encodeDockDrag({ panel: id, zone: dock.zoneId, win: windowKey }));
    dt.effectAllowed = 'move';
    if (el) {
      const realm = resolveHostWindow(el, host);
      const ghost = buildDockDragGhost(el, realm.document);
      if (ghost) {
        const r = el.getBoundingClientRect();
        try { dt.setDragImage(ghost, e.clientX - r.left, e.clientY - r.top); } catch { /* ignore */ }
        // Next frame, not this tick: the snapshot is taken after the handler returns.
        realm.window.requestAnimationFrame(() => ghost.remove());
      }
    }
    // The start point is the origin of the tear-off distance test. Both it and the
    // point read at dragend come from THIS frame, so their difference is consistent
    // under any webFrame zoom factor.
    beginDockDrag({ panel: id, from: dock.zoneId, win: windowKey, startX: e.screenX, startY: e.screenY });
    setDockDragTab(el);
    // NOT stopped: `.room-detail-inner`'s onDragStartCapture must still set
    // internalDrag (and could not be stopped from a bubble handler anyway).
  }, [dock, host, windowKey]);

  /**
   * The source's own `drag` event — the last channel still reporting the pointer once
   * the OS drag loop owns it. Two module writes and no React state (invariant C): the
   * fallback release point (Chromium reports `dragend` at 0,0 on some outside drops)
   * and whether this platform reports `buttons` on drag events at all.
   */
  const onTabDrag = useCallback((e: React.DragEvent<HTMLButtonElement>) => {
    noteDockDragPoint(e.screenX, e.screenY, e.buttons);
  }, []);

  const onTabDragEnd = useCallback((e: React.DragEvent<HTMLButtonElement>) => {
    // ORDER MATTERS. The snapshot has to be taken BEFORE teardown: a drop that one of
    // our targets accepted already called endDockDrag() from its own `drop` handler
    // (drop fires first), so a null session here is exactly the proof that nothing
    // took this drag. Tearing down first would erase the evidence.
    const snap = dockDragSnapshot();
    // dragend ALWAYS fires in the source window — including Esc-cancel and a drop
    // outside any target — which is why teardown lives here as well as in onDrop.
    endDockDrag();
    rectsRef.current = null;
    if (!dock?.onTearOut) return;
    const plan = planDockTearOff({
      snap,
      endX: e.screenX,
      endY: e.screenY,
      dropEffect: e.dataTransfer?.dropEffect ?? 'none',
      buttons: e.buttons,
    });
    if (!plan.tear) return;
    dock.onTearOut(plan.tear.panel, { screenX: plan.tear.screenX, screenY: plan.tear.screenY });
  }, [dock]);

  // ── drop target ───────────────────────────────────────────────────────────
  const onStripDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Type-only authorization: getData() is unreadable during dragover, and this is
    // also what lets an OS file drag pass straight through to the room's overlay.
    if (!dock || !isDockDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    e.stopPropagation();
    // Explicit every time: a handler that preventDefaults without setting this
    // inherits whatever the previous one left, which is how cursors go wrong mid-drag.
    e.dataTransfer.dropEffect = 'move';
    setDockDragOver(stripRef.current);
    const rects = tabRects();
    const marker = markerTargetFor(insertionIndexAt(rects, e.clientX), rects.length);
    const el = marker ? btnRefs.current[rects[marker.tabIndex]?.id] ?? null : null;
    setDockInsertMarker(el, marker && el ? marker.side : null);
  }, [dock, tabRects]);

  const onStripDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!dock || !isDockDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    e.stopPropagation();
    // At DROP the payload is readable again, and it — not the session ref — is
    // authoritative: the ref paints, the payload records.
    const payload = parseDockDragPayload(e.dataTransfer.getData(DOCK_DND_TYPE));
    const index = insertionIndexAt(tabRects(), e.clientX);
    endDockDrag();
    rectsRef.current = null;
    const plan = resolveDockDrop(payload, {
      zone: dock.zoneId,
      win: windowKey,
      panels: tabs.map((t) => t.id),
      index,
    });
    // A drop back where it started resolves to 'noop' HERE rather than being
    // refused during the drag: dropEffect='none' would suppress the drop event
    // entirely in Chromium and split teardown across two paths.
    if (!plan || plan.kind === 'noop') return;
    move(plan.panel, plan.to, plan.index);
  }, [dock, move, tabRects, tabs, windowKey]);

  // ── keyboard ──────────────────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (dock && isDockMenuKey(e)) {
      const el = (e.target as HTMLElement).closest?.('.dock-tab') as HTMLElement | null;
      const id = el?.getAttribute('data-dock-tab');
      if (!el || !id) return;
      e.preventDefault();
      e.stopPropagation();
      // Anchored at the tab's bottom-left, the keyboard equivalent of a right-click
      // at the pointer — so the menu appears attached to the thing it acts on.
      const r = el.getBoundingClientRect();
      openMenu(id, r.left, r.bottom + 2);
      return;
    }
    const idx = nextDockTabIndex(e, activeIndex, tabs.length);
    if (idx === null) return;
    e.preventDefault();
    e.stopPropagation(); // Ctrl+PageUp/Down is a plausible app-level shortcut too
    const target = tabs[idx];
    if (target.id !== activeId) onSelect(target.id);
    // Focus even when the selection did not change (Home on the first tab):
    // the roving tabindex means focus is the only thing that moved.
    btnRefs.current[target.id]?.focus();
  };

  // ── focus after a move ────────────────────────────────────────────────────
  // The one state change a move legitimately causes, and it is once per move, not
  // per pointer. useEffect rather than useLayoutEffect: focus is a post-paint
  // concern, and useLayoutEffect warns under the DOM-less server renderer.
  const focusWant = dock?.focusPanelId ?? null;
  const focusDoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusWant === null) { focusDoneRef.current = null; return; }
    if (focusDoneRef.current === focusWant) return;
    const el = btnRefs.current[focusWant];
    if (!el) return; // the panel landed in a different strip; that strip focuses it
    focusDoneRef.current = focusWant;
    el.focus();
  }, [focusWant]);

  // ── the menu ──────────────────────────────────────────────────────────────
  const menuNode = ((): React.ReactNode => {
    if (!dock || !menu) return null;
    const { targets, actions } = buildDockMenuItems(dock, menu.panel, move);
    return (
      <DockTabMenu
        idPrefix={`${idPrefix}-menu-${menu.panel}`}
        ariaLabel={dock.labels.tabMenu}
        groupLabel={dock.labels.moveTo}
        targets={targets}
        actions={actions}
        x={menu.x}
        y={menu.y}
        onClose={closeMenu}
      />
    );
  })();

  return (
    <div
      ref={stripRef}
      className={`dock-tabstrip${className ? ` ${className}` : ''}`}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      onDragOver={dock ? onStripDragOver : undefined}
      onDrop={dock ? onStripDrop : undefined}
    >
      {tabs.map((tab) => (
        <DockTabButton
          key={tab.id}
          ref={(el) => { btnRefs.current[tab.id] = el; }}
          tab={tab}
          selected={tab.id === activeId}
          tabDomId={dockTabDomId(idPrefix, tab.id)}
          panelDomId={dockPanelDomId(idPrefix, tab.id)}
          onSelect={onSelect}
          draggable={dock ? true : undefined}
          onTabDragStart={dock ? onTabDragStart : undefined}
          onTabDrag={dock ? onTabDrag : undefined}
          onTabDragEnd={dock ? onTabDragEnd : undefined}
          onOpenMenu={dock ? openMenu : undefined}
          menuOpen={menu?.panel === tab.id}
        />
      ))}
      {/*
        Portalled to the BODY of the document the TAB lives in — an element beats
        the context, and a strip can be portalled into a window its provider knows
        nothing about. Never inside the zone: `.dock-zone` and `.popout-root` are
        container-typed, which traps position:fixed descendants in their box.
        Resolved inside the `menuNode &&` short-circuit so a closed menu never
        dereferences a body (undefined under the DOM-less test renderer).
      */}
      {menu && menuNode && createPortal(menuNode, portalTargetFor(btnRefs.current[menu.panel], host))}
    </div>
  );
};
