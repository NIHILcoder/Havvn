import { ipcMain, type BrowserWindow } from "electron";
import { getAppEvents } from "../services/app-events";
import { AppEventActions } from "../services/app-event-actions";
import type { Download } from "../../shared/types";

export function registerAppEventsIpc(
  getWindow: () => BrowserWindow,
  deps: {
    getDownload: (id: string) => Promise<Download | null>;
    getRoomIds: () => Promise<string[]>;
    retry: (id: string) => Promise<unknown>;
  },
): void {
  const store = getAppEvents(),
    actions = new AppEventActions(store, deps);
  const assert = (event: Electron.IpcMainInvokeEvent) => {
    const window = getWindow();
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Untrusted event history request");
  };
  ipcMain.handle("events:list", (event, query: unknown) => {
    assert(event);
    return store.list(query);
  });
  ipcMain.handle("events:summary", (event) => {
    assert(event);
    return store.summary();
  });
  ipcMain.handle("events:read", (event, id: string) => {
    assert(event);
    store.read(id);
  });
  ipcMain.handle("events:run", (event, id: unknown, action: unknown) => {
    assert(event);
    return actions.run(id, action);
  });
  store.subscribe(() => {
    const window = getWindow();
    if (window && !window.isDestroyed())
      window.webContents.send("events:changed");
  });
}
