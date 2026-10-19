/** Signed file-sync index. V1 is single-publisher; V2 carries explicit writers and checkpoints. */
export const SYNC_ROOT_FILE_LIMIT = 2000;
export const SYNC_REVISION_LIMIT = 10000;
export const SYNC_POLICY_LIMIT = 64;
export const SYNC_FILE_BYTES = 256 * 1024 * 1024;
export const SYNC_CHECKPOINT_HEAD_LIMIT = SYNC_ROOT_FILE_LIMIT;
export const SYNC_LEGACY_CHECKPOINT_HEAD_LIMIT = 64;
export const SYNC_CHECKPOINT_ORIGIN_LIMIT = 4096;
export const SYNC_ARCHIVE_EPOCH_LIMIT = 8;
export const SYNC_HISTORY_REVISION_LIMIT = SYNC_REVISION_LIMIT * (SYNC_ARCHIVE_EPOCH_LIMIT * 2 + 1);
export const SYNC_RECOVERY_OPERATION_LIMIT = 100_000;
export const SYNC_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const SYNC_HASH = /^[a-f0-9]{64}$/;
const MEMBER = /^[a-f0-9]{32}$/;
const INFO_HASH = /^[a-f0-9]{40}$/;

export interface SyncBlob {
  infoHash: string;
  name: string;
  size: number;
  enc: boolean;
  keyEpoch: string | null;
}
export interface SyncHead { entryId: string; revisionId: string }
export interface SyncPolicy {
  v: 1 | 2 | 3 | 4 | 5 | 6;
  checkpoint?: { generation: number; parentCheckpointId: string | null; archiveDigest: string; archiveRecords: number; anchors: SyncRevision[];
    origins: Array<{ entryId: string; path: string }> };
  writers?: string[];
  rootId: string;
  policyId: string;
  epoch: number;
  parentPolicyId: string | null;
  ownerId: string;
  publisherId: string;
  name: string;
  allowDeletes: boolean;
  baseHeads: SyncHead[];
  pub: string;
  sig: string;
}
export interface SyncRevision {
  v: 1 | 2 | 3 | 4 | 5 | 6;
  rootId: string;
  revisionId: string;
  policyId: string;
  entryId: string;
  parents: string[];
  relativePath: string;
  previousPaths?: string[];
  op: 'put' | 'delete';
  blob: SyncBlob | null;
  authorId: string;
  createdAt: number;
  pub: string;
  sig: string;
}
export interface SyncIndexContext { scope: string; rootId: string; ownerId: string; e2e: boolean }
export type SyncProofVerifier = (memberId: string, pub: string, sig: string, bytes: Uint8Array, id: string) => boolean;
export type SyncRecord = { kind: 'policy'; value: SyncPolicy } | { kind: 'revision'; value: SyncRevision };
export type SyncIndexErrorCode = 'invalid' | 'authority' | 'policy-chain' | 'stale-policy' | 'missing-parent' | 'parent' | 'limit';
export class SyncIndexError extends Error {
  constructor(readonly code: SyncIndexErrorCode, message: string) { super(message); this.name = 'SyncIndexError'; }
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const matches = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const proof = (v: Record<string, unknown>) => text(v.pub, 2048) && matches(v.sig, /^[A-Za-z0-9+/]{86}==$/);

export function validSyncName(value: unknown): value is string {
  return text(value, 240) && value !== '.' && value !== '..' && !/[<>:"/\\|?*]/.test(value)
    && !Array.from(value).some(c => c.charCodeAt(0) < 32) && !/[. ]$/.test(value) && !/[\uD800-\uDFFF]/u.test(value)
    && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value);
}
export function validSyncRelativePath(value: unknown): value is string {
  return text(value, 1024) && value.split('/').every(part => validSyncName(part) && !/^\.havvn(?:-|$)/i.test(part));
}
export function validSyncMovePaths(from: string, to: string): boolean {
  const a = from.normalize('NFC').toLowerCase(), b = to.normalize('NFC').toLowerCase();
  return validSyncRelativePath(from) && validSyncRelativePath(to) && a !== b && !a.startsWith(b + '/') && !b.startsWith(a + '/');
}
export function syncPreviousPaths(target: string, parents: SyncRevision[]): { previousPaths?: string[] } {
  const paths = [...new Set(parents.map(p => p.relativePath).filter(p => p !== target))].sort();
  return paths.length ? { previousPaths: paths } : {};
}
export function validSyncBlob(value: unknown): value is SyncBlob {
  return object(value) && matches(value.infoHash, INFO_HASH) && validSyncName(value.name)
    && Number.isSafeInteger(value.size) && (value.size as number) >= 0 && (value.size as number) <= SYNC_FILE_BYTES
    && typeof value.enc === 'boolean' && (value.enc ? validSyncName(`${value.name}.enc`) && matches(value.keyEpoch, SYNC_HASH) : value.keyEpoch === null);
}
export function validSyncPolicy(value: unknown): value is SyncPolicy {
  return object(value) && (value.v === 1 && value.writers === undefined || (value.v === 2 || value.v === 3 || value.v === 4 || value.v === 5 || value.v === 6) && Array.isArray(value.writers)
    && value.writers.length > 0 && value.writers.length <= 16 && value.writers.every((w, i, all) => matches(w, MEMBER) && (!i || w > all[i - 1]))
    && value.writers.includes(value.ownerId) && value.writers.includes(value.publisherId)) && matches(value.rootId, SYNC_UUID) && matches(value.policyId, SYNC_HASH)
    && Number.isSafeInteger(value.epoch) && (value.epoch as number) > 0
    && (value.parentPolicyId === null || matches(value.parentPolicyId, SYNC_HASH))
    && matches(value.ownerId, MEMBER) && matches(value.publisherId, MEMBER) && text(value.name, 80)
    && typeof value.allowDeletes === 'boolean' && proof(value) && Array.isArray(value.baseHeads)
    && value.baseHeads.length <= SYNC_ROOT_FILE_LIMIT && value.baseHeads.every((h, i, all) => object(h)
      && matches(h.entryId, SYNC_UUID) && matches(h.revisionId, SYNC_HASH) && (!i || h.entryId > all[i - 1].entryId
        || value.v !== 1 && h.entryId === all[i - 1].entryId && h.revisionId > all[i - 1].revisionId))
    && (value.checkpoint === undefined || (value.v === 4 || value.v === 5 || value.v === 6) && (value.epoch as number) > 1 && value.parentPolicyId !== null && validSyncCheckpoint(value.checkpoint, value.baseHeads, value.v));
}
function validSyncCheckpoint(value: unknown, heads: Array<{ entryId: string; revisionId: string }>, version: 4 | 5 | 6): boolean {
  if (!object(value) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1
    || !(value.generation === 1 ? value.parentCheckpointId === null : matches(value.parentCheckpointId, SYNC_HASH)) || !matches(value.archiveDigest, SYNC_HASH)
    || !Number.isSafeInteger(value.archiveRecords) || (value.archiveRecords as number) < 1 || (value.archiveRecords as number) > SYNC_POLICY_LIMIT + SYNC_REVISION_LIMIT
    || !Array.isArray(value.anchors) || value.anchors.length > (version === 4 ? SYNC_LEGACY_CHECKPOINT_HEAD_LIMIT : SYNC_CHECKPOINT_HEAD_LIMIT) || value.anchors.length !== heads.length
    || !Array.isArray(value.origins) || value.origins.length > SYNC_CHECKPOINT_ORIGIN_LIMIT
    || !value.origins.every((o, i, all) => object(o) && matches(o.entryId, SYNC_UUID) && validSyncRelativePath(o.path) && heads.some(h => h.entryId === o.entryId)
      && (!i || o.entryId > all[i - 1].entryId || o.entryId === all[i - 1].entryId && o.path > all[i - 1].path))) return false;
  return value.anchors.every((r, i) => validSyncRevision(r) && r.v <= version && r.entryId === heads[i].entryId && r.revisionId === heads[i].revisionId);
}
export function syncWriters(policy: SyncPolicy | null): string[] { return !policy ? [] : policy.v >= 2 ? [...policy.writers!] : [policy.publisherId]; }
export function canWriteSync(policy: SyncPolicy | null, memberId: string): boolean { return syncWriters(policy).includes(memberId); }
export function validSyncRevision(value: unknown): value is SyncRevision {
  return object(value) && (value.v === 1 || value.v === 2 || value.v === 3 || value.v === 4 || value.v === 5 || value.v === 6) && matches(value.rootId, SYNC_UUID) && matches(value.revisionId, SYNC_HASH)
    && matches(value.policyId, SYNC_HASH) && matches(value.entryId, SYNC_UUID) && matches(value.authorId, MEMBER)
    && Number.isSafeInteger(value.createdAt) && (value.createdAt as number) >= 0 && (value.createdAt as number) <= 8_640_000_000_000_000
    && proof(value) && validSyncRelativePath(value.relativePath) && Array.isArray(value.parents) && value.parents.length <= (value.v >= 2 ? 64 : 8)
    && (value.previousPaths === undefined || (value.v === 3 || value.v === 4 || value.v === 5 || value.v === 6) && value.op === 'put' && value.parents.length > 0 && Array.isArray(value.previousPaths)
      && value.previousPaths.length > 0 && value.previousPaths.length <= 64 && value.previousPaths.every((p, i, all) => typeof p === 'string'
        && validSyncMovePaths(p, value.relativePath as string) && (!i || p > all[i - 1])))
    && value.parents.every((p, i, all) => matches(p, SYNC_HASH) && p !== value.revisionId && (!i || p > all[i - 1]))
    && (value.op === 'put' && validSyncBlob(value.blob) && value.blob.name === value.relativePath.split('/').at(-1)
      || value.op === 'delete' && value.blob === null && value.parents.length > 0);
}

/** IDs and signatures share the same domain-separated canonical bytes. */
export function syncPolicyCanonical(scope: string, p: Omit<SyncPolicy, 'policyId' | 'sig'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([`havvn-file-sync-policy:v${p.v}`, scope, p.rootId, p.epoch,
    p.parentPolicyId, p.ownerId, p.publisherId, p.name, p.allowDeletes, p.baseHeads.map(h => [h.entryId, h.revisionId]), p.pub,
    ...(p.v >= 2 ? [p.writers] : []), ...(p.v >= 4 ? [p.checkpoint ? [p.checkpoint.generation, p.checkpoint.parentCheckpointId,
      p.checkpoint.archiveDigest, p.checkpoint.archiveRecords, p.checkpoint.anchors.map(r => [r.revisionId, r.sig]), p.checkpoint.origins.map(o => [o.entryId, o.path])] : null] : [])]));
}
export function syncRevisionCanonical(scope: string, r: Omit<SyncRevision, 'revisionId' | 'sig'>): Uint8Array {
  const b = r.blob;
  return new TextEncoder().encode(JSON.stringify([`havvn-file-sync-revision:v${r.v}`, scope, r.rootId, r.policyId,
    r.entryId, r.parents, r.relativePath, r.op, b ? [b.infoHash, b.name, b.size, b.enc, b.keyEpoch] : null,
    r.authorId, r.createdAt, r.pub, ...(r.v >= 3 ? [r.previousPaths ?? []] : [])]));
}

