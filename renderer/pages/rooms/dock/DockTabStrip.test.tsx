import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DockTabStrip,
  nextDockTabIndex,
  dockCycleIndex,
  dockTabSignature,
  buildDockMenuItems,
  isDockMenuKey,
  dockTabDomId,
  dockPanelDomId,
} from './DockTabStrip';
import type { DockTabItem, DockStripInteractions } from './DockTabStrip';

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

// ── P3: the drag source and the "Move to" menu ──────────────────────────────
// Everything below hangs off the optional `dock` prop. The first test is the
// important one: without it the strip must be byte-for-byte the P1 strip, because
// a half-wired caller getting a half-working drag is the failure mode.
const DOCK: DockStripInteractions = {
  zoneId: 'left',
  windowKey: 'main',
  moveTargets: () => [
    { zone: 'left', label: 'Left', current: true },
    { zone: 'centre', label: 'Centre' },
    { zone: 'right', label: 'Right', refusal: 'Last docked group' },
  ],
  actions: () => [{ key: 'new-window', label: 'Open in new window', onSelect: () => {} }],
  onMovePanel: () => {},
  labels: { moveTo: 'Move to', tabMenu: 'Panel actions' },
};

const dockStrip = (activeId: string, dock?: DockStripInteractions) =>
  renderToStaticMarkup(
    <DockTabStrip
      tabs={TABS}
      activeId={activeId}
      onSelect={() => {}}
      ariaLabel="Room panels"
      idPrefix="rail"
      dock={dock}
    />,
  );

describe('DockTabStrip without `dock` (P1 behaviour is the default)', () => {
  it('adds nothing at all — no draggable, no menu affordance', () => {
    const html = dockStrip('voice');
    expect(html).not.toContain('draggable');
    expect(html).not.toContain('aria-haspopup');
    expect(html).not.toContain('dock-tab-menu-hint');
    // ...and it is exactly what the P1 strip rendered
    expect(html).toBe(strip('voice'));
  });
});

describe('DockTabStrip with `dock` (drag source + menu)', () => {
  it('makes every tab a drag source', () => {
    const html = dockStrip('voice', DOCK);
    expect(html.match(/draggable="true"/g)).toHaveLength(3);
  });

  it('stamps each tab with its panel id, so a key event can find which tab it is on', () => {
    // Shift+F10 / the ContextMenu key arrive on the tablist; the handler reads the
    // id back off the focused tab via closest('.dock-tab').
    const html = dockStrip('voice', DOCK);
    for (const t of TABS) expect(html).toContain(`data-dock-tab="${t.id}"`);
  });

  it('announces the menu on the tab itself, since the ⋮ glyph is decorative', () => {
    const html = dockStrip('voice', DOCK);
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(3);
    expect(html.match(/<span class="dock-tab-menu-hint" aria-hidden="true">/g)).toHaveLength(3);
  });

  it('keeps the ⋮ hint OUT of the tab order: it is a span, never a button', () => {
    // A <button> inside role="tab" is nested-interactive (invalid) and would add a
    // second tab stop per tab, breaking the roving tabindex.
    const html = dockStrip('people', DOCK);
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
  });

  it('leaves the P1 a11y contract untouched', () => {
    const html = dockStrip('lan', DOCK);
    expect(html).toMatch(/role="tablist"[^>]*aria-label="Room panels"/);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(
      new RegExp(`id="${dockTabDomId('rail', 'lan')}"[^>]*aria-controls="${dockPanelDomId('rail', 'lan')}"`),
    );
  });

  it('renders no menu until one is opened (so nothing portals during a static render)', () => {
    expect(dockStrip('voice', DOCK)).not.toContain('role="menu"');
  });
});

