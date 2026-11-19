import { describe, expect, it, vi } from 'vitest';
import { createWorkingProfilesState } from './working-profiles-state';
import { WORKING_PROFILES_KEY, emptyWorkingProfiles, readProfileNotifications, type WorkingValues } from '../../shared/working-profile-schema';
import type { AppSettings } from '../../shared/types';
const values = (): WorkingValues => ({ startPage: 'downloads', viewId: null, panels: { sidebar: true, statusBar: true }, appearanceName: null, notifications: readProfileNotifications({} as AppSettings) });
function fixture() {
  const data = new Map<string, string>(); let sequence = 0;
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
  const create = () => createWorkingProfilesState(() => storage, () => `p${++sequence}`);
  return { data, storage, create, state: create() };
}
describe('working profile catalog persistence', () => {
  it('loads without executing/saving, persists edits across instances and duplicates the saved snapshot', () => {
    const f = fixture(), initial = f.state.getSnapshot(); f.state.refresh(); expect(f.state.getSnapshot()).toBe(initial); expect(f.storage.setItem).not.toHaveBeenCalled();
    const id = f.state.save('Cinema', values()); const copy = f.state.duplicate(id, 'Copy');
    const after = f.create().getSnapshot(); expect(after.catalog.profiles).toHaveLength(2); expect(after.catalog.activeId).toBeNull();
    expect(after.catalog.profiles[1]).toEqual({ id: copy, name: 'Copy', values: values() });
  });
  it('rereads another window before edits and preserves the current application checkpoint', () => {
    const f = fixture(), other = f.create(); other.getSnapshot();
    const id = f.state.save('First', values()); other.save('Second', values());
    f.state.save('Updated', { ...values(), startPage: 'rooms' }, id);
    expect(f.state.getSnapshot().catalog.profiles.map(p => p.name)).toEqual(['Updated', 'Second']);
    f.state.setPanel('sidebar', false); expect(f.create().getSnapshot().panels.sidebar).toBe(false);
  });
  it('does not claim success or publish when a storage write is not retained', () => {
    const f = fixture(), initial = f.state.getSnapshot(), listener = vi.fn(); f.state.subscribe(listener); f.storage.setItem.mockImplementation(() => {});
    expect(() => f.state.save('Cinema', values())).toThrow('storage'); expect(f.state.getSnapshot()).toBe(initial); expect(listener).not.toHaveBeenCalled();
  });
  it('keeps invalid storage and the last good snapshot instead of overwriting them', () => {
    const f = fixture(); f.state.save('Cinema', values()); f.data.set(WORKING_PROFILES_KEY, '{invalid'); f.state.refresh();
    expect(f.state.getSnapshot().error).toBe(true); expect(f.state.getSnapshot().catalog.profiles[0].name).toBe('Cinema');
    expect(() => f.state.save('New', values())).toThrow('storage'); expect(f.data.get(WORKING_PROFILES_KEY)).toBe('{invalid');
    f.state.recover(); expect(f.state.getSnapshot().error).toBe(false); expect(f.state.getSnapshot().catalog.profiles[0].name).toBe('Cinema');
  });
  it('rejects duplicate names and obsolete IDs, then removes only the selected profile', () => {
    const f = fixture(), id = f.state.save('Cinema', values());
    expect(() => f.state.save('cinema', values())).toThrow('duplicate'); expect(() => f.state.save('A', values(), 'missing')).toThrow('missing');
    f.state.remove(id); expect(f.state.getSnapshot().catalog).toEqual(emptyWorkingProfiles());
  });
  it('repairs only an unavailable view in the return point after explicit user action', () => {
    const f = fixture(), appearance = { version: 1, name: 'Checkpoint', appearance: {
      version: 1, material: 'solid', acrylic: false, nativeMaterial: 'acrylic', intensity: 55, opacity: 78, blur: 22, tint: 8, highlight: 35, depth: 25,
      quality: 'full', motion: true, scopes: ['sidebar'], background: 'none', wallpaper: '', backgroundDim: 30, radii: { panels: null, cards: null, buttons: null, inputs: null },
    }, theme: null, mode: 'dark', accent: null, font: 'inter', density: 'normal', reduceMotion: false };
    f.data.set(WORKING_PROFILES_KEY, JSON.stringify({ ...emptyWorkingProfiles(), previous: { activeId: null, values: { ...values(), viewId: 'deleted' }, appearance } }));
    f.state.refresh(); f.state.repairPreviousView();
    expect(f.state.getSnapshot().catalog.previous).toEqual({ activeId: null, values: values(), appearance });
  });
});
