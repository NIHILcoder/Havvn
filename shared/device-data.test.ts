import { expect, it } from "vitest";
import { validateDeviceValue, exportDeviceView } from "./device-data";
import { DEFAULT_VIEW_CONFIG } from "./download-views";
it("only accepts the eight canonical portable preferences and rejects coercion/default substitution", () => {
  for (const [key, value] of [
    ["language", "ru"],
    ["uiScale", "125"],
    ["density", "compact"],
    ["reduceMotion", "1"],
    ["speedUnits", "bits"],
    ["audioLanguage", "ru"],
    ["subtitleLanguage", ""],
    ["subtitleMode", "auto"],
  ])
    expect(validateDeviceValue("preferences", key, value)).toBe(value);
  for (const [key, value] of [
    ["theme", "dark"],
    ["proxyPassword", "password"],
    ["language", "de"],
    ["uiScale", 100],
    ["reduceMotion", true],
    ["audioLanguage", "RUS"],
    ["subtitleLanguage", "garbage!"],
    ["subtitleMode", "yes"],
  ])
    expect(() =>
      validateDeviceValue("preferences", key as string, value),
    ).toThrow();
});
it("refuses extra fields, local paths and an inconsistent portable view identity", () => {
  const id = "1".repeat(32),
    value = {
      version: 1,
      syncViewId: id,
      name: "Name",
      pinned: true,
      ...DEFAULT_VIEW_CONFIG,
    };
  expect(validateDeviceValue("views", "view." + id, value)).toEqual(value);
  for (const v of [
    { ...value, extra: "x" },
    { ...value, syncViewId: "2".repeat(32) },
    { ...value, conditions: { ...value.conditions, path: "C:/private" } },
    { ...value, name: " Name " },
  ])
    expect(() => validateDeviceValue("views", "view." + id, v)).toThrow();
  expect(
    exportDeviceView(
      {
        id: "local",
        name: "Local",
        pinned: false,
        ...DEFAULT_VIEW_CONFIG,
        conditions: { ...DEFAULT_VIEW_CONFIG.conditions, path: "private" },
      },
      id,
    ),
  ).toEqual({ value: null, issue: "path-filter" });
});
it("bounds stable view order and refuses duplicate IDs", () => {
  expect(
    validateDeviceValue("views", "order", {
      version: 1,
      ids: ["1".repeat(32)],
    }),
  ).toEqual({ version: 1, ids: ["1".repeat(32)] });
  expect(() =>
    validateDeviceValue("views", "order", {
      version: 1,
      ids: ["1".repeat(32), "1".repeat(32)],
    }),
  ).toThrow();
});
it("requires a portable unambiguous media selector and exact position values", () => {
  const id = "media." + "1".repeat(64),
    v = {
      version: 1,
      infoHash: "a".repeat(40),
      path: "Series/E01.mkv",
      size: 100,
      position: 1,
      duration: 10,
      completed: false,
    };
  expect(validateDeviceValue("playback", id, v)).toEqual(v);
  for (const patch of [
    { path: "../secret" },
    { path: "C:/secret" },
    { path: "/file" },
    { path: "a\\b" },
    { path: "a/./b" },
    { size: -1 },
    { infoHash: "download-id" },
    { position: 11 },
    { duration: 0 },
    { completed: "true" },
    { downloadId: "remote" },
  ])
    expect(() =>
      validateDeviceValue("playback", id, { ...v, ...patch }),
    ).toThrow();
  expect(validateDeviceValue("playback", id, null, true)).toBeNull();
  expect(() => validateDeviceValue("playback", id, v, true)).toThrow();
});
