import { describe, it, expect } from 'vitest';
import { parseCaps, mergeCategories } from './torznab-caps';

const CAPS = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="Test Indexer" />
  <limits max="100" default="50" />
  <searching>
    <search available="yes" supportedParams="q" />
    <tv-search available="yes" supportedParams="q,season,ep" />
  </searching>
  <categories>
    <category id="2000" name="Movies">
      <subcat id="2010" name="Movies/Foreign" />
      <subcat id="2020" name="Movies/Other" />
    </category>
    <category id="5000" name="TV">
      <subcat id="5030" name="TV/SD" />
    </category>
  </categories>
</caps>`;

describe('parseCaps', () => {
  it('reads top-level categories', () => {
    expect(parseCaps(CAPS).categories).toEqual([
      { id: '2000', name: 'Movies' },
      { id: '5000', name: 'TV' },
    ]);
  });

  it('leaves subcats out — they run to hundreds on a real indexer', () => {
    const ids = parseCaps(CAPS).categories.map(c => c.id);
    expect(ids).not.toContain('2010');
    expect(ids).not.toContain('5030');
  });

  it('reports search availability', () => {
    expect(parseCaps(CAPS).searchAvailable).toBe(true);
    expect(parseCaps('<caps><searching><search available="no"/></searching></caps>').searchAvailable).toBe(false);
  });

  it('treats an unstated searching block as usable', () => {
    expect(parseCaps('<caps><categories/></caps>').searchAvailable).toBe(true);
  });

  it('accepts single-quoted attributes and self-closing categories', () => {
    const xml = `<caps><categories><category id='3000' name='Audio'/></categories></caps>`;
    expect(parseCaps(xml).categories).toEqual([{ id: '3000', name: 'Audio' }]);
  });

  it('ignores a category element outside the categories block', () => {
    const xml = `<caps><notes><category id="1" name="Nope"/></notes><categories><category id="2000" name="Movies"/></categories></caps>`;
    expect(parseCaps(xml).categories).toEqual([{ id: '2000', name: 'Movies' }]);
  });

  it('drops duplicate ids', () => {
    const xml = `<caps><categories><category id="2000" name="Movies"/><category id="2000" name="Films"/></categories></caps>`;
    expect(parseCaps(xml).categories).toHaveLength(1);
  });

  it('throws on a document that is not caps', () => {
    expect(() => parseCaps('<rss><channel/></rss>')).toThrow(/not a torznab caps/i);
    expect(() => parseCaps('')).toThrow();
  });

  it('returns no categories when the block is absent', () => {
    expect(parseCaps('<caps><server title="x"/></caps>').categories).toEqual([]);
  });
});

describe('mergeCategories', () => {
  it('unions ids across providers and sorts numerically', () => {
    const merged = mergeCategories([
      [{ id: '5000', name: 'TV' }, { id: '2000', name: 'Movies' }],
      [{ id: '2000', name: 'Films' }, { id: '3000', name: 'Audio' }],
    ]);

    expect(merged).toEqual([
      { id: '2000', name: 'Movies' },
      { id: '3000', name: 'Audio' },
      { id: '5000', name: 'TV' },
    ]);
  });

  it('handles an empty input', () => {
    expect(mergeCategories([])).toEqual([]);
    expect(mergeCategories([[], []])).toEqual([]);
  });
});
