import { describe, it, expect, afterEach } from 'vitest';
import {
  DOCK_PANEL_IDS,
  DOCK_REGISTRY,
  DOCK_SCHEMA_VERSION,
  DOCK_ZONE_IDS,
  PANELS,
  PANEL_BY_ID,
  ROOM_DOCK_KEY,
  activePanel,
  defaultDockLayout,
  defaultLayout,
  loadDockLayout,
  parseDockLayout,
  repairDockLayout,
  repairLayout,
  resetDockLayout,
  saveDockLayout,
  setActivePanel,
  zoneOfPanel,
  zonePanels,
  type DockRegistry,
} from './dockModel';

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

const railOf = (l: ReturnType<typeof defaultDockLayout>) => l.zones.rail;

describe('the registry itself', () => {
  it('declares every panel exactly once, in a zone that exists', () => {
    const ids = PANELS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...DOCK_PANEL_IDS]);
    for (const p of PANELS) expect(DOCK_ZONE_IDS).toContain(p.defaultZone);
  });

  it('declares at least as many panels as zones — the ≥1-panel-per-zone invariant is otherwise unsatisfiable', () => {
    expect(PANELS.length).toBeGreaterThanOrEqual(DOCK_ZONE_IDS.length);
  });

  it('exposes label + icon metadata through PANEL_BY_ID', () => {
    expect(PANEL_BY_ID.voice.labelKey).toBe('rooms.voice.title');
    expect(PANEL_BY_ID.lan.labelKey).toBe('rooms.lan.title');
    expect(PANEL_BY_ID.people.labelKey).toBe('rooms.people');
    for (const id of DOCK_PANEL_IDS) expect(PANEL_BY_ID[id].icon).toBeTruthy();
  });

  it('marks the panels that must survive a tab switch (voice PTT, LAN failure latch)', () => {
    expect(PANEL_BY_ID.voice.keepAlive).toBe(true);
    expect(PANEL_BY_ID.lan.keepAlive).toBe(true);
    expect(PANEL_BY_ID.people.keepAlive).toBeFalsy();
  });

  it('P1 ships only the rail zone populated', () => {
    expect([...DOCK_ZONE_IDS]).toEqual(['rail']);
    expect(railOf(defaultDockLayout()).panels).toEqual(['voice', 'lan', 'people']);
  });
});

describe('defaults', () => {
  it('stamps the current schema version and activates the first panel', () => {
    const l = defaultDockLayout();
    expect(l.v).toBe(DOCK_SCHEMA_VERSION);
    expect(railOf(l).active).toBe('voice');
  });

  it('hands out a fresh object each call (state is held and replaced, never shared)', () => {
    const a = defaultDockLayout();
    const b = defaultDockLayout();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.zones.rail.panels).not.toBe(b.zones.rail.panels);
    a.zones.rail.panels.push('voice');
    expect(defaultDockLayout().zones.rail.panels).toEqual(['voice', 'lan', 'people']);
  });

  it('is repair-canonical: repairing the defaults changes nothing', () => {
    const d = defaultDockLayout();
    expect(repairDockLayout(d)).toEqual(d);
  });
});

describe('parseDockLayout — garbage in, valid layout out', () => {
  const defaults = defaultDockLayout();

  it('falls back to defaults for empty/absent text', () => {
    expect(parseDockLayout(null)).toEqual(defaults);
    expect(parseDockLayout(undefined)).toEqual(defaults);
    expect(parseDockLayout('')).toEqual(defaults);
  });

  it('falls back to defaults for text that is not JSON', () => {
    expect(parseDockLayout('{not json')).toEqual(defaults);
    expect(parseDockLayout('undefined')).toEqual(defaults);
  });

  it('falls back to defaults for JSON that parses to a scalar, null or array', () => {
    // JSON.parse succeeds on all of these; reading .zones off null would throw.
    for (const text of ['5', 'null', 'true', '"roomDock"', '[]', '[{"v":1}]']) {
      expect(parseDockLayout(text)).toEqual(defaults);
    }
  });

  it('DISCARDS an unrecognised schema version instead of migrating it', () => {
    const stale = JSON.stringify({ v: 99, zones: { rail: { panels: ['people'], active: 'people' } } });
    const out = parseDockLayout(stale);
    // If it had been repaired rather than discarded, 'people' would still lead.
    expect(out).toEqual(defaults);
    expect(out.zones.rail.panels[0]).toBe('voice');
  });

  it('discards a missing or wrongly-typed version stamp', () => {
    expect(parseDockLayout(JSON.stringify({ zones: { rail: { panels: ['lan'], active: 'lan' } } }))).toEqual(defaults);
    expect(parseDockLayout(JSON.stringify({ v: '1', zones: { rail: { panels: ['lan'], active: 'lan' } } }))).toEqual(defaults);
    expect(parseDockLayout(JSON.stringify({ v: null, zones: {} }))).toEqual(defaults);
  });

  it('accepts and repairs a blob at the current version', () => {
    const text = JSON.stringify({ v: DOCK_SCHEMA_VERSION, zones: { rail: { panels: ['people', 'voice', 'lan'], active: 'lan' } } });
    const out = parseDockLayout(text);
    expect(out.zones.rail.panels).toEqual(['people', 'voice', 'lan']);
    expect(out.zones.rail.active).toBe('lan');
  });
});

