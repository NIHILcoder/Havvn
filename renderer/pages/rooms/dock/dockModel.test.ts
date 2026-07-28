import { describe, it, expect, afterEach } from 'vitest';
import {
  DOCK_DOCKED_ZONE_IDS,
  DOCK_MIGRATABLE_VERSIONS,
  DOCK_PANEL_IDS,
  DOCK_REGISTRY,
  DOCK_SCHEMA_VERSION,
  DOCK_SOLO_HOST_IDS,
  DOCK_WINDOW_FRAME_NAMES,
  DOCK_WINDOW_POOL_SIZE,
  DOCK_WINDOW_ZONE_IDS,
  DOCK_ZONE_IDS,
  PANELS,
  PANEL_BY_ID,
  ROOM_DOCK_KEY,
  activePanel,
  canMovePanel,
  defaultDockLayout,
  defaultLayout,
  detachPanel,
  detachTarget,
  dockAllDockWindows,
  dockAllWindowZones,
  dockBackZone,
  dockWindowFrameName,
  dockedPanelCount,
  firstFreeWindowZone,
  isDockedZone,
  isWindowZone,
  loadDockLayout,
  movePanel,
  moveTargets,
  nonEmptyDockedZones,
  openWindowZones,
  parseDockLayout,
  repairDockLayout,
  repairLayout,
  resetDockLayout,
  saveDockLayout,
  setActivePanel,
  tearOffTarget,
  tearOffZone,
  zoneIsEmpty,
  zoneOfPanel,
  zonePanels,
  type DockLayout,
  type DockPanelId,
  type DockRegistry,
  type DockZoneId,
} from './dockModel';
// Imported from the SOURCE of truth as well, so "derived, not restated" is proved
// against the file the main process allowlists from rather than against ourselves.
import { DOCK_WINDOW_FRAME_NAMES as SHARED_FRAME_NAMES } from '../../../../shared/dock-windows';

// The module reads localStorage only inside load/save/reset; these tests run in
// Node, so stub it per case (same shape as utils/voicePrefs.test.ts).
function stubStorage(initial: string | null, opts: { throwOnSet?: boolean } = {}) {
  const box = { value: initial, removed: false };
  (globalThis as any).localStorage = {
    getItem: (k: string) => (k === ROOM_DOCK_KEY ? box.value : null),
    setItem: (k: string, v: string) => {
      if (opts.throwOnSet) throw new Error('QuotaExceededError');
      if (k === ROOM_DOCK_KEY) box.value = v;
    },
    removeItem: (k: string) => { if (k === ROOM_DOCK_KEY) { box.value = null; box.removed = true; } },
  };
  return box;
}
afterEach(() => { delete (globalThis as any).localStorage; });

const base = () => defaultDockLayout();
/** The load-bearing predicate: invariant A. */
const holdsA = (l: DockLayout) => dockedPanelCount(l) > 0 && nonEmptyDockedZones(l).length > 0;
const ok = (r: { layout: DockLayout; refused: unknown }) => {
  expect(r.refused).toBeNull();
  return r.layout;
};

describe('the registry itself', () => {
  it('declares every panel exactly once, in a DOCKED zone that exists', () => {
    const ids = PANELS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...DOCK_PANEL_IDS]);
    for (const p of PANELS) expect(DOCK_DOCKED_ZONE_IDS).toContain(p.defaultZone);
    expect(PANELS.length).toBeGreaterThanOrEqual(1);
  });

  it('has a window pool big enough that tear-off can never be refused in a legal state', () => {
    // Invariant A keeps >=1 panel docked and a window zone holds >=1 panel, so at
    // most PANELS.length - 1 window zones are reachable. Adding a 6th panel without
    // a 5th slot must fail HERE rather than at a user's fifth tear-off.
    expect(DOCK_WINDOW_ZONE_IDS.length).toBeGreaterThanOrEqual(PANELS.length - 1);
    // ...and the SHARED constant is the one that has to hold, since it is what the
    // main process allowlists. shared/dock-windows.ts's header claims this
    // assertion exists; before P4 it did not, and nothing imported that file.
    expect(DOCK_WINDOW_POOL_SIZE).toBeGreaterThanOrEqual(PANELS.length - 1);
    expect(DOCK_WINDOW_ZONE_IDS.length).toBe(DOCK_WINDOW_POOL_SIZE);
  });

  it('declares which panels host their own solo affordance', () => {
    // A DOCKED zone holding exactly one of these hides its tab strip, so the
    // default room keeps the single header row it had before the dock existed.
    // Panels with no header of their own must NOT be listed: the zone body is a
    // drop target, never a drag source, so they would become unmovable.
    expect([...DOCK_SOLO_HOST_IDS]).toEqual(['files', 'chat']);
    expect(PANEL_BY_ID.people.soloHost).toBeUndefined();
    expect(PANEL_BY_ID.voice.soloHost).toBeUndefined();
    expect(PANEL_BY_ID.lan.soloHost).toBeUndefined();
  });

  it('lists docked zones first, then window zones', () => {
    expect([...DOCK_ZONE_IDS]).toEqual([...DOCK_DOCKED_ZONE_IDS, ...DOCK_WINDOW_ZONE_IDS]);
    for (const z of DOCK_DOCKED_ZONE_IDS) {
      expect(isDockedZone(z)).toBe(true);
      expect(isWindowZone(z)).toBe(false);
    }
    for (const z of DOCK_WINDOW_ZONE_IDS) {
      expect(isWindowZone(z)).toBe(true);
      expect(isDockedZone(z)).toBe(false);
    }
    expect(isDockedZone('rail')).toBe(false); // v1's name is gone
    expect(isWindowZone('w9')).toBe(false);
  });

  it('maps window zones to stable Electron frame names (main.ts keeps a literal allowlist)', () => {
    expect(dockWindowFrameName('w1')).toBe('havvn-dock-1');
    expect(dockWindowFrameName('w4')).toBe('havvn-dock-4');
    expect(DOCK_WINDOW_FRAME_NAMES).toEqual(['havvn-dock-1', 'havvn-dock-2', 'havvn-dock-3', 'havvn-dock-4']);
    // DERIVED from shared/dock-windows.ts, not restated: zone w{n} IS pool slot n.
    // Before P4 this file hand-wrote the map while three comments claimed it was
    // imported, so the two halves could drift with nothing to catch it.
    expect(DOCK_WINDOW_ZONE_IDS.map(dockWindowFrameName)).toEqual([...DOCK_WINDOW_FRAME_NAMES]);
    expect(DOCK_WINDOW_FRAME_NAMES).toEqual([...SHARED_FRAME_NAMES]);
    expect(new Set(DOCK_WINDOW_FRAME_NAMES).size).toBe(DOCK_WINDOW_ZONE_IDS.length);
    // The persisted blob must never carry an Electron naming convention.
    expect(DOCK_WINDOW_ZONE_IDS.some((z) => (DOCK_WINDOW_FRAME_NAMES as string[]).includes(z))).toBe(false);
  });

  it('exposes label + icon metadata through PANEL_BY_ID', () => {
    expect(PANEL_BY_ID.voice.labelKey).toBe('rooms.voice.title');
    expect(PANEL_BY_ID.lan.labelKey).toBe('rooms.lan.title');
    expect(PANEL_BY_ID.people.labelKey).toBe('rooms.people');
    expect(PANEL_BY_ID.files.labelKey).toBe('rooms.sharedFiles');
    expect(PANEL_BY_ID.chat.labelKey).toBe('rooms.chat');
    for (const id of DOCK_PANEL_IDS) expect(PANEL_BY_ID[id].icon).toBeTruthy();
  });

  it('marks the panels that must survive a tab switch (voice PTT, LAN latch, chat draft)', () => {
    expect(PANEL_BY_ID.voice.keepAlive).toBe(true);
    expect(PANEL_BY_ID.lan.keepAlive).toBe(true);
    expect(PANEL_BY_ID.chat.keepAlive).toBe(true);
    expect(PANEL_BY_ID.people.keepAlive).toBeFalsy();
    expect(PANEL_BY_ID.files.keepAlive).toBeFalsy();
  });
});

