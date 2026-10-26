import { expect, it } from "vitest";
import { X509Certificate, createPublicKey } from "node:crypto";
import {
  createDeviceIdentity,
  checkDeviceIdentity,
  checkDevicePublic,
  deviceHash,
  deviceDns,
  signDevice,
  verifyDevice,
} from "./identity";
import { legacyDeviceIdentity } from "../../research/device-pairing/legacy-fixture";
import { memoryDeviceStorage } from "../../research/device-pairing/vault-fixture";
import { DeviceVault } from "./vault";
it("issues independent Ed25519 identities and native-verifiable certificates", async () => {
  const a = await createDeviceIdentity(),
    b = await createDeviceIdentity();
  expect(a.public.deviceId).not.toBe(b.public.deviceId);
  const cert = new X509Certificate(a.public.certificate),
    key = createPublicKey({
      key: Buffer.from(a.public.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
  expect(
    cert.verify(new X509Certificate(a.public.certificateAuthority!).publicKey),
  ).toBe(true);
  expect(cert.publicKey.asymmetricKeyType).toBe("ec");
  expect(key.asymmetricKeyType).toBe("ed25519");
  expect(checkDevicePublic(a.public)).toEqual(a.public);
  expect(cert.ca).toBe(false);
  expect(cert.checkHost(deviceDns(a.public.deviceId))).toBeTruthy();
  expect(deviceHash(Buffer.from(a.public.publicKey, "base64"))).toBe(
    a.public.deviceId,
  );
});
it("checks key, certificate, fingerprint, expiry and private/public consistency", async () => {
  const a = await createDeviceIdentity(),
    b = await createDeviceIdentity();
  for (const value of [
    { ...a.public, deviceId: "0".repeat(64) },
    { ...a.public, certificate: b.public.certificate },
    { ...a.public, publicKey: b.public.publicKey },
    { ...a.public, certificateProof: b.public.certificateProof },
    { ...a.public, certificateAuthority: b.public.certificateAuthority },
  ])
    expect(() => checkDevicePublic(value)).toThrow("identity");
  expect(() => checkDeviceIdentity({ ...a, privateKey: b.privateKey })).toThrow(
    "identity",
  );
  expect(() =>
    checkDeviceIdentity({ ...a, tlsPrivateKey: b.tlsPrivateKey }),
  ).toThrow("identity");
  expect(() =>
    checkDevicePublic(a.public, Date.now() + 366 * 86400000),
  ).toThrow("identity");
});
it("signatures verify only for the selected public key and exact message", async () => {
  const a = await createDeviceIdentity(),
    b = await createDeviceIdentity(),
    message = new TextEncoder().encode("message"),
    sig = signDevice(a, message);
  expect(verifyDevice(a.public, message, sig)).toBe(true);
  expect(verifyDevice(b.public, message, sig)).toBe(false);
  expect(verifyDevice(a.public, new TextEncoder().encode("other"), sig)).toBe(
    false,
  );
});
it("reads a DP-01 identity without rewriting keys and refuses to silently use its unsupported TLS format", async () => {
  const legacy = await legacyDeviceIdentity(),
    storage = memoryDeviceStorage(),
    initial = await DeviceVault.initialize(storage.io());
  await initial.close();
  storage.mutate((state) => {
    state.identity = legacy;
  });
  const before = storage.raw(),
    vault = DeviceVault.open(storage.io());
  expect(vault.publicIdentity()).toEqual(legacy.public);
  expect(checkDeviceIdentity(legacy)).toEqual(legacy);
  expect(() => vault.createTlsContext()).toThrow("version");
  expect(storage.raw()).toBe(before);
  await vault.close();
});
it("rejects a stripped or incomplete v2 certificate binding", async () => {
  const identity = await createDeviceIdentity();
  expect(() =>
    checkDevicePublic({
      ...identity.public,
      version: 1,
      certificateAuthority: undefined,
      certificateProof: undefined,
    }),
  ).toThrow("identity");
  const broken = { ...identity };
  delete broken.tlsPrivateKey;
  expect(() => checkDeviceIdentity(broken)).toThrow("identity");
});
