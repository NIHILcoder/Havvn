import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppEventStore } from "../services/app-event-store";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  store: null as unknown,
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (id: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(id, handler),
  },
}));
vi.mock("../services/app-events", () => ({ getAppEvents: () => mocks.store }));
import { registerAppEventsIpc } from "./app-events";
describe("event history IPC boundary", () => {
  let store: AppEventStore,
    window: ReturnType<typeof fixture>["window"],
    trusted: ReturnType<typeof fixture>["trusted"];
  function fixture() {
    const frame = {},
      contents = { mainFrame: frame, send: vi.fn() },
      window = { isDestroyed: () => false, webContents: contents };
    return { window, trusted: { sender: contents, senderFrame: frame } };
  }
  beforeEach(() => {
    const f = fixture();
    window = f.window;
    trusted = f.trusted;
    store = new AppEventStore({ read: () => null, write: () => {} });
    mocks.store = store;
    mocks.handlers.clear();
    registerAppEventsIpc(() => window as never, {
      getDownload: async () => null,
      getRoomIds: async () => [],
      retry: async () => {},
    });
  });
  it("allows only the current main frame to read, acknowledge or execute", () => {
    for (const [channel, handler] of mocks.handlers) {
      expect(() =>
        handler({ sender: {}, senderFrame: trusted.senderFrame }, "all"),
      ).toThrow("Untrusted");
      expect(() => handler({ ...trusted, senderFrame: {} }, "all")).toThrow(
        "Untrusted",
      );
      expect(channel.startsWith("events:")).toBe(true);
    }
  });
  it("validates pagination and read arguments before mutation", () => {
    expect(() =>
      mocks.handlers.get("events:list")!(trusted, { filter: "unknown" }),
    ).toThrow();
    expect(() =>
      mocks.handlers.get("events:read")!(trusted, "../private"),
    ).toThrow();
    expect(store.summary().total).toBe(0);
  });
  it("pushes invalidation only, and reading does not clear active problems", () => {
    store.record("disk-low", { kind: "system" });
    expect(window.webContents.send).toHaveBeenCalledWith("events:changed");
    mocks.handlers.get("events:read")!(trusted, "all");
    expect(mocks.handlers.get("events:summary")!(trusted)).toMatchObject({
      active: 1,
      unread: 0,
    });
  });
});
