/** DP-01 wire shapes only. These messages do not authorize applying preferences. */
export const DEVICE_SCOPES = ["preferences", "views", "playback"] as const;
export type DeviceScope = (typeof DEVICE_SCOPES)[number];
export type DeviceErrorCode =
  | "invalid"
  | "version"
  | "size"
  | "identity"
  | "locked"
  | "storage"
  | "state"
  | "expired"
  | "peer"
  | "revoked"
  | "quota"
  | "stale"
  | "not-confirmed"
  | "clone"
  | "missing"
  | "exists";
export class DeviceError extends Error {
  constructor(public readonly code: DeviceErrorCode) {
    super(`Device pairing: ${code}`);
    this.name = "DeviceError";
  }
}
export interface DevicePublic {
  version: 1 | 2;
  deviceId: string;
  publicKey: string;
  certificate: string;
  certificateProof?: string;
  certificateAuthority?: string;
}
export interface DeviceInvite {
  version: 1;
  kind: "invite";
  inviteId: string;
  pairId: string;
  grantId: string;
  device: DevicePublic;
  endpoint: { host: string; port: number };
  scopes: DeviceScope[];
  issuedAt: number;
  expiresAt: number;
  token: string;
}
export interface DeviceConfirmationBody {
  version: 1;
  role: "initiator" | "responder";
  inviteId: string;
  pairId: string;
  grantId: string;
  initiatorId: string;
  responderId: string;
  initiatorCertificate: string;
  responderCertificate: string;
  scopes: DeviceScope[];
  challengeA: string;
  challengeB: string;
  channelBinding: string;
}
export interface DeviceConfirmation {
  version: 1;
  kind: "confirmation";
  body: DeviceConfirmationBody;
  signature: string;
}
export interface DevicePrepared {
  version: 1;
  kind: "prepared";
  body: {
    pairId: string;
    grantId: string;
    from: string;
    to: string;
    transcript: string;
  };
  signature: string;
}
export type DeviceJson =
  | null
  | boolean
  | number
  | string
  | DeviceJson[]
  | { [key: string]: DeviceJson };
export interface DeviceOperation {
  version: 1;
  kind: "operation";
  pairId: string;
  grantId: string;
  from: string;
  to: string;
  scope: DeviceScope;
  sequence: number;
  recordId: string;
  context: Record<string, number>;
  deleted: boolean;
  value: DeviceJson;
}
export interface DeviceAck {
  version: 1;
  kind: "ack";
  pairId: string;
  grantId: string;
  from: string;
  to: string;
  scope: DeviceScope;
  through: number;
}
export type DeviceMessage =
  | DeviceInvite
  | DeviceConfirmation
  | DevicePrepared
  | DeviceOperation
  | DeviceAck;
