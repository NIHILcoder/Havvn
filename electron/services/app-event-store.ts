import { randomUUID } from "node:crypto";
import {
  APP_EVENT_CODES,
  APP_EVENT_DAYS,
  APP_EVENT_LIMIT,
  APP_EVENT_PAGE_SIZE,
  eventKey,
  eventSeverity,
  validEventId,
  validateEventQuery,
  type AppEvent,
  type AppEventCode,
  type AppEventObject,
  type AppEventPage,
  type AppEventSummary,
} from "../../shared/app-events";

interface EventState {
  version: 1;
  events: AppEvent[];
}
export interface EventStorage {
  read: () => unknown;
  write: (state: EventState) => void;
}
const time = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8_640_000_000_000_000;
const unread = (event: AppEvent): boolean =>
  event.readAt === null || event.readAt < event.lastAt;
function validEvent(input: AppEvent): boolean {
  if (
    !input ||
    !validEventId(input.id) ||
    !APP_EVENT_CODES.includes(input.code) ||
    !input.object
  )
    return false;
  const object = input.object;
  if (
    object.kind !== "system" &&
    (!["download", "room"].includes(object.kind) || !validEventId(object.id))
  )
    return false;
  const requiredKind = input.code.startsWith("download-") || input.code.startsWith("automation-")
    ? "download"
    : input.code === "room-disconnected"
      ? "room"
      : "system";
  return (
    object.kind === requiredKind &&
    input.key === eventKey(input.code, object) &&
    input.severity === eventSeverity(input.code) &&
    time(input.firstAt) &&
    time(input.lastAt) &&
    input.firstAt <= input.lastAt &&
    Number.isSafeInteger(input.count) &&
    input.count > 0 &&
    input.count <= 1_000_000 &&
    (input.readAt === null || time(input.readAt)) &&
    (input.resolvedAt === null || time(input.resolvedAt)) &&
    ["none", "active", "resolved"].includes(input.problem) &&
    !!input.params
  );
}

