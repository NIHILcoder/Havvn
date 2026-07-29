import { describe, it, expect, vi } from 'vitest';

import {
  DOCK_HIDE_ACTION_KEY,
  buildHidePanelAction,
  isHidePanelAction,
  showsAllWorthOffering,
  withHidePanelAction,
} from './dockHidden';
import { buildDockMenuItems } from './DockTabStrip';
import type { DockStripInteractions, DockTabAction } from './DockTabStrip';

const HIDE = { label: 'Hide this panel', onHide: () => {} };

describe('buildHidePanelAction', () => {
  it('uses the shared key so the menu and its callers cannot drift', () => {
    expect(buildHidePanelAction(HIDE).key).toBe(DOCK_HIDE_ACTION_KEY);
    expect(isHidePanelAction(buildHidePanelAction(HIDE))).toBe(true);
  });

  it('normalises "allowed" to a null refusal', () => {
    expect(buildHidePanelAction(HIDE).refusal).toBeNull();
    expect(buildHidePanelAction({ ...HIDE, refusal: undefined }).refusal).toBeNull();
  });

  it('KEEPS the action when the model refuses, carrying the reason', () => {
    // The whole point: a hide the model will not allow must be listed and
    // explained. Omitting it (or disabling it silently) is the no-op this dock
    // forbids everywhere else.
    const a = buildHidePanelAction({ ...HIDE, refusal: 'At least one panel has to stay.' });
    expect(a.label).toBe('Hide this panel');
    expect(a.refusal).toBe('At least one panel has to stay.');
  });

  it('commits through the caller"s handler, untouched', () => {
    const onHide = vi.fn();
    buildHidePanelAction({ label: 'Hide', onHide }).onSelect();
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});

describe('withHidePanelAction', () => {
  const acts: DockTabAction[] = [
    { key: 'new-window', label: 'Open in new window', onSelect: () => {} },
    { key: 'dock-back', label: 'Dock back', onSelect: () => {} },
  ];

  it('appends LAST, leaving the placement actions in their order', () => {
    const out = withHidePanelAction(acts, HIDE);
    expect(out.map((a) => a.key)).toEqual(['new-window', 'dock-back', DOCK_HIDE_ACTION_KEY]);
  });

  it('does not mutate the caller"s array', () => {
    withHidePanelAction(acts, HIDE);
    expect(acts).toHaveLength(2);
  });

  it('is idempotent — reapplying replaces rather than duplicating', () => {
    const once = withHidePanelAction(acts, HIDE);
    const twice = withHidePanelAction(once, { ...HIDE, label: 'Hide (again)' });
    expect(twice.filter(isHidePanelAction)).toHaveLength(1);
    expect(twice[twice.length - 1].label).toBe('Hide (again)');
  });

  it('works from an empty action list (a plain docked zone with one panel)', () => {
    expect(withHidePanelAction([], HIDE).map((a) => a.key)).toEqual([DOCK_HIDE_ACTION_KEY]);
  });
});

/**
 * The claim this pins: routing Hide through `DockStripInteractions.actions` puts it
 * in BOTH menus. `buildDockMenuItems` is the shared builder — DockTabStrip's per-tab
 * menu and DockSoloHandle's grip menu each call it — so an item that survives this
 * function is an item both menus render.
 */
describe('Hide reaches the tab menu and the solo handle through one builder', () => {
  const dockWith = (refusal: string | null, onHide = () => {}): DockStripInteractions => ({
    zoneId: 'left',
    moveTargets: () => [{ zone: 'left', label: 'Left column', current: true }],
    actions: () => withHidePanelAction(
      [{ key: 'new-window', label: 'Open in new window', onSelect: () => {} }],
      { label: 'Hide this panel', refusal, onHide },
    ),
    onMovePanel: () => {},
    labels: { moveTo: 'Move to', tabMenu: 'Panel actions' },
  });

  it('lists the hide item with its refusal, which is what makes it VISIBLE-but-refused', () => {
    const { actions } = buildDockMenuItems(dockWith('At least one panel has to stay.'), 'voice');
    const hide = actions.find((a) => a.key === DOCK_HIDE_ACTION_KEY);
    // DockTabMenu turns a non-null `refusal` into aria-disabled + the reason as the
    // accessible description AND as inline text; that is the contract being relied on.
    expect(hide?.refusal).toBe('At least one panel has to stay.');
    expect(hide?.label).toBe('Hide this panel');
  });

  it('keeps the commit wired when the hide is allowed', () => {
    const onHide = vi.fn();
    const { actions } = buildDockMenuItems(dockWith(null, onHide), 'voice');
    actions.find((a) => a.key === DOCK_HIDE_ACTION_KEY)?.onSelect?.();
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('never becomes a move destination — hiding is an action, not a zone', () => {
    const { targets } = buildDockMenuItems(dockWith(null), 'voice');
    expect(targets.some(isHidePanelAction)).toBe(false);
  });
});

describe('showsAllWorthOffering', () => {
  it('offers "Show all" only above one hidden panel', () => {
    expect(showsAllWorthOffering(0)).toBe(false);
    // With one hidden panel the row would do exactly what the row above it does.
    expect(showsAllWorthOffering(1)).toBe(false);
    expect(showsAllWorthOffering(2)).toBe(true);
  });
});
