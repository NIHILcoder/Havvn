/** One catalog of page identities for the rail, palette and preferences. */
export const NAVIGATION_PAGES = [
  { id: 'events', labelKey: 'events.title', icon: 'bell' },
  { id: 'downloads', labelKey: 'nav.downloads', icon: 'download' },
  { id: 'rooms', labelKey: 'nav.rooms', icon: 'users' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'settings' },
  { id: 'search', labelKey: 'nav.search', icon: 'search' },
  { id: 'create-torrent', labelKey: 'nav.create', icon: 'file-plus' },
  { id: 'rss', labelKey: 'rss.title', icon: 'rss' },
  { id: 'swarm', labelKey: 'nav.swarm', icon: 'globe' },
  { id: 'watch-history', labelKey: 'library.title', icon: 'film' },
] as const;
export type NavigationPage = typeof NAVIGATION_PAGES[number]['id'];
export const UTILITY_PAGES = ['events', 'search', 'rss', 'create-torrent', 'swarm'] as const;
export type UtilityPage = typeof UTILITY_PAGES[number];
export const NAVIGATION_KEY = 'havvn.navigation.v1';
export const FAVORITES_LIMIT = 32;
export const NAVIGATION_MAX_CHARS = 64 * 1024;
export interface NavigationFavorite { kind: 'command' | 'room' | 'view'; id: string }
export interface NavigationPreferences {
  version: 1;
  utilities: Array<{ id: UtilityPage; visible: boolean }>;
  showHistory: boolean;
  favorites: NavigationFavorite[];
}
export const defaultNavigation = (): NavigationPreferences => ({ version: 1, utilities: UTILITY_PAGES.map(id => ({ id, visible: true })), showHistory: true, favorites: [] });
export type NavigationErrorCode = 'invalid' | 'storage' | 'limit' | 'missing';
export class NavigationError extends Error {
  constructor(readonly code: NavigationErrorCode) { super(`Navigation: ${code}`); }
}
export const favoriteKey = (favorite: NavigationFavorite): string => `${favorite.kind}:${favorite.id}`;
export const favoriteCommandId = (favorite: NavigationFavorite): string => favorite.kind === 'room' ? `room:${favorite.id}` : favorite.kind === 'view' ? `download-view:${favorite.id}` : favorite.id;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function validateFavorite(input: unknown): NavigationFavorite {
  if (!object(input) || Object.keys(input).some(key => key !== 'kind' && key !== 'id')
    || !['command', 'room', 'view'].includes(String(input.kind)) || typeof input.id !== 'string'
    || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(input.id) || ['__proto__', 'constructor', 'prototype'].includes(input.id)
    || (input.kind !== 'command' && !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id))) throw new NavigationError('invalid');
  return { kind: input.kind as NavigationFavorite['kind'], id: input.id };
}
export function validateNavigation(input: unknown): NavigationPreferences {
  if (!object(input) || input.version !== 1 || Object.keys(input).some(key => !['version', 'utilities', 'showHistory', 'favorites'].includes(key))
    || !Array.isArray(input.utilities) || input.utilities.length > UTILITY_PAGES.length || typeof input.showHistory !== 'boolean'
    || !Array.isArray(input.favorites) || input.favorites.length > FAVORITES_LIMIT) throw new NavigationError('invalid');
  const seen = new Set<string>();
  const utilities = input.utilities.map(item => {
    if (!object(item) || Object.keys(item).some(key => key !== 'id' && key !== 'visible')
      || !UTILITY_PAGES.includes(item.id as UtilityPage) || seen.has(String(item.id)) || typeof item.visible !== 'boolean') throw new NavigationError('invalid');
    seen.add(String(item.id)); return { id: item.id as UtilityPage, visible: item.visible };
  });
  // Future additions to the catalog get their default slot without dropping user order.
  utilities.push(...UTILITY_PAGES.filter(id => !seen.has(id)).map(id => ({ id, visible: true })));
  const favorites = input.favorites.map(validateFavorite), favoriteIds = favorites.map(favoriteKey);
  if (new Set(favoriteIds).size !== favoriteIds.length) throw new NavigationError('invalid');
  return { version: 1, utilities, showHistory: input.showHistory, favorites };
}
