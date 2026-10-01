import { createHash } from 'crypto';
import type { SearchResult } from '../../shared/types';
import { searchHistoryTitle } from '../../shared/search-download-history';

/** Source-scoped fingerprints, never raw URLs/passkeys or ephemeral sourceRefs. */
export function searchSourceHistoryKeys(providerId: string, result: SearchResult): string[] {
  const links = [result.detailsUrl, result.torrentUrl].filter((url): url is string => !!url);
  return [...new Set(links.flatMap(link => {
    try {
      const url = new URL(link);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
      url.hash = '';
      url.searchParams.sort();
      return [createHash('sha256').update(JSON.stringify([
        providerId, url.href, searchHistoryTitle(result.title), result.size,
      ])).digest('hex')];
    } catch { return []; }
  }))];
}
