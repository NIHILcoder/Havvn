/**
 * DockZone — the shell for ONE dock zone: a DockTabStrip on top, the active panel
 * below, wrapped in the zone's own framing.
 *
 * A "zone" is a region of the room that hosts a set of dockable panels and shows
 * one at a time. P1 wires exactly one zone (the left rail, which today stacks
 * Voice + LAN + People into a 180-360px column); later phases repeat this same
 * component for other zones and move panels between them. Everything a zone needs
 * arrives as props — DockZone knows nothing about rooms, voice, LAN, the registry
 * or i18n — so a second zone is a second `<DockZone>`, not a second implementation.
 *
 * It pairs with:
 *   - dockModel.ts    — which panels live in which zone, and which one is active
 *                       (versioned + self-repairing; guarantees a zone is never
 *                       empty, which is what lets this component assume `panels`
 *                       has at least one entry).
 *   - DockTabStrip.tsx — the ARIA tablist. DockZone owns the panel side of that
 *                       relationship and reuses the strip's own id helpers, so the
 *                       aria-controls ⇄ id pairing can never drift.
 *
 * ── Framing ───────────────────────────────────────────────────────────────────
 * The zone does NOT reinvent the room's chrome. The host's existing class (today
 * `room-col-rail`, which carries the border, background, padding, `overflow:hidden`
 * and the two corner-bracket pseudo-elements) is passed in via `className` and
 * lands on the zone root alongside `dock-zone`. DockZone.css only adds the
 * strip/panel flex plumbing — no colours, no radii, no borders, no padding.
 *
 * ── Mount policy: inactive panels are UNMOUNTED (P1) ──────────────────────────
 * This is the load-bearing decision in this file, so it is stated outright:
 *
 *   By default, switching tabs UNMOUNTS the panel you left and MOUNTS the one you
 *   arrived at. Only the active panel exists in the DOM.
 *
 * Why that is the P1 default: it preserves today's semantics. It is what the room
 * already does for swapped-out content — RoomStage deliberately conditional-renders
 * the player and the screen viewer so their presence-leave / watchStop cleanup
 * fires — and the repo's habit is that an unmounted panel is a released panel.
 * Keeping every panel alive forever would quietly redefine "hidden" as "still
 * running", which is both the harder default to reason about and the harder one to
 * walk back later.
 *
 * Why the escape hatch exists anyway: a panel whose unmount does real work, or
 * whose in-memory state is expensive to lose, opts out per panel with
 * `keepAlive: true` on its `DockZonePanel` — WITHOUT any caller changing shape. A
 * keep-alive panel mounts lazily (the first time it becomes active) and from then
 * on stays mounted, rendered with the `hidden` attribute while inactive. Two rail
 * panels are the obvious future candidates, and the reasons are concrete:
 *   • RoomVoicePanel — its unmount cleanup flushes the debounced voice-settings
 *     push and tears down the push-to-talk key listeners and the voice-warning
 *     subscription. A user mid-call who opens the LAN tab would lose PTT.
 *   • RoomLanPanel — its latched terminal-failure map (`failLatch`) exists so a
 *     reaped-and-instantly-rebuilt peer stops strobing; the latch dies with the
 *     panel and the honest failure message starts flapping again on return.
 * Flipping either is a one-word change where the panels are declared, not a
 * rewrite here and not a change at any call site.
 *
 * ── Query container ───────────────────────────────────────────────────────────
 * The zone root is a named query container (`container-name: dock`). Panels that
 * need to respond to how much room THEY have — rather than how wide the whole room
 * page is — can write `@container dock (...)`, and they keep working when a later
 * phase moves them out of the room's own column into a zone whose width no longer
 * tracks what the `room` container measures. Existing `@container room (...)` rules
 * inside a panel are unaffected: a NAMED query walks past containers carrying a
 * different name, up to `.room-detail-inner`.
 * CAUTION: `container-type` establishes containment, which traps `position:fixed`
 * descendants. Any overlay rendered inside a panel must portal OUT to the body of
 * the document that panel lives in — `realm.document.body` / an anchor element's
 * `ownerDocument.body`, never the module-scope `document`, or a zone hosted in a
 * detached window sends its overlay to the main window instead (LanPeerPicker,
 * LanDiagnosticsModal and ProfileCard all resolve it that way).
 *
 * No drag-and-drop, no tear-off, no reordering here — P1 is selection only.
 */
