import type { MergedResult } from '../../shared/search-dedupe';
import type { ProviderStat } from '../../shared/types';

export interface SearchSession {
  query: string; term: string; rows: MergedResult[]; hasSearched: boolean; interrupted: boolean;
  providerStats: ProviderStat[]; sortKey: 'seeds' | 'size' | 'name' | 'date'; sortDesc: boolean;
  refine: string; minSeeds: number; hideDead: boolean; providerFilter: string | null;
  expandedGroups: string[]; addCategoryId: string; addPaused?: boolean; scrollTop: number;
  capturedAt: number; truncated?: boolean;
}
/** One bounded result set in this window's memory. Never stores credentials or starts work. */
export function createSearchSession() {
  let snapshot: SearchSession | null = null;
  return {
    read: () => snapshot,
    save(value: SearchSession) {
      snapshot = { ...value, rows: value.rows.slice(0, 10_000), expandedGroups: value.expandedGroups.slice(0, 10_000),
        providerStats: value.providerStats.slice(0, 100), scrollTop: Math.max(0, value.scrollTop),
        truncated: value.rows.length > 10_000,
        providerFilter: value.providerFilter,
      };
    },
    clear() { snapshot = null; },
  };
}
export const searchSession = createSearchSession();
