import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultHotkeys,
  loadHotkeys,
  matchHotkey,
  rebindHotkey,
} from "./hotkeys";

afterEach(() => vi.unstubAllGlobals());
function storage(value: unknown) {
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(value) });
}
describe("command shortcut migration and conflicts", () => {
  it("adds Ctrl+K for existing users without changing their bindings", () => {
    storage([{ id: "open-settings", keys: ["Alt", "KeyS"] }]);
    const hotkeys = loadHotkeys();
    expect(hotkeys.find((h) => h.id === "open-command-palette")?.keys).toEqual([
      "Ctrl",
      "KeyK",
    ]);
    expect(hotkeys.find((h) => h.id === "open-settings")?.keys).toEqual([
      "Alt",
      "KeyS",
    ]);
  });
  it("leaves Ctrl+K with the user action that already owns it", () => {
    storage([{ id: "add-torrent", keys: ["Ctrl", "KeyK"] }]);
    expect(
      loadHotkeys().find((h) => h.id === "open-command-palette")?.keys,
    ).toEqual([]);
    expect(loadHotkeys().find((h) => h.id === "add-torrent")?.keys).toEqual([
      "Ctrl",
      "KeyK",
    ]);
  });
  it("preserves a disabled or customized palette binding", () => {
    for (const keys of [[], ["Alt", "KeyP"]]) {
      storage([{ id: "open-command-palette", keys }]);
      expect(
        loadHotkeys().find((h) => h.id === "open-command-palette")?.keys,
      ).toEqual(keys);
    }
  });
  it("moves a binding to the edited action and never mutates defaults", () => {
    const hotkeys = rebindHotkey(defaultHotkeys, "open-settings", [
      "Ctrl",
      "KeyK",
    ]);
    expect(hotkeys.find((h) => h.id === "open-command-palette")?.keys).toEqual(
      [],
    );
    expect(
      defaultHotkeys.find((h) => h.id === "open-command-palette")?.keys,
    ).toEqual(["Ctrl", "KeyK"]);
  });
  it("drops unknown IDs and de-duplicates malformed conflicting saved bindings", () => {
    storage([
      { id: "unknown", keys: ["Ctrl", "KeyK"] },
      { id: "open-settings", keys: ["Alt", "KeyS"] },
      { id: "add-torrent", keys: ["Alt", "KeyS"] },
    ]);
    const keys = loadHotkeys()
      .filter((h) => h.keys.length)
      .map((h) => h.keys.join("+"));
    expect(new Set(keys).size).toBe(keys.length);
    expect(
      loadHotkeys().find((h) => h.id === "open-command-palette")?.keys,
    ).toEqual(["Ctrl", "KeyK"]);
  });
  it("matches physical keys and requires exact modifiers", () => {
    const event = {
      code: "KeyK",
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    };
    expect(matchHotkey(defaultHotkeys, event)?.id).toBe("open-command-palette");
    expect(
      matchHotkey(defaultHotkeys, { ...event, shiftKey: true }),
    ).toBeUndefined();
  });
});
