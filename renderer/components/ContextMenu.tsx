/**
 * Context Menu Component
 *
 * Right-click (and ⋯) menu for downloads and room file rows. The menu is always
 * portaled to the host window's <body>: `.page-container` / `.main-content`
 * overflow:hidden clips position:fixed descendants in Chromium, which is why
 * the ⋯ menu on a compact download row used to show only its left strip.
 *
 * Clamp lives in React state (not a DOM write after paint). Writing
 * `el.style.left` used to lose on the next parent render — Downloads ticks
 * stats ~1/s, React reapplied the original click coords, and the menu jumped
 * back off the right edge.
 *
 * Every DOM global resolves from the menu's own document, with the host-window
 * context as fallback before the ref exists. A room file row can live in a
 * detached panel; mixing realms is worse here than elsewhere because the clamp
 * is viewport math.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

const PAD = 8;

/**
 * Keep a point-anchored menu inside the given viewport. Pure so the geometry
 * is testable without createPortal (which react-dom/server throws on).
 */
export function clampContextMenuPos(
  x: number,
  y: number,
  menuW: number,
  menuH: number,
  viewportW: number,
  viewportH: number,
): { x: number; y: number; maxHeight: number } {
  const maxHeight = Math.max(120, viewportH - PAD * 2);
  const h = Math.min(menuH, maxHeight);
  let nx = x + menuW + PAD > viewportW ? viewportW - menuW - PAD : x;
  let ny = y + h + PAD > viewportH ? viewportH - h - PAD : y;
  nx = Math.max(PAD, nx);
  ny = Math.max(PAD, ny);
  return { x: nx, y: ny, maxHeight };
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const host = useHostWindow();
  const [pos, setPos] = useState<{ x: number; y: number; maxHeight: number } | null>(null);

  useEffect(() => {
    const doc = menuRef.current?.ownerDocument ?? host.document;
    if (!doc) return;
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

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const win = el.ownerDocument.defaultView ?? host.window;
    setPos(clampContextMenuPos(
      x,
      y,
      el.offsetWidth,
      el.scrollHeight,
      win.innerWidth,
      win.innerHeight,
    ));
  }, [x, y, items.length, host]);

  const node = (
    <>
      <div className="context-menu-backdrop" onClick={onClose} />
      <div
        ref={menuRef}
        className="context-menu"
        style={{
          left: pos?.x ?? -9999,
          top: pos?.y ?? -9999,
          maxHeight: pos?.maxHeight,
          visibility: pos ? 'visible' : 'hidden',
        }}
      >
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

  const body = host.document?.body;
  return body ? createPortal(node, body) : node;
};