describe('defaults', () => {
  it('fills the three columns and leaves every window slot empty', () => {
    const l = base();
    expect(l.v).toBe(DOCK_SCHEMA_VERSION);
    expect(Object.keys(l.zones)).toEqual([...DOCK_ZONE_IDS]);
    expect(l.zones.left.panels).toEqual(['voice', 'lan', 'people']);
    expect(l.zones.centre.panels).toEqual(['files']);
    expect(l.zones.right.panels).toEqual(['chat']);
    expect(l.zones.left.active).toBe('voice');
    for (const w of DOCK_WINDOW_ZONE_IDS) {
      expect(l.zones[w].panels).toEqual([]);
      expect(l.zones[w].active).toBe('');
      expect(l.zones[w].origin).toBeUndefined();
    }
    expect(openWindowZones(l)).toEqual([]);
    expect(holdsA(l)).toBe(true);
  });

  it('hands out a fresh object each call (state is held and replaced, never shared)', () => {
    const a = base();
    const b = base();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.zones.left.panels).not.toBe(b.zones.left.panels);
    a.zones.left.panels.push('voice');
    expect(base().zones.left.panels).toEqual(['voice', 'lan', 'people']);
  });

  it('is repair-canonical: repairing the defaults changes nothing', () => {
    const d = base();
    expect(repairDockLayout(d)).toEqual(d);
  });
});

describe('parseDockLayout — garbage in, valid layout out', () => {
  const defaults = base();

  it('falls back to defaults for empty/absent text, non-JSON and non-objects', () => {
    for (const text of [null, undefined, '', '{not json', 'undefined', '5', 'null', 'true', '"roomDock"', '[]', '[{"v":2}]']) {
      expect(parseDockLayout(text as string | null | undefined)).toEqual(defaults);
    }
  });

  it('DISCARDS an unrecognised schema version instead of migrating it', () => {
    const stale = JSON.stringify({ v: 99, zones: { left: { panels: ['people'], active: 'people' } } });
    const out = parseDockLayout(stale);
    expect(out).toEqual(defaults);
    expect(out.zones.left.panels[0]).toBe('voice');
  });

  it('discards a missing or wrongly-typed version stamp', () => {
    expect(parseDockLayout(JSON.stringify({ zones: { left: { panels: ['lan'] } } }))).toEqual(defaults);
    expect(parseDockLayout(JSON.stringify({ v: '2', zones: { left: { panels: ['lan'] } } }))).toEqual(defaults);
    expect(parseDockLayout(JSON.stringify({ v: null, zones: {} }))).toEqual(defaults);
    expect(parseDockLayout(JSON.stringify({ v: 0, zones: {} }))).toEqual(defaults);
  });

  it('accepts and repairs a blob at the current version', () => {
    const text = JSON.stringify({
      v: DOCK_SCHEMA_VERSION,
      zones: { left: { panels: ['people', 'voice', 'lan'], active: 'lan' }, right: { panels: ['chat', 'files'], active: 'files' } },
    });
    const out = parseDockLayout(text);
    expect(out.zones.left.panels).toEqual(['people', 'voice', 'lan']);
    expect(out.zones.left.active).toBe('lan');
    expect(out.zones.right.panels).toEqual(['chat', 'files']);
    expect(out.zones.centre.panels).toEqual([]); // an empty docked column is legal in v2
  });
});

// The v1 blob is a RENAME away from v2, so it is read forward rather than thrown
// away: a user who arranged their P1 rail keeps that arrangement.
describe('v1 migration (a P1 rail layout must not be lost)', () => {
  it('declares v1 migratable and reads its rail as the left column', () => {
    expect(DOCK_MIGRATABLE_VERSIONS).toContain(1);
    const out = parseDockLayout(JSON.stringify({ v: 1, zones: { rail: { panels: ['people', 'lan', 'voice'], active: 'lan' } } }));
    expect(out.v).toBe(DOCK_SCHEMA_VERSION);
    expect(out.zones.left.panels).toEqual(['people', 'lan', 'voice']);
    expect(out.zones.left.active).toBe('lan');
    // panels v1 never knew are re-added at their v2 defaults
    expect(out.zones.centre.panels).toEqual(['files']);
    expect(out.zones.right.panels).toEqual(['chat']);
    expect((out.zones as Record<string, unknown>).rail).toBeUndefined();
    expect(holdsA(out)).toBe(true);
  });

  it('repairs a damaged v1 blob rather than trusting it', () => {
    const out = parseDockLayout(JSON.stringify({ v: 1, zones: { rail: { panels: ['lan', 'lan', 'ghost', 7], active: 'ghost' } } }));
    expect(out.zones.left.panels).toEqual(['lan', 'voice', 'people']);
    expect(out.zones.left.active).toBe('lan');
  });

  it('prefers an already-migrated left zone if a blob somehow carries both', () => {
    const out = parseDockLayout(JSON.stringify({ v: 1, zones: { left: { panels: ['voice'] }, rail: { panels: ['people'] } } }));
    expect(out.zones.left.panels).toEqual(['voice', 'lan', 'people']);
  });
});

