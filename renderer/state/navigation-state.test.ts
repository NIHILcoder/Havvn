import { describe, expect, it, vi } from 'vitest';
import { createNavigationState } from './navigation-state';
import { defaultNavigation, NAVIGATION_KEY, FAVORITES_LIMIT } from '../../shared/navigation';

function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
  return { data, storage, state: createNavigationState(() => storage) };
}
describe('navigation persistence', () => {
  it('loads without writes or actions, keeps stable snapshots and rehydrates the chosen order', () => {
    const f = fixture(), before = f.state.getSnapshot();
    f.state.refresh(); expect(f.state.getSnapshot()).toBe(before);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    f.state.moveUtility('rss', -1); f.state.setVisible('search', false); f.state.showHistory(false);
    f.state.add({ kind: 'view', id: 'v1' });
    const next = createNavigationState(() => f.storage).getSnapshot();
    expect(next).toEqual(f.state.getSnapshot());
    expect(next.preferences.utilities.slice(0, 3)).toEqual([{ id: 'events', visible: true }, { id: 'rss', visible: true }, { id: 'search', visible: false }]);
    expect(next.preferences.showHistory).toBe(false);
  });
  it('does not publish success when a write throws or silently disappears', () => {
    for (const silent of [true, false]) {
      const f = fixture(), before = f.state.getSnapshot(), listener = vi.fn(); f.state.subscribe(listener);
      f.storage.setItem.mockImplementation(() => { if (!silent) throw Error('quota'); });
      expect(() => f.state.add({ kind: 'room', id: 'r1' })).toThrow('storage');
      expect(f.state.getSnapshot()).toBe(before); expect(listener).not.toHaveBeenCalled();
    }
  });
  it('merges each intent with the latest storage written by another window', () => {
    const f = fixture(), other = createNavigationState(() => f.storage);
    f.state.getSnapshot(); other.getSnapshot();
    f.state.add({ kind: 'room', id: 'r1' }); other.setVisible('rss', false);
    f.state.add({ kind: 'command', id: 'open-search' }); other.moveFavorite('command:open-search', -1);
    f.state.refresh();
    expect(f.state.getSnapshot().preferences.favorites.map(item => item.id)).toEqual(['open-search', 'r1']);
    expect(f.state.getSnapshot().preferences.utilities.find(item => item.id === 'rss')!.visible).toBe(false);
    f.state.resetMenu();
    expect(f.state.getSnapshot().preferences).toEqual({ ...defaultNavigation(), favorites: other.getSnapshot().preferences.favorites });
  });
  it('keeps the last readable state after corruption and recovers only on explicit reset', () => {
    const f = fixture(); f.state.add({ kind: 'room', id: 'r1' }); f.state.setVisible('rss', false);
    f.data.set(NAVIGATION_KEY, '{broken'); f.state.refresh();
    expect(f.state.getSnapshot().error).toBe(true);
    expect(f.state.getSnapshot().preferences.favorites[0].id).toBe('r1');
    expect(() => f.state.showHistory(false)).toThrow('storage');
    expect(f.data.get(NAVIGATION_KEY)).toBe('{broken');
    f.state.resetMenu();
    expect(f.state.getSnapshot()).toEqual({ error: false, preferences: { ...defaultNavigation(), favorites: [{ kind: 'room', id: 'r1' }] } });
  });
  it('deduplicates favorites, bounds their count and removes missing references independently', () => {
    const f = fixture();
    f.state.add({ kind: 'command', id: 'unavailable' }); f.state.add({ kind: 'command', id: 'unavailable' });
    expect(f.state.getSnapshot().preferences.favorites).toHaveLength(1);
    f.state.remove('command:unavailable');
    for (let i = 0; i < FAVORITES_LIMIT; i++) f.state.add({ kind: 'view', id: String(i) });
    expect(() => f.state.add({ kind: 'room', id: 'extra' })).toThrow('limit');
    f.state.remove('view:3'); expect(f.state.getSnapshot().preferences.favorites).toHaveLength(FAVORITES_LIMIT - 1);
  });
  it('rejects oversized storage without overwriting it', () => {
    const f = fixture(); f.data.set(NAVIGATION_KEY, ' '.repeat(65537));
    expect(f.state.getSnapshot().error).toBe(true); expect(f.storage.setItem).not.toHaveBeenCalled();
  });
});
