import crypto from 'node:crypto';
import { SYNC_RECORD_BYTES, SYNC_RECORD_PART_BYTES, validSyncWireBody, syncHistoryBody, type SyncHistoryWireBody } from '../../shared/room-file-sync-protocol';
import type { SyncPolicy } from '../../shared/room-file-sync';
import type { SyncLogPack } from '../db/room-sync-log-pack';

interface Options {
  current(): boolean;
  send(to: string, body: SyncHistoryWireBody): Promise<void>;
  export(rootId: string, digest: string): SyncLogPack | undefined;
  accept(rootId: string, checkpointId: string, pack: SyncLogPack): number;
  peers?(): string[];
  timeoutMs?: number;
}
interface Pending {
  rootId: string; streamId: string; checkpointId: string; archiveDigest: string;
  peers: string[] | null; missing: Set<string>; peer?: string; digest?: string; bytes?: number;
  next: number; chunks: Buffer[]; accepting: boolean; progressAt: number;
  resolve(value: number | null): void; reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>; retry: ReturnType<typeof setInterval>;
}
/** Requested read-only metadata. It never feeds the active index or grants disk consent. */
export class RoomSyncHistoryExchange {
  private pending?: Pending;
  private cache?: { rootId: string; archiveDigest: string; bytes: Buffer; digest: string };
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  constructor(private readonly options: Options) {}
  private check(): void { if (this.stopped || !this.options.current()) throw new Error('History exchange stopped'); }
  private finish(error?: Error, value: number | null = null): void {
    const p = this.pending; if (!p) return;
    this.pending = undefined; clearTimeout(p.timeout); clearInterval(p.retry);
    p.chunks = []; if (error) p.reject(error); else p.resolve(value);
  }
  close(): void { this.stopped = true; this.cache = undefined; this.finish(new Error('History exchange stopped')); }
  private async send(to: string, body: SyncHistoryWireBody): Promise<void> { this.check(); await this.options.send(to, body); this.check(); }
  private async request(p: Pending): Promise<void> {
    if (this.pending !== p || p.accepting) return;
    const peers = p.peer ? [p.peer] : p.peers?.filter(id => !p.missing.has(id)) ?? [''];
    if (!peers.length) { this.finish(undefined); return; }
    for (const peer of peers) {
      if (this.pending !== p) return;
      try { await this.send(peer, { kind: 'history-request', rootId: p.rootId, streamId: p.streamId, checkpointId: p.checkpointId, archiveDigest: p.archiveDigest, byteOffset: p.next }); }
      catch { this.check(); /* An unavailable destination must not prevent asking other providers. */ }
    }
  }
  fetch(checkpoint: SyncPolicy): Promise<number | null> {
    this.check(); if (!checkpoint.checkpoint) return Promise.reject(new Error('History checkpoint required'));
    if (this.pending) return Promise.reject(new Error('Another history download is in progress'));
    return new Promise((resolve, reject) => {
      const p: Pending = { rootId: checkpoint.rootId, streamId: crypto.randomBytes(32).toString('hex'), checkpointId: checkpoint.policyId,
        archiveDigest: checkpoint.checkpoint!.archiveDigest, peers: this.options.peers ? [...new Set(this.options.peers())].filter(id => /^[a-f0-9]{32}$/.test(id)).slice(0, 64) : null,
        missing: new Set(), next: 0, chunks: [], accepting: false, progressAt: Date.now(), resolve, reject,
        timeout: setTimeout(() => { if (this.pending === p) this.finish(undefined); }, this.options.timeoutMs ?? 20_000),
        retry: setInterval(() => {
          if (this.pending === p && !p.accepting && p.peer && Date.now() - p.progressAt >= 6000) {
            p.missing.add(p.peer); p.peer = undefined; p.digest = undefined; p.bytes = undefined; p.next = 0; p.chunks = [];
          }
          void this.request(p).catch(() => { /* Reconnect retries until the bounded deadline. */ });
        }, 2000) };
      p.timeout.unref?.(); p.retry.unref?.(); this.pending = p;
      void this.request(p).catch(() => { /* Transient channel failure keeps the same requested offset. */ });
    });
  }
  receive(from: string, body: unknown): Promise<void> {
    if (this.waiting >= 64) return Promise.reject(new Error('History exchange queue full'));
    this.waiting++;
    const run = this.queue.catch(() => {}).then(async () => {
      this.check(); if (!/^[a-f0-9]{32}$/.test(from) || !validSyncWireBody(body) || !syncHistoryBody(body)) throw new Error('Invalid history frame');
      if (body.kind === 'history-request') {
        let cached = this.cache;
        if (!cached || cached.rootId !== body.rootId || cached.archiveDigest !== body.archiveDigest) {
          const pack = this.options.export(body.rootId, body.archiveDigest), bytes = pack && Buffer.from(JSON.stringify(pack));
          if (!bytes || bytes.length > SYNC_RECORD_BYTES) {
            await this.send(from, { kind: 'history-missing', rootId: body.rootId, streamId: body.streamId, checkpointId: body.checkpointId, archiveDigest: body.archiveDigest }); return;
          }
          cached = { rootId: body.rootId, archiveDigest: body.archiveDigest, bytes, digest: crypto.createHash('sha256').update(bytes).digest('hex') }; this.cache = cached;
        }
        if (body.byteOffset >= cached.bytes.length) return;
        await this.send(from, { kind: 'history-part', rootId: body.rootId, streamId: body.streamId, checkpointId: body.checkpointId, archiveDigest: body.archiveDigest,
          digest: cached.digest, bytes: cached.bytes.length, byteOffset: body.byteOffset,
          data: cached.bytes.subarray(body.byteOffset, body.byteOffset + SYNC_RECORD_PART_BYTES).toString('base64') }); return;
      }
      const p = this.pending;
      if (!p || p.accepting || body.streamId !== p.streamId || body.rootId !== p.rootId || body.checkpointId !== p.checkpointId || body.archiveDigest !== p.archiveDigest
        || p.peers && !p.peers.includes(from) || p.missing.has(from)) return;
      if (body.kind === 'history-missing') {
        p.missing.add(from);
        if (p.peer === from) { p.peer = undefined; p.digest = undefined; p.bytes = undefined; p.next = 0; p.chunks = []; }
        if (!p.peer && p.peers) await this.request(p); return;
      }
      if (p.peer && p.peer !== from) return;
      try {
        const bytes = Buffer.from(body.data, 'base64');
        if (bytes.toString('base64') !== body.data || bytes.length !== Math.min(SYNC_RECORD_PART_BYTES, body.bytes - body.byteOffset)) throw new Error('Invalid history part encoding');
        if (!p.peer) {
          if (body.byteOffset !== 0) return;
          p.peer = from; p.digest = body.digest; p.bytes = body.bytes;
        }
        if (p.digest !== body.digest || p.bytes !== body.bytes) throw new Error('History multipart identity changed');
        if (body.byteOffset !== p.next) { await this.request(p); return; }
        p.chunks.push(bytes); p.next += bytes.length; p.progressAt = Date.now();
        if (p.next < body.bytes) { await this.request(p); return; }
        p.accepting = true; const complete = Buffer.concat(p.chunks, body.bytes);
        if (crypto.createHash('sha256').update(complete).digest('hex') !== p.digest) throw new Error('History multipart digest mismatch');
        const pack = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(complete)) as SyncLogPack;
        this.check(); const imported = this.options.accept(p.rootId, p.checkpointId, pack); this.check(); this.finish(undefined, imported);
      } catch (error) { this.finish(error instanceof Error ? error : new Error(String(error))); throw error; }
    });
    this.queue = run; return run.finally(() => { this.waiting--; });
  }
}
