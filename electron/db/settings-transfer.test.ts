import { beforeEach, describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({
  stores: new Map<string, Record<string, unknown>>(),
  writes: [] as unknown[],
  fail: false,
}));
vi.mock("electron", () => ({ app: { getPath: () => "D:/isolated-test" } }));
vi.mock("./secrets", () => ({
  isEncryptionAvailable: () => true,
  encryptSecret: () => {
    throw new Error("Import must not re-encrypt existing secrets");
  },
  decryptSecret: () => {
    throw new Error("Transfer must not decrypt secrets");
  },
}));
vi.mock("electron-store", () => ({
  default: class {
    private name: string;
    constructor(options: { name?: string; defaults: Record<string, unknown> }) {
      this.name = options.name ?? "config";
      if (!storage.stores.has(this.name))
        storage.stores.set(this.name, structuredClone(options.defaults));
    }
    get store() {
      return structuredClone(storage.stores.get(this.name)!);
    }
    get(key: string) {
      return this.store[key];
    }
    set(key: string | Record<string, unknown>, value?: unknown) {
      if (storage.fail) throw new Error("disk full");
      const patch = typeof key === "string" ? { [key]: value } : key;
      storage.writes.push(structuredClone(patch));
      storage.stores.set(this.name, {
        ...this.store,
        ...structuredClone(patch),
      });
    }
    has(key: string) {
      return key in this.store;
    }
    delete(key: string) {
      const next = this.store;
      delete next[key];
      storage.stores.set(this.name, next);
    }
  },
}));
import { applySettingsImport, readSettingsImportState, store } from "./store";
import { createSettingsExport } from "../../shared/settings-transfer";

const initial = structuredClone(storage.stores.get("config")!);
const category = {
  id: "custom",
  name: "Своя категория",
  icon: "folder",
  color: "#123456",
};
beforeEach(() => {
  storage.fail = false;
  storage.stores.set("config", structuredClone(initial));
  storage.writes = [];
});

describe("atomic settings import", () => {
  it("restores exported categories and all config partitions in one write", () => {
    const source = readSettingsImportState();
    source.categories.push(category);
    source.settings.maxDownKbps = 500;
    source.scheduler = {
      enabled: true,
      schedules: [
        {
          id: "night",
          days: [0, 1],
          startTime: "23:00",
          endTime: "02:00",
          speedLimit: 12,
        },
      ],
    };
    source.privacyConfig.vpnKillSwitch = true;
    const bundle = createSettingsExport(source),
      before = readSettingsImportState();
    applySettingsImport(bundle, before);
    expect(storage.writes).toHaveLength(1);
    const after = readSettingsImportState();
    expect(after.categories).toContainEqual(category);
    expect(after.scheduler).toEqual(source.scheduler);
    expect(after.privacyConfig.vpnKillSwitch).toBe(true);
    expect(after.settings.maxDownKbps).toBe(500);
    expect(after.settings.updatedAt).not.toEqual(before.settings.updatedAt);
    expect(store.get("windowBounds")).toEqual(initial.windowBounds);
  });

  it("preserves ciphertext and the local remote-access token even in old backups containing secrets", () => {
    const raw = readSettingsImportState();
    storage.stores.set("config", {
      ...storage.stores.get("config"),
      settings: {
        ...raw.settings,
        proxyPassword: "enc:v1:original",
        customTurnCredential: "enc:v1:turn",
        webRemoteToken: "local",
      },
    });
    applySettingsImport(
      {
        version: 1,
        settings: {
          proxyPassword: "other",
          customTurnCredential: "other",
          webRemoteToken: "other",
        },
      },
      readSettingsImportState(),
    );
    expect(readSettingsImportState().settings).toMatchObject({
      proxyPassword: "enc:v1:original",
      customTurnCredential: "enc:v1:turn",
      webRemoteToken: "local",
    });
  });

  it("leaves every partition unchanged on validation or write failure", () => {
    const before = readSettingsImportState();
    expect(() =>
      applySettingsImport(
        {
          version: 1,
          settings: { maxDownKbps: 10 },
          categories: [category, category],
        },
        before,
      ),
    ).toThrow();
    expect(storage.writes).toEqual([]);
    expect(readSettingsImportState()).toEqual(before);
    storage.fail = true;
    expect(() =>
      applySettingsImport(
        { version: 1, settings: { maxDownKbps: 10 }, categories: [category] },
        before,
      ),
    ).toThrow("disk full");
    expect(storage.writes).toEqual([]);
    expect(readSettingsImportState()).toEqual(before);
  });

  it("refuses a stale preview instead of overwriting a concurrent change", () => {
    const preview = readSettingsImportState();
    store.set("categories", [...preview.categories, category]);
    storage.writes = [];
    expect(() =>
      applySettingsImport(
        { version: 1, settings: { maxDownKbps: 10 } },
        preview,
      ),
    ).toThrow("changed during");
    expect(storage.writes).toEqual([]);
    expect(readSettingsImportState().categories).toContainEqual(category);
  });
});
