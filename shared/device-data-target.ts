/** Runs next to the actual renderer localStorage, with explicit trusted local context. */
import {
  DeviceError,
  deviceObject,
  type DeviceOperation,
} from "./device-pairing";
import {
  DEVICE_INTERFACE_KEYS,
  DEVICE_PLAYER_KEYS,
  DEVICE_PLAYER_STORAGE,
  DEVICE_WATCH_STORAGE,
  validateDeviceValue,
  validateDeviceMedia,
  deviceDataCanonical,
  type DevicePlayback,
  type DeviceView,
} from "./device-data";
import {
  DOWNLOAD_VIEWS_KEY,
  validateDownloadViews,
  emptyDownloadViews,
  type DownloadView,
} from "./download-views";
import { normalizePlayerPreferences } from "./player-preferences";
import {
  watchKey,
  normalizeWatchEntry,
  type WatchTarget,
} from "./watch-history";
export const DEVICE_TARGET_META = "havvn.devices.data.v1";
export interface DeviceTargetContext {
  exportCategories?: Record<string, string>;
  categories: Record<string, string>;
  categoryIds: string[];
  media: Array<
    WatchTarget & { recordId: string; infoHash: string; size: number }
  >;
  activeMedia: string[];
}
export interface DeviceTargetPatch {
  key: string;
  before: string | null;
  after: string | null;
}
export interface DeviceTargetPlan {
  version: 1;
  writes: DeviceTargetPatch[];
  issue: string | null;
  beforeStamp: string;
  afterStamp: string;
  contextStamp: string;
}
export interface DeviceTargetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export const DEVICE_TARGET_KEYS: readonly string[] = [
  ...DEVICE_INTERFACE_KEYS,
  DEVICE_PLAYER_STORAGE,
  DEVICE_WATCH_STORAGE,
  DOWNLOAD_VIEWS_KEY,
  DEVICE_TARGET_META,
];
export function validateDeviceTargetPlan(raw: unknown): DeviceTargetPlan {
  const p = deviceObject(raw, [
    "version",
    "writes",
    "issue",
    "beforeStamp",
    "afterStamp",
    "contextStamp",
  ]);
  if (
    typeof p.beforeStamp !== "string" ||
    typeof p.afterStamp !== "string" ||
    p.beforeStamp.length > 8192 ||
    p.afterStamp.length > 8192
  )
    throw new DeviceError("invalid");
  if (
    p.version !== 1 ||
    !Array.isArray(p.writes) ||
    p.writes.length > 3 ||
    !(
      p.issue === null ||
      [
        "category",
        "missing-file",
        "ambiguous-file",
        "playing",
        "missing-view",
        "local-change",
        "conflict",
        "path-filter",
      ].includes(p.issue as string)
    )
  )
    throw new DeviceError("invalid");
  const seen = new Set<string>();
  if (typeof p.contextStamp !== "string" || p.contextStamp.length > 8192)
    throw new DeviceError("invalid");
  const writes = p.writes.map((raw) => {
    const w = deviceObject(raw, ["key", "before", "after"]);
    if (
      typeof w.key !== "string" ||
      !DEVICE_TARGET_KEYS.includes(w.key) ||
      seen.has(w.key) ||
      ![w.before, w.after].every((v) => v === null || typeof v === "string")
    )
      throw new DeviceError("invalid");
    seen.add(w.key);
    return {
      key: w.key,
      before: w.before as string | null,
      after: w.after as string | null,
    };
  });
  if (
    (p.issue !== null && writes.length) ||
    new TextEncoder().encode(JSON.stringify(writes)).length > 1024 * 1024
  )
    throw new DeviceError("size");
  return {
    version: 1,
    writes,
    issue: p.issue as string | null,
    beforeStamp: p.beforeStamp,
    afterStamp: p.afterStamp,
    contextStamp: p.contextStamp,
  };
}
export function validateDeviceScopedPlan(
  raw: unknown,
  scope: DeviceOperation["scope"],
  id: string,
): DeviceTargetPlan {
  const plan = validateDeviceTargetPlan(raw),
    keys =
      scope === "preferences"
        ? (DEVICE_INTERFACE_KEYS as readonly string[]).includes(id)
          ? [id]
          : [DEVICE_PLAYER_STORAGE]
        : scope === "views"
          ? [DOWNLOAD_VIEWS_KEY, DEVICE_TARGET_META]
          : [DEVICE_WATCH_STORAGE];
  if (plan.writes.some((w) => !keys.includes(w.key)))
    throw new DeviceError("invalid");
  return plan;
}
export function planDeviceTarget(
  storage: DeviceTargetStorage,
  op: DeviceOperation,
  context: DeviceTargetContext,
): DeviceTargetPlan {
  const value = validateDeviceValue(
      op.scope,
      op.recordId,
      op.value,
      op.deleted,
    ),
    writes: DeviceTargetPatch[] = [];
  const contextStamp = deviceTargetContextStamp(op, context);
  let beforeStamp = "null",
    afterStamp = "null";
  const stamps = (before: unknown, after: unknown) => {
    beforeStamp = deviceDataCanonical(before);
    afterStamp = deviceDataCanonical(after);
  };
  const patch = (key: string, after: string | null) => {
    writes.push({ key, before: storage.getItem(key), after });
  };
  const blocked = (issue: string): DeviceTargetPlan => ({
    version: 1,
    writes: [],
    issue,
    beforeStamp: "null",
    afterStamp: "null",
    contextStamp,
  });
  const parse = (key: string, fallback: unknown) => {
    const raw = storage.getItem(key);
    try {
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      throw new DeviceError("storage");
    }
  };
  if (op.scope === "preferences") {
    if ((DEVICE_INTERFACE_KEYS as readonly string[]).includes(op.recordId)) {
      patch(op.recordId, op.deleted ? null : (value as string));
      stamps(writes[0].before, writes[0].after);
    } else {
      const raw = parse(DEVICE_PLAYER_STORAGE, {});
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new DeviceError("storage");
      const player = normalizePlayerPreferences(raw),
        key = op.recordId as (typeof DEVICE_PLAYER_KEYS)[number];
      for (const [field, stored] of Object.entries(raw))
        if (
          !Object.hasOwn(player, field) ||
          player[field as keyof typeof player] !== stored
        )
          throw new DeviceError("storage");
      const before = player[key];
      if (key === "subtitleMode")
        player.subtitleMode = op.deleted
          ? "off"
          : (value as "off" | "auto" | "on");
      else player[key] = op.deleted ? "" : (value as string);
      stamps(before, player[key]);
      patch(DEVICE_PLAYER_STORAGE, JSON.stringify(player));
    }
  } else if (op.scope === "views") {
    const catalog = validateDownloadViews(
      parse(DOWNLOAD_VIEWS_KEY, emptyDownloadViews()),
    );
    const metaRaw = parse(DEVICE_TARGET_META, { version: 1, views: {} }),
      meta = deviceObject(metaRaw, ["version", "views"]);
    if (
      meta.version !== 1 ||
      !meta.views ||
      typeof meta.views !== "object" ||
      Array.isArray(meta.views) ||
      Object.keys(meta.views).length > 256
    )
      throw new DeviceError("storage");
    const mapping = { ...(meta.views as Record<string, string>) };
    if (
      Object.entries(mapping).some(
        ([key, id]) =>
          !/^[a-f0-9]{32}$/.test(key) ||
          typeof id !== "string" ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(id),
      ) ||
      new Set(Object.values(mapping)).size !== Object.keys(mapping).length
    )
      throw new DeviceError("storage");
    if (op.recordId === "order") {
      const ids = (value as { ids: string[] }).ids;
      if (
        ids.some(
          (id) =>
            !mapping[id] || !catalog.views.some((v) => v.id === mapping[id]),
        )
      )
        return blocked("missing-view");
      const mapped = ids.map((id) =>
        catalog.views.find((v) => v.id === mapping[id])!,
      );
      const before = catalog.views.map((v) => v.id);
      const positions = catalog.views
        .map((view, index) =>
          mapped.some((v) => v.id === view.id) ? index : -1,
        )
        .filter((n) => n >= 0);
      positions.forEach((position, index) => {
        catalog.views[position] = mapped[index];
      });
      stamps(
        before,
        catalog.views.map((v) => v.id),
      );
    } else {
      const syncId = op.recordId.slice(5),
        id = mapping[syncId] ?? "device-" + syncId;
      const before = catalog.views.find((v) => v.id === id) ?? null;
      if (op.deleted) {
        catalog.views = catalog.views.filter((v) => v.id !== id);
        if (catalog.activeId === id) catalog.activeId = null;
        delete mapping[syncId];
      } else {
        const view = value as unknown as DeviceView;
        let category = view.conditions.category;
        if (typeof category === "string") {
          if (
            !Object.hasOwn(context.categories, category) ||
            !context.categoryIds.includes(context.categories[category])
          )
            return blocked("category");
          category = context.categories[category];
        }
        const local: DownloadView = {
          id,
          name: view.name,
          pinned: view.pinned,
          sort: view.sort,
          mode: view.mode,
          conditions: {
            ...view.conditions,
            ...(category !== undefined ? { category } : {}),
          },
        };
        if (catalog.views.some((v) => v.id === id))
          catalog.views = catalog.views.map((v) => (v.id === id ? local : v));
        else catalog.views.push(local);
        mapping[syncId] = id;
      }
      stamps(before, catalog.views.find((v) => v.id === id) ?? null);
    }
    patch(DOWNLOAD_VIEWS_KEY, JSON.stringify(validateDownloadViews(catalog)));
    patch(DEVICE_TARGET_META, JSON.stringify({ version: 1, views: mapping }));
  } else {
    const candidates = context.media.filter(
      (file) => file.recordId === op.recordId,
    );
    if (!candidates.length) return blocked("missing-file");
    if (candidates.length !== 1) return blocked("ambiguous-file");
    const file = candidates[0];
    validateDeviceMedia({
      infoHash: file.infoHash,
      path: file.path,
      size: file.size,
    });
    if (context.activeMedia.includes(op.recordId)) return blocked("playing");
    const playback = value as unknown as DevicePlayback;
    if (
      !op.deleted &&
      (file.infoHash !== playback.infoHash ||
        file.path !== playback.path ||
        file.size !== playback.size)
    )
      return blocked("missing-file");
    const raw = parse(DEVICE_WATCH_STORAGE, {
      version: 1,
      epoch: 0,
      entries: {},
      revisions: {},
      serials: {},
      pending: {},
      migrated: false,
    });
    const store = deviceObject(raw, [
      "version",
      "epoch",
      "entries",
      "revisions",
      "serials",
      "pending",
      "migrated",
    ]);
    if (
      store.version !== 1 ||
      !Number.isSafeInteger(store.epoch) ||
      (store.epoch as number) < 0 ||
      typeof store.migrated !== "boolean"
    )
      throw new DeviceError("storage");
    for (const key of ["entries", "revisions", "serials", "pending"])
      if (
        !store[key] ||
        typeof store[key] !== "object" ||
        Array.isArray(store[key])
      )
        throw new DeviceError("storage");
    const entries = store.entries as Record<string, unknown>,
      revisions = store.revisions as Record<string, number>,
      serials = store.serials as Record<string, number>,
      key = watchKey(file);
    if (
      Object.values(entries).some((e) => !normalizeWatchEntry(e)) ||
      Object.values({ ...revisions, ...serials }).some(
        (n) => !Number.isSafeInteger(n) || n < 0,
      )
    )
      throw new DeviceError("storage");
    const stamp = (entry: unknown) => {
      const e = entry as Record<string, unknown> | undefined;
      return e
        ? [e.identity, e.path, e.position, e.duration, e.completed]
        : null;
    };
    const before = stamp(entries[key]);
    if (op.deleted) delete entries[key];
    else {
      const old = entries[key] as Record<string, unknown> | undefined;
      // Local timestamps are display metadata; causality is handled in main, never by this clock.
      const entry = normalizeWatchEntry({
        ...old,
        identity: file.identity,
        downloadId: file.downloadId,
        title: file.title,
        path: file.path,
        fileIndex: file.fileIndex,
        position: playback.position,
        duration: playback.duration,
        completed: playback.completed,
        lastOpened: old?.lastOpened ?? 0,
        updatedAt: Date.now(),
      });
      if (
        !entry ||
        (!Object.hasOwn(entries, key) && Object.keys(entries).length >= 200)
      )
        throw new DeviceError("quota");
      entries[key] = entry;
    }
    revisions[key] = Math.max(revisions[key] ?? 0, serials[key] ?? 0) + 1;
    serials[key] = revisions[key];
    stamps(before, stamp(entries[key]));
    if (beforeStamp === afterStamp)
      return {
        version: 1,
        writes: [],
        issue: null,
        beforeStamp,
        afterStamp,
        contextStamp,
      };
    patch(DEVICE_WATCH_STORAGE, JSON.stringify(store));
  }
  return validateDeviceTargetPlan({
    version: 1,
    writes,
    issue: null,
    beforeStamp,
    afterStamp,
    contextStamp,
  });
}
export function deviceTargetContextStamp(
  op: DeviceOperation,
  context: DeviceTargetContext,
): string {
  if (op.scope === "playback")
    return deviceDataCanonical({
      files: context.media.filter((f) => f.recordId === op.recordId),
      active: context.activeMedia.includes(op.recordId),
    });
  if (op.scope === "views" && !op.deleted && op.recordId !== "order") {
    const category = (op.value as unknown as DeviceView).conditions.category;
    if (typeof category === "string")
      return deviceDataCanonical([
        category,
        context.categories[category] ?? null,
        context.categoryIds.includes(context.categories[category]),
      ]);
  }
  return "null";
}
export function bindDeviceView(
  storage: DeviceTargetStorage,
  localId: string,
  syncViewId: string,
  guard: () => void,
): void {
  if (!/^[a-f0-9]{32}$/.test(syncViewId)) throw new DeviceError("invalid");
  const catalog = validateDownloadViews(
    JSON.parse(
      storage.getItem(DOWNLOAD_VIEWS_KEY) ??
        JSON.stringify(emptyDownloadViews()),
    ),
  );
  if (!catalog.views.some((v) => v.id === localId))
    throw new DeviceError("missing");
  const before = storage.getItem(DEVICE_TARGET_META),
    meta = before
      ? deviceObject(JSON.parse(before), ["version", "views"])
      : { version: 1, views: {} };
  if (
    meta.version !== 1 ||
    !meta.views ||
    typeof meta.views !== "object" ||
    Array.isArray(meta.views)
  )
    throw new DeviceError("storage");
  const views = { ...(meta.views as Record<string, string>) };
  if (
    (views[syncViewId] && views[syncViewId] !== localId) ||
    Object.entries(views).some(
      ([key, id]) => id === localId && key !== syncViewId,
    )
  )
    throw new DeviceError("stale");
  views[syncViewId] = localId;
  const after = JSON.stringify({ version: 1, views });
  guard();
  if (storage.getItem(DEVICE_TARGET_META) !== before)
    throw new DeviceError("stale");
  storage.setItem(DEVICE_TARGET_META, after);
  if (storage.getItem(DEVICE_TARGET_META) !== after)
    throw new DeviceError("storage");
}
/** Each write/readback and guard executes synchronously beside storage. */
export function applyDeviceTargetPlan(
  storage: DeviceTargetStorage,
  raw: DeviceTargetPlan,
  guard: () => void,
): void {
  const plan = validateDeviceTargetPlan(raw);
  if (plan.issue) throw new DeviceError("state");
  guard();
  // A partial prior commit can be resumed only when every key is still before/after.
  for (const w of plan.writes) {
    const actual = storage.getItem(w.key);
    if (actual !== w.before && actual !== w.after)
      throw new DeviceError("stale");
  }
  for (const w of plan.writes) {
    guard();
    if (storage.getItem(w.key) !== w.after) {
      if (w.after === null) storage.removeItem(w.key);
      else storage.setItem(w.key, w.after);
    }
  }
  guard();
  if (plan.writes.some((w) => storage.getItem(w.key) !== w.after))
    throw new DeviceError("storage");
}
export function rollbackDeviceTargetPlan(
  storage: DeviceTargetStorage,
  raw: DeviceTargetPlan,
  guard: () => void,
): void {
  const plan = validateDeviceTargetPlan(raw);
  guard();
  if (
    plan.writes.some((w) => {
      const current = storage.getItem(w.key);
      return current !== w.before && current !== w.after;
    })
  )
    throw new DeviceError("stale");
  for (const w of [...plan.writes].reverse()) {
    guard();
    if (storage.getItem(w.key) !== w.before) {
      if (w.before === null) storage.removeItem(w.key);
      else storage.setItem(w.key, w.before);
    }
  }
  if (plan.writes.some((w) => storage.getItem(w.key) !== w.before))
    throw new DeviceError("storage");
}
