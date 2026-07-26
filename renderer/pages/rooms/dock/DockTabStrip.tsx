/**
 * DockTabStrip — the tab bar of a dock zone (P1 of the rooms docking work).
 *
 * WHY NOT components/Tabs.tsx: that one is a 33-line stateless button row with
 * no ARIA roles, no roving tabindex and no keyboard handling — every button is a
 * tab stop, and a screen reader hears three unrelated buttons instead of a tab
 * set. It is also consumed by the Stage (RoomsPage.tsx) and re-exported from
 * components/index.ts, so growing it would ripple. This is a sibling, with its
 * own `dock-tab*` class prefix so the `.room-col-stage .tab-button` compaction
 * rules can never leak in either direction.
 *
 * ACCESSIBILITY (WAI-ARIA tabs pattern, automatic activation):
 *   - role="tablist" on the strip (named via `ariaLabel`), role="tab" on each
 *     button, aria-selected on all of them, aria-controls pointing at the panel
 *     DockZone renders with the matching id (see dockTabDomId/dockPanelDomId).
 *   - Roving tabindex: exactly ONE tab is in the page tab order (the selected
 *     one); the rest are tabIndex={-1} and reachable only by arrow keys. So Tab
 *     moves into the strip and then straight on into the panel body.
 *   - ArrowLeft/ArrowRight wrap and move focus AND selection; Home/End jump to
 *     the ends; Ctrl+PageUp/Ctrl+PageDown cycle. All key math lives in the pure
 *     `nextDockTabIndex` reducer below so it can be unit-tested without a DOM
 *     (the renderer test setup is renderToStaticMarkup — there is no jsdom).
 *
 * NARROW-RAIL BEHAVIOUR — decided, not accidental: the rail clamps to 180px
 * (RAIL_MIN), which leaves ~148px of content box; three natural-width tabs need
 * more than that. The strip COMPRESSES rather than scrolls (a scroller would
 * hide tabs behind a gesture and force scroll-into-view bookkeeping for keyboard
 * focus, for a zone that holds three fixed panels). Each tab is `flex: 1 1 0`
 * with `min-width: 0`; the icon and the badge never shrink, the label truncates
 * with an ellipsis, and `title` carries the full text. CSS truncation does not
 * change the accessible name, so assistive tech still hears the whole label.
 *
 * P1 has no drag affordances (that is P3), but the per-tab element is a single
 * forwardRef component (DockTabButton) precisely so a draggable can wrap it —
 * and hand it a DOM node — without this file having to be restructured.
 */

import React, { useRef } from 'react';
import './DockTabStrip.css';

export interface DockTabItem {
  id: string;
  /** Already-translated, user-visible label. Truncates at narrow rail widths. */
  label: string;
  icon?: React.ReactNode;
  /** Compact affix (a count, a live dot). Never shrinks; joins the tab's name. */
  badge?: React.ReactNode;
  /** Native tooltip; defaults to `label` since the label can be truncated. */
  title?: string;
}

export interface DockTabStripProps {
  tabs: DockTabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Accessible name for the tablist (a translated string from the caller). */
  ariaLabel?: string;
  /** Namespaces the generated DOM ids so several zones can coexist. */
  idPrefix?: string;
  className?: string;
}

/** DOM id of a tab button — DockZone pairs panels to tabs through these. */
export const dockTabDomId = (prefix: string, tabId: string): string => `${prefix}-tab-${tabId}`;
/** DOM id of the panel a tab controls; must be set on the rendered panel. */
export const dockPanelDomId = (prefix: string, tabId: string): string => `${prefix}-panel-${tabId}`;

/** The subset of a KeyboardEvent the reducer reads (so tests need no DOM). */
export interface DockTabKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Pure keyboard reducer: which tab index should become focused+selected.
 * Returns null when the key is not ours — the caller must then NOT
 * preventDefault, or it would eat the browser's own shortcuts.
 *
 * `current` may be out of range (nothing selected yet): "previous" then means
 * the last tab and "next" the first, instead of a modulo on a bogus index.
 */
