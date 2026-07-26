/**
 * DockTabMenu — the per-tab "Move to" menu.
 *
 * This is THE ACCESSIBLE PATH for moving a panel, not a fallback for when drag
 * polish slips. It is also the ONLY path in one direction: cross-window tab drag is
 * impossible (HTML5 DnD and pointer capture do not cross Electron BrowserWindow
 * boundaries), so moving a panel from a torn-off window back into a docked zone can
 * only ever be a menu action.
 *
 * ── WHY NOT components/ContextMenu or components/DropdownMenu ────────────────
 * Both were considered first; neither carries the semantics this needs.
 *
 *   ContextMenu.tsx — its root is a plain div: no `role="menu"`, its items are
 *   plain buttons with no `role="menuitem"`, it never focuses itself on open, and
 *   it has no arrow-key traversal. Opened from the keyboard it would leave focus on
 *   the tab while the menu sits at the END of the document (it is portalled to the
 *   body), so reaching an item would mean tabbing through the entire rest of the
 *   page. It also has no disabled-with-a-reason item and no group header, and both
 *   are required here: a refusal must be VISIBLE with its reason, never a silent
 *   no-op.
 *
 *   DropdownMenu.tsx — its trigger renders INSIDE its own wrapper, which here would
 *   mean a `<button>` inside `role="tab"`. That is nested-interactive (invalid) and
 *   it breaks the strip's roving tabindex by adding a second tab stop per tab. It
 *   likewise has no keyboard traversal between items and no disabled state.
 *
 * Growing either one would ripple: ContextMenu is shared with downloads and room
 * file rows, DropdownMenu with a dozen call sites. So this is a sibling with its own
 * `dock-tab-menu*` class prefix, ~90 lines, and the a11y model spelled out below.
 *
 * ── The a11y model ──────────────────────────────────────────────────────────
 *   - `role="menu"`, opened by right-click, by Shift+F10 / the ContextMenu key on
 *     the focused tab, or by the tab's decorative ⋮ hint (see DockTabStrip).
 *   - Zone destinations are `role="menuitemradio"` with `aria-checked` — "which
 *     zone is this panel in" is exactly a radio question, and it is what lets the
 *     CURRENT zone be LISTED, marked and disabled rather than omitted. A stable
 *     menu shape needs no branching for the one-zone case (single-column mode, or
 *     inside a torn-off window): the group renders one marked entry, which tells
 *     the user where the panel is instead of making the feature look absent.
 *   - A refused destination stays FOCUSABLE (`aria-disabled`, not `disabled`) with
 *     the reason as its accessible description, so a keyboard user can find out why
 *     rather than tabbing past a hole.
 *   - Roving focus is managed here: the menu focuses itself on open, Arrow/Home/End
 *     move between items, Escape and Tab close (the strip returns focus to the tab).
 *
 * DOM discipline: every reach — the dismiss listeners, the viewport clamp — goes
 * through the menu's OWN `ownerDocument`, with the host-window context as the
 * fallback before the ref exists. The clamp WRITES its answer into inline style, so
 * a wrong-window measurement would stick. The menu itself does not portal: the
 * strip portals it into the tab's document body, because the strip is the thing
 * holding the tab element (and because `createPortal` throws under the DOM-less
 * test renderer, keeping it out of here is what makes this component testable).
 */
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { useHostWindow, resolveHostWindow } from '../../../utils/hostWindow';
import './DockTabMenu.css';

export interface DockMenuItem {
  key: string;
  /** Already-translated. This component never calls t(). */
  label: string;
  /**
   * Non-null ⇒ the item is listed but REFUSED, and this string says why. It
   * becomes the item's tooltip and its accessible description — a refusal the user
   * cannot read is the silent no-op this whole design forbids.
   */
  refusal?: string | null;
  /**
   * Refused with no reason to give. Exactly one case: the zone the panel is
   * ALREADY in, which is listed and marked so the menu shape never changes, and
   * needs no explanation because the mark is the explanation.
   */
  disabled?: boolean;
  /** Radio semantics for the zone group: the panel's CURRENT zone is marked. */
  checked?: boolean;
  onSelect?: () => void;
}

export interface DockTabMenuProps {
  /** Accessible name for the menu, already translated (e.g. "Chat tab menu"). */
  ariaLabel: string;
  /** Non-interactive group header over the destinations (e.g. "Move to"). */
  groupLabel: string;
  /** Zone destinations, INCLUDING the current zone (marked + refused). */
  targets: readonly DockMenuItem[];
  /** Actions under the group: "Open in new window", "Dock back". */
  actions?: readonly DockMenuItem[];
  /** Anchor point in the OWNING window's client coordinates. */
  x: number;
  y: number;
  onClose: () => void;
  /** Namespaces the header id so several menus could coexist. */
  idPrefix?: string;
}

/** The subset of a KeyboardEvent the reducer reads (so tests need no DOM). */
export interface DockMenuKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Pure keyboard reducer: which item index should take focus. Returns null when the
 * key is not ours, so the caller knows not to preventDefault.
 *
 * Wraps at both ends (the WAI-ARIA menu pattern). `current` may be out of range
 * (nothing focused yet): "next" then means the first item and "previous" the last.
 * Modified arrows are ignored — Alt+Arrow and Ctrl+Arrow belong to the OS and app.
 */