import React, { useRef } from 'react';
import { DockTabStrip, dockTabDomId, dockPanelDomId, dockCycleIndex } from './DockTabStrip';
import './DockZone.css';

/**
 * One panel as this zone sees it. The panel REGISTRY owns identity (id, i18n key,
 * icon name, default zone); a zone receives the already-RESOLVED presentation, so
 * DockZone never calls `t()` and never imports Icon.
 */
export interface DockZonePanel<P extends string = string> {
  /** Stable panel id. Also the render-map key and part of the paired DOM ids. */
  id: P;
  /** Already-translated tab label. */
  label: string;
  /** Already-rendered tab icon element (the registry decides the icon and size). */
  icon?: React.ReactNode;
  /** Compact affix on the tab — a count, a live dot. Pure passthrough. */
  badge?: React.ReactNode;
  /**
   * Native tooltip for the tab. Worth setting whenever a `badge` carries meaning
   * the label does not: the badge sits INSIDE the button, so assistive tech reads
   * it as part of the tab's name ("People 3/8, tab") with nothing explaining it.
   * Defaults to the label in the strip.
   */
  title?: string;
  /**
   * Opt out of the unmount-on-switch default: once mounted, this panel stays
   * mounted and is merely `hidden` while another tab is active. Read the mount
   * policy in the file header before turning this on.
   */
  keepAlive?: boolean;
}

export interface DockZoneProps<P extends string = string> {
  /** Zone identity ('rail' in P1). Namespaces the DOM ids; also a `data-` hook. */
  zoneId: string;
  /** The panels docked here, in tab order. The model guarantees this is non-empty. */
  panels: readonly DockZonePanel<P>[];
  /** The selected panel. Repaired to the first panel if it is not in `panels`. */
  activeId: P;
  /** Selection request from the strip. The owner persists it; the zone does not. */
  onSelect: (panelId: P) => void;
  /** The render map: panel id → its content. Called only for MOUNTED panels. */
  renderPanel: (panelId: P) => React.ReactNode;
  /** Accessible name for the tab strip, already translated. */
  ariaLabel: string;
  /** Host framing classes for the zone root, e.g. 'room-col-rail'. */
  className?: string;
  /** Drop the strip when there is only one panel (RoomStage's existing habit). */
  hideSingleTab?: boolean;
}

export interface DockMountResult<P extends string = string> {
  /** `activeId` repaired against the actual panel list (empty if there are none). */
  activeId: P | '';
  /** Panel ids to render this pass, in tab order. */
  mounted: P[];
  /** Next keep-alive set: ids that have been activated and asked to stay mounted. */
  alive: P[];
}

/**
 * Pure mount resolver — the entire tab-switch policy, extracted so it is testable
 * without a DOM. (Renderer tests are renderToStaticMarkup string assertions; there
 * is no jsdom, so a stateful switch SEQUENCE can only be exercised here.)
 *
 * Rules, in order:
 *  1. An `activeId` that is not in `panels` is repaired to the first panel rather
 *     than rendering nothing — a zone pointed at a stale id must still show
 *     something. (dockModel repairs this too; the zone declines to trust it.)
 *  2. Keep-alive ids for panels that have since LEFT this zone are pruned, so
 *     moving a panel between zones in a later phase cannot leak a mount.
 *  3. A keep-alive panel mounts EAGERLY — it is alive from the first resolve, not
 *     from the first time it happens to be selected.
 *
 *     This must NOT be lazy. Before the dock existed these panels were stacked and
 *     therefore ALWAYS mounted, and keepAlive exists precisely because their mount
 *     owns app-level behaviour: RoomVoicePanel holds the voice-warning subscription,
 *     the PTT listeners and a debounced settings flush; RoomLanPanel holds the
 *     terminal-failure latch. With lazy mounting, a user whose persisted tab is
 *     People would run a whole session with the voice panel never mounted — voice
 *     warnings would silently stop arriving. Eager keeps the pre-dock semantics.
 *  4. Everything else: only the active panel is mounted.
 *
 * Idempotent for a fixed (panels, activeId): resolve(resolve(x).alive) is stable.
 */
