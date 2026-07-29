/**
 * dockHidden — the HIDE action and the RESTORE list, as data.
 *
 * Two halves of one feature ("a panel can be gone from the UI, not just inactive"),
 * kept here as pure builders so both are unit-testable without a DOM and so the
 * dock folder's rule holds: NOTHING here calls `t()` or touches the model. The
 * owner (RoomsPage) translates, asks the model whether the op is allowed, and hands
 * the answers down already-shaped.
 *
 * ── WHY THE HIDE ACTION IS NOT NEW MENU MACHINERY ────────────────────────────
 * Hiding is offered as one more `DockTabAction`, which is the item shape the
 * per-tab menu already renders — including the part that matters most here, a
 * REFUSAL WITH ITS REASON (`DockTabMenu` renders a refused item `aria-disabled`
 * rather than `disabled`, keeps it focusable, hangs the reason off it as the
 * accessible description AND draws it inline). So a hide that the model refuses is
 * VISIBLE with its explanation instead of being an item that does nothing, or —
 * worse — an item that is simply absent, which is the same silent no-op wearing a
 * different hat.
 *
 * The payoff of going through `DockStripInteractions.actions` rather than adding a
 * dedicated leg: `buildDockMenuItems` is shared by `DockTabStrip`'s per-tab menu
 * and by `DockSoloHandle` (the affordance a strip-less solo zone gets instead of a
 * tab), so ONE construction site puts Hide in BOTH menus and they cannot drift.
 * A strip-less Files or Chat column would otherwise be the one place the user
 * could not hide the panel they are looking at.
 *
 * INTEGRATION (RoomsPage's `dockInteractions`, inside `actions:`):
 *
 *     return withHidePanelAction(acts, {
 *       label: t('rooms.dock.hidePanel'),
 *       // null when allowed; the refusal text when not. NEVER drop the action.
 *       refusal: refusalText(hideTarget(dock, panel).refused),
 *       onHide: () => runDockOp((l) => hidePanel(l, panel), focusAfterHide, zoneToast),
 *     });
 *
 * i18n keys this feature needs (BOTH en.json and ru.json — the integrator adds
 * them; this folder only ever receives the finished strings):
 *   rooms.dock.hidePanel      "Hide this panel"
 *   rooms.dock.hiddenGroup    "Hidden panels"
 *   rooms.dock.showPanel      "Show {panel}"
 *   rooms.dock.showAll        "Show all"
 *   rooms.dock.hiddenAnnounce "{panel} hidden — restore it from room settings"
 *   rooms.dock.restored       "{panel} shown in {zone}"
 * NO new refusal key: hiding the last visible panel is refused for exactly the
 * reason a detach is, so it reuses `rooms.dock.refuse.lastGroup`.
 */

import type { ReactNode } from 'react';
import type { DockTabAction } from './DockTabStrip';

/**
 * The action's stable key. Exported because the menu identifies items by key, so
 * a test (or a future "is hiding offered here?" check) must not restate the
 * literal and drift from the builder.
 */
export const DOCK_HIDE_ACTION_KEY = 'hide';

export interface DockHideActionSpec {
  /** Already-translated (`rooms.dock.hidePanel`). This folder never calls t(). */
  label: string;
  /**
   * Non-null ⇒ the model REFUSES this hide, and this string says why. The action
   * is still listed: `DockTabMenu` renders it focusable, muted and explained.
   *
   * Passing `undefined`/`null` means "allowed". Omitting the whole action when the
   * model refuses is the one thing a caller must not do — an item that vanishes
   * teaches the user nothing and reads as the feature being broken.
   */
  refusal?: string | null;
  /**
   * THE commit. Called at most once per menu pick, and only when `refusal` is
   * null (the menu blocks activation of a refused item). Deliberately NOT wrapped
   * in a "don't run when refused" guard here: the model op refuses again and
   * toasts, so a bug shows up as a visible refusal rather than as a swallowed one.
   */
  onHide: () => void;
}

/** The Hide item for one panel's menu, in the shape both menus already render. */
export function buildHidePanelAction(spec: DockHideActionSpec): DockTabAction {
  return {
    key: DOCK_HIDE_ACTION_KEY,
    label: spec.label,
    // Normalised to null so `refusal ?? null` downstream is never load-bearing.
    refusal: spec.refusal ?? null,
    onSelect: spec.onHide,
  };
}

/**
 * Append Hide to a zone's existing actions, LAST.
 *
 * Order is the point: "Open in new window" / "Move this group…" / "Dock back"
 * are all placements — they say where the panel goes. Hide is the one that makes
 * it go away, so it sits at the end of the list, furthest from the item a user
 * reaches for by muscle memory.
 *
 * Idempotent: an existing hide entry is replaced rather than duplicated, so this
 * can be applied to an action list that already went through it (a re-render, a
 * caller that composes two helpers) without producing two Hide rows.
 */
export function withHidePanelAction(
  actions: readonly DockTabAction[],
  spec: DockHideActionSpec,
): DockTabAction[] {
  return [
    ...actions.filter((a) => a.key !== DOCK_HIDE_ACTION_KEY),
    buildHidePanelAction(spec),
  ];
}

/** Is this the hide item? Keeps the key literal in one place for callers too. */
export function isHidePanelAction(a: { key: string }): boolean {
  return a.key === DOCK_HIDE_ACTION_KEY;
}

// ── the restore list ────────────────────────────────────────────────────────

/**
 * One hidden panel, as the restore surface needs it. Everything is already
 * translated and already resolved by the owner — this folder does not know that
 * `voice` is called "Voice", nor that showing it puts it back in the left column.
 */
export interface DockHiddenPanelItem {
  /** Panel id, handed straight back to `onShow`. */
  id: string;
  /** Already-translated panel name, e.g. "Voice". */
  label: string;
  /** Usually the panel's registry `<Icon>`. Rendered `aria-hidden`. */
  icon?: ReactNode;
  /**
   * Where showing it will put it, already-translated (e.g. "Left column").
   * Optional but strongly wanted: a panel restored into a column the user is not
   * looking at (or behind the stage overlay) otherwise looks like a no-op.
   */
  where?: string;
  /**
   * The row's accessible name, already-translated and composed —
   * `t('rooms.dock.showPanel').replace('{panel}', name)`. The visible text is the
   * bare panel name, which on its own does not say that clicking it shows the
   * panel. Falls back to `label`.
   */
  showLabel?: string;
}

/**
 * Is a "Show all" row worth drawing? Only above one item: with a single hidden
 * panel it would be a second control that does exactly what the row above it does.
 */
export function showsAllWorthOffering(count: number): boolean {
  return Number.isInteger(count) && count > 1;
}
