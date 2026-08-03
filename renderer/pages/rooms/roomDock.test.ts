import { describe, it, expect } from 'vitest';
import { soloHandleZone, pttWindowSet } from './roomDock';
import {
  defaultDockLayout, movePanel, detachPanel, DOCK_SOLO_HOST_IDS, DOCK_PANEL_IDS,
  DOCK_DOCKED_ZONE_IDS, zonePanels, isDockedZone, zoneOfPanel,
} from './dock/dockModel';
import type { DockLayout, DockPanelId, DockZoneId } from './dock/dockModel';

/**
 * DockZone's strip-hiding rule, restated independently of the implementation:
 *   a DOCKED zone (window zones always keep their strip)
 *   holding exactly ONE panel
 *   which declares it hosts its own header row.
 * `soloHandleZone` must agree with this for every panel in every layout — the two
 * halves are in different files, and a disagreement is invisible: either a solo
 * panel has NO way to be moved out, or the room draws two move affordances one row
 * apart.
 */
function stripIsHidden(l: DockLayout, panel: DockPanelId): DockZoneId | null {
  for (const z of DOCK_DOCKED_ZONE_IDS) {
    const panels = zonePanels(l, z);
    const solo = panels.length === 1 && DOCK_SOLO_HOST_IDS.includes(panels[0]);
    if (solo && panels[0] === panel) return z;
  }
  return null;
}

const agree = (l: DockLayout): void => {
  for (const p of DOCK_PANEL_IDS) expect(soloHandleZone(l, p)).toBe(stripIsHidden(l, p));
};

describe('soloHandleZone', () => {
  it('gives the DEFAULT room a handle for chat, and for nothing else', () => {
    const l = defaultDockLayout();
    expect(soloHandleZone(l, 'chat')).toBe('right');
    // Files shares the centre with the server panel, and the three-panel rail keeps
    // its strip, so neither column's panels host a handle.
    expect(soloHandleZone(l, 'files')).toBeNull();
    expect(soloHandleZone(l, 'server')).toBeNull();
    expect(soloHandleZone(l, 'people')).toBeNull();
    expect(soloHandleZone(l, 'voice')).toBeNull();
    expect(soloHandleZone(l, 'lan')).toBeNull();
    agree(l);
  });

  it('drops the handle the moment the zone gains a second panel (the strip is back)', () => {
    const solo = movePanel(defaultDockLayout(), 'server', 'left').layout;
    expect(soloHandleZone(solo, 'files')).toBe('centre');
    const l = movePanel(solo, 'people', 'centre').layout;
    expect(zonePanels(l, 'centre')).toHaveLength(2);
    expect(soloHandleZone(l, 'files')).toBeNull();
    agree(l);
  });

  it('never offers a handle to a panel that renders no header of its own', () => {
    // Voice alone in a docked zone: the strip is its ONLY affordance, because the
    // zone body is a drop target and never a drag source.
    let l = defaultDockLayout();
    for (const p of ['files', 'server', 'people'] as const) l = movePanel(l, p, 'left').layout;
    l = movePanel(l, 'voice', 'centre').layout;
    expect(zonePanels(l, 'centre')).toEqual(['voice']);
    expect(soloHandleZone(l, 'voice')).toBeNull();
    agree(l);
  });

  it('never offers a handle inside a torn-off window', () => {
    const l = detachPanel(defaultDockLayout(), 'chat').layout;
    const zone = zoneOfPanel(l, 'chat');
    expect(zone && isDockedZone(zone)).toBe(false);
    expect(soloHandleZone(l, 'chat')).toBeNull();
    agree(l);
  });

  it('follows a solo panel as it moves between docked zones', () => {
    const l = movePanel(defaultDockLayout(), 'chat', 'centre').layout;
    // chat now shares the centre with files and server, so none of them is solo…
    expect(soloHandleZone(l, 'chat')).toBeNull();
    const l2 = movePanel(movePanel(l, 'files', 'left').layout, 'server', 'left').layout;
    // …and once they leave, chat is solo in the CENTRE, not in the right column.
    expect(soloHandleZone(l2, 'chat')).toBe('centre');
    agree(l2);
  });

  it('agrees with the strip rule across every single-panel placement', () => {
    for (const panel of DOCK_PANEL_IDS) {
      for (const zone of DOCK_DOCKED_ZONE_IDS) {
        agree(movePanel(defaultDockLayout(), panel, zone).layout);
      }
    }
  });
});

describe('pttWindowSet', () => {
  const main = { closed: false };

  it('binds the main window alone when nothing is torn off', () => {
    expect(pttWindowSet(main, [])).toEqual([main]);
  });

  it('binds every live dock window as well — a key only reaches the FOCUSED one', () => {
    const w1 = { closed: false }, w2 = { closed: false };
    expect(pttWindowSet(main, [w1, w2])).toEqual([main, w1, w2]);
  });

  it('keeps the main window first, so the docked case is unchanged', () => {
    const w1 = { closed: false };
    expect(pttWindowSet(main, [w1])[0]).toBe(main);
  });

  it('drops closed and absent windows rather than binding a dead document', () => {
    const dead = { closed: true }, live = { closed: false };
    expect(pttWindowSet(main, [dead, null, undefined, live])).toEqual([main, live]);
  });

  it('de-duplicates, so a panel whose own realm is already in the set binds once', () => {
    const w1 = { closed: false };
    // The voice panel appends its own host after the registry set; if it is already
    // there, binding twice would fire `set(true)` twice and, worse, `blur` twice.
    expect(pttWindowSet(main, [w1, w1, main])).toEqual([main, w1]);
  });
});
