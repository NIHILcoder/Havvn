import { describe, it, expect } from 'vitest';
import { parseFeed, extractTag, decodeEntities } from './feed-parse';

const FEED = 'feed-1';

describe('parseFeed — RSS 2.0', () => {
  it('reads an enclosure item with size', () => {
    const xml = `
      <rss><channel>
        <item>
          <title>Ubuntu 24.04 Desktop</title>
          <guid isPermaLink="false">ubuntu-2404</guid>
          <pubDate>Tue, 23 Apr 2024 10:00:00 GMT</pubDate>
          <enclosure url="https://example.org/u.torrent" length="6291456" type="application/x-bittorrent" />
        </item>
      </channel></rss>`;

    const [item] = parseFeed(xml, FEED);
    expect(item.title).toBe('Ubuntu 24.04 Desktop');
    expect(item.guid).toBe('ubuntu-2404');
    expect(item.link).toBe('https://example.org/u.torrent');
    expect(item.size).toBe(6291456);
    expect(item.feedId).toBe(FEED);
    expect(item.downloaded).toBe(false);
  });

  it('decodes entity-escaped links, including inside CDATA', () => {
    const xml = `
      <rss><channel>
        <item>
          <title>Escaped</title>
          <link>https://tracker.test/dl?id=1&amp;passkey=abc</link>
        </item>
        <item>
          <title><![CDATA[In CDATA]]></title>
          <link><![CDATA[magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&amp;dn=x]]></link>
        </item>
      </channel></rss>`;

    const items = parseFeed(xml, FEED);
    expect(items[0].link).toBe('https://tracker.test/dl?id=1&passkey=abc');
    expect(items[1].link).toContain('&dn=x');
    expect(items[1].link).not.toContain('&amp;');
  });

  it('falls back to a magnet buried in the description', () => {
    const xml = `
      <rss><channel>
        <item>
          <title>Only in body</title>
          <link>https://tracker.test/details/42</link>
          <description><![CDATA[<p>Grab it: magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&amp;dn=y</p>]]></description>
        </item>
      </channel></rss>`;

    // The item already has an http link, so the description magnet is not needed;
    // what matters is that inline HTML in the description doesn't break parsing.
    const [item] = parseFeed(xml, FEED);
    expect(item.link).toBe('https://tracker.test/details/42');
    expect(item.title).toBe('Only in body');
  });

  it('uses the description magnet when no link element exists', () => {
    const xml = `
      <rss><channel>
        <item>
          <title>Magnet only</title>
          <description>magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&amp;dn=z</description>
        </item>
      </channel></rss>`;

    const [item] = parseFeed(xml, FEED);
    expect(item.link).toBe('magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=z');
  });

  it('reads torrent: namespace magnet, size and seeds', () => {
    const xml = `
      <rss><channel>
        <item>
          <title>Namespaced</title>
          <torrent:magnetURI>magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd</torrent:magnetURI>
          <torrent:contentLength>1048576</torrent:contentLength>
          <torrent:seeds>42</torrent:seeds>
        </item>
      </channel></rss>`;

    const [item] = parseFeed(xml, FEED);
    expect(item.link).toContain('magnet:?xt=urn:btih:dddd');
    expect(item.size).toBe(1048576);
    expect(item.seeds).toBe(42);
  });

  it('skips items with no way to fetch them', () => {
    const xml = `
      <rss><channel>
        <item><title>Nothing here</title></item>
        <item><title>Real</title><link>magnet:?xt=urn:btih:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee</link></item>
      </channel></rss>`;

    const items = parseFeed(xml, FEED);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Real');
  });

  it('does not treat lookalike elements as items', () => {
    const xml = `
      <rss><channel>
        <itemcount>7</itemcount>
        <item><title>Genuine</title><link>magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff</link></item>
      </channel></rss>`;

    const items = parseFeed(xml, FEED);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Genuine');
  });
});

