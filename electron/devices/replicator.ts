import {
  DeviceError,
  type DeviceScope,
  type DeviceOperation,
  type DeviceJson,
  type DeviceAck,
} from "../../shared/device-pairing";
import {
  validateDeviceTargetPlan,
  type DeviceTargetPlan,
} from "../../shared/device-data-target";
import { DeviceVault } from "./vault";
import { inspect } from "node:util";
import { DeviceSession } from "./session";
import { deviceHash } from "./identity";
import {
  replicaKey,
  replicaHeads,
  validateDeviceSnapshot,
  type DeviceDataSnapshot,
} from "./replica-state";
export type DeviceDataJob = NonNullable<
  ReturnType<DeviceVault["pendingDataJob"]>
>;
export interface DeviceDataTarget {
  plan(operation: DeviceOperation): Promise<DeviceTargetPlan>;
  apply(job: DeviceDataJob): Promise<void>;
  rollback(job: DeviceDataJob): Promise<void>;
}
/** Explicit DP-03 controller; ordinary startup and UI never instantiate it yet. */
export class DeviceReplicator {
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private writes = new Set<Promise<void>>();
  private unsubscribe: () => void;
  status() {
    const state = this.vault.replicaState();
    return {
      records: Object.keys(state.records).length,
      lastApplied: state.lastApplied ?? null,
      conflicts: Object.values(state.records).filter((r) => r.heads.length > 1)
        .length,
      pending: Object.values(state.records).filter((r) => r.issue !== null)
        .length,
      unappliedOperations: Object.values(state.inbox).reduce(
        (n, i) => n + Object.values(i.pending).filter((p) => !p.applied).length,
        0,
      ),
      journal: !!state.job,
      resync: !!state.resync,
    };
  }
  toJSON() {
    try {
      return this.closed ? { closed: true } : this.status();
    } catch {
      return { paused: true };
    }
  }
  [inspect.custom]() {
    return this.toJSON();
  }
  constructor(
    private vault: DeviceVault,
    private target: DeviceDataTarget,
  ) {
    this.unsubscribe = vault.onRevokeBarrier(async () => {
      await Promise.allSettled([...this.writes]);
      const job = vault.pendingDataJob();
      if (job) await target.rollback(job);
    });
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new DeviceError("state"));
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  private guard(scope: DeviceScope): void {
    this.vault.guardSession(this.vault.sessionAccess(), scope);
  }
  private ack(scope: DeviceScope): DeviceAck | null {
    this.guard(scope);
    const a = this.vault.sessionAccess(),
      through = this.vault.replicaState().inbox[scope].floor;
    return through
      ? {
          version: 1,
          kind: "ack",
          pairId: a.pairId,
          grantId: a.grantId,
          from: this.vault.publicIdentity().deviceId,
          to: a.peer.deviceId,
          scope,
          through,
        }
      : null;
  }
  private async recoverJob(): Promise<void> {
    const job = this.vault.pendingDataJob();
    if (!job) return;
    this.guard(job.scope);
    const write = this.target.apply(job);
    this.writes.add(write);
    try {
      await write;
    } finally {
      this.writes.delete(write);
    }
    this.guard(job.scope);
    await this.vault.finishDataJob(job.heads);
  }
  private async retryRecord(
    scope: DeviceScope,
    id: string,
    approval?: { heads: string; beforeStamp: string },
  ): Promise<void> {
    this.guard(scope);
    const record = this.vault.replicaState().records[replicaKey(scope, id)];
    if (!record) return;
    if (record.heads.length !== 1) return;
    const op = record.heads[0],
      plan = validateDeviceTargetPlan(await this.target.plan(op));
    this.guard(scope);
    if (
      await this.vault.prepareDataJob(
        scope,
        id,
        plan,
        replicaHeads(record.heads),
        approval,
      )
    )
      await this.recoverJob();
  }
  receive(op: DeviceOperation): Promise<DeviceAck | null> {
    return this.serial(async () => {
      await this.recoverJob();
      const before = this.vault.replicaState().inbox[op.scope];
      await this.vault.receiveDataOperation(op);
      if (
        op.sequence <= before.floor ||
        before.pending[String(op.sequence)]?.applied
      )
        return this.ack(op.scope);
      await this.retryRecord(op.scope, op.recordId);
      return this.ack(op.scope);
    });
  }
  publish(
    scope: DeviceScope,
    id: string,
    value: DeviceJson,
    deleted = false,
  ): Promise<DeviceOperation> {
    return this.serial(async () => {
      await this.recoverJob();
      const op = this.vault.buildDataOperation(scope, id, value, deleted),
        plan = validateDeviceTargetPlan(await this.target.plan(op));
      this.guard(scope);
      if (plan.issue || plan.beforeStamp !== plan.afterStamp)
        throw new DeviceError("stale");
      return this.vault.publishDataOperation(op, plan.afterStamp);
    });
  }
  resolve(
    scope: DeviceScope,
    id: string,
    value: DeviceJson,
    deleted: boolean,
    expectedHeads: string,
    beforeStamp: string,
  ): Promise<DeviceOperation> {
    return this.serial(async () => {
      this.guard(scope);
      const record = this.vault.replicaState().records[replicaKey(scope, id)];
      if (!record || replicaHeads(record.heads) !== expectedHeads)
        throw new DeviceError("stale");
      const draft = this.vault.buildDataOperation(scope, id, value, deleted),
        plan = validateDeviceTargetPlan(await this.target.plan(draft));
      this.guard(scope);
      if (plan.issue || plan.beforeStamp !== beforeStamp)
        throw new DeviceError("stale");
      if (plan.beforeStamp === plan.afterStamp)
        return this.vault.publishDataOperation(
          draft,
          plan.afterStamp,
          this.vault.pendingDataJob()?.heads,
        );
      const op = await this.vault.stageDataResolution(
          scope,
          id,
          value,
          deleted,
          expectedHeads,
        ),
        heads = replicaHeads([op]);
      if (
        await this.vault.prepareDataJob(scope, id, plan, heads, {
          heads,
          beforeStamp,
        })
      )
        await this.recoverJob();
      return op;
    });
  }
  preview(scope: DeviceScope, id: string) {
    return this.serial(async () => {
      this.guard(scope);
      const r = this.vault.replicaState().records[replicaKey(scope, id)];
      if (!r) throw new DeviceError("missing");
      if (r.heads.length !== 1)
        return { heads: replicaHeads(r.heads), plan: null, conflict: true };
      const plan = validateDeviceTargetPlan(await this.target.plan(r.heads[0]));
      this.guard(scope);
      return { heads: replicaHeads(r.heads), plan, conflict: false };
    });
  }
  retry(
    scope: DeviceScope,
    id: string,
    approval?: { heads: string; beforeStamp: string },
  ): Promise<DeviceAck | null> {
    return this.serial(async () => {
      const job = this.vault.pendingDataJob();
      if (job && approval && job.scope === scope && job.recordId === id) {
        const record = this.vault.replicaState().records[replicaKey(scope, id)];
        if (record.heads.length !== 1) throw new DeviceError("stale");
        const plan = validateDeviceTargetPlan(
          await this.target.plan(record.heads[0]),
        );
        this.guard(scope);
        await this.vault.rebaseDataJob(scope, id, plan, approval);
      }
      await this.recoverJob();
      await this.retryRecord(scope, id, approval);
      await this.vault.finishDataResync();
      return this.ack(scope);
    });
  }
  recover(): Promise<void> {
    return this.serial(async () => {
      await this.recoverJob();
      const scopes = this.vault.sessionAccess().scopes;
      for (const [key, record] of Object.entries(
        this.vault.replicaState().records,
      )) {
        const op = record.heads[0];
        if (record.heads.length !== 1 || !scopes.includes(op.scope)) continue;
        const plan = validateDeviceTargetPlan(await this.target.plan(op));
        this.guard(op.scope);
        if (
          plan.issue ||
          plan.beforeStamp !== plan.afterStamp ||
          record.issue !== null
        ) {
          if (
            await this.vault.prepareDataJob(
              op.scope,
              key.slice(op.scope.length + 1),
              plan,
              replicaHeads(record.heads),
            )
          )
            await this.recoverJob();
        }
      }
    });
  }
  acceptSnapshot(
    raw: DeviceDataSnapshot,
    consent: (preview: {
      digest: string;
      scope: DeviceScope;
      records: number;
    }) => Promise<boolean>,
  ): Promise<DeviceAck | null> {
    return this.serial(async () => {
      await this.recoverJob();
      const access = this.vault.sessionAccess(),
        s = validateDeviceSnapshot(raw, {
          self: this.vault.publicIdentity().deviceId,
          peer: access.peer.deviceId,
          pairId: access.pairId,
          grantId: access.grantId,
          counters: this.vault.snapshot().counters,
        }),
        digest = deviceHash(JSON.stringify(s));
      const existing = this.vault.replicaState();
      if (s.watermark <= existing.inbox[s.scope].floor)
        return this.ack(s.scope);
      if (existing.resync && existing.resync.digest !== digest)
        throw new DeviceError("state");
      if (
        !existing.resync &&
        (await consent({
          digest,
          scope: s.scope,
          records: s.records.length,
        })) !== true
      )
        throw new DeviceError("not-confirmed");
      this.guard(s.scope);
      if (!existing.resync) await this.vault.importDataSnapshot(s, digest);
      for (const [key, r] of Object.entries(this.vault.replicaState().records))
        if (r.heads[0].scope === s.scope)
          await this.retryRecord(s.scope, key.slice(s.scope.length + 1));
      await this.vault.finishDataResync();
      return this.ack(s.scope);
    });
  }
  async receiveOnce(
    session: DeviceSession,
    consentSnapshot: (preview: {
      digest: string;
      scope: DeviceScope;
      records: number;
    }) => Promise<boolean>,
  ) {
    const message = await session.receive();
    if (message.kind === "ack") return;
    const ack =
      message.kind === "snapshot"
        ? await this.acceptSnapshot(message, consentSnapshot)
        : await this.receive(message);
    if (ack) await session.send(ack);
  }
  async close() {
    await this.queue;
    this.closed = true;
    this.unsubscribe();
  }
}
