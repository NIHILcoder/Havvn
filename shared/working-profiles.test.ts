import { describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE } from './appearance';
import { DEFAULT_VIEW_CONFIG, DOWNLOAD_VIEWS_KEY } from './download-views';
import { captureInterfacePreferences, selectInterfacePreferences, validateInterfacePreferences } from './interface-preferences';
import { captureWorkingState, planWorkingProfile, resolveWorkingAppearance, workingCatalog, workingDifferences } from './working-profiles';
import { PANELS_KEY, WORKING_PROFILES_KEY, defaultPanels, emptyWorkingProfiles, readProfileNotifications, validatePanels, validateWorkingProfiles, type WorkingValues } from './working-profile-schema';
import type { AppSettings } from './types';

const notifications = readProfileNotifications({} as AppSettings);
const values = (): WorkingValues => ({ startPage: 'rooms', viewId: 'v1', panels: { sidebar: false, statusBar: false }, appearanceName: 'Blue',
  notifications: { ...notifications, enableSounds: false } });
const appearance = () => ({ version: 1, name: 'Blue', appearance: { ...DEFAULT_APPEARANCE, radii: { panels: 12, cards: 12, buttons: 16, inputs: 12 } },
  theme: null, mode: 'light', accent: '#123456', font: 'inter', density: 'compact', reduceMotion: true });