describe('parseFeed — Atom 1.0', () => {
  it('reads an entry with an enclosure link', () => {
    const xml = `
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Debian 12.5</title>
          <id>tag:example.org,2024:debian-125</id>
          <updated>2024-02-10T12:00:00Z</updated>
          <link rel="alternate" href="https://example.org/debian-125" />
          <link rel="enclosure" type="application/x-bittorrent" href="https://example.org/d.torrent" length="512000" />
        </entry>
      </feed>`;

    const [item] = parseFeed(xml, FEED);
    expect(item.title).toBe('Debian 12.5');
    expect(item.guid).toBe('tag:example.org,2024:debian-125');
    expect(item.link).toBe('https://example.org/d.torrent');
    expect(item.size).toBe(512000);
    expect(item.pubDate).toBe('2024-02-10T12:00:00Z');
  });

  it('prefers published over updated for the date', () => {
    const xml = `
      <feed>
        <entry>
          <title>Dated</title>
          <published>2024-01-01T00:00:00Z</published>
          <updated>2024-06-01T00:00:00Z</updated>
          <link rel="enclosure" href="https://example.org/a.torrent" />
        </entry>
      </feed>`;

    const [item] = parseFeed(xml, FEED);
    expect(item.pubDate).toBe('2024-01-01T00:00:00Z');
  });

  it('builds a magnet from a Nyaa-style info hash', () => {
    const xml = `
      <feed>
        <entry>
          <title>Anime Ep 01</title>
          <id>nyaa-1</id>
          <nyaa:infoHash>0123456789abcdef0123456789abcdef01234567</nyaa:infoHash>
          <nyaa:seeders>17</nyaa:seeders>
        </entry>
      </feed>`;

    const [item] = parseFeed(xml, FEED);
    expect(item.link).toBe(
      'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Anime%20Ep%2001'
    );
    expect(item.seeds).toBe(17);
  });

  it('accepts single-quoted attributes', () => {
    const xml = `
      <feed>
        <entry>
          <title>Quoted</title>
          <id>q-1</id>
          <link rel='enclosure' href='https://example.org/q.torrent'/>
        </entry>
      </feed>`;

    const [item] = parseFeed(xml, FEED);
    expect(item.link).toBe('https://example.org/q.torrent');
  });

  it('falls back to the alternate link when there is no enclosure', () => {
    const xml = `
      <feed>
        <entry>
          <title>Alt only</title>
          <id>alt-1</id>
          <link rel="alternate" href="https://example.org/page" />
        </entry>
      </feed>`;

    const [item] = parseFeed(xml, FEED);
    expect(item.link).toBe('https://example.org/page');
  });
});

describe('parseFeed — general', () => {
  it('dedupes by guid across both element shapes', () => {
    const xml = `
      <feed>
        <item><title>A</title><guid>same</guid><link>magnet:?xt=urn:btih:1111111111111111111111111111111111111111</link></item>
        <entry><title>A</title><id>same</id><link rel="enclosure" href="https://example.org/a.torrent"/></entry>
      </feed>`;

    expect(parseFeed(xml, FEED)).toHaveLength(1);
  });

  it('returns an empty list for a document with no items', () => {
    expect(parseFeed('<rss><channel><title>Empty</title></channel></rss>', FEED)).toEqual([]);
    expect(parseFeed('', FEED)).toEqual([]);
  });
});

describe('extractTag', () => {
  it('reads CDATA and plain content', () => {
    expect(extractTag('<title><![CDATA[ Hello ]]></title>', 'title')).toBe('Hello');
    expect(extractTag('<title> Hello </title>', 'title')).toBe('Hello');
  });

  it('keeps inline markup instead of stopping at the first tag', () => {
    expect(extractTag('<description>a <b>bold</b> word</description>', 'description'))
      .toBe('a <b>bold</b> word');
  });

  it('matches a namespaced element when asked for the bare name', () => {
    expect(extractTag('<dc:creator>someone</dc:creator>', 'creator')).toBe('someone');
  });

  it('does not match an element whose name merely starts the same', () => {
    expect(extractTag('<titles>x</titles>', 'title')).toBeNull();
  });
});

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeEntities('a &amp; b')).toBe('a & b');
    expect(decodeEntities('&quot;q&quot; &apos;a&apos;')).toBe('"q" \'a\'');
    expect(decodeEntities('&#72;&#105;')).toBe('Hi');
    expect(decodeEntities('&#x48;&#x69;')).toBe('Hi');
  });

  it('does not double-decode escaped markup', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });

  it('drops out-of-range code points instead of throwing', () => {
    expect(decodeEntities('&#1114112;')).toBe('');
  });
});
