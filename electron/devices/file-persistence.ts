import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DeviceError } from "../../shared/device-pairing";
import { deviceHash } from "./identity";
import type { DeviceVaultStorage } from "./vault";
const owners = new Set<string>();
const MAX_BYTES = 16 * 1024 * 1024;
/** The app's existing single-instance lock remains the cross-process owner.
 * This lease prevents two independent vault handles inside that main process.
 */
export function deviceFilePersistence(
  directory: string,
  crypto: Pick<DeviceVaultStorage, "protect" | "unprotect">,
  initialize = false,
): DeviceVaultStorage {
  if (!path.isAbsolute(directory)) throw new DeviceError("invalid");
  if (initialize) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let root: string;
  try {
    root = fs.realpathSync.native(directory);
  } catch {
    throw new DeviceError("missing");
  }
  if (owners.has(root)) throw new DeviceError("state");
  owners.add(root);
  try {
    const stat = fs.statSync(root, { bigint: true });
    if (!stat.isDirectory()) throw new DeviceError("invalid");
    const binding = deviceHash(
      JSON.stringify([
        "havvn/device-profile/v1",
        process.platform,
        root,
        stat.dev.toString(),
        stat.ino.toString(),
      ]),
    );
    const file = path.join(root, "device-state.json"),
      marker = path.join(root, "device-state.marker");
    let closed = false;
    const readFile = (target: string, max: number): string | null => {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new DeviceError("storage");
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
        throw new DeviceError("invalid");
      return fs.readFileSync(target, "utf8");
    };
    const guard = () => {
      if (closed) throw new DeviceError("state");
    };
    const read = () => {
      guard();
      const markerValue = readFile(marker, 1024),
        value = readFile(file, MAX_BYTES);
      if (markerValue === null && value === null) return null;
      if (
        markerValue !== JSON.stringify({ version: 1, binding }) ||
        value === null
      )
        throw new DeviceError(
          markerValue && value === null ? "missing" : "clone",
        );
      return value;
    };
    // Reject moved/copied/partially initialized state before generating any key.
    read();
    const syncedWrite = (
      target: string,
      value: string,
      created?: () => void,
    ) => {
      const fd = fs.openSync(target, "wx", 0o600);
      created?.();
      try {
        fs.writeFileSync(fd, value, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    };
    return {
      binding,
      ...crypto,
      read,
      write: (expected, next) => {
        guard();
        if (Buffer.byteLength(next) > MAX_BYTES) throw new DeviceError("size");
        if (read() !== expected) throw new DeviceError("stale");
        const temporary = path.join(root, `.device-state-${randomUUID()}.tmp`);
        let created = false;
        try {
          syncedWrite(temporary, next, () => {
            created = true;
          });
          if (read() !== expected) throw new DeviceError("stale");
          if (expected === null) {
            syncedWrite(marker, JSON.stringify({ version: 1, binding }));
            fs.linkSync(temporary, file);
          } else fs.renameSync(temporary, file);
          // File data is fsynced before atomic publication. Directory fsync is
          // attempted where the platform supports it; this is not a power-cut test.
          if (process.platform !== "win32") {
            const fd = fs.openSync(root, "r");
            try {
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
          }
        } finally {
          if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
      },
      close: () => {
        if (!closed) {
          closed = true;
          owners.delete(root);
        }
      },
    };
  } catch (error) {
    owners.delete(root);
    if (error instanceof DeviceError) throw error;
    throw new DeviceError("storage");
  }
}
