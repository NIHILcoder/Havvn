// Production encrypted store across three separate Electron launches.
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "havvn-events-"));
  const env = { ...process.env, HAVVN_EVENTS_SCRATCH: scratch };
  delete env.ELECTRON_RUN_AS_NODE;
  (async () => {
    for (const phase of ["record", "recover", "verify"])
      await new Promise((resolve, reject) => {
        const child = require("node:child_process").spawn(
          require("electron"),
          [__filename, phase],
          { env, windowsHide: true, stdio: "inherit" },
        );
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0
            ? resolve()
            : reject(Error("Event phase failed: " + phase)),
        );
      });
  })()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      const target = path.resolve(scratch);
      if (
        path.dirname(target) !== path.resolve(os.tmpdir()) ||
        !path.basename(target).startsWith("havvn-events-")
      )
        throw Error("Unexpected event fixture path");
      fs.rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
} else {
  const { app } = require("electron"),
    scratch = path.resolve(process.env.HAVVN_EVENTS_SCRATCH || "");
  if (
    path.dirname(scratch) !== path.resolve(os.tmpdir()) ||
    !path.basename(scratch).startsWith("havvn-events-")
  )
    throw Error("Missing isolated profile");
  app.setPath("userData", path.join(scratch, "profile"));
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => app.exit(1), 30000);
  app
    .whenReady()
    .then(() => {
      const store =
          require("../dist/electron/electron/services/app-events.js").getAppEvents(),
        phase = process.argv[2];
      if (phase === "record") {
        store.record(
          "download-error",
          { kind: "download", id: "private-download-id" },
          { reason: "disk-full" },
        );
        store.record("room-disconnected", {
          kind: "room",
          id: "private-room-id",
        });
        store.record("settings-exported", { kind: "system" });
        store.read("all");
        assert.equal(store.summary().storage, "ready");
        assert.equal(store.summary().active, 2);
        const raw = fs.readFileSync(
          path.join(scratch, "profile", "events.json"),
          "utf8",
        );
        assert.ok(raw.includes("enc:v1:"));
        assert.ok(!raw.includes("private-download-id"));
        assert.ok(!raw.includes("room-disconnected"));
      } else if (phase === "recover") {
        assert.equal(store.summary().active, 2);
        assert.equal(store.summary().unread, 0);
        store.resolve("download-error", {
          kind: "download",
          id: "private-download-id",
        });
        store.resolve("room-disconnected", {
          kind: "room",
          id: "private-room-id",
        });
        assert.equal(store.summary().active, 0);
      } else {
        assert.equal(store.summary().active, 0);
        assert.equal(store.summary().total, 3);
        assert.equal(
          store.list().items.filter((e) => e.problem === "resolved").length,
          2,
        );
      }
      console.log("PASS production event history " + phase);
      clearTimeout(deadline);
      app.quit();
    })
    .catch((error) => {
      console.error(error);
      clearTimeout(deadline);
      app.exit(1);
    });
}
