import {
  DeviceError,
  DEVICE_SCOPES,
  deviceObject,
  deviceCount,
  deviceHex,
  type DeviceOperation,
  type DeviceScope,
} from "../../shared/device-pairing";
import {
  validateDeviceDataOperation,
  deviceDataCanonical,
  validateDeviceMedia,
} from "../../shared/device-data";
import {
  validateDeviceScopedPlan,
  type DeviceTargetPlan,
} from "../../shared/device-data-target";
import { deviceHash } from "./identity";
export interface ReplicaMeta {
  self: string;
  peer: string;
  pairId: string;
  grantId: string;
  counters: Record<DeviceScope, number>;
}
export interface DeviceRegister {
  clock: Record<string, number>;
  heads: DeviceOperation[];
  stamp: string | null;
  issue: string | null;
}
export interface DeviceReplicaState {
  version: 1;
  lastApplied?: { at: number; scope: DeviceScope };
  localThrough: Record<DeviceScope, number>;
  inbox: Record<
    DeviceScope,
    {
      floor: number;
      pending: Record<string, { operation: DeviceOperation; applied: boolean }>;
    }
  >;
  records: Record<string, DeviceRegister>;
  job: null | {
    scope: DeviceScope;
    recordId: string;
    heads: string;
    plan: DeviceTargetPlan;
  };
  resync: null | { scope: DeviceScope; watermark: number; digest: string };
}
export const replicaKey = (scope: DeviceScope, id: string) => scope + "/" + id;
export const mediaRecordId = (media: unknown) =>
  "media." + deviceHash(JSON.stringify(validateDeviceMedia(media)));
export const replicaHeads = (heads: DeviceOperation[]) =>
  deviceHash(deviceDataCanonical(heads));
