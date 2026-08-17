/**
 * Room dock model — the pure description of WHICH panels live in WHICH zone of a
 * room and which panel each zone is currently showing, plus its persistence.
 *
 * This file is deliberately dependency-free at runtime (no React, no DOM at module
 * scope) so it unit-tests under plain node vitest. The registry here holds only
 * METADATA — panel id, i18n label key, icon name, default zone. The actual React
 * components are wired in the zone component; keeping them out is what lets this
 * module stay pure.
 *
 * ── v2: three docked zones, plus a fixed pool of window zones ─────────────────
 *
 * There are two KINDS of zone behind one uniform state shape:
 *
 *  - DOCKED zones (`left | centre | right`) are fixed, positional and always exist.
 *    They carry the room's framing, which belongs to the COLUMN and not to whatever
 *    panel happens to be in it. v1's single `rail` zone is renamed to `left` —
 *    "rail" stops being true the moment Files or Chat can live there.
 *  - WINDOW zones (`w1..w4`) are a FIXED POOL, drawn from on tear-off and returned
 *    on dock-back. The load-bearing encoding choice is:
 *
 *        A WINDOW ZONE EXISTS IFF ITS PANEL LIST IS NON-EMPTY.
 *
 *    There is no allocation table, no `open: boolean`, no window registry, so
 *    "allocated but empty" and "orphan window zone" are unrepresentable and two
 *    whole repair cases are deleted before they can be written wrong.
 *
 * `zones` is TOTAL: every zone id is always a key. Pool size 4 is derived, not
 * guessed — invariant A keeps >=1 panel docked and each window zone holds >=1
 * panel, so with 5 panels at most PANELS.length - 1 = 4 window zones are reachable.
 * A registry test asserts that relation, so adding a 6th panel fails the suite
 * instead of silently making tear-off refusable in a legal state.
 *
 * ── HIDDEN PANELS ────────────────────────────────────────────────────────────
 *
 * A panel the user has hidden is REMOVED FROM EVERY ZONE and recorded in one
 * top-level, ordered `hidden` list (most recently hidden LAST). That encoding is
 * the whole feature:
 *
 *        A PANEL IS IN EXACTLY ONE ZONE, OR IN `hidden`. NEVER BOTH, NEVER NEITHER.
 *
 * `zones[z].panels` is read as "the tabs this zone shows" by ~10 consumers (the zone
 * component, the mount resolver, `dockedPanelCount`, `zoneOfPanel`, `openWindowZones`,
 * the solo-handle test, the emptiness flags, the window title...). Removing a hidden
 * panel from its zone keeps every one of them correct with ZERO edits, and makes
 * `dockedPanelCount` mean "VISIBLE docked panels" — which is exactly the quantity
 * invariant A always meant. A per-panel `hidden: true` flag would instead turn each of
 * those ten readers into a filter site, and a missed filter is the catastrophic case
 * (a torn-off window that opens showing nothing, a zone claiming a tab it renders no
 * slot for, an invariant counting panels nobody can see).
 *
 * `from` on a hidden entry is ALWAYS a DOCKED zone id, resolved AT HIDE TIME (a panel
 * hidden out of a torn-off window records that window's `origin`, else the panel's
 * `defaultZone`) — the same discipline `DockZoneState.origin` follows, and it means
 * "show it again where it was" never needs a window to still exist.
 *
 * The word "hidden" is overloaded in this folder — always disambiguate in prose:
 * PANEL-HIDDEN is this feature; a zone is COVERED when the stage overlay is over it;
 * a mounted-but-not-selected tab is INACTIVE.
 *
 * ── INVARIANT A ──────────────────────────────────────────────────────────────
 *
 *        AT LEAST ONE DOCKED ZONE HAS AT LEAST ONE PANEL.
 *
 * v1's per-zone rule ("no zone is ever empty") is DELETED: an empty docked zone is
 * legal in v2 and renders as a collapsed column — the headline feature ("Voice and
 * Chat together on the second monitor") necessarily empties one. The invariant
 * moves up a level and is guarded at three depths, deepest first:
 *
 *  1. STORAGE SHAPE — a stored blob can never contain a non-empty window zone
 *     (`saveDockLayout` folds them home before writing, `parseDockLayout` folds
 *     again after repair), so every LOADED layout is fully docked BY CONSTRUCTION,
 *     and it can never claim EVERY panel is hidden (repair un-hides one on the way
 *     out). "A persisted layout with everything torn off, plus child windows that
 *     fail to open" is therefore not a state the schema can express, and neither is
 *     "a persisted layout with nothing left to click".
 *  2. OPERATIONS — every mutating op refuses `'last-docked-group'` rather than
 *     performing a move — or a HIDE — that would empty the main window.
 *  3. REPAIR — `repairLayout` folds every window zone home when no docked zone
 *     holds a panel, and un-hides one panel if that still left nothing docked.
 *
 * Hiding deliberately reuses `'last-docked-group'` rather than inventing a
 * `'last-visible-panel'` synonym: if the docked count AFTER the hide is > 0 then at
 * least one panel is visible in the main window, so the docked check strictly implies
 * the visibility check, and the user gets one explanation across hide, move, detach
 * and tear-off. Panels in torn-off WINDOWS deliberately do not count as "visible" for
 * that guard — window zones are never persisted, so a rule that counted them would be
 * true at runtime and false at every storage boundary.
 *
 * ── persistence discipline (unchanged from v1) ────────────────────────────────
 *
 * Copied verbatim from renderer/utils/roomLayout.ts: try/catch around JSON.parse,
 * a plain-object guard (JSON.parse succeeds on scalars/null/arrays too), a
 * field-by-field rebuild so unknown keys are DROPPED, and a try/catch-and-ignore
 * save. Two deliberate differences:
 *
 *  - It lives in its OWN localStorage key. A corrupt dock blob must never be able
 *    to take the splitter widths (roomLayout) down with it.
 *  - It carries a `v` schema stamp. An UNRECOGNISED `v` DISCARDS the stored blob;
 *    a RECOGNISED older one is migrated forward (see `DOCK_MIGRATABLE_VERSIONS`).
 *    v1 -> v2 is a pure zone rename (`rail` -> `left`) with no ambiguity, so a P1
 *    user's arrangement survives the upgrade; anything we cannot read exactly is
 *    still thrown away rather than half-understood, because that is how a user ends
 *    up with nothing to click.
 *
 * The types stay generic over the panel-id and zone-id unions so a later phase can
 * add a zone, or move a panel, by editing the `as const` arrays below — and so the
 * repair pass is testable against registries the real one cannot express.
 */

import type { IconName } from '../../../components/Icon';
import {
  DOCK_WINDOW_POOL_SIZE,
  DOCK_WINDOW_FRAME_NAMES as SHARED_DOCK_WINDOW_FRAME_NAMES,
  dockWindowFrameName as sharedDockWindowFrameName,
} from '../../../../shared/dock-windows';

// Pure type query (no runtime import) — same idiom as utils/i18nContext.tsx, so
// en.json is not pulled into the bundle by this module.
type TranslationKey = keyof typeof import('../../../i18n/en.json');

/**
 * Bump ONLY on a shape change that old blobs cannot be read as. An unrecognised
 * stamp DISCARDS; a stamp listed in DOCK_MIGRATABLE_VERSIONS is migrated forward.
 *
 * `hidden` was ADDED WITHOUT A BUMP, on purpose. A blob written before it exists
 * reads as `hidden: []` — every panel visible, which is correct — so a migration
 * would be the identity function. The DOWNGRADE direction is what settles it: an
 * older build's field-by-field rebuild drops the unknown key, the hidden panels are
 * then in no zone, and its own repair re-adds them to their default zones. A
 * downgrade un-hides everything, which is the only safe way to fail. Bumping would
 * instead make that build hit the unrecognised-stamp branch and DISCARD the user's
 * whole arrangement to "fix" something that degrades gracefully on its own.
 */
