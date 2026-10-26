/* eslint-disable @typescript-eslint/no-require-imports -- Isolated native TLS/DPAPI acceptance. */
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const assert = require("node:assert/strict"),
  { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, ".."),
  prefix = "havvn-device-tls-";
function isolated(value) {
  const target = path.resolve(value);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith(prefix)
  )
    throw Error("Unexpected test profile");
  return target;
}
function protectCommand(value, key) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
function unprotectCommand(value, key) {
  const cipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    value.subarray(0, 12),
  );
  cipher.setAuthTag(value.subarray(-16));
  return JSON.parse(
    Buffer.concat([
      cipher.update(value.subarray(12, -16)),
      cipher.final(),
    ]).toString(),
  );
}
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    children = new Set(),
    checks = [];
  let processCount = 0;
  const check = (ok, label) => {
    assert(ok, label);
    checks.push(label);
    console.log("PASS " + label);
  };
  const launch = (name, initialize = false) => {
    processCount++;
    const control = path.join(scratch, "control", name + "-" + processCount),
      controlKey = crypto.randomBytes(32);
    fs.mkdirSync(control, { recursive: true });
    const env = {
      ...process.env,
      HAVVN_DP02_SCRATCH: scratch,
      HAVVN_DP02_DEVICE: name,
      HAVVN_DP02_INITIALIZE: initialize ? "1" : "0",
      HAVVN_DP02_CONTROL: control,
      HAVVN_DP02_CONTROL_KEY: controlKey.toString("hex"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename], {
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let next = 0,
      pending = new Map(),
      readyResolve,
      readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const exited = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => {
        children.delete(child);
        if (code === 0) resolve();
        else reject(Error("Native child failed: " + name));
      });
    });
    // Secrets travel only through these private test pipes, never console/artifacts.
    require("node:readline")
      .createInterface({ input: child.stdout })
      .on("line", (line) => {
        if (!line.startsWith("DP02:")) return;
        const frame = JSON.parse(line.slice(5));
        if (frame.diagnostic) {
          console.log("DIAGNOSTIC " + frame.diagnostic + " " + frame.code);
          return;
        }
        if (frame.ready) {
          readyResolve(frame.value);
          return;
        }
        const call = pending.get(frame.id);
        if (!call) return;
        pending.delete(frame.id);
        clearTimeout(call.timer);
        if (frame.ok) call.resolve(frame.value);
        else call.reject(Error("Native command: " + frame.code));
      });
    child.stderr.on("data", () => {}); // Native errors are reduced to codes by the child.
    exited.catch((error) => {
      readyReject(error);
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(error);
      }
      pending.clear();
    });
    const rpc = (command, value) =>
      new Promise((resolve, reject) => {
        const id = ++next,
          timer = setTimeout(() => {
            pending.delete(id);
            reject(Error("Native command deadline: " + command));
          }, 20000);
        pending.set(id, { resolve, reject, timer });
        const file = path.join(control, String(id) + ".cmd"),
          temporary = file + ".tmp";
        fs.writeFileSync(
          temporary,
          protectCommand({ id, command, value }, controlKey),
        );
        fs.renameSync(temporary, file);
      });
    return {
      ready,
      rpc,
      stop: async () => {
        await rpc("shutdown");
        await exited;
      },
    };
  };
  (async () => {
    try {
      let a = launch("a", true),
        b = launch("b", true);
      const [pa, pb] = await Promise.all([a.ready, b.ready]);
      check(
        pa.deviceId !== pb.deviceId,
        "two concurrent Electron processes own different protected identities",
      );
      const invite = await a.rpc("bootstrap");
      await b.rpc("pair", invite);
      check(
        (await a.rpc("snapshot")).status === "active" &&
          (await b.rpc("snapshot")).status === "active",
        "real TLS bootstrap commits both explicit test approvals",
      );
      check(
        (await a.rpc("binding")) === (await b.rpc("binding")),
        "both signed transcripts contain the same live TLS exporter",
      );
      const oldReady = await b.rpc("prepared");
      const port = await a.rpc("serve");
      await b.rpc("connect", port);
      const security = await b.rpc("security");
      check(
        security.protocol === "TLSv1.3" &&
          security.authorized &&
          !security.resumed &&
          security.alpn === "havvn-device-v1",
        "subsequent connection is a fresh authenticated TLS 1.3 session",
      );
      const op = await b.rpc("enqueue", {
        scope: "preferences",
        recordId: "dp02-canary",
        value: "dp02-private-value",
      });
      const received = a.rpc("receive");
      await b.rpc("send", op);
      assert.deepEqual(await received, op);
      check(
        (await b.rpc("snapshot")).outbox === 1,
        "receiving a network operation does not acknowledge application commit",
      );
      const ack = {
        version: 1,
        kind: "ack",
        pairId: op.pairId,
        grantId: op.grantId,
        from: op.to,
        to: op.from,
        scope: op.scope,
        through: op.sequence,
      };
      await a.rpc("send", ack);
      await b.rpc("receive");
      check(
        (await b.rpc("snapshot")).outbox === 0,
        "explicit authenticated test ACK durably retires the outbox",
      );
      const early = await b.rpc("probe-ticket", { port, peer: pa });
      check(
        (early.tickets === 0 || early.maxEarlyData === 0) && !early.reused,
        "native TLS either suppresses tickets or advertises zero early data and never resumes",
      );
      const selected = await a.rpc("enqueue", {
        scope: "views",
        recordId: "selected-before-revoke",
        value: "dp02-private-value",
      });
      const blocked = b.rpc("receive").then(
        () => false,
        () => true,
      );
      await a.rpc("revoke");
      check(
        await blocked,
        "revocation closes the other process pending on the open TLS connection",
      );
      check(
        (await a.rpc("snapshot")).status === "revoked",
        "revocation is durable before success is reported",
      );
      await assert.rejects(a.rpc("send", selected));
      check(
        true,
        "an operation selected before revocation cannot be written afterward",
      );
      await Promise.all([a.stop(), b.stop()]);

      a = launch("a");
      b = launch("b");
      await Promise.all([a.ready, b.ready]);
      check(
        (await a.rpc("snapshot")).status === "revoked",
        "revocation survives a new native process and OS decryption",
      );
      await assert.rejects(a.rpc("serve"));
      await assert.rejects(a.rpc("activate", oldReady));
      check(
        true,
        "old listeners and signed prepared receipts cannot resurrect the revoked grant",
      );
      await b.rpc("revoke");
      const next = await a.rpc("bootstrap", { dropFinal: true });
      await assert.rejects(b.rpc("pair", next));
      check(
        (await a.rpc("snapshot")).status === "active" &&
          (await b.rpc("snapshot")).status === "prepared",
        "connection loss before the final reply leaves recoverable active/prepared states",
      );
      check(
        next.grantId !== invite.grantId,
        "re-pairing creates a new grant and keeps the old tombstone",
      );
      await Promise.all([a.stop(), b.stop()]);

      a = launch("a");
      b = launch("b");
      await Promise.all([a.ready, b.ready]);
      const recoveredPort = await a.rpc("serve");
      await b.rpc("connect", recoveredPort);
      check(
        (await a.rpc("snapshot")).status === "active" &&
          (await b.rpc("snapshot")).status === "active",
        "mutual TLS restores the lost final reply after both processes restart",
      );
      await assert.rejects(a.rpc("activate", oldReady));
      await assert.rejects(b.rpc("send", op));
      check(
        (await a.rpc("snapshot")).revokedGrants === 1,
        "old proof and old queued operation remain invalid after the new grant activates",
      );
      check(
        (await a.rpc("protected", { tokens: [invite.token, next.token] })) &&
          (await b.rpc("protected", { tokens: [invite.token, next.token] })),
        "native state files contain no plaintext key, token or queued canary and create no room store",
      );
      const native = await a.rpc("versions");
      await Promise.all([a.stop(), b.stop()]);
      fs.mkdirSync(path.join(root, "artifacts/dp02"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "artifacts/dp02/native.json"),
        JSON.stringify(
          {
            schema: 1,
            at: new Date().toISOString(),
            passed: true,
            processes: processCount,
            physicalMachines: 1,
            isolatedProfiles: 2,
            ...native,
            actualSafeStorage: true,
            tls: security,
            ticketProbe: early,
            consent:
              "explicit deterministic test callbacks on both devices; no user UI",
            applicationJournalTested: false,
            physicalNetworkTested: false,
            installerTested: false,
            checks,
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      for (const child of children) child.kill();
      // All children must release files before removing this exact isolated test root.
      await Promise.all(
        [...children].map(
          (child) => new Promise((resolve) => child.once("exit", resolve)),
        ),
      );
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
  const { app, safeStorage } = require("electron"),
    scratch = isolated(process.env.HAVVN_DP02_SCRATCH || "");
  const name = process.env.HAVVN_DP02_DEVICE;
  if (!["a", "b"].includes(name)) throw Error("Missing isolated device");
  app.setPath("userData", path.join(scratch, "profiles", name));
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => app.exit(2), 120000);
  const emit = (frame) =>
    process.stdout.write("DP02:" + JSON.stringify(frame) + "\n");
  app
    .whenReady()
    .then(async () => {
      if (
        !safeStorage.isEncryptionAvailable() ||
        !app.requestSingleInstanceLock()
      )
        throw Error("OS protection/ownership unavailable");
      const compiled = path.join(root, "dist/electron/electron/devices");
      const { openDeviceVault } = require(path.join(compiled, "runtime.js"));
      const { openDeviceBootstrap, pairDevice } = require(
        path.join(compiled, "bootstrap.js"),
      );
      const { openDeviceSessionServer, connectDeviceSession } = require(
        path.join(compiled, "session.js"),
      );
      const { deviceDns } = require(path.join(compiled, "identity.js"));
      const { DeviceWire } = require(path.join(compiled, "wire.js"));
      const { decryptSecretStrict } = require(
        path.join(root, "dist/electron/electron/db/secrets.js"),
      );
      const directory = path.join(app.getPath("userData"), "devices");
      const vault = await openDeviceVault({
        directory,
        initialize: process.env.HAVVN_DP02_INITIALIZE === "1",
      });
      const originalServer = vault.createTlsServer.bind(vault);
      vault.createTlsServer = (peer) => {
        const server = originalServer(peer);
        server.on("tlsClientError", (error) =>
          emit({ diagnostic: "server TLS", code: error.code || "unknown" }),
        );
        return server;
      };
      const tlsModule = require("node:tls"),
        originalConnect = tlsModule.connect;
      tlsModule.connect = function (...args) {
        const socket = originalConnect.apply(this, args);
        socket.on("error", (error) =>
          emit({ diagnostic: "client TLS", code: error.code || "unknown" }),
        );
        return socket;
      };
      const originalActivate = vault.activate.bind(vault),
        listeners = [];
      let session, bootstrap, sessionResolve;
      const sessionReady = new Promise((resolve) => {
        sessionResolve = resolve;
      });
      const yes = async () => true; // Harness consent only. Never wired into product startup.
      let commandTimer;
      const run = async (command, value) => {
        if (command === "snapshot") return vault.snapshot();
        if (command === "versions")
          return {
            electron: process.versions.electron,
            node: process.versions.node,
            openssl: process.versions.openssl,
          };
        if (command === "binding") {
          const state = JSON.parse(
            decryptSecretStrict(
              JSON.parse(
                fs.readFileSync(path.join(directory, "device-state.json")),
              ).payload,
            ),
          );
          return state.pair.body.channelBinding;
        }
        if (command === "bootstrap") {
          if (value?.dropFinal)
            vault.activate = async (receipt) => {
              await originalActivate(receipt);
              await bootstrap.close();
              vault.activate = originalActivate;
            };
          bootstrap = await openDeviceBootstrap(
            vault,
            ["preferences", "views"],
            yes,
          );
          listeners.push(bootstrap);
          return bootstrap.invitation;
        }
        if (command === "pair") {
          await pairDevice(vault, value, yes);
          return vault.snapshot();
        }
        if (command === "prepared") return vault.preparedReceipt();
        if (command === "activate") {
          await vault.activate(value);
          return true;
        }
        if (command === "serve") {
          const server = await openDeviceSessionServer(
            vault,
            async (incoming) => {
              session = incoming;
              sessionResolve(incoming);
              await new Promise((resolve) => {
                incoming.__testRelease = resolve;
              });
            },
          );
          listeners.push(server);
          return server.port;
        }
        if (command === "connect") {
          session = await connectDeviceSession(vault, value);
          sessionResolve(session);
          return true;
        }
        if (command === "security") return (await sessionReady).security();
        if (command === "enqueue")
          return vault.enqueue(value.scope, value.recordId, value.value);
        if (command === "send") {
          await (await sessionReady).send(value);
          return true;
        }
        if (command === "receive") return (await sessionReady).receive();
        if (command === "revoke") {
          await vault.revoke();
          return true;
        }
        if (command === "probe-ticket") {
          const tls = require("node:tls"),
            openssl = path.join(
              process.env.ProgramFiles || "C:/Program Files",
              "Git/mingw64/bin/openssl.exe",
            );
          const tickets = [];
          const socket = tls.connect({
            host: "127.0.0.1",
            port: value.port,
            servername: deviceDns(value.peer.deviceId),
            secureContext: vault.createTlsContext(value.peer),
            rejectUnauthorized: true,
            ALPNProtocols: ["havvn-device-v1"],
          });
          socket.on("session", (ticket) => tickets.push(ticket));
          const wire = await new Promise((resolve, reject) => {
            socket.on("error", reject);
            socket.once("secureConnect", () => resolve(new DeviceWire(socket)));
          });
          await wire.write(vault.preparedReceipt());
          await wire.read();
          await new Promise((resolve) => setTimeout(resolve, 80));
          wire.close();
          if (!tickets.length)
            return {
              tickets: 0,
              maxEarlyData: null,
              reused: false,
              parser: null,
              policy:
                "Native backend suppressed ticket issuance; real old-ticket replay tested separately under Node",
            };
          const ticketFile = path.join(scratch, "ticket.der");
          if (!fs.existsSync(openssl))
            throw Error("Native ticket diagnostic requires OpenSSL");
          const prefix = Buffer.from("\0nodejs:tls:session:1\0"),
            ticket = tickets[0];
          const der = ticket.subarray(0, prefix.length).equals(prefix)
            ? ticket.subarray(
                prefix.length + 2 + ticket.readUInt16BE(prefix.length),
              )
            : ticket;
          fs.writeFileSync(ticketFile, der);
          const decoded = spawnSync(
            openssl,
            ["sess_id", "-inform", "DER", "-in", ticketFile, "-text", "-noout"],
            { encoding: "utf8", windowsHide: true },
          );
          fs.unlinkSync(ticketFile);
          if (
            decoded.status !== 0 ||
            !/Max Early Data:\s+0\b/.test(decoded.stdout)
          )
            throw Error("Early-data policy unavailable");
          // Never print the decoded session, which contains credential material.
          const again = tls.connect({
            host: "127.0.0.1",
            port: value.port,
            servername: deviceDns(value.peer.deviceId),
            secureContext: vault.createTlsContext(value.peer),
            rejectUnauthorized: true,
            ALPNProtocols: ["havvn-device-v1"],
            session: tickets[0],
          });
          const reused = await new Promise((resolve, reject) => {
            again.on("error", reject);
            again.once("secureConnect", () => resolve(again.isSessionReused()));
          });
          again.destroy();
          return {
            tickets: tickets.length,
            maxEarlyData: 0,
            reused,
            parser: "Git OpenSSL sess_id; secret output discarded",
          };
        }
        if (command === "protected") {
          const text = fs.readFileSync(
            path.join(directory, "device-state.json"),
            "utf8",
          );
          return (
            !/PRIVATE KEY|dp02-private-value|tokenHash/.test(text) &&
            value.tokens.every((token) => !text.includes(token)) &&
            !fs.existsSync(path.join(app.getPath("userData"), "rooms.json"))
          );
        }
        if (command === "shutdown") {
          clearInterval(commandTimer);
          session?.__testRelease?.();
          session?.close();
          for (const listener of listeners) await listener.close();
          await vault.close();
          clearTimeout(deadline);
          return true;
        }
        throw Error("Unknown command");
      };
      const control = path.resolve(process.env.HAVVN_DP02_CONTROL || ""),
        controlKey = Buffer.from(
          process.env.HAVVN_DP02_CONTROL_KEY || "",
          "hex",
        );
      if (
        path.dirname(control) !== path.join(scratch, "control") ||
        controlKey.length !== 32
      )
        throw Error("Missing isolated control");
      // Electron's Windows browser process does not reliably consume piped stdin.
      // Temporary test commands are authenticated/encrypted with a per-process key.
      commandTimer = setInterval(() => {
        for (const file of fs
          .readdirSync(control)
          .filter((file) => /^\d+\.cmd$/.test(file))) {
          const target = path.join(control, file),
            frame = unprotectCommand(fs.readFileSync(target), controlKey);
          fs.unlinkSync(target);
          void run(frame.command, frame.value).then(
            (value) => {
              if (frame.command === "shutdown")
                process.stdout.write(
                  "DP02:" +
                    JSON.stringify({ id: frame.id, ok: true, value }) +
                    "\n",
                  () => app.exit(0),
                );
              else emit({ id: frame.id, ok: true, value });
            },
            (error) =>
              emit({
                id: frame.id,
                ok: false,
                code: typeof error.code === "string" ? error.code : "native",
              }),
          );
        }
      }, 10);
      emit({ ready: true, value: vault.publicIdentity() });
    })
    .catch(() => app.exit(1));
}
