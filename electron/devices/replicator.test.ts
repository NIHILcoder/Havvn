import { afterEach, expect, it } from "vitest";
import {
  dataPair,
  targetFixture,
} from "../../research/device-pairing/data-fixture";
import { DeviceVault } from "./vault";
import { DeviceReplicator } from "./replicator";
import { replicaKey, replicaHeads } from "./replica-state";
import {
  DOWNLOAD_VIEWS_KEY,
  DEFAULT_VIEW_CONFIG,
} from "../../shared/download-views";
import {
  bindDeviceView,
  DEVICE_TARGET_META,
} from "../../shared/device-data-target";
import { DEVICE_WATCH_STORAGE } from "../../shared/device-data";
import { watchKey } from "../../shared/watch-history";
const clean: Array<() => Promise<void>> = [];
it('applies a reviewed conflict choice atomically and rejects an obsolete preview', async () => {
  const f = await fixture(), a = await language(f);
  f.tb.values.set('language', 'en');
  await f.rb.publish('preferences', 'language', 'en');
  await f.rb.receive(a);
  const heads = replicaHeads(f.b.replicaState().records['preferences/language'].heads);
  const draft = f.b.buildDataOperation('preferences', 'language', 'ru');
  const plan = await f.tb.target.plan(draft);
  f.tb.values.set('language', 'ru');
  await expect(f.rb.resolve('preferences', 'language', 'ru', false, heads, plan.beforeStamp)).rejects.toThrow('stale');
  f.tb.values.set('language', 'en');
  const resolved = await f.rb.resolve('preferences', 'language', 'ru', false, heads, plan.beforeStamp);
  expect(f.tb.values.get('language')).toBe('ru');
  expect(f.b.pendingDataJob()).toBeNull();
  expect(f.b.replicaState().records['preferences/language'].heads).toEqual([resolved]);
  expect(f.b.replicaState().inbox.preferences.floor).toBe(1);
  await expect(f.rb.resolve('preferences', 'language', 'en', false, heads, plan.beforeStamp)).rejects.toThrow('stale');
});
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await dataPair();
  clean.push(f.close);
  return f;
}
async function language(f: Awaited<ReturnType<typeof dataPair>>, value = "ru") {
  f.ta.values.set("language", value);
  return f.ra.publish("preferences", "language", value);
}
function view(id = "1".repeat(32)) {
  return {
    version: 1,
    syncViewId: id,
    name: "First",
    pinned: true,
    ...DEFAULT_VIEW_CONFIG,
  };
}
async function addView(f: Awaited<ReturnType<typeof dataPair>>, v = view()) {
  const { version: _version, syncViewId, ...fields } = v;
  void _version;
  f.ta.values.set(
    DOWNLOAD_VIEWS_KEY,
    JSON.stringify({
      version: 1,
      views: [{ id: "local-view", ...fields }],
      activeId: "local-view",
    }),
  );
  if (typeof v.conditions.category === "string") {
    f.ta.context.categories[v.conditions.category] = v.conditions.category;
    f.ta.context.categoryIds.push(v.conditions.category);
  }
  bindDeviceView(f.ta.storage, "local-view", syncViewId, () => {});
  return f.ra.publish("views", "view." + syncViewId, v);
}
function setWatch(target: ReturnType<typeof targetFixture>, position: number) {
  const file = target.context.media[0],
    key = watchKey(file);
  target.values.set(
    DEVICE_WATCH_STORAGE,
    JSON.stringify({
      version: 1,
      epoch: 0,
      entries: {
        [key]: {
          identity: file.identity,
          downloadId: file.downloadId,
          title: file.title,
          path: file.path,
          fileIndex: file.fileIndex,
          position,
          duration: 100,
          completed: false,
          lastOpened: 1,
          updatedAt: 2,
        },
      },
      revisions: {},
      serials: {},
      pending: {},
      migrated: true,
    }),
  );
}
it("commits counter/outbox/register together and ACKs only after target readback and journal completion", async () => {
  const f = await fixture(),
    op = await language(f);
  expect(f.a.snapshot().outbox).toBe(1);
  const ack = await f.rb.receive(op);
  expect(f.tb.values.get("language")).toBe("ru");
  expect(ack?.through).toBe(1);
  expect(f.b.pendingDataJob()).toBeNull();
  await f.a.acknowledge(ack!);
  expect(f.a.snapshot().outbox).toBe(0);
  const writes = f.tb.writes(),
    revision = f.b.snapshot().revision;
  await f.rb.receive(op);
  expect(f.tb.writes()).toBe(writes);
  expect(f.b.snapshot().revision).toBe(revision);
});
it("does not publish a remote value or pretend a local edit exists when storage differs", async () => {
  const f = await fixture();
  await expect(f.ra.publish("preferences", "language", "ru")).rejects.toThrow(
    "stale",
  );
  expect(f.a.snapshot().outbox).toBe(0);
  const op = await language(f);
  await f.rb.receive(op);
  expect(f.b.snapshot().outbox).toBe(0);
});
it("retains a failed write without ACK and resumes the exact journal after main restart", async () => {
  const f = await fixture(),
    op = await language(f);
  f.tb.faults.after = 0;
  await expect(f.rb.receive(op)).rejects.toThrow();
  expect(f.b.replicaState().inbox.preferences.floor).toBe(0);
  expect(f.b.pendingDataJob()).toBeTruthy();
  await f.rb.close();
  await f.b.close();
  const b = DeviceVault.open(f.sb.io()),
    target = targetFixture(b);
  target.values.set("language", "ru");
  const r = new DeviceReplicator(b, target.target);
  clean.push(async () => {
    await r.close();
    await b.close();
  });
  await r.recover();
  expect(target.writes()).toBe(0);
  expect((await r.receive(op))?.through).toBe(1);
});
it("detects a silent storage failure and keeps the journal/outbox for retry", async () => {
  const f = await fixture(),
    op = await language(f);
  f.tb.faults.silent = true;
  await expect(f.rb.receive(op)).rejects.toThrow("storage");
  expect(f.a.snapshot().outbox).toBe(1);
  expect(f.b.replicaState().inbox.preferences.floor).toBe(0);
  f.tb.faults.silent = false;
  await f.rb.recover();
  expect((await f.rb.receive(op))?.through).toBe(1);
});
it("does not ACK when committing main after target success fails", async () => {
  const f = await fixture(),
    op = await language(f),
    original = f.tb.target.apply;
  f.tb.target.apply = async (job) => {
    await original(job);
    f.sb.faults.beforeWrite = true;
  };
  await expect(f.rb.receive(op)).rejects.toThrow("storage");
  expect(f.tb.values.get("language")).toBe("ru");
  expect(f.a.snapshot().outbox).toBe(1);
  expect(f.b.snapshot().status).toBe("paused-error");
});
it("preserves an unsent local value until an exact preview is explicitly approved", async () => {
  const f = await fixture(),
    op = await language(f);
  f.tb.values.set("language", "en");
  expect(await f.rb.receive(op)).toBeNull();
  expect(f.tb.values.get("language")).toBe("en");
  const preview = await f.rb.preview("preferences", "language");
  expect(preview.plan?.beforeStamp).toBe('"en"');
  expect(
    (
      await f.rb.retry("preferences", "language", {
        heads: preview.heads,
        beforeStamp: preview.plan!.beforeStamp,
      })
    )?.through,
  ).toBe(1);
  expect(f.tb.values.get("language")).toBe("ru");
});
it("does not allow a stale overwrite approval to cover a newer local edit", async () => {
  const f = await fixture(),
    op = await language(f);
  f.tb.values.set("language", "en");
  await f.rb.receive(op);
  const preview = await f.rb.preview("preferences", "language");
  f.tb.values.set("language", "ru");
  f.tb.values.set("language", "en-local-invalid");
  expect(
    await f.rb.retry("preferences", "language", {
      heads: preview.heads,
      beforeStamp: preview.plan!.beforeStamp,
    }),
  ).toBeNull();
  expect(f.tb.values.get("language")).toBe("en-local-invalid");
});
it("stores simultaneous edits as two heads and resolves causally without a clock winner", async () => {
  const f = await fixture(),
    a = await language(f),
    before = Date.now();
  f.tb.values.set("language", "en");
  const b = await f.rb.publish("preferences", "language", "en");
  expect(await f.rb.receive(a)).toBeNull();
  expect(await f.ra.receive(b)).toBeNull();
  expect(f.b.replicaState().records["preferences/language"].heads).toHaveLength(
    2,
  );
  expect(f.tb.values.get("language")).toBe("en");
  f.tb.values.set("language", "ru");
  const resolved = await f.rb.publish("preferences", "language", "ru");
  expect(resolved.context[a.from]).toBe(1);
  expect(resolved.context[b.from]).toBe(1);
  await f.ra.receive(resolved);
  expect(f.a.replicaState().records["preferences/language"].heads).toHaveLength(
    1,
  );
  expect(Date.now()).toBeGreaterThanOrEqual(before);
});
it("applies reordered operations but never ACKs over a sequence gap", async () => {
  const f = await fixture(),
    one = await language(f);
  f.ta.values.set("density", "compact");
  const two = await f.ra.publish("preferences", "density", "compact");
  expect(await f.rb.receive(two)).toBeNull();
  expect(f.tb.values.get("density")).toBe("compact");
  expect((await f.rb.receive(one))?.through).toBe(2);
});
it("rejects equivocation, unissued local context and the receive window overflow", async () => {
  const f = await fixture(),
    one = await language(f);
  f.ta.values.set("density", "compact");
  const two = await f.ra.publish("preferences", "density", "compact");
  await f.rb.receive(two);
  await expect(f.rb.receive({ ...two, value: "normal" })).rejects.toThrow(
    "stale",
  );
  await expect(
    f.rb.receive({ ...one, context: { [one.to]: 1 } }),
  ).rejects.toThrow("peer");
  await expect(f.rb.receive({ ...one, sequence: 65 })).rejects.toThrow("quota");
});
it("does not widen a nonportable view or guess a foreign category", async () => {
  const f = await fixture(),
    v = {
      ...view(),
      conditions: { ...view().conditions, category: "source-category" },
    },
    op = await addView(f, v);
  expect(await f.rb.receive(op)).toBeNull();
  expect(f.tb.values.has(DOWNLOAD_VIEWS_KEY)).toBe(false);
  f.tb.context.categories["source-category"] = "local-category";
  f.tb.context.categoryIds = ["local-category"];
  expect((await f.rb.retry("views", op.recordId))?.through).toBe(1);
  const saved = JSON.parse(f.tb.values.get(DOWNLOAD_VIEWS_KEY)!);
  expect(saved.views[0].conditions.category).toBe("local-category");
  expect(saved.activeId).toBeNull();
});
it("keeps view identity through reorder and deletion and recovers a partial two-key commit", async () => {
  const f = await fixture(),
    op = await addView(f);
  f.tb.faults.after = 1;
  await expect(f.rb.receive(op)).rejects.toThrow();
  expect(f.tb.values.has(DOWNLOAD_VIEWS_KEY)).toBe(true);
  expect(f.tb.values.has(DEVICE_TARGET_META)).toBe(false);
  f.tb.faults.after = Infinity;
  await f.rb.recover();
  expect((await f.rb.receive(op))?.through).toBe(1);
  const id = JSON.parse(f.tb.values.get(DEVICE_TARGET_META)!).views[
    view().syncViewId
  ];
  expect(JSON.parse(f.tb.values.get(DOWNLOAD_VIEWS_KEY)!).views[0].id).toBe(id);
  f.ta.values.set(
    DOWNLOAD_VIEWS_KEY,
    JSON.stringify({ version: 1, views: [], activeId: null }),
  );
  const deletion = await f.ra.publish("views", op.recordId, null, true);
  await f.rb.receive(deletion);
  expect(JSON.parse(f.tb.values.get(DOWNLOAD_VIEWS_KEY)!).views).toHaveLength(
    0,
  );
});
it("defers playback for missing/ambiguous/playing files and uses only the exact local target", async () => {
  const f = await fixture();
  setWatch(f.ta, 40);
  const value = {
      version: 1,
      ...f.ta.media,
      position: 40,
      duration: 100,
      completed: false,
    },
    op = await f.ra.publish("playback", f.ta.recordId, value);
  const file = f.tb.context.media[0];
  f.tb.context.media = [];
  expect(await f.rb.receive(op)).toBeNull();
  expect(f.tb.values.has(DEVICE_WATCH_STORAGE)).toBe(false);
  f.tb.context.media = [file, file];
  expect(await f.rb.retry("playback", op.recordId)).toBeNull();
  f.tb.context.media = [file];
  f.tb.context.activeMedia = [op.recordId];
  expect(await f.rb.retry("playback", op.recordId)).toBeNull();
  f.tb.context.activeMedia = [];
  expect((await f.rb.retry("playback", op.recordId))?.through).toBe(1);
  const entry = Object.values(
    JSON.parse(f.tb.values.get(DEVICE_WATCH_STORAGE)!).entries,
  )[0] as Record<string, unknown>;
  expect(entry.downloadId).toBe(file.downloadId);
  expect(entry.title).toBe("Local title");
});
it("accepts a deliberate restart from zero and retains versioned deletion instead of max-position merging", async () => {
  const f = await fixture();
  setWatch(f.ta, 80);
  const value = {
      version: 1,
      ...f.ta.media,
      position: 80,
      duration: 100,
      completed: false,
    },
    one = await f.ra.publish("playback", f.ta.recordId, value);
  await f.rb.receive(one);
  setWatch(f.ta, 0);
  const two = await f.ra.publish("playback", f.ta.recordId, {
    ...value,
    position: 0,
  });
  await f.rb.receive(two);
  expect(
    (
      Object.values(
        JSON.parse(f.tb.values.get(DEVICE_WATCH_STORAGE)!).entries,
      )[0] as { position: number }
    ).position,
  ).toBe(0);
  f.ta.values.set(
    DEVICE_WATCH_STORAGE,
    JSON.stringify({
      version: 1,
      epoch: 0,
      entries: {},
      revisions: {},
      serials: {},
      pending: {},
      migrated: true,
    }),
  );
  const deletion = await f.ra.publish("playback", f.ta.recordId, null, true);
  await f.rb.receive(deletion);
  await f.rb.receive(one);
  expect(
    Object.values(JSON.parse(f.tb.values.get(DEVICE_WATCH_STORAGE)!).entries),
  ).toHaveLength(0);
  expect(
    f.b.replicaState().records[replicaKey("playback", one.recordId)].heads[0]
      .deleted,
  ).toBe(true);
});
it("rejects a playback identity hash mismatch before touching target storage", async () => {
  const f = await fixture();
  setWatch(f.ta, 5);
  await expect(
    f.ra.publish("playback", "media." + "0".repeat(64), {
      version: 1,
      ...f.ta.media,
      position: 5,
      duration: 100,
      completed: false,
    }),
  ).rejects.toThrow();
  expect(f.a.snapshot().outbox).toBe(0);
});
it("waits for an in-flight renderer write and rolls it back before successful revocation", async () => {
  const f = await fixture(),
    op = await language(f);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    }),
    original = f.tb.target.apply;
  f.tb.target.apply = async (job) => {
    await original(job);
    entered();
    await gate;
  };
  const receiving = f.rb.receive(op);
  const rejected = expect(receiving).rejects.toThrow();
  await started;
  let done = false;
  const revoking = f.b.revoke().then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  await revoking;
  await rejected;
  expect(f.tb.values.has("language")).toBe(false);
  expect(f.b.snapshot().status).toBe("revoked");
  expect(f.b.pendingDataJob()).toBeNull();
});
it("does not claim revocation when a partial target write cannot be rolled back", async () => {
  const f = await fixture(),
    op = await addView(f);
  f.tb.faults.after = 1;
  await expect(f.rb.receive(op)).rejects.toThrow();
  await expect(f.b.revoke()).rejects.toThrow();
  expect(f.b.snapshot().status).toBe("paused-error");
  f.tb.faults.after = Infinity;
  await f.b.revoke();
  expect(f.b.snapshot().status).toBe("revoked");
  expect(f.tb.values.has(DOWNLOAD_VIEWS_KEY)).toBe(false);
});
it("requires explicit snapshot review and keeps tombstones while filling missing sequence ranges", async () => {
  const f = await fixture(),
    first = await language(f);
  await f.rb.receive(first);
  f.ta.values.delete("language");
  const deleted = await f.ra.publish("preferences", "language", null, true);
  f.ta.values.set("density", "compact");
  await f.ra.publish("preferences", "density", "compact");
  const snapshot = f.a.dataSnapshot("preferences");
  await expect(
    f.rb.acceptSnapshot(snapshot, async () => false),
  ).rejects.toThrow("not-confirmed");
  expect(f.tb.values.get("language")).toBe("ru");
  const ack = await f.rb.acceptSnapshot(snapshot, async () => true);
  expect(ack?.through).toBe(3);
  expect(f.tb.values.has("language")).toBe(false);
  await f.rb.receive(first);
  expect(f.tb.values.has("language")).toBe(false);
  expect(
    f.b.replicaState().records["preferences/language"].heads[0].deleted,
  ).toBe(true);
  await f.a.acknowledge(ack!);
  expect(f.a.snapshot().outbox).toBe(0);
  expect(deleted.sequence).toBe(2);
});
it("does not move a snapshot watermark until blocked target writes are applied", async () => {
  const f = await fixture();
  await language(f);
  f.tb.values.set("language", "en");
  const snapshot = f.a.dataSnapshot("preferences");
  expect(await f.rb.acceptSnapshot(snapshot, async () => true)).toBeNull();
  expect(f.b.replicaState().resync).toBeTruthy();
  expect(f.b.replicaState().inbox.preferences.floor).toBe(0);
  const p = await f.rb.preview("preferences", "language");
  expect(
    (
      await f.rb.retry("preferences", "language", {
        heads: p.heads,
        beforeStamp: p.plan!.beforeStamp,
      })
    )?.through,
  ).toBe(1);
  expect(f.b.replicaState().resync).toBeNull();
});
it("rejects a damaged persistent replica and never replaces it with an empty state", async () => {
  const f = await fixture();
  await f.rb.receive(await language(f));
  await f.rb.close();
  await f.b.close();
  f.sb.mutate((s) => {
    const r = s.replica as {
      records: Record<string, { clock: Record<string, number> }>;
    };
    r.records["preferences/language"].clock = {};
  });
  const before = f.sb.raw();
  expect(() => DeviceVault.open(f.sb.io())).toThrow();
  expect(f.sb.raw()).toBe(before);
});
it("retains ordinary local edits at outbox capacity and resumes via a confirmed compact snapshot", async () => {
  const f = await fixture(),
    first = await language(f),
    actor = first.from;
  await f.ra.close();
  await f.a.close();
  f.sa.mutate((raw) => {
    const state = raw as unknown as {
      counters: { preferences: number };
      outbox: (typeof first)[];
      replica: {
        localThrough: { preferences: number };
        records: Record<
          string,
          { clock: Record<string, number>; heads: (typeof first)[] }
        >;
      };
    };
    state.counters.preferences = 1000;
    state.replica.localThrough.preferences = 1000;
    state.outbox = Array.from({ length: 1000 }, (_, i) => ({
      ...first,
      sequence: i + 1,
      context: i ? { [actor]: i } : {},
    }));
    state.replica.records["preferences/language"].clock = { [actor]: 1000 };
    state.replica.records["preferences/language"].heads = [state.outbox[999]];
  });
  const a = DeviceVault.open(f.sa.io()),
    r = new DeviceReplicator(a, f.ta.target);
  clean.push(async () => {
    await r.close();
    await a.close();
  });
  f.ta.target.plan = async (op) => {
    const { planDeviceTarget } =
      await import("../../shared/device-data-target");
    return planDeviceTarget(f.ta.storage, op, f.ta.context);
  };
  f.ta.values.set("density", "compact");
  await expect(r.publish("preferences", "density", "compact")).rejects.toThrow(
    "quota",
  );
  expect(f.ta.values.get("density")).toBe("compact");
  expect(a.snapshot().outbox).toBe(1000);
  const ack = await f.rb.acceptSnapshot(
    a.dataSnapshot("preferences"),
    async () => true,
  );
  expect(ack?.through).toBe(1000);
  await a.acknowledge(ack!);
  expect(a.snapshot().outbox).toBe(0);
  const op = await r.publish("preferences", "density", "compact");
  expect(op.sequence).toBe(1001);
  expect((await f.rb.receive(op))?.through).toBe(1001);
});
it("reorders mapped views without selecting one or changing an unsynchronized local row", async () => {
  const f = await fixture(),
    one = view(),
    op = await addView(f, one);
  await f.rb.receive(op);
  const two = { ...view("2".repeat(32)), name: "Second" },
    catalog = JSON.parse(f.ta.values.get(DOWNLOAD_VIEWS_KEY)!);
  const { version: _v, syncViewId, ...fields } = two;
  void _v;
  catalog.views.push({ id: "second-local", ...fields });
  f.ta.values.set(DOWNLOAD_VIEWS_KEY, JSON.stringify(catalog));
  bindDeviceView(f.ta.storage, "second-local", syncViewId, () => {});
  await f.rb.receive(await f.ra.publish("views", "view." + syncViewId, two));
  catalog.views.reverse();
  f.ta.values.set(DOWNLOAD_VIEWS_KEY, JSON.stringify(catalog));
  const order = await f.ra.publish("views", "order", {
    version: 1,
    ids: [two.syncViewId, one.syncViewId],
  });
  expect((await f.rb.receive(order))?.through).toBe(2);
  const preview = await f.rb.preview("views", "order");
  await f.rb.retry("views", "order", {
    heads: preview.heads,
    beforeStamp: preview.plan!.beforeStamp,
  });
  expect(
    JSON.parse(f.tb.values.get(DOWNLOAD_VIEWS_KEY)!).views.map(
      (v: { name: string }) => v.name,
    ),
  ).toEqual(["Second", "First"]);
  expect(JSON.parse(f.tb.values.get(DOWNLOAD_VIEWS_KEY)!).activeId).toBeNull();
});
it("pauses and rolls back an in-flight renderer job before narrowing scopes", async () => {
  const f = await fixture(),
    op = await addView(f);
  let entered!: () => void, release!: () => void;
  const start = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    }),
    apply = f.tb.target.apply;
  f.tb.target.apply = async (job) => {
    await apply(job);
    entered();
    await gate;
  };
  const receiving = f.rb.receive(op),
    rejected = expect(receiving).rejects.toThrow();
  await start;
  const narrowed = f.b.narrowScopes(["preferences"]);
  release();
  await narrowed;
  await rejected;
  expect(f.tb.values.has(DOWNLOAD_VIEWS_KEY)).toBe(false);
  expect(f.b.snapshot().scopes).toEqual(["preferences"]);
  expect(f.b.pendingDataJob()).toBeNull();
});
it("rejects a snapshot that invents a local dot for another record", async () => {
  const f = await fixture();
  const a = await language(f);
  f.tb.values.set("density", "compact");
  const b = await f.rb.publish("preferences", "density", "compact");
  const snapshot = f.a.dataSnapshot("preferences");
  snapshot.records[0].clock[b.from] = b.sequence;
  await expect(f.rb.acceptSnapshot(snapshot, async () => true)).rejects.toThrow(
    "peer",
  );
  expect(f.tb.values.has("language")).toBe(false);
  expect(f.b.replicaState().inbox.preferences.floor).toBe(0);
  expect(a.sequence).toBe(1);
});
it("retries an already approved blocked snapshot without another confirmation or lost tombstones", async () => {
  const f = await fixture();
  await language(f);
  f.tb.values.set("language", "en");
  const snapshot = f.a.dataSnapshot("preferences");
  await f.rb.acceptSnapshot(snapshot, async () => true);
  expect(
    await f.rb.acceptSnapshot(snapshot, async () => {
      throw Error("must not ask twice");
    }),
  ).toBeNull();
  const p = await f.rb.preview("preferences", "language");
  await f.rb.retry("preferences", "language", {
    heads: p.heads,
    beforeStamp: p.plan!.beforeStamp,
  });
  expect(
    (await f.rb.acceptSnapshot(snapshot, async () => false))?.through,
  ).toBe(1);
});
it("preserves a concurrent local head when importing a peer snapshot", async () => {
  const f = await fixture();
  await language(f);
  f.tb.values.set("language", "en");
  await f.rb.publish("preferences", "language", "en");
  expect(
    await f.rb.acceptSnapshot(
      f.a.dataSnapshot("preferences"),
      async () => true,
    ),
  ).toBeNull();
  expect(f.b.replicaState().records["preferences/language"].heads).toHaveLength(
    2,
  );
  expect(f.tb.values.get("language")).toBe("en");
});
it("refuses to drop a pending renderer journal when no rollback endpoint is attached", async () => {
  const f = await fixture(),
    op = await language(f);
  f.tb.faults.after = 0;
  await expect(f.rb.receive(op)).rejects.toThrow();
  await f.rb.close();
  await expect(f.b.revoke()).rejects.toThrow("state");
  expect(f.b.snapshot().status).toBe("paused-error");
});
it("preserves a local edit made during a partial commit until an exact new preview is approved", async () => {
  const f = await fixture(),
    op = await addView(f);
  f.tb.faults.after = 1;
  await expect(f.rb.receive(op)).rejects.toThrow();
  f.tb.faults.after = Infinity;
  const catalog = JSON.parse(f.tb.values.get(DOWNLOAD_VIEWS_KEY)!);
  catalog.views[0].name = "Local change";
  f.tb.values.set(DOWNLOAD_VIEWS_KEY, JSON.stringify(catalog));
  await expect(f.rb.recover()).rejects.toThrow("stale");
  expect(JSON.parse(f.tb.values.get(DOWNLOAD_VIEWS_KEY)!).views[0].name).toBe(
    "Local change",
  );
  const p = await f.rb.preview("views", op.recordId);
  expect(
    (
      await f.rb.retry("views", op.recordId, {
        heads: p.heads,
        beforeStamp: p.plan!.beforeStamp,
      })
    )?.through,
  ).toBe(1);
  expect(JSON.parse(f.tb.values.get(DOWNLOAD_VIEWS_KEY)!).views[0].name).toBe(
    "First",
  );
});
it("refuses a plan whose record heads changed while the renderer was preparing it", async () => {
  const f = await fixture(),
    one = await language(f);
  f.ta.values.set("language", "en");
  const two = await f.ra.publish("preferences", "language", "en"),
    original = f.tb.target.plan;
  f.tb.target.plan = async (op) => {
    const result = await original(op);
    f.tb.target.plan = original;
    await f.b.receiveDataOperation(two);
    return result;
  };
  await expect(f.rb.receive(one)).rejects.toThrow("stale");
  expect(f.tb.values.has("language")).toBe(false);
  expect(f.b.pendingDataJob()).toBeNull();
  expect((await f.rb.retry("preferences", "language"))?.through).toBe(2);
  expect(f.tb.values.get("language")).toBe("en");
});
it("rechecks the live category mapping immediately before applying a stored target job", async () => {
  const f = await fixture(),
    v = { ...view(), conditions: { ...view().conditions, category: "source" } },
    op = await addView(f, v);
  f.tb.context.categories.source = "target";
  f.tb.context.categoryIds = ["target"];
  const original = f.tb.target.apply;
  f.tb.target.apply = async (job) => {
    f.tb.context.categoryIds = [];
    await original(job);
  };
  await expect(f.rb.receive(op)).rejects.toThrow();
  expect(f.tb.values.has(DOWNLOAD_VIEWS_KEY)).toBe(false);
  expect(f.b.replicaState().inbox.views.floor).toBe(0);
  f.tb.target.apply = original;
  f.tb.context.categoryIds = ["target"];
  await f.rb.recover();
  expect((await f.rb.receive(op))?.through).toBe(1);
});
it("detects a renderer cache lost after ACK and retains the canonical main value for explicit restoration", async () => {
  const f = await fixture(),
    op = await language(f),
    ack = await f.rb.receive(op);
  await f.a.acknowledge(ack!);
  f.tb.values.delete("language");
  await f.rb.recover();
  expect(f.rb.status().pending).toBe(1);
  expect(
    f.b.replicaState().records["preferences/language"].heads[0].value,
  ).toBe("ru");
  expect(f.tb.values.has("language")).toBe(false);
  const p = await f.rb.preview("preferences", "language");
  await f.rb.retry("preferences", "language", {
    heads: p.heads,
    beforeStamp: p.plan!.beforeStamp,
  });
  expect(f.tb.values.get("language")).toBe("ru");
  expect(f.rb.status().pending).toBe(0);
});

it('records only completed local data application and persists its scope and time', async () => {
  const f = await fixture();
  expect(f.b.replicaState().lastApplied).toBeUndefined();
  const op = await language(f);
  expect(f.a.replicaState().lastApplied).toBeUndefined();
  expect(f.b.replicaState().lastApplied).toBeUndefined();
  await f.rb.receive(op);
  const applied = f.b.replicaState().lastApplied;
  expect(applied?.scope).toBe('preferences'); expect(applied!.at).toBeGreaterThan(0);
  const reopened = await DeviceVault.open(f.sb.io()); clean.push(() => reopened.close());
  expect(reopened.replicaState().lastApplied).toEqual(applied);
});
it('does not report a successful application when the target write fails', async () => {
  const f = await fixture(), op = await language(f);
  f.tb.faults.after = 0;
  await expect(f.rb.receive(op)).rejects.toThrow();
  expect(f.b.replicaState().lastApplied).toBeUndefined();
});
