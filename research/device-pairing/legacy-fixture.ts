/** Test-only DP-01 identity. Never imported by production roots. */
import "reflect-metadata";
import { webcrypto, createPrivateKey } from "node:crypto";
import {
  X509CertificateGenerator,
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  SubjectAlternativeNameExtension,
} from "@peculiar/x509";
import {
  deviceHash,
  deviceDns,
  type DeviceIdentity,
} from "../../electron/devices/identity";
export async function legacyDeviceIdentity(): Promise<DeviceIdentity> {
  const provider = webcrypto as unknown as Crypto;
  const keys = (await provider.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicDer = Buffer.from(
      await provider.subtle.exportKey("spki", keys.publicKey),
    ),
    deviceId = deviceHash(publicDer),
    at = Date.now();
  const cert = await X509CertificateGenerator.createSelfSigned(
    {
      name: "CN=Havvn Device",
      keys,
      signingAlgorithm: { name: "Ed25519" },
      notBefore: new Date(at - 300000),
      notAfter: new Date(at + 365 * 86400000),
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new ExtendedKeyUsageExtension([
          "1.3.6.1.5.5.7.3.1",
          "1.3.6.1.5.5.7.3.2",
        ]),
        new SubjectAlternativeNameExtension([
          { type: "dns", value: deviceDns(deviceId) },
        ]),
      ],
    },
    provider,
  );
  const privateDer = Buffer.from(
    await provider.subtle.exportKey("pkcs8", keys.privateKey),
  );
  try {
    return {
      public: {
        version: 1,
        deviceId,
        publicKey: publicDer.toString("base64"),
        certificate: cert.toString("pem"),
      },
      privateKey: createPrivateKey({
        key: privateDer,
        format: "der",
        type: "pkcs8",
      })
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      createdAt: at,
    };
  } finally {
    privateDer.fill(0);
  }
}
