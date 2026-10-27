import {
  app,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  DeviceError,
  deviceObject,
  deviceScopes,
} from "../../shared/device-pairing";
import type {
  DeviceUiRequest,
  DeviceSnapshotDecision,
} from "../../shared/device-ui";
import type { DeviceTargetContext } from "../../shared/device-data-target";
import { validateDeviceMedia } from "../../shared/device-data";
import { DeviceUiService } from "../devices/ui-service";
import { deviceUiConfigFile } from "../devices/ui-config";
import { openDeviceVault } from "../devices/runtime";
import { attachDeviceRendererTarget } from "../devices/renderer-target";
import { deviceHash } from "../devices/identity";
import { mediaRecordId } from "../devices/replica-state";
import { deviceHost } from "../devices/network";
import * as db from "../db/store";
import type { HistoryPlayback } from "../services/history-playback";
import type { ExternalPlayer } from "../services/external-player";

export function validateDeviceUiRequest(
  raw: unknown,
): DeviceUiRequest | DeviceSnapshotDecision {
  const shapes: Record<string, string[]> = {
    enable: ["enabled"],
    configure: ["listen", "remote", "scopes"],
    invite: [],
    join: ["text"],
    confirm: ["id", "accept"],
    approve: ["grant"],
    revoke: [],
    cancel: [],
    reconnect: [],
    narrow: ["scopes"],
    "map-category": ["source", "target"],
    preview: ["scope", "recordId", "author", "sequence", "local"],
    resolve: [
      "scope",
      "recordId",
      "author",
      "sequence",
      "local",
      "heads",
      "beforeStamp",
    ],
    snapshot: [],
    reset: ["confirmation"],
    "accept-snapshot": ["id", "accept"],
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new DeviceError("invalid");
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !Object.hasOwn(shapes, kind))
    throw new DeviceError("invalid");
  const allowed = ["kind", ...shapes[kind]],
    optional = ["preview", "resolve"].includes(kind)
      ? ["author", "sequence", "local"]
      : [];
  if (
    Object.keys(raw).some((k) => !allowed.includes(k)) ||
    allowed.some((k) => !optional.includes(k) && !Object.hasOwn(raw, k))
  )
    throw new DeviceError("invalid");
  const r = deviceObject(raw, Object.keys(raw));
  for (const [k, v] of Object.entries(r)) {
    if (v === undefined && ["author", "sequence", "local"].includes(k))
      continue;
    if (["enabled", "accept", "local"].includes(k) && typeof v !== "boolean")
      throw new DeviceError("invalid");
    if (
      [
        "id",
        "grant",
        "source",
        "target",
        "text",
        "recordId",
        "heads",
        "beforeStamp",
        "confirmation",
        "author",
      ].includes(k) &&
      (typeof v !== "string" ||
        v.length > (k === "text" ? 20000 : k === "beforeStamp" ? 8192 : 256))
    )
      throw new DeviceError("invalid");
    if (k === "sequence" && (!Number.isSafeInteger(v) || (v as number) < 1))
      throw new DeviceError("invalid");
  }
  if (r.scopes !== undefined) deviceScopes(r.scopes);
  if (r.scope !== undefined) deviceScopes([r.scope]);
  return r as unknown as DeviceUiRequest | DeviceSnapshotDecision;
}

let activeService: DeviceUiService | null = null;
export async function closeDeviceUi() {
  await activeService?.close();
  activeService = null;
}

