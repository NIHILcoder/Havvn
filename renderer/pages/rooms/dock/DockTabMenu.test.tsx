import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DockTabMenu, nextDockMenuIndex, clampDockMenuPos } from './DockTabMenu';
import type { DockMenuItem } from './DockTabMenu';

// Like the strip, this component takes already-translated strings, which is what
// keeps i18n in the registry and lets these tests need no provider.
const TARGETS: DockMenuItem[] = [
  { key: 'left', label: 'Left', checked: true, disabled: true },
  { key: 'centre', label: 'Centre' },
  { key: 'right', label: 'Right', refusal: 'Last docked group' },
];
const ACTIONS: DockMenuItem[] = [
  { key: 'new-window', label: 'Open in new window' },
  { key: 'dock-back', label: 'Dock back', refusal: 'All windows in use' },
];

const menu = (targets = TARGETS, actions: DockMenuItem[] | undefined = ACTIONS) =>
  renderToStaticMarkup(
    <DockTabMenu
      ariaLabel="Chat panel actions"
      groupLabel="Move to"
      targets={targets}
      actions={actions}
      x={40}
      y={80}
      onClose={() => {}}
      idPrefix="rail-menu-chat"
    />,
  );

describe('DockTabMenu markup', () => {
  it('is a real menu with a name — not the div-of-buttons ContextMenu renders', () => {
    const html = menu();
    expect(html).toMatch(/role="menu"[^>]*aria-label="Chat panel actions"/);
    expect(html).toContain('Move to');
  });

  it('gives the destinations RADIO semantics and marks the current zone', () => {
    const html = menu();
    expect(html.match(/role="menuitemradio"/g)).toHaveLength(3);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html.match(/aria-checked="false"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-checked="true"[^>]*>.*?Left/);
  });

  it('groups the destinations under the header, and names the group by it', () => {
    const html = menu();
    expect(html).toContain('id="rail-menu-chat-header"');
    expect(html).toMatch(/role="group" aria-labelledby="rail-menu-chat-header"/);
  });

  it('LISTS the current zone rather than omitting it — the shape never changes', () => {
    // A one-zone menu (single-column mode, or inside a torn-off window) still says
    // where the panel is, and still offers the actions.
    const html = menu([{ key: 'left', label: 'Left', checked: true, disabled: true }]);
    expect(html.match(/role="menuitemradio"/g)).toHaveLength(1);
    expect(html).toContain('Open in new window');
  });

  it('refuses items with aria-disabled, NOT disabled — the reason stays reachable', () => {
    const html = menu();
    // a `disabled` button is skipped by assistive tech and cannot be focused, so
    // the user would never learn why the move is impossible
    expect(html).not.toContain('disabled=""');
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(3); // current + 2 refusals
    expect(html).toMatch(/title="Last docked group"/);
  });

  it('renders the refusal reason inline and points aria-describedby at it', () => {
    const html = menu();
    expect(html).toContain('id="rail-menu-chat-why-right"');
    expect(html).toMatch(/aria-describedby="rail-menu-chat-why-right"/);
    expect(html).toContain('>Last docked group</span>');
    // the marked current zone needs no explanation — the mark IS the explanation
    expect(html).not.toContain('rail-menu-chat-why-left');
  });

  it('separates the actions from the destinations', () => {
    const html = menu();
    expect(html).toContain('role="separator"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
    expect(html).toContain('Open in new window');
    expect(html).toContain('Dock back');
  });

  it('drops the separator when there are no actions', () => {
    const html = menu(TARGETS, []);
    expect(html).not.toContain('role="separator"');
    expect(html).not.toMatch(/role="menuitem"/);
  });

  it('manages its own focus: every item is out of the page tab order', () => {
    const html = menu();
    // The menu focuses an item on open and moves focus with the arrow keys; items
    // that were also tab stops would let Tab walk out into the document behind it.
    expect(html.match(/tabindex="-1"/g)).toHaveLength(5);
    expect(html).not.toContain('tabindex="0"');
  });

  it('places itself at the anchor point (the clamp then corrects it after layout)', () => {
    expect(menu()).toMatch(/style="left:40px;top:80px"/);
  });
});

describe('nextDockMenuIndex', () => {
  const k = (key: string, mods: Record<string, boolean> = {}) => ({ key, ...mods });

  it('moves down/up and wraps at both ends', () => {
    expect(nextDockMenuIndex(k('ArrowDown'), 0, 5)).toBe(1);
    expect(nextDockMenuIndex(k('ArrowDown'), 4, 5)).toBe(0);
    expect(nextDockMenuIndex(k('ArrowUp'), 1, 5)).toBe(0);
    expect(nextDockMenuIndex(k('ArrowUp'), 0, 5)).toBe(4);
  });

  it('jumps to the ends with Home/End', () => {
    expect(nextDockMenuIndex(k('Home'), 3, 5)).toBe(0);
    expect(nextDockMenuIndex(k('End'), 0, 5)).toBe(4);
  });

  it('is sane when nothing is focused yet', () => {
    expect(nextDockMenuIndex(k('ArrowDown'), -1, 3)).toBe(0);
    expect(nextDockMenuIndex(k('ArrowUp'), -1, 3)).toBe(2);
  });

  it('ignores modified keys and keys it does not own', () => {
    expect(nextDockMenuIndex(k('ArrowDown', { altKey: true }), 0, 3)).toBeNull();
    expect(nextDockMenuIndex(k('ArrowLeft'), 0, 3)).toBeNull(); // arrows across belong to the strip
    expect(nextDockMenuIndex(k('Enter'), 0, 3)).toBeNull();
    expect(nextDockMenuIndex(k('Escape'), 0, 3)).toBeNull();    // dismissal, not traversal
    expect(nextDockMenuIndex(k('ArrowDown'), 0, 0)).toBeNull();
  });
});

describe('clampDockMenuPos', () => {
  it('leaves a menu that fits exactly where it was asked for', () => {
    expect(clampDockMenuPos(100, 200, 220, 160, 1280, 800)).toEqual({ x: 100, y: 200 });
  });

  it('pulls a menu back from the right edge', () => {
    expect(clampDockMenuPos(1200, 100, 220, 160, 1280, 800)).toEqual({ x: 1052, y: 100 });
  });

  it('flips above the anchor when there is no room below', () => {
    // 760 + 160 + 8 > 800, so it opens upward from the anchor
    expect(clampDockMenuPos(100, 760, 220, 160, 1280, 800)).toEqual({ x: 100, y: 600 });
  });

  it('never goes off the top or the left, even in a tiny window', () => {
    expect(clampDockMenuPos(-50, -50, 220, 160, 1280, 800)).toEqual({ x: 8, y: 8 });
    // a menu taller/wider than the viewport pins to the top-left margin
    expect(clampDockMenuPos(10, 10, 400, 400, 200, 200)).toEqual({ x: 8, y: 8 });
  });
});
