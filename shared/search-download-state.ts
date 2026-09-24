import type { Download, SearchResult } from './types';
import { base32ToHex, extractInfoHashFromMagnet } from './magnet';

export type SearchDownloadState = 'inDownloads' | 'downloaded';

function normalizeHash(value?: string): string | null {
  const hash = value?.trim() ?? '';
  if (/^[a-f0-9]{40}$/i.test(hash)) return hash.toLowerCase();
  return /^[a-z2-7]{32}$/i.test(hash) ? base32ToHex(hash) : null;
}

function magnetHash(uri?: string): string | null {
  if (!uri?.toLowerCase().startsWith('magnet:')) return null;
  try {
    for (const xt of new URL(uri).searchParams.getAll('xt')) {
      const hash = extractInfoHashFromMagnet(`magnet:?xt=${xt}`);
      if (hash) return hash;
    }
  } catch { /* An invalid URI is not a reliable identity. */ }
  return null;
}

export function searchResultHash(result: Pick<SearchResult, 'infoHash' | 'magnetUri'>): string | null {
  return normalizeHash(result.infoHash) ?? magnetHash(result.magnetUri);
}

export function downloadSearchState(download: Pick<Download, 'status' | 'progress'>): SearchDownloadState | null {
  if (download.status === 'removed') return null;
  // A stopped, partially downloaded torrent is still in the list. Completion
  // refers to the selected payload, not the existence of every file on disk.
  return download.progress >= 1 ? 'downloaded' : 'inDownloads';
}

export function indexSearchDownloads(downloads: Download[]): Map<string, SearchDownloadState> {
  const index = new Map<string, SearchDownloadState>();
  for (const download of downloads) {
    const state = downloadSearchState(download);
    const hash = normalizeHash(download.infoHash) ?? magnetHash(download.sourceUri);
    if (hash && state && index.get(hash) !== 'downloaded') index.set(hash, state);
  }
  return index;
}
