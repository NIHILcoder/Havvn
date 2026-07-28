/**
 * DockZone — the shell for ONE dock zone: a DockTabStrip on top, the active panel
 * below, wrapped in the zone's own framing.
 *
 * A "zone" is a region of the room that hosts a set of dockable panels and shows
 * one at a time. P1 wired exactly one zone (the left rail); P3 repeated it for the
 * centre and right columns and for each torn-off window. Everything a zone needs
 * arrives as props — DockZone knows nothing about rooms, voice, LAN, the registry
 * or i18n — so a second zone is a second `<DockZone>`, not a second implementation.
 *
 * It pairs with:
 *   - dockModel.ts    — which panels live in which zone, and which one is active
 *                       (versioned + self-repairing).
 *   - DockTabStrip.tsx — the ARIA tablist. DockZone owns the panel side of that
 *                       relationship and reuses the strip's own id helpers, so the
 *                       aria-controls ⇄ id pairing can never drift.
 *   - dockMounts.ts / DockPanelMounts.tsx — P4's hoisted mounts (below).
 *
 * ── Framing ───────────────────────────────────────────────────────────────────
 * The zone does NOT reinvent the room's chrome. The host's existing class (today
 * `room-col-rail`, which carries the border, background, padding, `overflow:hidden`
 * and the two corner-bracket pseudo-elements) is passed in via `className` and
 * lands on the zone root alongside `dock-zone`. DockZone.css only adds the
 * strip/panel flex plumbing — no colours, no radii, no borders, no padding.
 *
 * ── Mount policy: inactive panels are UNMOUNTED ───────────────────────────────
 * This is the load-bearing decision, so it is stated outright:
 *
 *   By default, switching tabs UNMOUNTS the panel you left and MOUNTS the one you
 *   arrived at. Only the active panel exists in the DOM.
 *
 * Why: it preserves the room's pre-dock semantics — an unmounted panel is a
 * released panel, and keeping every panel alive forever would quietly redefine
 * "hidden" as "still running".
 *
 * The escape hatch: a panel whose unmount does real work opts out per panel with
 * `keepAlive: true`, mounting EAGERLY and staying mounted, rendered `hidden` while
 * inactive. Two rail panels need it and the reasons are concrete:
 *   • RoomVoicePanel — its unmount flushes the debounced voice-settings push and
 *     tears down the push-to-talk listeners and the voice-warning subscription.
 *   • RoomLanPanel — its latched terminal-failure map (`failLatch`) exists so a
 *     reaped-and-instantly-rebuilt peer stops strobing.
 *
 * ── P4: WHERE that policy is applied — the `mounts` prop ─────────────────────
 * The RULE above is unchanged. WHO applies it moved.
 *
 * Through P3 each zone resolved its own mount set here (`resolveDockMount` plus a
 * per-instance `aliveRef`). Two zones are two component instances with two refs, so
 * keep-alive could not span a MOVE by construction: dragging Chat to another column
 * unmounted it in one subtree and mounted a fresh instance in the other, destroying
 * exactly the state keepAlive exists to protect.
 *
 * So the owner now resolves the live set for every zone at once
 * (`resolveLiveMounts`), mounts each live panel exactly ONCE from a stable tree
 * position (`DockPanelMounts`), and hands each zone its share as `mounts`. The zone
 * then renders SLOTS — the same `.dock-panel` wrapper with the same id, role,
 * aria-labelledby, tabIndex and hidden — and the owner's registry parks the panel's
 * stable container inside via `mounts.slotRef(id)`. A move becomes one
 * `appendChild`, and React never sees it.
 *
 * `renderPanel` remains for the P1/P3 inline path and is unchanged. Supply exactly
 * one of the two: `mounts` wins if both are given.
 *
 * ── P4: why the drag and keyboard handlers are NATIVE ────────────────────────
 * A portalled child's React tree position is elsewhere, so synthetic events from
 * inside a hoisted panel do NOT bubble through this component. Two things depended
 * on that and would have silently stopped working:
 *   • Ctrl/Cmd+PageUp/PageDown, whose whole purpose is to fire while focus is
 *     INSIDE a panel;
 *   • the zone-BODY drop target, which is the whole column and is what "put Chat
 *     over there" actually means (the strip is ~24px tall and at the 180px rail
 *     minimum that is a hostile Fitts target).
 * Both are now real DOM listeners on the zone root. The DOM hierarchy is fully
 * intact after adoption — only the React one is not. They skip any event whose
 * target is inside `.dock-tabstrip`, because the strip's synthetic
 * `stopPropagation` cannot stop a native listener on an intermediate node (React
 * delegates at its root container, which is downstream of us). The drag path is
 * native-ONLY, never native and React both, or a drop over the zone's own padding
 * would fire twice and move the panel twice.
 *
 * ── Query container ───────────────────────────────────────────────────────────
 * The zone root is a named query container (`container-name: dock`). Panels that
 * need to respond to how much room THEY have — rather than how wide the whole room
 * page is — can write `@container dock (...)`, and they keep working when a panel
 * moves into a zone whose width no longer tracks what the `room` container measures.
 * CAUTION: `container-type` establishes containment, which traps `position:fixed`
 * descendants. Any overlay rendered inside a panel must portal OUT to the body of
 * the document that panel lives in — `realm.document.body` / an anchor element's
 * `ownerDocument.body`, never the module-scope `document`.
 *
 * ── An EMPTY zone, and a HIDDEN one ──────────────────────────────────────────
 * A docked zone MAY hold nothing (that is what "Voice and Chat together on the
 * second monitor" does to a column). `activeId` is then '' and `panels` is empty —
 * the zone renders its ROOT AND NOTHING ELSE. It must still render the root: the
 * three columns are grid children by POSITION, and a zone that vanished would shift
 * the ones after it.
 *
 * `hidden` is the other half of that rule, for the stage overlay: the centre column
 * also hosts the watch player and the screen viewer, and CONDITIONALLY RENDERING
 * the zone around them would tear down its slots, its tab strip, its keyboard path
 * and its ARIA tablist mid-session. The host hides the zone instead, so DockZone's
 * own mount policy — not the stage — keeps deciding what stays mounted.
 */