export const DOCK_SCHEMA_VERSION = 2;

/**
 * Older stamps this module can still read EXACTLY, newest first.
 *  - v1: one zone, `rail`, holding voice/lan/people. Reading it is a rename, so a
 *    P1 user keeps their tab order instead of being reset.
 */
export const DOCK_MIGRATABLE_VERSIONS: readonly number[] = [1];

/** Separate from roomLayout's key on purpose — see the header. */
export const ROOM_DOCK_KEY = 'roomDock';

// ── zones ───────────────────────────────────────────────────────────────────

/** The three columns, in visual order. Always present; MAY be empty (v2). */
export const DOCK_DOCKED_ZONE_IDS = ['left', 'centre', 'right'] as const;
export type DockDockedZoneId = (typeof DOCK_DOCKED_ZONE_IDS)[number];

/**
 * The window pool. Opaque ids on purpose: the persisted blob never contains an
 * Electron naming convention (see `dockWindowFrameName`).
 */
export const DOCK_WINDOW_ZONE_IDS = ['w1', 'w2', 'w3', 'w4', 'w5'] as const;
export type DockWindowZoneId = (typeof DOCK_WINDOW_ZONE_IDS)[number];

export type DockZoneId = DockDockedZoneId | DockWindowZoneId;

/** Docked first, then window — this order IS the repair pass's precedence. */
export const DOCK_ZONE_IDS: readonly DockZoneId[] = [
  ...DOCK_DOCKED_ZONE_IDS,
  ...DOCK_WINDOW_ZONE_IDS,
];

export function isDockedZone(z: string): z is DockDockedZoneId {
  return (DOCK_DOCKED_ZONE_IDS as readonly string[]).includes(z);
}

export function isWindowZone(z: string): z is DockWindowZoneId {
  return (DOCK_WINDOW_ZONE_IDS as readonly string[]).includes(z);
}

/**
 * Model id -> Electron frameName. Keeps the naming convention out of the stored
 * blob and out of the model, while per-frameName bounds persistence keeps working
 * unmodified — with the pleasant side effect that `havvn-dock-1` always reopens
 * where the user last parked it.
 *
 * DERIVED from `shared/dock-windows.ts`, never restated. That file exists so the
 * main-process allowlist and this model cannot drift, and both its header and
 * main.ts's said the renderer imported it — which was not true until the map below
 * was built from `dockWindowFrameName(slot)`. Zone `w{n}` is pool slot `n`, and
 * dockModel.test.ts pins `DOCK_WINDOW_ZONE_IDS.length === DOCK_WINDOW_POOL_SIZE`
 * plus `DOCK_WINDOW_POOL_SIZE >= PANELS.length - 1`, so adding a sixth panel or a
 * fifth zone fails the suite instead of silently producing an unallocatable slot.
 */
const DOCK_WINDOW_FRAME_BY_ZONE: Readonly<Record<DockWindowZoneId, string>> =
  DOCK_WINDOW_ZONE_IDS.reduce((acc, z, i) => {
    const name = sharedDockWindowFrameName(i + 1);
    // null only if the zone list outgrew the pool, which the test above forbids.
    if (name) acc[z] = name;
    return acc;
  }, {} as Record<DockWindowZoneId, string>);

export function dockWindowFrameName(z: DockWindowZoneId): string {
  return DOCK_WINDOW_FRAME_BY_ZONE[z];
}

/** All four, in pool order — main.ts's allowlist must contain exactly these. */
export const DOCK_WINDOW_FRAME_NAMES: readonly string[] = SHARED_DOCK_WINDOW_FRAME_NAMES;

/** Re-exported so a caller asserting the pool relation does not reach past us. */
export { DOCK_WINDOW_POOL_SIZE };

// ── panels ──────────────────────────────────────────────────────────────────

/** Panels, in DEFAULT ORDER — this is the order a repaired/reset zone shows. */
export const DOCK_PANEL_IDS = ['voice', 'lan', 'people', 'files', 'server', 'chat'] as const;
export type DockPanelId = (typeof DOCK_PANEL_IDS)[number];

/**
 * The only part of a panel the repair pass cares about.
 * NOTE `Z` is the DOCKED zone union: a panel can never DEFAULT into a window zone.
 * That is the compile-time half of invariant A — every path that re-homes a panel
 * (repair's re-add step, and the window fold-back) is guaranteed a docked target.
 */
export interface DockPanelPlacement<P extends string = DockPanelId, Z extends string = DockDockedZoneId> {
  readonly id: P;
  readonly defaultZone: Z;
}

/** Full registry metadata for a panel. The component itself is wired in the zone. */
export interface DockPanelDef extends DockPanelPlacement<DockPanelId, DockDockedZoneId> {
  readonly labelKey: TranslationKey;
  readonly icon: IconName;
  /**
   * Passed straight through to DockZone: this panel must survive a tab switch
   * (rendered `hidden` instead of unmounted). Declared here so the fact lives with
   * the panel, not with whoever happens to wire the zone.
   *  - voice: its unmount flushes the debounced voice-settings push and tears down
   *    the push-to-talk listeners + the voice-warning subscription — a user mid-call
   *    who opens another tab would lose PTT.
   *  - lan: its latched terminal-failure map dies with the panel, and the honest
   *    failure message starts strobing again on return.
   *  - chat: the composer draft lives in the panel's own state.
   * It has NO effect on the persisted model.
   */
  readonly keepAlive?: boolean;
  /**
   * This panel renders its OWN header row, so a DOCKED zone holding only this panel
   * hides the tab strip and the panel's header hosts a `DockSoloHandle` instead.
   *
   * Why it is a per-panel FACT and not a blanket rule: the centre column's files
   * card already draws `SHARED FILES · N` as `.room-section-title`, and the right
   * column already draws the CHAT | HISTORY switcher — both 11px/700 uppercase HUD
   * eyebrows, which is exactly what `.dock-tabstrip` is styled as. A one-tab strip
   * above either is a second, near-identical row: ~26px plus a border of pure
   * duplication per column, and the default room stops looking like the room the
   * user had before the dock existed.
   *
   * People, Voice and LAN render no header of their own, so they are deliberately
   * NOT solo hosts: the zone body is a drop TARGET, never a drag SOURCE, and a
   * strip-less solo Voice column would leave no way to move that panel at all.
   *
   * Like `keepAlive`, it has NO effect on the persisted model.
   */
  readonly soloHost?: boolean;
}

/**
 * THE registry. Every dockable panel is declared exactly once, here.
 * Order is the default order; `defaultZone` is where a fresh install (or a repair
 * that had to re-add the panel) puts it.
 */
export const PANELS: readonly DockPanelDef[] = [
  { id: 'voice', labelKey: 'rooms.voice.title', icon: 'headphones', defaultZone: 'left', keepAlive: true },
  { id: 'lan', labelKey: 'rooms.lan.title', icon: 'network', defaultZone: 'left', keepAlive: true },
  { id: 'people', labelKey: 'rooms.people', icon: 'users', defaultZone: 'left' },
  { id: 'files', labelKey: 'rooms.sharedFiles', icon: 'folder-open', defaultZone: 'centre', soloHost: true },
  // AFTER files, deliberately: registry order is the default order within a zone,
  // and the first panel is the active one. Listing this before files would make a
  // fresh install open every room on the Servers tab instead of on the room's
  // actual contents.
  //
  // keepAlive: the console's live subscription and its scroll position live in
  // the panel's own state, so a tab switch would drop the user out of a running
  // server's output and lose everything printed while they were away.
  { id: 'server', labelKey: 'rooms.server.title', icon: 'server', defaultZone: 'centre', keepAlive: true, soloHost: true },
  { id: 'chat', labelKey: 'rooms.chat', icon: 'message-square', defaultZone: 'right', keepAlive: true, soloHost: true },
];

