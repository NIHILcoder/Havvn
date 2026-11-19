import { PANELS_KEY, WORKING_PROFILES_KEY, WORKING_PROFILES_LIMIT, WORKING_PROFILES_MAX_CHARS, WorkingProfileError,
  defaultPanels, emptyWorkingProfiles, validatePanels, validateWorkingProfile, validateWorkingProfiles,
  type PanelVisibility, type WorkingValues, type WorkingProfiles } from '../../shared/working-profile-schema';

export function createWorkingProfilesState(storage: () => Pick<Storage, 'getItem' | 'setItem'>, uuid: () => string) {
  let snapshot = { catalog: emptyWorkingProfiles(), panels: defaultPanels(), error: false }, loaded = false;
  const listeners = new Set<() => void>(), publish = () => listeners.forEach(listener => listener());
  function readCatalog() {
    const raw = storage().getItem(WORKING_PROFILES_KEY);
    if (raw !== null && raw.length > WORKING_PROFILES_MAX_CHARS) throw new WorkingProfileError('invalid');
    return raw === null ? emptyWorkingProfiles() : validateWorkingProfiles(JSON.parse(raw));
  }
  function readPanels() { const raw = storage().getItem(PANELS_KEY); return raw === null ? defaultPanels() : validatePanels(JSON.parse(raw)); }
  function refresh() {
    let next: typeof snapshot;
    try { next = { catalog: readCatalog(), panels: readPanels(), error: false }; } catch { next = { ...snapshot, error: true }; }
    loaded = true;
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) { snapshot = next; publish(); }
  }
  const getSnapshot = () => { if (!loaded) refresh(); return snapshot; };
  function write(key: string, value: unknown) {
    const encoded = JSON.stringify(value);
    if (key === WORKING_PROFILES_KEY && encoded.length > WORKING_PROFILES_MAX_CHARS) throw new WorkingProfileError('limit');
    try { storage().setItem(key, encoded); if (storage().getItem(key) !== encoded) throw Error('Not retained'); }
    catch { throw new WorkingProfileError('storage'); }
    refresh();
  }
  function change(update: (catalog: WorkingProfiles) => WorkingProfiles) {
    let current: WorkingProfiles;
    try { current = readCatalog(); } catch { refresh(); throw new WorkingProfileError('storage'); }
    write(WORKING_PROFILES_KEY, validateWorkingProfiles(update(current)));
  }
  function save(name: string, values: WorkingValues, existingId?: string) {
    name = name.trim(); if (!name || name.length > 60) throw new WorkingProfileError('name');
    const profile = validateWorkingProfile({ id: existingId ?? uuid(), name, values });
    change(current => {
      if (existingId && !current.profiles.some(p => p.id === existingId)) throw new WorkingProfileError('missing');
      if (current.profiles.some(p => p.id !== existingId && p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new WorkingProfileError('duplicate');
      if (!existingId && current.profiles.length >= WORKING_PROFILES_LIMIT) throw new WorkingProfileError('limit');
      return { ...current, profiles: existingId ? current.profiles.map(p => p.id === existingId ? profile : p) : [...current.profiles, profile] };
    });
    return profile.id;
  }
  return {
    getSnapshot, refresh, save,
    recover() {
      let { catalog, panels } = getSnapshot();
      try { catalog = readCatalog(); } catch { /* Explicitly retain the last readable catalog. */ }
      try { panels = readPanels(); } catch { /* Explicitly retain the last readable visibility. */ }
      write(WORKING_PROFILES_KEY, validateWorkingProfiles(catalog)); write(PANELS_KEY, validatePanels(panels));
      if (getSnapshot().error) throw new WorkingProfileError('storage');
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    duplicate(id: string, name: string) {
      const profile = readCatalog().profiles.find(p => p.id === id); if (!profile) throw new WorkingProfileError('missing');
      return save(name, profile.values);
    },
    remove(id: string) { change(current => ({ ...current, profiles: current.profiles.filter(p => p.id !== id), activeId: current.activeId === id ? null : current.activeId })); },
    repairPreviousView() { change(current => {
      if (!current.previous) throw new WorkingProfileError('missing');
      return { ...current, previous: { ...current.previous, values: { ...current.previous.values, viewId: null } } };
    }); },
    setPanel(key: keyof PanelVisibility, value: boolean) { write(PANELS_KEY, validatePanels({ ...readPanels(), [key]: value })); },
  };
}
