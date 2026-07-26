/**
 * Context Menu Component
 *
 * Right-click context menu for downloads — and for room file rows, which can be
 * shown in a DETACHED window. Every DOM global here therefore resolves from the
 * menu's own element (`ownerDocument`), with the host-window context as the
 * fallback before the ref exists: the caller portals this menu into the document
 * the right-clicked row lives in, and the dismiss listeners + the viewport clamp
 * must agree with it. Mixing realms is worse here than elsewhere because the clamp
 * WRITES its answer back into inline style, so a wrong-window measurement sticks.
 * In the main window every one of these resolves to the real globals.
 */

import React, { useEffect, useRef } from 'react';
import { Icon, IconName } from './Icon';
import { useHostWindow } from '../utils/hostWindow';
import './ContextMenu.css';

export interface ContextMenuItem {
  label: string;
  icon?: IconName;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const host = useHostWindow();

  useEffect(() => {
    const doc = menuRef.current?.ownerDocument ?? host.document;
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    doc.addEventListener('mousedown', handleClickOutside);
    doc.addEventListener('keydown', handleEscape);

    return () => {
      doc.removeEventListener('mousedown', handleClickOutside);
      doc.removeEventListener('keydown', handleEscape);
    };
  }, [onClose, host]);

  // Adjust position to keep menu within viewport — the rect and the viewport must
  // come from the SAME window, or the menu is clamped against a box it isn't in.
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const win = menuRef.current.ownerDocument.defaultView ?? host.window;
      const viewportWidth = win.innerWidth;
      const viewportHeight = win.innerHeight;

      let adjustedX = x;
      let adjustedY = y;

      if (rect.right > viewportWidth) {
        adjustedX = viewportWidth - rect.width - 10;
      }

      if (rect.bottom > viewportHeight) {
        adjustedY = viewportHeight - rect.height - 10;
      }

      menuRef.current.style.left = `${adjustedX}px`;
      menuRef.current.style.top = `${adjustedY}px`;
    }
  }, [x, y, host]);

  return (
    <>
      <div className="context-menu-backdrop" onClick={onClose} />
      <div ref={menuRef} className="context-menu" style={{ left: x, top: y }}>
        {items.map((item, index) => (
          item.divider ? (
            <div key={index} className="context-menu-divider" />
          ) : (
            <button
              key={index}
              className={`context-menu-item ${item.disabled ? 'context-menu-item-disabled' : ''} ${item.danger ? 'context-menu-item-danger' : ''}`}
              onClick={() => {
                if (!item.disabled) {
                  item.onClick();
                  onClose();
                }
              }}
              disabled={item.disabled}
            >
              {item.icon && <Icon name={item.icon} size={16} />}
              <span>{item.label}</span>
            </button>
          )
        ))}
      </div>
    </>
  );
};
