import { NAVIGATION_KEY, NAVIGATION_MAX_CHARS, FAVORITES_LIMIT, NavigationError, defaultNavigation, favoriteKey, validateFavorite, validateNavigation,
  type NavigationFavorite, type NavigationPreferences, type UtilityPage } from '../../shared/navigation';

/** No actions run when preferences load. Writes publish only after storage confirms them. */
export function createNavigationState(storage: () => Pick<Storage, 'getItem' | 'setItem'>) {
  let snapshot = { preferences: defaultNavigation(), error: false }, loaded = false;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(listener => listener());
  const read = (): NavigationPreferences => {
    const raw = storage().getItem(NAVIGATION_KEY);
    if (raw !== null && raw.length > NAVIGATION_MAX_CHARS) throw new NavigationError('invalid');
    return raw === null ? defaultNavigation() : validateNavigation(JSON.parse(raw));
  };
  const refresh = () => {
    let next: typeof snapshot;
    try { next = { preferences: read(), error: false }; } catch { next = { ...snapshot, error: true }; }
    loaded = true;
    if (JSON.stringify(snapshot) !== JSON.stringify(next)) { snapshot = next; publish(); }
  };
  const getSnapshot = () => { if (!loaded) refresh(); return snapshot; };
  const commit = (next: NavigationPreferences) => {
    const checked = validateNavigation(next), encoded = JSON.stringify(checked);
    try {
      storage().setItem(NAVIGATION_KEY, encoded);
      if (storage().getItem(NAVIGATION_KEY) !== encoded) throw new Error('Write not retained');
    } catch { throw new NavigationError('storage'); }
    snapshot = { preferences: checked, error: false }; loaded = true; publish();
  };
  const change = (update: (current: NavigationPreferences) => NavigationPreferences) => {
    let current: NavigationPreferences;
    try { current = read(); } catch { refresh(); throw new NavigationError('storage'); }
    commit(update(current));
  };
  const move = <T,>(items: T[], match: (item: T) => boolean, direction: -1 | 1): T[] => {
    const index = items.findIndex(match); if (index < 0) throw new NavigationError('missing');
    const nextIndex = index + direction; if (nextIndex < 0 || nextIndex >= items.length) return items;
    const next = [...items]; [next[index], next[nextIndex]] = [next[nextIndex], next[index]]; return next;
  };
  return {
    getSnapshot, refresh,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setVisible(id: UtilityPage, visible: boolean) { change(current => ({ ...current, utilities: current.utilities.map(item => item.id === id ? { ...item, visible } : item) })); },
    moveUtility(id: UtilityPage, direction: -1 | 1) { change(current => ({ ...current, utilities: move(current.utilities, item => item.id === id, direction) })); },
    showHistory(visible: boolean) { change(current => ({ ...current, showHistory: visible })); },
    add(input: NavigationFavorite) {
      const favorite = validateFavorite(input);
      change(current => {
        if (current.favorites.some(item => favoriteKey(item) === favoriteKey(favorite))) return current;
        if (current.favorites.length >= FAVORITES_LIMIT) throw new NavigationError('limit');
        return { ...current, favorites: [...current.favorites, favorite] };
      });
    },
    remove(key: string) { change(current => ({ ...current, favorites: current.favorites.filter(item => favoriteKey(item) !== key) })); },
    moveFavorite(key: string, direction: -1 | 1) { change(current => ({ ...current, favorites: move(current.favorites, item => favoriteKey(item) === key, direction) })); },
    resetMenu() {
      // Explicit recovery also works if the current on-disk preference is unreadable.
      let favorites = getSnapshot().preferences.favorites;
      try { favorites = read().favorites; } catch { /* Preserve the last readable snapshot. */ }
      commit({ ...defaultNavigation(), favorites });
    },
  };
}