describe('repairDockLayout — validate and repair', () => {
  const left = (panels: unknown, active?: unknown) =>
    repairDockLayout({ v: DOCK_SCHEMA_VERSION, zones: { left: { panels, active } } }).zones.left;

  it('drops unknown and non-string panel ids', () => {
    expect(left(['voice', 'bogus', 42, null, { id: 'lan' }, ['people'], 'lan']).panels)
      .toEqual(['voice', 'lan', 'people']);
  });

  it('dedupes, keeping the first occurrence', () => {
    expect(left(['people', 'voice', 'people', 'lan', 'voice']).panels).toEqual(['people', 'voice', 'lan']);
  });

  it('re-adds missing known panels into their DEFAULT zone, not into the survivor', () => {
    const out = repairDockLayout({ v: 2, zones: { left: { panels: ['people'] } } });
    expect(out.zones.left.panels).toEqual(['people', 'voice', 'lan']);
    expect(out.zones.centre.panels).toEqual(['files']);
    expect(out.zones.right.panels).toEqual(['chat']);
  });

  it('LETS A DOCKED ZONE BE EMPTY (v1 reclaim rule deleted — a move must not bounce back)', () => {
    const out = repairDockLayout({
      v: 2,
      zones: { left: { panels: ['voice', 'lan', 'people', 'files', 'chat'], active: 'files' }, centre: { panels: [] }, right: { panels: [] } },
    });
    expect(out.zones.centre.panels).toEqual([]);
    expect(out.zones.centre.active).toBe('');
    expect(out.zones.right.panels).toEqual([]);
    expect(out.zones.left.active).toBe('files');
    expect(zoneIsEmpty(out, 'right')).toBe(true);
    expect(holdsA(out)).toBe(true);
  });

  it('resolves a panel claimed by both a docked and a window zone in favour of DOCKED', () => {
    const out = repairDockLayout({
      v: 2,
      zones: { left: { panels: ['voice', 'chat'] }, w1: { panels: ['chat', 'people'] } },
    });
    expect(out.zones.left.panels).toEqual(['voice', 'chat', 'lan']);
    expect(out.zones.w1.panels).toEqual(['people']);
  });

  it('survives a zone that is missing, null, or not an object', () => {
    const defaults = base();
    expect(repairDockLayout({ v: 2, zones: {} })).toEqual(defaults);
    expect(repairDockLayout({ v: 2, zones: { left: null, w1: 3 } })).toEqual(defaults);
    expect(repairDockLayout({ v: 2, zones: { left: 'people' } })).toEqual(defaults);
    expect(repairDockLayout({ v: 2, zones: [] })).toEqual(defaults);
    expect(repairDockLayout({ v: 2 })).toEqual(defaults);
    expect(repairDockLayout(undefined)).toEqual(defaults);
    expect(repairDockLayout('nonsense')).toEqual(defaults);
  });

  it('drops unknown zone keys — including a window slot the pool no longer has', () => {
    const out = repairDockLayout({
      v: 2,
      zones: { left: { panels: ['lan'] }, ghost: { panels: ['voice'] }, w9: { panels: ['chat'], origin: 'right' } },
    });
    expect(Object.keys(out.zones)).toEqual([...DOCK_ZONE_IDS]);
    // A panel whose window is gone comes back to a docked zone rather than vanishing.
    expect(out.zones.left.panels).toEqual(['lan', 'voice', 'people']);
    expect(out.zones.right.panels).toEqual(['chat']);
    expect(zoneOfPanel(out, 'chat')).toBe('right');
  });

  it('drops unknown top-level and per-zone keys (field-by-field rebuild, never a spread)', () => {
    const out = repairDockLayout({
      v: 2,
      zones: { left: { panels: ['voice'], active: 'voice', junk: 1 }, w1: { panels: ['chat'], origin: 'right', junk: 2 } },
      extra: 'nope',
    }) as unknown as Record<string, any>;
    expect(Object.keys(out).sort()).toEqual(['v', 'zones']);
    expect(Object.keys(out.zones.left).sort()).toEqual(['active', 'panels']);
    expect(Object.keys(out.zones.w1).sort()).toEqual(['active', 'origin', 'panels']);
  });

  it('keeps a window zone origin only when it names a real docked zone', () => {
    const mk = (origin: unknown) => repairDockLayout({ v: 2, zones: { w1: { panels: ['chat'], origin } } }).zones.w1.origin;
    expect(mk('right')).toBe('right');
    expect(mk('w2')).toBeUndefined();
    expect(mk('rail')).toBeUndefined();
    expect(mk(7)).toBeUndefined();
    expect(mk(undefined)).toBeUndefined();
    // origin is meaningless on a docked zone and on an empty window zone
    expect((repairDockLayout({ v: 2, zones: { left: { panels: ['voice'], origin: 'right' } } }).zones.left as any).origin).toBeUndefined();
    expect(repairDockLayout({ v: 2, zones: { w2: { panels: [], origin: 'left' } } }).zones.w2.origin).toBeUndefined();
  });

  it("resolves each zone's active last: kept, else first panel, else ''", () => {
    expect(left(['voice', 'lan', 'people'], 'people').active).toBe('people');
    expect(left(['voice', 'lan', 'people'], 'ghost').active).toBe('voice');
    expect(left(['people', 'voice', 'lan'], undefined).active).toBe('people');
    expect(left(['voice', 'lan'], 7).active).toBe('voice');
    expect(left(['voice', 'lan'], 'chat').active).toBe('voice'); // valid id, wrong zone
    const emptied = repairDockLayout({ v: 2, zones: { left: { panels: ['voice', 'lan', 'people', 'files', 'chat'] }, right: { panels: [], active: 'chat' } } });
    expect(emptied.zones.right.active).toBe('');
  });

  it('always stamps the current version, whatever the input claimed', () => {
    expect(repairDockLayout({ v: 4, zones: {} }).v).toBe(DOCK_SCHEMA_VERSION);
    expect(repairDockLayout({ v: 'x', zones: {} }).v).toBe(DOCK_SCHEMA_VERSION);
  });

  it('is idempotent, including across a JSON round-trip', () => {
    for (const raw of [
      undefined,
      { v: 2, zones: { left: { panels: ['people', 'people', 'nope'], active: 'nope' } } },
      { v: 2, zones: { left: { panels: [] }, centre: { panels: [] }, right: { panels: [] } } },
      { v: 2, zones: { left: { panels: ['lan', 'voice'], active: 'voice' }, w1: { panels: ['chat'], origin: 'right' } } },
      { v: 2, zones: { w1: { panels: ['voice', 'lan'] }, w2: { panels: ['people', 'files', 'chat'], origin: 'centre' } } },
      { v: 2, zones: { w1: { panels: ['voice'], origin: 'zzz' }, ghost: { panels: ['chat'] } } },
    ]) {
      const once = repairDockLayout(raw);
      expect(repairDockLayout(once)).toEqual(once);
      expect(repairDockLayout(JSON.parse(JSON.stringify(once)))).toEqual(once);
    }
  });
});

