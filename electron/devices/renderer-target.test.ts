import { afterEach, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { dataPair } from "../../research/device-pairing/data-fixture";
import { DeviceReplicator } from "./replicator";
import { attachDeviceDataClient } from "../device-data-client";
const bus = vi.hoisted(() => {
  type Callback = (event: unknown, value: unknown) => void;
  const listeners = new Map<string, Set<Callback>>();
  return {
    listeners,
    on: (name: string, callback: Callback) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    removeListener: (name: string, callback: Callback) =>
      listeners.get(name)?.delete(callback),
    emit: (name: string, event: unknown, value: unknown) => {
      for (const listener of listeners.get(name) ?? []) listener(event, value);
    },
  };
});
vi.mock("electron", () => ({
  ipcMain: { on: bus.on, removeListener: bus.removeListener },
}));
import { attachDeviceRendererTarget } from "./renderer-target";
const clean: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close();
  bus.listeners.clear();
  vi.useRealTimers();
});
async function fixture() {
  const f = await dataPair();
  clean.push(f.close);
  await f.rb.close();
  let receiver: ((_event: unknown, value: unknown) => void) | undefined;
  const requests: unknown[] = [],
    replies: unknown[][] = [];
  const frame = {},
    contents = {
      mainFrame: frame,
      isDestroyed: () => false,
      send: (_name: string, value: unknown) => {
        requests.push(value);
        queueMicrotask(() => receiver?.({}, value));
      },
    };
  const event = (sender: unknown = contents, senderFrame: unknown = frame) => ({
    sender,
    senderFrame,
  });
  const bridge = {
    on: (_name: string, callback: typeof receiver) => {
      receiver = callback;
    },
    removeListener: () => {
      receiver = undefined;
    },
    send: (channel: string, value: unknown) =>
      bus.emit(channel, event(), value),
    sendSync: (channel: string, value: unknown) => {
      const assigned: unknown[] = [];
      let reply: unknown;
      const e = event();
      Object.defineProperty(e, "returnValue", {
        set: (value) => {
          assigned.push(value);
          if (assigned.length === 1) reply = value;
        },
      });
      bus.emit(channel, e, value);
      replies.push(assigned);
      return reply;
    },
  };
  const detach = attachDeviceDataClient(bridge, f.tb.storage);
  clean.push(detach);
  const target = attachDeviceRendererTarget(
    f.b,
    contents as unknown as WebContents,
    () => f.tb.context,
  );
  clean.push(target.close);
  const r = new DeviceReplicator(f.b, target);
  clean.push(() => r.close());
  f.ta.values.set("language", "ru");
  const op = await f.ra.publish("preferences", "language", "ru");
  return {
    ...f,
    r,
    target,
    requests,
    replies,
    event,
    contents,
    block: () => {
      receiver = undefined;
    },
    op,
  };
}
it("authorizes each localStorage write with exactly one synchronous reply from the trusted frame", async () => {
  const f = await fixture();
  expect((await f.r.receive(f.op))?.through).toBe(1);
  expect(f.tb.values.get("language")).toBe("ru");
  expect(f.replies.length).toBeGreaterThan(0);
  expect(
    f.replies.every((values) => values.length === 1 && values[0] === true),
  ).toBe(true);
});
it("does not accept a result from another webContents or a child frame", async () => {
  const f = await fixture();
  f.block();
  const planning = f.target.plan(f.op);
  const request = f.requests.at(-1) as { id: string };
  let finished = false;
  void planning.then(
    () => {
      finished = true;
    },
    () => {},
  );
  bus.emit("devices:data:result", f.event({}), {
    id: request.id,
    ok: true,
    value: {},
  });
  bus.emit("devices:data:result", f.event(f.contents, {}), {
    id: request.id,
    ok: true,
    value: {},
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  bus.emit("devices:data:result", f.event(), {
    id: request.id,
    ok: false,
    code: "stale",
  });
  await expect(planning).rejects.toThrow("stale");
});
it("denies an unknown lease without reading or mutating storage", async () => {
  const f = await fixture(),
    assigned: unknown[] = [];
  const event = f.event();
  Object.defineProperty(event, "returnValue", {
    set: (value) => assigned.push(value),
  });
  bus.emit("devices:data:authorize", event, {
    id: "unknown",
    heads: "0".repeat(64),
    kind: "apply",
  });
  expect(assigned).toEqual([false]);
  expect(f.tb.writes()).toBe(0);
});
it("cancels bounded renderer requests and removes IPC listeners on close", async () => {
  const f = await fixture();
  f.block();
  const request = f.target.plan(f.op),
    rejected = expect(request).rejects.toThrow("state");
  f.target.close();
  await rejected;
  expect(bus.listeners.get("devices:data:authorize")?.size).toBe(0);
  await expect(f.target.plan(f.op)).rejects.toThrow("state");
});
it("keeps a timed-out renderer application unacknowledged", async () => {
  const f = await fixture();
  f.block();
  vi.useFakeTimers();
  const request = f.target.plan(f.op),
    rejected = expect(request).rejects.toThrow("storage");
  await vi.advanceTimersByTimeAsync(10001);
  await rejected;
  expect(f.b.replicaState().inbox.preferences.floor).toBe(0);
  expect(f.a.snapshot().outbox).toBe(1);
});