export class AppEventStore {
  private events: AppEvent[] = [];
  private writable = true;
  private storage: AppEventSummary["storage"] = "ready";
  private listeners = new Set<() => void>();
  constructor(
    private io: EventStorage,
    private now: () => number = Date.now,
  ) {
    try {
      const raw = io.read();
      if (raw !== null && raw !== undefined) {
        const state = raw as EventState;
        if (
          state.version !== 1 ||
          !Array.isArray(state.events) ||
          state.events.length > APP_EVENT_LIMIT ||
          !state.events.every(validEvent)
        )
          throw new Error("Invalid event history");
        if (
          new Set(state.events.map((e) => e.id)).size !== state.events.length ||
          new Set(state.events.map((e) => e.key)).size !== state.events.length
        )
          throw new Error("Duplicate event history");
        // Explicit projection also discards unknown or formerly sensitive properties.
        this.events = state.events.map((e) => ({
          id: e.id,
          code: e.code,
          object:
            e.object.kind === "system"
              ? { kind: "system" }
              : { kind: e.object.kind, id: e.object.id },
          severity: e.severity,
          key: e.key,
          firstAt: e.firstAt,
          lastAt: e.lastAt,
          count: e.count,
          readAt: e.readAt,
          problem: e.problem,
          resolvedAt: e.resolvedAt,
          params: this.params(e.params),
        }));
      }
    } catch {
      this.writable = false;
      this.storage = "unavailable";
    }
    this.prune();
  }
  private params(params: AppEvent["params"]): AppEvent["params"] {
    return {
      ...(["disk-full", "permission", "unknown"].includes(params.reason ?? "")
        ? { reason: params.reason }
        : {}),
      ...(typeof params.paused === "number" && Number.isFinite(params.paused)
        ? {
            paused: Math.min(1_000_000, Math.max(0, Math.floor(params.paused))),
          }
        : {}),
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private save(): void {
    if (this.writable) {
      try {
        this.io.write({ version: 1, events: this.events });
        this.storage = "ready";
      } catch {
        this.storage = "unavailable";
      }
    }
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        /* windows may close */
      }
    });
  }
  private prune(): void {
    const cutoff = this.now() - APP_EVENT_DAYS * 86400_000;
    const retained = this.events
      .filter((e) => e.lastAt >= cutoff && e.lastAt <= this.now() + 60_000)
      .sort((a, b) => b.lastAt - a.lastAt || b.id.localeCompare(a.id))
      .slice(0, APP_EVENT_LIMIT);
    if (retained.length !== this.events.length) {
      this.events = retained;
      this.save();
    } else this.events = retained;
  }
  record(
    code: AppEventCode,
    object: AppEventObject,
    params: AppEvent["params"] = {},
  ): void {
    const kind = code.startsWith("download-") || code.startsWith("automation-")
      ? "download"
      : code === "room-disconnected"
        ? "room"
        : "system";
    if (
      !APP_EVENT_CODES.includes(code) ||
      object.kind !== kind ||
      (object.kind !== "system" && !validEventId(object.id))
    )
      return;
    this.prune();
    const at = this.now(),
      key = eventKey(code, object),
      previous = this.events.find((e) => e.key === key);
    const problem = eventSeverity(code) === "info" ? "none" : "active";
    const entry: AppEvent = {
      id: previous?.id ?? randomUUID(),
      code,
      object:
        object.kind === "system"
          ? { kind: "system" }
          : { kind: object.kind, id: object.id },
      severity: eventSeverity(code),
      key,
      firstAt: previous?.firstAt ?? at,
      lastAt: at,
      count: Math.min(1_000_000, (previous?.count ?? 0) + 1),
      readAt: null,
      problem,
      resolvedAt: null,
      params: this.params(params),
    };
    this.events = [entry, ...this.events.filter((e) => e.key !== key)].slice(
      0,
      APP_EVENT_LIMIT,
    );
    this.save();
  }
  resolve(code: AppEventCode, object: AppEventObject): void {
    const entry = this.events.find((e) => e.key === eventKey(code, object));
    if (!entry || entry.problem !== "active") return;
    entry.problem = "resolved";
    entry.resolvedAt = this.now();
    this.save();
  }
  isActive(code: AppEventCode, object: AppEventObject): boolean {
    return this.events.some(
      (e) => e.key === eventKey(code, object) && e.problem === "active",
    );
  }
  reconcileObjects(kind: "download" | "room", ids: ReadonlySet<string>): void {
    let changed = false;
    for (const event of this.events)
      if (
        event.problem === "active" &&
        event.object.kind === kind &&
        !ids.has(event.object.id)
      ) {
        event.problem = "resolved";
        event.resolvedAt = this.now();
        changed = true;
      }
    if (changed) this.save();
  }
  get(id: string): AppEvent | undefined {
    this.prune();
    const event = this.events.find((e) => e.id === id);
    return event ? structuredClone(event) : undefined;
  }
  summary(): AppEventSummary {
    this.prune();
    return {
      active: this.events.filter((e) => e.problem === "active").length,
      unread: this.events.filter(unread).length,
      total: this.events.length,
      storage: this.storage,
    };
  }
  read(id: string | "all"): void {
    if (id !== "all" && !validEventId(id)) throw new Error("Invalid event ID");
    let changed = false;
    for (const event of this.events)
      if ((id === "all" || event.id === id) && unread(event)) {
        event.readAt = Math.max(this.now(), event.lastAt);
        changed = true;
      }
    if (changed) this.save();
  }
  list(input?: unknown): AppEventPage {
    const query = validateEventQuery(input),
      summary = this.summary();
    const matched = this.events.filter(
      (e) =>
        (query.filter !== "problems" || e.problem === "active") &&
        (query.filter !== "unread" || unread(e)) &&
        (!query.cursor ||
          e.lastAt < query.cursor.at ||
          (e.lastAt === query.cursor.at &&
            e.id.localeCompare(query.cursor.id) < 0)),
    );
    const items = matched.slice(0, APP_EVENT_PAGE_SIZE),
      last = items[items.length - 1];
    return {
      items: structuredClone(items),
      next:
        matched.length > items.length && last
          ? { at: last.lastAt, id: last.id }
          : null,
      summary,
    };
  }
}
