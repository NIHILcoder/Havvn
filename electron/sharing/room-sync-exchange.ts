import crypto from 'node:crypto';
import { SYNC_PAGE_BYTES, SYNC_PAGE_RECORDS, copySyncRecord, syncRecordId, validSyncWireBody,
  SYNC_RECORD_BYTES, SYNC_RECORD_PART_BYTES, SYNC_RECORD_STAGING_BYTES, syncHistoryBody, type SyncWireBody } from '../../shared/room-file-sync-protocol';
import { validSyncPolicy, validSyncRevision, type SyncRecord } from '../../shared/room-file-sync';

interface ExchangeOptions {
  roots(): string[];
  records(rootId: string): SyncRecord[] | undefined;
  accept(rootId: string, records: SyncRecord[], from: string, streamId: string): Promise<void>;
  acknowledge(rootId: string, ids: string[]): void;
  send(to: string, body: SyncWireBody): Promise<void>;
  current(): boolean;
}
const LIMIT = 64;
const PART_TTL = 5 * 60_000;
interface StagedRecord { offset: number; recordId: string; digest: string; bytes: number; next: number; chunks: Buffer[]; expires: number }
interface Incoming { streamId: string; total: number; next: number; requestedAt: number; progressedAt: number; hash?: crypto.Hash; part?: StagedRecord }
interface Snapshot { streamId: string; records: SyncRecord[]; large?: { offset: number; bytes: Buffer; digest: string } }
/** Same signed set, same stream, regardless of concurrent branches' arrival order.
 * Epoch priority keeps legacy records before the next policy; dependencies keep each page replayable. */
export function canonicalSyncRecords(records: SyncRecord[]): SyncRecord[] {
  const nodes = new Map(records.map(r => [syncRecordId(r), r]));
  if (nodes.size !== records.length) throw new Error('Duplicate sync exchange record');
  const epochs = new Map(records.filter(r => r.kind === 'policy').map(r => [r.value.policyId, r.value.epoch]));
  const anchors = new Map(records.flatMap(r => r.kind === 'policy' && r.value.checkpoint ? r.value.checkpoint.anchors.map(a => [a.revisionId, r.value.policyId] as const) : []));
  const pending = new Map<string, number>(), children = new Map<string, string[]>(), heap: string[] = [];
  const rank = (id: string) => { const r = nodes.get(id)!; return r.kind === 'policy' ? r.value.epoch * 2 : (epochs.get(r.value.policyId) ?? Infinity) * 2 + 1; };
  const before = (a: string, b: string) => rank(a) < rank(b) || rank(a) === rank(b) && a < b;
  const push = (id: string) => {
    let i = heap.length; heap.push(id);
    while (i > 0) { const p = (i - 1) >> 1; if (!before(id, heap[p])) break; heap[i] = heap[p]; i = p; } heap[i] = id;
  };
  const pop = () => {
    const first = heap[0], last = heap.pop()!;
    if (heap.length) { let i = 0; while (2 * i + 1 < heap.length) {
      let child = 2 * i + 1; if (child + 1 < heap.length && before(heap[child + 1], heap[child])) child++;
      if (!before(heap[child], last)) break; heap[i] = heap[child]; i = child;
    } heap[i] = last; } return first;
  };
  for (const [id, r] of nodes) {
    const raw = r.kind === 'policy' ? r.value.checkpoint ? [] : [...(r.value.parentPolicyId ? [r.value.parentPolicyId] : []), ...r.value.baseHeads.map(h => h.revisionId)] : [r.value.policyId, ...r.value.parents];
    const deps = new Set(raw.map(dep => nodes.has(dep) ? dep : anchors.get(dep) ?? dep));
    pending.set(id, deps.size);
    for (const dep of deps) { if (!nodes.has(dep)) throw new Error('Missing sync exchange dependency'); const list = children.get(dep) ?? []; list.push(id); children.set(dep, list); }
    if (!deps.size) push(id);
  }
  const sorted: SyncRecord[] = [];
  while (heap.length) { const id = pop(); sorted.push(nodes.get(id)!);
    for (const child of children.get(id) ?? []) { const count = pending.get(child)! - 1; pending.set(child, count); if (!count) push(child); }
  }
  if (sorted.length !== records.length) throw new Error('Cyclic sync exchange log');
  return sorted;
}
const hashRecords = (records: SyncRecord[]) => {
  const hash = crypto.createHash('sha256'); records.forEach(r => hash.update(syncRecordId(r) + '\n')); return hash.digest('hex');
};

