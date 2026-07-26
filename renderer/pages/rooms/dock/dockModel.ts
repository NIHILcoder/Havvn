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
 *     again after repair), so every LOADED layout is fully docked BY CONSTRUCTION.
 *     "A persisted layout with everything torn off, plus child windows that fail to
 *     open" is therefore not a state the schema can express.
 *  2. OPERATIONS — every mutating op refuses `'last-docked-group'` rather than
 *     performing a move that would empty the main window.
 *  3. REPAIR — `repairLayout` folds every window zone home when no docked zone
 *     holds a panel.
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

// Pure type query (no runtime import) — same idiom as utils/i18nContext.tsx, so
// en.json is not pulled into the bundle by this module.
type TranslationKey = keyof typeof import('../../../i18n/en.json');

/**
 * Bump ONLY on a shape change that old blobs cannot be read as. An unrecognised
 * stamp DISCARDS; a stamp listed in DOCK_MIGRATABLE_VERSIONS is migrated forward.
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
export const DOCK_WINDOW_ZONE_IDS = ['w1', 'w2', 'w3', 'w4'] as const;
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
 * blob and out of the model, and keeps main.ts's allowlist a LITERAL record (four
 * more entries) rather than a regex — the security surface does not change shape,
 * and per-frameName bounds persistence keeps working unmodified, with the pleasant
 * side effect that `havvn-dock-1` always reopens where the user last parked it.
 */
const DOCK_WINDOW_FRAME_BY_ZONE: Readonly<Record<DockWindowZoneId, string>> = {
  w1: 'havvn-dock-1',
  w2: 'havvn-dock-2',
  w3: 'havvn-dock-3',
  w4: 'havvn-dock-4',
};

export function dockWindowFrameName(z: DockWindowZoneId): string {
  return DOCK_WINDOW_FRAME_BY_ZONE[z];
}

/** All four, in pool order — main.ts's allowlist must contain exactly these. */
export const DOCK_WINDOW_FRAME_NAMES: readonly string[] =
  DOCK_WINDOW_ZONE_IDS.map((z) => DOCK_WINDOW_FRAME_BY_ZONE[z]);

// ── panels ──────────────────────────────────────────────────────────────────

/** Panels, in DEFAULT ORDER — this is the order a repaired/reset zone shows. */
export const DOCK_PANEL_IDS = ['voice', 'lan', 'people', 'files', 'chat'] as const;
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
  { id: 'files', labelKey: 'rooms.sharedFiles', icon: 'folder-open', defaultZone: 'centre' },
  { id: 'chat', labelKey: 'rooms.chat', icon: 'message-square', defaultZone: 'right', keepAlive: true },
];

export const PANEL_BY_ID: Readonly<Record<DockPanelId, DockPanelDef>> = PANELS.reduce(
  (acc, p) => { acc[p.id] = p; return acc; },
  {} as Record<DockPanelId, DockPanelDef>,
);

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

export interface DockLayout<
  P extends string = DockPanelId,
  Z extends string = DockZoneId,
  D extends string = DockDockedZoneId,
