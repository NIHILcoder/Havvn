import {
  eventActions,
  validEventId,
  type AppEventAction,
  type AppEventActionResult,
} from "../../shared/app-events";
import type { Download } from "../../shared/types";
import type { AppEventStore } from "./app-event-store";

export class AppEventActions {
  private running = new Set<string>();
  constructor(
    private store: AppEventStore,
    private deps: {
      getDownload: (id: string) => Promise<Download | null>;
      getRoomIds: () => Promise<string[]>;
      retry: (id: string) => Promise<unknown>;
    },
  ) {}
  async run(id: unknown, action: unknown): Promise<AppEventActionResult> {
    if (!validEventId(id)) return { ok: false, reason: "missing" };
    if (this.running.has(id)) return { ok: false, reason: "busy" };
    this.running.add(id);
    try {
      const event = this.store.get(id);
      if (!event) return { ok: false, reason: "missing" };
      if (!eventActions(event).includes(action as AppEventAction))
        return { ok: false, reason: "not-available" };
      if (action === "settings") {
        this.store.read(id);
        return { ok: true, target: { kind: "settings" } };
      }
      if (event.object.kind === "download") {
        const download = await this.deps.getDownload(event.object.id);
        if (!download || download.status === "removed") {
          this.store.resolve(event.code, event.object);
          return { ok: false, reason: "missing" };
        }
        if (action === "retry") {
          if (download.status !== "error")
            return { ok: false, reason: "not-available" };
          await this.deps.retry(download.id);
          this.store.read(id);
          return { ok: true };
        }
        this.store.read(id);
        return { ok: true, target: { kind: "download", id: download.id } };
      }
      if (event.object.kind === "room") {
        if (!(await this.deps.getRoomIds()).includes(event.object.id)) {
          this.store.resolve(event.code, event.object);
          return { ok: false, reason: "missing" };
        }
        this.store.read(id);
        return { ok: true, target: { kind: "room", id: event.object.id } };
      }
      return { ok: false, reason: "not-available" };
    } catch {
      return { ok: false, reason: "failed" };
    } finally {
      this.running.delete(id);
    }
  }
}
