/**
 * Categories, loaded once per window.
 *
 * Categories change rarely (five defaults, edited by hand), but they are read
 * from several places at once — the picker on the search page, the picker in the
 * RSS feed form, and every row in the downloads list resolving its category id
 * to a name. A module-level promise keeps that to a single IPC round trip
 * instead of one per mounted component.
 */

import { useEffect, useState } from 'react';
import { Category } from '../../shared/types';

let cache: Promise<Category[]> | null = null;

function load(): Promise<Category[]> {
  if (!cache) {
    cache = window.api.getCategories().catch(err => {
      console.error('Failed to load categories:', err);
      // Drop the rejected promise so a later mount can retry rather than
      // inheriting the failure forever.
      cache = null;
      return [] as Category[];
    });
  }
  return cache;
}

/** Forget the cached list — call after categories are added, edited or removed. */
export function invalidateCategories(): void {
  cache = null;
}

export function useCategories(): Category[] {
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    let cancelled = false;
    load().then(list => { if (!cancelled) setCategories(list); });
    return () => { cancelled = true; };
  }, []);

  return categories;
}

/** Display name for a stored category id, falling back to the id itself. */
export function categoryLabel(categories: Category[], id: string | null): string | null {
  if (!id) return null;
  return categories.find(c => c.id === id)?.name ?? id;
}