describe('repairDockLayout — validate and repair', () => {
  const rail = (panels: unknown, active?: unknown) =>
    repairDockLayout({ v: DOCK_SCHEMA_VERSION, zones: { rail: { panels, active } } }).zones.rail;

  it('drops unknown and non-string panel ids', () => {
    expect(rail(['voice', 'bogus', 42, null, { id: 'lan' }, ['people'], 'lan']).panels)
      .toEqual(['voice', 'lan', 'people']);
  });

  it('dedupes, keeping the first occurrence', () => {
    expect(rail(['people', 'voice', 'people', 'lan', 'voice']).panels)
      .toEqual(['people', 'voice', 'lan']);
  });

  it('re-adds missing known panels, in default order, after the ones it kept', () => {
    expect(rail(['people']).panels).toEqual(['people', 'voice', 'lan']);
    expect(rail(['lan']).panels).toEqual(['lan', 'voice', 'people']);
  });

  it('never leaves a zone empty — an empty panel list is refilled', () => {
    expect(rail([]).panels).toEqual(['voice', 'lan', 'people']);
    expect(rail(['bogus', 'alsoBogus']).panels).toEqual(['voice', 'lan', 'people']);
  });

  it('survives a zone that is missing, null, or not an object', () => {
    const defaults = defaultDockLayout();
    expect(repairDockLayout({ v: 1, zones: {} })).toEqual(defaults);
    expect(repairDockLayout({ v: 1, zones: { rail: null } })).toEqual(defaults);
    expect(repairDockLayout({ v: 1, zones: { rail: 'people' } })).toEqual(defaults);
    expect(repairDockLayout({ v: 1, zones: [] })).toEqual(defaults);
    expect(repairDockLayout({ v: 1 })).toEqual(defaults);
    expect(repairDockLayout(undefined)).toEqual(defaults);
    expect(repairDockLayout('nonsense')).toEqual(defaults);
  });

  it('drops unknown zone keys instead of carrying them along', () => {
    const out = repairDockLayout({ v: 1, zones: { rail: { panels: ['lan'], active: 'lan' }, ghost: { panels: ['voice'], active: 'voice' } } });
    expect(Object.keys(out.zones)).toEqual(['rail']);
    // 'voice' was only ever in the ghost zone, so it is re-added to its default zone.
    expect(out.zones.rail.panels).toEqual(['lan', 'voice', 'people']);
  });

  it('drops unknown top-level keys (field-by-field rebuild, never a spread)', () => {
    const out = repairDockLayout({ v: 1, zones: { rail: { panels: ['voice'], active: 'voice', junk: 1 } }, extra: 'nope' }) as unknown as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['v', 'zones']);
    expect(Object.keys((out.zones as any).rail).sort()).toEqual(['active', 'panels']);
  });

  it('repairs an active tab that is not in its zone', () => {
    expect(rail(['voice', 'lan', 'people'], 'ghost').active).toBe('voice');
    expect(rail(['people', 'voice', 'lan'], undefined).active).toBe('people');
    expect(rail(['voice', 'lan', 'people'], 7).active).toBe('voice');
    expect(rail([], 'ghost').active).toBe('voice'); // refilled zone, stale active
  });

  it('keeps an active tab that the refill brought back into the zone', () => {
    expect(rail([], 'lan').active).toBe('lan');
  });

  it('keeps a valid active tab', () => {
    expect(rail(['voice', 'lan', 'people'], 'people').active).toBe('people');
  });

  it('always stamps the current version, whatever the input claimed', () => {
    expect(repairDockLayout({ v: 4, zones: {} }).v).toBe(DOCK_SCHEMA_VERSION);
  });

  it('is idempotent', () => {
    for (const raw of [
      undefined,
      { v: 1, zones: { rail: { panels: ['people', 'people', 'nope'], active: 'nope' } } },
      { v: 1, zones: { rail: { panels: [] } } },
      { v: 1, zones: { rail: { panels: ['lan', 'voice'], active: 'voice' } } },
    ]) {
      const once = repairDockLayout(raw);
      expect(repairDockLayout(once)).toEqual(once);
      expect(repairDockLayout(JSON.parse(JSON.stringify(once)))).toEqual(once);
    }
  });
});