export const emptyDeviceReplica = (): DeviceReplicaState => ({
  version: 1,
  localThrough: { preferences: 0, views: 0, playback: 0 },
  inbox: {
    preferences: { floor: 0, pending: {} },
    views: { floor: 0, pending: {} },
    playback: { floor: 0, pending: {} },
  },
  records: {},
  job: null,
  resync: null,
});
function clock(raw: unknown, meta: ReplicaMeta): Record<string, number> {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length > 2
  )
    throw new DeviceError("invalid");
  return Object.fromEntries(
    Object.entries(raw)
      .sort()
      .map(([id, n]) => {
        if (id !== meta.self && id !== meta.peer) throw new DeviceError("peer");
        return [id, deviceCount(n)];
      }),
  );
}
function validateOp(raw: unknown, meta: ReplicaMeta): DeviceOperation {
  const op = validateDeviceDataOperation(raw);
  if (
    op.pairId !== meta.pairId ||
    op.grantId !== meta.grantId ||
    ![meta.self, meta.peer].includes(op.from) ||
    op.to !== (op.from === meta.self ? meta.peer : meta.self) ||
    (op.from === meta.peer &&
      (op.context[meta.self] ?? 0) > meta.counters[op.scope]) ||
    (op.from === meta.self && op.sequence > meta.counters[op.scope])
  )
    throw new DeviceError("peer");
  if (op.scope === "playback" && !op.deleted) {
    const v = op.value as Record<string, unknown>;
    if (
      mediaRecordId({ infoHash: v.infoHash, path: v.path, size: v.size }) !==
      op.recordId
    )
      throw new DeviceError("peer");
  }
  return op;
}
function budget(state: DeviceReplicaState): void {
  if (
    Object.keys(state.records).length > 256 ||
    Buffer.byteLength(JSON.stringify(state)) > 3 * 1024 * 1024
  )
    throw new DeviceError("quota");
}
export function validateDeviceReplica(
  raw: unknown,
  meta: ReplicaMeta | null,
): DeviceReplicaState {
  const r = deviceObject(raw, [
    "version",
    "localThrough",
    "inbox",
    "records",
    "job",
    "resync",
    ...(raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'lastApplied') ? ['lastApplied'] : []),
  ]);
  if (r.version !== 1) throw new DeviceError("version");
  const state = emptyDeviceReplica(),
    through = deviceObject(r.localThrough, DEVICE_SCOPES),
    inbox = deviceObject(r.inbox, DEVICE_SCOPES);
  for (const scope of DEVICE_SCOPES) {
    state.localThrough[scope] = deviceCount(through[scope]);
    if (state.localThrough[scope] > (meta?.counters[scope] ?? 0))
      throw new DeviceError("state");
    const i = deviceObject(inbox[scope], ["floor", "pending"]);
    const floor = deviceCount(i.floor);
    if (
      !i.pending ||
      typeof i.pending !== "object" ||
      Array.isArray(i.pending) ||
      Object.keys(i.pending).length > 64
    )
      throw new DeviceError("invalid");
    state.inbox[scope].floor = floor;
    for (const [seq, raw] of Object.entries(i.pending)) {
      const p = deviceObject(raw, ["operation", "applied"]);
      if (!meta || typeof p.applied !== "boolean")
        throw new DeviceError("state");
      const op = validateOp(p.operation, meta);
      if (
        String(op.sequence) !== seq ||
        op.from !== meta.peer ||
        op.scope !== scope ||
        op.sequence <= floor ||
        op.sequence > floor + 64
      )
        throw new DeviceError("state");
      state.inbox[scope].pending[seq] = { operation: op, applied: p.applied };
    }
  }
  if (
    !r.records ||
    typeof r.records !== "object" ||
    Array.isArray(r.records) ||
    Object.keys(r.records).length > 256
  )
    throw new DeviceError("quota");
  for (const [key, raw] of Object.entries(r.records)) {
    const v = deviceObject(raw, ["clock", "heads", "stamp", "issue"]);
    if (
      !meta ||
      !Array.isArray(v.heads) ||
      v.heads.length < 1 ||
      v.heads.length > 2 ||
      !(
        v.stamp === null ||
        (typeof v.stamp === "string" && v.stamp.length <= 8192)
      ) ||
      !(
        v.issue === null ||
        (typeof v.issue === "string" && v.issue.length <= 40)
      )
    )
      throw new DeviceError("invalid");
    const heads = v.heads.map((h) => validateOp(h, meta)),
      c = clock(v.clock, meta);
    if (
      heads.some(
        (h) =>
          replicaKey(h.scope, h.recordId) !== key ||
          (c[h.from] ?? 0) !== h.sequence ||
          Object.entries(h.context).some(([id, n]) => (c[id] ?? 0) < n) ||
          heads.some(
            (other) =>
              other !== h && (h.context[other.from] ?? 0) >= other.sequence,
          ),
      ) ||
      new Set(heads.map((h) => h.from)).size !== heads.length ||
      (c[meta.self] ?? 0) > meta.counters[heads[0].scope]
    )
      throw new DeviceError("state");
    state.records[key] = {
      clock: c,
      heads,
      stamp: v.stamp as string | null,
      issue: v.issue as string | null,
    };
  }
  for (const scope of DEVICE_SCOPES)
    for (const p of Object.values(state.inbox[scope].pending))
      if (!state.records[replicaKey(scope, p.operation.recordId)])
        throw new DeviceError("state");
  if (r.job !== null) {
    const j = deviceObject(r.job, ["scope", "recordId", "heads", "plan"]);
    if (
      !DEVICE_SCOPES.includes(j.scope as DeviceScope) ||
      typeof j.recordId !== "string"
    )
      throw new DeviceError("invalid");
    const record =
      state.records[replicaKey(j.scope as DeviceScope, j.recordId)];
    if (
      !record ||
      record.heads.length !== 1 ||
      replicaHeads(record.heads) !== j.heads
    )
      throw new DeviceError("state");
    state.job = {
      scope: j.scope as DeviceScope,
      recordId: j.recordId,
      heads: deviceHex(j.heads),
      plan: validateDeviceScopedPlan(
        j.plan,
        j.scope as DeviceScope,
        j.recordId,
      ),
    };
    if (state.job.plan.issue) throw new DeviceError("state");
  }
  if (r.resync !== null) {
    const s = deviceObject(r.resync, ["scope", "watermark", "digest"]);
    if (!meta || !DEVICE_SCOPES.includes(s.scope as DeviceScope))
      throw new DeviceError("state");
    state.resync = {
      scope: s.scope as DeviceScope,
      watermark: deviceCount(s.watermark),
      digest: deviceHex(s.digest),
    };
  }
  if (r.lastApplied !== undefined) {
    const value = deviceObject(r.lastApplied, ['at', 'scope']);
    const at = deviceCount(value.at);
    if (!at || at > 8.64e15 || !DEVICE_SCOPES.includes(value.scope as DeviceScope)) throw new DeviceError('state');
    state.lastApplied = { at, scope: value.scope as DeviceScope };
  }
  if (!meta && JSON.stringify(state) !== JSON.stringify(emptyDeviceReplica()))
    throw new DeviceError("state");
  budget(state);
  return state;
}
function merge(state: DeviceReplicaState, op: DeviceOperation): void {
  const key = replicaKey(op.scope, op.recordId),
    old = state.records[key] ?? {
      clock: {},
      heads: [],
      stamp: null,
      issue: null,
    };
  if ((old.clock[op.from] ?? 0) >= op.sequence) return;
  if ((op.context[op.from] ?? 0) < (old.clock[op.from] ?? 0))
    throw new DeviceError("stale");
  const heads = old.heads.filter((h) => (op.context[h.from] ?? 0) < h.sequence);
  heads.push(structuredClone(op));
  heads.sort((a, b) => a.from.localeCompare(b.from));
  if (heads.length > 2) throw new DeviceError("quota");
  const c = { ...old.clock };
  for (const [id, n] of Object.entries({
    ...op.context,
    [op.from]: op.sequence,
  }))
    c[id] = Math.max(c[id] ?? 0, n);
  state.records[key] = {
    clock: Object.fromEntries(Object.entries(c).sort()),
    heads,
    stamp: old.stamp,
    issue: heads.length > 1 ? "conflict" : "pending",
  };
  budget(state);
}
export function receiveDeviceReplica(
  state: DeviceReplicaState,
  raw: unknown,
  meta: ReplicaMeta,
): { state: DeviceReplicaState; duplicate: boolean } {
  if (state.job) throw new DeviceError("state");
  const op = validateOp(raw, meta);
  if (op.from !== meta.peer) throw new DeviceError("peer");
  if (
    (op.context[meta.self] ?? 0) >
    (state.records[replicaKey(op.scope, op.recordId)]?.clock[meta.self] ?? 0)
  )
    throw new DeviceError("peer");
  const inbox = state.inbox[op.scope];
  if (op.sequence <= inbox.floor)
    return { state: structuredClone(state), duplicate: true };
  if (op.sequence > inbox.floor + 64) throw new DeviceError("quota");
  const previous = inbox.pending[String(op.sequence)];
  if (previous) {
    if (deviceDataCanonical(previous.operation) !== deviceDataCanonical(op))
      throw new DeviceError("stale");
    return { state: structuredClone(state), duplicate: true };
  }
  const next = structuredClone(state);
  merge(next, op);
  next.inbox[op.scope].pending[String(op.sequence)] = {
    operation: op,
    applied: false,
  };
  budget(next);
  return { state: next, duplicate: false };
}
export function publishDeviceReplica(
  state: DeviceReplicaState,
  raw: unknown,
  meta: ReplicaMeta,
  stamp: string,
): DeviceReplicaState {
  if (state.job) throw new DeviceError("state");
  const op = validateOp(raw, meta);
  if (op.from !== meta.self || op.sequence !== state.localThrough[op.scope] + 1)
    throw new DeviceError("state");
  const expected =
    state.records[replicaKey(op.scope, op.recordId)]?.clock ?? {};
  if (deviceDataCanonical(expected) !== deviceDataCanonical(op.context))
    throw new DeviceError("stale");
  const next = structuredClone(state);
  merge(next, op);
  next.localThrough[op.scope] = op.sequence;
  completeRecord(next, op.scope, op.recordId, stamp);
  return next;
}
export function completeRecord(
  state: DeviceReplicaState,
  scope: DeviceScope,
  id: string,
  stamp: string,
): void {
  const record = state.records[replicaKey(scope, id)];
  if (!record || record.heads.length !== 1) throw new DeviceError("state");
  record.stamp = stamp;
  record.issue = null;
  const inbox = state.inbox[scope];
  for (const item of Object.values(inbox.pending))
    if (item.operation.recordId === id) item.applied = true;
  while (inbox.pending[String(inbox.floor + 1)]?.applied) {
    inbox.floor++;
    delete inbox.pending[String(inbox.floor)];
  }
}
export interface DeviceDataSnapshot {
  version: 1;
  kind: "snapshot";
  pairId: string;
  grantId: string;
  from: string;
  to: string;
  scope: DeviceScope;
  watermark: number;
  records: Array<{ clock: Record<string, number>; heads: DeviceOperation[] }>;
}
export function validateDeviceSnapshot(
  raw: unknown,
  meta: ReplicaMeta,
): DeviceDataSnapshot {
  const s = deviceObject(raw, [
    "version",
    "kind",
    "pairId",
    "grantId",
    "from",
    "to",
    "scope",
    "watermark",
    "records",
  ]);
  if (
    s.version !== 1 ||
    s.kind !== "snapshot" ||
    s.pairId !== meta.pairId ||
    s.grantId !== meta.grantId ||
    s.from !== meta.peer ||
    s.to !== meta.self ||
    !DEVICE_SCOPES.includes(s.scope as DeviceScope) ||
    !Array.isArray(s.records) ||
    s.records.length > 256
  )
    throw new DeviceError("peer");
  if (Buffer.byteLength(JSON.stringify(raw)) > 65536)
    throw new DeviceError("size");
  const scope = s.scope as DeviceScope,
    watermark = deviceCount(s.watermark),
    seen = new Set<string>();
  const records = s.records.map((raw) => {
    const r = deviceObject(raw, ["clock", "heads"]);
    if (!Array.isArray(r.heads) || !r.heads.length || r.heads.length > 2)
      throw new DeviceError("invalid");
    const c = clock(r.clock, meta),
      heads = r.heads.map((h) => validateOp(h, meta)),
      id = heads[0].recordId;
    if (
      seen.has(id) ||
      heads.some(
        (h) =>
          h.scope !== scope ||
          h.recordId !== id ||
          (c[h.from] ?? 0) !== h.sequence ||
          Object.entries(h.context).some(([id, n]) => (c[id] ?? 0) < n) ||
          heads.some(
            (other) =>
              other !== h && (h.context[other.from] ?? 0) >= other.sequence,
          ),
      ) ||
      new Set(heads.map((h) => h.from)).size !== heads.length ||
      (c[meta.self] ?? 0) > meta.counters[scope] ||
      (c[meta.peer] ?? 0) > watermark
    )
      throw new DeviceError("peer");
    seen.add(id);
    return { clock: c, heads };
  });
  records.sort((a, b) =>
    a.heads[0].recordId.localeCompare(b.heads[0].recordId),
  );
  return {
    version: 1,
    kind: "snapshot",
    pairId: meta.pairId,
    grantId: meta.grantId,
    from: meta.peer,
    to: meta.self,
    scope,
    watermark,
    records,
  };
}
export function importDeviceSnapshot(
  state: DeviceReplicaState,
  snapshot: DeviceDataSnapshot,
): DeviceReplicaState {
  if (state.job) throw new DeviceError("state");
  const next = structuredClone(state);
  for (const r of snapshot.records) {
    const key = replicaKey(snapshot.scope, r.heads[0].recordId),
      old = next.records[key] ?? {
        clock: {},
        heads: [],
        stamp: null,
        issue: null,
      };
    // A peer cannot invent a local operation/causal dot just because that global
    // sequence was issued for a different record.
    const self = snapshot.to;
    if ((r.clock[self] ?? 0) > (old.clock[self] ?? 0))
      throw new DeviceError("peer");
    const same = (a: DeviceOperation, b: DeviceOperation) =>
      a.from === b.from && a.sequence === b.sequence;
    const heads = [
      ...old.heads.filter(
        (h) =>
          (r.clock[h.from] ?? 0) < h.sequence ||
          r.heads.some((v) => same(v, h)),
      ),
      ...r.heads.filter(
        (h) =>
          (old.clock[h.from] ?? 0) < h.sequence ||
          old.heads.some((v) => same(v, h)),
      ),
    ];
    const unique: DeviceOperation[] = [];
    for (const head of heads) {
      const existing = unique.find((v) => same(v, head));
      if (
        existing &&
        deviceDataCanonical(existing) !== deviceDataCanonical(head)
      )
        throw new DeviceError("stale");
      if (!existing) unique.push(structuredClone(head));
    }
    if (unique.length < 1 || unique.length > 2) throw new DeviceError("state");
    unique.sort((a, b) => a.from.localeCompare(b.from));
    const c = { ...old.clock };
    for (const [id, n] of Object.entries(r.clock))
      c[id] = Math.max(c[id] ?? 0, n);
    next.records[key] = {
      clock: Object.fromEntries(Object.entries(c).sort()),
      heads: unique,
      stamp: old.stamp,
      issue:
        unique.length > 1
          ? "conflict"
          : replicaHeads(old.heads) !== replicaHeads(unique)
            ? "pending"
            : old.issue,
    };
  }
  // Never discard tombstones or skip pending application. Completion of a confirmed
  // snapshot advances the floor separately, only after every resulting record is applied.
  budget(next);
  return next;
}
export function finishDeviceResync(state: DeviceReplicaState): boolean {
  const sync = state.resync;
  if (!sync) return false;
  const records = Object.values(state.records).filter(
    (r) => r.heads[0].scope === sync.scope,
  );
  if (
    records.some(
      (r) => r.heads.length !== 1 || r.stamp === null || r.issue !== null,
    ) ||
    Object.values(state.inbox[sync.scope].pending).some(
      (p) => p.operation.sequence <= sync.watermark && !p.applied,
    )
  )
    return false;
  const inbox = state.inbox[sync.scope];
  inbox.floor = Math.max(inbox.floor, sync.watermark);
  for (const [seq] of Object.entries(inbox.pending))
    if (Number(seq) <= inbox.floor) delete inbox.pending[seq];
  state.resync = null;
  return true;
}