/**
 * The panels a solo DOCKED zone may hide its strip for — hand this to
 * `DockZone.soloHostIds` for docked zones ONLY (a window zone always keeps its
 * strip; there is no pre-dock look to preserve there and the per-tab menu is the
 * way home).
 */
export const DOCK_SOLO_HOST_IDS: readonly DockPanelId[] =
  PANELS.filter((p) => p.soloHost).map((p) => p.id);

export const PANEL_BY_ID: Readonly<Record<DockPanelId, DockPanelDef>> = PANELS.reduce(
  (acc, p) => { acc[p.id] = p; return acc; },
  {} as Record<DockPanelId, DockPanelDef>,
);

/**
 * Does this zone draw a tab strip?
 *
 * The rule DockZone applies, extracted because a second caller now needs the same
 * answer: a panel must know whether the strip above it has already said its name,
 * so it can drop its own title row and leave only its actions. Two columns used to
 * announce themselves twice — "GOLOS" on the tab and "GOLOS" again underneath —
 * and each panel's second row was built differently, so no two columns lined up.
 *
 * It cannot be a context: panels are portalled out of DockPanelMounts, so their
 * React parent is the page, not the zone. It cannot be re-derived at the call site
 * either without becoming two rules that drift. So: one function, both callers.
 */
export function zoneShowsStrip(opts: {
  panelCount: number;
  /** True when the zone's ONLY panel is one that hosts its own header + handle. */
  soloHost?: boolean;
  /** The zone's caller-level "one panel needs no tabs" habit. */
  hideSingleTab?: boolean;
}): boolean {
  const { panelCount, soloHost = false, hideSingleTab = false } = opts;
  if (panelCount <= 0) return false;
  if (panelCount > 1) return true;
  return !(hideSingleTab || soloHost);
}

/** What the repair pass needs to know. Generic so tests (and later phases) can vary it. */
export interface DockRegistry<
  P extends string = DockPanelId,
  D extends string = DockDockedZoneId,
  W extends string = DockWindowZoneId,
> {
  readonly version: number;
  readonly dockedZoneIds: readonly D[];
  readonly windowZoneIds: readonly W[];
  readonly panels: readonly DockPanelPlacement<P, D>[];
}

export const DOCK_REGISTRY: DockRegistry = {
  version: DOCK_SCHEMA_VERSION,
  dockedZoneIds: DOCK_DOCKED_ZONE_IDS,
  windowZoneIds: DOCK_WINDOW_ZONE_IDS,
  panels: PANELS,
};

export interface DockZoneState<P extends string = DockPanelId, D extends string = DockDockedZoneId> {
  /** Tab order, left to right. A DOCKED zone may be empty; a window zone may not. */
  panels: P[];
  /** INVARIANT: a member of `panels`, or '' IFF `panels` is empty. */
  active: P | '';
  /**
   * Window zones only: the docked zone this group was torn off, so "Dock back"
   * puts it where it came from. SESSION-ONLY — it is never persisted, because a
   * torn-off arrangement is never persisted either.
   */
  origin?: D;
}

/**
 * One PANEL-HIDDEN panel, and the DOCKED zone "Show" puts it back into.
 *
 * A hidden panel is in NO zone — that is the encoding, not an implementation detail.
 */
export interface DockHiddenPanel<P extends string = DockPanelId, D extends string = DockDockedZoneId> {
  readonly id: P;
  /**
   * Resolved at HIDE time: the docked zone it left, or (hidden out of a window) that
   * window's `origin`, else the panel's `defaultZone`. Repair drops it unless it names
   * a real docked zone, so `restorePanel` never needs a window to exist.
   */
  readonly from?: D;
}

export interface DockLayout<
  P extends string = DockPanelId,
  Z extends string = DockZoneId,
  D extends string = DockDockedZoneId,
> {
  v: number;
  /** TOTAL: every zone id is a key. A window zone EXISTS iff panels.length > 0. */
  zones: Record<Z, DockZoneState<P, D>>;
  /**
   * Panels removed from the UI entirely, in HIDE ORDER (most recent LAST — repair
   * un-hides from this end, so a repair undoes the most recent hide).
   * REQUIRED, never optional: an optional field means every reader needs `?? []` and
   * the one place that forgets is a silent bug.
   */
  hidden: DockHiddenPanel<P, D>[];
}

// ── internals ───────────────────────────────────────────────────────────────

/** JSON.parse succeeds on scalars/null/arrays; only a plain object is safe to read. */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** A zone under construction: `active` is resolved LAST, by resolveActives. */
interface DraftZone<P extends string, D extends string> {
  panels: P[];
  active?: P | '';
  origin?: D;
}
type DraftZones<P extends string, D extends string> = Record<string, DraftZone<P, D>>;

const allZoneIds = <P extends string, D extends string, W extends string>(
  reg: DockRegistry<P, D, W>,
): (D | W)[] => [...reg.dockedZoneIds, ...reg.windowZoneIds];

/** Registry-order fallback chain for "somewhere docked to put this". */
function homeZoneFor<P extends string, D extends string, W extends string>(
  reg: DockRegistry<P, D, W>,
  panel: P,
): D | undefined {
  const def = reg.panels.find((p) => p.id === panel);
  if (def && reg.dockedZoneIds.includes(def.defaultZone)) return def.defaultZone;
  return reg.dockedZoneIds[0];
}

/**
 * Fold EVERY window zone into docked zones. Pure bookkeeping on a draft — the
 * public `dockAllWindowZones` wraps it.
 *
 * Termination: two nested bounded loops over sets fixed by the registry, no
 * recursion, no fixpoint iteration, and NO STEP EVER ADDS A PANEL TO A WINDOW
 * ZONE — so no iteration can re-enqueue work. It completes in one pass, and a
 * second pass sees every window zone already empty and does nothing.
 */
function foldWindowsInto<P extends string, D extends string, W extends string>(
  zones: DraftZones<P, D>,
  reg: DockRegistry<P, D, W>,
): void {
  for (const w of reg.windowZoneIds) {
    const zone = zones[w];
    if (!zone || zone.panels.length === 0) continue;
    const origin = zone.origin;
    for (const p of zone.panels) {
      const target =
        origin && reg.dockedZoneIds.includes(origin) ? origin : homeZoneFor(reg, p);
      const dest = target !== undefined ? zones[target] : undefined;
      if (dest) dest.panels.push(p);
      // No docked zone at all (a registry with zero docked zones) — the panel is
      // dropped rather than crashing; repairLayout's registry test forbids it.
    }
    zones[w] = { panels: [] };
  }
}

/**
 * Resolve every zone's active tab LAST, so a panel moved by an earlier step can
 * never leave a zone pointing at a tab it no longer owns.
 * `stored` supplies the caller's preferred value per zone (a raw blob field, or an
 * in-memory layout's own `active`); anything not in the zone falls back to its
 * first panel, and to '' when the zone is empty.
 */
function resolveActives<P extends string, D extends string, W extends string>(
  zones: DraftZones<P, D>,
  reg: DockRegistry<P, D, W>,
  stored: (zone: D | W) => unknown,
): void {
  for (const z of allZoneIds(reg)) {
    const zone = zones[z];
    if (!zone) continue;
    const want = stored(z);
    zone.active =
      typeof want === 'string' && (zone.panels as readonly string[]).includes(want)
        ? (want as P)
        : zone.panels[0] ?? '';
  }
}

