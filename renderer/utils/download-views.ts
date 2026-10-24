import { useSyncExternalStore } from "react";
import { DOWNLOAD_VIEWS_KEY } from "../../shared/download-views";
import { createDownloadViewsState } from "../state/download-views-state";

export const downloadViews = createDownloadViewsState(
  () => localStorage,
  () => crypto.randomUUID(),
);
let owners = 0;
const refresh = (event: StorageEvent) => {
  if (event.key === DOWNLOAD_VIEWS_KEY || event.key === null)
    downloadViews.refresh();
};
const subscribe = (listener: () => void) => {
  const off = downloadViews.subscribe(listener);
  if (++owners === 1) {
    window.addEventListener("storage", refresh);
    window.addEventListener("havvn:settings-transfer", downloadViews.refresh);
    downloadViews.refresh();
  }
  return () => {
    off();
    if (--owners === 0) {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(
        "havvn:settings-transfer",
        downloadViews.refresh,
      );
    }
  };
};
export const useDownloadViews = () =>
  useSyncExternalStore(
    subscribe,
    downloadViews.getSnapshot,
    downloadViews.getSnapshot,
  );
