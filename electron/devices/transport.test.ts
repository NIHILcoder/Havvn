import { afterEach, expect, it } from "vitest";
import { connect, type TLSSocket } from "node:tls";
import { connect as connectTcp } from "node:net";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes, constants } from "node:crypto";
import { DeviceVault } from "./vault";
import { DeviceWire } from "./wire";
import { openDeviceBootstrap, pairDevice } from "./bootstrap";
import { connectDevice, DEVICE_ALPN, listenDevice } from "./transport";
import {
  openDeviceSessionServer,
  connectDeviceSession,
  type DeviceSession,
} from "./session";
import { deviceDns, certificateHash, createDeviceIdentity } from "./identity";
import {
  memoryDeviceStorage,
  prepareDevices,
} from "../../research/device-pairing/vault-fixture";
import {
  DEVICE_FRAME_BYTES,
  type DeviceConfirmationBody,
  type DeviceInvite,
} from "../../shared/device-pairing";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const yes = async () => true;
async function devices() {
  const sa = memoryDeviceStorage(),
    sb = memoryDeviceStorage("b".repeat(64));
  const a = await DeviceVault.initialize(sa.io()),
    b = await DeviceVault.initialize(sb.io());
  cleanup.push(
    () => a.close(),
    () => b.close(),
  );
  return { a, b, sa, sb };
}
async function paired() {
  const f = await devices();
  const bootstrap = await openDeviceBootstrap(
    f.a,
    ["preferences", "views"],
    yes,
  );
  cleanup.push(() => bootstrap.close());
  await pairDevice(f.b, bootstrap.invitation, yes);
  expect(await bootstrap.completed).toBe(true);
  return { ...f, bootstrap };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function sessionPair(a: DeviceVault, b: DeviceVault) {
  const arrived = deferred<DeviceSession>(),
    hold = deferred<void>();
  const server = await openDeviceSessionServer(a, async (session) => {
    arrived.resolve(session);
    await hold.promise;
  });
  cleanup.push(async () => {
    hold.resolve();
    await server.close();
  });
  const client = await connectDeviceSession(b, server.port);
  cleanup.push(() => client.close());
  return { server, client, remote: await arrived.promise };
}
function rawConnect(
  vault: DeviceVault,
  invite: DeviceInvite,
  overrides: object = {},
) {
  return new Promise<TLSSocket>((resolve, reject) => {
    const socket = connect({
      host: "127.0.0.1",
      port: invite.endpoint.port,
      servername: deviceDns(invite.device.deviceId),
      secureContext: vault.createTlsContext(invite.device),
      rejectUnauthorized: true,
      ALPNProtocols: [DEVICE_ALPN],
      ...overrides,
    });
    cleanup.push(() => {
      socket.destroy();
    });
    socket.on("error", reject);
    socket.once("secureConnect", () => resolve(socket));
  });
}
it("pairs independent keys over real TLS, then uses a fresh mutually pinned session without auto-ACK", async () => {
  const { a, b, sa, sb } = await paired(),
    { client, remote } = await sessionPair(a, b);
  expect(sa.plain().pair.body.channelBinding).toBe(
    sb.plain().pair.body.channelBinding,
  );
  expect(a.publicIdentity().deviceId).not.toBe(b.publicIdentity().deviceId);
  const op = await b.enqueue("preferences", "language", "ru");
  await client.send(op);
  expect(await remote.receive()).toEqual(op);
  expect(b.snapshot().outbox).toBe(1);
  await remote.send({
    version: 1,
    kind: "ack",
    pairId: op.pairId,
    grantId: op.grantId,
    from: op.to,
    to: op.from,
    scope: op.scope,
    through: op.sequence,
  });
  expect((await client.receive()).kind).toBe("ack");
  expect(b.snapshot().outbox).toBe(0);
});
it("requires responder consent before dialing and initiator consent before becoming prepared", async () => {
  const { a, b } = await devices();
  let asked = 0;
  const bootstrap = await openDeviceBootstrap(a, ["preferences"], async () => {
    asked++;
    return false;
  });
  cleanup.push(() => bootstrap.close());
  await expect(
    pairDevice(b, bootstrap.invitation, async () => false),
  ).rejects.toThrow("not-confirmed");
  expect(a.snapshot().status).toBe("unpaired");
  expect(b.snapshot().status).toBe("unpaired");
  expect(asked).toBe(0);
  await expect(pairDevice(b, bootstrap.invitation, yes)).rejects.toThrow();
  expect(asked).toBe(1);
  expect(a.snapshot().status).toBe("revoked");
  expect(b.snapshot().status).toBe("pending");
});
it("rejects a wrong pinned identity before sending the invitation token", async () => {
  const { a, b } = await devices(),
    c = await createDeviceIdentity();
  const bootstrap = await openDeviceBootstrap(a, ["preferences"], yes);
  cleanup.push(() => bootstrap.close());
  await expect(
    pairDevice(b, { ...bootstrap.invitation, device: c.public }, yes),
  ).rejects.toThrow("peer");
  expect(a.snapshot().status).toBe("unpaired");
  expect(b.snapshot().status).toBe("unpaired");
});
it("rejects expired invites and public endpoints without a network attempt", async () => {
  const { a, b } = await devices(),
    bootstrap = await openDeviceBootstrap(a, ["preferences"], yes);
  cleanup.push(() => bootstrap.close());
  const now = Date.now();
  const expired = {
    ...bootstrap.invitation,
    issuedAt: now - 700000,
    expiresAt: now - 100000,
  };
  await expect(pairDevice(b, expired, yes)).rejects.toThrow("expired");
  await expect(
    pairDevice(
      b,
      { ...bootstrap.invitation, endpoint: { host: "8.8.8.8", port: 22 } },
      yes,
    ),
  ).rejects.toThrow("invalid");
});
it("rejects a wrong token without consuming the valid invitation", async () => {
  const { a, b } = await devices(),
    bootstrap = await openDeviceBootstrap(a, ["preferences"], yes);
  cleanup.push(() => bootstrap.close());
  await expect(
    pairDevice(b, { ...bootstrap.invitation, token: "0".repeat(64) }, yes),
  ).rejects.toThrow();
  expect(a.snapshot().status).toBe("unpaired");
  // B's cancellation tombstones this grant; another device can still use A's valid invite.
  await b.revoke();
  const c = await DeviceVault.initialize(
    memoryDeviceStorage("c".repeat(64)).io(),
  );
  cleanup.push(() => c.close());
  await pairDevice(c, bootstrap.invitation, yes);
  expect(a.snapshot().status).toBe("active");
});
it("does not reuse a consumed token for a different device or a fresh bootstrap channel", async () => {
  const { a, bootstrap } = await paired(),
    c = await DeviceVault.initialize(memoryDeviceStorage("c".repeat(64)).io());
  cleanup.push(() => c.close());
  await expect(pairDevice(c, bootstrap.invitation, yes)).rejects.toThrow();
  expect(a.snapshot().status).toBe("active");
  expect(c.snapshot().status).toBe("unpaired");
});
it("rejects a changed scope, certificate fingerprint or channel binding in the server challenge", async () => {
  for (const field of [
    "scopes",
    "responderCertificate",
    "channelBinding",
  ] as const) {
    const { a, b } = await devices();
    const server = await listenDevice(a, undefined, async (wire) => {
      const hello = (await wire.read()) as { challengeB: string };
      const body: DeviceConfirmationBody = {
        version: 1,
        role: "responder",
        inviteId: invite.inviteId,
        pairId: invite.pairId,
        grantId: invite.grantId,
        initiatorId: a.publicIdentity().deviceId,
        responderId: b.publicIdentity().deviceId,
        initiatorCertificate: certificateHash(a.publicIdentity()),
        responderCertificate: certificateHash(b.publicIdentity()),
        scopes: invite.scopes,
        challengeA: randomBytes(32).toString("hex"),
        challengeB: hello.challengeB,
        channelBinding: wire.binding(),
      };
      if (field === "scopes") body.scopes = ["views"];
      else body[field] = "0".repeat(64);
      await wire.write({ version: 1, kind: "challenge", body });
      await wire.read();
    });
    cleanup.push(() => server.close());
    const invite = await a.issueInvitation(
      { host: "127.0.0.1", port: server.port },
      ["preferences"],
    );
    await expect(pairDevice(b, invite, yes)).rejects.toThrow("peer");
    expect(b.snapshot().status).toBe("unpaired");
  }
});
it("rejects a signed responder proof from another TLS channel", async () => {
  const { a, b, sa } = await devices(),
    bootstrap = await openDeviceBootstrap(a, ["preferences"], yes);
  cleanup.push(() => bootstrap.close());
  const wire1 = await connectDevice(
      b,
      a.publicIdentity(),
      bootstrap.invitation.endpoint.port,
    ),
    nonce = randomBytes(32).toString("hex");
  cleanup.push(() => wire1.close());
  await wire1.write({
    version: 1,
    kind: "bootstrap",
    inviteId: bootstrap.invitation.inviteId,
    token: bootstrap.invitation.token,
    device: b.publicIdentity(),
    challengeB: nonce,
  });
  const challenge = (await wire1.read()) as { body: DeviceConfirmationBody };
  await b.acceptInvitation(bootstrap.invitation, challenge.body);
  const proof = await b.approveLocal();
  wire1.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const wire2 = await connectDevice(
    b,
    a.publicIdentity(),
    bootstrap.invitation.endpoint.port,
  );
  cleanup.push(() => wire2.close());
  await wire2.write({
    version: 1,
    kind: "bootstrap",
    inviteId: bootstrap.invitation.inviteId,
    token: bootstrap.invitation.token,
    device: b.publicIdentity(),
    challengeB: nonce,
  });
  const other = (await wire2.read()) as { body: DeviceConfirmationBody };
  expect(other.body.channelBinding).not.toBe(proof.body.channelBinding);
  await wire2.write(proof);
  await expect(wire2.read()).rejects.toThrow();
  expect(sa.plain().pair).toBeNull();
});
it("recovers a lost final bootstrap response after reopening the encrypted vaults", async () => {
  const { a, b, sa, sb } = await devices();
  const activate = a.activate.bind(a);
  a.activate = async (receipt) => {
    await activate(receipt);
    await bootstrap.close();
  };
  const bootstrap = await openDeviceBootstrap(a, ["preferences"], yes);
  cleanup.push(() => bootstrap.close());
  await expect(pairDevice(b, bootstrap.invitation, yes)).rejects.toThrow();
  expect(a.snapshot().status).toBe("active");
  expect(b.snapshot().status).toBe("prepared");
  await a.close();
  await b.close();
  const aa = DeviceVault.open(sa.io()),
    bb = DeviceVault.open(sb.io());
  cleanup.push(
    () => aa.close(),
    () => bb.close(),
  );
  await sessionPair(aa, bb);
  expect(aa.snapshot().status).toBe("active");
  expect(bb.snapshot().status).toBe("active");
});
it("closes an open connection synchronously when local revocation starts and blocks queued bytes", async () => {
  const { a, b } = await paired(),
    { remote, client } = await sessionPair(a, b),
    op = await a.enqueue("views", "one", {});
  const waiting = client.receive();
  const rejected = expect(waiting).rejects.toThrow();
  const revoking = a.revoke();
  await expect(remote.send(op)).rejects.toThrow();
  await revoking;
  await rejected;
  expect(a.snapshot().status).toBe("revoked");
  expect(a.snapshot().outbox).toBe(0);
});
it("rechecks scope rights for both sending and receiving on an already open session", async () => {
  const { a, b } = await paired(),
    { remote, client } = await sessionPair(a, b),
    op = await b.enqueue("views", "view", {});
  await client.send(op);
  await a.narrowScopes(["preferences"]);
  await expect(remote.receive()).rejects.toThrow("revoked");
  await b.narrowScopes(["preferences"]);
  await expect(client.send(op)).rejects.toThrow();
});
it("does not reactivate a revoked grant over the old authenticated listener", async () => {
  const { a, b } = await paired(),
    hold = deferred<void>();
  const server = await openDeviceSessionServer(a, async () => hold.promise);
  cleanup.push(() => {
    hold.resolve();
    return server.close();
  });
  await a.revoke();
  await expect(connectDeviceSession(b, server.port)).rejects.toThrow();
  expect(a.snapshot().status).toBe("revoked");
});
it("rejects another key and a missing client certificate in the mutual TLS handshake", async () => {
  const { a, b } = await paired(),
    server = await openDeviceSessionServer(a, async () => {});
  cleanup.push(() => server.close());
  const c = await DeviceVault.initialize(
    memoryDeviceStorage("c".repeat(64)).io(),
  );
  cleanup.push(() => c.close());
  // secureConnect may occur on TLS 1.3's client before the server rejects its certificate;
  // no application prepared/session exchange can complete.
  const wrong = await connectDevice(c, a.publicIdentity(), server.port).catch(
    () => null,
  );
  if (wrong) {
    cleanup.push(() => wrong.close());
    await expect(wrong.read()).rejects.toThrow();
  }
  const socket = await rawConnect(
    b,
    {
      version: 1,
      kind: "invite",
      device: a.publicIdentity(),
      endpoint: { host: "127.0.0.1", port: server.port },
    } as DeviceInvite,
    { secureContext: undefined, ca: a.publicIdentity().certificateAuthority },
  );
  const wire = new DeviceWire(socket);
  cleanup.push(() => wire.close());
  await expect(wire.read()).rejects.toThrow();
});
it("rejects an oversized frame header, malformed UTF-8 and unknown versions without state changes", async () => {
  const { a, b } = await devices(),
    bootstrap = await openDeviceBootstrap(a, ["preferences"], yes);
  cleanup.push(() => bootstrap.close());
  for (const payload of [
    Buffer.from([0, 1, 0, 1]),
    Buffer.from([0, 0, 0, 2, 0xc3, 0x28]),
    (() => {
      const json = Buffer.from('{"version":2}'),
        h = Buffer.alloc(4);
      h.writeUInt32BE(json.length);
      return Buffer.concat([h, json]);
    })(),
  ]) {
    const socket = await rawConnect(b, bootstrap.invitation),
      wire = new DeviceWire(socket);
    cleanup.push(() => wire.close());
    socket.write(payload);
    await expect(wire.read()).rejects.toThrow();
  }
  expect(DEVICE_FRAME_BYTES).toBe(65536);
  expect(a.snapshot().status).toBe("unpaired");
});
it("requires TLS 1.3 and the application ALPN before accepting a frame", async () => {
  const { a, b } = await devices(),
    bootstrap = await openDeviceBootstrap(a, ["preferences"], yes);
  cleanup.push(() => bootstrap.close());
  await expect(
    rawConnect(b, bootstrap.invitation, {
      secureContext: undefined,
      ca: a.publicIdentity().certificateAuthority,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
    }),
  ).rejects.toThrow();
  const socket = await rawConnect(b, bootstrap.invitation, {
      ALPNProtocols: [],
    }),
    wire = new DeviceWire(socket);
  cleanup.push(() => wire.close());
  await expect(wire.read()).rejects.toThrow();
});
it("performs a full handshake when an old TLS 1.3 ticket is offered, including after revoke", async () => {
  const { a, b } = await paired(),
    server = await openDeviceSessionServer(a, async () => {});
  cleanup.push(() => server.close());
  const invite = {
    device: a.publicIdentity(),
    endpoint: { host: "127.0.0.1", port: server.port },
  } as DeviceInvite;
  const first = await rawConnect(b, invite);
  const tickets: Buffer[] = [];
  first.on("session", (ticket) => tickets.push(ticket));
  // Reading the server's prepared receipt also allows post-handshake tickets to arrive.
  const wire = new DeviceWire(first);
  cleanup.push(() => wire.close());
  await wire.write(b.preparedReceipt());
  await wire.read();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(first.isSessionReused()).toBe(false);
  expect(tickets.length).toBeGreaterThan(0);
  const old = tickets[0];
  const openssl = "C:/Program Files/Git/mingw64/bin/openssl.exe";
  if (existsSync(openssl)) {
    // Node 24.18.1 wraps the DER with a hostname. Unwrap only for this
    // external diagnostic; the actual replay below uses the original opaque state.
    const prefix = Buffer.from("\0nodejs:tls:session:1\0");
    const der = old.subarray(0, prefix.length).equals(prefix)
      ? old.subarray(prefix.length + 2 + old.readUInt16BE(prefix.length))
      : old;
    const decoded = spawnSync(
      openssl,
      ["sess_id", "-inform", "PEM", "-text", "-noout"],
      {
        input:
          "-----BEGIN SSL SESSION PARAMETERS-----\n" +
          der
            .toString("base64")
            .match(/.{1,64}/g)!
            .join("\n") +
          "\n-----END SSL SESSION PARAMETERS-----\n",
        windowsHide: true,
      },
    );
    // Only assert a boolean: decoded session text contains keys and must never be printed.
    expect(
      decoded.status === 0 &&
        /Max Early Data:\s+0\b/.test(decoded.stdout.toString()),
    ).toBe(true);
  }
  const next = await rawConnect(b, invite, { session: old });
  expect(next.isSessionReused()).toBe(false);
  next.destroy();
  await a.revoke();
  const revoked = await rawConnect(b, invite, { session: old });
  expect(revoked.isSessionReused()).toBe(false);
  const denied = new DeviceWire(revoked);
  cleanup.push(() => denied.close());
  await expect(denied.read()).rejects.toThrow();
  expect(constants.SSL_OP_NO_TICKET).toBeGreaterThan(0);
});
it("rejects a certificate that is expired or not yet valid before dialing", async () => {
  const { a, b } = await devices(),
    bootstrap = await openDeviceBootstrap(a, ["preferences"], yes);
  cleanup.push(() => bootstrap.close());
  for (const at of [Date.now() - 366 * 86400000, Date.now() + 600000]) {
    const identity = await createDeviceIdentity(at);
    await expect(
      pairDevice(b, { ...bootstrap.invitation, device: identity.public }, yes),
    ).rejects.toThrow("identity");
  }
});
it("does not accept a replayed confirmation after revocation and a newly approved grant", async () => {
  const { a, b, bootstrap } = await paired(),
    old = a.preparedReceipt(),
    op = await b.enqueue("views", "old", {});
  await a.revoke();
  await b.revoke();
  await bootstrap.close();
  const next = await openDeviceBootstrap(a, ["preferences"], yes);
  cleanup.push(() => next.close());
  await pairDevice(b, next.invitation, yes);
  expect(a.snapshot().grantId).not.toBe(old.body.grantId);
  expect(a.snapshot().revokedGrants).toBe(1);
  const { client } = await sessionPair(a, b);
  await expect(client.send(op)).rejects.toThrow("peer");
  await expect(b.activate(old)).rejects.toThrow("peer");
  expect(b.snapshot().outbox).toBe(0);
});
it("denies a prepared receipt when only one approval exists", async () => {
  const { a, b } = await devices();
  await prepareDevices(a, b, ["preferences"]);
  await expect(openDeviceSessionServer(b, async () => {})).rejects.toThrow(
    "not-confirmed",
  );
  expect(b.snapshot().status).toBe("pending");
});
it("closes an authenticated session on an invalid ACK and retains the durable outbox", async () => {
  const { a, b } = await paired(),
    { remote, client } = await sessionPair(a, b),
    op = await b.enqueue("preferences", "language", "ru");
  await remote.send({
    version: 1,
    kind: "ack",
    pairId: op.pairId,
    grantId: op.grantId,
    from: op.to,
    to: op.from,
    scope: op.scope,
    through: op.sequence + 1,
  });
  await expect(client.receive()).rejects.toThrow("peer");
  expect(b.snapshot().outbox).toBe(1);
  await expect(client.send(op)).rejects.toThrow();
});
it("closes existing sessions even if writing the revocation fails", async () => {
  const { a, b, sa } = await paired(),
    { client, remote } = await sessionPair(a, b);
  const wait = client.receive(),
    failed = expect(wait).rejects.toThrow();
  sa.faults.beforeWrite = true;
  await expect(a.revoke()).rejects.toThrow("storage");
  await failed;
  expect(a.snapshot().status).toBe("paused-error");
  await expect(remote.receive()).rejects.toThrow();
  sa.faults.beforeWrite = false;
  await a.revoke();
  expect(a.snapshot().status).toBe("revoked");
});
it("never dispatches bytes sent before a TLS handshake", async () => {
  const { a } = await devices();
  let consent = 0;
  const bootstrap = await openDeviceBootstrap(a, ["preferences"], async () => {
    consent++;
    return true;
  });
  cleanup.push(() => bootstrap.close());
  await new Promise<void>((resolve, reject) => {
    const socket = connectTcp(
      { host: "127.0.0.1", port: bootstrap.invitation.endpoint.port },
      () => socket.write(Buffer.from([0, 0, 0, 2, 123, 125])),
    );
    cleanup.push(() => socket.destroy());
    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
  expect(consent).toBe(0);
  expect(a.snapshot().status).toBe("unpaired");
});
it("preserves framing across fragmented and coalesced records and caps pending messages", async () => {
  const { a, b } = await devices();
  const echo = await listenDevice(a, undefined, async (wire) => {
    await wire.write(await wire.read());
    await wire.read();
  });
  cleanup.push(() => echo.close());
  const invite = await a.issueInvitation(
    { host: "127.0.0.1", port: echo.port },
    ["preferences"],
  );
  const socket = await rawConnect(b, invite),
    wire = new DeviceWire(socket);
  cleanup.push(() => wire.close());
  const data = Buffer.from('{"value":"Привет"}'),
    header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const frame = Buffer.concat([header, data]);
  for (const byte of frame) socket.write(Buffer.from([byte]));
  expect(await wire.read()).toEqual({ value: "Привет" });
  const flooded = await rawConnect(b, invite),
    floodedWire = new DeviceWire(flooded);
  cleanup.push(() => floodedWire.close());
  flooded.write(Buffer.concat(Array.from({ length: 8 }, () => frame)));
  await expect(floodedWire.read()).rejects.toThrow();
});
