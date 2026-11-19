import { isIP } from "node:net";
import { DeviceError } from "../../shared/device-pairing";
export function deviceHost(host: unknown): string {
  if (typeof host !== "string" || isIP(host) !== 4)
    throw new DeviceError("invalid");
  const p = host.split(".").map(Number);
  if (!(
    p[0] === 127 ||
    p[0] === 10 ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
  ))
    throw new DeviceError("invalid");
  return host;
}
export function devicePort(port: unknown, zero = false): number {
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < (zero ? 0 : 1) ||
    port > 65535
  )
    throw new DeviceError("invalid");
  return port;
}
