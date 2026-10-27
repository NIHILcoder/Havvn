import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DeviceError,
  deviceObject,
  deviceScopes,
} from "../../shared/device-pairing";
import type { DeviceUiConfig } from "../../shared/device-ui";
import { deviceHost, devicePort } from "./network";
export const emptyDeviceUiConfig = (): DeviceUiConfig => ({
  version: 1,
  enabled: false,
  listen: { host: "127.0.0.1", port: 47841 },
  remote: null,
  scopes: ["preferences"],
  categories: {},
});
export function validateDeviceUiConfig(raw: unknown): DeviceUiConfig {
  const c = deviceObject(raw, [
    "version",
    "enabled",
    "listen",
    "remote",
    "scopes",
    "categories",
  ]);
  if (
    c.version !== 1 ||
    typeof c.enabled !== "boolean" ||
    !c.categories ||
    typeof c.categories !== "object" ||
    Array.isArray(c.categories) ||
    Object.keys(c.categories).length > 256
  )
    throw new DeviceError("invalid");
  const endpoint = (raw: unknown, zero = false) => {
    const e = deviceObject(raw, ["host", "port"]);
    return { host: deviceHost(e.host), port: devicePort(e.port, zero) };
  };
  const categories: Record<string, string> = {};
  for (const [key, value] of Object.entries(c.categories)) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(key) ||
      typeof value !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value) ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      throw new DeviceError("invalid");
    categories[key] = value;
  }
  return {
    version: 1,
    enabled: c.enabled,
    listen: endpoint(c.listen, true),
    remote: c.remote === null ? null : endpoint(c.remote),
    scopes: deviceScopes(c.scopes),
    categories,
  };
}
export interface DeviceUiConfigIo {
  read(): DeviceUiConfig;
  write(config: DeviceUiConfig): void;
}
export function deviceUiConfigFile(file: string): DeviceUiConfigIo {
  const read = () => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
        throw new DeviceError("invalid");
      return validateDeviceUiConfig(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyDeviceUiConfig();
      throw new DeviceError("storage");
    }
  };
  return {
    read,
    write: (config) => {
      const checked = validateDeviceUiConfig(config),
        text = JSON.stringify(checked),
        temporary = path.join(
          path.dirname(file),
          ".device-ui-" + randomUUID() + ".tmp",
        );
      let created = false;
      try {
        const fd = fs.openSync(temporary, "wx", 0o600);
        created = true;
        try {
          fs.writeFileSync(fd, text);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temporary, file);
        if (JSON.stringify(read()) !== text) throw new DeviceError("storage");
      } catch {
        throw new DeviceError("storage");
      } finally {
        if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    },
  };
}
