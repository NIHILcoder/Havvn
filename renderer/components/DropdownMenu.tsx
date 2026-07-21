/**
 * Dropdown Menu Component
 *
 * Trigger + anchored list of items with the shared open/close behavior:
 * closes on item select, on Escape, and on clicks outside the wrapper.
 * Visuals stay with the caller — menuClassName/itemClassName pick the skin,
 * so each call site keeps its existing look.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
   * Render the menu into document.body with fixed positioning instead of as an
   * absolutely-positioned child. Needed when an ancestor clips overflow (e.g. a
   * scroll area or a container-query subtree) — otherwise the menu is cut off.
   */
  portal?: boolean;
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

  const toggle = useCallback(() => setOpen((o) => !o), []);

  // Position the portaled menu below-right-aligned to the trigger, clamped to
  // the viewport so it never spills off an edge (the clip #3 was fixing).
  useLayoutEffect(() => {
    if (!open || !portal || !wrapperRef.current) { setPos(null); return; }
    const r = wrapperRef.current.getBoundingClientRect();
    const mw = menuRef.current?.offsetWidth ?? 220;
    const mh = menuRef.current?.offsetHeight ?? 240;
    const x = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8));
    const y = r.bottom + 4 + mh > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4;
    setPos({ x, y });
  }, [open, portal, items.length]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapperRef.current && !wrapperRef.current.contains(t) && menuRef.current && !menuRef.current.contains(t)) {
        setOpen(false);
      }
    };
    // Listens on document so stopPropagation keeps Escape from also reaching
    // window-level handlers (Modal close, page hotkeys) while the menu is open.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

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
      {portal ? (menu && createPortal(menu, document.body)) : menu}
    </div>
  );
};