export const DEVICE_FRAME_BYTES = 64 * 1024;
const fail = (code: DeviceErrorCode = "invalid"): never => {
  throw new DeviceError(code);
};
export function deviceObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== keys.length ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    return fail();
  return v;
}
export function deviceHex(value: unknown, length = 64): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[a-f0-9]{${length}}$`).test(value)
  )
    return fail();
  return value;
}
export function deviceCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return fail();
  return value;
}
function version(value: unknown): void {
  if (value !== 1) fail("version");
}
export function deviceScopes(value: unknown): DeviceScope[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 3 ||
    new Set(value).size !== value.length ||
    value.some((s) => !DEVICE_SCOPES.includes(s))
  )
    return fail();
  return DEVICE_SCOPES.filter((s) => value.includes(s));
}
export function validateDevicePublic(raw: unknown): DevicePublic {
  const v2 =
    !!raw &&
    typeof raw === "object" &&
    (raw as { version?: unknown }).version === 2;
  const v = deviceObject(raw, [
    "version",
    "deviceId",
    "publicKey",
    "certificate",
    ...(v2 ? ["certificateProof", "certificateAuthority"] : []),
  ]);
  if (v.version !== 1 && v.version !== 2) return fail("version");
  if (
    typeof v.publicKey !== "string" ||
    !/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/.test(v.publicKey)
  )
    return fail("identity");
  if (
    v2 &&
    (typeof v.certificateAuthority !== "string" ||
      v.certificateAuthority.length > 8192 ||
      !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\r?\n?$/.test(
        v.certificateAuthority,
      ))
  )
    return fail("identity");
  if (
    typeof v.certificate !== "string" ||
    v.certificate.length > 8192 ||
    !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\r?\n?$/.test(
      v.certificate,
    )
  )
    return fail("identity");
  return {
    version: v.version,
    deviceId: deviceHex(v.deviceId),
    publicKey: v.publicKey,
    certificate: v.certificate,
    ...(v2
      ? {
          certificateProof: signature(v.certificateProof),
          certificateAuthority: v.certificateAuthority as string,
        }
      : {}),
  };
}
export function validateDeviceInvite(raw: unknown): DeviceInvite {
  const v = deviceObject(raw, [
    "version",
    "kind",
    "inviteId",
    "pairId",
    "grantId",
    "device",
    "endpoint",
    "scopes",
    "issuedAt",
    "expiresAt",
    "token",
  ]);
  version(v.version);
  if (v.kind !== "invite") return fail();
  const e = deviceObject(v.endpoint, ["host", "port"]),
    issuedAt = deviceCount(v.issuedAt),
    expiresAt = deviceCount(v.expiresAt),
    port = deviceCount(e.port);
  if (
    typeof e.host !== "string" ||
    !e.host ||
    e.host.length > 253 ||
    !/^[a-zA-Z0-9.:[\]-]+$/.test(e.host) ||
    port < 1 ||
    port > 65535 ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 600000
  )
    return fail();
  if (e.host.includes(":")) {
    try {
      new URL(`https://${e.host.startsWith("[") ? e.host : `[${e.host}]`}/`);
    } catch {
      return fail();
    }
  } else if (/^[\d.]+$/.test(e.host)) {
    const parts = e.host.split(".");
    if (
      parts.length !== 4 ||
      parts.some(
        (p) =>
          !/^\d{1,3}$/.test(p) || Number(p) > 255 || String(Number(p)) !== p,
      )
    )
      return fail();
  } else if (
    e.host
      .split(".")
      .some(
        (label) =>
          !label ||
          label.length > 63 ||
          !/^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])$/.test(label),
      )
  )
    return fail();
  return {
    version: 1,
    kind: "invite",
    inviteId: deviceHex(v.inviteId, 32),
    pairId: deviceHex(v.pairId, 32),
    grantId: deviceHex(v.grantId),
    device: validateDevicePublic(v.device),
    endpoint: { host: e.host, port },
    scopes: deviceScopes(v.scopes),
    issuedAt,
    expiresAt,
    token: deviceHex(v.token),
  };
}
export function validateConfirmationBody(raw: unknown): DeviceConfirmationBody {
  const v = deviceObject(raw, [
    "version",
    "role",
    "inviteId",
    "pairId",
    "grantId",
    "initiatorId",
    "responderId",
    "initiatorCertificate",
    "responderCertificate",
    "scopes",
    "challengeA",
    "challengeB",
    "channelBinding",
  ]);
  version(v.version);
  if (
    !["initiator", "responder"].includes(v.role as string) ||
    v.initiatorId === v.responderId
  )
    return fail();
  return {
    version: 1,
    role: v.role as DeviceConfirmationBody["role"],
    inviteId: deviceHex(v.inviteId, 32),
    pairId: deviceHex(v.pairId, 32),
    grantId: deviceHex(v.grantId),
    initiatorId: deviceHex(v.initiatorId),
    responderId: deviceHex(v.responderId),
    initiatorCertificate: deviceHex(v.initiatorCertificate),
    responderCertificate: deviceHex(v.responderCertificate),
    scopes: deviceScopes(v.scopes),
    challengeA: deviceHex(v.challengeA),
    challengeB: deviceHex(v.challengeB),
    channelBinding: deviceHex(v.channelBinding),
  };
}
function signature(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value))
    return fail();
  return value;
}
export function validateDeviceConfirmation(raw: unknown): DeviceConfirmation {
  const v = deviceObject(raw, ["version", "kind", "body", "signature"]);
  version(v.version);
  if (v.kind !== "confirmation") return fail();
  return {
    version: 1,
    kind: "confirmation",
    body: validateConfirmationBody(v.body),
    signature: signature(v.signature),
  };
}
export function validateDevicePrepared(raw: unknown): DevicePrepared {
  const v = deviceObject(raw, ["version", "kind", "body", "signature"]);
  version(v.version);
  if (v.kind !== "prepared") return fail();
  const b = deviceObject(v.body, [
    "pairId",
    "grantId",
    "from",
    "to",
    "transcript",
  ]);
  if (b.from === b.to) return fail();
  return {
    version: 1,
    kind: "prepared",
    body: {
      pairId: deviceHex(b.pairId, 32),
      grantId: deviceHex(b.grantId),
      from: deviceHex(b.from),
      to: deviceHex(b.to),
      transcript: deviceHex(b.transcript),
    },
    signature: signature(v.signature),
  };
}
export function boundedDeviceJson(raw: unknown): DeviceJson {
  let nodes = 0;
  const visit = (v: unknown, depth: number): DeviceJson => {
    if (++nodes > 2048 || depth > 8) return fail("size");
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) {
      if (v.length > 128) return fail("size");
      return v.map((x) => visit(x, depth + 1));
    }
    if (
      v &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype
    ) {
      const entries = Object.entries(v);
      if (entries.length > 128) return fail("size");
      const out: Record<string, DeviceJson> = {};
      for (const [k, x] of entries) {
        if (
          k.length > 256 ||
          ["__proto__", "constructor", "prototype"].includes(k)
        )
          return fail();
        out[k] = visit(x, depth + 1);
      }
      return out;
    }
    return fail();
  };
  const result = visit(raw, 0);
  if (
    new TextEncoder().encode(JSON.stringify(result)).length > DEVICE_FRAME_BYTES
  )
    return fail("size");
  return result;
}
export function validateDeviceOperation(raw: unknown): DeviceOperation {
  const v = deviceObject(raw, [
    "version",
    "kind",
    "pairId",
    "grantId",
    "from",
    "to",
    "scope",
    "sequence",
    "recordId",
    "context",
    "deleted",
    "value",
  ]);
  version(v.version);
  if (
    v.kind !== "operation" ||
    v.from === v.to ||
    !DEVICE_SCOPES.includes(v.scope as DeviceScope) ||
    typeof v.recordId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/.test(v.recordId) ||
    typeof v.deleted !== "boolean"
  )
    return fail();
  const sequence = deviceCount(v.sequence);
  if (!sequence) return fail();
  if (
    !v.context ||
    typeof v.context !== "object" ||
    Array.isArray(v.context) ||
    Object.getPrototypeOf(v.context) !== Object.prototype ||
    Object.keys(v.context).length > 2
  )
    return fail();
  const context: Record<string, number> = {};
  for (const [key, value] of Object.entries(v.context)) {
    if (key !== v.from && key !== v.to) return fail();
    context[deviceHex(key)] = deviceCount(value);
  }
  if (
    (context[v.from as string] ?? 0) >= sequence ||
    (v.deleted && v.value !== null)
  )
    return fail();
  const result: DeviceOperation = {
    version: 1,
    kind: "operation",
    pairId: deviceHex(v.pairId, 32),
    grantId: deviceHex(v.grantId),
    from: deviceHex(v.from),
    to: deviceHex(v.to),
    scope: v.scope as DeviceScope,
    sequence,
    recordId: v.recordId,
    context,
    deleted: v.deleted,
    value: boundedDeviceJson(v.value),
  };
  if (
    new TextEncoder().encode(JSON.stringify(result)).length > DEVICE_FRAME_BYTES
  )
    return fail("size");
  return result;
}
export function validateDeviceAck(raw: unknown): DeviceAck {
  const v = deviceObject(raw, [
    "version",
    "kind",
    "pairId",
    "grantId",
    "from",
    "to",
    "scope",
    "through",
  ]);
  version(v.version);
  if (
    v.kind !== "ack" ||
    v.from === v.to ||
    !DEVICE_SCOPES.includes(v.scope as DeviceScope)
  )
    return fail();
  return {
    version: 1,
    kind: "ack",
    pairId: deviceHex(v.pairId, 32),
    grantId: deviceHex(v.grantId),
    from: deviceHex(v.from),
    to: deviceHex(v.to),
    scope: v.scope as DeviceScope,
    through: deviceCount(v.through),
  };
}
export function parseDeviceMessage(text: string): DeviceMessage {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > DEVICE_FRAME_BYTES
  )
    return fail("size");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return fail();
  }
  const kind = (v as { kind?: unknown })?.kind;
  if (kind === "invite") return validateDeviceInvite(v);
  if (kind === "confirmation") return validateDeviceConfirmation(v);
  if (kind === "prepared") return validateDevicePrepared(v);
  if (kind === "operation") return validateDeviceOperation(v);
  if (kind === "ack") return validateDeviceAck(v);
  return fail();
}
const bytes = (fields: unknown[]) =>
  new TextEncoder().encode(JSON.stringify(fields));
export function deviceConfirmationCanonical(
  raw: DeviceConfirmationBody,
): Uint8Array {
  const b = validateConfirmationBody(raw);
  return bytes([
    "havvn/device-pairing/confirmation/v1",
    b.role,
    b.inviteId,
    b.pairId,
    b.grantId,
    b.initiatorId,
    b.responderId,
    b.initiatorCertificate,
    b.responderCertificate,
    b.scopes,
    b.challengeA,
    b.challengeB,
    b.channelBinding,
  ]);
}
export function devicePreparedCanonical(
  raw: DevicePrepared["body"],
): Uint8Array {
  const v = validateDevicePrepared({
    version: 1,
    kind: "prepared",
    body: raw,
    signature: "A".repeat(86) + "==",
  }).body;
  return bytes([
    "havvn/device-pairing/prepared/v1",
    v.pairId,
    v.grantId,
    v.from,
    v.to,
    v.transcript,
  ]);
}
