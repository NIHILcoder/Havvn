/**
 * Torznab `t=caps` parsing.
 *
 * The category dropdown used to be five hardcoded newznab numbers. Those are
 * meaningless for a custom or script provider, and even a real Torznab indexer
 * only supports some of them — picking one the indexer doesn't carry quietly
 * returns nothing. Every Torznab server publishes what it actually supports;
 * this reads it.
 *
 * Pure and Electron-free so it can be unit-tested, like the other parsers in
 * this directory.
 */

import { SearchCaps, SearchCategory } from './types';

/** Ceiling on categories accepted from one document, so a dropdown stays usable. */
const MAX_CATEGORIES = 100;

/**
 * Parse a caps document.
 *
 * Only top-level `<category>` elements are taken: the nested `<subcat>` list runs
 * to hundreds of entries on a large indexer, and the coarse grouping is what a
 * dropdown wants. Throws when the document isn't caps at all, so the caller can
 * report a clear provider error.
 */
export function parseCaps(xml: string): SearchCaps {
  if (!/<caps[\s>]/i.test(xml)) {
    throw new Error('Not a Torznab caps document');
  }

  return {
    searchAvailable: parseSearchAvailable(xml),
    categories: parseCategories(xml),
  };
}

function parseSearchAvailable(xml: string): boolean {
  // <searching><search available="yes" …/></searching>
  const search = xml.match(/<search\s[^>]*\/?>/i);
  if (!search) return true; // unstated means usable
  const available = attrValue(search[0], 'available');
  return available === null || available.toLowerCase() !== 'no';
}

function parseCategories(xml: string): SearchCategory[] {
  // Scope to <categories> so a <category> mentioned elsewhere can't leak in.
  const block = xml.match(/<categories(?:\s[^>]*)?>([\s\S]*?)<\/categories\s*>/i);
  if (!block) return [];

  const out: SearchCategory[] = [];
  const seen = new Set<string>();

  // `<category` and not `<cat` — subcats use a different element name, so they
  // are excluded by construction.
  const categoryRegex = /<category(?:\s[^>]*)?\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = categoryRegex.exec(block[1])) !== null && out.length < MAX_CATEGORIES) {
    const id = attrValue(match[0], 'id');
    const name = attrValue(match[0], 'name');
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }

  return out;
}

/** Value of `name` inside a start tag, single or double quoted. */
function attrValue(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  if (!m) return null;
  return (m[2] ?? m[3] ?? '').trim();
}

/**
 * Union the categories of several providers for a single dropdown, keeping the
 * first name seen for an id (indexers word them slightly differently).
 */
export function mergeCategories(sets: SearchCategory[][]): SearchCategory[] {
  const byId = new Map<string, SearchCategory>();
  for (const set of sets) {
    for (const category of set) {
      if (!byId.has(category.id)) byId.set(category.id, category);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