// INVARIANT A, from every angle the phase can reach it.
describe('invariant A — the room can never be empty', () => {
  it('folds every window zone home when NO docked zone holds a panel', () => {
    const out = repairDockLayout({
      v: 2,
      zones: {
        left: { panels: [] }, centre: { panels: [] }, right: { panels: [] },
        w1: { panels: ['voice', 'lan'], origin: 'right' },
        w2: { panels: ['people', 'files', 'chat'] },
      },
    });
    expect(openWindowZones(out)).toEqual([]);
    // w1 had an origin, so its GROUP came home together; w2 had none, so its panels
    // fell back to their own defaults.
    expect(out.zones.right.panels).toEqual(['voice', 'lan', 'chat']);
    expect(out.zones.left.panels).toEqual(['people']);
    expect(out.zones.centre.panels).toEqual(['files']);
    expect(out.zones.right.active).toBe('voice');
    expect(holdsA(out)).toBe(true);
  });

  it('leaves a legal torn-off arrangement alone (repair is not a fold-everything pass)', () => {
    const out = repairDockLayout({
      v: 2,
      zones: { left: { panels: ['voice'] }, centre: { panels: [] }, right: { panels: [] }, w1: { panels: ['lan', 'people'], origin: 'left' } },
    });
    expect(out.zones.w1.panels).toEqual(['lan', 'people']);
    expect(openWindowZones(out)).toEqual(['w1']);
    expect(holdsA(out)).toBe(true);
  });

  it('re-establishes A no matter what it is handed', () => {
    const nasty: unknown[] = [
      undefined, null, 0, '', 'junk', [], {},
      { v: 2 },
      { v: 2, zones: {} },
      { v: 2, zones: { left: { panels: [] }, centre: { panels: [] }, right: { panels: [] } } },
      { v: 2, zones: { w1: { panels: ['voice', 'lan', 'people', 'files', 'chat'] } } },
      { v: 2, zones: { w1: { panels: ['voice'] }, w2: { panels: ['lan'] }, w3: { panels: ['people'] }, w4: { panels: ['files', 'chat'] } } },
      { v: 2, zones: { w1: { panels: ['voice'], origin: 'nowhere' }, w9: { panels: ['chat'] } } },
      { v: 2, zones: { left: { panels: ['nope'] }, w1: { panels: ['voice', 'lan', 'people', 'files', 'chat'], origin: 'centre' } } },
    ];
    for (const raw of nasty) {
      const out = repairDockLayout(raw);
      expect(holdsA(out)).toBe(true);
      // every known panel is somewhere, exactly once
      const all = DOCK_ZONE_IDS.flatMap((z) => out.zones[z].panels);
      expect([...all].sort()).toEqual([...DOCK_PANEL_IDS].sort());
      // and repair is stable
      expect(repairDockLayout(out)).toEqual(out);
    }
  });

  it('dockAllWindowZones is identity when already fully docked, and idempotent', () => {
    const b = base();
    expect(dockAllDockWindows(b)).toBe(b);
    const torn = ok(tearOffZone(b, 'left'));
    const folded = dockAllDockWindows(torn);
    expect(folded).not.toBe(torn);
    expect(openWindowZones(folded)).toEqual([]);
    expect(folded.zones.left.panels).toEqual(['voice', 'lan', 'people']);
    expect(dockAllDockWindows(folded)).toBe(folded);
  });

  it('a persisted layout can never carry a torn-off group (the shape, not a rule)', () => {
    const box = stubStorage(null);
    const torn = ok(tearOffZone(ok(tearOffZone(base(), 'left')), 'centre'));
    expect(openWindowZones(torn)).toEqual(['w1', 'w2']);
    saveDockLayout(torn);
    const written = JSON.parse(box.value!);
    expect(Object.keys(written.zones)).toEqual([...DOCK_DOCKED_ZONE_IDS]);
    const reloaded = loadDockLayout();
    expect(openWindowZones(reloaded)).toEqual([]);
    expect(reloaded.zones.left.panels).toEqual(['voice', 'lan', 'people']); // back where it was torn from
    expect(reloaded.zones.centre.panels).toEqual(['files']);
    expect(holdsA(reloaded)).toBe(true);
  });

  it('a hand-crafted blob claiming a torn-off group is folded home on the way in', () => {
    const text = JSON.stringify({
      v: 2,
      zones: { left: { panels: ['voice'] }, w1: { panels: ['lan', 'people'], origin: 'left' }, w2: { panels: ['chat'] } },
    });
    // repair alone keeps it (A holds) — the PARSE boundary is what folds.
    expect(openWindowZones(repairDockLayout(JSON.parse(text)))).toEqual(['w1', 'w2']);
    const out = parseDockLayout(text);
    expect(openWindowZones(out)).toEqual([]);
    expect(out.zones.left.panels).toEqual(['voice', 'lan', 'people']);
    expect(out.zones.right.panels).toEqual(['chat']);
  });
});

