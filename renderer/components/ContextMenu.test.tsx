import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ContextMenu, clampContextMenuPos } from './ContextMenu';

describe('clampContextMenuPos', () => {
  it('keeps a click that already fits', () => {
    expect(clampContextMenuPos(100, 80, 220, 240, 1920, 1080)).toEqual({
      x: 100, y: 80, maxHeight: 1080 - 16,
    });
  });

  it('pulls a right-edge click back so the menu stays on screen', () => {
    // ⋯ on a compact row: click at x=850 in a 900px window, 220px menu.
    const p = clampContextMenuPos(850, 120, 220, 300, 900, 800);
    expect(p.x).toBe(900 - 220 - 8);
    expect(p.y).toBe(120);
  });

  it('never goes past the left gutter, even when the menu is wider than the viewport', () => {
    expect(clampContextMenuPos(10, 20, 220, 100, 200, 700).x).toBe(8);
  });

  it('flips up when the menu would overflow the bottom', () => {
    const p = clampContextMenuPos(40, 700, 220, 240, 1920, 800);
    expect(p.y).toBe(800 - 240 - 8);
  });

  it('caps height and still stays in the viewport when the menu is taller than the window', () => {
    const p = clampContextMenuPos(40, 40, 220, 2000, 1920, 400);
    expect(p.maxHeight).toBe(400 - 16);
    expect(p.y).toBe(8);
  });
});

describe('ContextMenu markup', () => {
  it('renders without touching document.body (DOM-less / SSR)', () => {
    const html = renderToStaticMarkup(
      <ContextMenu
        x={10}
        y={10}
        onClose={() => {}}
        items={[{ label: 'Open', onClick: () => {} }]}
      />,
    );
    expect(html).toContain('context-menu');
    expect(html).toContain('Open');
  });
});