> {
  v: number;
  /** TOTAL: every zone id is a key. A window zone EXISTS iff panels.length > 0. */
  zones: Record<Z, DockZoneState<P, D>>;
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
 *  3. any known panel that survived nowhere is RE-ADDED to its default zone (which
 *     is docked by type), in registry order;
 *  4. a window zone's `origin` is kept only when it names a real docked zone, and
 *     only while the zone is non-empty (empty window zone == no window zone);
 *  5. INVARIANT A — an empty DOCKED zone is legal (v1's reclaim rule is deleted),
 *     but if NO docked zone holds a panel, every window zone is folded home;
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
  const dockedHasPanels = reg.dockedZoneIds.some((d) => (zones[d]?.panels.length ?? 0) > 0);
  if (!dockedHasPanels) foldWindowsInto(zones, reg);

  // (6) — resolve the active tab last.
  resolveActives(zones, reg, (z) => storedZone(z).active);

  return { v: reg.version, zones: sealZones(zones, reg) };
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
  return { v: l.v, zones: sealZones(zones, reg) };
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
  return { v: l.v, zones };
}

/**
 * Persist. The layout is folded home and then repaired on the way out, so storage
 * is always canonical, always carries the current stamp, and NEVER contains a
 * non-empty window zone. Cheap (a handful of panels), and it means a caller can
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

export function dockedPanelCount(l: DockLayout, reg: DockRegistry = DOCK_REGISTRY): number {
  return reg.dockedZoneIds.reduce((n, d) => n + (l.zones[d]?.panels.length ?? 0), 0);
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
  /** Invariant A would break: the main window would be left with nothing. */
  | 'last-docked-group'
  /** Every window slot is in use. */
  | 'window-pool-exhausted';

export interface DockOpResult {
  /** The INPUT object itself when refused, or when the op resolved to a no-op. */
  layout: DockLayout;
  refused: DockRefusal | null;
  /** The zone that was targeted / allocated, when there is one. */
  zone: DockZoneId | null;
}

const refuse = (l: DockLayout, refused: DockRefusal): DockOpResult => ({ layout: l, refused, zone: null });

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
 *  - SOURCE: if the moved panel was active, the new active is the panel now at the
 *    SAME INDEX, clamped to the last — the right-hand neighbour, else the left. Not
 *    "the first panel": jumping to tab 1 when you move tab 3 reads as a bug. A
 *    source left empty gets ''; an emptied window zone ceases to exist (its origin
 *    is dropped with it, so the slot is clean for the next tear-off).
 *  - DESTINATION: the moved panel ALWAYS becomes active. Non-negotiable — you
 *    dragged it there to look at it, and landing it behind another tab makes the
 *    whole gesture look like a no-op.
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
    const src = l.zones[from];
    const at = src.panels.indexOf(panel);
    const panels = src.panels.filter((p) => p !== panel);
    let active: DockPanelId | '' = src.active;
    if (active === panel || !panels.includes(active as DockPanelId)) {
      active = panels.length ? panels[Math.min(at, panels.length - 1)] : '';
    }
    const kept: DockZoneState = { panels, active };
    // An emptied window zone ceases to exist — its origin goes with it, so the slot
    // is clean for the next tear-off. `origin` is meaningless on a docked zone.
    if (panels.length > 0 && isWindowZone(from) && src.origin) kept.origin = src.origin;
    zones[from] = kept;
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

  return { layout: { ...l, zones }, refused: null, zone: to };
}

/** "Move to > New window": allocate a slot and move ONE panel into it. */
export function detachPanel(
  l: DockLayout,
  panel: DockPanelId,
  reg: DockRegistry = DOCK_REGISTRY,
): DockOpResult {
  if (!reg.panels.some((p) => p.id === panel)) return refuse(l, 'unknown-panel');
  // Invariant A is checked BEFORE the pool, so the refusal names the real reason:
  // "this is the last group" is honest, "no windows left" would be a red herring.
  const from = zoneOfPanel(l, panel);
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

/**
 * The ONLY bridge between the model and real OS windows: dock back every non-empty
 * window zone whose id is not in `live`. Identity when consistent, which is what
 * keeps the two-way liveness loop from oscillating — the MODEL drives window
 * creation (`openWindowZones` grows, so open it) and WINDOW DEATH drives the model
 * (a `beforeunload` recomputes `live`, so reconcile it).
 */
export function reconcileWindows(
  l: DockLayout,
  live: readonly DockWindowZoneId[],
  reg: DockRegistry = DOCK_REGISTRY,
): DockLayout {
  const stale = reg.windowZoneIds.filter(
    (w) => (l.zones[w]?.panels.length ?? 0) > 0 && !live.includes(w),
  );
  if (stale.length === 0) return l;
  let out = l;
  for (const w of stale) out = dockBackZone(out, w, undefined, reg).layout;
  return out;
}