export function copySyncPolicy(p: SyncPolicy): SyncPolicy {
  return { v: p.v, ...(p.v >= 2 ? { writers: [...p.writers!] } : {}), rootId: p.rootId, policyId: p.policyId, epoch: p.epoch, parentPolicyId: p.parentPolicyId,
    ownerId: p.ownerId, publisherId: p.publisherId, name: p.name, allowDeletes: p.allowDeletes,
    baseHeads: p.baseHeads.map(h => ({ entryId: h.entryId, revisionId: h.revisionId })), pub: p.pub, sig: p.sig,
    ...(p.checkpoint ? { checkpoint: { generation: p.checkpoint.generation, parentCheckpointId: p.checkpoint.parentCheckpointId,
      archiveDigest: p.checkpoint.archiveDigest, archiveRecords: p.checkpoint.archiveRecords, anchors: p.checkpoint.anchors.map(copySyncRevision), origins: p.checkpoint.origins.map(o => ({ entryId: o.entryId, path: o.path })) } } : {}) };
}
export function copySyncRevision(r: SyncRevision): SyncRevision {
  return { v: r.v, rootId: r.rootId, revisionId: r.revisionId, policyId: r.policyId, entryId: r.entryId,
    parents: [...r.parents], relativePath: r.relativePath, ...(r.previousPaths ? { previousPaths: [...r.previousPaths] } : {}), op: r.op, blob: r.blob ? {
      infoHash: r.blob.infoHash, name: r.blob.name, size: r.blob.size, enc: r.blob.enc, keyEpoch: r.blob.keyEpoch,
    } : null, authorId: r.authorId, createdAt: r.createdAt, pub: r.pub, sig: r.sig };
}