function preferences() {
  const stored: Record<string, string> = { startPage: 'downloads', hotkeys: '[]', language: 'ru',
    [WORKING_PROFILES_KEY]: JSON.stringify({ ...emptyWorkingProfiles(), profiles: [{ id: 'p1', name: 'Cinema', values: values() }] }),
    [DOWNLOAD_VIEWS_KEY]: JSON.stringify({ version: 1, views: [{ ...DEFAULT_VIEW_CONFIG, id: 'v1', name: 'Films', pinned: true }], activeId: null }),
    'havvn.appearance.profiles.v1': JSON.stringify([appearance()]),
  };
  return captureInterfacePreferences({ getItem: key => stored[key] ?? null });
}
describe('working profiles and preview projection', () => {
  it('projects only owned UI preferences and records an exact single return checkpoint', () => {
    const before = preferences(), original = structuredClone(before), result = planWorkingProfile(before, notifications, 'p1', 'work-new');
    expect(before).toEqual(original); expect(result.request.expected).toEqual(original);
    expect(result.differences).toEqual(['startPage', 'viewId', 'panels', 'notifications', 'appearance']);
    expect(result.preferences.values.startPage).toBe('rooms'); expect(result.preferences.values.hotkeys).toBe('[]'); expect(result.preferences.values.language).toBe('ru');
    expect(JSON.parse(result.preferences.values[PANELS_KEY]!)).toEqual({ sidebar: false, statusBar: false });
    expect(JSON.parse(result.preferences.values[DOWNLOAD_VIEWS_KEY]!).views).toEqual(JSON.parse(before.values[DOWNLOAD_VIEWS_KEY]!).views);
    const catalog = workingCatalog(result.preferences);
    expect(catalog.activeId).toBe('p1'); expect(catalog.previous).toEqual(captureWorkingState(before, notifications));
    const undo = planWorkingProfile(result.preferences, result.after.values.notifications, null, 'work-return');
    expect(undo.after.values.startPage).toBe('downloads'); expect(undo.after.values.viewId).toBeNull(); expect(undo.after.values.panels).toEqual(defaultPanels());
    expect(undo.after.values.notifications).toEqual(notifications); expect(undo.after.appearance).toEqual(result.before.appearance);
    expect(workingCatalog(undo.preferences).previous!.activeId).toBe('p1');
  });
  it('keeps appearance when no link is selected, detects manual changes and never auto-applies on import', () => {
    const before = preferences(), catalog = workingCatalog(before); catalog.profiles[0].values.appearanceName = null;
    before.values[WORKING_PROFILES_KEY] = JSON.stringify(catalog);
    const applied = planWorkingProfile(before, notifications, 'p1', 'work-new');
    expect(applied.preferences.values.theme).toBe(before.values.theme);
    const current = captureWorkingState(applied.preferences, applied.after.values.notifications);
    expect(workingDifferences(current, catalog.profiles[0].values, null)).toEqual([]);
    current.values.panels.sidebar = true;
    expect(workingDifferences(current, catalog.profiles[0].values, null)).toEqual(['panels']);
    const incoming = selectInterfacePreferences(before, applied.preferences, ['hotkeys']);
    expect(incoming.values[PANELS_KEY]).toBeNull(); expect(incoming.values[WORKING_PROFILES_KEY]).toBe(before.values[WORKING_PROFILES_KEY]);
  });
  it('preserves references through layout transfer and keeps older snapshots from erasing new catalogs', () => {
    const source = preferences(), blank = captureInterfacePreferences({ getItem: () => null });
    const imported = selectInterfacePreferences(blank, source, ['layout', 'appearance']);
    expect(workingCatalog(imported).profiles[0].values.viewId).toBe('v1');
    expect(resolveWorkingAppearance(imported, values())?.name).toBe('Blue');
    const legacy = structuredClone(blank); delete legacy.values[WORKING_PROFILES_KEY]; delete legacy.values[PANELS_KEY];
    const kept = selectInterfacePreferences(source, validateInterfacePreferences(legacy), ['layout']);
    expect(kept.values[WORKING_PROFILES_KEY]).toBe(source.values[WORKING_PROFILES_KEY]);
  });
  it('refuses missing views or appearances without modifying the source', () => {
    for (const key of [DOWNLOAD_VIEWS_KEY, 'havvn.appearance.profiles.v1'] as const) {
      const before = preferences(); before.values[key] = null;
      const original = structuredClone(before);
      expect(() => planWorkingProfile(before, notifications, 'p1', 'work-new')).toThrow('missing'); expect(before).toEqual(original);
    }
  });
  it('transfers saved profiles but clears the local return checkpoint and its embedded appearance', () => {
    const before = preferences(), applied = planWorkingProfile(before, notifications, 'p1', 'work-new');
    expect(workingCatalog(applied.preferences).previous).not.toBeNull();
    const imported = selectInterfacePreferences(before, applied.preferences, ['layout']);
    expect(workingCatalog(imported).previous).toBeNull(); expect(workingCatalog(imported).profiles).toEqual(workingCatalog(applied.preferences).profiles);
    expect(workingCatalog(selectInterfacePreferences(applied.preferences, before, ['hotkeys'])).previous).not.toBeNull();
  });
  it('never overwrites an existing theme ID and compares the resulting appearance independently of identity', () => {
    const before = preferences(), catalog = JSON.parse(before.values['havvn.appearance.profiles.v1']!);
    catalog[0].theme = { id: 'same-id', name: 'Blue', dark: { '--color-bg-primary': '#112233' }, light: {} };
    before.values['havvn.appearance.profiles.v1'] = JSON.stringify(catalog);
    before.values['havvn.theme.library'] = JSON.stringify([{ id: 'same-id', name: 'Existing', dark: {}, light: {} }]);
    const result = planWorkingProfile(before, notifications, 'p1', 'work-new');
    const library = JSON.parse(result.preferences.values['havvn.theme.library']!);
    expect(library[0].name).toBe('Existing'); expect(library[1].id).toBe('work-new');
    expect(workingDifferences(captureWorkingState(result.preferences, result.after.values.notifications), values(), resolveWorkingAppearance(result.preferences, values()))).toEqual([]);
  });
  it.each([
    { version: 2 }, { profiles: [{ id: 'p1', name: 'A', values: { ...values(), maxDownKbps: 5 } }] },
    { profiles: [{ id: 'p1', name: 'A', values: values() }, { id: 'p2', name: 'a', values: values() }] },
    { profiles: [{ id: '__proto__', name: 'A', values: values() }] },
    { profiles: [{ id: 'p1', name: 'A', values: { ...values(), viewId: 'havvn://join/secret' } }] },
    { profiles: [{ id: 'p1', name: 'A', values: { ...values(), notifications: { ...notifications, proxyPassword: 'secret' } } }] },
    { profiles: Array.from({ length: 17 }, (_, i) => ({ id: `p${i}`, name: String(i), values: values() })) },
    { activeId: 'missing' }, { previous: { activeId: null, values: values(), appearance: { version: 99 } } },
  ])('rejects non-profile fields and invalid catalogs %#', patch => {
    expect(() => validateWorkingProfiles({ ...emptyWorkingProfiles(), ...patch })).toThrow();
  });
  it('never allows hiding the title bar or storing a room/action in panel preferences', () => {
    expect(() => validatePanels({ ...defaultPanels(), titlebar: false })).toThrow();
    expect(() => validatePanels({ sidebar: true, statusBar: 'yes' })).toThrow();
  });
});
