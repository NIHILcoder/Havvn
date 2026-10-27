/* eslint-disable @typescript-eslint/no-require-imports -- Isolated main/renderer crash acceptance. */
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."),
  prefix = "havvn-device-data-";
function isolated(value) {
  const target = path.resolve(value);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith(prefix)
  )
    throw Error("Unexpected test root");
  return target;
}
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const launch = (stage, crash = false) =>
    new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        HAVVN_DP03_SCRATCH: scratch,
        HAVVN_DP03_STAGE: stage,
        HAVVN_DP03_REPO: root,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      let killed = false;
      const child = require("node:child_process").spawn(
        require("electron"),
        [__filename],
        { env, windowsHide: true, stdio: ["ignore", "pipe", "inherit"] },
      );
      require("node:readline")
        .createInterface({ input: child.stdout })
        .on("line", (line) => {
          if (line === "DP03_CRASH_READY" && crash) {
            killed = child.kill("SIGKILL");
          } else console.log(line);
        });
      child.on("error", reject);
      child.once("exit", (code) =>
        (crash ? killed : code === 0)
          ? resolve()
          : reject(Error("DP-03 stage failed: " + stage)),
      );
    });
  (async () => {
    try {
      await launch("initialize");
      await launch("crash-after-renderer", true);
      await launch("recover-and-revoke");
    } finally {
      fs.rmSync(isolated(scratch), {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow, safeStorage } = require("electron"),
    scratch = isolated(process.env.HAVVN_DP03_SCRATCH || ""),
    stage = process.env.HAVVN_DP03_STAGE;
  app.setPath("userData", path.join(scratch, "profile"));
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => app.exit(2), 90000);
  app
    .whenReady()
    .then(async () => {
      if (
        !safeStorage.isEncryptionAvailable() ||
        !app.requestSingleInstanceLock()
      )
        throw Error("OS protection/ownership unavailable");
      const compiled = path.join(root, "dist/electron"),
        load = (name) =>
          require(path.join(compiled, "electron/devices", name + ".js"));
      const { openDeviceVault } = load("runtime"),
        { openDeviceBootstrap, pairDevice } = load("bootstrap"),
        { openDeviceSessionServer, connectDeviceSession } = load("session");
      const { DeviceReplicator } = load("replicator"),
        { attachDeviceRendererTarget } = load("renderer-target");
      const { encryptSecret, decryptSecretStrict } = require(
        path.join(compiled, "electron/db/secrets.js"),
      );
      const out = path.join(root, "artifacts/dp03/native.json");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      if (stage === "initialize" && fs.existsSync(out)) fs.unlinkSync(out);
      const report = fs.existsSync(out)
        ? JSON.parse(fs.readFileSync(out))
        : {
            schema: 1,
            physicalMachines: 1,
            nativeProcesses: 3,
            rendererPartitions: 2,
            independentKeys: true,
            actualSafeStorage: true,
            realTls: true,
            actualRendererLocalStorage: true,
            powerCutTested: false,
            physicalNetworkTested: false,
            userUiTested: false,
            electron: process.versions.electron,
            node: process.versions.node,
            opensslReported: process.versions.openssl,
            stages: {},
          };
      const checks = [],
        check = (condition, label) => {
          assert(condition, label);
          checks.push(label);
          console.log("PASS " + label);
        };
      const receipt = () => {
        report.stages[stage] = { passed: true, checks };
        report.at = new Date().toISOString();
        report.passed = stage === "recover-and-revoke";
        fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
      };
      const a = await openDeviceVault({
          directory: path.join(app.getPath("userData"), "a"),
          initialize: stage === "initialize",
        }),
        b = await openDeviceVault({
          directory: path.join(app.getPath("userData"), "b"),
          initialize: stage === "initialize",
        });
      const contexts = {
        a: { categories: {}, categoryIds: [], media: [], activeMedia: [] },
        b: { categories: {}, categoryIds: [], media: [], activeMedia: [] },
      };
      const windows = {},
        targets = {};
      for (const name of ["a", "b"]) {
        const window = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: path.join(
              root,
              "research/device-pairing/data-preload.cjs",
            ),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            partition: "persist:dp03-" + name,
            backgroundThrottling: false,
          },
        });
        windows[name] = window;
        targets[name] = attachDeviceRendererTarget(
          name === "a" ? a : b,
          window.webContents,
          () => contexts[name],
        );
        await window.loadFile(
          path.join(root, "research/device-pairing/data-target.html"),
        );
        check(
          await window.webContents.executeJavaScript(
            'typeof window.dataTest === "object"',
          ),
          "trusted renderer " + name + " attaches its isolated data adapter",
        );
      }
      const js = (name, code) =>
          windows[name].webContents.executeJavaScript(code),
        get = (name, key) =>
          js(name, "window.dataTest.get(" + JSON.stringify(key) + ")"),
        set = (name, key, value) =>
          js(
            name,
            "window.dataTest.set(" +
              JSON.stringify(key) +
              "," +
              JSON.stringify(value) +
              ")",
          );
      let ra = new DeviceReplicator(a, targets.a),
        rb = new DeviceReplicator(b, targets.b);
      const factsFile = path.join(scratch, "facts.enc");
      if (stage === "initialize") {
        check(
          a.publicIdentity().deviceId !== b.publicIdentity().deviceId,
          "initialize independent protected identities before the crash experiment",
        );
        await ra.close();
        await rb.close();
        targets.a.close();
        targets.b.close();
        for (const window of Object.values(windows)) window.destroy();
        await a.close();
        await b.close();
        receipt();
        clearTimeout(deadline);
        app.quit();
        return;
      }
      if (stage === "crash-after-renderer") {
        check(
          a.publicIdentity().deviceId !== b.publicIdentity().deviceId,
          "native keys are independent",
        );
        const bootstrap = await openDeviceBootstrap(
          a,
          ["preferences", "views", "playback"],
          async () => true,
        );
        await pairDevice(b, bootstrap.invitation, async () => true);
        await bootstrap.close();
        check(
          a.snapshot().status === "active" && b.snapshot().status === "active",
          "both native grants are active before data exchange",
        );
        await set("a", "language", "ru");
        const operation = await ra.publish("preferences", "language", "ru");
        fs.writeFileSync(
          factsFile,
          encryptSecret(JSON.stringify({ operation }), false),
        );
        const original = targets.b.apply;
        targets.b.apply = async (job) => {
          await original(job);
          windows.b.webContents.session.flushStorageData();
          check(
            (await get("b", "language")) === "ru",
            "real renderer write/readback completes before the main commit",
          );
          check(
            !!b.pendingDataJob() &&
              b.replicaState().inbox.preferences.floor === 0,
            "main retains the prepared job and has not acknowledged the operation",
          );
          check(
            a.snapshot().outbox === 1,
            "sender retains the operation until application commit",
          );
          receipt();
          console.log("DP03_CRASH_READY");
          await new Promise(() => {});
        };
        const server = await openDeviceSessionServer(
          b,
          async (session) => {
            try {
              const message = await session.receive();
              if (message.kind !== "operation")
                throw Error("Unexpected test frame");
              const ack = await rb.receive(message);
              if (ack) await session.send(ack);
            } catch (error) {
              console.error(error.stack);
              throw error;
            }
          },
          (code) => console.log("NATIVE DATA SESSION " + code),
        );
        const client = await connectDeviceSession(a, server.port);
        await client.send(operation);
        await client.receive();
        throw Error("Crash injection did not run");
      }
      const facts = JSON.parse(
        decryptSecretStrict(fs.readFileSync(factsFile, "utf8")),
      );
      const targetSurvived = await get("b", "language");
      report.rendererCrashCheckpoint =
        targetSurvived === null
          ? "before"
          : targetSurvived === "ru"
            ? "after"
            : "unexpected";
      check(
        !!b.pendingDataJob() &&
          (targetSurvived === null || targetSurvived === "ru"),
        "the protected main job survives and renderer storage remains at its known before/after value",
      );
      const writes = await js("b", "window.dataTest.writes()");
      await rb.recover();
      check(
        (await js("b", "window.dataTest.writes()")) ===
          writes + (targetSurvived === null ? 1 : 0) &&
          (await get("b", "language")) === "ru" &&
          !b.pendingDataJob(),
        "recovery restores a lost renderer cache or reads an already persisted target without duplicate writes",
      );
      const ack = await rb.receive(facts.operation);
      await a.acknowledge(ack);
      check(
        ack.through === 1 && a.snapshot().outbox === 0,
        "duplicate delivery after restart durably completes the ACK and outbox",
      );
      const syncId = "1".repeat(32),
        view = {
          version: 1,
          syncViewId: syncId,
          name: "Crash test view",
          pinned: true,
          conditions: { status: "all", name: "", path: "" },
          sort: { by: "added", direction: "desc" },
          mode: "compact",
        };
      const local = {
        id: "local-view",
        name: view.name,
        pinned: view.pinned,
        conditions: view.conditions,
        sort: view.sort,
        mode: view.mode,
      };
      await set(
        "a",
        "havvn.download-views.v1",
        JSON.stringify({ version: 1, views: [local], activeId: "local-view" }),
      );
      await js(
        "a",
        'window.dataTest.bind("local-view",' + JSON.stringify(syncId) + ")",
      );
      const viewOp = await ra.publish("views", "view." + syncId, view);
      await js("b", "window.dataTest.failAfter(1)");
      await assert.rejects(rb.receive(viewOp));
      check(
        !!b.pendingDataJob() && b.replicaState().inbox.views.floor === 0,
        "a real localStorage failure leaves a durable unacknowledged two-key journal",
      );
      check(
        (await get("b", "havvn.download-views.v1")) !== null &&
          (await get("b", "havvn.devices.data.v1")) === null,
        "the failure was injected between the actual catalog and stable-ID mapping writes",
      );
      await js("b", "window.dataTest.failAfter(null)");
      await rb.recover();
      const viewAck = await rb.receive(viewOp);
      await a.acknowledge(viewAck);
      check(
        viewAck.through === 1 &&
          JSON.parse(await get("b", "havvn.devices.data.v1")).views[syncId],
        "partial target application resumes and commits the stable view mapping",
      );
      check(
        JSON.parse(await get("b", "havvn.download-views.v1")).activeId === null,
        "a remote view does not change the local active view",
      );
      const media = {
          infoHash: "a".repeat(40),
          path: "Series/E01.mkv",
          size: 1000,
        },
        recordId = load("replica-state").mediaRecordId(media);
      contexts.a.media = [
        {
          ...media,
          recordId,
          identity: media.infoHash,
          downloadId: "local-a",
          title: "Source title",
          fileIndex: 9,
        },
      ];
      const localFile = {
        ...media,
        recordId,
        identity: media.infoHash,
        downloadId: "local-b",
        title: "Local B title",
        fileIndex: 2,
      };
      const seedWatch = async (position) => {
        const file = contexts.a.media[0];
        // playerFileKey is the application's actual key, not a test-only lookup.
        const { watchKey } = require(
          path.join(compiled, "shared/watch-history.js"),
        );
        const actualKey = watchKey(file);
        await set(
          "a",
          "havvn.watchHistory.v1",
          JSON.stringify({
            version: 1,
            epoch: 0,
            entries: {
              [actualKey]: {
                identity: file.identity,
                downloadId: file.downloadId,
                title: file.title,
                path: file.path,
                fileIndex: file.fileIndex,
                position,
                duration: 100,
                completed: false,
                lastOpened: 1,
                updatedAt: 2,
              },
            },
            revisions: {},
            serials: {},
            pending: {},
            migrated: true,
          }),
        );
      };
      await seedWatch(80);
      const playback = await ra.publish("playback", recordId, {
        version: 1,
        ...media,
        position: 80,
        duration: 100,
        completed: false,
      });
      check(
        (await rb.receive(playback)) === null &&
          (await get("b", "havvn.watchHistory.v1")) === null,
        "missing media remains pending without creating a history entry",
      );
      contexts.b.media = [localFile];
      contexts.b.activeMedia = [recordId];
      check(
        (await rb.retry("playback", recordId)) === null,
        "an active local player blocks application of the remote position",
      );
      contexts.b.activeMedia = [];
      const playbackAck = await rb.retry("playback", recordId);
      await a.acknowledge(playbackAck);
      const entry = Object.values(
        JSON.parse(await get("b", "havvn.watchHistory.v1")).entries,
      )[0];
      check(
        entry.position === 80 &&
          entry.downloadId === "local-b" &&
          entry.fileIndex === 2 &&
          entry.title === "Local B title",
        "renderer history uses the exact local media target and preserves local metadata",
      );
      await seedWatch(0);
      const restarted = await ra.publish("playback", recordId, {
        version: 1,
        ...media,
        position: 0,
        duration: 100,
        completed: false,
      });
      await a.acknowledge(await rb.receive(restarted));
      check(
        Object.values(
          JSON.parse(await get("b", "havvn.watchHistory.v1")).entries,
        )[0].position === 0,
        "a deliberate restart from zero is applied instead of retaining the greatest position",
      );
      // Keep a genuine mTLS connection open while revoking an independently journaled edit.
      let connectionResolve, holdResolve;
      const connected = new Promise((resolve) => {
          connectionResolve = resolve;
        }),
        hold = new Promise((resolve) => {
          holdResolve = resolve;
        });
      const server = await openDeviceSessionServer(b, async (session) => {
        connectionResolve(session);
        await hold;
      });
      const client = await connectDeviceSession(a, server.port);
      await connected;
      await set("a", "language", "en");
      const op = await ra.publish("preferences", "language", "en");
      let enteredResolve, release;
      const entered = new Promise((resolve) => {
          enteredResolve = resolve;
        }),
        gate = new Promise((resolve) => {
          release = resolve;
        });
      const original = targets.b.apply;
      targets.b.apply = async (job) => {
        await original(job);
        enteredResolve();
        await gate;
      };
      const applying = rb.receive(op),
        denied = assert.rejects(applying);
      await entered;
      let revoked = false;
      const revoking = b.revoke().then(() => {
        revoked = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      check(
        !revoked,
        "successful revocation waits for the in-flight renderer write",
      );
      const disconnected = assert.rejects(client.receive());
      release();
      await revoking;
      await denied;
      await disconnected;
      check(
        (await get("b", "language")) === "ru",
        "revocation rolls back the uncommitted renderer value with a checked journal patch",
      );
      check(
        b.snapshot().status === "revoked" && !b.pendingDataJob(),
        "only the completed rollback permits durable revocation success",
      );
      check(
        a.snapshot().outbox === 1,
        "the rolled-back operation never receives an application ACK",
      );
      holdResolve();
      client.close();
      await server.close();
      await ra.close();
      await rb.close();
      targets.a.close();
      targets.b.close();
      for (const window of Object.values(windows)) window.destroy();
      await a.close();
      await b.close();
      check(
        !fs.existsSync(path.join(app.getPath("userData"), "rooms.json")),
        "device data acceptance never creates or copies the room identity store",
      );
      receipt();
      clearTimeout(deadline);
      app.exit(0);
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.stack : "Native data acceptance failed",
      );
      clearTimeout(deadline);
      app.exit(1);
    });
}
