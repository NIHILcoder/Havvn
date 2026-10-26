import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deviceFilePersistence } from "./file-persistence";
import { DeviceVault, type DeviceVaultStorage } from "./vault";
import { memoryDeviceStorage } from "../../research/device-pairing/vault-fixture";
const roots: string[] = [],
  handles: DeviceVaultStorage[] = [];
const root = () => {
  const value = fs.mkdtempSync(
    path.join(os.tmpdir(), "havvn-device-vault-test-"),
  );
  roots.push(value);
  return value;
};
const io = (directory: string, initialize = false) => {
  const value = deviceFilePersistence(
    directory,
    memoryDeviceStorage().io(),
    initialize,
  );
  handles.push(value);
  return value;
};
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close?.();
  for (const directory of roots.splice(0)) {
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith("havvn-device-vault-test-")
    )
      throw Error("Unexpected test root");
    fs.rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 100,
    });
  }
});
it("atomically publishes ciphertext and leaves no temporary files after a successful write", async () => {
  const directory = root(),
    storage = io(directory, true),
    vault = await DeviceVault.initialize(storage);
  expect(fs.readdirSync(directory).sort()).toEqual([
    "device-state.json",
    "device-state.marker",
  ]);
  expect(
    fs.readFileSync(path.join(directory, "device-state.json"), "utf8"),
  ).not.toContain("PRIVATE KEY");
  await vault.close();
});
it("rejects another in-process owner and closing an old lease twice cannot release its successor", () => {
  const directory = root(),
    one = io(directory, true);
  expect(() => io(directory)).toThrow("state");
  one.close?.();
  const two = io(directory);
  one.close?.();
  expect(() => io(directory)).toThrow("state");
  two.close?.();
});
it("detects profile copies from the directory binding before attempting decryption", async () => {
  const a = root(),
    b = root(),
    first = io(a, true),
    vault = await DeviceVault.initialize(first);
  await vault.close();
  for (const name of fs.readdirSync(a))
    fs.copyFileSync(path.join(a, name), path.join(b, name));
  expect(() => io(b)).toThrow("clone");
});
it("missing state or marker does not silently create a replacement identity", async () => {
  const directory = root(),
    storage = io(directory, true),
    vault = await DeviceVault.initialize(storage);
  await vault.close();
  fs.unlinkSync(path.join(directory, "device-state.json"));
  expect(() => io(directory, true)).toThrow("missing");
  expect(fs.readdirSync(directory)).toEqual(["device-state.marker"]);
});
it("checks expected ciphertext before replacing a newer write", () => {
  const directory = root(),
    storage = io(directory, true);
  storage.write(null, "first-ciphertext");
  storage.write("first-ciphertext", "second-ciphertext");
  expect(() => storage.write("first-ciphertext", "stale-ciphertext")).toThrow(
    "stale",
  );
  expect(storage.read()).toBe("second-ciphertext");
});
it("keeps a corrupt envelope intact and refuses oversized files before JSON or OS decryption", async () => {
  const directory = root(),
    storage = io(directory, true),
    vault = await DeviceVault.initialize(storage);
  await vault.close();
  const file = path.join(directory, "device-state.json");
  fs.writeFileSync(file, "{broken");
  expect(() => DeviceVault.open(io(directory))).toThrow("invalid");
  expect(fs.readFileSync(file, "utf8")).toBe("{broken");
  const fd = fs.openSync(file, "w");
  fs.ftruncateSync(fd, 16 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  expect(() => io(directory)).toThrow("invalid");
});
