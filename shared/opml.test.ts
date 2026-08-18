import { describe, it, expect } from 'vitest';
import { parseOPML, buildOPML } from './opml';

const SIMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>My feeds</title></head>
  <body>
    <outline type="rss" text="Linux ISOs" title="Linux ISOs" xmlUrl="https://example.org/linux.xml" />
    <outline type="rss" text="Docs" xmlUrl="https://example.org/docs.xml" />
  </body>
</opml>`;

const FOLDERED = `<opml version="1.0"><body>
  <outline text="Tech">
    <outline type="rss" title="Inner" xmlUrl="https://example.org/inner.xml" />
  </outline>
</body></opml>`;

describe('parseOPML', () => {
  it('reads feeds with their titles', () => {
    expect(parseOPML(SIMPLE)).toEqual([
      { name: 'Linux ISOs', url: 'https://example.org/linux.xml' },
      { name: 'Docs', url: 'https://example.org/docs.xml' },
    ]);
  });

  it('finds feeds inside folders', () => {
    // A foldered export would otherwise import as empty.
    expect(parseOPML(FOLDERED)).toEqual([
      { name: 'Inner', url: 'https://example.org/inner.xml' },
    ]);
  });

  it('skips container outlines that carry no feed URL', () => {
    expect(parseOPML(FOLDERED)).toHaveLength(1);
  });

  it('falls back to the host when there is no title', () => {
    const xml = '<opml><body><outline xmlUrl="https://feeds.example.org/a.xml"/></body></opml>';
    expect(parseOPML(xml)[0].name).toBe('feeds.example.org');
  });

  it('drops duplicate URLs', () => {
    const xml = `<opml><body>
      <outline title="A" xmlUrl="https://example.org/a.xml"/>
      <outline title="B" xmlUrl="https://example.org/a.xml"/>
    </body></opml>`;
    expect(parseOPML(xml)).toHaveLength(1);
  });

  it('ignores non-http URLs', () => {
    const xml = '<opml><body><outline title="X" xmlUrl="file:///etc/passwd"/></body></opml>';
    expect(parseOPML(xml)).toEqual([]);
  });

  it('decodes entities in titles and URLs', () => {
    const xml = '<opml><body><outline title="A &amp; B" xmlUrl="https://x.test/f?a=1&amp;b=2"/></body></opml>';
    expect(parseOPML(xml)[0]).toEqual({ name: 'A & B', url: 'https://x.test/f?a=1&b=2' });
  });

  it('accepts single-quoted attributes', () => {
    const xml = "<opml><body><outline title='Q' xmlUrl='https://x.test/q.xml'/></body></opml>";
    expect(parseOPML(xml)[0].name).toBe('Q');
  });

  it('throws on a document that is not OPML', () => {
    expect(() => parseOPML('<rss><channel/></rss>')).toThrow(/not an opml/i);
    expect(() => parseOPML('')).toThrow();
  });

  it('returns nothing for an empty body', () => {
    expect(parseOPML('<opml><body></body></opml>')).toEqual([]);
  });
});

describe('buildOPML', () => {
  it('round-trips through the parser', () => {
    const feeds = [
      { name: 'Linux ISOs', url: 'https://example.org/linux.xml' },
      { name: 'Docs', url: 'https://example.org/docs.xml' },
    ];
    expect(parseOPML(buildOPML(feeds))).toEqual(feeds);
  });

  it('escapes characters that would break the attribute', () => {
    const xml = buildOPML([{ name: 'A & "B"', url: 'https://x.test/f?a=1&b=2' }]);
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;');
    expect(parseOPML(xml)[0]).toEqual({ name: 'A & "B"', url: 'https://x.test/f?a=1&b=2' });
  });

  it('produces a valid document for an empty list', () => {
    expect(parseOPML(buildOPML([]))).toEqual([]);
  });
});
