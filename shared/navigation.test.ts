import { describe, expect, it } from 'vitest';
import { defaultNavigation, favoriteCommandId, favoriteKey, validateFavorite, validateNavigation, FAVORITES_LIMIT, UTILITY_PAGES } from './navigation';

describe('portable navigation schema', () => {
  it('keeps the existing menu by default and fills new slots after saved ones', () => {
    expect(defaultNavigation().utilities.map(item => item.id)).toEqual([...UTILITY_PAGES]);
    const value = validateNavigation({ ...defaultNavigation(), utilities: [{ id: 'rss', visible: false }] });
    expect(value.utilities[0]).toEqual({ id: 'rss', visible: false });
    expect(value.utilities.map(item => item.id)).toEqual(['rss', 'events', 'search', 'create-torrent', 'swarm']);
    expect(value.showHistory).toBe(true);
  });
  it('stores references without titles, paths or executable payloads', () => {
    const favorites = [{ kind: 'room', id: 'r1' }, { kind: 'view', id: 'v1' }, { kind: 'command', id: 'future-command' }] as const;
    const checked = validateNavigation({ ...defaultNavigation(), favorites });
    expect(checked.favorites.map(favoriteCommandId)).toEqual(['room:r1', 'download-view:v1', 'future-command']);
    expect(checked.favorites.map(favoriteKey)).toEqual(['room:r1', 'view:v1', 'command:future-command']);
  });
  it.each([
    { version: 2 }, { showHistory: 'true' }, { unexpected: true },
    { utilities: [{ id: 'settings', visible: true }] },
    { utilities: [{ id: 'search', visible: true }, { id: 'search', visible: false }] },
    { utilities: [{ id: 'search', visible: 1 }] },
    { favorites: [{ kind: 'room', id: 'r1' }, { kind: 'room', id: 'r1' }] },
    { favorites: Array.from({ length: FAVORITES_LIMIT + 1 }, (_, id) => ({ kind: 'view', id: String(id) })) },
  ])('rejects malformed configuration %#', patch => {
    expect(() => validateNavigation({ ...defaultNavigation(), ...patch })).toThrow();
  });
  it.each([
    { kind: 'command', id: 'https://example.test' }, { kind: 'room', id: '../secret' },
    { kind: 'command', id: '__proto__' }, { kind: 'command', id: 'constructor' },
    { kind: 'view', id: 'v1', name: 'Imported' }, { kind: 'folder', id: 'x' },
    { kind: 'command', id: 'x', run: 'pauseAll' }, { kind: 'command', id: 'x'.repeat(201) },
  ])('rejects unsafe or non-reference favorites %#', value => {
    expect(() => validateFavorite(value)).toThrow();
  });
});
