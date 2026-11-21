export interface DownloadLink { sourceType: 'magnet' | 'torrent_file'; sourceUri: string }
const btih = /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i;

/** One explicit user-supplied link. Parsing never fetches or starts a download. */
export function parseDownloadLink(value: string): DownloadLink | null {
  const text = value.trim();
  // eslint-disable-next-line no-control-regex -- Reject NUL and line breaks in user-supplied links.
  if (!text || text.length > 10_000 || /[\r\n\u0000]/.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol === 'magnet:') {
      if (url.host || url.pathname) return null;
      const params = [...url.searchParams.entries()];
      if (!params.some(([key, value]) => key.toLowerCase() === 'xt' && btih.test(value))) return null;
      // Keep btih literal for both engines' hash extraction, including when the
      // pasted link percent-encoded its xt value. Other values stay URL encoded.
      const sourceUri = 'magnet:?' + params.map(([key, value]) => {
        const xt = key.toLowerCase() === 'xt';
        return `${encodeURIComponent(xt ? 'xt' : key)}=${xt && btih.test(value) ? value : encodeURIComponent(value)}`;
      }).join('&');
      return sourceUri.length <= 10_000 ? { sourceType: 'magnet', sourceUri } : null;
    }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) {
      return url.href.length <= 10_000 ? { sourceType: 'torrent_file', sourceUri: url.href } : null;
    }
  } catch { /* Invalid or unsupported link. */ }
  return null;
}
