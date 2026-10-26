import { inspect } from "node:util";
import {
  DeviceError,
  deviceObject,
  validateDeviceOperation,
  validateDeviceAck,
  validateDevicePrepared,
  type DeviceOperation,
  type DeviceAck,
} from "../../shared/device-pairing";
import { DeviceVault } from "./vault";
import { DeviceWire } from "./wire";
import { connectDevice, listenDevice } from "./transport";
import {
  validateDeviceSnapshot,
  type DeviceDataSnapshot,
} from "./replica-state";

type Access = ReturnType<DeviceVault["sessionAccess"]>;
function watch(vault: DeviceVault, access: Access, wire: DeviceWire) {
  return vault.onAccessChange(() => {
    try {
      vault.guardSession(access, undefined, true);
    } catch {
      wire.close("revoked");
    }
  });
}
async function ready(
  vault: DeviceVault,
  access: Access,
  wire: DeviceWire,
  server: boolean,
) {
  const unsubscribe = watch(vault, access, wire);
  try {
    vault.guardSession(access, undefined, true);
    // Both saved approvals are required even when recovering a lost final bootstrap reply.
    const receipt = vault.preparedReceipt();
    if (!server)
      await wire.write(receipt, () =>
        vault.guardSession(access, undefined, true),
      );
    const peerReceipt = validateDevicePrepared(await wire.read());
    if (server)
      await wire.write(receipt, () =>
        vault.guardSession(access, undefined, true),
      );
    await vault.activate(peerReceipt);
    const frame = {
      version: 1,
      protocol: 2,
      kind: "session",
      pairId: access.pairId,
      grantId: access.grantId,
      channelBinding: wire.binding(),
    };
    if (!server) await wire.write(frame, () => vault.guardSession(access));
    const remote = deviceObject(await wire.read(), [
      "version",
      "protocol",
      "kind",
      "pairId",
      "grantId",
      "channelBinding",
    ]);
    if (
      Object.keys(frame).some(
        (key) => remote[key] !== frame[key as keyof typeof frame],
      )
    )
      throw new DeviceError("peer");
    vault.guardSession(access);
    if (server) await wire.write(frame, () => vault.guardSession(access));
  } finally {
    unsubscribe();
  }
}
export class DeviceSession {
  private seen = performance.now();
  private unsubscribe: () => void;
  constructor(
    private vault: DeviceVault,
    private access: Access,
    private wire: DeviceWire,
  ) {
    vault.guardSession(access);
    this.unsubscribe = watch(vault, access, wire);
    wire.onClose(() => this.unsubscribe());
  }
  toJSON() {
    return { peerId: this.access.peer.deviceId, grantId: this.access.grantId };
  }
  [inspect.custom]() {
    return this.toJSON();
  }
  security() {
    return this.wire.security();
  }
  lastSeen() {
    return this.seen;
  }
  async heartbeat() {
    await this.wire.write(
      {
        version: 1,
        kind: "heartbeat",
        pairId: this.access.pairId,
        grantId: this.access.grantId,
        from: this.vault.publicIdentity().deviceId,
        to: this.access.peer.deviceId,
      },
      () => this.vault.guardSession(this.access),
    );
  }
  async sendSnapshot(raw: DeviceDataSnapshot): Promise<void> {
    const self = this.vault.publicIdentity().deviceId;
    const snapshot = validateDeviceSnapshot(raw, {
      self: this.access.peer.deviceId,
      peer: self,
      pairId: this.access.pairId,
      grantId: this.access.grantId,
      counters: {
        preferences: Number.MAX_SAFE_INTEGER,
        views: Number.MAX_SAFE_INTEGER,
        playback: Number.MAX_SAFE_INTEGER,
      },
    });
    await this.wire.write(snapshot, () =>
      this.vault.guardSession(this.access, snapshot.scope),
    );
  }
  async send(raw: DeviceOperation | DeviceAck): Promise<void> {
    const message =
      raw.kind === "operation"
        ? validateDeviceOperation(raw)
        : validateDeviceAck(raw);
    if (
      message.from !== this.vault.publicIdentity().deviceId ||
      message.to !== this.access.peer.deviceId ||
      message.pairId !== this.access.pairId ||
      message.grantId !== this.access.grantId
    )
      throw new DeviceError("peer");
    await this.wire.write(message, () => {
      this.vault.guardSession(this.access, message.scope);
      if (message.kind === "operation") this.vault.guardOutbound(message);
    });
  }
  async receive(): Promise<DeviceOperation | DeviceAck | DeviceDataSnapshot> {
    try {
      for (;;) {
        this.vault.guardSession(this.access);
        const raw = await this.wire.read();
        this.seen = performance.now();
        const kind =
          raw && typeof raw === "object"
            ? (raw as { kind?: unknown }).kind
            : null;
        if (kind === "heartbeat") {
          const h = deviceObject(raw, [
            "version",
            "kind",
            "pairId",
            "grantId",
            "from",
            "to",
          ]);
          if (
            h.version !== 1 ||
            h.pairId !== this.access.pairId ||
            h.grantId !== this.access.grantId ||
            h.from !== this.access.peer.deviceId ||
            h.to !== this.vault.publicIdentity().deviceId
          )
            throw new DeviceError("peer");
          this.vault.guardSession(this.access);
          continue;
        }
        if (kind === "snapshot") {
          const snapshot = validateDeviceSnapshot(raw, {
            self: this.vault.publicIdentity().deviceId,
            peer: this.access.peer.deviceId,
            pairId: this.access.pairId,
            grantId: this.access.grantId,
            counters: this.vault.snapshot().counters,
          });
          this.vault.guardSession(this.access, snapshot.scope);
          return snapshot;
        }
        const message =
          kind === "operation"
            ? validateDeviceOperation(raw)
            : kind === "ack"
              ? validateDeviceAck(raw)
              : null;
        if (
          !message ||
          message.from !== this.access.peer.deviceId ||
          message.to !== this.vault.publicIdentity().deviceId ||
          message.pairId !== this.access.pairId ||
          message.grantId !== this.access.grantId
        )
          throw new DeviceError("peer");
        this.vault.guardSession(this.access, message.scope);
        if (message.kind === "ack") await this.vault.acknowledge(message);
        // An operation has NO transport ACK. DP-03 must commit its journal before sending one.
        return message;
      }
    } catch (error) {
      this.close();
      throw error instanceof DeviceError ? error : new DeviceError("peer");
    }
  }
  close(): void {
    this.unsubscribe();
    this.wire.close();
  }
}
export async function connectDeviceSession(
  vault: DeviceVault,
  port: number,
  host = "127.0.0.1",
): Promise<DeviceSession> {
  const access = vault.sessionAccess(),
    wire = await connectDevice(vault, access.peer, port, host);
  try {
    await ready(vault, access, wire, false);
    return new DeviceSession(vault, access, wire);
  } catch (error) {
    wire.close();
    throw error;
  }
}
export async function openDeviceSessionServer(
  vault: DeviceVault,
  handle: (session: DeviceSession) => Promise<void>,
  rejected?: (code: DeviceError["code"]) => void,
  endpoint = { host: "127.0.0.1", port: 0 },
) {
  const access = vault.sessionAccess();
  return listenDevice(
    vault,
    access.peer,
    async (wire) => {
      vault.guardSession(access, undefined, true);
      await ready(vault, access, wire, true);
      const session = new DeviceSession(vault, access, wire);
      try {
        await handle(session);
      } finally {
        session.close();
      }
    },
    rejected,
    endpoint,
  );
}
