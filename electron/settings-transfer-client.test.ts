import { describe, expect, it } from "vitest";
import { createSettingsTransferClient } from "./settings-transfer-client";
import { WORKING_PROFILES_KEY, PANELS_KEY, emptyWorkingProfiles, readProfileNotifications } from '../shared/working-profile-schema';
import { SettingsTransferState } from "./db/settings-transfer-state";
import {
  TRANSFER_SECTIONS,
  captureInterfacePreferences,
  type InterfacePreferences,
} from "../shared/interface-preferences";
import type { SettingsImportState } from "../shared/settings-transfer";
import {
  DEFAULT_VIEW_CONFIG,
  DOWNLOAD_VIEWS_KEY,
} from "../shared/download-views";

it("recovers an older interface journal without clearing views added in the new version", async () => {
  const views = JSON.stringify({
    version: 1,
    views: [
      { ...DEFAULT_VIEW_CONFIG, id: "v1", name: "New view", pinned: true },
    ],
    activeId: "v1",
  });
  const data = new Map<string, string>([
    ["theme", "light"],
    [DOWNLOAD_VIEWS_KEY, views],
  ]);
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  const legacy = captureInterfacePreferences({ getItem: () => null });
  delete (legacy.values as Partial<typeof legacy.values>)[DOWNLOAD_VIEWS_KEY];
  legacy.values.theme = "dark";
  let acknowledged = false;
  const client = createSettingsTransferClient(
    {
      invoke: async () => undefined,
      sendSync: (channel, ...args) => {
        if (channel === "settings:recovery:get")
          return { id: "old-operation", preferences: legacy };
        expect(args).toEqual(["old-operation", legacy]);
        acknowledged = true;
        return { success: true };
      },
    },
    storage,
  );
  await client.recoverSettingsTransfer();
  expect(acknowledged).toBe(true);
  expect(data.get("theme")).toBe("dark");
  expect(data.get(DOWNLOAD_VIEWS_KEY)).toBe(views);
});

describe('working profile preload transaction', () => {
  function prepare() {
    const f = fixture(), notifications = readProfileNotifications(f.main.settings);
    f.storage.setItem(WORKING_PROFILES_KEY, JSON.stringify({ ...emptyWorkingProfiles(), profiles: [{ id: 'p1', name: 'Quiet', values: {
      startPage: 'rooms', viewId: null, appearanceName: null, panels: { sidebar: false, statusBar: true }, notifications: { ...notifications, enableSounds: false },
    } }] }));
    const before = captureInterfacePreferences(f.storage);
    return { f, before, request: { id: 'p1', expected: before, notifications } };
  }
  it('uses the trusted profile route and confirms both stores without changing unrelated settings', async () => {
    const { f, request } = prepare();
    await expect(f.client.applyWorkingProfile(request)).resolves.toEqual({ success: true });
    expect(f.main.settings.enableSounds).toBe(false); expect(f.main.settings.maxDownKbps).toBe(10);
    expect(f.storage.getItem('startPage')).toBe('rooms'); expect(f.storage.getItem('privateSearchToken')).toBe('local-only');
    expect(f.controller.status().recoveryNeeded).toBe(false);
  });
  it('rolls back notifications and the profile checkpoint when renderer storage fails', async () => {
    const { f, before, request } = prepare(); f.storageFailure = { key: PANELS_KEY, once: true };
    await expect(f.client.applyWorkingProfile(request)).rejects.toThrow();
    expect(f.main.settings.enableSounds).toBeUndefined(); expect(captureInterfacePreferences(f.storage)).toEqual(before);
    expect(f.controller.status().recoveryNeeded).toBe(false);
  });
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function fixture() {
  let main = {
    settings: {
      portMin: 6881,
      portMax: 6889,
      maxDownKbps: 10,
      updatedAt: new Date(0),
    },
    categories: [],
    scheduler: { enabled: false, schedules: [] },
    privacyConfig: {},
  } as unknown as SettingsImportState;
  main = clone(main);
  let record: unknown = null,
    failingKey: string | null = null,
    failOnce = false,
    concurrent = false,
    failFinish = false;
  const data = new Map<string, string>([
    ["theme", "dark"],
    ["density", "normal"],
    ["privateSearchToken", "local-only"],
  ]);
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      if (failingKey === key) {
        if (failOnce) failingKey = null;
        throw new Error("storage quota");
      }
      data.set(key, value);
    },
  };
  const original = captureInterfacePreferences(storage),
    incoming = clone(original);
  incoming.values.theme = "light";
  incoming.values.hotkeys = JSON.stringify([
    { id: "open-settings", keys: ["Alt", "KeyK"] },
  ]);
  const controller = new SettingsTransferState({
    read: () => clone(record),
    write: (value) => {
      record = clone(value);
    },
    readMain: () => clone(main),
    writeMain: (next, expected) => {
      if (JSON.stringify(main) !== JSON.stringify(expected))
        throw new Error("stale");
      main = clone(next);
    },
    categoryReferences: () => new Set(),
  });
  const bridge = {
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      if (channel === "settings:import" || channel === "settings:restore" || channel === 'settings:working-profile') {
        const plan =
          channel === 'settings:working-profile' ? controller.planWorkingProfile(args[0] as InterfacePreferences, args[1]) : channel === "settings:import"
            ? controller.planImport(
                {
                  version: 2,
                  sections: [...TRANSFER_SECTIONS],
                  settings: { maxDownKbps: 777 },
                  interfacePreferences: incoming,
                },
                args[0] as InterfacePreferences,
                [...TRANSFER_SECTIONS],
              )
            : controller.planRestore(args[0] as InterfacePreferences, [
                ...TRANSFER_SECTIONS,
              ]);
        controller.begin(plan);
        if (concurrent) data.set("density", "compact");
        return { success: true, id: plan.id, preferences: plan.afterInterface };
      }
      if (channel === "settings:transfer:finish") {
        if (failFinish) {
          failFinish = false;
          throw new Error("cannot confirm");
        }
        controller.finish(args[0] as string, args[1] as InterfacePreferences);
        return { success: true };
      }
      if (channel === "settings:transfer:abort") {
        controller.abort(
          args[0] as string,
          args[1] as InterfacePreferences | undefined,
        );
        return { success: true };
      }
      return { success: false };
    },
    sendSync(channel: string, ...args: unknown[]) {
      if (channel === "settings:recovery:get")
        return controller.recoverMain() ?? {};
      controller.finishRecovery(
        args[0] as string,
        args[1] as InterfacePreferences,
      );
      return { success: true };
    },
  };
  return {
    storage,
    original,
    incoming,
    controller,
    bridge,
    client: createSettingsTransferClient(bridge, storage),
    get main() {
      return clone(main);
    },
    get record() {
      return clone(record);
    },
    set storageFailure(value: { key: string; once: boolean } | null) {
      failingKey = value?.key ?? null;
      failOnce = !!value?.once;
    },
    set concurrent(value: boolean) {
      concurrent = value;
    },
    set failFinish(value: boolean) {
      failFinish = value;
    },
  };
}

