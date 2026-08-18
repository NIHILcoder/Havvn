/**
 * OPML import and export for feed subscriptions.
 *
 * OPML is how every other reader and torrent client hands over a feed list, and
 * without it a collection moves one URL at a time by hand. Deliberately narrow:
 * the only fields anyone actually exchanges are the title and the feed URL.
 *
 * Pure and Electron-free so it can be unit-tested, like the other parsers here.
 */

export interface OPMLFeed {
  name: string;
  url: string;
}

/** Cap on outlines accepted from one document. */
const MAX_FEEDS = 500;

/**
 * Read feeds out of an OPML document.
 *
 * Outlines nest (readers use folders), so the whole document is scanned rather
 * than just the top level — a foldered export would otherwise import as empty.
 * Outlines with no xmlUrl are containers, not feeds, and are skipped.
 */
export function parseOPML(xml: string): OPMLFeed[] {
  if (!/<opml[\s>]/i.test(xml)) {
    throw new Error('Not an OPML document');
  }

  const out: OPMLFeed[] = [];
  const seen = new Set<string>();

  const outlineRegex = /<outline(?:\s[^>]*)?\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = outlineRegex.exec(xml)) !== null && out.length < MAX_FEEDS) {
    const tag = match[0];
    const url = decodeEntities(attrValue(tag, 'xmlUrl') || attrValue(tag, 'xmlurl') || '');
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const name = decodeEntities(
      attrValue(tag, 'title') || attrValue(tag, 'text') || ''
    ).trim();

    out.push({ name: name || hostOf(url), url });
  }

  return out;
}

/** Render feeds as an OPML 2.0 document. */
export function buildOPML(feeds: OPMLFeed[], title = 'Havvn feeds'): string {
  const outlines = feeds
    .map(feed => {
      const name = escapeAttr(feed.name || hostOf(feed.url));
      return `    <outline type="rss" text="${name}" title="${name}" xmlUrl="${escapeAttr(feed.url)}" />`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escapeAttr(title)}</title>`,
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    '  </head>',
    '  <body>',
    outlines,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
}

/** Last-resort name for a feed the document didn't title. */
function hostOf(url: string): string {
  const match = url.match(/^https?:\/\/([^/?#]+)/i);
  return match ? match[1] : url;
}

function attrValue(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  if (!m) return null;
  return m[2] ?? m[3] ?? '';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, '&');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
