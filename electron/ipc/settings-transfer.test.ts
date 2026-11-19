import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { SettingsImportState } from "../../shared/settings-transfer";

type Handler = (event: unknown) => Promise<unknown>;
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  open: vi.fn(),
  save: vi.fn(),
  confirm: vi.fn(),
  read: vi.fn(),
  apply: vi.fn(),
  windows: [] as unknown[],
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: Handler) =>
      mocks.handlers.set(name, handler),
  },
  dialog: {
    showOpenDialog: mocks.open,
    showSaveDialog: mocks.save,
    showMessageBox: mocks.confirm,
  },
  BrowserWindow: { getAllWindows: () => mocks.windows },
}));
vi.mock("../db/store", () => ({
  readSettingsImportState: mocks.read,
  applySettingsImport: mocks.apply,
}));
import {
  readSettingsTransfer,
  registerSettingsTransferIpc,
} from "./settings-transfer";
import { SETTINGS_TRANSFER_MAX_BYTES } from "../../shared/settings-transfer";

const frame = {},
  sender = { mainFrame: frame, send: vi.fn() };
const win = { webContents: sender, isDestroyed: () => false };
const event = { sender, senderFrame: frame };
const current = {
  settings: {
    id: 1,
    portMin: 6881,
    portMax: 6889,
    maxDownKbps: 0,
    proxyPassword: "enc:v1:secret",
    customTurnCredential: "enc:v1:turn",
    webRemoteToken: "local-token",
  },
  categories: [
    { id: "movies", name: "Old movies", icon: "film", color: "#123456" },
  ],
  scheduler: { enabled: false, schedules: [] },
  privacyConfig: { vpnKillSwitch: true },
} as SettingsImportState;
let directory: string, input: string, output: string;
const bundle = () => ({
  version: 1,
  settings: { maxDownKbps: 100 },
  categories: [
    { id: "movies", name: "New movies", icon: "film", color: "#654321" },
    { id: "custom", name: "My category", icon: "folder", color: "#123456" },
  ],
});
const invoke = (kind: "import" | "export", from: unknown = event) =>
  mocks.handlers.get(`settings:${kind}`)!(from);

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.handlers.clear();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "havvn-settings-ipc-"));
  input = path.join(directory, "input.json");
  output = path.join(directory, "output.json");
  await fs.writeFile(input, JSON.stringify(bundle()));
  mocks.open.mockResolvedValue({ canceled: false, filePaths: [input] });
  mocks.save.mockResolvedValue({ canceled: false, filePath: output });
  mocks.confirm.mockResolvedValue({ response: 1 });
  mocks.read.mockImplementation(() => structuredClone(current));
  mocks.windows = [win];
  registerSettingsTransferIpc(() => win as unknown as BrowserWindow);
});
afterEach(async () => {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("havvn-settings-ipc-")
  )
    throw new Error("Unexpected test directory");
  await fs.rm(resolved, { recursive: true, force: true });
});

