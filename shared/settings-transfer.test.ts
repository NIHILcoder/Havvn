import { describe, expect, it } from "vitest";

it('accepts a portable resource preference but rejects live power state and unknown modes', () => {
  expect(validateSettingsTransfer({ version: 1, settings: { resourceMode: 'auto' } }).settings.resourceMode).toBe('auto');
  expect(() => validateSettingsTransfer({ version: 1, settings: { resourceMode: 'battery' } })).toThrow();
  expect(validateSettingsTransfer({ version: 1, settings: { power: 'battery' } }).settings).not.toHaveProperty('power');
});
import type { AppSettings, Category, PrivacyConfig } from "./types";
import {
  createSettingsExport,
  planSettingsImport,
  validateSettingsTransfer,
  SETTINGS_CATEGORY_LIMIT,
  type SettingsImportState,
} from "./settings-transfer";

const category = (id: string, name = id): Category => ({
  id,
  name,
  icon: "folder",
  color: "#123456",
});
function state(): SettingsImportState {
  return {
    settings: {
      id: 1,
      portMin: 6881,
      portMax: 6889,
      maxDownKbps: 0,
      proxyPassword: "enc:v1:proxy",
      customTurnCredential: "enc:v1:turn",
      webRemoteToken: "local-token",
      updatedAt: new Date(0),
    } as AppSettings,
    categories: [category("movies", "Old name"), category("local")],
    scheduler: { enabled: false, schedules: [] },
    privacyConfig: { vpnKillSwitch: true, vpnCheck: true } as PrivacyConfig,
  };
}

describe("settings transfer v1", () => {
  it("round-trips categories while preserving unrelated IDs, assignments and installation secrets", () => {
    const source = state();
    source.categories = [
      category("movies", "Фильмы"),
      category("new", "Новое"),
    ];
    const bundle = createSettingsExport(source),
      target = state();
    const { next, changes } = planSettingsImport(
      target,
      JSON.parse(JSON.stringify(bundle)),
    );
    expect(next.categories).toEqual([
      category("movies", "Фильмы"),
      category("local"),
      category("new", "Новое"),
    ]);
    expect(changes).toEqual([
      {
        before: category("movies", "Old name"),
        after: category("movies", "Фильмы"),
      },
      { after: category("new", "Новое") },
    ]);
    expect(next.settings.proxyPassword).toBe("enc:v1:proxy");
    expect(next.settings.customTurnCredential).toBe("enc:v1:turn");
    expect(next.settings.webRemoteToken).toBe("local-token");
    expect(target.categories[0].name).toBe("Old name");
    expect(planSettingsImport(next, bundle).changes).toEqual([]);
  });

  it("keeps equal names with different IDs distinct and does not delete categories for an empty list", () => {
    const target = state(),
      sameName = category("different-id", "Old name");
    expect(
      planSettingsImport(target, {
        version: 1,
        settings: {},
        categories: [sameName],
      }).next.categories,
    ).toEqual([...target.categories, sameName]);
    expect(
      planSettingsImport(target, { version: 1, settings: {}, categories: [] })
        .next.categories,
    ).toEqual(target.categories);
  });

  it("reads old full v1 exports but projects only portable known fields", () => {
    const legacy = {
      version: 1,
      settings: {
        ...state().settings,
        proxyPassword: "",
        customTurnCredential: "legacy-plaintext",
        webRemoteToken: "old-token",
        unknown: "ignored",
        maxDownKbps: 500,
      },
      extraSection: { roomSecret: "ignored" },
    };
    const bundle = validateSettingsTransfer(JSON.parse(JSON.stringify(legacy)));
    expect(bundle).toEqual({
      version: 1,
      settings: { portMin: 6881, portMax: 6889, maxDownKbps: 500 },
    });
    expect(
      planSettingsImport(state(), legacy).next.settings.proxyPassword,
    ).toBe("enc:v1:proxy");
    const output = JSON.stringify(createSettingsExport(state()));
    for (const privateValue of [
      "proxyPassword",
      "customTurnCredential",
      "webRemoteToken",
      "enc:v1:",
      "local-token",
    ])
      expect(output).not.toContain(privateValue);
  });

  it("preserves missing optional sections and merges partial privacy settings", () => {
    const target = state();
    const { next } = planSettingsImport(target, {
      version: 1,
      settings: { maxDownKbps: 42 },
      privacyConfig: { vpnCheck: false },
    });
    expect(next.settings.maxDownKbps).toBe(42);
    expect(next.scheduler).toEqual(target.scheduler);
    expect(next.privacyConfig).toEqual({
      vpnCheck: false,
      vpnKillSwitch: true,
    });
    expect(next.categories).toEqual(target.categories);
  });

  it.each([
    null,
    [],
    {},
    { version: "1", settings: {} },
    { version: 2, settings: {} },
    { version: 1, settings: [] },
    { version: 1, settings: { maxDownKbps: -1 } },
    { version: 1, settings: { autoLaunch: "true" } },
    { version: 1, settings: { engine: "unknown" } },
    { version: 1, settings: { defaultDownloadDir: "a\0b" } },
    { version: 1, settings: { roomResources: {} } },
    {
      version: 1,
      settings: {
        dohCustomTemplates: [{ id: "a", name: "A", url: "http://unsafe.test" }],
      },
    },
    {
      version: 1,
      settings: {},
      categories: [category("duplicate"), category("duplicate")],
    },
    { version: 1, settings: {}, categories: [category("__proto__")] },
    {
      version: 1,
      settings: {},
      categories: [{ ...category("a"), color: "url(https://example.test)" }],
    },
    {
      version: 1,
      settings: {},
      scheduler: {
        enabled: true,
        schedules: [
          { id: "a", days: [7], startTime: "00:00", endTime: "01:00" },
        ],
      },
    },
    {
      version: 1,
      settings: {},
      scheduler: {
        enabled: true,
        schedules: [
          { id: "a", days: [1], startTime: "24:00", endTime: "01:00" },
        ],
      },
    },
    { version: 1, settings: {}, privacyConfig: { vpnKillSwitch: 0 } },
  ])(
    "rejects an invalid or unsupported file before planning any write: %#",
    (input) => {
      expect(() => validateSettingsTransfer(input)).toThrow(
        "Invalid settings file",
      );
    },
  );

  it("rejects an inverted effective port range and excessive merged categories", () => {
    expect(() =>
      planSettingsImport(state(), { version: 1, settings: { portMin: 6990 } }),
    ).toThrow("port range");
    const full = {
      ...state(),
      categories: Array.from({ length: SETTINGS_CATEGORY_LIMIT }, (_, i) =>
        category(`cat-${i}`),
      ),
    };
    expect(() =>
      planSettingsImport(full, {
        version: 1,
        settings: {},
        categories: [category("extra")],
      }),
    ).toThrow("merged categories");
  });

  it("projects dangerous JSON keys without prototype mutation", () => {
    const parsed = JSON.parse(
      '{"version":1,"settings":{"__proto__":{"polluted":true},"constructor":{},"maxUpKbps":12}}',
    );
    expect(validateSettingsTransfer(parsed).settings).toEqual({
      maxUpKbps: 12,
    });
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});