describe('queries', () => {
  it('reads panels, the active tab and emptiness', () => {
    const b = base();
    expect(zonePanels(b, 'left')).toEqual(['voice', 'lan', 'people']);
    expect(activePanel(b, 'left')).toBe('voice');
    expect(activePanel(b, 'w1')).toBe('');
    expect(zoneIsEmpty(b, 'w1')).toBe(true);
    expect(zoneIsEmpty(b, 'right')).toBe(false);
    expect(zonePanels(b, 'nope' as DockZoneId)).toEqual([]);
    expect(activePanel(b, 'nope' as DockZoneId)).toBe('');
  });

  it('finds the zone holding a panel, docked or windowed', () => {
    const b = base();
    expect(zoneOfPanel(b, 'lan')).toBe('left');
    expect(zoneOfPanel(b, 'chat')).toBe('right');
    const torn = ok(tearOffZone(b, 'right'));
    expect(zoneOfPanel(torn, 'chat')).toBe('w1');
  });

  it('counts docked panels and finds the lowest free window slot', () => {
    const b = base();
    expect(dockedPanelCount(b)).toBe(5);
    expect(firstFreeWindowZone(b)).toBe('w1');
    const torn = ok(tearOffZone(b, 'left'));
    expect(dockedPanelCount(torn)).toBe(2);
    expect(firstFreeWindowZone(torn)).toBe('w2');
    expect(nonEmptyDockedZones(torn)).toEqual(['centre', 'right']);
    expect(firstFreeWindowZone(b, { ...DOCK_REGISTRY, windowZoneIds: [] })).toBeNull();
  });

  it('setActivePanel is a no-op (same reference) when nothing would change', () => {
    const b = base();
    expect(setActivePanel(b, 'left', 'voice')).toBe(b);
    expect(setActivePanel(b, 'left', 'chat')).toBe(b); // not in that zone
    expect(setActivePanel(b, 'w1', 'chat')).toBe(b);
    const next = setActivePanel(b, 'left', 'lan');
    expect(next).not.toBe(b);
    expect(next.zones.left.active).toBe('lan');
    expect(b.zones.left.active).toBe('voice');
    expect(next.zones.centre).toBe(b.zones.centre); // untouched zones keep identity
  });
});

describe('movePanel', () => {
  it('moves a panel between docked zones and activates it at the destination', () => {
    const out = ok(movePanel(base(), 'chat', 'left'));
    expect(out.zones.left.panels).toEqual(['voice', 'lan', 'people', 'chat']);
    expect(out.zones.left.active).toBe('chat');
    expect(out.zones.right.panels).toEqual([]);
    expect(out.zones.right.active).toBe('');
    expect(holdsA(out)).toBe(true);
  });

  it('inserts at an index, and appends when none is given', () => {
    expect(ok(movePanel(base(), 'chat', 'left', 0)).zones.left.panels).toEqual(['chat', 'voice', 'lan', 'people']);
    expect(ok(movePanel(base(), 'chat', 'left', 2)).zones.left.panels).toEqual(['voice', 'lan', 'chat', 'people']);
    expect(ok(movePanel(base(), 'chat', 'left', 99)).zones.left.panels).toEqual(['voice', 'lan', 'people', 'chat']);
    expect(ok(movePanel(base(), 'chat', 'left', -3)).zones.left.panels).toEqual(['chat', 'voice', 'lan', 'people']);
    expect(ok(movePanel(base(), 'chat', 'left', NaN)).zones.left.panels).toEqual(['voice', 'lan', 'people', 'chat']);
    expect(ok(movePanel(base(), 'chat', 'left', 1.7)).zones.left.panels).toEqual(['voice', 'chat', 'lan', 'people']);
  });

  it('reorders within a zone', () => {
    const out = ok(movePanel(base(), 'people', 'left', 0));
    expect(out.zones.left.panels).toEqual(['people', 'voice', 'lan']);
    expect(out.zones.left.active).toBe('people');
  });

  it("hands the source's active tab to the SAME INDEX, clamped — never back to the first", () => {
    const b = setActivePanel(base(), 'left', 'lan'); // index 1 of 3
    expect(ok(movePanel(b, 'lan', 'centre')).zones.left.active).toBe('people'); // right-hand neighbour
    const last = setActivePanel(base(), 'left', 'people'); // index 2 of 3
    expect(ok(movePanel(last, 'people', 'centre')).zones.left.active).toBe('lan'); // else the left one
    // an untouched active tab stays put
    expect(ok(movePanel(b, 'voice', 'centre')).zones.left.active).toBe('lan');
  });

  it('returns the INPUT object when nothing would change', () => {
    const b = base();
    expect(movePanel(b, 'voice', 'left').layout).toBe(b);          // same zone, no index
    expect(movePanel(b, 'voice', 'left', 0).layout).toBe(b);       // same zone, same slot, already active
    expect(movePanel(b, 'lan', 'left', 1).layout).not.toBe(b);     // same slot but activates it
    expect(movePanel(b, 'lan', 'left', 1).layout.zones.left.active).toBe('lan');
  });

  it('leaves untouched zones referentially identical (a move must not re-render the room)', () => {
    const b = base();
    const out = ok(movePanel(b, 'chat', 'left'));
    expect(out.zones.centre).toBe(b.zones.centre);
    for (const w of DOCK_WINDOW_ZONE_IDS) expect(out.zones[w]).toBe(b.zones[w]);
    expect(b.zones.left.panels).toEqual(['voice', 'lan', 'people']); // input untouched
  });

  it('refuses an unknown panel or an unknown zone, without touching the layout', () => {
    const b = base();
    const bad = movePanel(b, 'nope' as DockPanelId, 'left');
    expect(bad.refused).toBe('unknown-panel');
    expect(bad.layout).toBe(b);
    expect(bad.zone).toBeNull();
    expect(movePanel(b, 'chat', 'nowhere' as DockZoneId).refused).toBe('unknown-zone');
    expect(canMovePanel(b, 'nope' as DockPanelId, 'left')).toBe('unknown-panel');
    expect(canMovePanel(b, 'chat', 'w9' as DockZoneId)).toBe('unknown-zone');
    expect(canMovePanel(b, 'chat', 'right')).toBeNull(); // its own zone is always legal
  });

  it('REFUSES the move that would empty the main window, and allows every other one', () => {
    // Everything but chat is already torn off.
    let l = ok(tearOffZone(base(), 'left'));
    l = ok(tearOffZone(l, 'centre'));
    expect(nonEmptyDockedZones(l)).toEqual(['right']);
    expect(canMovePanel(l, 'chat', 'w3')).toBe('last-docked-group');
    const refused = movePanel(l, 'chat', 'w3');
    expect(refused.refused).toBe('last-docked-group');
    expect(refused.layout).toBe(l);
    // ...but docked -> docked is always fine, and it keeps A true
    const moved = ok(movePanel(l, 'chat', 'left'));
    expect(moved.zones.left.panels).toEqual(['chat']);
    expect(holdsA(moved)).toBe(true);
    // ...and moving a panel INTO the main window from a window zone never refuses
    expect(canMovePanel(l, 'voice', 'centre')).toBeNull();
    expect(ok(movePanel(l, 'voice', 'centre')).zones.w1.panels).toEqual(['lan', 'people']);
  });

  it('an emptied window zone ceases to exist, origin and all', () => {
    const torn = ok(tearOffZone(base(), 'right'));
    expect(torn.zones.w1.origin).toBe('right');
    const back = ok(movePanel(torn, 'chat', 'centre'));
    expect(back.zones.w1).toEqual({ panels: [], active: '' });
    expect(back.zones.w1.origin).toBeUndefined();
    expect(openWindowZones(back)).toEqual([]);
    // ...but a group that merely LOSES a panel keeps its origin and its identity
    const group = ok(tearOffZone(base(), 'left'));
    const thinner = ok(movePanel(group, 'people', 'centre'));
    expect(thinner.zones.w1.panels).toEqual(['voice', 'lan']);
    expect(thinner.zones.w1.origin).toBe('left');
    expect(ok(dockBackZone(thinner, 'w1')).zones.left.panels).toEqual(['voice', 'lan']);
  });

  it('a move into a fresh window slot remembers where the panel came from', () => {
    const out = ok(movePanel(base(), 'chat', 'w2'));
    expect(out.zones.w2.panels).toEqual(['chat']);
    expect(out.zones.w2.origin).toBe('right');
    // a second panel joining that group does not rewrite its origin
    const joined = ok(movePanel(out, 'files', 'w2'));
    expect(joined.zones.w2.panels).toEqual(['chat', 'files']);
    expect(joined.zones.w2.origin).toBe('right');
  });
});

