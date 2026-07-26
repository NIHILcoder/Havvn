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
 * Persistence discipline is copied verbatim from renderer/utils/roomLayout.ts:
 * try/catch around JSON.parse, a plain-object guard (JSON.parse succeeds on
 * scalars/null/arrays too), a field-by-field rebuild so unknown keys are DROPPED,
 * and a try/catch-and-ignore save. Two deliberate differences:
 *
 *  - It lives in its OWN localStorage key. A corrupt dock blob must never be able
 *    to take the splitter widths (roomLayout) down with it.
 *  - It carries a `v` schema stamp. On an unrecognised `v` the stored blob is
 *    DISCARDED, never migrated — a dock layout is cheap to rebuild and a
 *    half-understood migration is how a user ends up with nothing to click.
 *    (roomLayout's stored blobs have no stamp and must never gain one, or every
 *    existing user's dragged splitter widths would be wiped.)
 *
 * The types are generic over the panel-id and zone-id unions so a later phase can
 * add a zone, or move a panel to a different zone, by editing the two `as const`
 * arrays below — no schema break, no bump of `v`. `repairLayout()` takes the
 * registry as an argument for the same reason (and so the multi-zone future is
 * testable today).
 */

import type { IconName } from '../../../components/Icon';

// Pure type query (no runtime import) — same idiom as utils/i18nContext.tsx, so
// en.json is not pulled into the bundle by this module.
type TranslationKey = keyof typeof import('../../../i18n/en.json');

/** Bump ONLY on a shape change that old blobs cannot be read as. Bumping discards. */
export const DOCK_SCHEMA_VERSION = 1;

/** Separate from roomLayout's key on purpose — see the header. */
export const ROOM_DOCK_KEY = 'roomDock';

/**
 * Zones, in visual order. P1 ships only the rail; adding 'stage' | 'chat' here is
 * all a later phase needs to do at the model level.
 */
export const DOCK_ZONE_IDS = ['rail'] as const;
export type DockZoneId = (typeof DOCK_ZONE_IDS)[number];

/** Panels, in DEFAULT ORDER — this is the order a repaired/reset zone shows. */
export const DOCK_PANEL_IDS = ['voice', 'lan', 'people'] as const;
export type DockPanelId = (typeof DOCK_PANEL_IDS)[number];

/** The only part of a panel the repair pass cares about. */
export interface DockPanelPlacement<P extends string = DockPanelId, Z extends string = DockZoneId> {
  readonly id: P;
  readonly defaultZone: Z;
}

/** Full registry metadata for a panel. The component itself is wired in the zone. */
export interface DockPanelDef extends DockPanelPlacement<DockPanelId, DockZoneId> {
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
  { id: 'voice', labelKey: 'rooms.voice.title', icon: 'headphones', defaultZone: 'rail', keepAlive: true },
  { id: 'lan', labelKey: 'rooms.lan.title', icon: 'network', defaultZone: 'rail', keepAlive: true },
  { id: 'people', labelKey: 'rooms.people', icon: 'users', defaultZone: 'rail' },
];

export const PANEL_BY_ID: Readonly<Record<DockPanelId, DockPanelDef>> = PANELS.reduce(
  (acc, p) => { acc[p.id] = p; return acc; },
  {} as Record<DockPanelId, DockPanelDef>,
);

/** What the repair pass needs to know. Generic so tests (and later phases) can vary it. */
export interface DockRegistry<P extends string = DockPanelId, Z extends string = DockZoneId> {
  readonly version: number;
  readonly zoneIds: readonly Z[];
  readonly panels: readonly DockPanelPlacement<P, Z>[];
}

export const DOCK_REGISTRY: DockRegistry = {
  version: DOCK_SCHEMA_VERSION,
  zoneIds: DOCK_ZONE_IDS,
  panels: PANELS,
};

export interface DockZoneState<P extends string = DockPanelId> {
  /** Tab order, left to right. INVARIANT: never empty (see repairLayout). */
  panels: P[];
  /** INVARIANT: always a member of `panels`. */
  active: P;
}

export interface DockLayout<P extends string = DockPanelId, Z extends string = DockZoneId> {
  v: number;
  zones: Record<Z, DockZoneState<P>>;
}

// ── internals ───────────────────────────────────────────────────────────────

/** JSON.parse succeeds on scalars/null/arrays; only a plain object is safe to read. */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

// ── defaults / repair ───────────────────────────────────────────────────────

/**
 * A fresh default layout. Returns a NEW object every call — callers hold this in
 * React state and mutate-by-replace, so a shared frozen singleton would be a trap.
 *
 * It is literally "repair nothing", which is what keeps defaults and repaired
 * layouts from ever drifting apart: repair(defaults) always equals defaults.
 */
export function defaultLayout<P extends string, Z extends string>(reg: DockRegistry<P, Z>): DockLayout<P, Z> {
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
 *  1. every known zone is present, in registry order;
 *  2. unknown / non-string panel ids are DROPPED;
 *  3. a panel that appears more than once (in one zone or across zones) keeps only
 *     its FIRST occurrence, scanning zones in registry order;
 *  4. any known panel that survived nowhere is RE-ADDED to its default zone, in
 *     registry (default) order;
 *  5. a zone that would still be empty reclaims a panel — preferring one of its own
 *     default panels — from a zone that can spare it, so NO ZONE IS EVER EMPTY;
 *  6. each zone's active tab is kept if it is still in that zone, else it falls back
 *     to that zone's first panel.
 *
 * Note it does NOT check `v` — the version gate belongs to the parse step, because
 * repair is also called on in-memory layouts that are current by construction.
 *
 * Idempotent: repair(repair(x)) deep-equals repair(x).
 */
export function repairLayout<P extends string, Z extends string>(
  raw: unknown,
  reg: DockRegistry<P, Z>,
): DockLayout<P, Z> {
  const known = new Set<string>(reg.panels.map((p) => p.id));
  const src = isPlainObject(raw) ? raw : {};
  const srcZones = isPlainObject(src.zones) ? src.zones : {};

  const zones = {} as Record<Z, DockZoneState<P>>;
  const seen = new Set<P>();

  // (1)(2)(3) — read each known zone, dropping unknown ids and later duplicates.
  for (const z of reg.zoneIds) {
    const stored = isPlainObject(srcZones[z]) ? (srcZones[z] as Record<string, unknown>) : {};
    const list = Array.isArray(stored.panels) ? stored.panels : [];
    const panels: P[] = [];
    for (const id of list) {
      if (typeof id !== 'string' || !known.has(id) || seen.has(id as P)) continue;
      seen.add(id as P);
      panels.push(id as P);
    }
    zones[z] = { panels, active: undefined as unknown as P };
  }

  // (4) — re-add panels the stored blob lost, into their default zone.
  for (const p of reg.panels) {
    if (seen.has(p.id)) continue;
    const zone = zones[p.defaultZone] ?? zones[reg.zoneIds[0]];
    if (!zone) continue; // defaultZone not in zoneIds and no zones at all — nothing to do
    zone.panels.push(p.id);
    seen.add(p.id);
  }

  // (5) — the hard invariant: a zone with zero panels is a bricked zone (a tab strip
  // with nothing to click). Reclaim ONE panel from a donor that keeps at least one.
  for (const z of reg.zoneIds) {
    if (zones[z].panels.length > 0) continue;
    const mine = reg.panels.filter((p) => p.defaultZone === z).map((p) => p.id);
    const candidates = [...mine, ...reg.panels.map((p) => p.id).filter((id) => !mine.includes(id))];
    for (const id of candidates) {
      const donor = reg.zoneIds.find(
        (dz) => dz !== z && zones[dz].panels.length > 1 && zones[dz].panels.includes(id),
      );
      if (!donor) continue;
      zones[donor].panels = zones[donor].panels.filter((x) => x !== id);
      zones[z].panels.push(id);
      break;
    }
  }

  // (6) — resolve the active tab last, so a panel moved by (5) can't leave a donor
  // pointing at a tab it no longer owns.
  for (const z of reg.zoneIds) {
    const stored = isPlainObject(srcZones[z]) ? (srcZones[z] as Record<string, unknown>) : {};
    const active = stored.active;
    zones[z].active =
      typeof active === 'string' && zones[z].panels.includes(active as P)
        ? (active as P)
        : // A still-empty zone is only reachable when the registry declares fewer
          // panels than zones (a registry bug — see the test asserting it holds).
          // The field must still carry a valid id so consumers can type it as P.
          zones[z].panels[0] ?? reg.panels[0]?.id;
  }

  return { v: reg.version, zones };
}

/** Validate-and-repair against the real registry. */
export function repairDockLayout(raw: unknown): DockLayout {
  return repairLayout(raw, DOCK_REGISTRY);
}

// ── parse / persist ─────────────────────────────────────────────────────────

/**
 * The pure half of loading: text in, valid layout out. Never throws.
 * An unrecognised `v` DISCARDS the blob (returns defaults) — we never migrate.
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
  if (parsed.v !== DOCK_SCHEMA_VERSION) return defaultDockLayout();
  return repairDockLayout(parsed);
}

export function loadDockLayout(): DockLayout {
  try {
    return parseDockLayout(localStorage.getItem(ROOM_DOCK_KEY));
  } catch {
    return defaultDockLayout();
  }
}

/**
 * Persist. The layout is repaired on the way out so storage is always canonical and
 * always carries the current stamp — cheap (a handful of panels) and it means a
 * caller can never write a blob that its own loader would have to repair.
 * Mirror roomLayout: call this on COMMIT (a tab switch), not on every render.
 */
export function saveDockLayout(l: DockLayout): void {
  try {
    localStorage.setItem(ROOM_DOCK_KEY, JSON.stringify(repairDockLayout(l)));
  } catch { /* ignore */ }
}

/**
 * "Reset layout" (room-settings popover). Drops the stored blob entirely rather than
 * writing today's defaults, so a future change to the default arrangement reaches
 * users who have reset. Returns the layout the caller should put into state.
 */
export function resetDockLayout(): DockLayout {
  try { localStorage.removeItem(ROOM_DOCK_KEY); } catch { /* ignore */ }
  return defaultDockLayout();
}

// ── zone helpers (pure; used by the zone component) ─────────────────────────

export function zonePanels(l: DockLayout, zone: DockZoneId): DockPanelId[] {
  return l.zones[zone]?.panels ?? [];
}

export function activePanel(l: DockLayout, zone: DockZoneId): DockPanelId | undefined {
  return l.zones[zone]?.active;
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

/** Which zone currently holds a panel (head-bar chips deep-link into a panel). */
export function zoneOfPanel(l: DockLayout, panel: DockPanelId): DockZoneId | undefined {
  return DOCK_ZONE_IDS.find((z) => l.zones[z]?.panels.includes(panel));
}
