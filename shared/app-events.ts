/** Versioned local history. No names, filesystem paths, URLs or raw exceptions. */
export const APP_EVENT_CODES = [
  "automation-applied",
  "automation-failed",
  "download-complete",
  "download-error",
  "disk-low",
  "settings-exported",
  "settings-export-failed",
  "room-disconnected",
] as const;
export type AppEventCode = (typeof APP_EVENT_CODES)[number];
export type AppEventAction = "open" | "retry" | "settings";
export type AppEventObject =
  { kind: "download" | "room"; id: string } | { kind: "system" };
export interface AppEvent {
  id: string;
  code: AppEventCode;
  object: AppEventObject;
  severity: "info" | "warning" | "error";
  key: string;
  firstAt: number;
  lastAt: number;
  count: number;
  readAt: number | null;
  problem: "none" | "active" | "resolved";
  resolvedAt: number | null;
  params: { reason?: "disk-full" | "permission" | "unknown"; paused?: number };
}
export interface AppEventSummary {
  active: number;
  unread: number;
  total: number;
  storage: "ready" | "unavailable";
}
export interface AppEventQuery {
  filter?: "all" | "problems" | "unread";
  cursor?: { at: number; id: string };
}
export interface AppEventPage {
  items: AppEvent[];
  next: AppEventQuery["cursor"] | null;
  summary: AppEventSummary;
}
export type AppEventTarget =
  { kind: "download" | "room"; id: string } | { kind: "settings" };
export type AppEventActionResult =
  | { ok: true; target?: AppEventTarget }
  | { ok: false; reason: "missing" | "not-available" | "busy" | "failed" };
export interface AppEventsApi {
  list: (query?: AppEventQuery) => Promise<AppEventPage>;
  summary: () => Promise<AppEventSummary>;
  read: (id: string | "all") => Promise<void>;
  run: (id: string, action: AppEventAction) => Promise<AppEventActionResult>;
  onChanged: (callback: () => void) => () => void;
}
export const APP_EVENT_LIMIT = 1000;
export const APP_EVENT_DAYS = 30;
export const APP_EVENT_PAGE_SIZE = 40;
export const validEventId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
export const eventKey = (code: AppEventCode, object: AppEventObject): string =>
  `${code}:${object.kind}:${object.kind === "system" ? "" : object.id}`;
export function eventActions(
  event: Pick<AppEvent, "code" | "object" | "problem">,
): AppEventAction[] {
  if (event.object.kind === "download")
    return event.code === "download-error" && event.problem === "active"
      ? ["open", "retry"]
      : ["open"];
  if (event.object.kind === "room") return ["open"];
  return ["settings"];
}
export function eventSeverity(code: AppEventCode): AppEvent["severity"] {
  return code === "download-error" || code === "settings-export-failed" || code === "automation-failed"
    ? "error"
    : code === "disk-low" || code === "room-disconnected"
      ? "warning"
      : "info";
}
export function validateEventQuery(input: unknown): AppEventQuery {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid event query");
  const query = input as AppEventQuery;
  if (
    query.filter !== undefined &&
    !["all", "problems", "unread"].includes(query.filter)
  )
    throw new Error("Invalid event filter");
  if (
    query.cursor !== undefined &&
    (!query.cursor ||
      typeof query.cursor !== "object" ||
      !validEventId(query.cursor.id) ||
      !Number.isSafeInteger(query.cursor.at) ||
      query.cursor.at < 0)
  )
    throw new Error("Invalid event cursor");
  return {
    filter: query.filter,
    ...(query.cursor
      ? { cursor: { at: query.cursor.at, id: query.cursor.id } }
      : {}),
  };
}
