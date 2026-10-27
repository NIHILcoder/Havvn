/** DP-03 allowlist. Never accepts an arbitrary application/localStorage key. */
import {
  DeviceError,
  deviceObject,
  deviceHex,
  validateDeviceOperation,
  boundedDeviceJson,
  type DeviceOperation,
  type DeviceJson,
} from "./device-pairing";
import {
  INTERFACE_KEYS,
  validateInterfacePreferences,
} from "./interface-preferences";
import {
  trackLanguage,
  normalizePlayerPreferences,
} from "./player-preferences";
import { validateDownloadViews, type DownloadView } from "./download-views";
export const DEVICE_INTERFACE_KEYS = [
  "language",
  "uiScale",
  "density",
  "reduceMotion",
  "speedUnits",
] as const;
export const DEVICE_PLAYER_KEYS = [
  "audioLanguage",
  "subtitleLanguage",
  "subtitleMode",
] as const;
export const DEVICE_PLAYER_STORAGE = "havvn.player.preferences.v1";
export const DEVICE_WATCH_STORAGE = "havvn.watchHistory.v1";
export interface DeviceMediaIdentity {
  infoHash: string;
  path: string;
  size: number;
}
export interface DevicePlayback extends DeviceMediaIdentity {
  version: 1;
  position: number;
  duration: number | null;
  completed: boolean;
}
export interface DeviceView extends Omit<DownloadView, "id"> {
  version: 1;
  syncViewId: string;
}
const fail = (): never => {
  throw new DeviceError("invalid");
};
export function validateDeviceMedia(raw: unknown): DeviceMediaIdentity {
  const m = deviceObject(raw, ["infoHash", "path", "size"]);
  if (
    typeof m.infoHash !== "string" ||
    !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(m.infoHash) ||
    typeof m.path !== "string" ||
    !m.path ||
    m.path.length > 1024 ||
    m.path.includes("\\") ||
    m.path.startsWith("/") ||
    m.path
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          p.includes(":") ||
          [...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
      ) ||
    !Number.isSafeInteger(m.size) ||
    (m.size as number) < 0
  )
    return fail();
  return { infoHash: m.infoHash, path: m.path, size: m.size as number };
}
export function validateDeviceValue(
  scope: DeviceOperation["scope"],
  recordId: string,
  value: unknown,
  deleted = false,
): DeviceJson {
  try {
    if (deleted) {
      if (value !== null) fail();
    }
    if (scope === "preferences") {
      const key = recordId;
      if (
        !(DEVICE_INTERFACE_KEYS as readonly string[]).includes(key) &&
        !(DEVICE_PLAYER_KEYS as readonly string[]).includes(key)
      )
        fail();
      if (deleted) return null;
      if (typeof value !== "string") fail();
      if ((DEVICE_INTERFACE_KEYS as readonly string[]).includes(key)) {
        const values = Object.fromEntries(
          INTERFACE_KEYS.map((k) => [k, k === key ? value : null]),
        );
        validateInterfacePreferences({ version: 1, values });
      } else if (key === "subtitleMode") {
        if (!["off", "auto", "on"].includes(value as string)) fail();
      } else if (trackLanguage(value) !== value) fail();
      // Normalizers may not turn an invalid network value into a successful default.
      if (
        (DEVICE_PLAYER_KEYS as readonly string[]).includes(key) &&
        normalizePlayerPreferences({ [key]: value })[
          key as (typeof DEVICE_PLAYER_KEYS)[number]
        ] !== value
      )
        fail();
      return value as string;
    }
    if (scope === "views") {
      if (recordId === "order") {
        if (deleted) fail();
        const v = deviceObject(value, ["version", "ids"]);
        if (
          v.version !== 1 ||
          !Array.isArray(v.ids) ||
          v.ids.length > 64 ||
          new Set(v.ids).size !== v.ids.length
        )
          fail();
        return {
          version: 1,
          ids: (v.ids as unknown[]).map((id) => deviceHex(id, 32)),
        };
      }
      if (!/^view\.[a-f0-9]{32}$/.test(recordId)) fail();
      if (deleted) return null;
      const v = deviceObject(value, [
        "version",
        "syncViewId",
        "name",
        "pinned",
        "conditions",
        "sort",
        "mode",
      ]);
      if (v.version !== 1 || deviceHex(v.syncViewId, 32) !== recordId.slice(5))
        fail();
      const checked = validateDownloadViews({
        version: 1,
        activeId: null,
        views: [
          {
            id: v.syncViewId,
            name: v.name,
            pinned: v.pinned,
            conditions: v.conditions,
            sort: v.sort,
            mode: v.mode,
          },
        ],
      }).views[0];
      if (checked.name !== v.name || checked.conditions.path !== "") fail();
      const { id, ...fields } = checked;
      return boundedDeviceJson({ version: 1, syncViewId: id, ...fields });
    }
    if (scope !== "playback" || !/^media\.[a-f0-9]{64}$/.test(recordId)) fail();
    if (deleted) return null;
    const v = deviceObject(value, [
      "version",
      "infoHash",
      "path",
      "size",
      "position",
      "duration",
      "completed",
    ]);
    const media = validateDeviceMedia({
      infoHash: v.infoHash,
      path: v.path,
      size: v.size,
    });
    if (
      v.version !== 1 ||
      typeof v.position !== "number" ||
      !Number.isFinite(v.position) ||
      v.position < 0 ||
      typeof v.completed !== "boolean" ||
      (v.duration !== null &&
        (typeof v.duration !== "number" ||
          !Number.isFinite(v.duration) ||
          v.duration <= 0 ||
          v.position > v.duration))
    )
      fail();
    return boundedDeviceJson({
      version: 1,
      ...media,
      position: v.position,
      duration: v.duration,
      completed: v.completed,
    });
  } catch {
    throw new DeviceError("invalid");
  }
}
export function validateDeviceDataOperation(raw: unknown): DeviceOperation {
  const op = validateDeviceOperation(raw);
  op.value = validateDeviceValue(op.scope, op.recordId, op.value, op.deleted);
  if (new TextEncoder().encode(JSON.stringify(op)).length > 4096)
    throw new DeviceError("size");
  return op;
}
export function exportDeviceView(
  view: DownloadView,
  syncViewId: string,
): { value: DeviceView | null; issue: "path-filter" | null } {
  if (view.conditions.path) return { value: null, issue: "path-filter" };
  const { id: _id, ...fields } = view;
  void _id;
  const value = validateDeviceValue("views", "view." + syncViewId, {
    version: 1,
    syncViewId,
    ...fields,
  }) as unknown as DeviceView;
  return { value, issue: null };
}
export function deviceDataCanonical(value: unknown): string {
  const v = boundedDeviceJson(value);
  const encode = (x: DeviceJson): string =>
    x && typeof x === "object"
      ? Array.isArray(x)
        ? "[" + x.map(encode).join(",") + "]"
        : "{" +
          Object.keys(x)
            .sort()
            .map((k) => JSON.stringify(k) + ":" + encode(x[k]))
            .join(",") +
          "}"
      : JSON.stringify(x);
  return encode(v);
}
