import {
  DOWNLOAD_VIEWS_KEY,
  DOWNLOAD_VIEW_LIMIT,
  DownloadViewError,
  emptyDownloadViews,
  normalizeViewText,
  validateDownloadViews,
  type DownloadView,
  type DownloadViews,
} from "../../shared/download-views";

export interface DownloadViewsSnapshot {
  catalog: DownloadViews;
  error: boolean;
  selection: number;
}
/** One local preference store per renderer; writes commit before subscribers see success. */
export function createDownloadViewsState(
  storage: () => Pick<Storage, "getItem" | "setItem">,
  newId: () => string,
) {
  let snapshot: DownloadViewsSnapshot = {
      catalog: emptyDownloadViews(),
      error: false,
      selection: 0,
    },
    loaded = false;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const refresh = () => {
    try {
      const raw = storage().getItem(DOWNLOAD_VIEWS_KEY);
      const catalog =
        raw === null
          ? emptyDownloadViews()
          : validateDownloadViews(JSON.parse(raw));
      if (
        JSON.stringify(catalog) !== JSON.stringify(snapshot.catalog) ||
        snapshot.error
      )
        snapshot = { catalog, error: false, selection: snapshot.selection + 1 };
    } catch {
      snapshot = { ...snapshot, error: true };
    }
    loaded = true;
    publish();
  };
  const getSnapshot = () => {
    if (!loaded) refresh();
    return snapshot;
  };
  const commit = (catalog: DownloadViews, select = false) => {
    getSnapshot();
    if (snapshot.error) throw new DownloadViewError("storage");
    const checked = validateDownloadViews(catalog);
    try {
      storage().setItem(DOWNLOAD_VIEWS_KEY, JSON.stringify(checked));
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('havvn:device-local'));
    } catch {
      throw new DownloadViewError("storage");
    }
    snapshot = {
      catalog: checked,
      error: false,
      selection: snapshot.selection + (select ? 1 : 0),
    };
    publish();
  };
  return {
    getSnapshot,
    refresh,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select: (activeId: string | null) => {
      const { catalog } = getSnapshot();
      if (activeId !== null && !catalog.views.some((v) => v.id === activeId))
        throw new DownloadViewError("missing");
      commit({ ...catalog, activeId }, true);
    },
    save: (
      name: string,
      config: Omit<DownloadView, "id" | "name" | "pinned">,
      pinned: boolean,
      existingId?: string,
    ) => {
      const { catalog } = getSnapshot(),
        trimmed = name.trim();
      if (!trimmed || trimmed.length > 80) throw new DownloadViewError("name");
      if (
        catalog.views.some(
          (v) =>
            v.id !== existingId &&
            normalizeViewText(v.name) === normalizeViewText(trimmed),
        )
      )
        throw new DownloadViewError("duplicate");
      if (existingId && !catalog.views.some((v) => v.id === existingId))
        throw new DownloadViewError("missing");
      if (!existingId && catalog.views.length >= DOWNLOAD_VIEW_LIMIT)
        throw new DownloadViewError("limit");
      const view = {
        ...config,
        id: existingId ?? newId(),
        name: trimmed,
        pinned,
      };
      commit(
        {
          ...catalog,
          views: existingId
            ? catalog.views.map((v) => (v.id === existingId ? view : v))
            : [...catalog.views, view],
          activeId: view.id,
        },
        true,
      );
      return view.id;
    },
    rename: (id: string, name: string) => {
      const { catalog } = getSnapshot(),
        view = catalog.views.find((v) => v.id === id),
        trimmed = name.trim();
      if (!view) throw new DownloadViewError("missing");
      if (!trimmed || trimmed.length > 80) throw new DownloadViewError("name");
      if (
        catalog.views.some(
          (v) =>
            v.id !== id &&
            normalizeViewText(v.name) === normalizeViewText(trimmed),
        )
      )
        throw new DownloadViewError("duplicate");
      commit({
        ...catalog,
        views: catalog.views.map((v) =>
          v.id === id ? { ...v, name: trimmed } : v,
        ),
      });
    },
    pin: (id: string) => {
      const { catalog } = getSnapshot();
      if (!catalog.views.some((v) => v.id === id))
        throw new DownloadViewError("missing");
      commit({
        ...catalog,
        views: catalog.views.map((v) =>
          v.id === id ? { ...v, pinned: !v.pinned } : v,
        ),
      });
    },
    remove: (id: string) => {
      const { catalog } = getSnapshot();
      if (!catalog.views.some((v) => v.id === id))
        throw new DownloadViewError("missing");
      commit(
        {
          ...catalog,
          views: catalog.views.filter((v) => v.id !== id),
          activeId: catalog.activeId === id ? null : catalog.activeId,
        },
        catalog.activeId === id,
      );
    },
  };
}
