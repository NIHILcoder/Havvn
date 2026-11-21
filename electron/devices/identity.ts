import "reflect-metadata";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  webcrypto,
  X509Certificate,
} from "node:crypto";
import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  AuthorityKeyIdentifierExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import {
  DeviceError,
  validateDevicePublic,
  type DevicePublic,
} from "../../shared/device-pairing";
export interface DeviceIdentity {
  public: DevicePublic;
  privateKey: string;
  tlsPrivateKey?: string;
  createdAt: number;
}
export const deviceHash = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
export const deviceDns = (id: string) =>
  `dev-${id.slice(0, 32)}.${id.slice(32)}.havvn.invalid`;
export function deviceCertificateCanonical(
  p: Pick<
    DevicePublic,
    "deviceId" | "publicKey" | "certificate" | "certificateAuthority"
  >,
): Uint8Array {
  return Buffer.from(
    JSON.stringify([
      "havvn/device-tls-certificate/v2",
      p.deviceId,
      p.publicKey,
      certificateHash(p as DevicePublic),
      deviceHash(new X509Certificate(p.certificateAuthority!).raw),
    ]),
  );
}
export function checkDevicePublic(
  raw: unknown,
  now = Date.now(),
): DevicePublic {
  try {
    const p = validateDevicePublic(raw),
      der = Buffer.from(p.publicKey, "base64");
    if (
      der.toString("base64") !== p.publicKey ||
      deviceHash(der) !== p.deviceId
    )
      throw Error();
    const key = createPublicKey({ key: der, format: "der", type: "spki" }),
      cert = new X509Certificate(p.certificate);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      cert.ca ||
      !cert.checkHost(deviceDns(p.deviceId), {
        subject: "never",
        wildcards: false,
      }) ||
      Date.parse(cert.validFrom) > now ||
      Date.parse(cert.validTo) <= now
    )
      throw Error();
    if (p.version === 1) {
      if (
        !cert.publicKey.equals(key) ||
        !cert.verify(key) ||
        cert.subject !== cert.issuer
      )
        throw Error();
    } else {
      const ca = new X509Certificate(p.certificateAuthority!);
      if (
        !ca.ca ||
        ca.subject !== ca.issuer ||
        !ca.verify(ca.publicKey) ||
        !cert.checkIssued(ca) ||
        !cert.verify(ca.publicKey) ||
        ca.publicKey.asymmetricKeyType !== "ec" ||
        ca.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
        Date.parse(ca.validFrom) > now ||
        Date.parse(ca.validTo) <= now ||
        cert.publicKey.asymmetricKeyType !== "ec" ||
        cert.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
        !verifyDevice(
          p,
          deviceCertificateCanonical(p),
          p.certificateProof ?? "",
        )
      )
        throw Error();
    }
    if (
      !cert.keyUsage?.includes("1.3.6.1.5.5.7.3.1") ||
      !cert.keyUsage.includes("1.3.6.1.5.5.7.3.2")
    )
      throw Error();
    return p;
  } catch {
    throw new DeviceError("identity");
  }
}
export function checkDeviceIdentity(
  raw: DeviceIdentity,
  now = Date.now(),
): DeviceIdentity {
  try {
    if (
      !raw ||
      Object.keys(raw).sort().join(",") !==
        (raw.public?.version === 2
          ? "createdAt,privateKey,public,tlsPrivateKey"
          : "createdAt,privateKey,public") ||
      !Number.isSafeInteger(raw.createdAt) ||
      raw.createdAt < 0 ||
      raw.createdAt > now + 300000 ||
      typeof raw.privateKey !== "string" ||
      raw.privateKey.length > 2048
    )
      throw Error();
    const p = checkDevicePublic(raw.public, now),
      key = createPrivateKey(raw.privateKey);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      createPublicKey(key)
        .export({ format: "der", type: "spki" })
        .toString("base64") !== p.publicKey
    )
      throw Error();
    if (
      p.version === 2 &&
      (typeof raw.tlsPrivateKey !== "string" ||
        raw.tlsPrivateKey.length > 2048 ||
        !new X509Certificate(p.certificate).checkPrivateKey(
          createPrivateKey(raw.tlsPrivateKey),
        ))
    )
      throw Error();
    return {
      public: p,
      privateKey: raw.privateKey,
      createdAt: raw.createdAt,
      ...(p.version === 2 ? { tlsPrivateKey: raw.tlsPrivateKey! } : {}),
    };
  } catch {
    throw new DeviceError("identity");
  }
}
export async function createDeviceIdentity(
  now = Date.now(),
): Promise<DeviceIdentity> {
  try {
    const provider = webcrypto as unknown as Crypto;
    const keys = (await provider.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const tlsKeys = (await provider.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const caKeys = (await provider.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = Buffer.from(
        await provider.subtle.exportKey("spki", keys.publicKey),
      ),
      deviceId = deviceHash(der);
    const caName = `CN=Havvn Device Authority ${deviceId}`;
    const ca = await X509CertificateGenerator.createSelfSigned(
      {
        serialNumber: randomBytes(19).toString("hex"),
        name: caName,
        keys: caKeys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        notBefore: new Date(now - 300000),
        notAfter: new Date(now + 365 * 86400000),
        extensions: [
          new BasicConstraintsExtension(true, 0, true),
          new KeyUsagesExtension(KeyUsageFlags.keyCertSign, true),
          await SubjectKeyIdentifierExtension.create(
            caKeys.publicKey,
            false,
            provider,
          ),
        ],
      },
      provider,
    );
    const cert = await X509CertificateGenerator.create(
      {
        serialNumber: randomBytes(19).toString("hex"),
        subject: "CN=Havvn Device",
        issuer: caName,
        notBefore: new Date(now - 300000),
        notAfter: new Date(now + 365 * 86400000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        publicKey: tlsKeys.publicKey,
        signingKey: caKeys.privateKey,
        extensions: [
          new BasicConstraintsExtension(false, undefined, true),
          new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
          new ExtendedKeyUsageExtension([
            "1.3.6.1.5.5.7.3.1",
            "1.3.6.1.5.5.7.3.2",
          ]),
          new SubjectAlternativeNameExtension([
            { type: "dns", value: deviceDns(deviceId) },
          ]),
          await AuthorityKeyIdentifierExtension.create(
            caKeys.publicKey,
            false,
            provider,
          ),
          await SubjectKeyIdentifierExtension.create(
            tlsKeys.publicKey,
            false,
            provider,
          ),
        ],
      },
      provider,
    );
    const privateDer = Buffer.from(
      await provider.subtle.exportKey("pkcs8", keys.privateKey),
    );
    const tlsDer = Buffer.from(
      await provider.subtle.exportKey("pkcs8", tlsKeys.privateKey),
    );
    try {
      const privateKey = createPrivateKey({
        key: privateDer,
        format: "der",
        type: "pkcs8",
      })
        .export({ type: "pkcs8", format: "pem" })
        .toString();
      const publicFields = {
        deviceId,
        publicKey: der.toString("base64"),
        certificate: cert.toString("pem"),
        certificateAuthority: ca.toString("pem"),
      };
      return checkDeviceIdentity(
        {
          public: {
            version: 2,
            ...publicFields,
            certificateProof: sign(
              null,
              deviceCertificateCanonical(publicFields),
              privateKey,
            ).toString("base64"),
          },
          privateKey,
          tlsPrivateKey: createPrivateKey({
            key: tlsDer,
            format: "der",
            type: "pkcs8",
          })
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
          createdAt: now,
        },
        now,
      );
    } finally {
      privateDer.fill(0);
      tlsDer.fill(0);
    }
  } catch {
    throw new DeviceError("identity");
  }
}
export function signDevice(
  identity: DeviceIdentity,
  message: Uint8Array,
): string {
  try {
    return sign(null, message, identity.privateKey).toString("base64");
  } catch {
    throw new DeviceError("identity");
  }
}
export function verifyDevice(
  peer: DevicePublic,
  message: Uint8Array,
  signature: string,
): boolean {
  try {
    const bytes = Buffer.from(signature, "base64");
    return (
      bytes.length === 64 &&
      bytes.toString("base64") === signature &&
      verify(
        null,
        message,
        createPublicKey({
          key: Buffer.from(peer.publicKey, "base64"),
          format: "der",
          type: "spki",
        }),
        bytes,
      )
    );
  } catch {
    return false;
  }
}
export function certificateHash(peer: DevicePublic): string {
  try {
    return deviceHash(new X509Certificate(peer.certificate).raw);
  } catch {
    throw new DeviceError("identity");
  }
}
