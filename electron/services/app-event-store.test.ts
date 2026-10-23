import { describe, expect, it, vi } from "vitest";
import { AppEventStore } from "./app-event-store";
import { AppEventSources, downloadErrorReason } from "./app-event-sources";
import { AppEventActions } from "./app-event-actions";
import {
  APP_EVENT_LIMIT,
  APP_EVENT_DAYS,
  APP_EVENT_PAGE_SIZE,
  validateEventQuery,
} from "../../shared/app-events";
import type { Download, RoomState } from "../../shared/types";

function fixture() {
  let data: unknown = null,
    now = 1_800_000_000_000;
  const io = {
    read: () => structuredClone(data),
    write: vi.fn((value) => {
      data = structuredClone(value);
    }),
  };
  const store = new AppEventStore(io, () => now);
  return {
    store,
    io,
    now: () => now,
    advance: (ms = 1) => {
      now += ms;
    },
    restart: () => new AppEventStore(io, () => now),
  };
}
describe("bounded durable app history", () => {
  it("survives a restart with independent read and problem state", () => {
    const f = fixture();
    f.store.record(
      "download-error",
      { kind: "download", id: "d1" },
      { reason: "permission" },
    );
    const id = f.store.list().items[0].id;
    f.store.read(id);
    expect(f.store.summary()).toMatchObject({ active: 1, unread: 0 });
    const restarted = f.restart();
    expect(restarted.summary()).toMatchObject({
      active: 1,
      unread: 0,
      total: 1,
    });
    restarted.resolve("download-error", { kind: "download", id: "d1" });
    expect(f.restart().summary()).toMatchObject({
      active: 0,
      unread: 0,
      total: 1,
    });
  });
  it("merges repetitions, reopens a recovered problem and marks a new occurrence unread", () => {
    const f = fixture(),
      object = { kind: "room" as const, id: "r1" };
    f.store.record("room-disconnected", object);
    const initial = f.store.list().items[0];
    f.store.read("all");
    f.store.resolve("room-disconnected", object);
    f.advance();
    f.store.record("room-disconnected", object);
    expect(f.store.list().items[0]).toMatchObject({
      id: initial.id,
      count: 2,
      firstAt: initial.firstAt,
      problem: "active",
      readAt: null,
      resolvedAt: null,
    });
  });
  it("caps storage at 1000 records and expires records after 30 days", () => {
    const f = fixture();
    for (let i = 0; i < APP_EVENT_LIMIT + 30; i++) {
      f.advance();
      f.store.record("download-complete", { kind: "download", id: "d" + i });
    }
    expect(f.store.summary().total).toBe(APP_EVENT_LIMIT);
    expect(f.restart().summary().total).toBe(APP_EVENT_LIMIT);
    f.advance((APP_EVENT_DAYS + 1) * 86400_000);
    expect(f.store.summary().total).toBe(0);
    expect(f.restart().summary().total).toBe(0);
  });
  it("pages equal timestamps without duplicates and supports unread/problems filters", () => {
    const f = fixture();
    for (let i = 0; i < 95; i++)
      f.store.record("download-error", { kind: "download", id: "d" + i });
    const first = f.store.list();
    expect(first.items).toHaveLength(APP_EVENT_PAGE_SIZE);
    const second = f.store.list({ cursor: first.next }),
      third = f.store.list({ cursor: second.next });
    expect(
      new Set(
        [...first.items, ...second.items, ...third.items].map((e) => e.id),
      ).size,
    ).toBe(95);
    expect(third.next).toBeNull();
    f.store.read(first.items[0].id);
    expect(f.store.list({ filter: "unread" }).summary.unread).toBe(94);
    f.store.resolve("download-error", { kind: "download", id: "d0" });
    expect(f.store.summary().active).toBe(94);
  });
  it("does not overwrite a locked or corrupt history and bounds session-only fallback", () => {
    const write = vi.fn(),
      store = new AppEventStore({
        read: () => {
          throw Error("locked");
        },
        write,
      });
    store.record("disk-low", { kind: "system" });
    expect(store.summary()).toMatchObject({
      storage: "unavailable",
      active: 1,
    });
    expect(write).not.toHaveBeenCalled();
  });
  it("reports a failed write, keeps the operation event in memory and retries persistence later", () => {
    const f = fixture();
    f.io.write.mockImplementationOnce(() => {
      throw Error("ENOSPC");
    });
    f.store.record("settings-exported", { kind: "system" });
    expect(f.store.summary()).toMatchObject({
      storage: "unavailable",
      total: 1,
    });
    f.store.record("settings-exported", { kind: "system" });
    expect(f.restart().list().items[0].count).toBe(2);
  });
  it("projects only permitted parameters and never saves raw exceptions, paths or names", () => {
    const f = fixture();
    f.store.record(
      "download-error",
      { kind: "download", id: "d1" },
      {
        reason: "unknown",
        paused: Infinity,
        ...{ error: "D:/private/secret.mkv", invite: "secret" },
      },
    );
    const raw = JSON.stringify(f.io.write.mock.calls);
    expect(raw).not.toContain("private");
    expect(raw).not.toContain("invite");
    expect(f.store.list().items[0].params).toEqual({ reason: "unknown" });
  });
  it("returns isolated copies and reconciles removed objects beyond the first page", () => {
    const f = fixture();
    for (let i = 0; i < 90; i++)
      f.store.record("download-error", { kind: "download", id: "d" + i });
    const page = f.store.list();
    page.items[0].problem = "resolved";
    expect(f.store.summary().active).toBe(90);
    f.store.reconcileObjects("download", new Set(["d1"]));
    expect(f.store.summary().active).toBe(1);
  });
  it("rejects invalid cursor/filter input and ignores unsupported object identities", () => {
    for (const input of [
      { cursor: false },
      { cursor: { id: "../secret", at: 1 } },
      { cursor: { id: "id", at: NaN } },
      { filter: "raw" },
      [],
    ])
      expect(() => validateEventQuery(input)).toThrow();
    const f = fixture();
    f.store.record("download-error", { kind: "download", id: "D:/secret" });
    expect(f.store.summary().total).toBe(0);
  });
});

