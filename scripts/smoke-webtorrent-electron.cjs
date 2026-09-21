// Run with Node after npm run build:electron. Uses a temporary profile and loopback only.
if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [__filename], {
    env,
    windowsHide: true,
    stdio: "inherit",
  });
  child.on("error", (e) => {
    console.error(e);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  const { app, BrowserWindow, ipcMain, utilityProcess } = require("electron");
  const fs = require("fs"),
    os = require("os"),
    path = require("path"),
    assert = require("assert/strict");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "havvn-wt3-electron-"));
  app.setPath("userData", root);
  fs.mkdirSync(path.join(process.cwd(), "node_modules/.cache"), {
    recursive: true,
  });
  const result = {};
  let finished = false;
  const children = [];
  const timer = setTimeout(() => finish(2, "timeout"), 45000);
  function finish(code, error) {
    if (finished) return;
    finished = true;
    if (error) result.error = String(error);
    fs.writeFileSync(
      path.join(process.cwd(), "node_modules/.cache/wt3-electron.json"),
      JSON.stringify(result, null, 2),
    );
    for (const c of children) c.kill();
    clearTimeout(timer);
    app.exit(code);
  }
  app.on("window-all-closed", () => {});
  app
    .whenReady()
    .then(async () => {
      await new Promise((resolve, reject) => {
        const host = utilityProcess.fork(
          path.resolve("dist/electron/electron/torrent/host/torrent-host.js"),
          [],
          { stdio: "pipe" },
        );
        children.push(host);
        host.stderr.on("data", (d) => process.stderr.write(d));
        host.stdout.on("data", (d) => process.stdout.write(d));
        host.on("exit", (code) => {
          if (!result.host) reject(Error("host exit " + code));
        });
        host.on("spawn", () =>
          host.postMessage({
            kind: "init",
            env: {
              version: "3.0.6",
              isPackaged: false,
              tempDir: root,
              userDataDir: root,
              downloadsDir: root,
              engine: "webtorrent",
              engineBinary: null,
              engineStateDir: root,
            },
          }),
        );
        host.on("message", (m) => {
          if (m.kind === "db") {
            const value =
              m.fn === "getSettings"
                ? {
                    maxActiveDownloads: 3,
                    maxDownKbps: 0,
                    maxUpKbps: 0,
                    enableDHT: false,
                    enableUtp: false,
                    portMin: 0,
                  }
                : m.fn === "getPrivacyConfig"
                  ? {}
                  : [];
            host.postMessage({
              kind: "db-res",
              id: m.id,
              ok: true,
              result: value,
            });
          }
          if (m.kind === "ready")
            host.postMessage({
              kind: "rpc",
              id: 1,
              method: "getDownloads",
              args: [],
            });
          if (m.kind === "rpc-res") {
            try {
              assert.equal(m.ok, true);
              assert.deepEqual(m.result, []);
              result.host = "ready and getDownloads returned []";
              resolve();
            } catch (e) {
              reject(e);
            }
          }
        });
      });
      await new Promise((resolve, reject) => {
        const win = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: path.resolve(
              "dist/electron/electron/sharing/room-engine.js",
            ),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            backgroundThrottling: false,
          },
        });
        win.webContents.on("preload-error", (_e, _p, error) => reject(error));
        ipcMain.on("room-log", (_e, msg) => console.log("room:", msg));

        ipcMain.on("room-res", (_e, m) => {
          if (m.reqId === 1)
            win.webContents.send("room-cmd", {
              type: "join",
              reqId: 2,
              payload: {},
            });
          if (m.reqId === 2) {
            if (!m.ok && m.error.includes("VPN is down")) {
              result.room = "ESM loaded; suspended join correctly rejected";
              win.destroy();
              resolve();
            } else reject(Error(JSON.stringify(m)));
          }
        });
        const page = path.join(root, "room.html");
        fs.writeFileSync(page, "<!doctype html><html><body></body></html>");
        win
          .loadFile(page)
          .then(() =>
            win.webContents.send("room-cmd", { type: "netSuspend", reqId: 1 }),
          )
          .catch(reject);
      });
      await new Promise((resolve, reject) => {
        const win = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: path.resolve("scripts/smoke-webtorrent-rtc-preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
          },
        });
        win.webContents.on("preload-error", (_e, _p, error) => reject(error));
        ipcMain.once("wt3-rtc", (_e, m) => {
          win.destroy();
          if (m.ok) {
            result.rtc = "Chromium native peers exchanged data";
            resolve();
          } else reject(Error(m.error));
        });
        win.loadFile(path.join(root, "room.html")).catch((error) => {
          if (!win.isDestroyed()) reject(error);
        });
      });
      finish(0);
    })
    .catch((e) => finish(1, e.stack));
}
