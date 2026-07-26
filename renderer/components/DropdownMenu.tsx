/**
 * Dropdown Menu Component
 *
 * Trigger + anchored list of items with the shared open/close behavior:
 * closes on item select, on Escape, and on clicks outside the wrapper.
 * Visuals stay with the caller — menuClassName/itemClassName pick the skin,
 * so each call site keeps its existing look.
 *
 * HOST WINDOW: every DOM reach here (portal target, viewport clamp, dismiss
 * listeners) goes through the trigger's OWN document/window, not the module-scope
 * globals — a call site can live in a detached panel window, where the main
 * window's body is the wrong container and its innerWidth is the wrong box to
 * clamp against. `resolveHostWindow` falls back to the context, whose default IS
 * the real globals, so in the main window every one of these resolves to
 * `document` / `window` exactly as before.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHostWindow, resolveHostWindow, portalTargetFor } from '../utils/hostWindow';

export interface DropdownMenuItem {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  /** Destructive action — appends the shared `.danger` item skin. */
  danger?: boolean;
  onSelect: () => void;
}

interface DropdownMenuProps {
  /** Renders the trigger; wire `toggle` to its onClick. */
  renderTrigger: (ctx: { open: boolean; toggle: () => void }) => React.ReactNode;
  items: DropdownMenuItem[];
  /** Full class list for the menu element (replaces the default, not appended). */
  menuClassName?: string;
  /** Class for item buttons; pass '' for unstyled buttons skinned by the menu class. */
  itemClassName?: string;
  /**
   * Render the menu into the OWNING document's body with fixed positioning
   * instead of as an absolutely-positioned child. Needed when an ancestor clips
   * overflow (e.g. a scroll area or a container-query subtree) — otherwise the
   * menu is cut off. Load-bearing, not cosmetic: dropping it inside a
   * container-typed panel traps the fixed menu in the panel's box.
   */
  portal?: boolean;
}

/**
 * Where a portaled menu is placed: below the trigger and right-aligned to it,
 * clamped so it never spills off an edge (the clip `portal` exists to fix), and
 * flipped above when there is no room below.
 *
 * Pure so the geometry is testable — and so the wrong-window bug it used to have
 * is impossible to reintroduce silently: the rect and the viewport are separate
 * arguments, and a caller that passes a rect measured in one window with a
 * viewport read from another gets a visibly wrong answer in the unit test.
 */
export function clampMenuPos(
  rect: { top: number; bottom: number; right: number },
  menuW: number,
  menuH: number,
  viewportW: number,
  viewportH: number,
): { x: number; y: number } {
  const x = Math.max(8, Math.min(rect.right - menuW, viewportW - menuW - 8));
  const y = rect.bottom + 4 + menuH > viewportH ? Math.max(8, rect.top - menuH - 4) : rect.bottom + 4;
  return { x, y };
}

export const DropdownMenu: React.FC<DropdownMenuProps> = ({
  renderTrigger,
  items,
  menuClassName = 'dropdown-menu',
  itemClassName = 'dropdown-item',
  portal = false,
}) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const host = useHostWindow();

  const toggle = useCallback(() => setOpen((o) => !o), []);

  // Position the portaled menu below-right-aligned to the trigger, clamped to
  // the viewport so it never spills off an edge (the clip #3 was fixing).
  // The rect is measured in the trigger's own window, so the clamp must read
  // that window's viewport — mixing the two windows here is what let the menu
  // hang off the right edge of a narrow detached panel.
  useLayoutEffect(() => {
    if (!open || !portal || !wrapperRef.current) { setPos(null); return; }
    const win = resolveHostWindow(wrapperRef.current, host).window;
    const r = wrapperRef.current.getBoundingClientRect();
    const mw = menuRef.current?.offsetWidth ?? 220;
    const mh = menuRef.current?.offsetHeight ?? 240;
    setPos(clampMenuPos(r, mw, mh, win.innerWidth, win.innerHeight));
  }, [open, portal, items.length, host]);

  useEffect(() => {
    if (!open) return;
    const doc = resolveHostWindow(wrapperRef.current, host).document;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapperRef.current && !wrapperRef.current.contains(t) && menuRef.current && !menuRef.current.contains(t)) {
        setOpen(false);
      }
    };
    // Listens on the trigger's own document so stopPropagation keeps Escape from
    // also reaching window-level handlers (Modal close, page hotkeys) while the
    // menu is open — that shielding only holds within ONE window, which is why
    // the binding follows the trigger rather than staying on the main document.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    doc.addEventListener('mousedown', onMouseDown);
    doc.addEventListener('keydown', onKeyDown);
    return () => {
      doc.removeEventListener('mousedown', onMouseDown);
      doc.removeEventListener('keydown', onKeyDown);
    };
  }, [open, host]);

  const menu = open ? (
    <div
      ref={menuRef}
      className={menuClassName}
      role="menu"
      style={portal ? { position: 'fixed', left: pos?.x ?? -9999, top: pos?.y ?? -9999, right: 'auto', marginTop: 0, visibility: pos ? 'visible' : 'hidden', zIndex: 1000 } : undefined}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`${itemClassName}${item.danger ? ' danger' : ''}`.trim() || undefined}
          role="menuitem"
          onClick={() => {
            setOpen(false);
            item.onSelect();
          }}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="dropdown-wrapper" ref={wrapperRef}>
      {renderTrigger({ open, toggle })}
      {/*
        The wrapper ref is populated by the time a menu can exist (the first
        render is always closed), so it — not the context — decides which body
        receives the portal. An element always beats the context: a trigger can
        itself be portalled into a window its provider knows nothing about.
        Resolved inside the `menu &&` short-circuit so a closed menu never
        dereferences a body (which is `undefined` under the DOM-less test
        renderer, and the WRONG body if it were captured before mount).
      */}
      {portal ? (menu && createPortal(menu, portalTargetFor(wrapperRef.current, host))) : menu}
    </div>
  );
};
