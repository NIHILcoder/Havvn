/**
 * Feed parser for RSS subscriptions.
 *
 * Lives in `shared/` with no Electron / Node imports so it can be unit-tested in
 * isolation (same arrangement as `search-parse.ts`).
 *
 * It reads BOTH shapes a torrent feed shows up in:
 *   - RSS 2.0   — `<item>` with `<enclosure>` / `<torrent:magnetURI>` / `<link>`
 *   - Atom 1.0  — `<entry>` with `<link rel="enclosure" href>` / `<id>`
 *
 * Atom used to be invisible: the old parser only ever looked for `<item>`, so a
 * Nyaa or GitHub-releases feed was accepted, showed as healthy, and silently
 * produced zero items forever.
 *
 * The parsing is regex-based on purpose — it stays dependency-free and tolerates
 * the malformed markup real trackers emit, where a strict XML parser would throw
 * away the whole document over one stray ampersand.
 */

import { RSSItem } from './types';

/** Magnet URI as it appears inside descriptions/summaries. */
const MAGNET_RE = /magnet:\?[^\s"'<>]+/i;

/** A 40-char hex or 32-char base32 BitTorrent info hash. */
const INFOHASH_RE = /^[0-9a-f]{40}$|^[a-z2-7]{32}$/i;

/**
 * Parse a feed document into items.
 *
 * Both element shapes are scanned and merged (deduped by guid) rather than
 * picking one branch, so a hybrid document doesn't lose half its entries.
 */
export function parseFeed(xml: string, feedId: string): RSSItem[] {
  const items = [...parseRssItems(xml, feedId), ...parseAtomEntries(xml, feedId)];

  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.guid)) return false;
    seen.add(item.guid);
    return true;
  });
}

// ---------------------------------------------------------------- RSS 2.0

function parseRssItems(xml: string, feedId: string): RSSItem[] {
  const out: RSSItem[] = [];
  // `<item(?:\s[^>]*)?>` and not `<item[^>]*>`: the latter also matches `<items>`
  // and any other element whose name merely starts with "item".
  const itemRegex = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi;

  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = buildItem(match[1], feedId, rssLink, rssDate);
    if (item) out.push(item);
  }
  return out;
}

/** Resolve the downloadable link of an RSS `<item>`, best source first. */
function rssLink(xml: string): string {
  // <enclosure url="..."> is the canonical torrent carrier in RSS.
  const enclosure = attr(xml, 'enclosure', 'url');
  if (enclosure) return enclosure;

  const magnetTag = extractTag(xml, 'torrent:magnetURI') || extractTag(xml, 'magnetURI');
  if (magnetTag) return magnetTag;

  const link = extractTag(xml, 'link');
  if (link) return link;

  return '';
}

function rssDate(xml: string): string | undefined {
  return extractTag(xml, 'pubDate') || extractTag(xml, 'dc:date') || undefined;
}

// ---------------------------------------------------------------- Atom 1.0

function parseAtomEntries(xml: string, feedId: string): RSSItem[] {
  const out: RSSItem[] = [];
  const entryRegex = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry\s*>/gi;

  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml)) !== null) {
    const item = buildItem(match[1], feedId, atomLink, atomDate);
    if (item) out.push(item);
  }
  return out;
}

interface AtomLink {
  href: string;
  rel: string;
  type: string;
  length: string;
}

function atomLinks(xml: string): AtomLink[] {
  const out: AtomLink[] = [];
  // Atom links are empty elements carrying attributes — `<link href="…"/>` —
  // so the RSS text-content extraction finds nothing here.
  const linkRegex = /<link(?:\s[^>]*)?\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(xml)) !== null) {
    const tag = match[0];
    const href = attrValue(tag, 'href');
    if (!href) continue;
    out.push({
      href,
      rel: (attrValue(tag, 'rel') || 'alternate').toLowerCase(),
      type: (attrValue(tag, 'type') || '').toLowerCase(),
      length: attrValue(tag, 'length') || '',
    });
  }
  return out;
}

function atomLink(xml: string): string {
  const links = atomLinks(xml);

  const enclosure = links.find(l => l.rel === 'enclosure');
  if (enclosure) return enclosure.href;

  const torrentType = links.find(l => l.type.includes('bittorrent'));
  if (torrentType) return torrentType.href;

  const magnet = links.find(l => /^magnet:/i.test(l.href));
  if (magnet) return magnet.href;

  const alternate = links.find(l => l.rel === 'alternate');
  if (alternate) return alternate.href;

  return links[0]?.href || '';
}

function atomDate(xml: string): string | undefined {
  return extractTag(xml, 'published') || extractTag(xml, 'updated') || undefined;
}

// ---------------------------------------------------------------- shared

/**
 * Build one item from an `<item>` / `<entry>` body. Returns null when there is
 * no way to actually fetch the torrent — such a row is noise in the list.
 */