describe('detachPanel / tearOffZone / dockBackZone', () => {
  it('detaches ONE panel into the lowest free slot', () => {
    const r = detachPanel(base(), 'chat');
    expect(r.refused).toBeNull();
    expect(r.zone).toBe('w1');
    expect(r.layout.zones.w1).toEqual({ panels: ['chat'], active: 'chat', origin: 'right' });
    expect(r.layout.zones.right.panels).toEqual([]);
  });

  it('refuses "new window" for a panel that ALREADY has a window to itself', () => {
    // Honouring it would allocate the next free slot and MOVE the panel there: the
    // current window closes and a different one opens, at a different remembered
    // geometry (bounds persist per slot). The user asked for a new window and would
    // get their existing one teleported.
    const alone = ok(detachPanel(base(), 'chat'));
    expect(zonePanels(alone, 'w1')).toEqual(['chat']);
    const again = detachPanel(alone, 'chat');
    expect(again.refused).toBe('already-own-window');
    expect(again.layout).toBe(alone);
    // ...and the menu learns it through the same path, so the item disables itself
    // with the reason attached instead of silently doing the wrong thing.
    expect(detachTarget(alone, 'chat').refused).toBe('already-own-window');
  });

  it('still allows "new window" for a panel SHARING a window with another', () => {
    // Splitting a torn-off group is a real request: the panel gets its own slot and
    // the original window keeps the rest.
    const grouped = ok(movePanel(base(), 'chat', 'left'));
    const torn = ok(tearOffZone(grouped, 'left'));
    const split = detachPanel(torn, 'chat');
    expect(split.refused).toBeNull();
    expect(split.zone).toBe('w2');
    expect(zonePanels(split.layout, 'w1')).toEqual(['voice', 'lan', 'people']);
  });

  it('tears off the WHOLE group, order and active tab intact', () => {
    const b = setActivePanel(base(), 'left', 'people');
    const r = tearOffZone(b, 'left');
    expect(r.zone).toBe('w1');
    expect(r.layout.zones.w1).toEqual({ panels: ['voice', 'lan', 'people'], active: 'people', origin: 'left' });
    expect(r.layout.zones.left).toEqual({ panels: [], active: '' });
    expect(holdsA(r.layout)).toBe(true);
  });

  it('supports the headline arrangement: drag Chat into Voice\'s strip, then tear that strip off', () => {
    const grouped = ok(movePanel(base(), 'chat', 'left'));
    const torn = tearOffZone(grouped, 'left');
    expect(torn.layout.zones.w1.panels).toEqual(['voice', 'lan', 'people', 'chat']);
    expect(torn.layout.zones.w1.origin).toBe('left');
    expect(nonEmptyDockedZones(torn.layout)).toEqual(['centre']);
    expect(holdsA(torn.layout)).toBe(true);
  });

  it('refuses to tear off anything that is not a docked group', () => {
    const b = base();
    expect(tearOffZone(b, 'w1').refused).toBe('unknown-zone');     // already a window
    expect(tearOffZone(b, 'nope' as DockZoneId).refused).toBe('unknown-zone');
    const emptied = ok(movePanel(b, 'chat', 'left'));
    expect(tearOffZone(emptied, 'right').refused).toBe('unknown-zone'); // nothing to tear off
    expect(tearOffTarget(emptied, 'right').refused).toBe('unknown-zone');
    expect(tearOffZone(b, 'left').layout).not.toBe(b);
    expect(tearOffZone(b, 'w1').layout).toBe(b);
  });

  it('REFUSES to tear off the last docked group', () => {
    let l = ok(tearOffZone(base(), 'left'));
    l = ok(tearOffZone(l, 'centre'));
    const r = tearOffZone(l, 'right');
    expect(r.refused).toBe('last-docked-group');
    expect(r.layout).toBe(l);
    expect(holdsA(l)).toBe(true);
    expect(detachPanel(l, 'chat').refused).toBe('last-docked-group');
    expect(detachTarget(l, 'chat').refused).toBe('last-docked-group');
  });

  it('refuses a detach when the pool is exhausted, and says so', () => {
    // The real pool can never be exhausted (A refuses first), so prove the branch
    // against a two-slot registry.
    const small: DockRegistry = { ...DOCK_REGISTRY, windowZoneIds: ['w1', 'w2'] };
    let l = ok(detachPanel(base(), 'voice', small));
    l = ok(detachPanel(l, 'lan', small));
    expect(firstFreeWindowZone(l, small)).toBeNull();
    const r = detachPanel(l, 'people', small);
    expect(r.refused).toBe('window-pool-exhausted');
    expect(r.layout).toBe(l);
    expect(detachTarget(l, 'people', small).refused).toBe('window-pool-exhausted');
    expect(tearOffZone(l, 'left', small).refused).toBe('window-pool-exhausted');
    // invariant A is checked FIRST, so the honest reason wins over the pool one
    const noSlots: DockRegistry = { ...DOCK_REGISTRY, windowZoneIds: [] };
    let alone = ok(movePanel(base(), 'files', 'left'));
    alone = ok(movePanel(alone, 'chat', 'left'));
    expect(detachPanel(alone, 'voice', noSlots).refused).toBe('window-pool-exhausted');
    const onlyOne = repairDockLayout({ v: 2, zones: { left: { panels: ['voice'] }, w1: { panels: ['lan', 'people', 'files', 'chat'] } } });
    expect(detachPanel(onlyOne, 'voice').refused).toBe('last-docked-group');
  });

  it('detach refuses an unknown panel', () => {
    const b = base();
    expect(detachPanel(b, 'nope' as DockPanelId).refused).toBe('unknown-panel');
    expect(detachPanel(b, 'nope' as DockPanelId).layout).toBe(b);
  });

  it('docks a group back where it came from, as a group', () => {
    const torn = ok(tearOffZone(setActivePanel(base(), 'left', 'lan'), 'left'));
    const r = dockBackZone(torn, 'w1');
    expect(r.zone).toBe('left');
    expect(r.layout.zones.left).toEqual({ panels: ['voice', 'lan', 'people'], active: 'lan' });
    expect(r.layout.zones.w1).toEqual({ panels: [], active: '' });
  });

  it('appends to whatever the destination now holds, and honours an explicit target', () => {
    const torn = ok(tearOffZone(base(), 'right'));           // w1 = [chat], origin right
    const filled = ok(movePanel(torn, 'files', 'right'));    // someone else moved in
    const r = dockBackZone(filled, 'w1');
    expect(r.layout.zones.right.panels).toEqual(['files', 'chat']);
    expect(r.layout.zones.right.active).toBe('chat');
    expect(dockBackZone(filled, 'w1', 'centre').layout.zones.centre.panels).toEqual(['chat']);
    expect(dockBackZone(filled, 'w1', 'w2' as never).refused).toBe('unknown-zone');
  });

  it('falls back to the first non-empty docked zone when the group has no origin', () => {
    const l = repairDockLayout({
      v: 2,
      zones: { left: { panels: [] }, centre: { panels: ['voice', 'lan', 'people', 'files'] }, w1: { panels: ['chat'] } },
    });
    expect(l.zones.w1.origin).toBeUndefined();
    const r = dockBackZone(l, 'w1');
    expect(r.zone).toBe('centre');
    expect(r.layout.zones.centre.panels).toEqual(['voice', 'lan', 'people', 'files', 'chat']);
  });

  it('refuses to dock back a slot that holds nothing', () => {
    const b = base();
    expect(dockBackZone(b, 'w1').refused).toBe('unknown-zone');
    expect(dockBackZone(b, 'w1').layout).toBe(b);
    expect(dockBackZone(b, 'nope' as never).refused).toBe('unknown-zone');
  });

  it('tear-off then dock-back is a round trip', () => {
    const b = setActivePanel(base(), 'left', 'people');
    const back = ok(dockBackZone(ok(tearOffZone(b, 'left')), 'w1'));
    expect(back).toEqual(b);
  });
});