// Which keys open the tab menu. Deliberately disjoint from nextDockTabIndex, which
// owns the arrows — a key handled by both would move focus AND open a menu.
describe('isDockMenuKey', () => {
  const k = (key: string, mods: Record<string, boolean> = {}) => ({ key, ...mods });

  it('opens on the ContextMenu key and on Shift+F10 (the WAI-ARIA equivalent)', () => {
    expect(isDockMenuKey(k('ContextMenu'))).toBe(true);
    expect(isDockMenuKey(k('F10', { shiftKey: true }))).toBe(true);
  });

  it('leaves bare F10 and other modifier combinations to the app', () => {
    expect(isDockMenuKey(k('F10'))).toBe(false);
    expect(isDockMenuKey(k('F10', { shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(isDockMenuKey(k('F10', { altKey: true }))).toBe(false);
    expect(isDockMenuKey(k('Enter'))).toBe(false);
  });

  it('does not overlap the navigation keys the strip already owns', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(isDockMenuKey(k(key))).toBe(false);
    }
    expect(nextDockTabIndex(k('ContextMenu'), 0, 3)).toBeNull();
    expect(nextDockTabIndex(k('F10', { shiftKey: true }), 0, 3)).toBeNull();
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

// The zone root claims this key for every column, so it must not claim it when it
// has nothing to do with it: a no-op preventDefault + stopPropagation swallows the
// key inside the files list and the chat composer, which it did not before P3.
describe('dockCycleIndex', () => {
  const k = (key: string, mods: Record<string, boolean> = {}) => ({ key, ...mods });

  it('cycles a multi-panel zone with Ctrl/Cmd held', () => {
    expect(dockCycleIndex(k('PageDown', { ctrlKey: true }), 0, 3)).toBe(1);
    expect(dockCycleIndex(k('PageUp', { metaKey: true }), 0, 3)).toBe(2);
  });

  it('declines a ONE-panel zone rather than returning its only index', () => {
    expect(dockCycleIndex(k('PageDown', { ctrlKey: true }), 0, 1)).toBeNull();
    expect(dockCycleIndex(k('PageUp', { ctrlKey: true }), 0, 1)).toBeNull();
  });

  it('declines an EMPTY zone', () => {
    expect(dockCycleIndex(k('PageDown', { ctrlKey: true }), -1, 0)).toBeNull();
  });

  it('never claims arrows, Home/End or an unmodified PageUp/PageDown', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(dockCycleIndex(k(key), 0, 3)).toBeNull();
    }
    expect(dockCycleIndex(k('PageDown'), 0, 3)).toBeNull(); // bare PageDown scrolls
  });
});

// The per-drag rect cache is keyed on this. A gossip push mid-drag re-renders the
// strip and can change a badge's WIDTH; stale midpoints make the insertion marker
// and the computed drop index disagree.
describe('dockTabSignature', () => {
  it('changes when a badge changes width', () => {
    const a = dockTabSignature([{ id: 'people', label: 'People', badge: '9/10' }]);
    const b = dockTabSignature([{ id: 'people', label: 'People', badge: '10/10' }]);
    expect(a).not.toBe(b);
  });

  it('changes when a badge appears or disappears (LAN)', () => {
    const off = dockTabSignature([{ id: 'lan', label: 'LAN' }]);
    const on = dockTabSignature([{ id: 'lan', label: 'LAN', badge: '!' }]);
    expect(off).not.toBe(on);
  });

  it('changes when the tab set or its labels change', () => {
    const one = dockTabSignature(TABS);
    expect(dockTabSignature(TABS.slice(0, 2))).not.toBe(one);
    expect(dockTabSignature([{ id: 'voice', label: 'Голос' }]))
      .not.toBe(dockTabSignature([{ id: 'voice', label: 'Voice' }]));
  });

  it('is stable for an unchanged strip, so a drag still measures once', () => {
    expect(dockTabSignature(TABS)).toBe(dockTabSignature([...TABS]));
  });

  it('does not stringify element badges on the drag path', () => {
    const el = dockTabSignature([{ id: 'lan', label: 'LAN', badge: <i className="dot" /> }]);
    expect(el).toContain('#');
  });
});

// Shared by the tab menu and DockSoloHandle, so a strip-less solo zone can never
// offer a different set of moves from a tabbed one.
describe('buildDockMenuItems', () => {
  it('lists every destination, marking and disabling the current zone', () => {
    const { targets } = buildDockMenuItems(DOCK, 'voice');
    expect(targets.map((t) => t.key)).toEqual(['left', 'centre', 'right']);
    expect(targets[0].checked).toBe(true);
    expect(targets[0].disabled).toBe(true);
    expect(targets[1].disabled).toBe(false);
  });

  it('carries the refusal reason through, never a silent disable', () => {
    const { targets } = buildDockMenuItems(DOCK, 'voice');
    expect(targets[2].refusal).toBe('Last docked group');
    expect(targets[1].refusal).toBeNull();
  });

  it('appends on a menu move — there is no pointer, so no insertion index', () => {
    const calls: [string, string, number | null][] = [];
    const dock = { ...DOCK, onMovePanel: (p: string, z: string, i: number | null) => calls.push([p, z, i]) };
    buildDockMenuItems(dock, 'chat').targets[1].onSelect?.();
    expect(calls).toEqual([['chat', 'centre', null]]);
  });

  it('passes actions through with their refusals', () => {
    const { actions } = buildDockMenuItems(DOCK, 'chat');
    expect(actions.map((a) => a.key)).toEqual(['new-window']);
    expect(actions[0].refusal).toBeNull();
    expect(buildDockMenuItems({ ...DOCK, actions: undefined }, 'chat').actions).toEqual([]);
  });

  it('routes the menu through the caller supplied commit, so it announces too', () => {
    // The strip and DockSoloHandle both hand it `useDockMove(dock)`; the default is
    // only there so the pure builder is usable without a React realm.
    const seen: string[] = [];
    buildDockMenuItems(DOCK, 'chat', (p, z) => seen.push(`${p}->${z}`)).targets[1].onSelect?.();
    expect(seen).toEqual(['chat->centre']);
  });
});
