import {
  DeviceError,
  deviceObject,
  deviceScopes,
  type DeviceScope,
} from "./device-pairing";
import {
  DEVICE_INTERFACE_KEYS,
  DEVICE_PLAYER_KEYS,
  DEVICE_PLAYER_STORAGE,
  DEVICE_WATCH_STORAGE,
  validateDeviceValue,
  exportDeviceView,
} from "./device-data";
import {
  DEVICE_TARGET_META,
  type DeviceTargetContext,
  type DeviceTargetStorage,
} from "./device-data-target";
import {
  DOWNLOAD_VIEWS_KEY,
  validateDownloadViews,
  emptyDownloadViews,
} from "./download-views";
import { normalizePlayerPreferences } from "./player-preferences";
import { normalizeWatchEntry } from "./watch-history";
import type { DeviceCapture, DeviceLocalRecord } from "./device-ui";
export function captureDeviceLocal(
  storage: DeviceTargetStorage,
  rawScopes: DeviceScope[],
  context: DeviceTargetContext,
  newId: () => string,
  guard: () => void,
): DeviceCapture {
  const scopes = deviceScopes(rawScopes),
    records: DeviceLocalRecord[] = [],
    issues: DeviceCapture["issues"] = [];
  const push = (scope: DeviceScope, recordId: string, value: unknown) => {
    try {
      records.push({
        scope,
        recordId,
        value: validateDeviceValue(scope, recordId, value),
        deleted: false,
      });
    } catch {
      issues.push({ scope, recordId, code: "invalid" });
    }
  };
  const parse = (key: string, fallback: unknown) => {
    const raw = storage.getItem(key);
    try {
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      throw new DeviceError("storage");
    }
  };
  if (scopes.includes("preferences")) {
    for (const key of DEVICE_INTERFACE_KEYS) {
      const value = storage.getItem(key);
      if (value !== null) push("preferences", key, value);
    }
    const raw = parse(DEVICE_PLAYER_STORAGE, null);
    if (raw !== null) {
      const player = normalizePlayerPreferences(raw);
      for (const key of DEVICE_PLAYER_KEYS) {
        const value = (raw as Record<string, unknown>)[key];
        if (value !== undefined)
          push("preferences", key, value === player[key] ? value : undefined);
      }
    }
  }
  if (scopes.includes("views")) {
    const catalog = validateDownloadViews(
        parse(DOWNLOAD_VIEWS_KEY, emptyDownloadViews()),
      ),
      before = storage.getItem(DEVICE_TARGET_META),
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
    const mapping = { ...(meta.views as Record<string, string>) },
      order: string[] = [];
    if (
      Object.entries(mapping).some(
        ([id, local]) =>
          !/^[a-f0-9]{32}$/.test(id) || typeof local !== "string",
      ) ||
      Object.keys(mapping).length > 256
    )
      throw new DeviceError("storage");
    for (const view of catalog.views) {
      let syncId = Object.keys(mapping).find((id) => mapping[id] === view.id);
      if (!syncId) {
        syncId = newId();
        if (
          !/^[a-f0-9]{32}$/.test(syncId) ||
          Object.hasOwn(mapping, syncId) ||
          Object.keys(mapping).length >= 256
        )
          throw new DeviceError("quota");
        mapping[syncId] = view.id;
      }
      if (view.conditions.path) {
        issues.push({
          scope: "views",
          recordId: "view." + syncId,
          code: "path-filter",
        });
        continue;
      }
      const c = view.conditions.category;
      const alias = typeof c === "string" ? context.exportCategories?.[c] : c;
      if (typeof c === "string" && !alias) {
        issues.push({
          scope: "views",
          recordId: "view." + syncId,
          code: "category",
        });
        continue;
      }
      const portable = {
        ...view,
        conditions: {
          ...view.conditions,
          ...(alias !== undefined ? { category: alias } : {}),
        },
      };
      const value = exportDeviceView(portable, syncId).value;
      if (value) {
        push("views", "view." + syncId, value);
        order.push(syncId);
      }
    }
    const after = JSON.stringify({ version: 1, views: mapping });
    if (before !== after) {
      guard();
      if (storage.getItem(DEVICE_TARGET_META) !== before)
        throw new DeviceError("stale");
      storage.setItem(DEVICE_TARGET_META, after);
      if (storage.getItem(DEVICE_TARGET_META) !== after)
        throw new DeviceError("storage");
    }
    if (order.length || catalog.views.length === 0)
      push("views", "order", { version: 1, ids: order });
  }
  if (scopes.includes("playback")) {
    const store = parse(DEVICE_WATCH_STORAGE, null);
    if (store !== null) {
      if (
        !store ||
        typeof store !== "object" ||
        (store as { version?: unknown }).version !== 1
      )
        throw new DeviceError("storage");
      const raw = (store as { entries?: unknown }).entries;
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).length > 200
      )
        throw new DeviceError("storage");
      for (const rawEntry of Object.values(raw)) {
        const entry = normalizeWatchEntry(rawEntry);
        if (!entry) {
          issues.push({
            scope: "playback",
            recordId: "unknown",
            code: "invalid",
          });
          continue;
        }
        const matches = context.media.filter(
          (file) =>
            file.infoHash === entry.identity && file.path === entry.path,
        );
        if (matches.length !== 1) {
          issues.push({
            scope: "playback",
            recordId: "unknown-media",
            code: matches.length ? "ambiguous-file" : "missing-file",
          });
          continue;
        }
        const file = matches[0];
        if (context.activeMedia.includes(file.recordId)) {
          issues.push({
            scope: "playback",
            recordId: file.recordId,
            code: "playing",
          });
          continue;
        }
        push("playback", file.recordId, {
          version: 1,
          infoHash: file.infoHash,
          path: file.path,
          size: file.size,
          position: entry.position,
          duration: entry.duration,
          completed: entry.completed,
        });
      }
    }
  }
  if (records.length > 256) throw new DeviceError("quota");
  return { records, issues };
}