// `reconcileWindows` was deleted in P4 (see the note where it used to live). What
// it existed to guarantee — N simultaneous window deaths collapsing into one
// correct repair — is a property of dockBackZone being IDEMPOTENT plus the room
// committing dock ops as functional updates, so that is what is pinned here.
describe('window death is repaired one frame at a time, idempotently', () => {
  it('dockBackZone on an already-empty window zone is identity', () => {
    const b = base();
    const torn = ok(tearOffZone(b, 'left'));
    const home = ok(dockBackZone(torn, 'w1'));
    // The second signal for the same window (beforeunload AND win:popoutClosed both
    // arrive for a user-closed window) must change nothing at all.
    const again = dockBackZone(home, 'w1');
    expect(again.refused).toBe('unknown-zone');
    expect(again.layout).toBe(home);
    // ...and a slot that never held anything is the same case.
    expect(dockBackZone(b, 'w3').layout).toBe(b);
  });

  it('two windows dying in one batch both come home when chained through prev', () => {
    // This is exactly what a functional `setDock(prev => ...)` does; the hazard the
    // deleted helper addressed was the NON-functional update, not the model.
    let l = ok(tearOffZone(base(), 'left'));
    l = ok(tearOffZone(l, 'centre'));
    expect(openWindowZones(l)).toEqual(['w1', 'w2']);
    const out = ok(dockBackZone(ok(dockBackZone(l, 'w1')), 'w2'));
    expect(openWindowZones(out)).toEqual([]);
    expect(out.zones.left.panels).toEqual(['voice', 'lan', 'people']);
    expect(out.zones.centre.panels).toEqual(['files']);
    expect(holdsA(out)).toBe(true);
  });

  it('a window that failed to OPEN is the same single-slot repair', () => {
    let l = ok(tearOffZone(base(), 'left'));
    l = ok(tearOffZone(l, 'centre'));
    const one = ok(dockBackZone(l, 'w2'));
    expect(openWindowZones(one)).toEqual(['w1']);
    expect(one.zones.centre.panels).toEqual(['files']);
  });
});

describe('moveTargets / detachTarget — the accessible menu', () => {
  it('lists every docked zone with the refusal the move would give', () => {
    const b = base();
    expect(moveTargets(b, 'chat')).toEqual([
      { zone: 'left', refused: null },
      { zone: 'centre', refused: null },
      { zone: 'right', refused: null }, // its own zone stays listed, so the menu has a stable shape
    ]);
    expect(detachTarget(b, 'chat').refused).toBeNull();
    let l = ok(tearOffZone(b, 'left'));
    l = ok(tearOffZone(l, 'centre'));
    expect(moveTargets(l, 'chat').every((t) => t.refused === null)).toBe(true);
    expect(detachTarget(l, 'chat').refused).toBe('last-docked-group');
  });

  it('asking for a target never mutates anything', () => {
    const b = base();
    const snapshot = JSON.stringify(b);
    moveTargets(b, 'chat');
    detachTarget(b, 'chat');
    tearOffTarget(b, 'left');
    expect(JSON.stringify(b)).toBe(snapshot);
  });
});