export function registerDeviceUi(
  window: BrowserWindow,
  history: HistoryPlayback,
  external: ExternalPlayer,
) {
  const profile = app.getPath("userData"),
    directory = path.join(profile, "devices");
  let active: Array<{ identity: string; path: string }> = [];
  let media: Array<DeviceTargetContext["media"][number] & { disk: string }> =
    [];
  let refreshed = 0;
  let notification: ReturnType<typeof setTimeout> | null = null;
  const addresses = () => [
    ...new Set([
      "127.0.0.1",
      ...Object.values(os.networkInterfaces()).flatMap((list) =>
        (list ?? []).flatMap((n) => {
          try {
            return n.family === "IPv4" ? [deviceHost(n.address)] : [];
          } catch {
            return [];
          }
        }),
      ),
    ]),
  ];
  const context = (): DeviceTargetContext => {
    const categories = db.store.get("categories"),
      self = service.state().self;
    const exportCategories = Object.fromEntries(
      categories.map((c) => [
        c.id,
        deviceHash(JSON.stringify(["havvn/device-category/v1", self, c.id])),
      ]),
    );
    const playing = external.activeTargets();
    const local = media.filter((f) => {
      try {
        const s = fs.statSync(f.disk);
        return s.isFile() && s.size === f.size;
      } catch {
        return false;
      }
    });
    return {
      exportCategories,
      categoryIds: categories.map((c) => c.id),
      categories: {
        ...service.configuration().categories,
        ...Object.fromEntries(
          Object.entries(exportCategories).map(([k, v]) => [v, k]),
        ),
      },
      media: local.map(({ disk: _disk, ...f }) => f),
      activeMedia: local
        .filter(
          (f) =>
            active.some(
              (a) => a.identity === f.identity && a.path === f.path,
            ) ||
            playing.some(
              (p) => p.downloadId === '*' || (p.downloadId === f.downloadId && p.path === f.path),
            ),
        )
        .map((f) => f.recordId),
    };
  };
  const service = new DeviceUiService({
    config: deviceUiConfigFile(path.join(profile, "device-pairing.json")),
    hasVault: () => fs.existsSync(directory),
    open: (initialize) => {
      if (!app.hasSingleInstanceLock() && !app.requestSingleInstanceLock())
        throw new DeviceError("state");
      return openDeviceVault({ initialize });
    },
    archive: async () => {
      if (!app.hasSingleInstanceLock() && !app.requestSingleInstanceLock())
        throw new DeviceError("state");
      if (!fs.existsSync(directory)) return;
      const root = fs.realpathSync.native(profile),
        source = fs.realpathSync.native(directory);
      if (
        fs.lstatSync(directory).isSymbolicLink() ||
        path.dirname(source).toLowerCase() !== root.toLowerCase()
      )
        throw new DeviceError("clone");
      const destination = path.join(root, "devices-archive-" + randomUUID());
      fs.renameSync(source, destination);
    },
    renderer: (vault) =>
      attachDeviceRendererTarget(vault, window.webContents, context),
    refresh: async () => {
      if (
        !service.configuration().scopes.includes("playback") ||
        Date.now() - refreshed < 15000
      )
        return;
      const next: typeof media = [];
      for (const d of (await db.getAllDownloads())
        .filter((d) => d.infoHash && d.status !== "removed")
        .slice(0, 50)) {
        for (const f of await history.deviceFiles(
          d.id,
          Math.min(100, 500 - next.length),
        )) {
          try {
            const m = validateDeviceMedia({
              infoHash: f.infoHash,
              path: f.path,
              size: f.size,
            });
            next.push({ ...f, recordId: mediaRecordId(m) });
          } catch {
            /* Unusable identities stay outside the sync allowlist. */
          }
        }
        if (next.length >= 500) break;
      }
      media = next;
      refreshed = Date.now();
    },
    addresses,
    changed: () => {
      if (notification) return;
      notification = setTimeout(() => {
        notification = null;
        if (!window.isDestroyed()) window.webContents.send("devices:changed");
      }, 100);
    },
  });
  activeService = service;
  const owns = (e: IpcMainInvokeEvent) => {
    if (e.sender !== window.webContents || e.senderFrame !== e.sender.mainFrame)
      throw new DeviceError("peer");
  };
  for (const channel of ["devices:state", "devices:start", "devices:command"])
    ipcMain.removeHandler(channel);
  ipcMain.handle("devices:state", (e) => {
    owns(e);
    return service.state();
  });
  ipcMain.handle("devices:start", (e) => {
    owns(e);
    return service.start();
  });
  ipcMain.handle("devices:command", (e, r: unknown) => {
    owns(e);
    return service.command(validateDeviceUiRequest(r));
  });
  const dirty = (e: Electron.IpcMainEvent) => {
    if (e.sender === window.webContents && e.senderFrame === e.sender.mainFrame)
      service.localChanged();
  };
  const playing = (e: Electron.IpcMainEvent, raw: unknown) => {
    if (e.sender !== window.webContents || e.senderFrame !== e.sender.mainFrame)
      return;
    if (
      !Array.isArray(raw) ||
      raw.length > 64 ||
      raw.some(
        (r) =>
          !r ||
          typeof r.identity !== "string" ||
          r.identity.length > 128 ||
          typeof r.path !== "string" ||
          r.path.length > 1024,
      )
    )
      return;
    active = raw.map((r) => ({ identity: r.identity, path: r.path }));
    service.localChanged();
  };
  ipcMain.on("devices:localChanged", dirty);
  ipcMain.on("devices:activeMedia", playing);
  window.once("closed", () => {
    if (notification) clearTimeout(notification);
    ipcMain.off("devices:localChanged", dirty);
    ipcMain.off("devices:activeMedia", playing);
    void service.close();
    if (activeService === service) activeService = null;
  });
  return service;
}
