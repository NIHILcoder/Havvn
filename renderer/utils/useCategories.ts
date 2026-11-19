/**
 * Categories, loaded once per window.
 *
 * Categories change rarely (five defaults, edited by hand), but they are read
 * from several places at once — the picker on the search page, the picker in the
 * RSS feed form, and every row in the downloads list resolving its category id
 * to a name. A shared store coalesces requests and refreshes mounted consumers
 * after a main-process change, with one IPC subscription per window.
 */

import { useSyncExternalStore } from 'react';
import { Category } from '../../shared/types';
import { createCategoriesState } from '../state/categories';

const categoriesState = createCategoriesState(() => window.api);

/** Forget the cached list — call after categories are added, edited or removed. */
export function invalidateCategories(): void {
  categoriesState.invalidate();
}

export function useCategories(): Category[] {
  return useSyncExternalStore(categoriesState.subscribe, categoriesState.getSnapshot, categoriesState.getSnapshot);
}

/** Display name for a stored category id, falling back to the id itself. */
export function categoryLabel(categories: Category[], id: string | null): string | null {
  if (!id) return null;
  return categories.find(c => c.id === id)?.name ?? id;
}