/** Freeze a draft into the real shape, dropping `origin` where it is meaningless. */
function sealZones<P extends string, D extends string, W extends string>(
  zones: DraftZones<P, D>,
  reg: DockRegistry<P, D, W>,
): Record<D | W, DockZoneState<P, D>> {
  const out = {} as Record<D | W, DockZoneState<P, D>>;
  for (const z of allZoneIds(reg)) {
    const zone = zones[z] ?? { panels: [] };
    const sealed: DockZoneState<P, D> = { panels: zone.panels, active: zone.active ?? zone.panels[0] ?? '' };
    // `origin` is a window-zone-only field, and an empty window zone does not
    // exist — carrying an origin on one would be state about nothing.
    if (
      reg.windowZoneIds.includes(z as W) &&
      zone.panels.length > 0 &&
      zone.origin !== undefined &&
      reg.dockedZoneIds.includes(zone.origin)
    ) {
      sealed.origin = zone.origin;
    }
    out[z] = sealed;
  }
  return out;
}

/**
 * Read the raw `hidden` list. Entries survive only when they are plain objects
 * naming a panel the registry still declares, that no ZONE already claimed (`seen`)
 * and that no earlier entry already claimed. `from` survives only when it names a
 * real docked zone.
 *
 * Claimed-by-a-zone-wins is deliberate and is the SAME tie-break repair rule (2)
 * already makes for a panel claimed by two zones: ambiguity fails toward VISIBILITY.
 * A blob that says a panel is both in the left column and hidden leaves it on screen.
 *
 * A bare string entry (`hidden: ['voice']`) is dropped rather than guessed at, which
 * costs a hand-crafted blob one un-hidden panel — again, failing toward visible.
 */
function readHidden<P extends string, D extends string, W extends string>(
  raw: unknown,
  reg: DockRegistry<P, D, W>,
  seen: Set<string>,
): DockHiddenPanel<P, D>[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(reg.panels.map((p) => p.id));
  const out: DockHiddenPanel<P, D>[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const id = entry.id;
    if (typeof id !== 'string' || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    const from = entry.from;
    out.push(
      typeof from === 'string' && (reg.dockedZoneIds as readonly string[]).includes(from)
        ? { id: id as P, from: from as D }
        : { id: id as P },
    );
  }
  return out;
}

/** A mutable draft copy of a live layout (arrays copied, so ops never mutate input). */
function draftOf<P extends string, D extends string, W extends string>(
  l: DockLayout<P, D | W, D>,
  reg: DockRegistry<P, D, W>,
): DraftZones<P, D> {
  const zones: DraftZones<P, D> = {};
  for (const z of allZoneIds(reg)) {
    const src = l.zones[z];
    zones[z] = {
      panels: src ? [...src.panels] : [],
      active: src?.active,
      origin: src?.origin,
    };
  }
  return zones;
}

// ── defaults / repair ───────────────────────────────────────────────────────

/**
 * A fresh default layout. Returns a NEW object every call — callers hold this in
 * React state and mutate-by-replace, so a shared frozen singleton would be a trap.
 *
 * It is literally "repair nothing", which is what keeps defaults and repaired
 * layouts from ever drifting apart: repair(defaults) always equals defaults.
 */
export function defaultLayout<P extends string, D extends string, W extends string>(
  reg: DockRegistry<P, D, W>,
): DockLayout<P, D | W, D> {
  return repairLayout(undefined, reg);
}

/** A fresh default layout for the real registry. */
export function defaultDockLayout(): DockLayout {
  return defaultLayout(DOCK_REGISTRY);
}

/**
 * Validate-and-repair. Accepts ANYTHING (a parsed blob, or a layout a caller just
 * mutated) and returns a structurally valid layout:
 *
 *  1. every known zone is present, read in REGISTRY ORDER (docked first, then
 *     window); unknown / non-string panel ids are DROPPED, and so are panels held
 *     by a zone id the registry no longer declares (a retired window slot);
 *  2. a panel that appears more than once keeps only its FIRST occurrence in that
 *     order — so a panel claimed by both a docked and a window zone resolves in
 *     favour of DOCKED. The tie-break fails toward visibility, on purpose;
 *  2b. `hidden` is read AFTER every zone, so a panel claimed by a zone AND by the
 *     hidden list stays VISIBLE (same tie-break), and BEFORE (3), or (3) would
 *     re-add hidden panels to zones and make them visible AND hidden at once.
 *     Unknown ids, duplicates, non-objects and a `from` that is not a docked zone
 *     are dropped;
 *  3. any known panel that survived nowhere — neither in a zone nor hidden — is
 *     RE-ADDED to its default zone (which is docked by type), in registry order;
 *  4. a window zone's `origin` is kept only when it names a real docked zone, and
 *     only while the zone is non-empty (empty window zone == no window zone);
 *  5. INVARIANT A — an empty DOCKED zone is legal (v1's reclaim rule is deleted),
 *     but if NO docked zone holds a panel, every window zone is folded home;
 *  5b. if that STILL left no docked panel (a blob claiming every panel is hidden),
 *     exactly ONE panel is un-hidden — the LAST entry, i.e. the most recent hide —
 *     into `from ?? defaultZone`. One, not all: the minimum repair that satisfies
 *     invariant A preserves the most user intent, and undoing the most recent hide
 *     is the smallest, most explicable undo;
 *  6. each zone's active tab is resolved LAST: kept if still in that zone, else the
 *     zone's first panel, else '' (the empty-zone encoding).
 *
 * Note it does NOT check `v` — the version gate belongs to the parse step, because
 * repair is also called on in-memory layouts that are current by construction.
 *
 * Idempotent: repair(repair(x)) deep-equals repair(x).
 */
export function repairLayout<P extends string, D extends string, W extends string>(
  raw: unknown,
  reg: DockRegistry<P, D, W>,
): DockLayout<P, D | W, D> {
  const known = new Set<string>(reg.panels.map((p) => p.id));
  const src = isPlainObject(raw) ? raw : {};
  const srcZones = isPlainObject(src.zones) ? src.zones : {};
  const storedZone = (z: D | W): Record<string, unknown> =>
    isPlainObject(srcZones[z]) ? (srcZones[z] as Record<string, unknown>) : {};

  const zones: DraftZones<P, D> = {};
  const seen = new Set<string>();

  // (1)(2) — read each known zone, dropping unknown ids and later duplicates.
  for (const z of allZoneIds(reg)) {
    const stored = storedZone(z);
    const list = Array.isArray(stored.panels) ? stored.panels : [];
    const panels: P[] = [];
    for (const id of list) {
      if (typeof id !== 'string' || !known.has(id) || seen.has(id)) continue;
      seen.add(id);
      panels.push(id as P);
    }
    const zone: DraftZone<P, D> = { panels };
    // (4) — origin survives only if it names a real docked zone.
    const origin = stored.origin;
    if (
      typeof origin === 'string' &&
      (reg.dockedZoneIds as readonly string[]).includes(origin) &&
      reg.windowZoneIds.includes(z as W)
    ) {
      zone.origin = origin as D;
    }
    zones[z] = zone;
  }

  // (2b) — read the hidden list AFTER the zones (visible wins) and BEFORE the
  // re-add (or a hidden panel would be resurrected into a zone as well).
  const hidden = readHidden(src.hidden, reg, seen);

  // (3) — re-add panels the stored blob lost, into their default (docked) zone.
  for (const p of reg.panels) {
    if (seen.has(p.id)) continue;
    const target = reg.dockedZoneIds.includes(p.defaultZone) ? p.defaultZone : reg.dockedZoneIds[0];
    const zone = target !== undefined ? zones[target] : undefined;
    if (!zone) continue; // a registry with no docked zones at all — nothing to do
    zone.panels.push(p.id);
    seen.add(p.id);
  }

  // (5) — INVARIANT A. Empty docked zones are fine; ZERO docked panels are not.
  const anyDocked = (): boolean => reg.dockedZoneIds.some((d) => (zones[d]?.panels.length ?? 0) > 0);
  if (!anyDocked()) foldWindowsInto(zones, reg);

  // (5b) — the fold is the smaller intervention, so it goes first; if there was
  // nothing to fold (every panel hidden), un-hide the most recent hide. One is
  // always enough: it lands in a docked zone, which is what A asks for.
  if (!anyDocked() && hidden.length > 0) {
    const last = hidden[hidden.length - 1];
    const target =
      last.from && reg.dockedZoneIds.includes(last.from) ? last.from : homeZoneFor(reg, last.id);
    const zone = target !== undefined ? zones[target] : undefined;
    if (zone) {
      zone.panels.push(last.id);
      hidden.pop();
    }
    // No docked zone at all — the same degradation as (3); the registry test forbids it.
  }

  // (6) — resolve the active tab last.
  resolveActives(zones, reg, (z) => storedZone(z).active);

  return { v: reg.version, zones: sealZones(zones, reg), hidden };
}

/** Validate-and-repair against the real registry. */
export function repairDockLayout(raw: unknown): DockLayout {
  return repairLayout(raw, DOCK_REGISTRY);
}

/**
 * Fold ALL window zones into docked zones, preferring each group's `origin` and
 * falling back to each panel's `defaultZone`. Returns the SAME object when the
 * layout is already fully docked, so the caller's effects do not re-fire.
 *
 * This is the third and last line of defence for invariant A, and it is what makes
 * main.ts's close-to-tray behaviour (every child window dies with the owner) safe
 * rather than catastrophic: the panels come home, the user restores a working room.
 */
export function dockAllWindowZones<P extends string, D extends string, W extends string>(
  l: DockLayout<P, D | W, D>,
  reg: DockRegistry<P, D, W>,
): DockLayout<P, D | W, D> {
  if (!reg.windowZoneIds.some((w) => (l.zones[w]?.panels.length ?? 0) > 0)) return l;
  const zones = draftOf(l, reg);
  foldWindowsInto(zones, reg);
  resolveActives(zones, reg, (z) => l.zones[z]?.active);
  // Hidden panels are in NO zone, so folding windows home cannot touch them — and a
  // fold must never un-hide, or closing the last child window would silently undo a
  // deliberate hide. Repair's (5b) is the only un-hider, and it only fires when the
  // fold left nothing docked.
  return { v: l.v, zones: sealZones(zones, reg), hidden: l.hidden };
}

/** Fold every window zone home, against the real registry. */
export function dockAllDockWindows(l: DockLayout): DockLayout {
  return dockAllWindowZones(l, DOCK_REGISTRY);
}

// ── parse / persist ─────────────────────────────────────────────────────────

/**
 * v1 -> v2: one zone named `rail` became `left`. This is the whole migration; it
 * cannot be ambiguous, so a P1 user keeps the tab order they arranged instead of
 * being reset. Panels v1 never knew (files, chat) are re-added by repair.
 */
function migrateLegacy(parsed: Record<string, unknown>, from: number): unknown {
  if (from !== 1) return parsed;
  const zones = isPlainObject(parsed.zones) ? parsed.zones : {};
  return { v: DOCK_SCHEMA_VERSION, zones: { ...zones, left: zones.left ?? zones.rail } };
}

/**
 * The pure half of loading: text in, valid layout out. Never throws.
 * An unrecognised `v` DISCARDS the blob (returns defaults); a migratable one is
 * read forward. The window fold is applied belt-and-braces after repair, so even a
 * hand-crafted blob cannot restore an arrangement we said we do not restore.
 */
export function parseDockLayout(text: string | null | undefined): DockLayout {
  if (!text) return defaultDockLayout();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return defaultDockLayout();
  }
  if (!isPlainObject(parsed)) return defaultDockLayout();
  const v = parsed.v;
  if (typeof v !== 'number') return defaultDockLayout();
  if (v !== DOCK_SCHEMA_VERSION && !DOCK_MIGRATABLE_VERSIONS.includes(v)) return defaultDockLayout();
  return dockAllDockWindows(repairDockLayout(migrateLegacy(parsed, v)));
}

