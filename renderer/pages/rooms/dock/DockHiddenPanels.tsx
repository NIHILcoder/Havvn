/**
 * DockHiddenPanels — the way BACK for a panel that was hidden.
 *
 * ── WHY THIS IS NOT IN THE DOCK ──────────────────────────────────────────────
 * The control that restores a hidden panel has to be reachable in the state it
 * exists for: several panels hidden, possibly every hideable one. Anything
 * anchored to a zone (a badge on the strip, a chip in the column) dies with its
 * zone, which is precisely the arrangement in which the user needs it — and "the
 * first non-empty docked zone" wanders unpredictably as panels are dragged, so
 * even the surviving variant is somewhere different every time.
 *
 * So this component draws NO surface of its own. It is a section meant to be
 * mounted in the room head bar's settings popover, directly above "Reset layout",
 * for exactly the reason that item lives there: the head bar is never detachable,
 * so it survives every dock state including one the user cannot click their way
 * out of. Reset layout is then the guaranteed escape sitting one row below the
 * restore list, which is what lets this list afford to be the only other route.
 *
 * ── WHAT IT IS, MECHANICALLY ─────────────────────────────────────────────────
 * A labelled group of ordinary `<button>`s in DOM order. No roving tabindex, no
 * portal, no fixed positioning: it is a list inside somebody else's popover, and
 * every item must be a normal Tab stop there, exactly like the "Copy code" /
 * "Rename" / "Reset layout" rows it sits among. That is the whole keyboard story
 * — and it is why this is a plain section and not a second `DockTabMenu`.
 *
 * It renders NOTHING when nothing is hidden (`items` empty ⇒ `null`), so the host
 * mounts it unconditionally instead of restating the emptiness test at the call
 * site, where it would be one more thing to get wrong.
 *
 * SURFACE STYLING IS THE HOST'S. `itemClassName` REPLACES the built-in button
 * class, so mounted in the popover the rows are literally `.room-settings-item`
 * and cannot drift from the rows above and below them; mounted anywhere else they
 * fall back to a self-sufficient `.dock-hidden-btn` built from theme tokens. This
 * file's own classes only do layout that both surfaces need (truncation, the
 * right-aligned destination hint).
 *
 * Like the rest of this folder it NEVER calls `t()`: labels, the group title, the
 * per-row accessible name and the destination hint all arrive translated.
 */
import React from 'react';
import type { DockHiddenPanelItem } from './dockHidden';
import { showsAllWorthOffering } from './dockHidden';
import './DockHiddenPanels.css';

export interface DockHiddenPanelsProps {
  /**
   * The hidden panels, in the order they should be listed (the model's hide order
   * — most recently hidden last — is the order the owner passes).
   */
  items: readonly DockHiddenPanelItem[];
  /** Group heading, already translated (`rooms.dock.hiddenGroup`). */
  title: string;
  /** Restore one panel. The id is the one from `items`. */
  onShow: (panelId: string) => void;
  /**
   * "Show all", already translated (`rooms.dock.showAll`). The row is drawn only
   * when this AND `onShowAll` are given AND more than one panel is hidden — with a
   * single hidden panel it would just repeat the row above it.
   */
  showAllLabel?: string;
  onShowAll?: () => void;
  /**
   * REPLACES the built-in row class. Pass the host surface's own item class
   * (`'room-settings-item'` in the room-settings popover) so the rows match the
   * menu they are part of. Omitted ⇒ the standalone `.dock-hidden-btn` look.
   */
  itemClassName?: string;
  /** Namespaces the heading id so two of these could coexist. */
  idPrefix?: string;
  /** Extra classes on the section wrapper. */
  className?: string;
}

export const DockHiddenPanels: React.FC<DockHiddenPanelsProps> = ({
  items,
  title,
  onShow,
  showAllLabel,
  onShowAll,
  itemClassName,
  idPrefix = 'dock-hidden',
  className,
}) => {
  // Nothing hidden ⇒ nothing at all, not an empty heading. The host mounts this
  // unconditionally; the emptiness rule lives in one place.
  if (items.length === 0) return null;

  const headingId = `${idPrefix}-title`;
  const rowClass = itemClassName ?? 'dock-hidden-btn';
  const showAll = showAllLabel !== undefined && onShowAll !== undefined
    && showsAllWorthOffering(items.length);

  return (
    <div
      className={`dock-hidden${className ? ` ${className}` : ''}`}
      // A group rather than a list: these are controls, and the heading is what
      // tells a screen reader why this cluster of buttons is one thing.
      role="group"
      aria-labelledby={headingId}
    >
      <div className="dock-hidden-title" id={headingId}>{title}</div>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          data-dock-hidden={it.id}
          className={`${rowClass} dock-hidden-item`}
          // The visible text is the bare panel name, which does not say that
          // activating the row brings it back; `showLabel` ("Show Voice") is the
          // accessible name, and it also carries the destination out of the
          // truncation-prone hint below.
          aria-label={it.showLabel ?? it.label}
          title={it.showLabel ?? it.label}
          onClick={() => onShow(it.id)}
        >
          {it.icon !== undefined && it.icon !== null && (
            <span className="dock-hidden-icon" aria-hidden="true">{it.icon}</span>
          )}
          <span className="dock-hidden-label">{it.label}</span>
          {/* Where it will land. aria-hidden because `showLabel` already names the
              action in full — read out here as well it would be said twice. */}
          {it.where && (
            <span className="dock-hidden-where" aria-hidden="true">{it.where}</span>
          )}
        </button>
      ))}
      {showAll && (
        <button
          type="button"
          data-dock-hidden-all=""
          className={`${rowClass} dock-hidden-item dock-hidden-all`}
          onClick={onShowAll}
        >
          <span className="dock-hidden-label">{showAllLabel}</span>
        </button>
      )}
    </div>
  );
};

export default DockHiddenPanels;