import React, { useEffect, useRef } from 'react';
import { DockTabStrip, dockTabDomId, dockPanelDomId, dockCycleIndex, useDockMove } from './DockTabStrip';
import type { DockStripInteractions } from './DockTabStrip';
import {
  DOCK_DND_TYPE,
  DOCK_MAIN_WINDOW_KEY,
  endDockDrag,
  isDockDrag,
  parseDockDragPayload,
  resolveDockDrop,
  setDockDragOver,
} from './dockDrag';
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

/**
 * P4 hoisted mounts. Present ⇒ this zone renders SLOTS, not bodies.
 * See the mount-policy section of the file header.
 */
export interface DockZoneMounts<P extends string = string> {
  /**
   * The panels this zone must render a slot for, from the OWNER's global resolver
   * (`resolveLiveMounts` + `liveMountsIn`). Re-ordered here into tab order, and
   * intersected with `panels`, so the zone can never render a slot for a panel it
   * does not hold.
   */
  mounted: readonly P[];
  /**
   * Callback ref for one panel's slot, from the owner's mount registry. MUST be
   * cached per panel id by the registry — a fresh function identity per render
   * would make React detach and re-attach (and therefore reparent) on every
   * gossip push.
   */
  slotRef: (panelId: P) => (el: HTMLElement | null) => void;
}