export function loadDockLayout(): DockLayout {
  try {
    return parseDockLayout(localStorage.getItem(ROOM_DOCK_KEY));
  } catch {
    return defaultDockLayout();
  }
}

/**
 * The persisted projection: the three docked zones and nothing else.
 *
 * A torn-off arrangement is DELIBERATELY not persisted. Restoring one would need a
 * boot reconciliation pass, an "is the main window even visible" gate (the app can
 * start minimised to tray), auto-opened child windows at launch and a fold-back for
 * the ones that fail — four new failure modes, each of which would have to
 * re-establish invariant A on its own. It is also non-deterministic at quit, since
 * main.ts closes children with the owner while the renderer closes them too, so
 * whichever wins the race decides what gets written. Folding home at BOTH ends of
 * the storage boundary buys the strongest form of the invariant there is: a shape
 * that cannot exist beats a repair rule that has to be correct.
 *
 * The cost is two drags per launch, and it is smaller than it looks — the main
 * process persists window BOUNDS per frameName, so a re-torn-off group reappears at
 * the same size on the same monitor.
 */
function toPersisted(l: DockLayout): unknown {
  const zones: Record<string, { panels: DockPanelId[]; active: DockPanelId | '' }> = {};
  for (const z of DOCK_DOCKED_ZONE_IDS) {
    zones[z] = { panels: [...l.zones[z].panels], active: l.zones[z].active };
  }
  // `hidden` IS persisted — a user who hid Voice expects it hidden next launch, and
  // unlike a torn-off arrangement there is nothing to reconcile at boot: the panel is
  // simply not there. `from` is written only when it survived repair, so it always
  // names a docked zone (the caller is the canonical layout, folded and repaired).
  const hidden = l.hidden.map((h) => (h.from ? { id: h.id, from: h.from } : { id: h.id }));
  return { v: l.v, zones, hidden };
}

/**
 * Persist. The layout is folded home and then repaired on the way out, so storage
 * is always canonical, always carries the current stamp, NEVER contains a non-empty
 * window zone and NEVER claims every panel is hidden (repair's (5b) un-hides one
 * first). Both halves of invariant A therefore hold in their strongest form on
 * storage — a shape that cannot exist, not a rule that has to be applied correctly.
 * Cheap (a handful of panels), and it means a caller can
 * never write a blob that its own loader would have to repair.
 * Mirror roomLayout: call this on COMMIT (a tab switch, a drop), not every render.
 */
export function saveDockLayout(l: DockLayout): void {
  try {
    const canonical = repairDockLayout(dockAllDockWindows(repairDockLayout(l)));
    localStorage.setItem(ROOM_DOCK_KEY, JSON.stringify(toPersisted(canonical)));
  } catch { /* ignore */ }
}

/**
 * "Reset layout" (room-settings popover). Drops the stored blob entirely rather than
 * writing today's defaults, so a future change to the default arrangement reaches
 * users who have reset. Returns the layout the caller should put into state.
 *
 * It lives OUTSIDE the dock (the room head bar is never detachable), which makes it
 * the last-resort escape reachable in every state — the braces to invariant A's belt.
 *
 * It also SHOWS EVERY HIDDEN PANEL, for free and by construction (defaults carry an
 * empty `hidden`). That is what lets the restore list afford to sit next to it: even
 * a user who cannot find the list has a guaranteed way back.
 */
export function resetDockLayout(): DockLayout {
  try { localStorage.removeItem(ROOM_DOCK_KEY); } catch { /* ignore */ }
  return defaultDockLayout();
}

// ── queries (pure; no allocation) ───────────────────────────────────────────

export function zonePanels(l: DockLayout, zone: DockZoneId): DockPanelId[] {
  return l.zones[zone]?.panels ?? [];
}

/** '' when the zone is empty — the encoding that makes an empty zone type-visible. */
export function activePanel(l: DockLayout, zone: DockZoneId): DockPanelId | '' {
  return l.zones[zone]?.active ?? '';
}

export function zoneIsEmpty(l: DockLayout, zone: DockZoneId): boolean {
  return (l.zones[zone]?.panels.length ?? 0) === 0;
}