describe("event adapters", () => {
  it("writes only on download error transitions and resolves only after recovery/removal", () => {
    const f = fixture(),
      source = new AppEventSources(f.store);
    for (let i = 0; i < 100; i++)
      source.download({
        id: "d1",
        status: "error",
        lastError: "ENOSPC: D:/secret/movie",
      });
    expect(f.io.write).toHaveBeenCalledTimes(1);
    expect(f.store.list().items[0].params.reason).toBe("disk-full");
    source.download({ id: "d1", status: "paused", lastError: null });
    expect(f.store.summary().active).toBe(1);
    source.download({ id: "d1", status: "downloading", lastError: null });
    expect(f.store.summary().active).toBe(0);
    source.download({ id: "d1", status: "error", lastError: "EACCES" });
    expect(f.store.list().items[0].count).toBe(2);
    source.removed("download", "d1");
    expect(f.store.summary().active).toBe(0);
  });
  it("does not inflate a persisted active error on startup and records completion", () => {
    const f = fixture();
    f.store.record("download-error", { kind: "download", id: "d1" });
    const source = new AppEventSources(f.restart());
    source.download({ id: "d1", status: "error", lastError: "unknown" });
    source.complete("d1");
    const page = f.restart().list();
    expect(page.items.find((e) => e.code === "download-error")).toMatchObject({
      count: 1,
      problem: "resolved",
    });
    expect(page.items.some((e) => e.code === "download-complete")).toBe(true);
  });
  it("records a lost established room, ignores an empty fresh room, and resolves reconnects", () => {
    const f = fixture(),
      source = new AppEventSources(f.store);
    const state = (identified: number, lastConnectedAt?: number) =>
      ({
        roomId: "r1",
        connection: {
          phase: identified ? "ready" : "waiting",
          channels: { identified },
          lastConnectedAt,
        },
      }) as Pick<RoomState, "roomId" | "connection">;
    source.room(state(0));
    expect(f.store.summary().total).toBe(0);
    source.room(state(1));
    source.room(state(0, 100));
    source.room(state(0, 100));
    expect(f.store.summary().active).toBe(1);
    source.room(state(1));
    expect(f.store.summary().active).toBe(0);
    source.room(state(0, 100));
    expect(f.store.list().items[0].count).toBe(2);
  });
  it("classifies common write errors without retaining their text", () => {
    expect(downloadErrorReason("read-only filesystem /private")).toBe(
      "permission",
    );
    expect(downloadErrorReason("no space left")).toBe("disk-full");
    expect(downloadErrorReason("tracker failed")).toBe("unknown");
  });
});

describe("event actions revalidate objects and serialize execution", () => {
  function actions() {
    const f = fixture();
    f.store.record("download-error", { kind: "download", id: "d1" });
    const deps = {
      getDownload: vi.fn(
        async () => ({ id: "d1", status: "error" }) as Download | null,
      ),
      getRoomIds: vi.fn(async () => ["r1"]),
      retry: vi.fn(async () => {}),
    };
    return {
      ...f,
      deps,
      actions: new AppEventActions(f.store, deps),
      id: f.store.list().items[0].id,
    };
  }
  it("blocks concurrent retry and waits for real source recovery to resolve", async () => {
    const f = actions();
    let finish!: () => void;
    f.deps.retry.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = f.actions.run(f.id, "retry");
    await Promise.resolve();
    expect(await f.actions.run(f.id, "retry")).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(f.deps.retry).toHaveBeenCalledTimes(1);
    finish();
    expect(await first).toEqual({ ok: true });
    expect(f.store.summary().active).toBe(1);
  });
  it("rejects removed objects and stale actions, and never calls arbitrary operations", async () => {
    const f = actions();
    f.deps.getDownload.mockResolvedValueOnce(null);
    expect(await f.actions.run(f.id, "open")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(f.store.summary().active).toBe(0);
    f.store.record("download-error", { kind: "download", id: "d1" });
    f.deps.getDownload.mockResolvedValueOnce({
      id: "d1",
      status: "downloading",
    } as Download);
    expect(await f.actions.run(f.id, "retry")).toEqual({
      ok: false,
      reason: "not-available",
    });
    expect(await f.actions.run(f.id, "delete-files")).toEqual({
      ok: false,
      reason: "not-available",
    });
    expect(f.deps.retry).not.toHaveBeenCalled();
  });
  it("returns addressable targets and marks the event read without resolving it", async () => {
    const f = actions();
    expect(await f.actions.run(f.id, "open")).toEqual({
      ok: true,
      target: { kind: "download", id: "d1" },
    });
    expect(f.store.summary()).toMatchObject({ active: 1, unread: 0 });
    f.store.record("room-disconnected", { kind: "room", id: "r1" });
    const room = f.store
      .list()
      .items.find((e) => e.code === "room-disconnected")!;
    f.deps.getRoomIds.mockResolvedValueOnce([]);
    expect(await f.actions.run(room.id, "open")).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});
