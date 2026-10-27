import { randomBytes } from "node:crypto";
import {
  DeviceError,
  deviceObject,
  deviceHex,
  validateConfirmationBody,
  validateDeviceInvite,
  validateDeviceConfirmation,
  validateDevicePrepared,
  deviceConfirmationCanonical,
  type DeviceConfirmationBody,
  type DeviceInvite,
  type DevicePublic,
  type DeviceScope,
} from "../../shared/device-pairing";
import { checkDevicePublic, certificateHash } from "./identity";
import { DeviceVault } from "./vault";
import { listenDevice, connectDevice } from "./transport";
import { deviceHost } from "./network";

/** A future UI must present these exact identities/scopes and return explicit consent. */
export type DeviceConsent = (preview: {
  self: DevicePublic;
  peer: DevicePublic;
  scopes: DeviceScope[];
}) => Promise<boolean>;
const random = () => randomBytes(32).toString("hex");
function fresh(invite: DeviceInvite): void {
  if (invite.expiresAt <= Date.now() || invite.issuedAt > Date.now() + 300000)
    throw new DeviceError("expired");
}
function equalBody(
  a: DeviceConfirmationBody,
  b: DeviceConfirmationBody,
): boolean {
  return Buffer.from(deviceConfirmationCanonical(a)).equals(
    Buffer.from(deviceConfirmationCanonical(b)),
  );
}
export async function openDeviceBootstrap(
  vault: DeviceVault,
  scopes: DeviceScope[],
  consent: DeviceConsent,
  rejected?: (code: DeviceError["code"]) => void,
  endpoint = { host: "127.0.0.1", port: 0 },
) {
  let invitation: DeviceInvite | undefined,
    busy = false;
  let resolveCompleted!: (value: boolean) => void;
  const completed = new Promise<boolean>((resolve) => {
    resolveCompleted = resolve;
  });
  const listener = await listenDevice(
    vault,
    undefined,
    async (wire) => {
      if (
        busy ||
        !invitation ||
        !["unpaired", "revoked"].includes(vault.snapshot().status)
      )
        throw new DeviceError("state");
      busy = true;
      const unsubscribe = vault.onAccessChange(() => {
        try {
          if (
            ["pausing", "paused-error", "revoked"].includes(
              vault.snapshot().status,
            )
          )
            wire.close("revoked");
        } catch {
          wire.close("state");
        }
      });
      try {
        const hello = deviceObject(await wire.read(), [
          "version",
          "kind",
          "inviteId",
          "token",
          "device",
          "challengeB",
        ]);
        if (
          hello.version !== 1 ||
          hello.kind !== "bootstrap" ||
          hello.inviteId !== invitation.inviteId
        )
          throw new DeviceError("invalid");
        const token = deviceHex(hello.token),
          peer = checkDevicePublic(hello.device),
          self = vault.publicIdentity();
        fresh(invitation);
        const body = validateConfirmationBody({
          version: 1,
          role: "responder",
          inviteId: invitation.inviteId,
          pairId: invitation.pairId,
          grantId: invitation.grantId,
          initiatorId: self.deviceId,
          responderId: peer.deviceId,
          initiatorCertificate: certificateHash(self),
          responderCertificate: certificateHash(peer),
          scopes: invitation.scopes,
          challengeA: random(),
          challengeB: deviceHex(hello.challengeB),
          channelBinding: wire.binding(),
        });
        await wire.write({ version: 1, kind: "challenge", body });
        const proof = validateDeviceConfirmation(await wire.read());
        if (
          !equalBody(proof.body, body) ||
          proof.body.channelBinding !== wire.binding()
        )
          throw new DeviceError("peer");
        await vault.bindInvitation(invitation.inviteId, token, peer, proof);
        wire.idleTimeout(Math.max(1000, invitation.expiresAt - Date.now()));
        if (
          (await consent(
            structuredClone({ self, peer, scopes: body.scopes }),
          )) !== true
        ) {
          await vault.revoke();
          throw new DeviceError("not-confirmed");
        }
        wire.assertOpen();
        fresh(invitation);
        await wire.write(await vault.approveLocal());
        const ready = validateDevicePrepared(await wire.read());
        await vault.activate(ready);
        await wire.write(vault.preparedReceipt());
        resolveCompleted(true);
      } finally {
        unsubscribe();
        busy = false;
      }
    },
    rejected,
    endpoint,
  );
  try {
    invitation = await vault.issueInvitation(
      { host: endpoint.host, port: listener.port },
      scopes,
    );
  } catch (error) {
    await listener.close();
    throw error;
  }
  return {
    invitation: structuredClone(invitation),
    completed,
    close: async () => {
      resolveCompleted(false);
      await listener.close();
    },
  };
}
export async function pairDevice(
  vault: DeviceVault,
  raw: DeviceInvite,
  consent: DeviceConsent,
): Promise<void> {
  const invite = validateDeviceInvite(raw),
    peer = checkDevicePublic(invite.device),
    self = vault.publicIdentity();
  deviceHost(invite.endpoint.host);
  fresh(invite);
  // Approval before opening the connection also prevents an invite from silently dialing.
  if (
    (await consent(structuredClone({ self, peer, scopes: invite.scopes }))) !==
    true
  )
    throw new DeviceError("not-confirmed");
  fresh(invite);
  const wire = await connectDevice(
      vault,
      peer,
      invite.endpoint.port,
      invite.endpoint.host,
    ),
    challengeB = random();
  const unsubscribe = vault.onAccessChange(() => {
    try {
      if (
        ["pausing", "paused-error", "revoked"].includes(vault.snapshot().status)
      )
        wire.close("revoked");
    } catch {
      wire.close("state");
    }
  });
  try {
    await wire.write({
      version: 1,
      kind: "bootstrap",
      inviteId: invite.inviteId,
      token: invite.token,
      device: self,
      challengeB,
    });
    const challenge = deviceObject(await wire.read(), [
      "version",
      "kind",
      "body",
    ]);
    if (challenge.version !== 1 || challenge.kind !== "challenge")
      throw new DeviceError("invalid");
    const body = validateConfirmationBody(challenge.body),
      expected: DeviceConfirmationBody = {
        version: 1,
        role: "responder",
        inviteId: invite.inviteId,
        pairId: invite.pairId,
        grantId: invite.grantId,
        initiatorId: peer.deviceId,
        responderId: self.deviceId,
        initiatorCertificate: certificateHash(peer),
        responderCertificate: certificateHash(self),
        scopes: invite.scopes,
        challengeA: body.challengeA,
        challengeB,
        channelBinding: wire.binding(),
      };
    if (!equalBody(body, expected)) throw new DeviceError("peer");
    await vault.acceptInvitation(invite, body);
    await wire.write(await vault.approveLocal());
    const proof = validateDeviceConfirmation(await wire.read());
    if (!equalBody(proof.body, { ...expected, role: "initiator" }))
      throw new DeviceError("peer");
    await vault.recordPeerProof(proof);
    await wire.write(vault.preparedReceipt());
    await vault.activate(validateDevicePrepared(await wire.read()));
  } finally {
    unsubscribe();
    wire.close();
  }
}