/** Which zone currently holds a panel (head-bar chips deep-link into a panel). */
export function zoneOfPanel(l: DockLayout, panel: DockPanelId): DockZoneId | undefined {
  return DOCK_ZONE_IDS.find((z) => l.zones[z]?.panels.includes(panel));
}

/** Window zones with panels — i.e. exactly the windows that SHOULD be open. */
export function openWindowZones(l: DockLayout): DockWindowZoneId[] {
  return DOCK_WINDOW_ZONE_IDS.filter((w) => (l.zones[w]?.panels.length ?? 0) > 0);
}

/** Every docked zone with panels — the "is invariant A satisfied" witness set. */
export function nonEmptyDockedZones(l: DockLayout): DockDockedZoneId[] {
  return DOCK_DOCKED_ZONE_IDS.filter((d) => (l.zones[d]?.panels.length ?? 0) > 0);
}

/**
 * How many panels the MAIN window is showing. Hidden panels are in no zone, so this
 * counts VISIBLE docked panels without a filter — which is the quantity invariant A
 * has always meant, and the reason hiding cannot be used to launder a move past the
 * guard (`canMovePanel`, `detachPanel` and `tearOffZone` all read it).
 */
export function dockedPanelCount(l: DockLayout, reg: DockRegistry = DOCK_REGISTRY): number {
  return reg.dockedZoneIds.reduce((n, d) => n + (l.zones[d]?.panels.length ?? 0), 0);
}

// ── hidden-panel queries ────────────────────────────────────────────────────

/** The hidden list itself, in HIDE ORDER (most recent last). */
export function hiddenPanels(l: DockLayout): readonly DockHiddenPanel[] {
  return l.hidden;
}

export function isPanelHidden(l: DockLayout, panel: DockPanelId): boolean {
  return l.hidden.some((h) => h.id === panel);
}

/** Every panel that is in a zone — docked or torn off — in zone order. */
export function visiblePanels(l: DockLayout): DockPanelId[] {
  return DOCK_ZONE_IDS.flatMap((z) => l.zones[z]?.panels ?? []);
}

/**
 * Where `restorePanel` would put this panel: its remembered zone, else its default,
 * else the first docked zone. `null` IFF the panel is not hidden — so the popover can
 * name the destination ("Files shown in Centre column") without simulating the op.
 */
export function restoreTargetZone(
  l: DockLayout,
  panel: DockPanelId,
  reg: DockRegistry = DOCK_REGISTRY,
): DockDockedZoneId | null {
  const entry = l.hidden.find((h) => h.id === panel);
  if (!entry) return null;
  if (entry.from && reg.dockedZoneIds.includes(entry.from)) return entry.from;
  return homeZoneFor(reg, panel) ?? null;
}

/** The lowest free pool slot, or null when every slot is in use. */
export function firstFreeWindowZone(
  l: DockLayout,
  reg: DockRegistry = DOCK_REGISTRY,
): DockWindowZoneId | null {
  return reg.windowZoneIds.find((w) => (l.zones[w]?.panels.length ?? 0) === 0) ?? null;
}

// ── operations ──────────────────────────────────────────────────────────────

export type DockRefusal =
  | 'unknown-panel'
  | 'unknown-zone'
  /**
   * Invariant A would break: the main window would be left with nothing. Shared by
   * move, detach, tear-off AND hide — a hide that leaves no docked panel is the same
   * failure with the same explanation, so it deliberately does not get a synonym of
   * its own to say the same thing in different words.
   */
  | 'last-docked-group'
  /** Every window slot is in use. */
  | 'window-pool-exhausted'
  /**
   * "Open in new window" on a panel that is ALREADY alone in a window. Honouring it
   * would allocate the next free slot and MOVE the panel there — the current window
   * closes and a different one opens, at a different remembered geometry (bounds are
   * persisted per slot). The user asked for a new window and would get their
   * existing window teleported.
   */
  | 'already-own-window';

export interface DockOpResult {
  /** The INPUT object itself when refused, or when the op resolved to a no-op. */
  layout: DockLayout;
  refused: DockRefusal | null;
  /** The zone that was targeted / allocated, when there is one. */
  zone: DockZoneId | null;
}

const refuse = (l: DockLayout, refused: DockRefusal): DockOpResult => ({ layout: l, refused, zone: null });

/**
 * The SOURCE half of every relocation — a move, and a hide — as one function, so the
 * two can never drift. Returns the zone state after `panel` leaves it:
 *
 *  - if the departing panel was active, the new active is the panel now at the SAME
 *    INDEX, clamped to the last (the right-hand neighbour, else the left). Not "the
 *    first panel": jumping to tab 1 when you move tab 3 reads as a bug;
 *  - a zone left empty gets `active: ''`;
 *  - an emptied WINDOW zone ceases to exist — its `origin` goes with it, so the pool
 *    slot is clean for the next tear-off.
 *
 * Returns the input state untouched when the panel is not in it.
 */
function zoneWithoutPanel(src: DockZoneState, from: DockZoneId, panel: DockPanelId): DockZoneState {
  const at = src.panels.indexOf(panel);
  if (at < 0) return src;
  const panels = src.panels.filter((p) => p !== panel);
  let active: DockPanelId | '' = src.active;
  if (active === panel || !panels.includes(active as DockPanelId)) {
    active = panels.length ? panels[Math.min(at, panels.length - 1)] : '';
  }
  const kept: DockZoneState = { panels, active };
  if (panels.length > 0 && isWindowZone(from) && src.origin) kept.origin = src.origin;
  return kept;
}

/** `hidden` minus one panel, keeping IDENTITY when it was not in there. */
function hiddenWithout(l: DockLayout, panel: DockPanelId): DockHiddenPanel[] {
  return l.hidden.some((h) => h.id === panel) ? l.hidden.filter((h) => h.id !== panel) : l.hidden;
}

/**
 * Select a tab. Returns the SAME object when nothing changes (already active, or the
 * panel does not live in that zone), so React can skip the re-render.
 */
export function setActivePanel(l: DockLayout, zone: DockZoneId, panel: DockPanelId): DockLayout {
  const z = l.zones[zone];
  if (!z || z.active === panel || !z.panels.includes(panel)) return l;
  return { ...l, zones: { ...l.zones, [zone]: { ...z, active: panel } } };
}

/**
 * The same guard `movePanel` applies, as a pure predicate — so the "Move to" menu
 * can disable an item with the reason as its tooltip, and a drop target can refuse
 * visibly, for exactly the reason the move would have refused.
 */
export function canMovePanel(
  l: DockLayout,
  panel: DockPanelId,
  to: DockZoneId,
  reg: DockRegistry = DOCK_REGISTRY,
): DockRefusal | null {
  if (!reg.panels.some((p) => p.id === panel)) return 'unknown-panel';
  const zoneIds = allZoneIds(reg);
  if (!zoneIds.includes(to)) return 'unknown-zone';
  const from = zoneOfPanel(l, panel);
  if (from === to) return null;
  const docked = (z: DockZoneId | undefined): boolean => !!z && reg.dockedZoneIds.includes(z as DockDockedZoneId);
  const after = dockedPanelCount(l, reg) - (docked(from) ? 1 : 0) + (docked(to) ? 1 : 0);
  return after > 0 ? null : 'last-docked-group';
}

/**
 * THE mover — every relocation goes through here; detach and tear-off are this
 * plus an allocation.
 *
 * `index` is an insertion position in the DESTINATION's panel list AFTER the panel
 * has been removed from its source. (A drag layer that computed the index against a
 * strip still containing the dragged tab must subtract one when the move is within
 * the same zone and the index is past the tab's own position.) Absent = append.
 *
 * Active-tab consequences, both ends:
 *  - SOURCE: see `zoneWithoutPanel` — same index, clamped; an emptied window zone
 *    ceases to exist.
 *  - DESTINATION: the moved panel ALWAYS becomes active. Non-negotiable — you
 *    dragged it there to look at it, and landing it behind another tab makes the
 *    whole gesture look like a no-op.
 *
 * A HIDDEN panel moved into a zone is un-hidden by the same act: a panel is in
 * exactly one zone or in `hidden`, so putting it in a zone takes it out of `hidden`.
 * That keeps "both at once" unrepresentable instead of relying on every caller to
 * remember, and it is why `restorePanel` is this function plus a destination rule.
 *
 * Returns the INPUT layout object when nothing would change, so a no-op drop costs
 * no re-render and no storage write.
 */
