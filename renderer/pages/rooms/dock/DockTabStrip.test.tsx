import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DockTabStrip, nextDockTabIndex, dockTabDomId, dockPanelDomId } from './DockTabStrip';
import type { DockTabItem } from './DockTabStrip';

// No i18n mock: the strip takes already-translated labels as props, which is
// what lets the PANELS registry own the keys.
const TABS: DockTabItem[] = [
  { id: 'voice', label: 'Voice', icon: <i className="ic-voice" /> },
  { id: 'lan', label: 'LAN' },
  { id: 'people', label: 'People', badge: '3/5' },
];

const strip = (activeId: string) =>
  renderToStaticMarkup(
    <DockTabStrip tabs={TABS} activeId={activeId} onSelect={() => {}} ariaLabel="Room panels" idPrefix="rail" />,
  );

// The a11y contract is the whole reason this exists instead of components/Tabs,
// so it is pinned in markup rather than left to review.
describe('DockTabStrip markup', () => {
  it('is a real tablist with a name and one tab per entry', () => {
    const html = strip('voice');
    expect(html).toMatch(/role="tablist"[^>]*aria-label="Room panels"/);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('Voice');
    expect(html).toContain('LAN');
    expect(html).toContain('People');
  });

  it('marks exactly one tab selected and gives it the accent underline class', () => {
    const html = strip('lan');
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/aria-selected="false"/g)).toHaveLength(2);
    // the `selected` class lands on the LAN button, not just anywhere
    expect(html).toMatch(/id="rail-tab-lan"[^>]*aria-selected="true"[^>]*class="dock-tab selected"/);
    expect(html).toMatch(/id="rail-tab-voice"[^>]*class="dock-tab"/);
  });

  it('roves the tabindex: only the selected tab is in the page tab order', () => {
    const html = strip('people');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(html).toMatch(/id="rail-tab-people"[^>]*tabindex="0"/);
  });

  it('pairs every tab to its panel id via aria-controls', () => {
    const html = strip('voice');
    for (const t of TABS) {
      expect(html).toMatch(
        new RegExp(`id="${dockTabDomId('rail', t.id)}"[^>]*aria-controls="${dockPanelDomId('rail', t.id)}"`),
      );
    }
  });

  it('keeps the label truncatable but tooltipped, and renders icon/badge slots', () => {
    const html = strip('voice');
    expect(html).toContain('<span class="dock-tab-label">Voice</span>');
    expect(html).toMatch(/title="People"/); // full text survives CSS ellipsis
    expect(html).toContain('dock-tab-icon');
    expect(html).toContain('<span class="dock-tab-badge">3/5</span>');
    // icons are decorative; the label already names the tab
    expect(html).toMatch(/class="dock-tab-icon" aria-hidden="true"/);
  });
});

// Keyboard behaviour can't be event-simulated (no jsdom in this repo), so the
// key math is a pure reducer and THIS is where it is tested.
describe('nextDockTabIndex', () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    ({ key, ...mods });

  it('moves left/right and wraps at both ends', () => {
    expect(nextDockTabIndex(k('ArrowRight'), 0, 3)).toBe(1);
    expect(nextDockTabIndex(k('ArrowRight'), 2, 3)).toBe(0);
    expect(nextDockTabIndex(k('ArrowLeft'), 1, 3)).toBe(0);
    expect(nextDockTabIndex(k('ArrowLeft'), 0, 3)).toBe(2);
  });

  it('jumps to the ends with Home/End', () => {
    expect(nextDockTabIndex(k('Home'), 2, 3)).toBe(0);
    expect(nextDockTabIndex(k('End'), 0, 3)).toBe(2);
  });

  it('cycles with Ctrl+PageUp / Ctrl+PageDown only when the modifier is held', () => {
    expect(nextDockTabIndex(k('PageDown', { ctrlKey: true }), 0, 3)).toBe(1);
    expect(nextDockTabIndex(k('PageUp', { ctrlKey: true }), 0, 3)).toBe(2);
    expect(nextDockTabIndex(k('PageDown', { metaKey: true }), 2, 3)).toBe(0);
    expect(nextDockTabIndex(k('PageDown'), 0, 3)).toBeNull(); // bare PageDown scrolls
  });

  it('ignores modified arrows so OS/app shortcuts still work', () => {
    expect(nextDockTabIndex(k('ArrowRight', { ctrlKey: true }), 0, 3)).toBeNull();
    expect(nextDockTabIndex(k('ArrowLeft', { altKey: true }), 1, 3)).toBeNull();
    expect(nextDockTabIndex(k('Home', { shiftKey: true }), 2, 3)).toBeNull();
  });

  it('returns null for keys it does not own', () => {
    expect(nextDockTabIndex(k('a'), 0, 3)).toBeNull();
    expect(nextDockTabIndex(k('Enter'), 0, 3)).toBeNull();
    expect(nextDockTabIndex(k('ArrowDown'), 0, 3)).toBeNull();
  });

  it('is inert with no tabs and sane when nothing is selected yet', () => {
    expect(nextDockTabIndex(k('ArrowRight'), 0, 0)).toBeNull();
    expect(nextDockTabIndex(k('Home'), -1, 0)).toBeNull();
    // activeId not in the list (a repaired/stale layout): next → first, prev → last
    expect(nextDockTabIndex(k('ArrowRight'), -1, 3)).toBe(0);
    expect(nextDockTabIndex(k('ArrowLeft'), -1, 3)).toBe(2);
    expect(nextDockTabIndex(k('ArrowRight'), 9, 3)).toBe(0);
  });
});
