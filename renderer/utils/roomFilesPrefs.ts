/**
 * Files-panel preferences — per-install (localStorage), all clamped on load.
 * Global view prefs (density / reactions / type icons) plus two per-room maps:
 * the preferred sort and the set of collapsed folders.
 */
export type RoomFilesDensity = 'cozy' | 'compact';
export type RoomFilesPrefs = {
  density: RoomFilesDensity;
  showReactions: boolean;
  typeIcons: boolean;
};

const PREFS_KEY = 'roomFilesPrefs';
const SORT_KEY = 'roomFilesSort';
const COLLAPSED_KEY = 'roomFolderCollapsed';

const readJson = (key: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* defaults */ }
  return {};
};

export function loadRoomFilesPrefs(): RoomFilesPrefs {
  const p = readJson(PREFS_KEY);
  return {
    density: p.density === 'compact' ? 'compact' : 'cozy',
    showReactions: p.showReactions !== false,
    typeIcons: p.typeIcons !== false,
  };
}

export function saveRoomFilesPrefs(p: RoomFilesPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export type RoomFilesSortKey = 'added' | 'name' | 'size' | 'status';
export type RoomFilesSortDir = 'asc' | 'desc';

/** Each key's natural direction — what the pre-direction UI always showed. */
export const SORT_NATURAL_DIR: Record<RoomFilesSortKey, RoomFilesSortDir> = {
  added: 'desc', name: 'asc', size: 'desc', status: 'asc',
};

export function loadRoomSort(roomId: string): RoomFilesSortKey {
  const all = readJson(SORT_KEY);
  const v = all[roomId];
  return v === 'name' || v === 'size' || v === 'status' ? v : 'added';
}

export function saveRoomSort(roomId: string, sort: RoomFilesSortKey): void {
  const all = readJson(SORT_KEY);
  all[roomId] = sort;
  try { localStorage.setItem(SORT_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

const SORT_DIR_KEY = 'roomFilesSortDir';

/** Per-room direction; defaults to the current sort key's natural direction. */
export function loadRoomSortDir(roomId: string, key: RoomFilesSortKey): RoomFilesSortDir {
  const all = readJson(SORT_DIR_KEY);
  const v = all[roomId];
  return v === 'asc' || v === 'desc' ? v : SORT_NATURAL_DIR[key];
}

export function saveRoomSortDir(roomId: string, dir: RoomFilesSortDir): void {
  const all = readJson(SORT_DIR_KEY);
  all[roomId] = dir;
  try { localStorage.setItem(SORT_DIR_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

export function loadCollapsedFolders(roomId: string): Set<string> {
  const all = readJson(COLLAPSED_KEY);
  const v = all[roomId];
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
}

export function saveCollapsedFolders(roomId: string, collapsed: Set<string>): void {
  const all = readJson(COLLAPSED_KEY);
  all[roomId] = Array.from(collapsed);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

/** Drop a left room's entries from the per-room maps (they'd accrue forever). */
export function clearRoomFilesPrefs(roomId: string): void {
  for (const key of [SORT_KEY, SORT_DIR_KEY, COLLAPSED_KEY]) {
    const all = readJson(key);
    if (roomId in all) {
      delete all[roomId];
      try { localStorage.setItem(key, JSON.stringify(all)); } catch { /* ignore */ }
    }
  }
}
