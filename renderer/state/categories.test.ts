import { describe, expect, it, vi } from "vitest";
import type { Category } from "../../shared/types";
import { createCategoriesState } from "./categories";

const category = (name: string): Category => ({
  id: "custom",
  name,
  icon: "folder",
  color: "#123456",
});
function fixture() {
  let signal!: () => void;
  const off = vi.fn(),
    getCategories = vi.fn(async () => [category("before")]);
  const onCategoriesChanged = vi.fn((callback: () => void) => {
    signal = callback;
    return off;
  });
  const model = createCategoriesState(() => ({
    getCategories,
    onCategoriesChanged,
  }));
  return {
    model,
    getCategories,
    onCategoriesChanged,
    off,
    changed: () => signal(),
  };
}

describe("shared category state", () => {
  it("updates already mounted consumers after import using one subscription and request", async () => {
    const f = fixture(),
      a = vi.fn(),
      b = vi.fn();
    const stopA = f.model.subscribe(a),
      stopB = f.model.subscribe(b);
    await f.model.refresh();
    expect(f.getCategories).toHaveBeenCalledTimes(1);
    expect(f.onCategoriesChanged).toHaveBeenCalledTimes(1);
    f.getCategories.mockResolvedValue([category("after")]);
    f.changed();
    await f.model.refresh();
    expect(f.model.getSnapshot()).toEqual([category("after")]);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
    stopA();
    expect(f.off).not.toHaveBeenCalled();
    stopB();
    expect(f.off).toHaveBeenCalledTimes(1);
  });

  it("ignores a pre-import response that arrives after the refreshed list", async () => {
    const f = fixture();
    let resolve!: (rows: Category[]) => void;
    f.getCategories.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const stop = f.model.subscribe(vi.fn()),
      pending = f.model.refresh();
    await Promise.resolve();
    f.getCategories.mockResolvedValue([category("after")]);
    f.changed();
    await f.model.refresh();
    resolve([category("before")]);
    await pending;
    expect(f.model.getSnapshot()).toEqual([category("after")]);
    stop();
  });

  it("keeps the last successful list on failure and retries after a later signal", async () => {
    const f = fixture(),
      stop = f.model.subscribe(vi.fn());
    await f.model.refresh();
    f.getCategories.mockRejectedValueOnce(new Error("unavailable"));
    f.changed();
    await expect(f.model.refresh()).rejects.toThrow("unavailable");
    expect(f.model.getSnapshot()).toEqual([category("before")]);
    f.getCategories.mockResolvedValue([category("recovered")]);
    f.changed();
    await f.model.refresh();
    expect(f.model.getSnapshot()).toEqual([category("recovered")]);
    stop();
  });

  it("refreshes on remount because changes can happen while no window component subscribes", async () => {
    const f = fixture(),
      stop = f.model.subscribe(vi.fn());
    await f.model.refresh();
    stop();
    f.getCategories.mockResolvedValue([category("while away")]);
    const nextStop = f.model.subscribe(vi.fn());
    await f.model.refresh();
    expect(f.model.getSnapshot()).toEqual([category("while away")]);
    expect(f.onCategoriesChanged).toHaveBeenCalledTimes(2);
    nextStop();
  });
});
