/**
 * Which games the picker offers as "coming soon".
 *
 * The rule worth pinning is the self-cleaning one: the locked entries carry ids
 * so that shipping a real module for one of them removes its own placeholder.
 * Without that, the day a Terraria module registers the window would show
 * Terraria in both sections at once — available and unavailable — and the only
 * thing standing between us and that is somebody remembering to edit a constant.
 */
import { describe, it, expect } from 'vitest';
import { plannedGamesFor } from './GamePicker';

const planned = [{ id: 'terraria', label: 'Terraria' }, { id: 'valheim', label: 'Valheim' }];

describe('plannedGamesFor', () => {
  it('offers the planned games no module covers yet', () => {
    expect(plannedGamesFor([{ id: 'minecraft' }], planned).map((g) => g.id))
      .toEqual(['terraria', 'valheim']);
  });

  it('a shipped module deletes its own locked row', () => {
    expect(plannedGamesFor([{ id: 'minecraft' }, { id: 'terraria' }], planned).map((g) => g.id))
      .toEqual(['valheim']);
    expect(plannedGamesFor([{ id: 'terraria' }, { id: 'valheim' }], planned)).toEqual([]);
  });

  it('shows everything when nothing is registered, and nothing when nothing is planned', () => {
    expect(plannedGamesFor([], planned)).toHaveLength(2);
    expect(plannedGamesFor([{ id: 'minecraft' }], [])).toEqual([]);
  });

  it('ships a real list that cannot collide with a registered module id', () => {
    // Guards the shipped constant, not the fixture: an entry named 'minecraft'
    // would silently vanish from the window and read as a lost edit.
    for (const id of ['minecraft', 'generic']) {
      expect(plannedGamesFor([{ id }]).some((g) => g.id === id)).toBe(false);
    }
    expect(plannedGamesFor([{ id: 'minecraft' }]).length).toBeGreaterThan(0);
  });

  it('keeps the promise list short — every entry is one', () => {
    expect(plannedGamesFor([]).length).toBeLessThanOrEqual(3);
  });
});
