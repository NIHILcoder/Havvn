import type { Download, RoomState } from "../../shared/types";
import type { AppEventStore } from "./app-event-store";

export function downloadErrorReason(
  message: string | null | undefined,
): "disk-full" | "permission" | "unknown" {
  if (/enospc|no space|disk.*full/i.test(message ?? "")) return "disk-full";
  if (/eacces|eperm|permission|read.only/i.test(message ?? ""))
    return "permission";
  return "unknown";
}

/** Only transitions reach storage; progress/speed/peer statistics never do. */
export class AppEventSources {
  private downloads = new Map<string, string>();
  private rooms = new Map<string, boolean>();
  constructor(private store: AppEventStore) {}
  download(download: Pick<Download, "id" | "status" | "lastError">): void {
    const { id, status } = download,
      previous = this.downloads.get(id),
      object = { kind: "download" as const, id };
    this.downloads.set(id, status);
    if (
      status === "error" &&
      previous !== "error" &&
      (previous !== undefined || !this.store.isActive("download-error", object))
    )
      this.store.record("download-error", object, {
        reason: downloadErrorReason(download.lastError),
      });
    else if (
      ["downloading", "seeding", "completed", "removed"].includes(status)
    )
      this.store.resolve("download-error", object);
    if (status === "removed") this.downloads.delete(id);
  }
  complete(id: string): void {
    const object = { kind: "download" as const, id };
    this.store.resolve("download-error", object);
    this.store.record("download-complete", object);
  }
  room(state: Pick<RoomState, "roomId" | "connection">): void {
    const { roomId: id, connection } = state;
    if (!connection) return;
    const object = { kind: "room" as const, id };
    if (connection.phase === "removed") {
      this.store.resolve("room-disconnected", object);
      this.rooms.delete(id);
      return;
    }
    const online = connection.channels.identified > 0;
    if (online) this.store.resolve("room-disconnected", object);
    else if (
      (this.rooms.get(id) || connection.lastConnectedAt) &&
      !this.store.isActive("room-disconnected", object)
    )
      this.store.record("room-disconnected", object);
    this.rooms.set(id, online);
  }
  removed(kind: "download" | "room", id: string): void {
    this.store.resolve(
      kind === "download" ? "download-error" : "room-disconnected",
      { kind, id },
    );
    if (kind === "room") this.rooms.delete(id);
    else this.downloads.delete(id);
  }
}