// The schema is generic over the panel/zone unions precisely so a later phase can
// add a zone and move panels between zones without a version bump. Prove the repair
// pass already behaves for that shape — including the branch P1's single zone can
// never reach: a zone emptied because the user moved everything out of it.
describe('multi-zone future (no schema break)', () => {
  type P = 'a' | 'b' | 'c';
  type Z = 'left' | 'right';
  const REG: DockRegistry<P, Z> = {
    version: DOCK_SCHEMA_VERSION,
    zoneIds: ['left', 'right'],
    panels: [
      { id: 'a', defaultZone: 'left' },
      { id: 'b', defaultZone: 'left' },
      { id: 'c', defaultZone: 'right' },
    ],
  };
  const repair = (raw: unknown) => repairLayout(raw, REG);

  it('places each panel in its default zone by default', () => {
    const d = defaultLayout(REG);
    expect(d.zones.left.panels).toEqual(['a', 'b']);
    expect(d.zones.right.panels).toEqual(['c']);
    expect(d.zones.left.active).toBe('a');
    expect(d.zones.right.active).toBe('c');
  });

  it('honours a panel the user moved to another zone', () => {
    const out = repair({ v: 1, zones: { left: { panels: ['a'], active: 'a' }, right: { panels: ['c', 'b'], active: 'b' } } });
    expect(out.zones.left.panels).toEqual(['a']);
    expect(out.zones.right.panels).toEqual(['c', 'b']);
    expect(out.zones.right.active).toBe('b');
  });

  it('dedupes a panel claimed by two zones, keeping the first zone in registry order', () => {
    const out = repair({ v: 1, zones: { left: { panels: ['a', 'c'] }, right: { panels: ['c', 'b'] } } });
    expect(out.zones.left.panels).toEqual(['a', 'c']);
    expect(out.zones.right.panels).toEqual(['b']);
  });

  it('refills a zone the user emptied, preferring a panel that defaults to that zone', () => {
    const out = repair({ v: 1, zones: { left: { panels: ['a', 'b', 'c'], active: 'a' }, right: { panels: [], active: 'a' } } });
    expect(out.zones.right.panels).toEqual(['c']); // 'c' defaults to right, so it comes home
    expect(out.zones.left.panels).toEqual(['a', 'b']);
    expect(out.zones.right.active).toBe('c'); // stale 'a' is not in this zone
    expect(out.zones.left.active).toBe('a');
  });

  it('refills a zone that has no default panels of its own from any donor that can spare one', () => {
    const noneOfItsOwn: DockRegistry<P, Z> = {
      ...REG,
      panels: [
        { id: 'a', defaultZone: 'right' },
        { id: 'b', defaultZone: 'right' },
        { id: 'c', defaultZone: 'right' },
      ],
    };
    const out = repairLayout({ v: 1, zones: { left: { panels: [] }, right: { panels: ['a', 'b', 'c'] } } }, noneOfItsOwn);
    expect(out.zones.left.panels).toEqual(['a']);
    expect(out.zones.right.panels).toEqual(['b', 'c']);
  });

  it('never empties the donor to fill someone else', () => {
    const out = repair({ v: 1, zones: { left: { panels: ['a'] }, right: { panels: ['b', 'c'] } } });
    expect(out.zones.left.panels.length).toBeGreaterThan(0);
    expect(out.zones.right.panels.length).toBeGreaterThan(0);
    expect([...out.zones.left.panels, ...out.zones.right.panels].sort()).toEqual(['a', 'b', 'c']);
  });

  it('degrades safely when a registry declares fewer panels than zones (a registry bug)', () => {
    const starved: DockRegistry<'a', Z> = {
      version: DOCK_SCHEMA_VERSION,
      zoneIds: ['left', 'right'],
      panels: [{ id: 'a', defaultZone: 'left' }],
    };
    const out = repairLayout({}, starved);
    expect(out.zones.left.panels).toEqual(['a']);
    expect(out.zones.right.panels).toEqual([]);
    // active must still hold a real panel id rather than undefined.
    expect(out.zones.right.active).toBe('a');
  });

  it('is idempotent across zones', () => {
    const once = repair({ v: 1, zones: { left: { panels: ['c', 'c', 'zzz'] }, right: { panels: [] } } });
    expect(repair(once)).toEqual(once);
  });
});