describe('persistence', () => {
  it('round-trips through localStorage', () => {
    const box = stubStorage(null);
    const l = ok(movePanel(setActivePanel(base(), 'left', 'people'), 'chat', 'centre'));
    saveDockLayout(l);
    expect(JSON.parse(box.value!).v).toBe(DOCK_SCHEMA_VERSION);
    const back = loadDockLayout();
    expect(back.zones.left.active).toBe('people');
    expect(back.zones.centre.panels).toEqual(['files', 'chat']);
    expect(back.zones.right.panels).toEqual([]);
  });

  it('writes a canonical blob even when handed a damaged layout', () => {
    const box = stubStorage(null);
    saveDockLayout({ v: 0, zones: { left: { panels: ['people', 'people'] as any, active: 'ghost' as any } } } as unknown as DockLayout);
    const written = JSON.parse(box.value!);
    expect(written.v).toBe(DOCK_SCHEMA_VERSION);
    expect(written.zones.left.panels).toEqual(['people', 'voice', 'lan']);
    expect(written.zones.left.active).toBe('people');
    expect(written.zones.centre.panels).toEqual(['files']);
  });

  it('swallows a storage write failure (private mode / quota)', () => {
    stubStorage(null, { throwOnSet: true });
    expect(() => saveDockLayout(base())).not.toThrow();
  });

  it('returns defaults when storage holds junk, and when storage is absent entirely', () => {
    stubStorage('¯\\_(ツ)_/¯');
    expect(loadDockLayout()).toEqual(base());
    delete (globalThis as any).localStorage; // no DOM at all
    expect(loadDockLayout()).toEqual(base());
  });

  it('resetDockLayout drops the stored blob and returns defaults', () => {
    const box = stubStorage(JSON.stringify({ v: DOCK_SCHEMA_VERSION, zones: { left: { panels: ['people'], active: 'people' } } }));
    const out = resetDockLayout();
    expect(out).toEqual(base());
    expect(box.removed).toBe(true);
    expect(box.value).toBeNull();
    expect(loadDockLayout()).toEqual(base());
  });

  it('resetDockLayout does not throw when storage is unavailable', () => {
    expect(() => resetDockLayout()).not.toThrow();
  });

  it('uses its own storage key so a corrupt dock blob cannot touch the splitter widths', () => {
    expect(ROOM_DOCK_KEY).not.toBe('roomLayout');
  });
});

// The schema stays generic over the panel/zone unions so a later phase can add a
// zone or a pool slot without a version bump — and so the repair pass is testable
// against registries the real one cannot express.
describe('generic registries (no schema break)', () => {
  type P = 'a' | 'b' | 'c';
  type D = 'main' | 'side';
  type W = 'x1' | 'x2';
  const REG: DockRegistry<P, D, W> = {
    version: DOCK_SCHEMA_VERSION,
    dockedZoneIds: ['main', 'side'],
    windowZoneIds: ['x1', 'x2'],
    panels: [
      { id: 'a', defaultZone: 'main' },
      { id: 'b', defaultZone: 'main' },
      { id: 'c', defaultZone: 'side' },
    ],
  };
  const repair = (raw: unknown) => repairLayout(raw, REG);

  it('places each panel in its default zone and leaves the pool empty', () => {
    const d = defaultLayout(REG);
    expect(d.zones.main.panels).toEqual(['a', 'b']);
    expect(d.zones.side.panels).toEqual(['c']);
    expect(d.zones.x1).toEqual({ panels: [], active: '' });
    expect(d.zones.main.active).toBe('a');
  });

  it('honours an arrangement the user made, windows included', () => {
    const out = repair({ zones: { main: { panels: ['a'] }, side: { panels: [] }, x1: { panels: ['c', 'b'], active: 'b', origin: 'side' } } });
    expect(out.zones.main.panels).toEqual(['a']);
    expect(out.zones.side.panels).toEqual([]);
    expect(out.zones.x1.panels).toEqual(['c', 'b']);
    expect(out.zones.x1.active).toBe('b');
    expect(out.zones.x1.origin).toBe('side');
  });

  it('re-establishes invariant A for a registry of its own shape', () => {
    const out = repair({ zones: { main: { panels: [] }, side: { panels: [] }, x1: { panels: ['a', 'b'], origin: 'side' }, x2: { panels: ['c'] } } });
    // x1 carried an origin, so its group went there whole; x2 had none, so 'c'
    // fell back to its own defaultZone — which is 'side' as well.
    expect(out.zones.side.panels).toEqual(['a', 'b', 'c']);
    expect(out.zones.main.panels).toEqual([]);
    expect(out.zones.side.panels.length + out.zones.main.panels.length).toBeGreaterThan(0);
    expect(out.zones.side.active).toBe('a');
    expect(out.zones.x1.panels).toEqual([]);
    expect(repair(out)).toEqual(out);
  });

  it('degrades safely when a registry declares fewer panels than zones', () => {
    const starved: DockRegistry<'a', D, W> = {
      version: DOCK_SCHEMA_VERSION,
      dockedZoneIds: ['main', 'side'],
      windowZoneIds: ['x1', 'x2'],
      panels: [{ id: 'a', defaultZone: 'main' }],
    };
    const out = repairLayout({}, starved);
    expect(out.zones.main.panels).toEqual(['a']);
    expect(out.zones.side.panels).toEqual([]);
    expect(out.zones.side.active).toBe(''); // '' is the empty-zone encoding, not a lie
  });

  it('dockAllWindowZones folds a generic layout home and is then identity', () => {
    const torn = repair({ zones: { main: { panels: ['a'] }, x1: { panels: ['b', 'c'], origin: 'main' } } });
    const folded = dockAllWindowZones(torn, REG);
    expect(folded.zones.main.panels).toEqual(['a', 'b', 'c']);
    expect(folded.zones.x1.panels).toEqual([]);
    expect(dockAllWindowZones(folded, REG)).toBe(folded);
  });
});
