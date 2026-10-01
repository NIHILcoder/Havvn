import Store from 'electron-store';
import type { Download } from '../../shared/types';
import { logger } from '../utils/logger';
import {
  rememberSearchDownload, sanitizeSearchDownloadHistory,
  type SearchDownloadHistoryData, type SearchDownloadHistoryEntry,
} from '../../shared/search-download-history';

export class SearchDownloadHistoryStore {
  private readonly store = new Store<{ history: SearchDownloadHistoryData }>({
    name: 'search-download-history', defaults: { history: { version: 1, entries: [] } },
  });
  get(): SearchDownloadHistoryEntry[] {
    return sanitizeSearchDownloadHistory(this.store.get('history')).entries;
  }
  remember(download: Download, keys: string[] = [], removed = false): void {
    try {
      this.store.set('history', rememberSearchDownload(this.store.get('history'), download, keys, removed));
    } catch {
      // History is auxiliary: never report an already successful add/removal as
      // failed, or encourage a duplicate add. Do not log secret-bearing errors.
      logger.warn('SearchDownloadHistory', 'Could not save search download history');
    }
  }
  clear(): void { this.store.set('history', { version: 1, entries: [] }); }
}

export const searchDownloadHistory = new SearchDownloadHistoryStore();
