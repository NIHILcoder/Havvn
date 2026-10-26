import { expect, it } from "vitest";
import {
  deviceConfirmationCanonical,
  devicePreparedCanonical,
  parseDeviceMessage,
  validateDeviceInvite,
  validateDeviceOperation,
  type DeviceConfirmationBody,
  type DeviceOperation,
} from "./device-pairing";
const body = (): DeviceConfirmationBody => ({
  version: 1,
  role: "initiator",
  inviteId: "1".repeat(32),
  pairId: "2".repeat(32),
  grantId: "3".repeat(64),
  initiatorId: "a".repeat(64),
  responderId: "b".repeat(64),
  initiatorCertificate: "c".repeat(64),
  responderCertificate: "d".repeat(64),
  scopes: ["views", "preferences"],
  challengeA: "4".repeat(64),
  challengeB: "5".repeat(64),
  channelBinding: "6".repeat(64),
});
const op = (): DeviceOperation => ({
  version: 1,
  kind: "operation",
  pairId: "2".repeat(32),
  grantId: "3".repeat(64),
  from: "a".repeat(64),
  to: "b".repeat(64),
  scope: "preferences",
  sequence: 1,
  recordId: "language",
  context: {},
  deleted: false,
  value: "ru",
});
it("canonicalizes confirmed scopes and fields independent of property insertion order", () => {
  const a = body(),
    b = {
      ...Object.fromEntries(Object.entries(a).reverse()),
      scopes: ["preferences", "views"],
    } as DeviceConfirmationBody;
  expect(deviceConfirmationCanonical(a)).toEqual(
    deviceConfirmationCanonical(b),
  );
  expect(deviceConfirmationCanonical({ ...a, role: "responder" })).not.toEqual(
    deviceConfirmationCanonical(a),
  );
  expect(
    deviceConfirmationCanonical({ ...a, channelBinding: "7".repeat(64) }),
  ).not.toEqual(deviceConfirmationCanonical(a));
});
it("separates signed confirmation and prepared-receipt domains", () => {
  const a = body(),
    ready = {
      pairId: a.pairId,
      grantId: a.grantId,
      from: a.initiatorId,
      to: a.responderId,
      transcript: "7".repeat(64),
    };
  expect(new TextDecoder().decode(deviceConfirmationCanonical(a))).toContain(
    "confirmation/v1",
  );
  expect(new TextDecoder().decode(devicePreparedCanonical(ready))).toContain(
    "prepared/v1",
  );
});
it("rejects unknown versions, fields, message kinds and attempts to attach private keys", () => {
  for (const value of [
    { ...op(), version: 2 },
    { ...op(), extra: "x" },
    { ...op(), kind: "shell" },
    null,
    { ...op(), privateKey: "secret" },
  ])
    expect(() => parseDeviceMessage(JSON.stringify(value))).toThrow();
});
it("rejects overflow, nonfinite values, deep JSON and prototype payloads", () => {
  expect(() => parseDeviceMessage("x".repeat(65537))).toThrow("size");
  expect(() => validateDeviceOperation({ ...op(), value: Infinity })).toThrow();
  let nested: unknown = "x";
  for (let i = 0; i < 10; i++) nested = [nested];
  expect(() => validateDeviceOperation({ ...op(), value: nested })).toThrow(
    "size",
  );
  expect(() =>
    parseDeviceMessage(
      JSON.stringify(op()).replace('"value":"ru"', '"value":{"__proto__":"x"}'),
    ),
  ).toThrow();
});
it("checks operation clocks, authors, counters and tombstones", () => {
  for (const value of [
    { ...op(), from: op().to },
    { ...op(), sequence: 0 },
    { ...op(), context: { [op().from]: 1 } },
    { ...op(), context: { intruder: 1 } },
    { ...op(), deleted: true, value: "data" },
  ])
    expect(() => validateDeviceOperation(value)).toThrow();
  expect(
    validateDeviceOperation({ ...op(), deleted: true, value: null }).deleted,
  ).toBe(true);
});
it("invitation parsing is strict before any certificate or token is used", () => {
  expect(() =>
    validateDeviceInvite({
      version: 1,
      kind: "invite",
      token: "short",
      endpoint: { host: "file://private", port: 0 },
    }),
  ).toThrow();
});
