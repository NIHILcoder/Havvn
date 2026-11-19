import { randomUUID } from "node:crypto";
import { ipcMain, type WebContents, type IpcMainEvent } from "electron";
import { DeviceError, type DeviceOperation } from "../../shared/device-pairing";
import {
  validateDeviceTargetPlan,
  deviceTargetContextStamp,
  type DeviceTargetContext,
} from "../../shared/device-data-target";
import { type DeviceDataTarget, type DeviceDataJob } from "./replicator";
import { DeviceVault } from "./vault";
import { deviceHash } from "./identity";
import type { DeviceCapture } from "../../shared/device-ui";
/** Called explicitly with the trusted main frame; no registration on ordinary startup. */
export function attachDeviceRendererTarget(
  vault: DeviceVault,
  contents: WebContents,
  context: () => DeviceTargetContext,
): DeviceDataTarget & {
  capture(
    scopes: import("../../shared/device-pairing").DeviceScope[],
  ): Promise<DeviceCapture>;
  close(): void;
} {
  const pending = new Map<
    string,
    {
      kind: string;
      heads: string | null;
      jobHash: string | null;
      resolve(value: unknown): void;
      reject(error: DeviceError): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let closed = false;
  const owns = (event: IpcMainEvent) =>
    event.sender === contents && event.senderFrame === contents.mainFrame;
  const result = (event: IpcMainEvent, raw: unknown) => {
    if (!owns(event) || !raw || typeof raw !== "object") return;
    const r = raw as { id: string; ok: boolean; value: unknown; code: string };
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    clearTimeout(p.timer);
    if (r.ok === true) p.resolve(r.value);
    else
      p.reject(
        new DeviceError(
          ["stale", "revoked", "quota", "invalid"].includes(r.code)
            ? (r.code as "stale")
            : "storage",
        ),
      );
  };
  const authorize = (event: IpcMainEvent, raw: unknown) => {
    if (event.sender !== contents) return;
    if (event.senderFrame !== contents.mainFrame) {
      event.returnValue = false;
      return;
    }
    let allowed = false;
    try {
      const r = raw as { id: string; heads: string; kind: string },
        p = pending.get(r.id),
        job = vault.pendingDataJob();
      if (p?.kind === "capture" && r.kind === "capture") {
        vault.sessionAccess();
        allowed = true;
        return;
      }
      if (
        !p ||
        !job ||
        p.heads !== r.heads ||
        p.jobHash !== deviceHash(JSON.stringify(job)) ||
        job.heads !== r.heads ||
        p.kind !== r.kind ||
        !["apply", "rollback"].includes(r.kind)
      )
        return;
      if (r.kind === "apply") {
        vault.guardSession(vault.sessionAccess(), job.scope);
        const record =
          vault.replicaState().records[job.scope + "/" + job.recordId];
        if (
          !record ||
          record.heads.length !== 1 ||
          deviceTargetContextStamp(record.heads[0], context()) !==
            job.plan.contextStamp
        )
          return;
      }
      // Rollback is permitted only for this still-owned journal, using its exact stored
      // before/after patch. It cannot apply another network value while access is paused.
      allowed = true;
    } catch {
      allowed = false;
    } finally {
      event.returnValue = allowed;
    }
  };
  ipcMain.on("devices:data:result", result);
  ipcMain.on("devices:data:authorize", authorize);
  const request = (
    kind: string,
    operation:
      | DeviceOperation
      | { scopes: import("../../shared/device-pairing").DeviceScope[] }
      | null,
    job: DeviceDataJob | null,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed || contents.isDestroyed() || pending.size >= 4) {
        reject(new DeviceError("state"));
        return;
      }
      const id = randomUUID(),
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new DeviceError("storage"));
        }, 10000);
      pending.set(id, {
        kind,
        heads: job?.heads ?? null,
        jobHash: job ? deviceHash(JSON.stringify(job)) : null,
        resolve,
        reject,
        timer,
      });
      try {
        contents.send("devices:data:request", {
          version: 1,
          id,
          kind,
          operation,
          job,
          context: kind === "plan" || kind === "capture" ? context() : null,
        });
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(new DeviceError("storage"));
      }
    });
  return {
    capture: async (scopes) => {
      const raw = await request("capture", { scopes }, null);
      if (
        !raw ||
        typeof raw !== "object" ||
        !Array.isArray((raw as DeviceCapture).records) ||
        !Array.isArray((raw as DeviceCapture).issues) ||
        (raw as DeviceCapture).records.length > 256 ||
        (raw as DeviceCapture).issues.length > 256
      )
        throw new DeviceError("invalid");
      return raw as DeviceCapture;
    },
    plan: async (op) =>
      validateDeviceTargetPlan(await request("plan", op, null)),
    apply: async (job) => {
      if ((await request("apply", null, job)) !== true)
        throw new DeviceError("storage");
    },
    rollback: async (job) => {
      if ((await request("rollback", null, job)) !== true)
        throw new DeviceError("storage");
    },
    close: () => {
      closed = true;
      ipcMain.removeListener("devices:data:result", result);
      ipcMain.removeListener("devices:data:authorize", authorize);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new DeviceError("state"));
      }
      pending.clear();
    },
  };
}
