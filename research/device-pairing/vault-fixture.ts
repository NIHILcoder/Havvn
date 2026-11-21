/** Test-only helpers; imported only by *.test.ts. No Electron or user stores. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  DeviceVault,
  type DeviceVaultStorage,
} from "../../electron/devices/vault";
import { certificateHash } from "../../electron/devices/identity";
import type {
  DeviceConfirmationBody,
  DeviceScope,
} from "../../shared/device-pairing";
export function memoryDeviceStorage(binding = "a".repeat(64)) {
  const key = randomBytes(32);
  let cipher: string | null = null;
  const faults = {
    protect: false,
    unprotect: false,
    beforeWrite: false,
    afterWrite: false,
    read: false,
  };
  const protect = (plain: string) => {
    if (faults.protect) throw Error("sensitive encryption error");
    const iv = randomBytes(12),
      enc = createCipheriv("aes-256-gcm", key, iv);
    return (
      "enc:v1:" +
      Buffer.concat([
        iv,
        enc.update(plain),
        enc.final(),
        enc.getAuthTag(),
      ]).toString("base64")
    );
  };
  const unprotect = (value: string) => {
    if (faults.unprotect) throw Error("sensitive decryption error");
    const b = Buffer.from(value.slice(7), "base64"),
      dec = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    dec.setAuthTag(b.subarray(-16));
    return Buffer.concat([
      dec.update(b.subarray(12, -16)),
      dec.final(),
    ]).toString();
  };
  const io = (): DeviceVaultStorage => ({
    binding,
    protect,
    unprotect,
    read: () => {
      if (faults.read) throw Error("sensitive read error");
      return cipher;
    },
    write: (expected, next) => {
      if (faults.beforeWrite) throw Error("disk before commit");
      if (cipher !== expected) throw Error("stale");
      cipher = next;
      if (faults.afterWrite) throw Error("disk after commit");
    },
  });
  return {
    io,
    faults,
    raw: () => cipher,
    setRaw: (value: string | null) => {
      cipher = value;
    },
    plain: () => JSON.parse(unprotect(JSON.parse(cipher!).payload)),
    mutate: (fn: (value: Record<string, unknown>) => void) => {
      const v = JSON.parse(unprotect(JSON.parse(cipher!).payload));
      fn(v);
      cipher = JSON.stringify({
        version: 1,
        payload: protect(JSON.stringify(v)),
      });
    },
  };
}
export async function prepareDevices(
  a: DeviceVault,
  b: DeviceVault,
  scopes: DeviceScope[] = ["preferences", "views", "playback"],
) {
  const invite = await a.issueInvitation(
      { host: "127.0.0.1", port: 47474 },
      scopes,
    ),
    pa = a.publicIdentity(),
    pb = b.publicIdentity();
  const body: DeviceConfirmationBody = {
    version: 1,
    role: "responder",
    inviteId: invite.inviteId,
    pairId: invite.pairId,
    grantId: invite.grantId,
    initiatorId: pa.deviceId,
    responderId: pb.deviceId,
    initiatorCertificate: certificateHash(pa),
    responderCertificate: certificateHash(pb),
    scopes,
    challengeA: randomBytes(32).toString("hex"),
    challengeB: randomBytes(32).toString("hex"),
    channelBinding: randomBytes(32).toString("hex"),
  };
  await b.acceptInvitation(invite, body);
  return { invite, body, proofB: await b.approveLocal() };
}
export async function activateDevices(
  a: DeviceVault,
  b: DeviceVault,
  scopes?: DeviceScope[],
) {
  const prepared = await prepareDevices(a, b, scopes);
  await a.bindInvitation(
    prepared.invite.inviteId,
    prepared.invite.token,
    b.publicIdentity(),
    prepared.proofB,
  );
  const proofA = await a.approveLocal();
  await b.recordPeerProof(proofA);
  const readyA = a.preparedReceipt(),
    readyB = b.preparedReceipt();
  await a.activate(readyB);
  await b.activate(readyA);
  return { ...prepared, proofA, readyA, readyB };
}