describe('persistence', () => {
  it('round-trips through localStorage', () => {
    const box = stubStorage(null);
    const l = setActivePanel(defaultDockLayout(), 'rail', 'people');
    saveDockLayout(l);
    expect(box.value).toBeTruthy();
    expect(JSON.parse(box.value!).v).toBe(DOCK_SCHEMA_VERSION);
    expect(loadDockLayout().zones.rail.active).toBe('people');
  });

  it('writes a canonical blob even when handed a damaged layout', () => {
    const box = stubStorage(null);
    saveDockLayout({ v: 0, zones: { rail: { panels: ['people', 'people'] as any, active: 'ghost' as any } } });
    const written = JSON.parse(box.value!);
    expect(written.v).toBe(DOCK_SCHEMA_VERSION);
    expect(written.zones.rail.panels).toEqual(['people', 'voice', 'lan']);
    expect(written.zones.rail.active).toBe('people');
  });

  it('swallows a storage write failure (private mode / quota)', () => {
    stubStorage(null, { throwOnSet: true });
    expect(() => saveDockLayout(defaultDockLayout())).not.toThrow();
  });

  it('returns defaults when storage holds junk, and when storage is absent entirely', () => {
    stubStorage('¯\\_(ツ)_/¯');
    expect(loadDockLayout()).toEqual(defaultDockLayout());
    delete (globalThis as any).localStorage; // no DOM at all
    expect(loadDockLayout()).toEqual(defaultDockLayout());
  });

  it('resetDockLayout drops the stored blob and returns defaults', () => {
    const box = stubStorage(JSON.stringify({ v: DOCK_SCHEMA_VERSION, zones: { rail: { panels: ['people'], active: 'people' } } }));
    const out = resetDockLayout();
    expect(out).toEqual(defaultDockLayout());
    expect(box.removed).toBe(true);
    expect(box.value).toBeNull();
    expect(loadDockLayout()).toEqual(defaultDockLayout());
  });

  it('resetDockLayout does not throw when storage is unavailable', () => {
    expect(() => resetDockLayout()).not.toThrow();
  });

  it('uses its own storage key so a corrupt dock blob cannot touch the splitter widths', () => {
    expect(ROOM_DOCK_KEY).not.toBe('roomLayout');
  });
});

describe('zone helpers', () => {
  const base = defaultDockLayout();

  it('reads panels and the active tab', () => {
    expect(zonePanels(base, 'rail')).toEqual(['voice', 'lan', 'people']);
    expect(activePanel(base, 'rail')).toBe('voice');
  });

  it('setActivePanel returns a new layout when the selection changes', () => {
    const next = setActivePanel(base, 'rail', 'lan');
    expect(next).not.toBe(base);
    expect(next.zones.rail.active).toBe('lan');
    expect(base.zones.rail.active).toBe('voice'); // input untouched
    expect(next.zones.rail.panels).toEqual(base.zones.rail.panels);
  });

  it('setActivePanel is a no-op (same reference) when nothing would change', () => {
    expect(setActivePanel(base, 'rail', 'voice')).toBe(base);
  });

  it('setActivePanel refuses a panel that does not live in that zone', () => {
    const stripped = repairLayout({ v: 1, zones: { rail: { panels: ['voice'], active: 'voice' } } }, {
      ...DOCK_REGISTRY,
      panels: PANELS.filter((p) => p.id !== 'people'),
    });
    expect(stripped.zones.rail.panels).not.toContain('people');
    expect(setActivePanel(stripped, 'rail', 'people')).toBe(stripped);
  });

  it('zoneOfPanel finds the zone holding a panel (head-bar chips deep-link by panel)', () => {
    expect(zoneOfPanel(base, 'lan')).toBe('rail');
    expect(zoneOfPanel(base, 'people')).toBe('rail');
  });
});