export function movePanel(
  l: DockLayout,
  panel: DockPanelId,
  to: DockZoneId,
  index?: number,
  reg: DockRegistry = DOCK_REGISTRY,
): DockOpResult {
  const refused = canMovePanel(l, panel, to, reg);
  if (refused) return refuse(l, refused);

  const from = zoneOfPanel(l, panel);
  if (from === to && index === undefined) return { layout: l, refused: null, zone: to };

  const zones = { ...l.zones } as Record<DockZoneId, DockZoneState>;

  // ── source
  if (from !== undefined && from !== to) {
    zones[from] = zoneWithoutPanel(l.zones[from], from, panel);
  }

  // ── destination
  const dest = l.zones[to];
  const base = dest.panels.filter((p) => p !== panel);
  const wanted = index === undefined || !Number.isFinite(index) ? base.length : Math.trunc(index);
  const at = Math.max(0, Math.min(wanted, base.length));
  const panels = [...base.slice(0, at), panel, ...base.slice(at)];

  const sameOrder = from === to && panels.length === dest.panels.length
    && panels.every((p, i) => p === dest.panels[i]);
  if (sameOrder && dest.active === panel) return { layout: l, refused: null, zone: to };

  const next: DockZoneState = { panels, active: panel };
  if (isWindowZone(to)) {
    // A group keeps the origin it was torn off with; a slot being filled for the
    // first time by a plain move remembers where the panel came from.
    const origin = dest.panels.length > 0 ? dest.origin : (from && isDockedZone(from) ? from : undefined);
    if (origin) next.origin = origin;
  }
  zones[to] = next;

  return { layout: { ...l, zones, hidden: hiddenWithout(l, panel) }, refused: null, zone: to };
}

/** "Move to > New window": allocate a slot and move ONE panel into it. */
export function detachPanel(
  l: DockLayout,
  panel: DockPanelId,
  reg: DockRegistry = DOCK_REGISTRY,
): DockOpResult {
  if (!reg.panels.some((p) => p.id === panel)) return refuse(l, 'unknown-panel');
  const from = zoneOfPanel(l, panel);
  // Refused FIRST, because it is the most specific reason and the only one whose
  // "success" would be actively wrong rather than merely impossible: a panel alone
  // in a window would be teleported to a different pool slot (different remembered
  // bounds) instead of getting a new window. Refusing in the MODEL rather than in
  // the menu is what makes `detachTarget` report it, so the item disables itself
  // with the reason attached — the same shape as the tear-off guard.
  if (from && reg.windowZoneIds.includes(from as DockWindowZoneId)
    && (l.zones[from]?.panels.length ?? 0) === 1) {
    return refuse(l, 'already-own-window');
  }
  // Invariant A is checked BEFORE the pool, so the refusal names the real reason:
  // "this is the last group" is honest, "no windows left" would be a red herring.
  const fromDocked = !!from && reg.dockedZoneIds.includes(from as DockDockedZoneId);
  if (dockedPanelCount(l, reg) - (fromDocked ? 1 : 0) <= 0) return refuse(l, 'last-docked-group');
  const slot = firstFreeWindowZone(l, reg);
  if (!slot) return refuse(l, 'window-pool-exhausted');
  return movePanel(l, panel, slot, undefined, reg);
}

/**
 * "Tear off group": allocate a slot and move the WHOLE zone into it — order and
 * active tab preserved, `origin` recorded.
 *
 * This is the op the headline scenario needs. A per-panel-only tear-off would
 * degrade "Voice and Chat together on the second monitor" into two OS windows the
 * user arranges by hand, which is the whole point lost.
 */
export function tearOffZone(
  l: DockLayout,
  from: DockZoneId,
  reg: DockRegistry = DOCK_REGISTRY,
): DockOpResult {
  // Only a docked zone with panels is a group that can be torn off: a window zone
  // is already torn off, and an empty zone is not a group at all.
  if (!reg.dockedZoneIds.includes(from as DockDockedZoneId)) return refuse(l, 'unknown-zone');
  const src = l.zones[from];
  if (!src || src.panels.length === 0) return refuse(l, 'unknown-zone');
  if (dockedPanelCount(l, reg) - src.panels.length <= 0) return refuse(l, 'last-docked-group');
  const slot = firstFreeWindowZone(l, reg);
  if (!slot) return refuse(l, 'window-pool-exhausted');

  const zones = { ...l.zones } as Record<DockZoneId, DockZoneState>;
  zones[from] = { panels: [], active: '' };
  zones[slot] = {
    panels: [...src.panels],
    active: src.active,
    origin: from as DockDockedZoneId,
  };
  return { layout: { ...l, zones }, refused: null, zone: slot };
}

/**
 * Header "Dock back": every panel of `w`, appended in order, into
 * `to ?? origin ?? the first non-empty docked zone ?? the first docked zone`.
 * The destination's active tab becomes the window's active tab.
 *
 * The group docks back AS A GROUP where it came from — per-panel scatter would
 * dissolve the arrangement the user just built.
 */
export function dockBackZone(
  l: DockLayout,
  w: DockWindowZoneId,
  to?: DockDockedZoneId,
  reg: DockRegistry = DOCK_REGISTRY,
): DockOpResult {
  if (!reg.windowZoneIds.includes(w)) return refuse(l, 'unknown-zone');
  const src = l.zones[w];
  if (!src || src.panels.length === 0) return refuse(l, 'unknown-zone');
  if (to !== undefined && !reg.dockedZoneIds.includes(to)) return refuse(l, 'unknown-zone');

  const target =
    to ??
    (src.origin && reg.dockedZoneIds.includes(src.origin) ? src.origin : undefined) ??
    reg.dockedZoneIds.find((d) => (l.zones[d]?.panels.length ?? 0) > 0) ??
    reg.dockedZoneIds[0];
  if (target === undefined) return refuse(l, 'unknown-zone');

  const dest = l.zones[target];
  const panels = [...dest.panels, ...src.panels.filter((p) => !dest.panels.includes(p))];
  const zones = { ...l.zones } as Record<DockZoneId, DockZoneState>;
  zones[w] = { panels: [], active: '' };
  zones[target] = { panels, active: src.active || panels[0] || '' };
  return { layout: { ...l, zones }, refused: null, zone: target };
}

/**
 * Powers the "Move to >" menu: every docked target plus its refusal, if any. The
 * panel's CURRENT zone is included (refusal `null`) so the menu has a stable shape
 * and can render it disabled-and-marked rather than omitting it — a menu that loses
 * an entry is a menu the user has to re-read.
 */
export function moveTargets(
  l: DockLayout,
  panel: DockPanelId,
  reg: DockRegistry = DOCK_REGISTRY,
): readonly { zone: DockDockedZoneId; refused: DockRefusal | null }[] {
  return reg.dockedZoneIds.map((zone) => ({
    zone: zone as DockDockedZoneId,
    refused: canMovePanel(l, panel, zone, reg),
  }));
}

/** The "New window" item's state (pool exhaustion / invariant A), without moving. */
export function detachTarget(
  l: DockLayout,
  panel: DockPanelId,
  reg: DockRegistry = DOCK_REGISTRY,
): { refused: DockRefusal | null } {
  return { refused: detachPanel(l, panel, reg).refused };
}