export interface DockZoneProps<P extends string = string> {
  /** Zone identity ('left' | 'centre' | 'right' | a window slot). Namespaces the DOM ids. */
  zoneId: string;
  /** The panels docked here, in tab order. MAY be empty (v2) — see the header. */
  panels: readonly DockZonePanel<P>[];
  /** The selected panel — '' iff the zone is empty. Repaired against `panels`. */
  activeId: P | '';
  /** Selection request from the strip. The owner persists it; the zone does not. */
  onSelect: (panelId: P) => void;
  /**
   * The render map: panel id → its content. Called only for MOUNTED panels.
   * The P1/P3 inline path — omit it when `mounts` is supplied.
   */
  renderPanel?: (panelId: P) => React.ReactNode;
  /** P4: hoisted mounts. Takes precedence over `renderPanel` when both are given. */
  mounts?: DockZoneMounts<P>;
  /** Accessible name for the tab strip, already translated. */
  ariaLabel: string;
  /** Host framing classes for the zone root, e.g. 'room-col-rail'. */
  className?: string;
  /** Drop the strip when there is only one panel (RoomStage's existing habit). */
  hideSingleTab?: boolean;
  /**
   * Panels that render their OWN header row and host their own move affordance
   * (a `DockSoloHandle`). A DOCKED zone holding exactly one of these hides the
   * strip, so the default room looks exactly as it did before the dock existed —
   * the centre column's "SHARED FILES · N" eyebrow and the chat column's
   * CHAT | HISTORY row are already that row, and a one-tab strip above either is a
   * second, near-identical 11px/700 uppercase line.
   *
   * The CALLER decides which zones qualify: pass this for docked zones only. A
   * window zone always keeps its strip — there is no pre-P3 look to preserve there,
   * and the per-tab menu is the only way home besides the header's Dock back.
   *
   * Panels that render no header of their own (People, Voice, LAN) must NOT be
   * listed: the zone body is a drop target, never a drag source, so a strip-less
   * solo Voice column would have no way to move that panel out at all.
   */
  soloHostIds?: readonly P[];
  /**
   * Hide the zone without unmounting it — the stage overlay's only sanctioned way
   * to take the column. See the header.
   */
  hidden?: boolean;
  /**
   * P3 move wiring — drag source, drop target and the per-tab "Move to" menu.
   * Absent ⇒ the P1 zone (selection only): the strip renders no drag affordance and
   * the zone's own drag listeners bail on their first line, so nothing is draggable
   * and nothing is a drop target. (P4 note: those listeners are NATIVE and are
   * attached once regardless — an inert listener is cheaper and simpler than
   * re-arming the pair whenever `dock` appears, and it cannot preventDefault
   * anything without a `dock`.)
   */
  dock?: DockStripInteractions;
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
 * Pure mount resolver — the entire tab-switch policy for ONE zone, extracted so it
 * is testable without a DOM. (Renderer tests are renderToStaticMarkup string
 * assertions; there is no jsdom, so a stateful switch SEQUENCE can only be
 * exercised here.)
 *
 * Rules, in order:
 *  1. An `activeId` that is not in `panels` is repaired to the first panel rather
 *     than rendering nothing — a zone pointed at a stale id must still show
 *     something. (dockModel repairs this too; the zone declines to trust it.)
 *     `dockMounts.resolveZoneActive` is the same rule, shared with the hoisted
 *     resolver so the two deciders cannot disagree.
 *  2. Keep-alive ids for panels that have since LEFT this zone are pruned, so
 *     moving a panel between zones cannot leak a mount.
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
 *
 * P4 NOTE — in the hoisted path this is still called, for rule 1 (the activeId
 * repair, which decides which slot is `hidden`); the MOUNT set comes from the
 * owner's `mounts.mounted` instead, and `alive` is not advanced. The rule is the
 * same rule — `resolveLiveMounts` is this function unioned across zones.
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

/** True when the event happened inside the tab strip, which owns its own handling. */
function insideStrip(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return !!el && typeof el.closest === 'function' && el.closest('.dock-tabstrip') !== null;
}

/** Everything the zone's NATIVE listeners need, refreshed on every render. */
interface DockZoneLive<P extends string> {
  dock: DockStripInteractions | undefined;
  zoneId: string;
  windowKey: string;
  panels: readonly DockZonePanel<P>[];
  active: P | '';
  onSelect: (panelId: P) => void;
  /** Commit + announce, in this zone's own window (`useDockMove`). */
  move: (panelId: string, toZone: string, toIndex: number | null) => void;
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
  mounts,
  ariaLabel,
  className,
  hideSingleTab = false,
  soloHostIds,
  hidden,
  dock,
}: DockZoneProps<P>): React.ReactElement {
  const idPrefix = `dock-${zoneId}`;
  const rootRef = useRef<HTMLDivElement>(null);

  // The keep-alive set lives in a ref rather than state: it is derived bookkeeping,
  // and resolving it during render keeps the mount decision in the same pass as the
  // markup (an effect would mount the panel a frame late, and would not run at all
  // under renderToStaticMarkup). resolveDockMount is pure and idempotent for a given
  // (panels, activeId), so a StrictMode double render lands on the same result.
  const aliveRef = useRef<P[]>([]);
  const resolved = resolveDockMount(panels, activeId, aliveRef.current);
  // Only the inline path owns an alive set. In the hoisted path the owner's
  // resolver is the single decider and this ref must not shadow it.
  if (!mounts) aliveRef.current = resolved.alive;
  const active = resolved.activeId;

  const ids = panels.map((p) => p.id);
  // Slots are emitted in TAB order and only for panels this zone actually holds:
  // the owner's live set is registry-ordered and covers every zone, so filtering
  // here is what keeps DOM order, focus order and tab order the same order.
  const slotIds = mounts ? ids.filter((id) => mounts.mounted.includes(id)) : resolved.mounted;

  const soloHost = panels.length === 1 && (soloHostIds?.includes(ids[0]) ?? false);
  const showStrip = panels.length > 0 && (panels.length > 1 || !(hideSingleTab || soloHost));
  const rootClass = ['dock-zone', `dock-zone-${zoneId}`, className].filter(Boolean).join(' ');

  // ── native listeners: the zone-body drop target and the cycle key ──────────
  // Both must be NATIVE — see the header. Values they read are refreshed through a
  // ref during render (same discipline as `aliveRef`) so the listeners install once
  // and the room's ~700ms gossip re-render never re-arms them.
  const windowKey = dock?.windowKey ?? DOCK_MAIN_WINDOW_KEY;
  const move = useDockMove(dock);
  const liveRef = useRef<DockZoneLive<P>>({ dock, zoneId, windowKey, panels, active, onSelect, move });
  liveRef.current = { dock, zoneId, windowKey, panels, active, onSelect, move };

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;

    // Ctrl/Cmd+PageUp/PageDown. Handled on the element that wraps both the strip
    // and the panels, because the strip is the panels' SIBLING — a handler on the
    // tablist alone would only fire while a tab button has focus, i.e. never in the
    // situation the shortcut exists for (cycling while working inside a panel).
    const onKeyDown = (e: KeyboardEvent): void => {
      const cur = liveRef.current;
      if (insideStrip(e.target)) return; // the strip owns its own keys
      const idx = dockCycleIndex(e, cur.panels.findIndex((p) => p.id === cur.active), cur.panels.length);
      if (idx === null) return;
      e.preventDefault();
      e.stopPropagation();
      const target = cur.panels[idx];
      if (target && target.id !== cur.active) cur.onSelect(target.id);
    };

    // Same guard order as the strip's, and the same single check in both places:
    // only a drag carrying DOCK_DND_TYPE is ever preventDefault'ed, so an OS file
    // drag ('Files') and a room file-row drag ('text/havvn-fileid') fall straight
    // through to the room's own overlay. Nothing here touches React state — hover
    // is a DOM attribute written by dockDrag.ts and read by CSS (invariant C).
    const onDragOver = (e: DragEvent): void => {
      const cur = liveRef.current;
      if (!cur.dock || !isDockDrag(e.dataTransfer?.types)) return;
      if (insideStrip(e.target)) return; // the strip lights itself, and only itself
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      setDockDragOver(rootRef.current, 'zone');
    };

    const onDrop = (e: DragEvent): void => {
      const cur = liveRef.current;
      if (!cur.dock || !isDockDrag(e.dataTransfer?.types)) return;
      if (insideStrip(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const payload = parseDockDragPayload(e.dataTransfer?.getData(DOCK_DND_TYPE) ?? '');
      endDockDrag();
      // index null: a body drop appends at the end of the tab order and activates.
      const plan = resolveDockDrop(payload, {
        zone: cur.zoneId,
        win: cur.windowKey,
        panels: cur.panels.map((p) => p.id),
        index: null,
      });
      if (!plan || plan.kind === 'noop') return;
      cur.move(plan.panel, plan.to, plan.index);
    };

    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={rootClass}
      data-dock-zone={zoneId}
      // An empty zone is legal and renders as nothing; the class lets the column
      // collapse without the host having to duplicate the model's emptiness test.
      data-dock-empty={panels.length === 0 ? '' : undefined}
      // The stage overlay's way of taking the column without unmounting the zone.
      // `.dock-zone` is display:flex, which outranks the UA [hidden] rule, so
      // DockZone.css restates it.
      hidden={hidden || undefined}
    >
      {showStrip && (
        <DockTabStrip
          idPrefix={idPrefix}
          ariaLabel={ariaLabel}
          tabs={panels.map((p) => ({ id: p.id, label: p.label, icon: p.icon, badge: p.badge, title: p.title }))}
          activeId={active}
          onSelect={(id) => onSelect(id as P)}
          dock={dock}
        />
      )}
      {slotIds.map((id) => (
        <div
          key={id}
          // In the hoisted path this ref is what MOVES the panel: the owner's
          // registry appends the panel's stable container here. It is cached per
          // panel id by the registry, so React does not re-run it on every render.
          ref={mounts ? mounts.slotRef(id) : undefined}
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
          // from the slot list.
          hidden={id !== active}
        >
          {mounts ? null : renderPanel?.(id)}
        </div>
      ))}
    </div>
  );
}

export default DockZone;
