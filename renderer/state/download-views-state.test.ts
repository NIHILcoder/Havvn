import { describe, expect, it, vi } from "vitest";
import { createDownloadViewsState } from "./download-views-state";
import {
  DEFAULT_VIEW_CONFIG,
  DOWNLOAD_VIEWS_KEY,
  validateDownloadViews,
} from "../../shared/download-views";
function fixture() {
  const data = new Map<string, string>(),
    storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => {
        data.set(key, value);
      }),
    };
  let sequence = 0;
  return {
    data,
    storage,
    model: createDownloadViewsState(
      () => storage,
      () => `v${++sequence}`,
    ),
    restart: () =>
      createDownloadViewsState(
        () => storage,
        () => `v${++sequence}`,
      ),
  };
}
describe("saved view preference state", () => {
  it("restores saved conditions, pinning and selection after restart", () => {
    const f = fixture();
    f.model.save("Films", { ...DEFAULT_VIEW_CONFIG, mode: "detailed" }, true);
    expect(f.restart().getSnapshot().catalog).toMatchObject({
      activeId: "v1",
      views: [{ id: "v1", name: "Films", mode: "detailed", pinned: true }],
    });
  });
  it("renames and pins without reapplying the active draft; selection deliberately reapplies", () => {
    const f = fixture(),
      id = f.model.save("One", DEFAULT_VIEW_CONFIG, true),
      selection = f.model.getSnapshot().selection;
    f.model.rename(id, "Two");
    f.model.pin(id);
    expect(f.model.getSnapshot().selection).toBe(selection);
    f.model.select(id);
    expect(f.model.getSnapshot().selection).toBe(selection + 1);
    expect(f.model.getSnapshot().catalog.views[0]).toMatchObject({
      id,
      name: "Two",
      pinned: false,
    });
  });
  it("updates a saved configuration only on explicit save and deletes the preset alone", () => {
    const f = fixture(),
      id = f.model.save("One", DEFAULT_VIEW_CONFIG, true);
    f.model.save(
      "One",
      { ...DEFAULT_VIEW_CONFIG, sort: { by: "name", direction: "asc" } },
      false,
      id,
    );
    expect(f.model.getSnapshot().catalog.views).toHaveLength(1);
    f.model.remove(id);
    expect(f.model.getSnapshot().catalog).toEqual({
      version: 1,
      views: [],
      activeId: null,
    });
  });
  it("rejects duplicate names, missing identities and overflow", () => {
    const f = fixture();
    f.model.save("One", DEFAULT_VIEW_CONFIG, true);
    expect(() => f.model.save(" ONE ", DEFAULT_VIEW_CONFIG, false)).toThrow(
      "duplicate",
    );
    expect(() => f.model.select("missing")).toThrow("missing");
    for (let i = 1; i < 64; i++)
      f.model.save("View " + i, DEFAULT_VIEW_CONFIG, false);
    expect(() => f.model.save("Overflow", DEFAULT_VIEW_CONFIG, false)).toThrow(
      "limit",
    );
  });
  it("does not publish success or mutate the old catalog after storage failure", () => {
    const f = fixture();
    f.model.save("One", DEFAULT_VIEW_CONFIG, true);
    const before = f.model.getSnapshot(),
      changed = vi.fn();
    f.model.subscribe(changed);
    f.storage.setItem.mockImplementationOnce(() => {
      throw Error("quota");
    });
    expect(() => f.model.save("Two", DEFAULT_VIEW_CONFIG, false)).toThrow(
      "storage",
    );
    expect(f.model.getSnapshot()).toBe(before);
    expect(changed).not.toHaveBeenCalled();
  });
  it("preserves malformed storage instead of overwriting it with an empty list", () => {
    const f = fixture();
    f.data.set(DOWNLOAD_VIEWS_KEY, "corrupt");
    expect(f.model.getSnapshot().error).toBe(true);
    expect(() => f.model.save("One", DEFAULT_VIEW_CONFIG, true)).toThrow(
      "storage",
    );
    expect(f.data.get(DOWNLOAD_VIEWS_KEY)).toBe("corrupt");
  });
  it("refreshes an imported catalog and rejects payloads containing unrelated records", () => {
    const f = fixture();
    f.model.getSnapshot();
    f.data.set(
      DOWNLOAD_VIEWS_KEY,
      JSON.stringify({
        version: 1,
        views: [
          {
            ...DEFAULT_VIEW_CONFIG,
            id: "other",
            name: "Imported",
            pinned: true,
          },
        ],
        activeId: "other",
      }),
    );
    f.model.refresh();
    expect(f.model.getSnapshot().catalog.activeId).toBe("other");
    expect(() =>
      validateDownloadViews({
        ...f.model.getSnapshot().catalog,
        downloads: [],
      }),
    ).toThrow();
  });
});
