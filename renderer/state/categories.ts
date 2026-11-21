import type { Category, IpcApi } from "../../shared/types";

type CategoryApi = Pick<IpcApi, "getCategories"> &
  Partial<Pick<IpcApi, "onCategoriesChanged">>;

/** One request and one IPC subscription per window, even for many mounted rows. */
export function createCategoriesState(getApi: () => CategoryApi) {
  let snapshot: Category[] = [];
  let request: Promise<Category[]> | null = null;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const refresh = () => {
    if (request) return request;
    const pending = Promise.resolve().then(() => getApi().getCategories());
    request = pending;
    void pending.then(
      (categories) => {
        if (request !== pending) return;
        snapshot = categories;
        listeners.forEach((listener) => listener());
      },
      () => {
        // Keep the last successful list; a later subscription/invalidation retries.
        if (request === pending) request = null;
      },
    );
    return pending;
  };
  const invalidate = () => {
    request = null;
    if (listeners.size) void refresh();
  };
  return {
    getSnapshot: () => snapshot,
    refresh,
    invalidate,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        const api = getApi();
        unsubscribe = api.onCategoriesChanged?.(invalidate);
        // A change may have happened while nobody was listening.
        invalidate();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },
  };
}
