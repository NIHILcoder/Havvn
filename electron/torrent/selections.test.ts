import { describe, expect, it } from 'vitest';
import { clearSelections, hasNoSelections } from './selections';

describe('WebTorrent selection compatibility', () => {
  it('clears legacy arrays in place', () => {
    const selections = [{ from: 0, to: 100 }];
    clearSelections(selections);
    expect(hasNoSelections(selections)).toBe(true);
  });
  it('clears modern collections through their API', () => {
    const selections = { length: 1, clear() { this.length = 0; } };
    clearSelections(selections);
    expect(hasNoSelections(selections)).toBe(true);
  });
  it('does not silently accept unknown collection formats', () => {
    expect(() => clearSelections({})).toThrow();
    expect(hasNoSelections(undefined)).toBe(false);
  });
});
