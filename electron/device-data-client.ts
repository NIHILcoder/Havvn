import {
  DeviceError,
  deviceObject,
  validateDeviceOperation,
} from "../shared/device-pairing";
import {
  planDeviceTarget,
  applyDeviceTargetPlan,
  rollbackDeviceTargetPlan,
  validateDeviceTargetPlan,
  type DeviceTargetStorage,
  type DeviceTargetContext,
} from "../shared/device-data-target";
import { captureDeviceLocal } from "../shared/device-capture";
interface Bridge {
  on(
    channel: string,
    listener: (_event: unknown, request: unknown) => void,
  ): void;
  removeListener(
    channel: string,
    listener: (_event: unknown, request: unknown) => void,
  ): void;
  send(channel: string, result: unknown): void;
  sendSync(channel: string, request: unknown): unknown;
}
/** Explicit preload endpoint. It exposes no arbitrary storage API to the page. */
export function attachDeviceDataClient(
  bridge: Bridge,
  storage: DeviceTargetStorage,
  onChanged: (keys: string[]) => void = () => {},
) {
  const listener = (_event: unknown, raw: unknown) => {
    let id: unknown;
    try {
      const r = deviceObject(raw, [
        "version",
        "id",
        "kind",
        "operation",
        "job",
        "context",
      ]);
      id = r.id;
      if (
        r.version !== 1 ||
        typeof id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(id) ||
        !["plan", "apply", "rollback", "capture"].includes(r.kind as string)
      )
        throw new DeviceError("invalid");
      let value: unknown = true;
      if (r.kind === "capture") {
        const request = deviceObject(r.operation, ["scopes"]);
        value = captureDeviceLocal(
          storage,
          request.scopes as import("../shared/device-pairing").DeviceScope[],
          r.context as DeviceTargetContext,
          () => crypto.randomUUID().replace(/-/g, ""),
          () => {
            if (
              bridge.sendSync("devices:data:authorize", {
                id,
                heads: null,
                kind: "capture",
              }) !== true
            )
              throw new DeviceError("revoked");
          },
        );
      } else if (r.kind === "plan")
        value = planDeviceTarget(
          storage,
          validateDeviceOperation(r.operation),
          r.context as DeviceTargetContext,
        );
      else {
        const j = deviceObject(r.job, ["scope", "recordId", "heads", "plan"]),
          plan = validateDeviceTargetPlan(j.plan);
        const guard = () => {
          const allowed = bridge.sendSync("devices:data:authorize", {
            id,
            heads: j.heads,
            kind: r.kind,
          });
          if (allowed !== true) throw new DeviceError("revoked");
        };
        if (r.kind === "apply") applyDeviceTargetPlan(storage, plan, guard);
        else rollbackDeviceTargetPlan(storage, plan, guard);
        onChanged(plan.writes.map((w) => w.key));
      }
      bridge.send("devices:data:result", { id, ok: true, value });
    } catch (error) {
      bridge.send("devices:data:result", {
        id,
        ok: false,
        code: error instanceof DeviceError ? error.code : "storage",
      });
    }
  };
  bridge.on("devices:data:request", listener);
  return () => bridge.removeListener("devices:data:request", listener);
}
