import { describe, expect, it } from "vitest";
import {
  compileDownloadView,
  DEFAULT_VIEW_CONFIG,
  validateDownloadViews,
  validateViewConfig,
  type DownloadView,
  type DownloadViewConditions,
} from "./download-views";
import type { Download } from "./types";
const view: DownloadView = {
  id: "v1",
  name: "Большие фильмы",
  pinned: true,
  ...DEFAULT_VIEW_CONFIG,
};
const download = {
  status: "downloading",
  category: "video.old",
  name: "Приём архива.mkv",
  savePath: "D:\\MEDIA\\Films",
  totalSize: 1024,
} as Download;
const conditions = (patch: Partial<DownloadViewConditions> = {}) => ({
  ...DEFAULT_VIEW_CONFIG.conditions,
  ...patch,
});
describe("portable download view schema", () => {
  it("round trips conditions, sort, mode, pin and active identity without downloads", () => {
    const config = validateViewConfig({
      ...DEFAULT_VIEW_CONFIG,
      conditions: conditions({
        category: "video.old",
        minBytes: 1,
        maxBytes: 2048,
        path: "media",
      }),
      sort: { by: "speed", direction: "asc" },
      mode: "detailed",
    });
    const result = validateDownloadViews(
      JSON.parse(
        JSON.stringify({
          version: 1,
          views: [{ ...view, ...config }],
          activeId: "v1",
        }),
      ),
    );
    expect(result.views[0]).toMatchObject({
      pinned: true,
      mode: "detailed",
      sort: { by: "speed", direction: "asc" },
      conditions: { category: "video.old", maxBytes: 2048 },
    });
    expect(JSON.stringify(result)).not.toContain("sourceUri");
  });
  it("rejects unknown versions, arbitrary predicates, stored download copies and dangling selection", () => {
    for (const input of [
      { version: 2, views: [], activeId: null },
      {
        version: 1,
        views: [{ ...view, downloads: [download] }],
        activeId: null,
      },
      { version: 1, views: [], activeId: "missing" },
      {
        version: 1,
        views: [{ ...view, conditions: { ...conditions(), script: "evil()" } }],
        activeId: null,
      },
    ])
      expect(() => validateDownloadViews(input)).toThrow();
  });
  it("bounds the catalog, IDs, names and duplicate normalized names", () => {
    expect(() =>
      validateDownloadViews({
        version: 1,
        views: [view, { ...view, id: "v2", name: "большие фильмы" }],
        activeId: null,
      }),
    ).toThrow();
    expect(() =>
      validateDownloadViews({
        version: 1,
        views: Array.from({ length: 65 }, (_, i) => ({
          ...view,
          id: "v" + i,
          name: "View " + i,
        })),
        activeId: null,
      }),
    ).toThrow();
    for (const name of ["", "x".repeat(81), "bad\nname"])
      expect(() =>
        validateDownloadViews({
          version: 1,
          views: [{ ...view, name }],
          activeId: null,
        }),
      ).toThrow();
  });
  it("validates numeric bounds and excludes unknown sizes when bounded", () => {
    for (const patch of [
      { minBytes: -1 },
      { minBytes: NaN },
      { maxBytes: Infinity },
      { minBytes: 0.1 },
      { minBytes: 2, maxBytes: 1 },
    ])
      expect(() =>
        validateViewConfig({
          ...DEFAULT_VIEW_CONFIG,
          conditions: conditions(patch),
        }),
      ).toThrow();
    const match = compileDownloadView(
      conditions({ minBytes: 1024, maxBytes: 1024 }),
    );
    expect(match(download)).toBe(true);
    expect(match({ ...download, totalSize: 0 })).toBe(false);
    expect(match({ ...download, totalSize: 1025 })).toBe(false);
  });
});
describe("live condition evaluation", () => {
  it("combines status, category, name, size and normalized path with AND", () => {
    const match = compileDownloadView(
      conditions({
        status: "downloading",
        category: "video.old",
        name: "ПРИЕМ",
        path: "d:/media",
        minBytes: 1000,
        maxBytes: 2000,
      }),
    );
    expect(match(download)).toBe(true);
    for (const patch of [
      { status: "paused" },
      { category: null },
      { name: "other" },
      { savePath: "C:/elsewhere" },
      { totalSize: 500 },
    ])
      expect(match({ ...download, ...patch } as Download)).toBe(false);
  });
  it("preserves existing active/completed status groups", () => {
    expect(
      compileDownloadView(conditions({ status: "downloading" }))({
        ...download,
        status: "queued",
      }),
    ).toBe(true);
    expect(
      compileDownloadView(conditions({ status: "completed" }))({
        ...download,
        status: "seeding",
      }),
    ).toBe(true);
    expect(
      compileDownloadView(conditions({ status: "paused" }))(download),
    ).toBe(false);
  });
  it("distinguishes all, uncategorized and missing category IDs without broadening a view", () => {
    expect(compileDownloadView(conditions())(download)).toBe(true);
    expect(compileDownloadView(conditions({ category: null }))(download)).toBe(
      false,
    );
    expect(
      compileDownloadView(conditions({ category: null }))({
        ...download,
        category: null,
      }),
    ).toBe(true);
    expect(
      compileDownloadView(conditions({ category: "removed-category" }))(
        download,
      ),
    ).toBe(false);
  });
  it("re-evaluates changed downloads instead of freezing membership", () => {
    const match = compileDownloadView(conditions({ status: "completed" }));
    expect([download].filter(match)).toHaveLength(0);
    expect(
      [{ ...download, status: "completed" as const }].filter(match),
    ).toHaveLength(1);
  });
  it("filters 1000 entries deterministically without reading stats or external data", () => {
    const list = Array.from({ length: 1000 }, (_, i) => ({
      ...download,
      id: String(i),
      totalSize: i + 1,
    }));
    const match = compileDownloadView(
      conditions({ minBytes: 100, maxBytes: 199 }),
    );
    expect(list.filter(match).map((d) => d.id)).toEqual(
      Array.from({ length: 100 }, (_, i) => String(99 + i)),
    );
  });
});
