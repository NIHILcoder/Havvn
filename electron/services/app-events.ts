import Store from "electron-store";
import { encryptSecret, decryptSecretStrict } from "../db/secrets";
import { AppEventStore } from "./app-event-store";
import type {
  AppEventCode,
  AppEventObject,
  AppEvent,
} from "../../shared/app-events";

let instance: AppEventStore | undefined;
export function getAppEvents(): AppEventStore {
  if (!instance) {
    let store: Store<{ payload: string }> | undefined;
    instance = new AppEventStore({
      read: () => {
        store = new Store({
          name: "events",
          defaults: { payload: "" },
          clearInvalidConfig: false,
        });
        const payload = store.get("payload");
        if (typeof payload !== "string" || payload.length > 2 * 1024 * 1024)
          throw new Error("Invalid event history size");
        return payload ? JSON.parse(decryptSecretStrict(payload)) : null;
      },
      write: (state) => {
        if (!store) throw new Error("Event storage is unavailable");
        store.set("payload", encryptSecret(JSON.stringify(state), false));
      },
    });
  }
  return instance;
}
/** Recording history must never turn a completed operation into a failure. */
export function recordAppEvent(
  code: AppEventCode,
  object: AppEventObject,
  params?: AppEvent["params"],
): void {
  try {
    getAppEvents().record(code, object, params);
  } catch {
    /* local history is best effort */
  }
}
export function resolveAppEvent(
  code: AppEventCode,
  object: AppEventObject,
): void {
  try {
    getAppEvents().resolve(code, object);
  } catch {
    /* source of truth is the subsystem */
  }
}
