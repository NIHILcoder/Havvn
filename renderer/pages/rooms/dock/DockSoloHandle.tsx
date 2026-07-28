/**
 * DockSoloHandle — the move affordance a strip-less zone gets instead of a tab.
 *
 * ── Why a solo zone has no strip ─────────────────────────────────────────────
 * P3 gave every zone a tab strip, including the one-panel ones. That made the
 * DEFAULT room stop looking like the room users had: the centre column's files card
 * already draws `SHARED FILES · N` as `.room-section-title` and the right column
 * already draws the CHAT | HISTORY switcher — both 11px/700 uppercase HUD eyebrows,
 * which is exactly what `.dock-tabstrip` is styled as. A single-tab strip above
 * either is a second, near-identical row: ~26px plus a border of pure duplication
 * per column, in two of the three columns, for a user who never dragged anything.
 *
 * So a DOCKED zone holding exactly one `soloHost` panel hides its strip
 * (`DockZone.soloHostIds`) and the panel's OWN header row hosts this handle. The
 * zone keeps everything else — the slot, the drop target, the query container.
 *
 * What it must replace, exactly: the strip was a DRAG SOURCE and a MENU TRIGGER.
 * A zone body is only ever a drop TARGET, so without both of those a solo panel
 * would be movable in but never out. This provides both from one 24px control:
 *   • drag — same `DOCK_DND_TYPE` payload a tab emits, so every existing drop
 *     target (another strip, another zone body) accepts it with no changes;
 *   • menu — the same `DockTabMenu` the tab's ⋮ opens, built by the same
 *     `buildDockMenuItems`, so the two paths can never offer different moves.
 *
 * It is a real `<button>`: reachable by Tab, named by `label`, and it opens the
 * menu on click, on right-click and on Shift+F10 / the ContextMenu key. That is the
 * accessible path, and for a panel torn into a window it is the only path home
 * besides the shell's Dock back — an HTML5 drag cannot cross a BrowserWindow.
 *
 * This folder never calls `t()`: `label` arrives already translated, exactly like
 * DockZone's `ariaLabel` and the strip's menu labels.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHostWindow, resolveHostWindow, portalTargetFor } from '../../../utils/hostWindow';
import { DockTabMenu } from './DockTabMenu';
import { buildDockMenuItems, isDockMenuKey, useDockMove } from './DockTabStrip';
import type { DockStripInteractions } from './DockTabStrip';
import {
  DOCK_DND_TYPE,
  DOCK_MAIN_WINDOW_KEY,
  beginDockDrag,
  buildDockDragGhost,
  encodeDockDrag,
  endDockDrag,
  setDockDragTab,
} from './dockDrag';
import './DockSoloHandle.css';

export interface DockSoloHandleProps {
  /** The panel this handle moves — the only panel in its zone. */
  panelId: string;
  /** The same interaction surface the strip receives, from `dockInteractions`. */
  dock: DockStripInteractions;
  /** Accessible name + tooltip, ALREADY TRANSLATED (e.g. "Move panel"). */
  label: string;
  /** Extra classes for the host's header row. */
  className?: string;
}

export const DockSoloHandle: React.FC<DockSoloHandleProps> = ({
  panelId,
  dock,
  label,
  className,
}) => {
  const btnRef = useRef<HTMLButtonElement>(null);
  const host = useHostWindow();
  const windowKey = dock.windowKey ?? DOCK_MAIN_WINDOW_KEY;
  // Same commit path as a tab's menu, so a solo zone announces its moves too.
  const move = useDockMove(dock);

  // The only state here, and it changes once per menu open — never per pointer
  // move (invariant C: the room re-renders on every gossip push already).
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const openAtButton = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Anchored under the control, the keyboard equivalent of a right-click at the
    // pointer — the menu appears attached to the thing it acts on.
    setMenu({ x: r.left, y: r.bottom + 2 });
  }, []);

  const closeMenu = useCallback(() => {
    setMenu(null);
    // A menu that closes onto <body> strands a keyboard user exactly as a move
    // without focus would.
    const el = btnRef.current;
    if (el && el.isConnected) el.focus();
  }, []);

  /**
   * Take focus when this panel is the one that just moved — the same contract
   * DockTabStrip honours via `focusPanelId`, which this handle received and
   * ignored. It matters MORE here, not less: a hoisted panel's move is a DOM
   * reparent, which blurs whatever had focus, and a solo zone has no tab strip to
   * fall back to. Without this, moving a solo panel by keyboard drops the user on
   * <body> with no way back into the dock.
   */
  useEffect(() => {
    if (dock.focusPanelId !== panelId) return;
    const el = btnRef.current;
    if (el && el.isConnected) el.focus();
  }, [dock.focusPanelId, panelId]);

  const onDragStart = useCallback((e: React.DragEvent<HTMLButtonElement>) => {
    const el = btnRef.current;
    const dt = e.dataTransfer;
    // ONE type, no text/plain — see DOCK_DND_TYPE. Without that omission every
    // input in the room (and the OS) would accept this as text.
    dt.setData(DOCK_DND_TYPE, encodeDockDrag({ panel: panelId, zone: dock.zoneId, win: windowKey }));
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
    beginDockDrag({ panel: panelId, from: dock.zoneId, win: windowKey });
    setDockDragTab(el);
    // NOT stopped: `.room-detail-inner`'s onDragStartCapture must still set
    // internalDrag (and could not be stopped from a bubble handler anyway).
  }, [dock.zoneId, host, panelId, windowKey]);

  const onDragEnd = useCallback(() => {
    // dragend ALWAYS fires in the source window — including Esc-cancel and a drop
    // outside any target — which is why teardown lives here as well as in onDrop.
    endDockDrag();
  }, []);

  const { targets, actions } = menu
    ? buildDockMenuItems(dock, panelId, move)
    : { targets: [], actions: [] };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`dock-solo-handle${className ? ` ${className}` : ''}`}
        data-dock-tab={panelId}
        data-menu-open={menu ? '' : undefined}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu ? true : undefined}
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); openAtButton(); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openAtButton(); }}
        onKeyDown={(e) => {
          if (!isDockMenuKey(e)) return;
          e.preventDefault();
          e.stopPropagation();
          openAtButton();
        }}
      >
        {/* Decorative: the button's aria-label is the accessible name. A grip, not
            a ⋮, because this control is a DRAG source first and a menu second. */}
        <span className="dock-solo-grip" aria-hidden="true">⣿</span>
      </button>
      {/*
        Portalled to the BODY of the document the BUTTON lives in — an element beats
        the context, and this handle can be portalled into a window its provider
        knows nothing about. Never inside the zone: `.dock-zone` and `.popout-root`
        are container-typed, which traps position:fixed descendants in their box.
        Resolved inside the `menu &&` short-circuit so a closed menu never
        dereferences a body (undefined under the DOM-less test renderer).
      */}
      {menu && createPortal(
        <DockTabMenu
          idPrefix={`dock-solo-${panelId}`}
          ariaLabel={dock.labels.tabMenu}
          groupLabel={dock.labels.moveTo}
          targets={targets}
          actions={actions}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
        />,
        portalTargetFor(btnRef.current, host),
      )}
    </>
  );
};

export default DockSoloHandle;