/** Metadata only: ACK means durable index, never an assertion that file bytes exist. */
export class RoomSyncExchange {
  private snapshots = new Map<string, Snapshot>();
  private incoming = new Map<string, Incoming>();
  private outgoing = new Map<string, { streamId: string; end: number; ids: string[] }>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private waiting = 0;
  private retryTimer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: ExchangeOptions) {}
  close(): void { this.stopped = true; clearInterval(this.retryTimer); this.snapshots.clear(); this.incoming.clear(); this.outgoing.clear(); }
  private async retryPending(): Promise<void> {
    if (this.stopped || !this.options.current()) return;
    const now = Date.now(); let active = false;
    for (const [key, state] of this.incoming) {
      if (state.next >= state.total || now - state.progressedAt > PART_TTL) continue;
      active = true;
      if (now - state.requestedAt < 2000) continue;
      const separator = key.indexOf(':');
      try { await this.requestNext(key.slice(0, separator), key.slice(separator + 1), state); } catch { /* Other peers may still be available. */ }
    }
    if (!active) { clearInterval(this.retryTimer); this.retryTimer = undefined; }
  }
  private check(): void { if (this.stopped || !this.options.current()) throw new Error('Sync exchange stopped'); }
  private async send(to: string, body: SyncWireBody): Promise<void> { this.check(); await this.options.send(to, body); this.check(); }
  private snapshot(rootId: string) {
    const raw = this.options.records(rootId);
    if (!raw?.length) return undefined;
    const records = canonicalSyncRecords(raw);
    const streamId = hashRecords(records), previous = this.snapshots.get(rootId);
    if (previous?.streamId === streamId) return previous;
    const snapshot: Snapshot = { streamId, records: records.map(copySyncRecord) }; this.snapshots.set(rootId, snapshot); return snapshot;
  }
  private pruneParts(): void {
    for (const state of this.incoming.values()) if (state.part && state.part.expires <= Date.now()) state.part = undefined;
  }
  private async requestNext(from: string, rootId: string, state: Incoming): Promise<void> {
    if (state.next >= state.total) return;
    if (!this.retryTimer) {
      this.retryTimer = setInterval(() => { void this.retryPending().catch(() => {}); }, 2000);
      this.retryTimer.unref?.();
    }
    state.requestedAt = Date.now();
    const part = state.part;
    await this.send(from, part ? { kind: 'part-request', rootId, streamId: state.streamId, offset: state.next, byteOffset: part.next, digest: part.digest }
      : { kind: 'request', rootId, streamId: state.streamId, offset: state.next });
  }
  private async sendPart(to: string, rootId: string, snapshot: Snapshot, offset: number, byteOffset: number, digest?: string): Promise<void> {
    const record = snapshot.records[offset];
    if (!record || record.value.v < 5) throw new Error('Multipart records require sync v5');
    let large = snapshot.large;
    if (!large || large.offset !== offset) {
      const bytes = Buffer.from(JSON.stringify(record));
      if (bytes.length > SYNC_RECORD_BYTES) throw new Error('Sync record exceeds multipart capacity');
      large = { offset, bytes, digest: crypto.createHash('sha256').update(bytes).digest('hex') }; snapshot.large = large;
    }
    if (byteOffset >= large.bytes.length || digest !== undefined && digest !== large.digest) return;
    const key = to + ':' + rootId;
    if (!this.outgoing.has(key) && this.outgoing.size >= LIMIT) this.outgoing.delete(this.outgoing.keys().next().value!);
    this.outgoing.set(key, { streamId: snapshot.streamId, end: offset + 1, ids: [syncRecordId(record)] });
    await this.send(to, { kind: 'record-part', rootId, streamId: snapshot.streamId, offset, total: snapshot.records.length,
      recordId: syncRecordId(record), digest: large.digest, bytes: large.bytes.length, byteOffset,
      data: large.bytes.subarray(byteOffset, byteOffset + SYNC_RECORD_PART_BYTES).toString('base64') });
  }
  private async persist(from: string, rootId: string, state: Incoming, records: SyncRecord[]): Promise<void> {
    const hash = state.hash!.copy(); records.forEach(record => hash.update(syncRecordId(record) + '\n'));
    const next = state.next + records.length;
    if (next === state.total && hash.copy().digest('hex') !== state.streamId) throw new Error('Sync stream digest mismatch');
    // The staged record has no authority until its complete proof and atomic write succeed.
    await this.options.accept(rootId, records, from, state.streamId); this.check();
    state.hash = next === state.total ? undefined : hash; state.next = next; state.part = undefined; state.progressedAt = Date.now();
    await this.send(from, { kind: 'ack', rootId, streamId: state.streamId, next });
    await this.requestNext(from, rootId, state);
  }
  async offer(to = '', rootId?: string): Promise<void> {
    this.check();
    for (const root of rootId ? [rootId] : this.options.roots()) {
      const snapshot = this.snapshot(root); if (!snapshot) continue;
      await this.send(to, { kind: 'offer', rootId: root, streamId: snapshot.streamId, total: snapshot.records.length });
    }
  }
  receive(from: string, body: unknown): Promise<void> {
    if (this.waiting >= 128) return Promise.reject(new Error('Sync exchange queue full'));
    this.waiting++;
    const run = this.queue.catch(() => {}).then(async () => {
      this.check(); if (!/^[a-f0-9]{32}$/.test(from) || !validSyncWireBody(body)) throw new Error('Invalid sync wire body');
      if (body.kind === 'blob-request' || body.kind === 'blob-metadata' || syncHistoryBody(body)) throw new Error('Auxiliary metadata is handled by the room coordinator');
      this.pruneParts(); const b = body, key = from + ':' + b.rootId;
      if (b.kind === 'offer') {
        let state = this.incoming.get(key);
        if (!state || state.streamId !== b.streamId || state.total !== b.total) {
          if (!state && this.incoming.size >= LIMIT) this.incoming.delete(this.incoming.keys().next().value!);
          state = { streamId: b.streamId, total: b.total, next: 0, requestedAt: 0, progressedAt: Date.now(), hash: crypto.createHash('sha256') }; this.incoming.set(key, state);
        }
        if (state.next < state.total) await this.requestNext(from, b.rootId, state);
        else await this.send(from, { kind: 'ack', rootId: b.rootId, streamId: b.streamId, next: state.next });
      } else if (b.kind === 'request' || b.kind === 'part-request') {
        const snapshot = this.snapshot(b.rootId);
        if (!snapshot) return;
        if (snapshot.streamId !== b.streamId) { await this.offer(from, b.rootId); return; }
        if (b.offset >= snapshot.records.length) return;
        if (b.kind === 'part-request') { await this.sendPart(from, b.rootId, snapshot, b.offset, b.byteOffset, b.digest); return; }
        const records: SyncRecord[] = [];
        for (const record of snapshot.records.slice(b.offset, b.offset + SYNC_PAGE_RECORDS)) {
          const candidate = [...records, record];
          const page = { kind: 'page' as const, rootId: b.rootId, streamId: b.streamId, offset: b.offset, total: snapshot.records.length, records: candidate };
          if (Buffer.byteLength(JSON.stringify(page)) > SYNC_PAGE_BYTES) break;
          records.push(record);
        }
        if (!records.length) { await this.sendPart(from, b.rootId, snapshot, b.offset, 0); return; }
        if (!this.outgoing.has(key) && this.outgoing.size >= LIMIT) this.outgoing.delete(this.outgoing.keys().next().value!);
        this.outgoing.set(key, { streamId: b.streamId, end: b.offset + records.length, ids: records.map(syncRecordId) });
        await this.send(from, { kind: 'page', rootId: b.rootId, streamId: b.streamId, offset: b.offset, total: snapshot.records.length, records });
      } else if (b.kind === 'record-part') {
        const state = this.incoming.get(key);
        if (!state || state.streamId !== b.streamId || state.total !== b.total) return;
        if (b.offset !== state.next) {
          if (b.offset < state.next) await this.send(from, { kind: 'ack', rootId: b.rootId, streamId: b.streamId, next: state.next });
          return;
        }
        const bytes = Buffer.from(b.data, 'base64');
        if (bytes.toString('base64') !== b.data || bytes.length !== Math.min(SYNC_RECORD_PART_BYTES, b.bytes - b.byteOffset)) throw new Error('Invalid sync part encoding');
        let part = state.part;
        if (!part) {
          if (b.byteOffset !== 0) { await this.requestNext(from, b.rootId, state); return; }
          part = { offset: b.offset, recordId: b.recordId, digest: b.digest, bytes: b.bytes, next: 0, chunks: [], expires: Date.now() + PART_TTL };
          state.part = part;
        }
        if (part.recordId !== b.recordId || part.digest !== b.digest || part.bytes !== b.bytes) {
          state.part = undefined; throw new Error('Sync multipart identity changed');
        }
        if (b.byteOffset !== part.next) { await this.requestNext(from, b.rootId, state); return; }
        const staged = [...this.incoming.values()].reduce((n, incoming) => n + (incoming.part?.next ?? 0), 0);
        if (staged + bytes.length > SYNC_RECORD_STAGING_BYTES) { state.part = undefined; throw new Error('Sync multipart staging capacity reached'); }
        part.chunks.push(bytes); part.next += bytes.length; part.expires = Date.now() + PART_TTL; state.progressedAt = Date.now();
        if (part.next < part.bytes) { await this.requestNext(from, b.rootId, state); return; }
        try {
          const complete = Buffer.concat(part.chunks, part.bytes);
          if (crypto.createHash('sha256').update(complete).digest('hex') !== part.digest) throw new Error('Sync multipart digest mismatch');
          const record: SyncRecord = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(complete));
          if (!record || !(record.kind === 'policy' && validSyncPolicy(record.value) || record.kind === 'revision' && validSyncRevision(record.value))
            || record.value.v < 5 || record.value.rootId !== b.rootId || syncRecordId(record) !== part.recordId) throw new Error('Invalid multipart sync record');
          await this.persist(from, b.rootId, state, [copySyncRecord(record)]);
        } catch (error) { state.part = undefined; throw error; }
      } else if (b.kind === 'page') {
        const state = this.incoming.get(key);
        if (!state || state.streamId !== b.streamId || state.total !== b.total) return;
        if (b.offset !== state.next) {
          if (b.offset < state.next) await this.send(from, { kind: 'ack', rootId: b.rootId, streamId: b.streamId, next: state.next });
          return;
        }
        await this.persist(from, b.rootId, state, b.records.map(copySyncRecord));
      } else {
        const sent = this.outgoing.get(key);
        const snapshot = this.snapshots.get(b.rootId);
        if (!snapshot || snapshot.streamId !== b.streamId || b.next > snapshot.records.length
          || b.next !== snapshot.records.length && (!sent || sent.streamId !== b.streamId || sent.end !== b.next)) return;
        this.options.acknowledge(b.rootId, snapshot.records.slice(0, b.next).map(syncRecordId)); this.outgoing.delete(key);
      }
    });
    this.queue = run; return run.finally(() => { this.waiting--; });
  }
}
