import { DeviceVault } from "../../electron/devices/vault";
import {
  DeviceReplicator,
  type DeviceDataJob,
} from "../../electron/devices/replicator";
import { mediaRecordId } from "../../electron/devices/replica-state";
import {
  planDeviceTarget,
  deviceTargetContextStamp,
  applyDeviceTargetPlan,
  rollbackDeviceTargetPlan,
  type DeviceTargetContext,
  type DeviceTargetStorage,
} from "../../shared/device-data-target";
import { memoryDeviceStorage, activateDevices } from "./vault-fixture";
export function targetFixture(vault: DeviceVault) {
  const values = new Map<string, string>();
  let writes = 0;
  const faults = { after: Infinity, silent: false, read: false };
  const storage: DeviceTargetStorage = {
    getItem: (key) => {
      if (faults.read) throw Error("read");
      return values.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (writes >= faults.after) throw Error("write");
      writes++;
      if (!faults.silent) values.set(key, value);
    },
    removeItem: (key) => {
      if (writes >= faults.after) throw Error("write");
      writes++;
      if (!faults.silent) values.delete(key);
    },
  };
  const media = {
    infoHash: "a".repeat(40),
    path: "Series/E01.mkv",
    size: 10000,
  };
  const recordId = mediaRecordId(media);
  const context: DeviceTargetContext = {
    categories: {},
    categoryIds: [],
    media: [
      {
        ...media,
        recordId,
        identity: media.infoHash,
        downloadId: "local-" + vault.publicIdentity().deviceId.slice(0, 4),
        title: "Local title",
        fileIndex: 0,
      },
    ],
    activeMedia: [],
  };
  const guard = (job: DeviceDataJob) => {
    vault.guardSession(vault.sessionAccess(), job.scope);
    const op =
      vault.replicaState().records[job.scope + "/" + job.recordId].heads[0];
    if (deviceTargetContextStamp(op, context) !== job.plan.contextStamp)
      throw Error("context changed");
  };
  const target = {
    plan: async (op: Parameters<typeof planDeviceTarget>[1]) =>
      planDeviceTarget(storage, op, context),
    apply: async (job: DeviceDataJob) =>
      applyDeviceTargetPlan(storage, job.plan, () => guard(job)),
    rollback: async (job: DeviceDataJob) =>
      rollbackDeviceTargetPlan(storage, job.plan, () => {
        if (vault.pendingDataJob()?.heads !== job.heads) throw Error("stale");
      }),
  };
  return {
    values,
    storage,
    context,
    target,
    faults,
    media,
    recordId,
    writes: () => writes,
  };
}
export async function dataPair() {
  const sa = memoryDeviceStorage(),
    sb = memoryDeviceStorage("b".repeat(64)),
    a = await DeviceVault.initialize(sa.io()),
    b = await DeviceVault.initialize(sb.io());
  await activateDevices(a, b);
  const ta = targetFixture(a),
    tb = targetFixture(b),
    ra = new DeviceReplicator(a, ta.target),
    rb = new DeviceReplicator(b, tb.target);
  return {
    sa,
    sb,
    a,
    b,
    ta,
    tb,
    ra,
    rb,
    close: async () => {
      await ra.close();
      await rb.close();
      await a.close();
      await b.close();
    },
  };
}
