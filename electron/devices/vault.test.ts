import { expect, it } from "vitest";
import { inspect } from "node:util";
import { DeviceVault } from "./vault";
import {
  activateDevices,
  memoryDeviceStorage,
  prepareDevices,
} from "../../research/device-pairing/vault-fixture";
import type { DeviceAck } from "../../shared/device-pairing";
it('persists separate data consent, rejects another grant and clears consent on revocation', async () => {
  const f = await fixture(); await activateDevices(f.a, f.b);
  expect(f.a.dataApproved()).toBe(false);
  await expect(f.a.approveDataExchange('0'.repeat(64))).rejects.toThrow('stale');
  const grant = f.a.snapshot().grantId!;
  await f.a.approveDataExchange(grant); await f.a.close();
  const reopened = await DeviceVault.open(f.sa.io());
  expect(reopened.dataApproved()).toBe(true);
  await reopened.revoke(); expect(() => reopened.dataApproved()).toThrow('state');
  await f.b.revoke();
  await activateDevices(reopened, f.b);
  expect(reopened.dataApproved()).toBe(false);
  await reopened.close(); await f.b.close();
});
async function fixture() {
  const sa = memoryDeviceStorage(),
    sb = memoryDeviceStorage("b".repeat(64)),
    a = await DeviceVault.initialize(sa.io()),
    b = await DeviceVault.initialize(sb.io());
  return { sa, sb, a, b };
}
it("creates an independent identity without writing plaintext keys or exposing them in snapshots", async () => {
  const { sa, a, b } = await fixture();
  expect(a.publicIdentity().deviceId).not.toBe(b.publicIdentity().deviceId);
  expect(sa.raw()).not.toContain("PRIVATE KEY");
  expect(JSON.stringify(a.snapshot())).not.toMatch(
    /privateKey|certificate|token|channelBinding/,
  );
  expect(JSON.stringify({ vault: a })).not.toMatch(
    /PRIVATE KEY|privateKey|tokenHash/,
  );
  expect(inspect(a, { depth: 8 })).not.toMatch(
    /PRIVATE KEY|privateKey|tokenHash/,
  );
  expect(a.createTlsContext()).toBeTruthy();
});
it("requires both native-verifiable confirmations and a peer prepared receipt", async () => {
  const { a, b } = await fixture(),
    p = await prepareDevices(a, b);
  expect(b.snapshot().status).toBe("pending");
  expect(() => b.preparedReceipt()).toThrow("not-confirmed");
  await a.bindInvitation(
    p.invite.inviteId,
    p.invite.token,
    b.publicIdentity(),
    p.proofB,
  );
  expect(a.snapshot().status).toBe("pending");
  await expect(a.enqueue("preferences", "language", "ru")).rejects.toThrow(
    "state",
  );
  const proofA = await a.approveLocal();
  expect(a.snapshot().status).toBe("prepared");
  await b.recordPeerProof(proofA);
  await a.activate(b.preparedReceipt());
  await b.activate(a.preparedReceipt());
  expect(a.snapshot().status).toBe("active");
  expect(b.snapshot().status).toBe("active");
});
it("binds a token to one peer/transcript, verifies signatures and permits exact retries", async () => {
  const { a, b, sa } = await fixture(),
    p = await prepareDevices(a, b);
  await expect(
    a.bindInvitation(
      p.invite.inviteId,
      "0".repeat(64),
      b.publicIdentity(),
      p.proofB,
    ),
  ).rejects.toThrow("peer");
  await expect(
    a.bindInvitation(p.invite.inviteId, p.invite.token, b.publicIdentity(), {
      ...p.proofB,
      body: { ...p.proofB.body, challengeA: "0".repeat(64) },
    }),
  ).rejects.toThrow("peer");
  await a.bindInvitation(
    p.invite.inviteId,
    p.invite.token,
    b.publicIdentity(),
    p.proofB,
  );
  const revision = a.snapshot().revision;
  await a.bindInvitation(
    p.invite.inviteId,
    p.invite.token,
    b.publicIdentity(),
    p.proofB,
  );
  expect(a.snapshot().revision).toBe(revision);
  expect(JSON.stringify(sa.plain())).not.toContain(p.invite.token);
  expect(JSON.stringify(a.snapshot())).not.toContain(p.invite.token);
});
it("prepared receipts are peer-, transcript- and grant-bound and activation retries are harmless", async () => {
  const { a, b } = await fixture(),
    p = await activateDevices(a, b);
  const revision = a.snapshot().revision;
  await a.activate(p.readyB);
  expect(a.snapshot().revision).toBe(revision);
  await expect(a.activate(p.readyA)).rejects.toThrow("peer");
  await expect(
    a.activate({
      ...p.readyB,
      body: { ...p.readyB.body, grantId: "0".repeat(64) },
    }),
  ).rejects.toThrow("peer");
});
it("cancelling or expiring an invitation cannot activate it later", async () => {
  const sa = memoryDeviceStorage(),
    sb = memoryDeviceStorage("b".repeat(64));
  let now = Date.now();
  const a = await DeviceVault.initialize(sa.io(), () => now),
    b = await DeviceVault.initialize(sb.io(), () => now),
    p = await prepareDevices(a, b);
  now += 600001;
  await expect(
    a.bindInvitation(
      p.invite.inviteId,
      p.invite.token,
      b.publicIdentity(),
      p.proofB,
    ),
  ).rejects.toThrow("expired");
  await a.cancelInvitation();
  await expect(
    a.bindInvitation(
      p.invite.inviteId,
      p.invite.token,
      b.publicIdentity(),
      p.proofB,
    ),
  ).rejects.toThrow("state");
  expect(a.snapshot().revokedGrants).toBe(1);
});
it("serializes concurrent queue writes and atomically persists sequence numbers with the outbox", async () => {
  const { a, b, sa } = await fixture();
  await activateDevices(a, b);
  const operations = await Promise.all([
    a.enqueue("preferences", "language", "ru"),
    a.enqueue("preferences", "density", "compact"),
  ]);
  expect(operations.map((op) => op.sequence)).toEqual([1, 2]);
  await a.close();
  const restored = DeviceVault.open(sa.io());
  expect(restored.snapshot().counters.preferences).toBe(2);
  expect(restored.outbound()).toHaveLength(2);
  expect((await restored.enqueue("preferences", "scale", 100)).sequence).toBe(
    3,
  );
});
it("accepts only matching monotonic acknowledgments and persists queue retirement", async () => {
  const { a, b, sa } = await fixture();
  await activateDevices(a, b);
  const op = await a.enqueue("preferences", "language", "ru");
  const ack: DeviceAck = {
    version: 1,
    kind: "ack",
    pairId: op.pairId,
    grantId: op.grantId,
    from: op.to,
    to: op.from,
    scope: "preferences",
    through: 1,
  };
  await expect(a.acknowledge({ ...ack, through: 2 })).rejects.toThrow("peer");
  await expect(
    a.acknowledge({ ...ack, grantId: "0".repeat(64) }),
  ).rejects.toThrow("peer");
  await a.acknowledge(ack);
  const revision = a.snapshot().revision;
  await a.acknowledge(ack);
  expect(a.snapshot().revision).toBe(revision);
  await a.close();
  expect(DeviceVault.open(sa.io()).outbound()).toHaveLength(0);
});
it("narrowing scopes purges that queue and blocks an earlier selected packet", async () => {
  const { a, b } = await fixture();
  await activateDevices(a, b);
  const op = await a.enqueue("playback", "media", 10);
  await a.narrowScopes(["preferences"]);
  expect(a.outbound()).toHaveLength(0);
  expect(() => a.guardOutbound(op)).toThrow("peer");
  await expect(a.narrowScopes(["preferences", "playback"])).rejects.toThrow(
    "peer",
  );
});
it("revocation blocks already selected packets immediately, then survives reopen", async () => {
  const { a, b, sa } = await fixture();
  await activateDevices(a, b);
  const op = await a.enqueue("preferences", "language", "ru"),
    revoke = a.revoke();
  expect(() => a.guardOutbound(op)).toThrow("state");
  await revoke;
  expect(a.snapshot().status).toBe("revoked");
  await a.close();
  const restored = DeviceVault.open(sa.io());
  expect(restored.snapshot().status).toBe("revoked");
  expect(restored.snapshot().outbox).toBe(0);
  expect(() => restored.guardOutbound(op)).toThrow("state");
});
it("failed revocation freezes output, keeps the durable old file and can be retried", async () => {
  const { a, b, sa } = await fixture();
  await activateDevices(a, b);
  const op = await a.enqueue("preferences", "language", "ru"),
    before = sa.raw();
  sa.faults.beforeWrite = true;
  await expect(a.revoke()).rejects.toThrow("storage");
  expect(sa.raw()).toBe(before);
  expect(a.snapshot().status).toBe("paused-error");
  expect(() => a.guardOutbound(op)).toThrow("state");
  sa.faults.beforeWrite = false;
  await a.revoke();
  expect(a.snapshot().status).toBe("revoked");
});
it("after-write ambiguity freezes the instance and reopen recovers the committed operation", async () => {
  const { a, b, sa } = await fixture();
  await activateDevices(a, b);
  sa.faults.afterWrite = true;
  await expect(a.enqueue("preferences", "language", "ru")).rejects.toThrow(
    "storage",
  );
  expect(a.snapshot().status).toBe("paused-error");
  expect(() => a.outbound()).toThrow("state");
  sa.faults.afterWrite = false;
  await a.close();
  const restored = DeviceVault.open(sa.io());
  expect(restored.outbound()).toHaveLength(1);
  expect(
    (await restored.enqueue("preferences", "density", "compact")).sequence,
  ).toBe(2);
});
it("a before-write failure cannot leave an incremented counter without its operation", async () => {
  const { a, b, sa } = await fixture();
  await activateDevices(a, b);
  const before = sa.raw();
  sa.faults.beforeWrite = true;
  await expect(a.enqueue("preferences", "language", "ru")).rejects.toThrow();
  expect(sa.raw()).toBe(before);
  sa.faults.beforeWrite = false;
  await a.close();
  const restored = DeviceVault.open(sa.io());
  expect(restored.snapshot().counters.preferences).toBe(0);
  expect(
    (await restored.enqueue("preferences", "language", "en")).sequence,
  ).toBe(1);
});
it("re-pairing retains revocation tombstones and rejects old ready receipts and queue entries", async () => {
  const { a, b, sa } = await fixture(),
    old = await activateDevices(a, b),
    op = await a.enqueue("preferences", "language", "ru");
  await a.revoke();
  await b.revoke();
  const newer = await activateDevices(a, b);
  expect(newer.invite.grantId).not.toBe(old.invite.grantId);
  await expect(a.activate(old.readyB)).rejects.toThrow("peer");
  expect(() => a.guardOutbound(op)).toThrow("stale");
  expect(
    sa
      .plain()
      .revoked.some(
        (r: { grantId: string }) => r.grantId === old.invite.grantId,
      ),
  ).toBe(true);
});
it("unavailable OS protection and corrupt/unknown stored data never reset an identity", async () => {
  const store = memoryDeviceStorage();
  store.faults.protect = true;
  await expect(DeviceVault.initialize(store.io())).rejects.toThrow("locked");
  expect(store.raw()).toBeNull();
  store.faults.protect = false;
  const vault = await DeviceVault.initialize(store.io());
  const original = store.raw(),
    id = vault.publicIdentity().deviceId;
  await vault.close();
  store.faults.unprotect = true;
  expect(() => DeviceVault.open(store.io())).toThrow("locked");
  expect(store.raw()).toBe(original);
  store.faults.unprotect = false;
  store.mutate((v) => {
    v.version = 2;
  });
  expect(() => DeviceVault.open(store.io())).toThrow("version");
  await expect(DeviceVault.initialize(store.io())).rejects.toThrow("exists");
  store.setRaw(original);
  expect(DeviceVault.open(store.io()).publicIdentity().deviceId).toBe(id);
});
it("detects a copied profile binding and mismatched private key before any rewrite", async () => {
  const { a, b, sa, sb } = await fixture(),
    before = sa.raw();
  await a.close();
  expect(() =>
    DeviceVault.open({ ...sa.io(), binding: "f".repeat(64) }),
  ).toThrow("clone");
  expect(sa.raw()).toBe(before);
  const other = sb.plain().identity.privateKey;
  sa.mutate((v) => {
    (v.identity as { privateKey: string }).privateKey = other;
  });
  const corrupt = sa.raw();
  expect(() => DeviceVault.open(sa.io())).toThrow("identity");
  expect(sa.raw()).toBe(corrupt);
  await b.close();
});
it("rejects an active state lacking both proofs and storage cannot silently widen permissions", async () => {
  const { a, b, sa } = await fixture();
  await activateDevices(a, b, ["preferences"]);
  await a.close();
  sa.mutate((v) => {
    (v.pair as { peerProof: null }).peerProof = null;
  });
  expect(() => DeviceVault.open(sa.io())).toThrow("not-confirmed");
});
it("missing private keys and unknown stored fields are not replaced with a new identity", async () => {
  const { a, sa } = await fixture();
  await a.close();
  const original = sa.raw();
  sa.mutate((v) => {
    delete (v.identity as Record<string, unknown>).privateKey;
  });
  expect(() => DeviceVault.open(sa.io())).toThrow("identity");
  sa.setRaw(original);
  sa.mutate((v) => {
    v.extra = "unknown";
  });
  expect(() => DeviceVault.open(sa.io())).toThrow("invalid");
});
it("a read failure during revocation pauses the instance and redacts the adapter error", async () => {
  const { a, sa } = await fixture();
  sa.faults.read = true;
  await expect(a.revoke()).rejects.toThrow("storage");
  expect(a.snapshot().status).toBe("paused-error");
  sa.faults.read = false;
  await a.revoke();
  expect(a.snapshot().status).toBe("unpaired");
});
it("strictly validates invitation destinations before committing any capability", async () => {
  const { a, sa } = await fixture(),
    before = sa.raw();
  for (const host of [
    "file://private",
    "[[]",
    "999.2.3.4",
    "127.1",
    "-invalid",
    "a..b",
  ])
    await expect(
      a.issueInvitation({ host, port: 1234 }, ["preferences"]),
    ).rejects.toThrow("invalid");
  expect(sa.raw()).toBe(before);
});