describe("preload settings transfer coordinator", () => {
  it("blocks export and recovery while an import awaits confirmation", async () => {
    const f = fixture(),
      invoke = f.bridge.invoke;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.bridge.invoke = async (channel, ...args) => {
      const result = await invoke(channel, ...args);
      if (channel === "settings:import") await gate;
      return result;
    };
    const pending = f.client.importSettings();
    await expect(f.client.exportSettings()).rejects.toThrow(
      "already in progress",
    );
    await expect(f.client.recoverSettingsTransfer()).rejects.toThrow(
      "already in progress",
    );
    release();
    await expect(pending).resolves.toEqual({ success: true });
  });
  it("confirms both main and UI stores, then restores both from the previous import", async () => {
    const f = fixture();
    expect(await f.client.importSettings()).toEqual({ success: true });
    expect(f.main.settings.maxDownKbps).toBe(777);
    expect(captureInterfacePreferences(f.storage)).toEqual(f.incoming);
    expect(f.controller.status().backupAt).not.toBeNull();
    expect(await f.client.restoreSettings()).toEqual({ success: true });
    expect(f.main.settings.maxDownKbps).toBe(10);
    expect(captureInterfacePreferences(f.storage)).toEqual(f.original);
    expect(f.storage.getItem("privateSearchToken")).toBe("local-only");
  });
  it("rolls back main and all changing UI keys if one localStorage write fails", async () => {
    const f = fixture();
    f.storageFailure = { key: "hotkeys", once: true };
    await expect(f.client.importSettings()).rejects.toThrow("storage quota");
    expect(f.main.settings.maxDownKbps).toBe(10);
    expect(captureInterfacePreferences(f.storage)).toEqual(f.original);
    expect(f.controller.status().recoveryNeeded).toBe(false);
  });
  it("keeps durable recovery data if UI restoration also fails, and completes it on a later retry", async () => {
    const f = fixture();
    // The target write fails at hotkeys; restoring the original theme fails too.
    let phase = 0;
    const originalSet = f.storage.setItem;
    f.storage.setItem = (key, value) => {
      if (key === "hotkeys" && !phase) {
        phase = 1;
        throw new Error("storage quota");
      }
      if (key === "theme" && phase === 1)
        throw new Error("storage still unavailable");
      originalSet(key, value);
    };
    await expect(f.client.importSettings()).rejects.toThrow(
      "storage still unavailable",
    );
    expect(f.main.settings.maxDownKbps).toBe(10);
    expect(f.controller.status().recoveryNeeded).toBe(true);
    phase = 2;
    await f.client.recoverSettingsTransfer();
    expect(captureInterfacePreferences(f.storage)).toEqual(f.original);
    expect(f.controller.status().recoveryNeeded).toBe(false);
  });
  it("recovers a simulated process stop before confirmation, before the next app reads preferences", async () => {
    const f = fixture();
    await f.bridge.invoke("settings:import", f.original);
    f.storage.setItem("theme", "light"); // The old preload stopped halfway through writing.
    const restarted = createSettingsTransferClient(f.bridge, f.storage);
    await restarted.recoverSettingsTransfer();
    expect(f.main.settings.maxDownKbps).toBe(10);
    expect(captureInterfacePreferences(f.storage)).toEqual(f.original);
  });
  it("does not overwrite a user preference changed while the preview was open", async () => {
    const f = fixture();
    f.concurrent = true;
    await expect(f.client.importSettings()).rejects.toThrow("changed during");
    expect(f.main.settings.maxDownKbps).toBe(10);
    expect(f.storage.getItem("density")).toBe("compact");
    expect(f.storage.getItem("theme")).toBe("dark");
    expect(f.controller.status().recoveryNeeded).toBe(false);
  });
  it("does not report success when final main confirmation fails", async () => {
    const f = fixture();
    f.failFinish = true;
    await expect(f.client.importSettings()).rejects.toThrow("cannot confirm");
    expect(f.main.settings.maxDownKbps).toBe(10);
    expect(captureInterfacePreferences(f.storage)).toEqual(f.original);
  });
});