export class FileSyncIndex {
  private policies = new Map<string, SyncPolicy>();
  private revisions = new Map<string, SyncRevision>();
  private currentHeads = new Map<string, Set<string>>();
  private active: SyncPolicy | null = null;
  private floor: SyncPolicy | null = null;
  readonly context: Readonly<SyncIndexContext>;

  constructor(context: SyncIndexContext, private readonly verify: SyncProofVerifier) {
    if (!text(context.scope, 128) || !matches(context.rootId, SYNC_UUID) || !matches(context.ownerId, MEMBER)
      || typeof context.e2e !== 'boolean') throw new SyncIndexError('invalid', 'Invalid sync index context');
    this.context = Object.freeze({ ...context });
  }

  clone(): FileSyncIndex {
    const next = new FileSyncIndex(this.context, this.verify);
    // Retained objects never escape without a copy and are never modified in place.
    next.policies = new Map(this.policies); next.revisions = new Map(this.revisions); next.active = this.active;
    next.floor = this.floor;
    next.currentHeads = new Map([...this.currentHeads].map(([entry, heads]) => [entry, new Set(heads)]));
    return next;
  }
  policy(): SyncPolicy | null { return this.active ? copySyncPolicy(this.active) : null; }
  checkpoint(): SyncPolicy | null { return this.floor ? copySyncPolicy(this.floor) : null; }
  revision(id: string): SyncRevision | undefined { const r = this.revisions.get(id); return r && copySyncRevision(r); }
  includesApplied(entryId: string, revisionId: string): boolean {
    const pending = [...(this.currentHeads.get(entryId) ?? [])], seen = new Set<string>();
    while (pending.length) { const id = pending.pop()!; if (id === revisionId) return true;
      if (!seen.has(id)) { seen.add(id); pending.push(...(this.revisions.get(id)?.parents ?? [])); }
    }
    return false;
  }
  heads(): Array<{ entryId: string; revisionIds: string[] }> {
    return [...this.currentHeads].map(([entryId, ids]) => ({ entryId, revisionIds: [...ids].sort() }))
      .sort((a, b) => a.entryId < b.entryId ? -1 : 1);
  }
  pathConflicts(): Array<{ path: string; entryIds: string[] }> {
    const paths = new Map<string, Set<string>>();
    for (const [entryId, heads] of this.currentHeads) for (const id of heads) {
      const revision = this.revisions.get(id)!;
      if (revision.op === 'delete') continue;
      const key = revision.relativePath.normalize('NFC').toLowerCase();
      const entries = paths.get(key) ?? new Set<string>(); entries.add(entryId); paths.set(key, entries);
    }
    const collisions = new Map<string, Set<string>>();
    for (const key of paths.keys()) {
      const entries = paths.get(key)!;
      if (entries.size > 1) collisions.set(key, new Set(entries));
      const parts = key.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/');
        if (!paths.has(parent)) continue;
        const combined = new Set([...paths.get(parent)!, ...entries]);
        if (combined.size < 2) continue;
        for (const p of [parent, key]) collisions.set(p, new Set([...(collisions.get(p) ?? []), ...combined]));
      }
    }
    return [...collisions].map(([key, entries]) => ({ path: key, entryIds: [...entries].sort() }))
      .sort((a, b) => a.path < b.path ? -1 : 1);
  }

  acceptPolicy(value: unknown): 'accepted' | 'duplicate' {
    if (!validSyncPolicy(value) || value.rootId !== this.context.rootId) throw new SyncIndexError('invalid', 'Invalid sync policy');
    const p = copySyncPolicy(value);
    if (p.ownerId !== this.context.ownerId || !this.verify(p.ownerId, p.pub, p.sig,
      syncPolicyCanonical(this.context.scope, p), p.policyId)) throw new SyncIndexError('authority', 'Invalid sync policy proof');
    if (this.policies.has(p.policyId)) return 'duplicate';
    if (this.active && p.v < this.active.v) throw new SyncIndexError('policy-chain', 'A sync root cannot downgrade its protocol');
    if (p.checkpoint) {
      const cp = p.checkpoint, previous = this.floor;
      if (this.active && (p.epoch <= this.active.epoch || p.epoch === this.active.epoch + 1 && p.parentPolicyId !== this.active.policyId) || previous && (cp.generation <= previous.checkpoint!.generation
        || cp.generation === previous.checkpoint!.generation + 1 && cp.parentCheckpointId !== previous.policyId)
        || !previous && cp.generation === 1 && cp.parentCheckpointId !== null) throw new SyncIndexError('policy-chain', 'Stale or forked sync checkpoint');
      for (const r of cp.anchors) {
        if (r.rootId !== this.context.rootId || r.blob && r.blob.enc !== this.context.e2e
          || !this.verify(r.authorId, r.pub, r.sig, syncRevisionCanonical(this.context.scope, r), r.revisionId)) throw new SyncIndexError('authority', 'Invalid checkpoint anchor proof');
      }
      this.policies = new Map([[p.policyId, p]]); this.revisions = new Map(cp.anchors.map(r => [r.revisionId, r]));
      this.active = p; this.floor = p; this.currentHeads = new Map();
      for (const h of p.baseHeads) { const ids = this.currentHeads.get(h.entryId) ?? new Set<string>(); ids.add(h.revisionId); this.currentHeads.set(h.entryId, ids); }
      return 'accepted';
    }
    if (this.policies.size >= SYNC_POLICY_LIMIT) throw new SyncIndexError('limit', 'Sync policy history is full');
    if (p.epoch !== (this.active?.epoch ?? 0) + 1 || p.parentPolicyId !== (this.active?.policyId ?? null)) {
      throw new SyncIndexError('policy-chain', 'Missing or stale sync policy predecessor');
    }
    if (this.active && p.v < this.active.v) throw new SyncIndexError('policy-chain', 'A sync root cannot downgrade its protocol');
    if (p.v === 1 && p.baseHeads.length !== this.currentHeads.size) throw new SyncIndexError('missing-parent', 'Incomplete sync policy baseline');
    for (const h of p.baseHeads) {
      const revision = this.revisions.get(h.revisionId);
      if (!revision || revision.entryId !== h.entryId) throw new SyncIndexError('missing-parent', 'Unknown sync policy baseline');
      const baseline = this.active?.baseHeads.some(b => b.entryId === h.entryId && b.revisionId === revision.revisionId);
      if (this.active && revision.policyId !== this.active.policyId && !baseline) {
        throw new SyncIndexError('parent', 'Sync policy baseline predates the active policy');
      }
    }
    this.policies.set(p.policyId, p); this.active = p;
    this.currentHeads = new Map();
    for (const head of p.baseHeads) { const ids = this.currentHeads.get(head.entryId) ?? new Set<string>(); ids.add(head.revisionId); this.currentHeads.set(head.entryId, ids); }
    return 'accepted';
  }

  acceptRevision(value: unknown): 'accepted' | 'duplicate' {
    if (!validSyncRevision(value) || value.rootId !== this.context.rootId) throw new SyncIndexError('invalid', 'Invalid sync revision');
    const r = copySyncRevision(value);
    if (!this.verify(r.authorId, r.pub, r.sig, syncRevisionCanonical(this.context.scope, r), r.revisionId)) {
      throw new SyncIndexError('authority', 'Invalid sync revision proof');
    }
    if (this.revisions.has(r.revisionId)) return 'duplicate';
    const policy = this.policies.get(r.policyId), historical = r.policyId !== this.active?.policyId;
    if (!this.active || !policy || historical && this.active.v < 2) throw new SyncIndexError('stale-policy', 'Sync revision uses an inactive policy');
    if (r.v !== policy.v || !canWriteSync(policy, r.authorId) || r.op === 'delete' && !policy.allowDeletes
      || r.blob && r.blob.enc !== this.context.e2e) throw new SyncIndexError('authority', 'Sync publisher or content mode is not authorized');
    if (this.revisions.size >= SYNC_REVISION_LIMIT || !historical && !this.currentHeads.has(r.entryId) && this.currentHeads.size >= SYNC_ROOT_FILE_LIMIT) {
      throw new SyncIndexError('limit', 'Sync revision index is full');
    }
    if (!historical && this.currentHeads.has(r.entryId) && !r.parents.length) throw new SyncIndexError('parent', 'An existing sync entry requires a parent');
    for (const id of r.parents) {
      const parent = this.revisions.get(id);
      if (!parent) throw new SyncIndexError('missing-parent', 'Unknown sync revision parent');
      if (parent.entryId !== r.entryId || parent.relativePath !== r.relativePath && !(r.v >= 3 && r.previousPaths?.includes(parent.relativePath))
        || parent.policyId !== policy.policyId && !policy.baseHeads.some(h => h.entryId === r.entryId && h.revisionId === id)) throw new SyncIndexError('parent', 'Incompatible sync revision parent');
    }
    if (r.previousPaths?.some(p => !r.parents.some(id => this.revisions.get(id)?.relativePath === p))) throw new SyncIndexError('parent', 'Move source is not a parent path');
    // Old-epoch content remains verifiable history, never active disk authority. An owner checkpoint
    // defines the new epoch's heads independent of arrival order or revoked writers' timestamps.
    if (historical) { this.revisions.set(r.revisionId, r); return 'accepted'; }
    const heads = new Set(this.currentHeads.get(r.entryId));
    r.parents.forEach(id => heads.delete(id)); heads.add(r.revisionId);
    this.revisions.set(r.revisionId, r); this.currentHeads.set(r.entryId, heads);
    return 'accepted';
  }
}