function buildItem(
  xml: string,
  feedId: string,
  linkOf: (xml: string) => string,
  dateOf: (xml: string) => string | undefined
): RSSItem | null {
  const title = decodeEntities(extractTag(xml, 'title') || 'Untitled');

  // Entity-decode links unconditionally, CDATA included: a URL never legitimately
  // contains the literal text "&amp;", and plenty of trackers escape magnets
  // inside CDATA anyway. Skipping this makes tracker links 404.
  let link = decodeEntities(linkOf(xml));

  // No usable link yet? Torrent feeds routinely bury the magnet in the body text.
  if (!isFetchable(link)) {
    const body =
      extractTag(xml, 'description') ||
      extractTag(xml, 'content') ||
      extractTag(xml, 'summary') ||
      '';
    const found = decodeEntities(body).match(MAGNET_RE);
    if (found) link = found[0];
  }

  // Nyaa-style feeds ship the hash instead of a link — that's enough to build one.
  const infoHash = extractTag(xml, 'nyaa:infoHash') || extractTag(xml, 'torrent:infoHash');
  if (!isFetchable(link) && infoHash && INFOHASH_RE.test(infoHash.trim())) {
    link = `magnet:?xt=urn:btih:${infoHash.trim()}&dn=${encodeURIComponent(title)}`;
  }

  // media:content is the last resort — some aggregators use it as the enclosure.
  if (!isFetchable(link)) {
    const media = attr(xml, 'media:content', 'url');
    if (media) link = decodeEntities(media);
  }

  if (!link) return null;

  const guid =
    extractTag(xml, 'guid') ||
    extractTag(xml, 'id') ||
    extractTag(xml, 'link') ||
    link ||
    title;

  return {
    guid: String(decodeEntities(guid)),
    title,
    link,
    pubDate: dateOf(xml),
    downloaded: false,
    size: parseSize(xml),
    seeds: parseSeeds(xml),
    feedId,
  };
}

/** A link we can hand to the downloader as-is. */
function isFetchable(link: string): boolean {
  return /^magnet:/i.test(link) || /^https?:\/\//i.test(link);
}

function parseSize(xml: string): number | undefined {
  // torrent:contentLength is the most explicit, then the enclosure/link length attr.
  const contentLength = extractTag(xml, 'torrent:contentLength') || extractTag(xml, 'contentLength');
  const fromTag = toPositiveInt(contentLength);
  if (fromTag) return fromTag;

  const fromEnclosure = toPositiveInt(attr(xml, 'enclosure', 'length'));
  if (fromEnclosure) return fromEnclosure;

  const atomLength = atomLinks(xml).map(l => toPositiveInt(l.length)).find(Boolean);
  return atomLength || undefined;
}

/**
 * Seed count, when the feed bothers to publish one. Nothing renders it yet — it
 * is captured so the RSS rule engine can filter on it (plan phase 3.1) without a
 * second pass over every stored item.
 */
function parseSeeds(xml: string): number | undefined {
  const raw =
    extractTag(xml, 'torrent:seeds') ||
    extractTag(xml, 'nyaa:seeders') ||
    extractTag(xml, 'seeders');
  const n = toPositiveInt(raw);
  return n === undefined ? undefined : n;
}

function toPositiveInt(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Text content of an element, CDATA-aware.
 *
 * Tries the exact name first, then the same local name under any namespace
 * prefix, so `<magnetURI>` and `<torrent:magnetURI>` both resolve without the
 * caller guessing which prefix a given tracker picked.
 */
export function extractTag(xml: string, tag: string): string | null {
  const direct = matchTag(xml, escapeRe(tag));
  if (direct !== null) return direct;

  // Only worth a second pass for unprefixed names — a prefixed request already
  // named the namespace it wanted.
  if (tag.includes(':')) return null;
  return matchTag(xml, `(?:\\w+:)?${escapeRe(tag)}`);
}

function matchTag(xml: string, namePattern: string): string | null {
  const open = `<${namePattern}(?:\\s[^>]*)?>`;
  const close = `<\\/${namePattern}\\s*>`;

  const cdata = xml.match(new RegExp(`${open}\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*${close}`, 'i'));
  if (cdata) return cdata[1].trim();

  // `[\s\S]*?` rather than `[^<]*`: descriptions carry inline HTML, and the old
  // `[^<]*` bailed out at the first tag and returned nothing.
  const normal = xml.match(new RegExp(`${open}([\\s\\S]*?)${close}`, 'i'));
  if (normal) return normal[1].trim();

  return null;
}

/** Value of `attribute` on the first `<tag …>` element found. */
function attr(xml: string, tag: string, attribute: string): string | null {
  const el = xml.match(new RegExp(`<${escapeRe(tag)}(?:\\s[^>]*)?\\/?>`, 'i'));
  return el ? attrValue(el[0], attribute) : null;
}

/** Value of `name` inside a single start tag, single or double quoted. */
function attrValue(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${escapeRe(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  if (!m) return null;
  return (m[2] ?? m[3] ?? '').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Decode the XML/HTML entities that show up in feed titles and links. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" doesn't collapse into "<"
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}
