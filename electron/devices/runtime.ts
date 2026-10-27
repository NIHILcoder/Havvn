import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import {
  encryptSecret,
  decryptSecretStrict,
  isEncryptionAvailable,
} from "../db/secrets";
import { DeviceError } from "../../shared/device-pairing";
import { deviceFilePersistence } from "./file-persistence";
import { DeviceVault } from "./vault";
/** Explicit backend entry point for DP-02; never called during normal startup.
 * It is not part of preload/IPC, settings transfer or the room identity store.
 */
export async function openDeviceVault(
  options: { initialize?: boolean; directory?: string } = {},
): Promise<DeviceVault> {
  if (process.type !== "browser" || !app.hasSingleInstanceLock())
    throw new DeviceError("state");
  if (!isEncryptionAvailable()) throw new DeviceError("locked");
  const profile = fs.realpathSync.native(app.getPath("userData")),
    directory = path.resolve(
      options.directory ?? path.join(profile, "devices"),
    );
  const within = (value: string) => {
    const relative = path.relative(profile, value);
    return (
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep)
    );
  };
  if (!within(directory)) throw new DeviceError("clone");
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new DeviceError("storage");
    ancestor = parent;
  }
  if (!within(fs.realpathSync.native(ancestor))) throw new DeviceError("clone");
  const io = deviceFilePersistence(
    directory,
    {
      protect: (plain) => encryptSecret(plain, false),
      unprotect: decryptSecretStrict,
    },
    options.initialize === true,
  );
  return options.initialize ? DeviceVault.initialize(io) : DeviceVault.open(io);
}
