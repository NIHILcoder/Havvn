/**
 * Dropdown Menu Component
 *
 * Trigger + anchored list of items with the shared open/close behavior:
 * closes on item select, on Escape, and on clicks outside the wrapper.
 * Visuals stay with the caller — menuClassName/itemClassName pick the skin,
 * so each call site keeps its existing look.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface DropdownMenuItem {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
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
}

export const DropdownMenu: React.FC<DropdownMenuProps> = ({
  renderTrigger,
  items,
  menuClassName = 'dropdown-menu',
  itemClassName = 'dropdown-item',
}) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback(() => setOpen((o) => !o), []);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
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

  return (
    <div className="dropdown-wrapper" ref={wrapperRef}>
      {renderTrigger({ open, toggle })}
      {open && (
        <div className={menuClassName} role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              className={itemClassName || undefined}
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
      )}
    </div>
  );
};
