import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "./appearance";
import { DOWNLOAD_VIEWS_KEY, DEFAULT_VIEW_CONFIG } from "./download-views";
import { NAVIGATION_KEY, defaultNavigation } from './navigation';
import {
  INTERFACE_KEYS,
  captureInterfacePreferences,
  selectInterfacePreferences,
  transferSections,
  validateInterfacePreferences,
  writeInterfacePreferences,
} from "./interface-preferences";

function storage(entries: Record<string, string> = {}) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
const image = "data:image/png;base64,iVBORw0KGgo=";
describe("saved view transfer compatibility", () => {
  const views = JSON.stringify({
    version: 1,
    views: [{ ...DEFAULT_VIEW_CONFIG, id: "v1", name: "Films", pinned: true }],
    activeId: "v1",
  });
  it("transfers saved views with layout and preserves them when another section is selected", () => {
    const before = captureInterfacePreferences(storage()),
      incoming = captureInterfacePreferences(
        storage({ [DOWNLOAD_VIEWS_KEY]: views }),
      );
    expect(
      selectInterfacePreferences(before, incoming, ["layout"]).values[
        DOWNLOAD_VIEWS_KEY
      ],
    ).toBe(views);
    expect(
      selectInterfacePreferences(before, incoming, ["hotkeys"]).values[
        DOWNLOAD_VIEWS_KEY
      ],
    ).toBeNull();
  });
  it("accepts older snapshots without views and does not erase the current catalog", () => {
    const current = storage({ [DOWNLOAD_VIEWS_KEY]: views }),
      before = captureInterfacePreferences(current),
      legacy = structuredClone(captureInterfacePreferences(storage()));
    delete (legacy.values as Partial<typeof legacy.values>)[DOWNLOAD_VIEWS_KEY];
    const checked = validateInterfacePreferences(legacy);
    expect(Object.hasOwn(checked.values, DOWNLOAD_VIEWS_KEY)).toBe(false);
    expect(
      selectInterfacePreferences(before, checked, ["layout"]).values[
        DOWNLOAD_VIEWS_KEY
      ],
    ).toBe(views);
    writeInterfacePreferences(current, checked);
    expect(current.getItem(DOWNLOAD_VIEWS_KEY)).toBe(views);
  });
  it("treats explicit null as a complete snapshot reset and rejects invalid view schemas", () => {
    const before = captureInterfacePreferences(
        storage({ [DOWNLOAD_VIEWS_KEY]: views }),
      ),
      incoming = captureInterfacePreferences(storage());
    expect(
      selectInterfacePreferences(before, incoming, ["layout"]).values[
        DOWNLOAD_VIEWS_KEY
      ],
    ).toBeNull();
    expect(() =>
      captureInterfacePreferences(
        storage({
          [DOWNLOAD_VIEWS_KEY]: JSON.stringify({ version: 3, views: [] }),
        }),
      ),
    ).toThrow();
  });
});
describe('portable navigation preferences', () => {
  const navigation = JSON.stringify({ ...defaultNavigation(), showHistory: false, favorites: [{ kind: 'room', id: 'r1' }] });
  it('imports navigation only with layout and keeps it when an old snapshot omits the key', () => {
    const target = storage({ [NAVIGATION_KEY]: navigation }), before = captureInterfacePreferences(target);
    const incoming = captureInterfacePreferences(storage());
    expect(selectInterfacePreferences(before, incoming, ['hotkeys']).values[NAVIGATION_KEY]).toBe(navigation);
    expect(selectInterfacePreferences(before, incoming, ['layout']).values[NAVIGATION_KEY]).toBeNull();
    delete incoming.values[NAVIGATION_KEY];
    const legacy = validateInterfacePreferences(incoming);
    expect(selectInterfacePreferences(before, legacy, ['layout']).values[NAVIGATION_KEY]).toBe(navigation);
    writeInterfacePreferences(target, legacy);
    expect(target.getItem(NAVIGATION_KEY)).toBe(navigation);
  });
  it('round-trips references without embedding names and applies explicit resets', () => {
    const target = storage(), source = captureInterfacePreferences(storage({ [NAVIGATION_KEY]: navigation }));
    writeInterfacePreferences(target, source);
    expect(target.getItem(NAVIGATION_KEY)).toBe(navigation);
    writeInterfacePreferences(target, captureInterfacePreferences(storage()));
    expect(target.getItem(NAVIGATION_KEY)).toBeNull();
    expect(() => captureInterfacePreferences(storage({ [NAVIGATION_KEY]: JSON.stringify({ ...defaultNavigation(), favorites: [{ kind: 'command', id: 'javascript:alert(1)' }] }) }))).toThrow();
    expect(() => captureInterfacePreferences(storage({ [NAVIGATION_KEY]: ' '.repeat(65537) + navigation }))).toThrow();
  });
});
function rich() {
  return storage({
    theme: "light",
    accentColor: "#123456",
    fontChoice: "inter",
    "havvn.theme.library": JSON.stringify([
      { id: "my-theme", name: "Моя тема", dark: {}, light: {} },
    ]),
    "havvn.theme.active": "my-theme",
    "havvn.appearance.v1": JSON.stringify({
      ...DEFAULT_APPEARANCE,
      background: "image",
    }),
    "havvn.appearance.wallpaper.v1": image,
    hotkeys: JSON.stringify([{ id: "open-settings", keys: ["Ctrl", "KeyK"] }]),
    roomLayout: JSON.stringify({ railW: 300, chatW: 400 }),
    density: "compact",
    reduceMotion: "1",
    uiScale: "125",
    startPage: "rooms",
    speedUnits: "si",
    language: "ru",
    privateSearchToken: "must-stay-local",
  });
}
describe("portable interface preferences", () => {
  it("round-trips the exact allowed values, including themes and a split wallpaper, without copying other storage", () => {
    const source = rich(),
      target = storage({ theme: "dark", privateSearchToken: "target-token" });
    const snapshot = captureInterfacePreferences(source);
    writeInterfacePreferences(target, snapshot);
    expect(captureInterfacePreferences(target)).toEqual(snapshot);
    expect(target.getItem("privateSearchToken")).toBe("target-token");
    expect(JSON.stringify(snapshot)).not.toContain("must-stay-local");
    expect(Object.keys(snapshot.values)).toEqual([...INTERFACE_KEYS]);
  });
  it("changes only selected sections and supports restoring absent values", () => {
    const before = captureInterfacePreferences(
      storage({ theme: "dark", hotkeys: "[]" }),
    );
    const after = selectInterfacePreferences(
      before,
      captureInterfacePreferences(rich()),
      ["hotkeys"],
    );
    expect(after.values.theme).toBe("dark");
    expect(after.values.roomLayout).toBeNull();
    expect(after.values.hotkeys).toContain("KeyK");
    const target = rich();
    writeInterfacePreferences(target, before);
    expect(target.getItem("havvn.theme.library")).toBeNull();
    expect(target.getItem("havvn.appearance.wallpaper.v1")).toBeNull();
  });
  it.each([
    { language: "unsupported" },
    { uiScale: "9000" },
    { roomLayout: "{invalid" },
    { roomLayout: '{"railW":10,"chatW":300}' },
    { hotkeys: '[{"id":"open-settings","keys":["Ctrl","Ctrl"]}]' },
    { hotkeys: '[{"id":"a","keys":[]},{"id":"a","keys":[]}]' },
    {
      "havvn.theme.library":
        '[{"id":"a","name":"A","dark":{"--color-logo":"url(https://example.test)"},"light":{}}]',
    },
    { "havvn.theme.active": "missing" },
    { "havvn.appearance.wallpaper.v1": "https://example.test/wallpaper.png" },
    { "havvn.appearance.profiles.v1": "[{}]" },
  ])("rejects malformed or unsafe stored preferences: %#", (entries) => {
    expect(() => captureInterfacePreferences(storage(entries))).toThrow(
      "Invalid interface preferences",
    );
  });
  it("rejects extra keys, missing keys and unsupported section masks", () => {
    const valid = captureInterfacePreferences(storage());
    expect(() =>
      validateInterfacePreferences({
        ...valid,
        values: { ...valid.values, roomSecret: "hidden" },
      }),
    ).toThrow();
    expect(() =>
      validateInterfacePreferences({ version: 1, values: {} }),
    ).toThrow();
    for (const sections of [[], ["hotkeys", "hotkeys"], ["unknown"]])
      expect(() => transferSections({ sections: sections as never })).toThrow();
  });
});
