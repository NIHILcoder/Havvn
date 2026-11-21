import type { Download } from "./types";

export const DOWNLOAD_VIEWS_KEY = "havvn.download-views.v1";
export const DOWNLOAD_VIEW_LIMIT = 64;
export const DOWNLOAD_VIEW_STATUSES = [
  "all",
  "downloading",
  "completed",
  "paused",
  "error",
] as const;
export type DownloadViewStatus = (typeof DOWNLOAD_VIEW_STATUSES)[number];
export interface DownloadViewConditions {
  status: DownloadViewStatus;
  /** Omitted = all categories, null = uncategorized, string = exact category ID. */
  category?: string | null;
  name: string;
  path: string;
  minBytes?: number;
  maxBytes?: number;
}
export interface DownloadViewConfig {
  conditions: DownloadViewConditions;
  sort: {
    by: "added" | "name" | "progress" | "speed";
    direction: "asc" | "desc";
  };
  mode: "compact" | "detailed";
}
export interface DownloadView extends DownloadViewConfig {
  id: string;
  name: string;
  pinned: boolean;
}
export interface DownloadViews {
  version: 1;
  views: DownloadView[];
  activeId: string | null;
}
export const DEFAULT_VIEW_CONFIG: DownloadViewConfig = {
  conditions: { status: "all", name: "", path: "" },
  sort: { by: "added", direction: "desc" },
  mode: "compact",
};
export const emptyDownloadViews = (): DownloadViews => ({
  version: 1,
  views: [],
  activeId: null,
});
export type DownloadViewErrorCode =
  "invalid" | "name" | "duplicate" | "limit" | "missing" | "storage";
export class DownloadViewError extends Error {
  constructor(public code: DownloadViewErrorCode) {
    super(`Download view: ${code}`);
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  ![...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
export const normalizeViewText = (value: string): string =>
  value.normalize("NFKC").toLowerCase().replace(/ё/g, "е");

export function validateViewConfig(input: unknown): DownloadViewConfig {
  if (!object(input) || !object(input.conditions) || !object(input.sort))
    throw new DownloadViewError("invalid");
  const c = input.conditions,
    s = input.sort;
  if (
    !keys(c, ["status", "category", "name", "path", "minBytes", "maxBytes"]) ||
    !DOWNLOAD_VIEW_STATUSES.includes(c.status as DownloadViewStatus) ||
    !text(c.name, 200) ||
    !text(c.path, 1024) ||
    (c.category !== undefined &&
      c.category !== null &&
      (!text(c.category, 128) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(c.category) ||
        ["__proto__", "constructor", "prototype"].includes(c.category))) ||
    !keys(s, ["by", "direction"]) ||
    !["added", "name", "progress", "speed"].includes(s.by as string) ||
    !["asc", "desc"].includes(s.direction as string) ||
    !["compact", "detailed"].includes(input.mode as string)
  )
    throw new DownloadViewError("invalid");
  for (const bound of [c.minBytes, c.maxBytes])
    if (
      bound !== undefined &&
      (typeof bound !== "number" || !Number.isSafeInteger(bound) || bound < 0)
    )
      throw new DownloadViewError("invalid");
  if (
    typeof c.minBytes === "number" &&
    typeof c.maxBytes === "number" &&
    c.minBytes > c.maxBytes
  )
    throw new DownloadViewError("invalid");
  return {
    conditions: {
      status: c.status as DownloadViewStatus,
      name: c.name,
      path: c.path,
      ...(c.category !== undefined
        ? { category: c.category as string | null }
        : {}),
      ...(c.minBytes !== undefined ? { minBytes: c.minBytes as number } : {}),
      ...(c.maxBytes !== undefined ? { maxBytes: c.maxBytes as number } : {}),
    },
    sort: {
      by: s.by as DownloadViewConfig["sort"]["by"],
      direction: s.direction as "asc" | "desc",
    },
    mode: input.mode as "compact" | "detailed",
  };
}
export function validateDownloadViews(input: unknown): DownloadViews {
  if (
    !object(input) ||
    !keys(input, ["version", "views", "activeId"]) ||
    input.version !== 1 ||
    !Array.isArray(input.views) ||
    input.views.length > DOWNLOAD_VIEW_LIMIT ||
    (input.activeId !== null && !id(input.activeId))
  )
    throw new DownloadViewError("invalid");
  const ids = new Set<string>(),
    names = new Set<string>();
  const views = input.views.map((value) => {
    if (
      !object(value) ||
      !keys(value, ["id", "name", "pinned", "conditions", "sort", "mode"]) ||
      !id(value.id) ||
      ids.has(value.id) ||
      !text(value.name, 80) ||
      !value.name.trim() ||
      typeof value.pinned !== "boolean"
    )
      throw new DownloadViewError("invalid");
    const name = value.name.trim(),
      normalized = normalizeViewText(name);
    if (names.has(normalized)) throw new DownloadViewError("duplicate");
    ids.add(value.id);
    names.add(normalized);
    return {
      id: value.id,
      name,
      pinned: value.pinned,
      ...validateViewConfig(value),
    };
  });
  if (input.activeId !== null && !ids.has(input.activeId))
    throw new DownloadViewError("invalid");
  return { version: 1, views, activeId: input.activeId as string | null };
}

/** Prepared once per condition change. No regex compilation, IPC or stats subscription. */
export function compileDownloadView(
  conditions: DownloadViewConditions,
): (
  download: Pick<
    Download,
    "status" | "category" | "name" | "savePath" | "totalSize"
  >,
) => boolean {
  const name = normalizeViewText(conditions.name),
    path = normalizeViewText(conditions.path).replace(/\\/g, "/");
  return (download) => {
    const status = conditions.status;
    if (
      status === "downloading" &&
      !["downloading", "queued"].includes(download.status)
    )
      return false;
    if (
      status === "completed" &&
      !["completed", "seeding"].includes(download.status)
    )
      return false;
    if (
      status !== "all" &&
      status !== "downloading" &&
      status !== "completed" &&
      download.status !== status
    )
      return false;
    if (
      conditions.category !== undefined &&
      (download.category ?? null) !== conditions.category
    )
      return false;
    if (name && !normalizeViewText(download.name).includes(name)) return false;
    if (
      path &&
      !normalizeViewText(download.savePath).replace(/\\/g, "/").includes(path)
    )
      return false;
    if (
      conditions.minBytes !== undefined ||
      conditions.maxBytes !== undefined
    ) {
      if (!Number.isFinite(download.totalSize) || download.totalSize <= 0)
        return false;
      if (
        conditions.minBytes !== undefined &&
        download.totalSize < conditions.minBytes
      )
        return false;
      if (
        conditions.maxBytes !== undefined &&
        download.totalSize > conditions.maxBytes
      )
        return false;
    }
    return true;
  };
}
export function sameViewConfig(
  a: DownloadViewConfig,
  b: DownloadViewConfig,
): boolean {
  return (
    JSON.stringify(validateViewConfig(a)) ===
    JSON.stringify(validateViewConfig(b))
  );
}