export function nextDockTabIndex(
  ev: DockTabKeyEvent,
  current: number,
  count: number,
): number | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  const inRange = Number.isInteger(current) && current >= 0 && current < count;
  const prev = () => (inRange ? (current - 1 + count) % count : count - 1);
  const next = () => (inRange ? (current + 1) % count : 0);
  // Arrows/Home/End must stay plain: Ctrl+Arrow, Alt+Arrow and Shift+Home all
  // mean something else to the OS, the app or a text field.
  const plain = !ev.altKey && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey;
  const cycler = (ev.ctrlKey === true || ev.metaKey === true) && ev.altKey !== true;

  switch (ev.key) {
    case 'ArrowLeft': return plain ? prev() : null;
    case 'ArrowRight': return plain ? next() : null;
    case 'Home': return plain ? 0 : null;
    case 'End': return plain ? count - 1 : null;
    case 'PageUp': return cycler ? prev() : null;
    case 'PageDown': return cycler ? next() : null;
    default: return null;
  }
}

/**
 * The CYCLER half of the ladder — Ctrl/Cmd+PageUp/PageDown only, never arrows.
 *
 * The zone root attaches this, because the tab strip is a SIBLING of the panels,
 * not their ancestor: a handler on the tablist alone only fires while a tab button
 * has focus, which defeats the whole point of a cycle shortcut (you use it while
 * working INSIDE a panel). Arrows deliberately stay strip-only — inside a panel
 * they belong to lists, text fields and sliders.
 */
export function dockCycleIndex(ev: DockTabKeyEvent, current: number, count: number): number | null {
  if (ev.key !== 'PageUp' && ev.key !== 'PageDown') return null;
  return nextDockTabIndex(ev, current, count);
}

interface DockTabButtonProps {
  tab: DockTabItem;
  selected: boolean;
  tabDomId: string;
  panelDomId: string;
  onSelect: (id: string) => void;
}

/**
 * One tab. Kept a standalone forwardRef component so P3 can wrap it in a
 * draggable (which needs the element) without touching the strip's a11y wiring.
 */
export const DockTabButton = React.forwardRef<HTMLButtonElement, DockTabButtonProps>(
  ({ tab, selected, tabDomId, panelDomId, onSelect }, ref) => (
    <button
      ref={ref}
      type="button"
      role="tab"
      id={tabDomId}
      aria-selected={selected}
      aria-controls={panelDomId}
      tabIndex={selected ? 0 : -1}
      className={`dock-tab${selected ? ' selected' : ''}`}
      title={tab.title ?? tab.label}
      onClick={() => { if (!selected) onSelect(tab.id); }}
    >
      {tab.icon !== undefined && tab.icon !== null && (
        <span className="dock-tab-icon" aria-hidden="true">{tab.icon}</span>
      )}
      <span className="dock-tab-label">{tab.label}</span>
      {tab.badge !== undefined && tab.badge !== null && (
        <span className="dock-tab-badge">{tab.badge}</span>
      )}
    </button>
  ),
);
DockTabButton.displayName = 'DockTabButton';

export const DockTabStrip: React.FC<DockTabStripProps> = ({
  tabs,
  activeId,
  onSelect,
  ariaLabel,
  idPrefix = 'dock',
  className,
}) => {
  // Keyed by tab id, not index: the map survives a panel being added or moved
  // between zones in a later phase.
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const activeIndex = tabs.findIndex((t) => t.id === activeId);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = nextDockTabIndex(e, activeIndex, tabs.length);
    if (idx === null) return;
    e.preventDefault();
    e.stopPropagation(); // Ctrl+PageUp/Down is a plausible app-level shortcut too
    const target = tabs[idx];
    if (target.id !== activeId) onSelect(target.id);
    // Focus even when the selection did not change (Home on the first tab):
    // the roving tabindex means focus is the only thing that moved.
    btnRefs.current[target.id]?.focus();
  };

  return (
    <div
      className={`dock-tabstrip${className ? ` ${className}` : ''}`}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => (
        <DockTabButton
          key={tab.id}
          ref={(el) => { btnRefs.current[tab.id] = el; }}
          tab={tab}
          selected={tab.id === activeId}
          tabDomId={dockTabDomId(idPrefix, tab.id)}
          panelDomId={dockPanelDomId(idPrefix, tab.id)}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
};