describe("settings transfer IPC", () => {
  it('keeps owner stages and confirmed cancellation/failure/success available after the invoking UI closes', async () => {
    const read = () => mocks.handlers.get('settings:export:operation')!(event);
    expect(await read()).toBeNull();
    let finish!: (value: unknown) => void;
    mocks.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const exporting = invoke('export');
    expect(await read()).toMatchObject({ stage: 'choose-file', status: 'waiting', waitingFor: 'save-dialog', progress: null });
    await expect(invoke('export')).rejects.toThrow('already in progress');
    finish({ canceled: true }); await exporting;
    expect(await read()).toMatchObject({ status: 'cancelled', lastResult: { stage: 'choose-file', status: 'cancelled' } });
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(directory, 'missing', 'out.json') });
    await expect(invoke('export')).rejects.toThrow();
    expect(await read()).toMatchObject({ status: 'failed', stage: 'write-export', actions: ['retry'] });
    expect(await invoke('export')).toMatchObject({ success: true });
    expect(await read()).toMatchObject({ status: 'succeeded', lastResult: { status: 'succeeded', stage: 'write-export' } });
    expect(() => mocks.handlers.get('settings:export:operation')!({ sender: {} })).toThrow('Untrusted');
  });
  it("previews added/updated categories before applying and invalidates all window category lists", async () => {
    expect(await invoke("import")).toEqual({ success: true });
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    const options = mocks.confirm.mock.calls[0][1];
    expect(options.detail).toContain("Old movies");
    expect(options.detail).toContain("New movies");
    expect(options.detail).toContain("My category");
    expect(options.detail).toContain(
      "Categories to add: 1. Categories to update by ID: 1.",
    );
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(0);
    expect(mocks.apply).toHaveBeenCalledWith(bundle(), current);
    expect(mocks.confirm.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.apply.mock.invocationCallOrder[0],
    );
    expect(sender.send).toHaveBeenCalledWith("categories:changed");
  });

  it("does not write or invalidate on file-dialog or preview cancellation", async () => {
    mocks.open.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await invoke("import")).toEqual({ success: false });
    expect(mocks.confirm).not.toHaveBeenCalled();
    mocks.confirm.mockResolvedValueOnce({ response: 0 });
    expect(await invoke("import")).toEqual({ success: false });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("rejects unsupported and corrupt imports before the preview or any write", async () => {
    for (const text of [
      "{invalid",
      JSON.stringify({ ...bundle(), version: 2 }),
      JSON.stringify({ ...bundle(), categories: [{ id: "bad" }] }),
    ]) {
      await fs.writeFile(input, text);
      await expect(invoke("import")).rejects.toThrow();
    }
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("never reports a failed commit as success or broadcasts invalidation", async () => {
    mocks.apply.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await expect(invoke("import")).rejects.toThrow("disk full");
    expect(sender.send).not.toHaveBeenCalled();
    expect(await invoke("import")).toEqual({ success: true });
  });

  it("authenticates the main frame for import and export before opening dialogs", async () => {
    for (const kind of ["import", "export"] as const) {
      await expect(
        invoke(kind, { sender: {}, senderFrame: frame }),
      ).rejects.toThrow("Untrusted");
      await expect(invoke(kind, { sender, senderFrame: {} })).rejects.toThrow(
        "Untrusted",
      );
    }
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("serializes transfers and releases the guard after cancellation", async () => {
    let resolve!: (value: unknown) => void;
    mocks.confirm.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const importing = invoke("import");
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    await expect(invoke("export")).rejects.toThrow("already in progress");
    resolve({ response: 0 });
    expect(await importing).toEqual({ success: false });
    expect(await invoke("export")).toEqual({ success: true, path: output });
  });

  it("refuses a changed window after the preview and does not apply its old request", async () => {
    let currentWindow = win;
    registerSettingsTransferIpc(
      () => currentWindow as unknown as BrowserWindow,
    );
    mocks.confirm.mockImplementationOnce(async () => {
      currentWindow = {
        webContents: { mainFrame: {}, send: vi.fn() },
        isDestroyed: () => false,
      };
      return { response: 1 };
    });
    await expect(invoke("import")).rejects.toThrow("Untrusted");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("does not report a committed import as failed if a window closes during invalidation", async () => {
    sender.send.mockImplementationOnce(() => {
      throw new Error("window closed");
    });
    expect(await invoke("import")).toEqual({ success: true });
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });

  it("exports a bounded portable v1 file without proxy/TURN credentials and remote tokens", async () => {
    expect(await invoke("export")).toEqual({ success: true, path: output });
    const text = await fs.readFile(output, "utf8"),
      exported = JSON.parse(text);
    expect(exported.version).toBe(1);
    expect(exported.categories).toEqual(current.categories);
    for (const privateValue of [
      "proxyPassword",
      "customTurnCredential",
      "webRemoteToken",
      "enc:v1:",
      "local-token",
    ])
      expect(text).not.toContain(privateValue);
    expect(await fs.readdir(directory)).toEqual(["input.json", "output.json"]);
  });

  it("preserves an existing export if validation fails, and releases the guard after errors", async () => {
    await fs.writeFile(output, "previous backup");
    mocks.read.mockReturnValueOnce({
      ...current,
      categories: [{ id: "invalid" }],
    });
    await expect(invoke("export")).rejects.toThrow();
    expect(await fs.readFile(output, "utf8")).toBe("previous backup");
    expect(await invoke("export")).toEqual({ success: true, path: output });
  });

  it("preserves an existing target and removes the temporary export when replacement fails", async () => {
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, "original.txt"), "original");
    await expect(invoke("export")).rejects.toThrow();
    expect(await fs.readFile(path.join(output, "original.txt"), "utf8")).toBe(
      "original",
    );
    expect(await fs.readdir(directory)).toEqual(["input.json", "output.json"]);
  });

  it("bounds selected files and rejects directories", async () => {
    await fs.writeFile(input, Buffer.alloc(SETTINGS_TRANSFER_MAX_BYTES + 1));
    await expect(readSettingsTransfer(input)).rejects.toThrow("oversized");
    await expect(readSettingsTransfer(directory)).rejects.toThrow();
  });
});
