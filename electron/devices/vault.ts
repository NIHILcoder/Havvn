import { constants, randomBytes, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";
import {
  emptyDeviceReplica,
  validateDeviceReplica,
  receiveDeviceReplica,
  publishDeviceReplica,
  replicaKey,
  replicaHeads,
  completeRecord,
  validateDeviceSnapshot,
  importDeviceSnapshot,
  finishDeviceResync,
  type DeviceDataSnapshot,
  type DeviceReplicaState,
  type ReplicaMeta,
} from "./replica-state";
import { validateDeviceDataOperation } from "../../shared/device-data";
import {
  validateDeviceScopedPlan,
  type DeviceTargetPlan,
} from "../../shared/device-data-target";
import {
  createSecureContext,
  createServer,
  type SecureContext,
  type SecureContextOptions,
} from "node:tls";
import {
  DEVICE_SCOPES,
  DeviceError,
  deviceCount,
  deviceHex,
  deviceObject,
  deviceScopes,
  deviceConfirmationCanonical,
  devicePreparedCanonical,
  validateDeviceInvite,
  validateDeviceConfirmation,
  validateDevicePrepared,
  validateDeviceOperation,
  validateDeviceAck,
  type DeviceAck,
  type DeviceConfirmation,
  type DeviceConfirmationBody,
  type DeviceInvite,
  type DeviceOperation,
  type DevicePrepared,
  type DevicePublic,
  type DeviceScope,
  type DeviceJson,
} from "../../shared/device-pairing";
import {
  certificateHash,
  checkDeviceIdentity,
  checkDevicePublic,
  createDeviceIdentity,
  deviceHash,
  signDevice,
  verifyDevice,
  type DeviceIdentity,
} from "./identity";

export interface DeviceVaultStorage {
  binding: string;
  read(): string | null;
  write(expected: string | null, next: string): void;
  protect(plain: string): string;
  unprotect(cipher: string): string;
  close?(): void;
}
interface StoredInvite {
  invite: Omit<DeviceInvite, "token">;
  tokenHash: string;
  status: "open" | "bound" | "consumed" | "cancelled";
}
interface StoredPair {
  status: "pending" | "prepared" | "active" | "revoked";
  peer: DevicePublic;
  body: DeviceConfirmationBody;
  localProof: DeviceConfirmation | null;
  peerProof: DeviceConfirmation | null;
  allowed: DeviceScope[];
}
interface VaultState {
  version: 1;
  revision: number;
  binding: string;
  identity: DeviceIdentity;
  invitation: StoredInvite | null;
  pair: StoredPair | null;
  revoked: { grantId: string; at: number }[];
  counters: Record<DeviceScope, number>;
  acknowledged: Record<DeviceScope, number>;
  outbox: DeviceOperation[];
  replica: DeviceReplicaState;
  exchangeApproved: boolean;
}
const replicaMeta = (state: VaultState): ReplicaMeta | null =>
  state.pair && state.pair.status === "active"
    ? {
        self: state.identity.public.deviceId,
        peer: state.pair.peer.deviceId,
        pairId: state.pair.body.pairId,
        grantId: state.pair.body.grantId,
        counters: state.counters,
      }
    : null;
const counters = (): Record<DeviceScope, number> => ({
  preferences: 0,
  views: 0,
  playback: 0,
});
const random = (bytes = 32) => randomBytes(bytes).toString("hex");
const sameScopes = (a: DeviceScope[], b: DeviceScope[]) =>
  JSON.stringify(deviceScopes(a)) === JSON.stringify(deviceScopes(b));
const normalizedBody = (body: DeviceConfirmationBody) => ({
  ...body,
  role: "initiator" as const,
});
const transcript = (body: DeviceConfirmationBody) =>
  deviceHash(deviceConfirmationCanonical(normalizedBody(body)));
const publicOf = (s: VaultState) => s.identity.public;
const localRole = (
  s: VaultState,
  p: StoredPair,
): DeviceConfirmationBody["role"] =>
  p.body.initiatorId === publicOf(s).deviceId ? "initiator" : "responder";
function matchesProof(
  proof: DeviceConfirmation,
  body: DeviceConfirmationBody,
  role: DeviceConfirmationBody["role"],
  peer: DevicePublic,
): boolean {
  return (
    proof.body.role === role &&
    transcript(proof.body) === transcript(body) &&
    verifyDevice(peer, deviceConfirmationCanonical(proof.body), proof.signature)
  );
}
function matchParticipants(
  body: DeviceConfirmationBody,
  self: DevicePublic,
  peer: DevicePublic,
): void {
  const initiator = body.initiatorId === self.deviceId ? self : peer,
    responder = body.responderId === self.deviceId ? self : peer;
  if (
    initiator.deviceId !== body.initiatorId ||
    responder.deviceId !== body.responderId ||
    initiator.deviceId === responder.deviceId ||
    certificateHash(initiator) !== body.initiatorCertificate ||
    certificateHash(responder) !== body.responderCertificate
  )
    throw new DeviceError("peer");
}
function matchInvite(invite: DeviceInvite, body: DeviceConfirmationBody): void {
  if (
    body.inviteId !== invite.inviteId ||
    body.pairId !== invite.pairId ||
    body.grantId !== invite.grantId ||
    body.initiatorId !== invite.device.deviceId ||
    certificateHash(invite.device) !== body.initiatorCertificate ||
    !sameScopes(body.scopes, invite.scopes)
  )
    throw new DeviceError("peer");
}
function fresh(invite: DeviceInvite, now: number): void {
  if (invite.expiresAt <= now || invite.issuedAt > now + 30000)
    throw new DeviceError("expired");
}
function validateState(raw: unknown, binding: string, now: number): VaultState {
  const v = deviceObject(raw, [
    "version",
    "revision",
    "binding",
    "identity",
    "invitation",
    "pair",
    "revoked",
    "counters",
    "acknowledged",
    "outbox",
    ...(raw && typeof raw === "object" && Object.hasOwn(raw, "replica")
      ? ["replica"]
      : []),
    ...(raw && typeof raw === "object" && Object.hasOwn(raw, "exchangeApproved")
      ? ["exchangeApproved"]
      : []),
  ]);
  if (v.version !== 1) throw new DeviceError("version");
  if (v.binding !== binding) throw new DeviceError("clone");
  const identity = checkDeviceIdentity(v.identity as DeviceIdentity, now),
    revision = deviceCount(v.revision);
  const state: VaultState = {
    version: 1,
    revision,
    binding,
    identity,
    invitation: null,
    pair: null,
    revoked: [],
    counters: counters(),
    acknowledged: counters(),
    outbox: [],
    replica: emptyDeviceReplica(),
    exchangeApproved: false,
  };
  if (v.invitation !== null) {
    const i = deviceObject(v.invitation, ["invite", "tokenHash", "status"]);
    if (
      !["open", "bound", "consumed", "cancelled"].includes(i.status as string)
    )
      throw new DeviceError("invalid");
    const tokenHash = deviceHex(i.tokenHash),
      publicInvite = deviceObject(i.invite, [
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
      ]),
      stored = validateDeviceInvite({ ...publicInvite, token: "0".repeat(64) });
    checkDevicePublic(stored.device, now);
    if (stored.device.deviceId !== identity.public.deviceId)
      throw new DeviceError("identity");
    const { token: _token, ...invite } = stored;
    void _token;
    state.invitation = {
      invite,
      tokenHash,
      status: i.status as StoredInvite["status"],
    };
  }
  if (!Array.isArray(v.revoked) || v.revoked.length > 256)
    throw new DeviceError("quota");
  state.revoked = v.revoked.map((raw) => {
    const r = deviceObject(raw, ["grantId", "at"]);
    return { grantId: deviceHex(r.grantId), at: deviceCount(r.at) };
  });
  if (
    new Set(state.revoked.map((r) => r.grantId)).size !== state.revoked.length
  )
    throw new DeviceError("invalid");
  if (v.pair !== null) {
    const p = deviceObject(v.pair, [
      "status",
      "peer",
      "body",
      "localProof",
      "peerProof",
      "allowed",
    ]);
    if (
      !["pending", "prepared", "active", "revoked"].includes(p.status as string)
    )
      throw new DeviceError("state");
    const peer = checkDevicePublic(p.peer, now),
      body = validateDeviceConfirmation({
        version: 1,
        kind: "confirmation",
        body: p.body,
        signature: "A".repeat(86) + "==",
      }).body;
    matchParticipants(body, identity.public, peer);
    const allowed = deviceScopes(p.allowed);
    if (allowed.some((s) => !body.scopes.includes(s)))
      throw new DeviceError("state");
    const pair: StoredPair = {
      status: p.status as StoredPair["status"],
      peer,
      body: normalizedBody(body),
      localProof:
        p.localProof === null ? null : validateDeviceConfirmation(p.localProof),
      peerProof:
        p.peerProof === null ? null : validateDeviceConfirmation(p.peerProof),
      allowed,
    };
    const role = localRole(state, pair);
    if (
      (pair.localProof &&
        !matchesProof(pair.localProof, body, role, identity.public)) ||
      (pair.peerProof &&
        !matchesProof(
          pair.peerProof,
          body,
          role === "initiator" ? "responder" : "initiator",
          peer,
        ))
    )
      throw new DeviceError("peer");
    if (
      ["prepared", "active"].includes(pair.status) &&
      (!pair.localProof || !pair.peerProof)
    )
      throw new DeviceError("not-confirmed");
    if (
      (pair.status === "revoked" &&
        !state.revoked.some((r) => r.grantId === body.grantId)) ||
      (pair.status !== "revoked" &&
        state.revoked.some((r) => r.grantId === body.grantId))
    )
      throw new DeviceError("revoked");
    state.pair = pair;
  }
  const c = deviceObject(v.counters, DEVICE_SCOPES),
    a = deviceObject(v.acknowledged, DEVICE_SCOPES);
  for (const scope of DEVICE_SCOPES) {
    state.counters[scope] = deviceCount(c[scope]);
    state.acknowledged[scope] = deviceCount(a[scope]);
    if (state.acknowledged[scope] > state.counters[scope])
      throw new DeviceError("state");
  }
  if (
    !Array.isArray(v.outbox) ||
    v.outbox.length > 1000 ||
    new TextEncoder().encode(JSON.stringify(v.outbox)).length > 8 * 1024 * 1024
  )
    throw new DeviceError("quota");
  const seen = new Set<string>();
  state.outbox = v.outbox.map((value) => {
    const op = validateDeviceOperation(value),
      pair = state.pair,
      key = `${op.scope}:${op.sequence}`;
    if (
      !pair ||
      pair.status !== "active" ||
      op.grantId !== pair.body.grantId ||
      op.pairId !== pair.body.pairId ||
      op.from !== identity.public.deviceId ||
      op.to !== pair.peer.deviceId ||
      !pair.allowed.includes(op.scope) ||
      op.sequence > state.counters[op.scope] ||
      op.sequence <= state.acknowledged[op.scope] ||
      seen.has(key)
    )
      throw new DeviceError("state");
    seen.add(key);
    return op;
  });
  state.replica = validateDeviceReplica(
    v.replica ?? emptyDeviceReplica(),
    replicaMeta(state),
  );
  if (
    v.exchangeApproved !== undefined &&
    typeof v.exchangeApproved !== "boolean"
  )
    throw new DeviceError("invalid");
  state.exchangeApproved = v.exchangeApproved === true;
  if (state.exchangeApproved && state.pair?.status !== "active")
    throw new DeviceError("state");
  return state;
}
function decode(io: DeviceVaultStorage, text: string, now: number): VaultState {
  if (text.length > 16 * 1024 * 1024) throw new DeviceError("size");
  let outer: Record<string, unknown>;
  try {
    outer = deviceObject(JSON.parse(text), ["version", "payload"]);
  } catch {
    throw new DeviceError("invalid");
  }
  if (outer.version !== 1) throw new DeviceError("version");
  if (typeof outer.payload !== "string" || !outer.payload.startsWith("enc:v1:"))
    throw new DeviceError("locked");
  let plain: string;
  try {
    plain = io.unprotect(outer.payload);
  } catch {
    throw new DeviceError("locked");
  }
  if (plain.length > 9 * 1024 * 1024) throw new DeviceError("size");
  let raw: unknown;
  try {
    raw = JSON.parse(plain);
  } catch {
    throw new DeviceError("invalid");
  }
  return validateState(raw, io.binding, now);
}
function encode(io: DeviceVaultStorage, state: VaultState): string {
  const plain = JSON.stringify(state);
  if (new TextEncoder().encode(plain).length > 9 * 1024 * 1024)
    throw new DeviceError("quota");
  let payload: string;
  try {
    payload = io.protect(plain);
  } catch {
    throw new DeviceError("locked");
  }
  if (typeof payload !== "string" || !payload.startsWith("enc:v1:"))
    throw new DeviceError("locked");
  return JSON.stringify({ version: 1, payload });
}
/** One main-process owner. TLS factories never start listeners. No IPC, logging or auto-start. */
export class DeviceVault {
  dataApproved() {
    this.active();
    return this.state.exchangeApproved;
  }
  approveDataExchange(grant: string): Promise<void> {
    return this.serial(() => {
      const p = this.active();
      if (p.body.grantId !== grant) throw new DeviceError("stale");
      if (this.state.exchangeApproved) return;
      const next = structuredClone(this.state);
      next.exchangeApproved = true;
      this.commit(next);
    });
  }
  invitationStatus() {
    const i = this.state.invitation;
    return i ? { status: i.status, expiresAt: i.invite.expiresAt } : null;
  }
  private revokeBarriers = new Set<() => Promise<void>>();
  private pauseEpoch = 0;
  onRevokeBarrier(barrier: () => Promise<void>): () => void {
    this.assert();
    this.revokeBarriers.add(barrier);
    return () => {
      this.revokeBarriers.delete(barrier);
    };
  }
  pendingDataJob() {
    return this.state.replica.job
      ? structuredClone(this.state.replica.job)
      : null;
  }
  replicaState() {
    this.active();
    return structuredClone(this.state.replica);
  }
  dataSnapshot(scope: DeviceScope): DeviceDataSnapshot {
    this.active(scope);
    const meta = replicaMeta(this.state)!;
    if (
      this.state.replica.job ||
      this.state.replica.localThrough[scope] !== this.state.counters[scope]
    )
      throw new DeviceError("state");
    const raw = {
      version: 1,
      kind: "snapshot",
      pairId: meta.pairId,
      grantId: meta.grantId,
      from: meta.self,
      to: meta.peer,
      scope,
      watermark: this.state.counters[scope],
      records: Object.values(this.state.replica.records)
        .filter((r) => r.heads[0].scope === scope)
        .map((r) => ({ clock: r.clock, heads: r.heads })),
    };
    return validateDeviceSnapshot(raw, {
      ...meta,
      self: meta.peer,
      peer: meta.self,
      counters: {
        preferences: Number.MAX_SAFE_INTEGER,
        views: Number.MAX_SAFE_INTEGER,
        playback: Number.MAX_SAFE_INTEGER,
      },
    });
  }
  importDataSnapshot(
    raw: DeviceDataSnapshot,
    approvedDigest: string,
  ): Promise<void> {
    return this.serial(() => {
      this.active(raw.scope);
      const s = validateDeviceSnapshot(raw, replicaMeta(this.state)!);
      if (
        deviceHash(JSON.stringify(s)) !== approvedDigest ||
        this.state.replica.resync
      )
        throw new DeviceError("not-confirmed");
      const next = structuredClone(this.state);
      next.replica = importDeviceSnapshot(next.replica, s);
      next.replica.resync = {
        scope: s.scope,
        watermark: s.watermark,
        digest: approvedDigest,
      };
      finishDeviceResync(next.replica);
      this.commit(next);
    });
  }
  finishDataResync(): Promise<void> {
    return this.serial(() => {
      this.active();
      const next = structuredClone(this.state);
      if (finishDeviceResync(next.replica)) this.commit(next);
    });
  }
  buildDataOperation(
    scope: DeviceScope,
    recordId: string,
    value: DeviceJson,
    deleted = false,
  ): DeviceOperation {
    const p = this.active(scope),
      r = this.state.replica.records[replicaKey(scope, recordId)];
    return validateDeviceDataOperation({
      version: 1,
      kind: "operation",
      pairId: p.body.pairId,
      grantId: p.body.grantId,
      from: publicOf(this.state).deviceId,
      to: p.peer.deviceId,
      scope,
      sequence: this.state.counters[scope] + 1,
      recordId,
      context: r?.clock ?? {},
      deleted,
      value,
    });
  }
  publishDataOperation(
    raw: DeviceOperation,
    stamp: string,
    replaceJobHeads?: string,
  ): Promise<DeviceOperation> {
    return this.serial(() => {
      const op = validateDeviceDataOperation(raw);
      this.active(op.scope);
      if (
        op.sequence !== this.state.counters[op.scope] + 1 ||
        this.state.outbox.length >= 1000 ||
        typeof stamp !== "string" ||
        stamp.length > 8192
      )
        throw new DeviceError("quota");
      const next = structuredClone(this.state);
      if (next.replica.job && replaceJobHeads) {
        if (
          next.replica.job.heads !== replaceJobHeads ||
          next.replica.job.scope !== op.scope ||
          next.replica.job.recordId !== op.recordId
        )
          throw new DeviceError("stale");
        next.replica.job = null;
      }
      next.counters[op.scope] = op.sequence;
      next.replica = publishDeviceReplica(
        next.replica,
        op,
        replicaMeta(next)!,
        stamp,
      );
      next.outbox.push(op);
      if (Buffer.byteLength(JSON.stringify(next.outbox)) > 8 * 1024 * 1024)
        throw new DeviceError("quota");
      this.commit(next);
      return structuredClone(op);
    });
  }
  stageDataResolution(
    scope: DeviceScope,
    id: string,
    value: DeviceJson,
    deleted: boolean,
    expectedHeads: string,
  ): Promise<DeviceOperation> {
    return this.serial(() => {
      this.active(scope);
      const r = this.state.replica.records[replicaKey(scope, id)];
      if (!r || replicaHeads(r.heads) !== expectedHeads)
        throw new DeviceError("stale");
      const op = this.buildDataOperation(scope, id, value, deleted);
      if (this.state.outbox.length >= 1000) throw new DeviceError("quota");
      const next = structuredClone(this.state);
      if (
        next.replica.job &&
        (next.replica.job.scope !== scope || next.replica.job.recordId !== id)
      )
        throw new DeviceError("state");
      next.replica.job = null;
      next.counters[scope] = op.sequence;
      next.replica = publishDeviceReplica(
        next.replica,
        op,
        replicaMeta(next)!,
        "",
      );
      next.replica.records[replicaKey(scope, id)].stamp = r.stamp;
      next.replica.records[replicaKey(scope, id)].issue = "pending";
      // Resolution does not ACK the superseded remote heads before the chosen value is materialized.
      next.replica.inbox = structuredClone(this.state.replica.inbox);
      next.outbox.push(op);
      if (Buffer.byteLength(JSON.stringify(next.outbox)) > 8 * 1024 * 1024)
        throw new DeviceError("quota");
      this.commit(next);
      return op;
    });
  }
  receiveDataOperation(raw: DeviceOperation): Promise<void> {
    return this.serial(() => {
      const op = validateDeviceDataOperation(raw);
      this.active(op.scope);
      const result = receiveDeviceReplica(
        this.state.replica,
        op,
        replicaMeta(this.state)!,
      );
      if (!result.duplicate) {
        const next = structuredClone(this.state);
        next.replica = result.state;
        this.commit(next);
      }
    });
  }
  prepareDataJob(
    scope: DeviceScope,
    recordId: string,
    raw: DeviceTargetPlan,
    expectedHeads: string,
    approval?: { heads: string; beforeStamp: string },
  ): Promise<boolean> {
    return this.serial(() => {
      this.active(scope);
      if (this.state.replica.job) throw new DeviceError("state");
      const r = this.state.replica.records[replicaKey(scope, recordId)];
      if (!r) throw new DeviceError("missing");
      const plan = validateDeviceScopedPlan(raw, scope, recordId),
        hash = replicaHeads(r.heads),
        next = structuredClone(this.state),
        record = next.replica.records[replicaKey(scope, recordId)];
      if (hash !== expectedHeads) throw new DeviceError("stale");
      let issue = plan.issue;
      if (r.heads.length !== 1) issue = "conflict";
      const approved =
        approval?.heads === hash && approval.beforeStamp === plan.beforeStamp;
      if (
        !issue &&
        plan.beforeStamp !== plan.afterStamp &&
        plan.beforeStamp !== (r.stamp ?? "null") &&
        !approved
      )
        issue = "local-change";
      if (issue) {
        if (record.issue !== issue) {
          record.issue = issue;
          this.commit(next);
        }
        return false;
      }
      next.replica.job = { scope, recordId, heads: hash, plan };
      this.commit(next);
      return true;
    });
  }
  finishDataJob(heads: string): Promise<void> {
    return this.serial(() => {
      const j = this.state.replica.job;
      if (!j || j.heads !== heads) throw new DeviceError("stale");
      this.active(j.scope);
      const next = structuredClone(this.state);
      completeRecord(next.replica, j.scope, j.recordId, j.plan.afterStamp);
      next.replica.lastApplied = { at: Date.now(), scope: j.scope };
      next.replica.job = null;
      finishDeviceResync(next.replica);
      this.commit(next);
    });
  }
  rebaseDataJob(
    scope: DeviceScope,
    recordId: string,
    raw: DeviceTargetPlan,
    approval: { heads: string; beforeStamp: string },
  ): Promise<void> {
    return this.serial(() => {
      this.active(scope);
      const job = this.state.replica.job,
        plan = validateDeviceScopedPlan(raw, scope, recordId);
      if (
        !job ||
        job.scope !== scope ||
        job.recordId !== recordId ||
        job.heads !== approval.heads ||
        plan.beforeStamp !== approval.beforeStamp ||
        plan.issue
      )
        throw new DeviceError("stale");
      const next = structuredClone(this.state);
      next.replica.job!.plan = plan;
      this.commit(next);
    });
  }
  private accessListeners = new Set<() => void>();
  onAccessChange(listener: () => void): () => void {
    this.assert();
    this.accessListeners.add(listener);
    return () => {
      this.accessListeners.delete(listener);
    };
  }
  private notifyAccess(): void {
    for (const listener of this.accessListeners) {
      try {
        listener();
      } catch {
        /* A transport cannot prevent revocation. */
      }
    }
  }
  sessionAccess() {
    this.assert();
    const p = this.state.pair;
    if (!p || !["prepared", "active"].includes(p.status))
      throw new DeviceError("not-confirmed");
    return structuredClone({
      peer: p.peer,
      pairId: p.body.pairId,
      grantId: p.body.grantId,
      scopes: p.allowed,
    });
  }
  guardSession(
    access: { peer: DevicePublic; pairId: string; grantId: string },
    scope?: DeviceScope,
    prepared = false,
  ): void {
    this.assert();
    const p = this.state.pair;
    if (
      !p ||
      !(prepared ? ["prepared", "active"] : ["active"]).includes(p.status) ||
      p.body.pairId !== access.pairId ||
      p.body.grantId !== access.grantId ||
      certificateHash(p.peer) !== certificateHash(access.peer) ||
      p.peer.deviceId !== access.peer.deviceId ||
      (scope && !p.allowed.includes(scope))
    )
      throw new DeviceError("revoked");
  }
  toJSON() {
    return this.closed ? { status: "closed" } : this.snapshot();
  }
  [inspect.custom]() {
    return this.toJSON();
  }
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private faulted = false;
  private suspended = false;
  private constructor(
    private io: DeviceVaultStorage,
    private state: VaultState,
    private cipher: string,
    private now: () => number,
  ) {}
  static async initialize(
    io: DeviceVaultStorage,
    now = Date.now,
  ): Promise<DeviceVault> {
    try {
      deviceHex(io.binding);
      if (io.read() !== null) throw new DeviceError("exists");
      const identity = await createDeviceIdentity(now());
      const state: VaultState = {
        version: 1,
        revision: 0,
        binding: io.binding,
        identity,
        invitation: null,
        pair: null,
        revoked: [],
        counters: counters(),
        acknowledged: counters(),
        outbox: [],
        replica: emptyDeviceReplica(),
        exchangeApproved: false,
      };
      const cipher = encode(io, state);
      io.write(null, cipher);
      if (io.read() !== cipher) throw new DeviceError("storage");
      return new DeviceVault(io, state, cipher, now);
    } catch (error) {
      io.close?.();
      if (error instanceof DeviceError) throw error;
      throw new DeviceError("storage");
    }
  }
  static open(io: DeviceVaultStorage, now = Date.now): DeviceVault {
    try {
      const cipher = io.read();
      if (cipher === null) throw new DeviceError("missing");
      return new DeviceVault(io, decode(io, cipher, now()), cipher, now);
    } catch (error) {
      io.close?.();
      if (error instanceof DeviceError) throw error;
      throw new DeviceError("storage");
    }
  }
  private assert(): void {
    if (this.closed || this.faulted || this.suspended)
      throw new DeviceError("state");
  }
  private serial<T>(
    action: () => T | Promise<T>,
    allowSuspended = false,
  ): Promise<T> {
    const next = this.queue
      .then(() => {
        if (!allowSuspended) this.assert();
        else if (this.closed) throw new DeviceError("state");
        return action();
      })
      .catch((error) => {
        if (error instanceof DeviceError) throw error;
        throw new DeviceError("storage");
      });
    this.queue = next.catch(() => {});
    return next;
  }
  private commit(next: VaultState): void {
    try {
      next.revision = this.state.revision + 1;
      validateState(next, this.io.binding, this.now());
      const encoded = encode(this.io, next);
      this.io.write(this.cipher, encoded);
      if (this.io.read() !== encoded) throw new DeviceError("storage");
      this.cipher = encoded;
      this.state = next;
    } catch (error) {
      this.faulted = true;
      this.notifyAccess();
      if (error instanceof DeviceError) throw error;
      throw new DeviceError("storage");
    }
  }
  publicIdentity(): DevicePublic {
    if (this.closed) throw new DeviceError("state");
    return structuredClone(publicOf(this.state));
  }
  snapshot() {
    if (this.closed) throw new DeviceError("state");
    const p = this.state.pair;
    return {
      version: 1,
      deviceId: publicOf(this.state).deviceId,
      revision: this.state.revision,
      status: this.faulted
        ? "paused-error"
        : this.suspended
          ? "pausing"
          : (p?.status ?? "unpaired"),
      peerId: p?.peer.deviceId ?? null,
      grantId: p?.body.grantId ?? null,
      scopes: p ? [...p.allowed] : [],
      outbox: this.state.outbox.length,
      counters: { ...this.state.counters },
      revokedGrants: this.state.revoked.length,
    };
  }
  private tlsOptions(peer?: DevicePublic): SecureContextOptions {
    this.assert();
    if (publicOf(this.state).version !== 2 || (peer && peer.version !== 2))
      throw new DeviceError("version");
    return {
      key: this.state.identity.tlsPrivateKey,
      cert:
        publicOf(this.state).certificate +
        "\n" +
        publicOf(this.state).certificateAuthority,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      secureOptions: constants.SSL_OP_NO_TICKET,
      ...(peer
        ? { ca: checkDevicePublic(peer, this.now()).certificateAuthority }
        : {}),
    };
  }
  createTlsServer(peer?: DevicePublic) {
    try {
      return createServer({
        ...this.tlsOptions(peer),
        requestCert: !!peer,
        rejectUnauthorized: true,
        ALPNProtocols: ["havvn-device-v1"],
        handshakeTimeout: 5000,
      });
    } catch (error) {
      if (error instanceof DeviceError) throw error;
      throw new DeviceError("identity");
    }
  }
  createTlsContext(peer?: DevicePublic): SecureContext {
    try {
      return createSecureContext(this.tlsOptions(peer));
    } catch (error) {
      if (error instanceof DeviceError) throw error;
      throw new DeviceError("identity");
    }
  }
  issueInvitation(
    endpoint: DeviceInvite["endpoint"],
    scopes: DeviceScope[],
  ): Promise<DeviceInvite> {
    return this.serial(() => {
      if (
        (this.state.pair && this.state.pair.status !== "revoked") ||
        this.state.invitation?.status === "open" ||
        this.state.revoked.length >= 256
      )
        throw new DeviceError("state");
      const at = this.now(),
        invite = validateDeviceInvite({
          version: 1,
          kind: "invite",
          inviteId: random(16),
          pairId: random(16),
          grantId: random(),
          device: publicOf(this.state),
          endpoint,
          scopes,
          issuedAt: at,
          expiresAt: at + 600000,
          token: random(),
        });
      const { token, ...stored } = invite,
        next = structuredClone(this.state);
      next.invitation = {
        invite: stored,
        tokenHash: deviceHash(token),
        status: "open",
      };
      this.commit(next);
      return invite;
    });
  }
  cancelInvitation(): Promise<void> {
    return this.serial(() => {
      const i = this.state.invitation;
      if (!i || i.status === "cancelled") return;
      if (i.status !== "open") throw new DeviceError("state");
      const next = structuredClone(this.state);
      this.tombstone(next, i.invite.grantId);
      next.invitation!.status = "cancelled";
      this.commit(next);
    });
  }
  private tombstone(next: VaultState, grantId: string): void {
    if (!next.revoked.some((r) => r.grantId === grantId)) {
      if (next.revoked.length >= 256) throw new DeviceError("quota");
      next.revoked.push({ grantId, at: this.now() });
    }
  }
  acceptInvitation(
    raw: DeviceInvite,
    body: DeviceConfirmationBody,
  ): Promise<void> {
    return this.serial(() => {
      if (
        (this.state.pair && this.state.pair.status !== "revoked") ||
        this.state.invitation?.status === "open"
      )
        throw new DeviceError("state");
      const invite = validateDeviceInvite(raw),
        peer = checkDevicePublic(invite.device, this.now());
      fresh(invite, this.now());
      matchInvite(invite, body);
      matchParticipants(body, publicOf(this.state), peer);
      if (
        body.responderId !== publicOf(this.state).deviceId ||
        this.state.revoked.some((r) => r.grantId === body.grantId)
      )
        throw new DeviceError("revoked");
      const validated = validateDeviceConfirmation({
        version: 1,
        kind: "confirmation",
        body,
        signature: "A".repeat(86) + "==",
      }).body;
      const next = structuredClone(this.state);
      next.pair = {
        status: "pending",
        peer,
        body: normalizedBody(validated),
        localProof: null,
        peerProof: null,
        allowed: deviceScopes(body.scopes),
      };
      next.counters = counters();
      next.acknowledged = counters();
      next.outbox = [];
      next.replica = emptyDeviceReplica();
      next.exchangeApproved = false;
      this.commit(next);
    });
  }
  approveLocal(): Promise<DeviceConfirmation> {
    return this.serial(() => {
      const pair = this.state.pair;
      if (!pair || !["pending", "prepared"].includes(pair.status))
        throw new DeviceError("state");
      if (pair.localProof) return structuredClone(pair.localProof);
      const body = { ...pair.body, role: localRole(this.state, pair) },
        proof: DeviceConfirmation = {
          version: 1,
          kind: "confirmation",
          body,
          signature: signDevice(
            this.state.identity,
            deviceConfirmationCanonical(body),
          ),
        };
      const next = structuredClone(this.state);
      next.pair!.localProof = proof;
      if (next.pair!.peerProof) next.pair!.status = "prepared";
      this.commit(next);
      return proof;
    });
  }
  bindInvitation(
    inviteId: string,
    token: string,
    peerRaw: DevicePublic,
    proofRaw: DeviceConfirmation,
  ): Promise<void> {
    return this.serial(() => {
      const i = this.state.invitation;
      if (
        !i ||
        !["open", "bound"].includes(i.status) ||
        i.invite.inviteId !== inviteId
      )
        throw new DeviceError("state");
      deviceHex(token);
      if (
        !timingSafeEqual(
          Buffer.from(i.tokenHash, "hex"),
          Buffer.from(deviceHash(token), "hex"),
        )
      )
        throw new DeviceError("peer");
      const invite = validateDeviceInvite({ ...i.invite, token }),
        proof = validateDeviceConfirmation(proofRaw),
        peer = checkDevicePublic(peerRaw, this.now());
      fresh(invite, this.now());
      matchInvite(invite, proof.body);
      matchParticipants(proof.body, publicOf(this.state), peer);
      if (
        proof.body.initiatorId !== publicOf(this.state).deviceId ||
        !matchesProof(proof, proof.body, "responder", peer) ||
        this.state.revoked.some((r) => r.grantId === proof.body.grantId)
      )
        throw new DeviceError("peer");
      if (i.status === "bound") {
        if (
          this.state.pair?.peer.deviceId === peer.deviceId &&
          transcript(this.state.pair.body) === transcript(proof.body)
        )
          return;
        throw new DeviceError("peer");
      }
      const next = structuredClone(this.state);
      next.invitation!.status = "bound";
      next.pair = {
        status: "pending",
        peer,
        body: normalizedBody(proof.body),
        localProof: null,
        peerProof: proof,
        allowed: deviceScopes(proof.body.scopes),
      };
      next.counters = counters();
      next.acknowledged = counters();
      next.outbox = [];
      next.replica = emptyDeviceReplica();
      next.exchangeApproved = false;
      this.commit(next);
    });
  }
  recordPeerProof(raw: DeviceConfirmation): Promise<void> {
    return this.serial(() => {
      const pair = this.state.pair;
      if (!pair || !["pending", "prepared"].includes(pair.status))
        throw new DeviceError("state");
      const proof = validateDeviceConfirmation(raw),
        role =
          localRole(this.state, pair) === "initiator"
            ? "responder"
            : "initiator";
      if (!matchesProof(proof, pair.body, role, pair.peer))
        throw new DeviceError("peer");
      if (pair.peerProof) return;
      const next = structuredClone(this.state);
      next.pair!.peerProof = proof;
      if (next.pair!.localProof) next.pair!.status = "prepared";
      this.commit(next);
    });
  }
  preparedReceipt(): DevicePrepared {
    this.assert();
    const p = this.state.pair;
    if (!p || !["prepared", "active"].includes(p.status))
      throw new DeviceError("not-confirmed");
    const body = {
      pairId: p.body.pairId,
      grantId: p.body.grantId,
      from: publicOf(this.state).deviceId,
      to: p.peer.deviceId,
      transcript: transcript(p.body),
    };
    return {
      version: 1,
      kind: "prepared",
      body,
      signature: signDevice(this.state.identity, devicePreparedCanonical(body)),
    };
  }
  activate(raw: DevicePrepared): Promise<void> {
    return this.serial(() => {
      const p = this.state.pair;
      if (!p || !["prepared", "active"].includes(p.status))
        throw new DeviceError("not-confirmed");
      const receipt = validateDevicePrepared(raw),
        b = receipt.body;
      if (
        b.pairId !== p.body.pairId ||
        b.grantId !== p.body.grantId ||
        b.from !== p.peer.deviceId ||
        b.to !== publicOf(this.state).deviceId ||
        b.transcript !== transcript(p.body) ||
        !verifyDevice(p.peer, devicePreparedCanonical(b), receipt.signature)
      )
        throw new DeviceError("peer");
      if (p.status === "active") return;
      const next = structuredClone(this.state);
      next.pair!.status = "active";
      if (next.invitation?.invite.grantId === p.body.grantId)
        next.invitation.status = "consumed";
      this.commit(next);
    });
  }
  private active(scope?: DeviceScope): StoredPair {
    this.assert();
    const p = this.state.pair;
    if (!p || p.status !== "active") throw new DeviceError("state");
    if (scope && !p.allowed.includes(scope)) throw new DeviceError("peer");
    return p;
  }
  enqueue(
    scope: DeviceScope,
    recordId: string,
    value: DeviceJson,
    context: Record<string, number> = {},
    deleted = false,
  ): Promise<DeviceOperation> {
    return this.serial(() => {
      const p = this.active(scope);
      if (this.state.outbox.length >= 1000) throw new DeviceError("quota");
      const op = validateDeviceOperation({
        version: 1,
        kind: "operation",
        pairId: p.body.pairId,
        grantId: p.body.grantId,
        from: publicOf(this.state).deviceId,
        to: p.peer.deviceId,
        scope,
        sequence: this.state.counters[scope] + 1,
        recordId,
        context,
        deleted,
        value,
      });
      const next = structuredClone(this.state);
      next.counters[scope] = op.sequence;
      next.outbox.push(op);
      if (Buffer.byteLength(JSON.stringify(next.outbox)) > 8 * 1024 * 1024)
        throw new DeviceError("quota");
      this.commit(next);
      return structuredClone(op);
    });
  }
  outbound(): DeviceOperation[] {
    this.active();
    return structuredClone(this.state.outbox);
  }
  guardOutbound(raw: DeviceOperation): DeviceOperation {
    const op = validateDeviceOperation(raw),
      p = this.active(op.scope);
    if (
      op.grantId !== p.body.grantId ||
      !this.state.outbox.some(
        (queued) => JSON.stringify(queued) === JSON.stringify(op),
      )
    )
      throw new DeviceError("stale");
    return op;
  }
  acknowledge(raw: DeviceAck): Promise<void> {
    return this.serial(() => {
      const ack = validateDeviceAck(raw),
        p = this.active(ack.scope);
      if (
        ack.pairId !== p.body.pairId ||
        ack.grantId !== p.body.grantId ||
        ack.from !== p.peer.deviceId ||
        ack.to !== publicOf(this.state).deviceId ||
        ack.through > this.state.counters[ack.scope]
      )
        throw new DeviceError("peer");
      if (ack.through <= this.state.acknowledged[ack.scope]) return;
      const next = structuredClone(this.state);
      next.acknowledged[ack.scope] = ack.through;
      next.outbox = next.outbox.filter(
        (op) => op.scope !== ack.scope || op.sequence > ack.through,
      );
      this.commit(next);
    });
  }
  narrowScopes(scopes: DeviceScope[]): Promise<void> {
    let allowed: DeviceScope[];
    try {
      allowed = deviceScopes(scopes);
      const p = this.active();
      if (allowed.some((s) => !p.allowed.includes(s)))
        throw new DeviceError("peer");
      if (sameScopes(p.allowed, allowed)) return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
    const epoch = ++this.pauseEpoch;
    this.suspended = true;
    this.notifyAccess();
    const drained = Promise.all(
      [...this.revokeBarriers].map((barrier) =>
        Promise.resolve().then(barrier),
      ),
    );
    void drained.catch(() => {});
    return this.serial(async () => {
      try {
        await drained;
        if (this.state.replica.job && !this.revokeBarriers.size)
          throw new DeviceError("state");
        const next = structuredClone(this.state);
        if (next.pair?.status !== "active") throw new DeviceError("state");
        next.pair.allowed = allowed;
        next.replica.job = null;
        next.outbox = next.outbox.filter((op) => allowed.includes(op.scope));
        this.commit(next);
        if (epoch === this.pauseEpoch) this.suspended = false;
        this.notifyAccess();
      } catch (error) {
        this.faulted = true;
        this.notifyAccess();
        throw error;
      }
    }, true);
  }
  revoke(): Promise<void> {
    const epoch = ++this.pauseEpoch;
    this.suspended = true;
    this.notifyAccess();
    const drained = Promise.all(
      [...this.revokeBarriers].map((barrier) =>
        Promise.resolve().then(barrier),
      ),
    );
    // Observe immediately; serial storage work may be queued ahead of this barrier.
    void drained.catch(() => {});
    return this.serial(async () => {
      try {
        await drained;
        if (this.state.replica.job && !this.revokeBarriers.size)
          throw new DeviceError("state");
        // Re-read after a previous uncertain write before deciding whether to retry.
        const cipher = this.io.read();
        if (cipher === null) throw new DeviceError("missing");
        const current = decode(this.io, cipher, this.now());
        if (publicOf(current).deviceId !== publicOf(this.state).deviceId)
          throw new DeviceError("identity");
        this.state = current;
        this.cipher = cipher;
        if (
          (!current.pair || current.pair.status === "revoked") &&
          (!current.invitation || current.invitation.status === "cancelled") &&
          !current.outbox.length
        ) {
          this.faulted = false;
          if (epoch === this.pauseEpoch) this.suspended = false;
          return;
        }
        const next = structuredClone(current),
          p = next.pair;
        if (p) {
          this.tombstone(next, p.body.grantId);
          p.status = "revoked";
        }
        if (next.invitation && next.invitation.status !== "cancelled") {
          this.tombstone(next, next.invitation.invite.grantId);
          next.invitation.status = "cancelled";
        }
        next.outbox = [];
        next.replica = emptyDeviceReplica();
        next.exchangeApproved = false;
        this.commit(next);
        this.faulted = false;
        if (epoch === this.pauseEpoch) this.suspended = false;
      } catch (error) {
        this.faulted = true;
        throw error;
      }
    }, true);
  }
  async close(): Promise<void> {
    await this.queue;
    this.closed = true;
    this.notifyAccess();
    this.accessListeners.clear();
    this.revokeBarriers.clear();
    this.io.close?.();
    this.state.identity.privateKey = "";
    this.state.identity.tlsPrivateKey = "";
  }
}