export function nextDockMenuIndex(
  ev: DockMenuKeyEvent,
  current: number,
  count: number,
): number | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (ev.altKey || ev.metaKey || ev.ctrlKey || ev.shiftKey) return null;
  const inRange = Number.isInteger(current) && current >= 0 && current < count;
  switch (ev.key) {
    case 'ArrowDown': return inRange ? (current + 1) % count : 0;
    case 'ArrowUp': return inRange ? (current - 1 + count) % count : count - 1;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/**
 * Pure placement: prefer below-right of the anchor point, flip above when it does
 * not fit, and clamp to the viewport with an 8px margin so the menu can never spill
 * off an edge. The anchor and the viewport are separate arguments precisely so a
 * caller that measures in one window and clamps against another gets a visibly
 * wrong answer in the unit test rather than a subtly misplaced menu in production.
 */
export function clampDockMenuPos(
  x: number,
  y: number,
  menuW: number,
  menuH: number,
  viewportW: number,
  viewportH: number,
): { x: number; y: number } {
  const gap = 8;
  const nx = Math.max(gap, Math.min(x, viewportW - menuW - gap));
  const fitsBelow = y + menuH + gap <= viewportH;
  const ny = Math.max(gap, Math.min(fitsBelow ? y : y - menuH, viewportH - menuH - gap));
  return { x: nx, y: ny };
}

export const DockTabMenu: React.FC<DockTabMenuProps> = ({
  ariaLabel,
  groupLabel,
  targets,
  actions = [],
  x,
  y,
  onClose,
  idPrefix = 'dock-tab-menu',
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const host = useHostWindow();
  const items: DockMenuItem[] = [...targets, ...actions];
  const headerId = `${idPrefix}-header`;

  // Focus the menu on open — this is what makes the keyboard path usable at all.
  // Prefer the first item that can actually be chosen; if every destination is
  // refused, land on the first item anyway so the reason is reachable.
  useEffect(() => {
    const first = items.findIndex((it) => !it.refusal);
    (itemRefs.current[first >= 0 ? first : 0])?.focus();
    // Only on open: re-running on every items change would steal focus mid-menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clamp AFTER layout, in the menu's own window: the rect and the viewport must
  // come from the same window or the menu is clamped against a box it is not in.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const win = resolveHostWindow(el, host).window;
    const pos = clampDockMenuPos(x, y, el.offsetWidth, el.offsetHeight, win.innerWidth, win.innerHeight);
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
  }, [x, y, host, items.length]);

  // Dismissal. Both listeners bind to the menu's OWN document, so a menu opened in
  // a torn-off window is dismissed by clicks and Escape in THAT window.
  useEffect(() => {
    const doc = menuRef.current?.ownerDocument ?? host.document;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Shield the room's other Escape handlers while a menu is open.
      e.stopPropagation();
      onClose();
    };
    doc.addEventListener('mousedown', onMouseDown);
    doc.addEventListener('keydown', onKeyDown);
    return () => {
      doc.removeEventListener('mousedown', onMouseDown);
      doc.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, host]);

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Tab') { onClose(); return; } // moving on closes; focus goes back to the tab
    const el = e.target as HTMLElement;
    const current = itemRefs.current.findIndex((r) => r === el);
    const idx = nextDockMenuIndex(e, current, items.length);
    if (idx === null) return;
    e.preventDefault();
    e.stopPropagation();
    itemRefs.current[idx]?.focus();
  };

  const renderItem = (item: DockMenuItem, index: number, role: 'menuitem' | 'menuitemradio') => {
    const refused = !!item.refusal || item.disabled === true;
    const descId = item.refusal ? `${idPrefix}-why-${item.key}` : undefined;
    return (
      <button
        key={item.key}
        type="button"
        role={role}
        // aria-disabled, NOT `disabled`: a refused item must stay focusable so the
        // reason below is reachable by keyboard.
        aria-disabled={refused || undefined}
        aria-checked={role === 'menuitemradio' ? !!item.checked : undefined}
        aria-describedby={descId}
        title={item.refusal ?? undefined}
        tabIndex={-1}
        ref={(el) => { itemRefs.current[index] = el; }}
        className={`dock-tab-menu-item${refused ? ' refused' : ''}${item.checked ? ' checked' : ''}`}
        onClick={() => {
          if (refused) return;
          item.onSelect?.();
          onClose();
        }}
      >
        <span className="dock-tab-menu-mark" aria-hidden="true" />
        <span className="dock-tab-menu-label">{item.label}</span>
        {item.refusal && <span className="dock-tab-menu-why" id={descId}>{item.refusal}</span>}
      </button>
    );
  };

  return (
    <div
      ref={menuRef}
      className="dock-tab-menu"
      role="menu"
      aria-label={ariaLabel}
      style={{ left: x, top: y }}
      onKeyDown={onMenuKeyDown}
    >
      <div className="dock-tab-menu-header" id={headerId} role="presentation">{groupLabel}</div>
      <div role="group" aria-labelledby={headerId}>
        {targets.map((item, i) => renderItem(item, i, 'menuitemradio'))}
      </div>
      {actions.length > 0 && <div className="dock-tab-menu-sep" role="separator" />}
      {actions.map((item, i) => renderItem(item, targets.length + i, 'menuitem'))}
    </div>
  );
};

export default DockTabMenu;
