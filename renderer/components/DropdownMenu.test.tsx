import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DropdownMenu, clampMenuPos } from './DropdownMenu';

// The interesting half of DropdownMenu is unreachable from renderToStaticMarkup:
// the menu only exists after a click, and when `portal` is set it goes through
// createPortal, which react-dom/server throws on. So the geometry lives in a pure
// function that IS testable, and the markup test guards the one thing SSR can
// prove — that nothing touches the DOM globals during render.

const rect = (top: number, height: number, right: number) => ({ top, bottom: top + height, right });

describe('clampMenuPos', () => {
  it('right-aligns the menu to the trigger when there is room', () => {
    // trigger right edge at 500 in a 1920px viewport, 220px menu → x = 280.
    expect(clampMenuPos(rect(100, 24, 500), 220, 240, 1920, 1080)).toEqual({ x: 280, y: 128 });
  });

  it('pulls the menu back inside the right edge', () => {
    // A trigger flush against the right edge would put the menu at 1915-220.
    const p = clampMenuPos(rect(10, 20, 1915), 220, 100, 1920, 1080);
    expect(p.x).toBe(1920 - 220 - 8);
  });

  it('never goes past the left gutter, even in a viewport narrower than the menu', () => {
    // This is the detached-panel case: a ~420px window with a 220px menu.
    expect(clampMenuPos(rect(10, 20, 100), 220, 100, 420, 700).x).toBe(8);
    expect(clampMenuPos(rect(10, 20, 400), 220, 100, 200, 700).x).toBe(8);
  });

  it('flips above the trigger when the menu would overflow the bottom', () => {
    // 1000 (bottom) + 4 + 240 > 1080 → open upwards from the trigger top.
    expect(clampMenuPos(rect(976, 24, 500), 220, 240, 1920, 1080).y).toBe(976 - 240 - 4);
  });

  it('clamps a flipped menu that is taller than the space above it', () => {
    expect(clampMenuPos(rect(20, 24, 500), 220, 600, 1920, 400).y).toBe(8);
  });

  it('is decided entirely by the viewport it is given — the wrong-window bug, as data', () => {
    const r = rect(600, 24, 418);
    // Measured in a 420x700 detached panel, clamped against ITS viewport: the
    // menu is pulled inside and flipped above the trigger.
    const own = clampMenuPos(r, 220, 240, 420, 700);
    // The old code took the same rect but read the MAIN window's viewport, which
    // clamps nothing and flips nothing — the menu spills off the panel's edge
    // and runs past its bottom.
    const wrong = clampMenuPos(r, 220, 240, 1920, 1080);
    expect(own).not.toEqual(wrong);
    expect(own.x).toBe(420 - 220 - 8);
    expect(wrong.x).toBe(418 - 220);
    expect(own.y).toBe(600 - 240 - 4);
    expect(wrong.y).toBe(628);
  });
});

describe('DropdownMenu markup', () => {
  const render = (portal: boolean) =>
    renderToStaticMarkup(
      <DropdownMenu
        portal={portal}
        renderTrigger={({ open, toggle }) => (
          <button type="button" onClick={toggle} aria-expanded={open}>menu</button>
        )}
        items={[{ key: 'a', label: 'Alpha', onSelect: () => {} }]}
      />,
    );

  it('renders the trigger and no menu while closed', () => {
    const html = render(false);
    expect(html).toContain('class="dropdown-wrapper"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('Alpha');
  });

  // Regression guard for the host-window work: the portal target is resolved lazily,
  // inside the `menu && …` short-circuit. Resolving it eagerly would dereference
  // `document.body` on every render — which throws here (no jsdom) and, worse,
  // would bind a closed menu to the wrong window at mount time.
  it('does not touch the DOM globals when a portaled menu is closed', () => {
    expect(() => render(true)).not.toThrow();
    expect(render(true)).toBe(render(false));
  });

  // Nothing in the app wraps the tree in a HostWindowProvider — the main window
  // is supposed to work off the context default. If useHostWindow ever starts
  // throwing on a missing provider (the useTranslation pattern), this catches it.
  it('works with no HostWindowProvider anywhere above it', () => {
    expect(render(false)).toContain('dropdown-wrapper');
  });
});