export function resolveDockMount<P extends string>(
  panels: readonly DockZonePanel<P>[],
  activeId: P | '',
  alive: readonly P[] = [],
): DockMountResult<P> {
  const ids = panels.map((p) => p.id);
  const active: P | '' = ids.includes(activeId as P) ? (activeId as P) : (ids[0] ?? '');
  const nextAlive = alive.filter((id) => ids.includes(id));
  // EAGER: every keep-alive panel in this zone is alive from the first resolve,
  // regardless of which tab is active (rule 3 — a lazily-mounted voice panel would
  // mean no voice-warning subscription for a user whose saved tab is People).
  for (const p of panels) if (p.keepAlive && !nextAlive.includes(p.id)) nextAlive.push(p.id);
  const mounted = ids.filter((id) => id === active || nextAlive.includes(id));
  return { activeId: active, mounted, alive: nextAlive };
}

/**
 * Generic over the panel-id union (like dockModel) so a caller passing
 * `DockPanelId` keeps its narrowing all the way through `renderPanel` — hence a
 * plain generic function component rather than `React.FC`.
 */
export function DockZone<P extends string = string>({
  zoneId,
  panels,
  activeId,
  onSelect,
  renderPanel,
  ariaLabel,
  className,
  hideSingleTab = false,
}: DockZoneProps<P>): React.ReactElement {
  const idPrefix = `dock-${zoneId}`;

  // The keep-alive set lives in a ref rather than state: it is derived bookkeeping,
  // and resolving it during render keeps the mount decision in the same pass as the
  // markup (an effect would mount the panel a frame late, and would not run at all
  // under renderToStaticMarkup). resolveDockMount is pure and idempotent for a given
  // (panels, activeId), so a StrictMode double render lands on the same result.
  const aliveRef = useRef<P[]>([]);
  const { activeId: active, mounted, alive } = resolveDockMount(panels, activeId, aliveRef.current);
  aliveRef.current = alive;

  const showStrip = panels.length > 1 || !hideSingleTab;
  const rootClass = ['dock-zone', `dock-zone-${zoneId}`, className].filter(Boolean).join(' ');

  // Ctrl/Cmd+PageUp/PageDown is handled HERE, on the element that wraps both the
  // strip and the panels, because the strip is the panels' SIBLING — a handler on
  // the tablist alone would only fire while a tab button has focus, i.e. never in
  // the situation the shortcut exists for (cycling while working inside a panel).
  // The strip stops propagation for its own keys, so this cannot double-fire.
  const onRootKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const idx = dockCycleIndex(e, panels.findIndex((p) => p.id === active), panels.length);
    if (idx === null) return;
    e.preventDefault();
    e.stopPropagation();
    const target = panels[idx];
    if (target && target.id !== active) onSelect(target.id);
  };

  return (
    <div className={rootClass} data-dock-zone={zoneId} onKeyDown={onRootKeyDown}>
      {showStrip && (
        <DockTabStrip
          idPrefix={idPrefix}
          ariaLabel={ariaLabel}
          tabs={panels.map((p) => ({ id: p.id, label: p.label, icon: p.icon, badge: p.badge, title: p.title }))}
          activeId={active}
          onSelect={(id) => onSelect(id as P)}
        />
      )}
      {mounted.map((id) => (
        <div
          key={id}
          id={dockPanelDomId(idPrefix, id)}
          className={`dock-panel dock-panel-${id}`}
          data-dock-panel={id}
          // With no strip there is no tab to be labelled by, so the tabpanel role
          // would dangle — it degrades to a plain div in that case.
          role={showStrip ? 'tabpanel' : undefined}
          aria-labelledby={showStrip ? dockTabDomId(idPrefix, id) : undefined}
          // The WAI-ARIA tabs pattern puts the panel in the tab order right after
          // the (roving) strip, which is also what makes an internally scrolling
          // panel reachable by keyboard.
          tabIndex={showStrip ? 0 : undefined}
          // Only ever true for keep-alive panels — unmounted ones are simply absent
          // from `mounted`.
          hidden={id !== active}
        >
          {renderPanel(id)}
        </div>
      ))}
    </div>
  );
}

export default DockZone;