/** Whether a zone's whole group could be torn off right now, and why not. */
export function tearOffTarget(
  l: DockLayout,
  from: DockZoneId,
  reg: DockRegistry = DOCK_REGISTRY,
): { refused: DockRefusal | null } {
  return { refused: tearOffZone(l, from, reg).refused };
}

// ── hide / show ─────────────────────────────────────────────────────────────

/**
 * The hide guard as a pure predicate, so the per-tab menu item can disable itself
 * with the reason attached — the same shape as `detachTarget`/`tearOffTarget`.
 *
 * `'last-docked-group'` is REUSED rather than a new `'last-visible-panel'` invented:
 * see the header. Already-hidden is `null`, not a refusal — hiding twice is a no-op,
 * the same precedent `movePanel` sets for a same-zone move.
 */
export function canHidePanel(
  l: DockLayout,
  panel: DockPanelId,
  reg: DockRegistry = DOCK_REGISTRY,
): DockRefusal | null {
  if (!reg.panels.some((p) => p.id === panel)) return 'unknown-panel';
  if (isPanelHidden(l, panel)) return null;
  const from = zoneOfPanel(l, panel);
  const fromDocked = !!from && reg.dockedZoneIds.includes(from as DockDockedZoneId);
  return dockedPanelCount(l, reg) - (fromDocked ? 1 : 0) <= 0 ? 'last-docked-group' : null;
}

/**
 * Remove a panel from the UI entirely: no tab, no strip entry, nowhere.
 *
 * It leaves its zone through the SAME source-side rule a move uses, so an emptied
 * window zone ceases to exist and its group's window closes — a hidden panel is never
 * stranded in a window that no longer exists, which is what makes "show it where it
 * was" free and correct.
 *
 * This is a LAYOUT act, not a lifecycle one. What happens to the panel's React mount
 * is the mount layer's business (keep-alive panels are PARKED — still mounted, still
 * running — precisely so hiding Voice does not silently drop push-to-talk).
 *
 * Returns the INPUT layout when the panel is already hidden. `zone` is the zone it
 * left, or null.
 */
export function hidePanel(
  l: DockLayout,
  panel: DockPanelId,
  reg: DockRegistry = DOCK_REGISTRY,
): DockOpResult {
  const refused = canHidePanel(l, panel, reg);
  if (refused) return refuse(l, refused);
  if (isPanelHidden(l, panel)) return { layout: l, refused: null, zone: null };

  const from = zoneOfPanel(l, panel);
  // The docked zone "Show" will put it back into, decided NOW while we still know
  // where it lived: a window's `origin` outlives the window; the window id would not.
  const fromDocked = !!from && reg.dockedZoneIds.includes(from as DockDockedZoneId);
  const origin = from !== undefined ? l.zones[from]?.origin : undefined;
  const back: DockDockedZoneId | undefined = fromDocked
    ? (from as DockDockedZoneId)
    : origin && reg.dockedZoneIds.includes(origin)
      ? origin
      : homeZoneFor(reg, panel);

  const zones = { ...l.zones } as Record<DockZoneId, DockZoneState>;
  if (from !== undefined) zones[from] = zoneWithoutPanel(l.zones[from], from, panel);
  const entry: DockHiddenPanel = back ? { id: panel, from: back } : { id: panel };
  return { layout: { ...l, zones, hidden: [...l.hidden, entry] }, refused: null, zone: from ?? null };
}

/**
 * Bring one back: appended to `to ?? from ?? defaultZone ?? the first docked zone`,
 * and made ACTIVE. Always a DOCKED zone, never a window — the same discipline that
 * refuses to persist a torn-off arrangement, and it means "Show" cannot depend on a
 * window still existing.
 *
 * Activating is non-negotiable, for `movePanel`'s reason: landing behind another tab
 * makes "Show" look like a no-op.
 *
 * Returns the INPUT layout when the panel is not hidden. Never refuses
 * `'last-docked-group'` — showing a panel cannot empty anything.
 */
export function restorePanel(
  l: DockLayout,
  panel: DockPanelId,
  to?: DockDockedZoneId,
  reg: DockRegistry = DOCK_REGISTRY,
): DockOpResult {
  if (!reg.panels.some((p) => p.id === panel)) return refuse(l, 'unknown-panel');
  if (to !== undefined && !reg.dockedZoneIds.includes(to)) return refuse(l, 'unknown-zone');
  if (!isPanelHidden(l, panel)) return { layout: l, refused: null, zone: zoneOfPanel(l, panel) ?? null };
  const target = to ?? restoreTargetZone(l, panel, reg) ?? undefined;
  if (target === undefined) return refuse(l, 'unknown-zone'); // a registry with no docked zones
  // movePanel appends, activates, and drops the panel from `hidden` — a restore IS a
  // move out of nowhere, so it must not restate any of those three rules.
  return movePanel(l, panel, target, undefined, reg);
}

/** Show every hidden panel, each in its own remembered zone. Never refuses. */
export function restoreAllPanels(l: DockLayout, reg: DockRegistry = DOCK_REGISTRY): DockOpResult {
  if (l.hidden.length === 0) return { layout: l, refused: null, zone: null };
  let out = l;
  let last: DockZoneId | null = null;
  // Snapshot: `restorePanel` shortens `hidden` under us.
  for (const h of [...l.hidden]) {
    const r = restorePanel(out, h.id, undefined, reg);
    if (r.refused) continue; // unreachable for a repaired layout; skipping beats throwing
    out = r.layout;
    last = r.zone ?? last;
  }
  return { layout: out, refused: null, zone: last };
}

/** The "Hide this panel" menu item's state, without hiding. */
export function hideTarget(
  l: DockLayout,
  panel: DockPanelId,
  reg: DockRegistry = DOCK_REGISTRY,
): { refused: DockRefusal | null } {
  return { refused: canHidePanel(l, panel, reg) };
}

/**
 * The restore list: what is hidden, and where each would come back to. In hide order,
 * so the list reads as a history the user can undo from the bottom.
 */
export function restoreTargets(
  l: DockLayout,
  reg: DockRegistry = DOCK_REGISTRY,
): readonly { panel: DockPanelId; zone: DockDockedZoneId }[] {
  const out: { panel: DockPanelId; zone: DockDockedZoneId }[] = [];
  for (const h of l.hidden) {
    const zone = restoreTargetZone(l, h.id, reg);
    if (zone) out.push({ panel: h.id, zone });
  }
  return out;
}

/*
 * `reconcileWindows(layout, liveSlots)` used to live here, documented as "the ONLY
 * bridge between the model and real OS windows". It was exported and tested and
 * never called, and it is deleted rather than wired, because both claims stopped
 * being true:
 *
 *  - Liveness now arrives PER FRAME, not as a set. `DockWindowHost` reports every
 *    death route (the user's ✕, close-to-tray via the owner's `hide`, owner close,
 *    quit, crash) as `onDockBack('closed')`, and the main process additionally
 *    pushes `win:popoutClosed` for the one case a renderer cannot see. Both map
 *    straight to `dockBackZone(prev, zone)`.
 *  - The race it was meant to collapse is already closed. `dockBackZone` refuses
 *    (returns the input layout) for an already-empty zone, so it is idempotent, and
 *    the room commits dock ops as FUNCTIONAL updates — N simultaneous window deaths
 *    chain correctly through `prev` instead of overwriting each other.
 *
 * Wiring it instead would have required inventing state nothing maintains (a live
 * slot Set) and re-implementing `stepDockWindowLiveness`'s "not open YET" guard per
 * slot: the host defers `openPopout` by one macrotask, so a set-based reconcile
 * running in that gap would see the just-torn-off slot as dead and fold the group
 * home instantly, making tear-off look broken.
 *
 * If a future phase ever needs poll-based liveness (a child that fires neither
 * `beforeunload` nor `closed`), reintroducing it is a smaller change than carrying
 * a misleading export that points a reader away from the two paths that do the job.
 */
