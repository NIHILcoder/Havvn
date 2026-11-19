import crypto from 'node:crypto';
import { DOCUMENT_LIMIT, DOCUMENT_PENDING_LIMIT, DOCUMENT_PART_BYTES, DOCUMENT_RECORD_BYTES, DOCUMENT_STATE_BYTES, DOCUMENT_UUID, documentBase64,
  validDocumentText, validDocumentTitle, validDocumentPresence, validDocumentWireBody, type DocumentProposal, type DocumentCommit,
  type DocumentCheckpoint, type DocumentRecord, type DocumentWireBody, type DocumentPresence, type DocumentCursor, type DocumentSummary, type DocumentsView,
  type DocumentOpenView, type DocumentMemberView, type DocumentLocalSnapshot, type DocumentHead } from '../../shared/room-documents';
import type { DocumentsPersistence, StoredDocument, DocumentRecoverySource } from '../db/room-documents-store';
import { DOCUMENT_STORE_BYTES, documentContextScope } from '../db/room-documents-store';
import { deriveMemberId } from './room-crypto';
import { verifyDocumentProposal, verifyDocumentRecord, signDocumentPolicy, signDocumentProposal, signDocumentRecord,
  cleanDocumentProposal, cleanDocumentRecord } from './room-document-proofs';
import type { DocumentValidation, MaterializedDocument } from './room-document-model';
import { validateDocumentInWorker, DocumentValidationUnavailableError } from './room-document-validator';
import type { DocumentAccessRequest, DocumentAccessView } from '../../shared/room-documents';

export interface RoomDocumentsOptions {
  scope: string; ownerId: string; identity: { pub: string; priv: string }; persistence: DocumentsPersistence;
  current(): boolean; members(): DocumentMemberView[]; send(to: string, body: DocumentWireBody): Promise<void>;
  validate?(input: DocumentValidation): Promise<MaterializedDocument>; warn?(error: unknown): void;
  recoverySources?: DocumentRecoverySource[]; banned?(): string[];
  sessions?: Array<{ token: string; documentId: string; expires: number; clock: number; version: number }>;
}
const zeros = '0'.repeat(64), colors = ['#58c7f3', '#a98bff', '#f7b955', '#62d6ac', '#f58fba', '#f09566'];
const seq = (d: StoredDocument) => d.commits.at(-1)?.seq ?? d.checkpoint.seq;
const head = (d: StoredDocument) => d.commits.at(-1)?.id ?? d.checkpoint.head;
const policy = (d: StoredDocument) => d.checkpoint.policy;
const idOf = (r: DocumentRecord) => r.kind === 'checkpoint' ? r.policy.documentId : r.documentId;
const snapshotLimit = (snapshots: DocumentLocalSnapshot[]) => {
  const result = [...snapshots].slice(-20); while (result.length > 1 && Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) result.shift(); return result;
};

/** Owner-signed commits establish admission order; clients retain their optimistic CRDT updates offline. */
export class RoomDocuments {
  private accessInbox = new Map<string, DocumentAccessRequest>();
  private accessOwn = new Map<string, DocumentAccessRequest & { status: 'sent' | 'received' | 'declined' }>();
  private accessRate = new Map<string, number>();
  private accessSeen = new Map<string, number>();
  readonly selfId: string;
  private docs = new Map<string, StoredDocument>();
  private versions = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private ready: Promise<void>;
  private stopped = false;
  private failed?: string;
  private loadingError?: DocumentValidationUnavailableError;
  private loadRetries = 0;
  private retryAt = 0;
  private lastWarning?: string;
  private tokens = new Map<string, { documentId: string; expires: number; clock: number }>();
  private cursors = new Map<string, { memberId: string; presence: DocumentPresence; until: number }>();
  private staging = new Map<string, { from: string; documentId: string; digest: string; bytes: number; buffer: Buffer; received: Set<number>; count: number; until: number }>();
  private sentAt = new Map<string, number>();
  private requests = new Map<string, number>();
  private networkBusy = false;
  private handoff?: { nonce: string; to: string; items: DocumentHead[]; ready(): void; reject(error: Error): void };
  private handoffRequest?: { nonce: string; items: DocumentHead[]; at: number };
  private timer: ReturnType<typeof setInterval>;
  private validate: (input: DocumentValidation) => Promise<MaterializedDocument>;
  constructor(private readonly options: RoomDocumentsOptions) {
    this.selfId = deriveMemberId(options.identity.pub); this.validate = options.validate ?? validateDocumentInWorker;
    for (const session of options.sessions ?? []) if (session.expires > Date.now()) {
      this.tokens.set(session.token, { documentId: session.documentId, expires: session.expires, clock: session.clock });
      this.versions.set(session.documentId, session.version + 1);
    }
    this.ready = this.startLoad();
    this.timer = setInterval(() => this.wake(), 2000); this.timer.unref?.();
  }
  current(): boolean { return !this.stopped && this.options.current(); }
  sessions(): NonNullable<RoomDocumentsOptions['sessions']> { return [...this.tokens].map(([token, session]) => ({ token, ...session, version: this.versions.get(session.documentId) ?? 0 })); }
  close(): void { this.stopped = true; clearInterval(this.timer); this.handoff?.reject(new Error('Documents context changed during handoff')); this.handoff = undefined; this.tokens.clear(); this.cursors.clear(); this.staging.clear(); }
  async idle(): Promise<void> { await this.ready; await this.queue.catch(() => {}); }
  private report(error: unknown): void {
    if (!this.current()) return;
    const key = String(error); if (key === this.lastWarning) return;
    this.lastWarning = key; this.options.warn?.(error);
  }
  private startLoad(): Promise<void> {
    return Promise.resolve().then(async () => {
      // Until the complete protected catalog is verified, no editor or mutation
      // can use this session. A startup retry reloads only this unexposed state.
      this.loadingError = undefined; this.docs.clear(); await this.load();
      this.loadingError = undefined; this.loadRetries = 0; this.retryAt = 0; this.lastWarning = undefined;
    }).catch(error => {
      if (error instanceof DocumentValidationUnavailableError) {
        this.loadingError = error; this.loadRetries = Math.min(this.loadRetries + 1, 7);
        this.retryAt = Date.now() + Math.min(60000, 1000 * 2 ** (this.loadRetries - 1));
      } else this.failed = String(error);
      this.report(error);
    });
  }
  private check(): void { if (!this.current()) throw new Error('Documents session stopped'); if (this.failed) throw new Error('Protected documents unavailable; restart after restoring storage access'); if (this.loadingError) throw this.loadingError; }
  private run<T>(action: () => Promise<T>): Promise<T> {
    if (this.queued >= 128) return Promise.reject(new Error('Document queue is busy'));
    this.queued++;
    const job = this.queue.catch(() => {}).then(async () => {
      await this.ready;
      if (this.loadingError && !this.failed && this.current() && Date.now() >= this.retryAt) { this.ready = this.startLoad(); await this.ready; }
      this.check(); return action();
    }).finally(() => { this.queued--; });
    this.queue = job; return job;
  }
  private async load(): Promise<void> {
    const ids = this.options.persistence.list(); if (ids.length > DOCUMENT_LIMIT || new Set(ids).size !== ids.length) throw new Error('Invalid document catalog');
    for (const id of ids) {
      const raw = this.options.persistence.read(id) as StoredDocument;
      const value = await this.verifyStored(id, raw, this.options.scope, this.options.ownerId);
      this.docs.set(id, value); if (!this.versions.has(id)) this.versions.set(id, 1);
    }
    // Newest locally observed context wins. Nothing from private drafts is sent over the wire.
    const seen = new Set<string>();
    for (const source of this.options.recoverySources ?? []) {
      const sourceIds = source.persistence.list(); if (sourceIds.length > DOCUMENT_LIMIT || new Set(sourceIds).size !== sourceIds.length) throw new Error('Invalid recovery document catalog');
      for (const id of sourceIds) {
        if (seen.has(id)) continue; seen.add(id);
        const existing = this.docs.get(id); if (existing?.migratedFrom === source.key) continue;
        const sourceScope = documentContextScope(source.context);
        const old = await this.verifyStored(id, source.persistence.read(id) as StoredDocument, sourceScope, source.context.ownerId);
        this.check();
        const next = existing ? structuredClone(existing) : structuredClone(old);
        if (!existing) {
          next.scope = this.options.scope; next.ownerId = this.options.ownerId; next.pending = [];
          next.draftReview = old.draftReview || old.pending.length > 0;
          next.recovery = old.recovery ?? { key: source.key, scope: sourceScope, ownerId: source.context.ownerId };
          if (this.selfId === this.options.ownerId) {
            let inherited = policy(old).writers.filter(id => id !== this.selfId && !this.options.banned?.().includes(id));
            // A full 32-writer document exchanges the previous owner's mandatory slot.
            if (inherited.length >= 32) inherited = inherited.filter(id => id !== policy(old).ownerId);
            const writers = [this.selfId, ...inherited].slice(0, 32).sort();
            const p = signDocumentPolicy(this.options.scope, { ...policy(old), epoch: policy(old).epoch + 1, previous: policy(old).id, ownerId: this.selfId, writers }, this.options.identity);
            next.checkpoint = signDocumentRecord<DocumentCheckpoint>(this.options.scope, { kind: 'checkpoint', policy: p, seq: seq(old), head: head(old), state: old.state, acks: [], at: Date.now() }, this.options.identity);
            next.commits = []; delete next.recovery;
          }
        } else {
          next.snapshots = snapshotLimit([...old.snapshots, ...next.snapshots].filter((s, index, all) => all.findIndex(item => item.id === s.id) === index).sort((a, b) => a.at - b.at));
          if ((old.draftReview || old.pending.length) && !next.pending.length && !next.draftReview) { next.working = old.working; next.text = old.text; next.draftReview = true; }
        }
        next.migratedFrom = source.key; this.save(next);
      }
    }
    this.maybeHandoffReady();
  }
  private async verifyStored(id: string, raw: StoredDocument, scope: string, ownerId: string): Promise<StoredDocument> {
      const recovery = raw?.recovery;
      if (recovery && !this.options.recoverySources?.some(s => s.key === recovery.key && documentContextScope(s.context) === recovery.scope && s.context.ownerId === recovery.ownerId)) throw new Error('Unknown document recovery source');
      const proofScope = recovery?.scope ?? scope, proofOwner = recovery?.ownerId ?? ownerId;
      if (!DOCUMENT_UUID.test(id) || !raw || raw.v !== 1 || raw.scope !== scope || raw.ownerId !== ownerId
        || Buffer.byteLength(JSON.stringify(raw)) > DOCUMENT_STORE_BYTES || !verifyDocumentRecord(proofScope, proofOwner, raw.checkpoint)
        || raw.checkpoint.kind !== 'checkpoint' || idOf(raw.checkpoint) !== id || !Array.isArray(raw.commits) || raw.commits.length > 256
        || !Array.isArray(raw.pending) || raw.pending.length > DOCUMENT_PENDING_LIMIT || !validDocumentText(raw.text)
        || !documentBase64(raw.working, DOCUMENT_STATE_BYTES) || !Array.isArray(raw.snapshots) || raw.snapshots.length > 20
        || raw.snapshots.some(s => !s || !DOCUMENT_UUID.test(s.id) || !validDocumentText(s.text) || typeof s.label !== 'string' || s.label.length > 120 || !Number.isSafeInteger(s.at))
        || raw.draftReview !== undefined && typeof raw.draftReview !== 'boolean' || recovery && raw.pending.length > 0
        || Buffer.byteLength(JSON.stringify(raw.snapshots)) > 2 * 1024 * 1024 + 2048) throw new Error('Invalid protected document');
      let next = raw.checkpoint.seq + 1, previous = raw.checkpoint.head;
      for (const commit of raw.commits) {
        if (!verifyDocumentRecord(proofScope, proofOwner, commit) || commit.kind !== 'change' || commit.documentId !== id
          || commit.policyId !== raw.checkpoint.policy.id || commit.seq !== next++ || commit.previous !== previous || !raw.checkpoint.policy.writers.includes(commit.proposal.authorId)) throw new Error('Invalid document commit chain');
        previous = commit.id;
      }
      if (new Set(raw.pending.map(p => p.proposal.id)).size !== raw.pending.length || raw.pending.some(p => !verifyDocumentProposal(scope, p.proposal)
        || p.proposal.documentId !== id || p.proposal.authorId !== this.selfId || p.rejected !== undefined && typeof p.rejected !== 'string')) throw new Error('Invalid local document draft');
      const verified = await this.validate({ state: raw.checkpoint.state, updates: raw.commits.map(c => c.proposal.data) });
      if (verified.state !== raw.state) throw new Error('Document state differs from its signed log');
      const draft = await this.validate({ state: raw.working, updates: [] });
      if (draft.text !== raw.text) throw new Error('Invalid protected document draft');
      const value = structuredClone(raw); await this.materializePending(value, verified); return value;
  }
  private heads(): DocumentHead[] { return [...this.docs.values()].filter(d => !d.recovery).map(d => ({ documentId: policy(d).documentId, seq: seq(d), head: head(d), policyId: policy(d).id })); }
  /** Freeze admission until the intended successor has durably verified every confirmed head. */
  async prepareHandoff(to: string, timeoutMs = 20_000): Promise<() => void> {
    let release = () => {};
    const ready = await this.run(async () => {
      if (this.selfId !== this.options.ownerId || this.handoff) throw new Error('Document ownership handoff is not authorized');
      if (this.docs.size && (to === this.selfId || !this.options.members().some(m => m.memberId === to && m.capable && m.online))) throw new Error('The new owner must be online and support collaborative documents');
      let resolve!: () => void, reject!: (error: Error) => void;
      const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
      // Attach a handler immediately: close() can reject during the gap between queues.
      void promise.catch(() => {});
      const handoff = { nonce: crypto.randomUUID(), to, items: this.heads(), ready: resolve, reject };
      this.handoff = handoff;
      for (const id of this.docs.keys()) this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
      release = () => { if (this.handoff !== handoff) return; this.handoff = undefined; for (const id of this.docs.keys()) this.versions.set(id, (this.versions.get(id) ?? 0) + 1); };
      if (!handoff.items.length) resolve();
      else this.background(() => this.options.send(to, { kind: 'prepare-handoff', nonce: handoff.nonce, items: handoff.items }));
      return { promise };
    });
    const timer = setTimeout(() => this.handoff?.reject(new Error('The new owner did not confirm document storage. Try again after synchronization.')), timeoutMs); timer.unref?.();
    try { await ready.promise; this.check(); return release; } catch (error) { release(); throw error; } finally { clearTimeout(timer); }
  }
  private maybeHandoffReady(): void {
    const request = this.handoffRequest;
    if (!request || Date.now() - request.at > 30_000) { this.handoffRequest = undefined; return; }
    if (!request.items.every(item => { const d = this.docs.get(item.documentId); return d && !d.recovery && seq(d) === item.seq && head(d) === item.head && policy(d).id === item.policyId; })) return;
    this.handoffRequest = undefined;
    this.background(() => this.options.send(this.options.ownerId, { kind: 'handoff-ready', nonce: request.nonce }));
  }
  private mutable(): void { if (this.handoff) throw new Error('Document ownership handoff is in progress'); }
  private save(d: StoredDocument): void {
    this.check(); const id = policy(d).documentId;
    if (!this.docs.has(id) && this.docs.size >= DOCUMENT_LIMIT) throw new Error('Document catalog capacity reached');
    if (Buffer.byteLength(JSON.stringify(d)) > DOCUMENT_STORE_BYTES) throw new Error('Document storage capacity reached');
    try { this.options.persistence.write(id, structuredClone(d)); } catch (error) { this.failed = 'write'; throw error; }
    this.docs.set(id, d); this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    this.maybeHandoffReady();
    const pendingIds = new Set([...this.docs.values()].flatMap(value => value.pending.map(p => p.proposal.id)));
    for (const sent of this.sentAt.keys()) if (!pendingIds.has(sent)) this.sentAt.delete(sent);
  }
  private document(id: string): StoredDocument { const d = this.docs.get(id); if (!d) throw new Error('Document unavailable'); return d; }
  private blocked(d: StoredDocument): boolean { return !!d.draftReview || d.pending.some(p => !!p.rejected || p.proposal.policyId !== policy(d).id); }
  private writable(d: StoredDocument): boolean { return !d.recovery && !policy(d).archived && policy(d).writers.includes(this.selfId); }
  private online(): boolean { return this.selfId === this.options.ownerId || this.options.members().some(m => m.memberId === this.options.ownerId && m.online); }
  private summary(d: StoredDocument): DocumentSummary {
    return { documentId: policy(d).documentId, title: policy(d).title, language: policy(d).language, archived: policy(d).archived,
      writable: this.writable(d) && !this.handoff, seq: seq(d), pending: d.pending.length, updatedAt: d.updatedAt, accessRequestCount: this.accessView(d).pending.length, ...(d.recovery ? { recovering: true } : {}), ...(this.handoff ? { transferring: true } : {}), ...(this.blocked(d) ? { error: 'draft-review' } : {}) };
  }
  private accessView(d: StoredDocument): DocumentAccessView {
    const now = Date.now(), members = this.options.members(), p = policy(d);
    for (const [key, value] of this.accessInbox) {
      const doc = this.docs.get(value.documentId);
      if (now - value.at > 600_000 || !doc || policy(doc).id !== value.policyId || policy(doc).archived || policy(doc).writers.includes(value.memberId) || this.options.banned?.().includes(value.memberId) || !members.some(m => m.memberId === value.memberId && m.capable)) this.accessInbox.delete(key);
    }
    for (const [key, value] of this.accessOwn) if (now - value.at > 600_000 || !this.docs.has(key) || policy(this.docs.get(key)!).id !== value.policyId) this.accessOwn.delete(key);
    for (const [key, at] of this.accessRate) if (now - at >= 60_000) this.accessRate.delete(key);
    for (const [key, at] of this.accessSeen) if (now - at > 120_000) this.accessSeen.delete(key);
    const own = this.accessOwn.get(p.documentId);
    return { supported: members.some(m => m.memberId === this.options.ownerId && m.accessCapable === true), nextRequestAt: this.accessRate.has(this.selfId) ? this.accessRate.get(this.selfId)! + 60_000 : 0,
      own: own ? { status: own.status, at: own.at } : null,
      pending: this.selfId === this.options.ownerId ? [...this.accessInbox.values()].filter(value => value.documentId === p.documentId).map(value => ({ ...value })) : [] };
  }
  requestAccess(id: string, expected: string): Promise<DocumentAccessView> {
    return this.run(async () => {
      this.mutable(); const d = this.document(id), p = policy(d), view = this.accessView(d), now = Date.now();
      if (this.options.banned?.().includes(this.selfId) || this.selfId === this.options.ownerId || this.writable(d) || p.archived || d.recovery || p.id !== expected || !this.online() || !view.supported || now < view.nextRequestAt || view.own && view.own.status !== 'declined') throw new Error('Document access request unavailable; refresh the document');
      if (this.accessRate.size >= 256 || this.accessOwn.size >= DOCUMENT_LIMIT) throw new Error('Document access request capacity reached');
      const request = { documentId: id, policyId: p.id, requestId: crypto.randomUUID(), memberId: this.selfId, at: now, status: 'sent' as const };
      this.accessRate.set(this.selfId, now); this.accessOwn.set(id, request); this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
      try { await this.options.send(this.options.ownerId, { kind: 'access-request', documentId: id, policyId: p.id, requestId: request.requestId, at: now }); }
      catch (error) { this.accessOwn.delete(id); throw error; }
      return this.accessView(d);
    });
  }
  dismissAccess(id: string, requestId: string): Promise<void> {
    return this.run(async () => {
      this.mutable(); const d = this.document(id); this.accessView(d);
      if (this.selfId !== this.options.ownerId) throw new Error('Document access decision is not authorized');
      const entry = [...this.accessInbox].find(([, r]) => r.documentId === id && r.requestId === requestId);
      if (!entry) throw new Error('Document access request expired');
      await this.options.send(entry[1].memberId, { kind: 'access-receipt', documentId: id, policyId: policy(d).id, requestId, status: 'declined' });
      this.accessInbox.delete(entry[0]); this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    });
  }
  view(): Promise<DocumentsView> { return this.run(async () => ({ enabled: true, selfId: this.selfId, ownerId: this.options.ownerId,
    canCreate: this.selfId === this.options.ownerId && !this.handoff, ownerOnline: this.online(), members: this.options.members(),
    items: [...this.docs.values()].map(d => this.summary(d)).sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)) })); }
  private checkpoint(d: StoredDocument, acks: string[] = []): DocumentCheckpoint {
    return signDocumentRecord<DocumentCheckpoint>(this.options.scope, { kind: 'checkpoint', policy: policy(d), seq: seq(d), head: head(d), state: d.state,
      acks: [...new Set([...d.checkpoint.acks, ...d.commits.map(c => c.proposal.id), ...acks])].slice(-256), at: Date.now() }, this.options.identity);
  }
  create(title: string, language: 'markdown' | 'text', text: string, writers: string[]): Promise<DocumentSummary> {
    return this.run(async () => {
      this.mutable();
      if (this.selfId !== this.options.ownerId || !validDocumentTitle(title) || !validDocumentText(text) || !['markdown', 'text'].includes(language)) throw new Error('Document creation is not authorized');
      this.validateWriters(writers);
      const id = crypto.randomUUID(), p = signDocumentPolicy(this.options.scope, { v: 1, documentId: id, epoch: 1, previous: null, ownerId: this.options.ownerId,
        title, language, writers: [...writers].sort(), archived: false, createdAt: Date.now() }, this.options.identity);
      const material = await this.validate({ updates: [], replace: text }); this.check();
      const checkpoint = signDocumentRecord<DocumentCheckpoint>(this.options.scope, { kind: 'checkpoint', policy: p, seq: 0, head: p.id, state: material.state, acks: [], at: Date.now() }, this.options.identity);
      const d: StoredDocument = { v: 1, scope: this.options.scope, ownerId: this.options.ownerId, checkpoint, commits: [], state: material.state,
        working: material.state, text, pending: [], snapshots: [], updatedAt: Date.now() };
      this.save(d); this.background(() => this.sendObject('', id, checkpoint)); return this.summary(d);
    });
  }
  private validateWriters(writers: string[], known: string[] = []): void {
    const candidates = this.options.members();
    if (!Array.isArray(writers) || writers.length < 1 || writers.length > 32 || new Set(writers).size !== writers.length || !writers.includes(this.options.ownerId)
      || writers.some(id => id !== this.options.ownerId && !known.includes(id) && !candidates.some(m => m.memberId === id && m.capable))) throw new Error('Invalid document writers');
  }
  changePolicy(id: string, expected: string, title: string, writers: string[], archived: boolean): Promise<DocumentSummary> {
    return this.run(async () => {
      this.mutable();
      const d = this.document(id); if (this.selfId !== this.options.ownerId || policy(d).id !== expected || !validDocumentTitle(title) || typeof archived !== 'boolean') throw new Error('Document rights changed; review again');
      this.validateWriters(writers, policy(d).writers);
      const p = signDocumentPolicy(this.options.scope, { ...policy(d), title, writers: [...writers].sort(), archived, epoch: policy(d).epoch + 1, previous: policy(d).id }, this.options.identity);
      const next = structuredClone(d), cp = this.checkpoint(d); next.checkpoint = signDocumentRecord<DocumentCheckpoint>(this.options.scope, { ...cp, policy: p, at: Date.now() }, this.options.identity); next.commits = [];
      this.save(next); this.background(() => this.sendObject('', id, next.checkpoint)); return this.summary(next);
    });
  }
  open(id: string): Promise<DocumentOpenView> { return this.run(async () => {
    this.document(id); for (const [token, t] of this.tokens) if (t.expires < Date.now()) this.tokens.delete(token);
    if (this.tokens.size >= 16) throw new Error('Too many open documents');
    const token = crypto.randomUUID(); this.tokens.set(token, { documentId: id, expires: Date.now() + 30 * 60_000, clock: 0 }); return this.openView(token);
  }); }
  private session(token: string) {
    const session = this.tokens.get(token); if (!session || session.expires < Date.now()) throw new Error('Document session expired');
    session.expires = Date.now() + 30 * 60_000; return session;
  }
  private openView(token: string, since = -1): DocumentOpenView {
    const session = this.session(token), d = this.document(session.documentId), now = Date.now();
    const cursors: DocumentCursor[] = [];
    for (const [key, c] of this.cursors) {
      if (c.until < now) { this.cursors.delete(key); continue; }
      if (c.presence.documentId !== session.documentId || c.presence.policyId !== policy(d).id || c.presence.sessionId === token) continue;
      const member = this.options.members().find(m => m.memberId === c.memberId); if (!member) continue;
      cursors.push({ ...c.presence, memberId: c.memberId, name: member.name.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 48), color: colors[parseInt(c.memberId.slice(0, 8), 16) % colors.length] });
    }
    return { ...this.summary(d), token, policyId: policy(d).id, state: since === this.versions.get(session.documentId) ? '' : d.working,
      version: this.versions.get(session.documentId)!, selfId: this.selfId, ownerId: this.options.ownerId, ownerOnline: this.online(), writers: [...policy(d).writers],
      cursors: cursors.slice(0, 32), localDraft: !!d.draftReview || d.pending.length > 0, blockedPending: this.blocked(d), access: this.accessView(d) };
  }
  poll(token: string, since = -1): Promise<DocumentOpenView> { return this.run(async () => this.openView(token, since)); }
  closeDocument(token: string): void {
    const t = this.tokens.get(token); this.tokens.delete(token);
    if (t) { this.cursors.delete(this.selfId + ':' + token); this.background(() => this.options.send('', { kind: 'presence', presence: { documentId: t.documentId, policyId: policy(this.document(t.documentId)).id,
      sessionId: token, clientId: 0, clock: ++t.clock, at: Date.now(), anchor: null, head: null } })); }
  }
  update(token: string, data: string): Promise<DocumentOpenView> {
    return this.run(async () => {
      this.mutable();
      const id = this.session(token).documentId, d = this.document(id);
      if (!this.writable(d) || this.blocked(d)) throw new Error('Document draft needs review or write access');
      const merging = d.pending.length >= 32;
      const material = await this.validate({ state: merging ? d.state : d.working, updates: merging ? [...d.pending.map(p => p.proposal.data), data] : [data], merge: merging }); this.check();
      if (!material.changed) return this.openView(token);
      const combined = merging && material.combined;
      if (!combined && d.pending.length >= DOCUMENT_PENDING_LIMIT) throw new Error('Document draft capacity reached');
      const proposal = signDocumentProposal(this.options.scope, { documentId: id, policyId: policy(d).id, authorId: this.selfId, nonce: crypto.randomUUID(), data: combined || data }, this.options.identity);
      if (this.selfId === this.options.ownerId && !d.pending.length) await this.admit(proposal, this.selfId, material);
      else {
        const next = structuredClone(d); if (combined) next.pending = []; next.pending.push({ proposal });
        if (Buffer.byteLength(JSON.stringify(next.pending)) > 2 * 1024 * 1024) throw new Error('Document offline draft capacity reached');
        next.working = material.state; next.text = material.text; next.updatedAt = Date.now(); this.save(next); this.wake();
      }
      return this.openView(token);
    });
  }
  private async materializePending(d: StoredDocument, confirmed: MaterializedDocument): Promise<void> {
    if (d.draftReview) return;
    if (!d.pending.length) { d.working = confirmed.state; d.text = confirmed.text; return; }
    try { const local = await this.validate({ state: d.state, updates: d.pending.map(p => p.proposal.data) }); d.working = local.state; d.text = local.text; }
    catch (error) { if (error instanceof DocumentValidationUnavailableError) throw error; d.pending = d.pending.map(p => ({ ...p, rejected: p.rejected || 'dependencies' })); }
  }
  private async admit(proposal: DocumentProposal, from: string, validated?: MaterializedDocument, base?: StoredDocument): Promise<void> {
    if (this.selfId !== this.options.ownerId || !verifyDocumentProposal(this.options.scope, proposal)) throw new Error('Invalid document author');
    if (this.handoff) return; // Author keeps retrying its protected pending queue after the transition.
    const d = base ?? this.document(proposal.documentId), p = policy(d);
    if (proposal.policyId !== p.id || !p.writers.includes(proposal.authorId) || p.archived) {
      this.background(() => this.options.send(from, { kind: 'rejected', documentId: p.documentId, proposalId: proposal.id, reason: 'rights' })); return;
    }
    let material: MaterializedDocument;
    try { material = validated ?? await this.validate({ state: d.state, updates: [proposal.data] }); }
    catch (error) {
      // Missing causal predecessors can arrive on another wire later. The author's durable
      // pending queue retries them in order; packet reordering must not reject that draft.
      if (error instanceof Error && error.message === 'Document dependencies missing') {
        this.background(() => this.sendObject(from, p.documentId, this.checkpoint(d))); return;
      }
      this.background(() => this.options.send(from, { kind: 'rejected', documentId: p.documentId, proposalId: proposal.id, reason: /capacity|limit/i.test(String(error)) ? 'limit' : 'invalid' })); return;
    }
    this.check();
    if (!material.changed) {
      const next = structuredClone(d); next.checkpoint = this.checkpoint(d, [proposal.id]); next.commits = []; this.save(next);
      this.background(() => this.sendObject(from, p.documentId, next.checkpoint)); return;
    }
    const commit = signDocumentRecord<DocumentCommit>(this.options.scope, { kind: 'change', documentId: p.documentId, policyId: p.id, seq: seq(d) + 1,
      previous: head(d), proposal: cleanDocumentProposal(proposal), at: Date.now() }, this.options.identity);
    const next = structuredClone(d); next.commits.push(commit); next.state = material.state; next.pending = next.pending.filter(p => p.proposal.id !== proposal.id);
    await this.materializePending(next, material); this.check(); next.updatedAt = Date.now();
    let outgoing: DocumentRecord = commit;
    if (next.commits.length >= 64 || Buffer.byteLength(JSON.stringify(next.commits)) > 1024 * 1024) { next.checkpoint = this.checkpoint(next); next.commits = []; outgoing = next.checkpoint; }
    this.save(next); this.background(() => this.sendObject('', p.documentId, outgoing));
  }
  private async acceptRecord(raw: unknown): Promise<void> {
    if (!verifyDocumentRecord(this.options.scope, this.options.ownerId, raw)) throw new Error('Invalid signed document record');
    const record = cleanDocumentRecord(raw), id = idOf(record), d = this.docs.get(id);
    if (record.kind === 'checkpoint') {
      if (d && (record.seq < seq(d) || record.policy.epoch < policy(d).epoch)) return;
      if (d && record.seq === seq(d) && (record.head !== head(d) || !d.recovery && record.policy.epoch === policy(d).epoch && record.policy.id !== policy(d).id)) throw new Error('Conflicting owner document checkpoint');
      const material = await this.validate({ state: record.state, updates: [] }); this.check();
      if (d && record.seq === seq(d) && record.head === head(d) && material.state !== d.state) throw new Error('Conflicting owner document contents');
      const next: StoredDocument = { v: 1, scope: this.options.scope, ownerId: this.options.ownerId, checkpoint: record, commits: [], state: material.state,
        working: d?.working ?? material.state, text: d?.text ?? material.text, pending: d?.pending.filter(p => !record.acks.includes(p.proposal.id)) ?? [], snapshots: d?.snapshots ?? [], updatedAt: record.at,
        ...(d?.draftReview ? { draftReview: true } : {}), ...(d?.migratedFrom ? { migratedFrom: d.migratedFrom } : {}) };
      await this.materializePending(next, material); this.save(next); return;
    }
    if (!d || d.recovery || record.seq > seq(d) + 1 || record.policyId !== policy(d).id) { this.request(id); return; }
    if (record.seq <= seq(d)) {
      const known = record.seq === seq(d) ? head(d) : d.commits.find(c => c.seq === record.seq)?.id;
      if (known && known !== record.id) throw new Error('Conflicting owner document commit'); return;
    }
    if (record.previous !== head(d) || policy(d).archived || !policy(d).writers.includes(record.proposal.authorId) || d.commits.length >= 256) { this.request(id); return; }
    const material = await this.validate({ state: d.state, updates: [record.proposal.data] }); this.check();
    const next = structuredClone(d); next.commits.push(record); next.state = material.state; next.pending = next.pending.filter(p => p.proposal.id !== record.proposal.id);
    await this.materializePending(next, material); next.updatedAt = record.at; this.save(next);
  }
  private request(id: string): void {
    if (Date.now() - (this.requests.get(id) ?? 0) < 1000) return; this.requests.set(id, Date.now()); const d = this.docs.get(id);
    if (this.requests.size > 64) this.requests.delete(this.requests.keys().next().value!);
    this.background(() => this.options.send(this.options.ownerId, { kind: 'request', documentId: id, seq: d && !d.recovery ? seq(d) : 0, head: d && !d.recovery ? head(d) : zeros, policyId: d && !d.recovery ? policy(d).id : zeros }));
  }
  private background(action: () => Promise<unknown>): void { if (this.current()) void action().catch(error => this.report(error)); }
  private async sendObject(to: string, documentId: string, object: DocumentRecord | { kind: 'proposal-record'; proposal: DocumentProposal }): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(object)); if (bytes.length > DOCUMENT_RECORD_BYTES) throw new Error('Document packet capacity reached');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    for (let offset = 0; offset < bytes.length; offset += DOCUMENT_PART_BYTES) {
      this.check(); await this.options.send(to, { kind: 'part', documentId, digest, bytes: bytes.length, offset, data: bytes.subarray(offset, offset + DOCUMENT_PART_BYTES).toString('base64') });
    }
  }
  receive(from: string, body: DocumentWireBody): Promise<void> {
    if (!validDocumentWireBody(body)) return Promise.reject(new Error('Invalid document frame'));
    return this.run(async () => {
      if (!this.options.members().some(m => m.memberId === from && m.capable)) throw new Error('Unknown document peer');
      if (body.kind === 'access-request' || body.kind === 'access-receipt') {
        this.mutable(); const d = this.docs.get(body.documentId); if (!d || d.recovery || policy(d).archived || policy(d).id !== body.policyId || this.options.banned?.().includes(from)) return;
        this.accessView(d);
        if (body.kind === 'access-request') {
          const now = Date.now();
          if (this.selfId !== this.options.ownerId || from === this.selfId || policy(d).writers.includes(from) || !this.options.members().some(m => m.memberId === from && m.accessCapable === true) || Math.abs(now - body.at) > 60_000 || this.accessRate.has(from) && now - this.accessRate.get(from)! < 60_000 || this.accessSeen.has(from + ':' + body.requestId) || this.accessSeen.size >= 1024 || this.accessInbox.size >= 128 || this.accessRate.size >= 256) return;
          this.accessSeen.set(from + ':' + body.requestId, now);
          this.accessRate.set(from, now); this.accessInbox.set(body.documentId + ':' + from, { ...body, memberId: from });
          this.versions.set(body.documentId, (this.versions.get(body.documentId) ?? 0) + 1);
          this.background(() => this.options.send(from, { kind: 'access-receipt', documentId: body.documentId, policyId: body.policyId, requestId: body.requestId, status: 'received' }));
        } else {
          const pending = this.accessOwn.get(body.documentId);
          if (from === this.options.ownerId && pending?.requestId === body.requestId && pending.policyId === body.policyId && pending.status !== 'declined') { pending.status = body.status; this.versions.set(body.documentId, (this.versions.get(body.documentId) ?? 0) + 1); }
        }
      } else if (body.kind === 'catalog') {
        if (this.selfId === this.options.ownerId) this.background(() => this.options.send(from, { kind: 'heads', items: this.heads() }));
      } else if (body.kind === 'heads') {
        if (from !== this.options.ownerId) return;
        for (const item of body.items) { const d = this.docs.get(item.documentId); if (!d || d.recovery || seq(d) !== item.seq || head(d) !== item.head || policy(d).id !== item.policyId) this.request(item.documentId); }
      } else if (body.kind === 'prepare-handoff') {
        if (from !== this.options.ownerId || this.selfId === this.options.ownerId) return;
        this.handoffRequest = { nonce: body.nonce, items: structuredClone(body.items), at: Date.now() };
        for (const item of body.items) { const d = this.docs.get(item.documentId); if (!d || d.recovery || seq(d) !== item.seq || head(d) !== item.head || policy(d).id !== item.policyId) this.request(item.documentId); }
        this.maybeHandoffReady();
      } else if (body.kind === 'handoff-ready') {
        if (this.handoff?.to === from && this.handoff.nonce === body.nonce) this.handoff.ready();
      } else if (body.kind === 'request') {
        if (this.selfId !== this.options.ownerId) return; const d = this.docs.get(body.documentId); if (!d) return;
        const prior = d.commits.findIndex(c => c.seq === body.seq && c.id === body.head);
        const changes = body.policyId === policy(d).id && (body.seq === d.checkpoint.seq && body.head === d.checkpoint.head || prior >= 0) ? d.commits.filter(c => c.seq > body.seq) : null;
        this.background(async () => { if (changes?.length) { for (const c of changes) await this.sendObject(from, body.documentId, c); } else await this.sendObject(from, body.documentId, this.checkpoint(d)); });
      } else if (body.kind === 'proposal') {
        if (this.selfId === this.options.ownerId && body.proposal.authorId === from) await this.admit(body.proposal, from);
      } else if (body.kind === 'part') {
        const now = Date.now(); for (const [key, item] of this.staging) if (item.until < now) this.staging.delete(key);
        const key = from + ':' + body.digest, data = Buffer.from(body.data, 'base64');
        if (data.toString('base64') !== body.data || body.offset % DOCUMENT_PART_BYTES || data.length !== Math.min(DOCUMENT_PART_BYTES, body.bytes - body.offset)) throw new Error('Invalid document part');
        let item = this.staging.get(key);
        if (!item) {
          if (this.staging.size >= 4 || [...this.staging.values()].filter(s => s.from === from).length >= 2 || [...this.staging.values()].reduce((n, s) => n + s.bytes, 0) + body.bytes > 8 * 1024 * 1024) throw new Error('Document staging capacity reached');
          item = { from, documentId: body.documentId, digest: body.digest, bytes: body.bytes, buffer: Buffer.alloc(body.bytes), received: new Set(), count: 0, until: now + 30_000 }; this.staging.set(key, item);
        }
        if (item.bytes !== body.bytes || item.documentId !== body.documentId) throw new Error('Document part changed');
        if (!item.received.has(body.offset)) { data.copy(item.buffer, body.offset); item.received.add(body.offset); item.count += data.length; }
        if (item.count !== item.bytes) return; this.staging.delete(key);
        if (crypto.createHash('sha256').update(item.buffer).digest('hex') !== item.digest) throw new Error('Document packet digest mismatch');
        const raw = JSON.parse(item.buffer.toString('utf8')) as { kind?: string; proposal?: DocumentProposal };
        if (raw?.kind === 'proposal-record') {
          if (this.selfId === this.options.ownerId && raw.proposal?.authorId === from && raw.proposal.documentId === item.documentId) await this.admit(raw.proposal, from);
        } else {
          if (from !== this.options.ownerId || !verifyDocumentRecord(this.options.scope, this.options.ownerId, raw) || idOf(raw) !== item.documentId) throw new Error('Document record is not from the owner');
          await this.acceptRecord(raw);
        }
      } else if (body.kind === 'presence') {
        for (const [key, cursor] of this.cursors) if (cursor.until < Date.now()) this.cursors.delete(key);
        const p = body.presence, d = this.docs.get(p.documentId); if (!d || p.policyId !== policy(d).id || Math.abs(p.at - Date.now()) > 60_000) return;
        const key = from + ':' + p.sessionId, old = this.cursors.get(key);
        if (old && old.presence.clock >= p.clock) return;
        if (p.anchor === null || p.head === null) this.cursors.delete(key);
        else if (this.cursors.size < 128 || old) this.cursors.set(key, { memberId: from, presence: { ...p }, until: Date.now() + 20_000 });
      } else if (body.kind === 'rejected' && from === this.options.ownerId) {
        const d = this.docs.get(body.documentId); if (!d || !d.pending.some(p => p.proposal.id === body.proposalId)) return;
        const next = structuredClone(d); next.pending.forEach(p => { if (p.proposal.id === body.proposalId) p.rejected = body.reason; }); this.save(next); this.request(body.documentId);
      }
    });
  }
  peer(memberId: string): Promise<void> { return this.run(async () => { this.sentAt.clear(); this.background(() => this.options.send(memberId, { kind: 'catalog' })); this.wake(); }); }
  private wake(): void {
    if (this.networkBusy || !this.current() || this.failed || this.loadingError && Date.now() < this.retryAt) return; this.networkBusy = true;
    void this.run(async () => [...this.docs.values()].flatMap(d => this.blocked(d) || !this.writable(d) ? [] : d.pending.map(p => p.proposal)).slice(0, 8)).then(async proposals => {
      for (const p of proposals) {
        if (!this.current() || Date.now() - (this.sentAt.get(p.id) ?? 0) < 4000) continue; this.sentAt.set(p.id, Date.now());
        if (p.data.length < 24 * 1024) await this.options.send(this.options.ownerId, { kind: 'proposal', proposal: p });
        else await this.sendObject(this.options.ownerId, p.documentId, { kind: 'proposal-record', proposal: p });
      }
      if (this.handoff?.items.length) await this.options.send(this.handoff.to, { kind: 'prepare-handoff', nonce: this.handoff.nonce, items: this.handoff.items });
      if (this.selfId === this.options.ownerId) await this.options.send('', { kind: 'heads', items: this.heads() });
    }).catch(error => this.report(error)).finally(() => { this.networkBusy = false; });
  }
  presence(token: string, input: Pick<DocumentPresence, 'clientId' | 'anchor' | 'head'>): Promise<void> {
    return this.run(async () => {
      const t = this.session(token), d = this.document(t.documentId), p: DocumentPresence = { ...input, documentId: t.documentId, policyId: policy(d).id, sessionId: token, clock: ++t.clock, at: Date.now() };
      if (!validDocumentPresence(p)) throw new Error('Invalid document cursor');
      this.cursors.set(this.selfId + ':' + token, { memberId: this.selfId, presence: p, until: Date.now() + 20_000 }); this.background(() => this.options.send('', { kind: 'presence', presence: p }));
    });
  }
  history(token: string): Promise<DocumentLocalSnapshot[]> { return this.run(async () => structuredClone(this.document(this.session(token).documentId).snapshots).reverse()); }
  keepDraft(token: string, text: string): Promise<void> {
    return this.run(async () => {
      if (!validDocumentText(text)) throw new Error('Invalid local draft');
      const d = this.document(this.session(token).documentId), next = structuredClone(d);
      const review = !!d.recovery || this.blocked(d) || !this.writable(d);
      if (d.snapshots.at(-1)?.text === text && (!review || d.draftReview && d.text === text)) return;
      if (d.snapshots.at(-1)?.text !== text) next.snapshots = snapshotLimit([...next.snapshots, { id: crypto.randomUUID(), label: '', at: Date.now(), text, seq: seq(d) }]);
      if (review) {
        const material = await this.validate({ state: d.working, updates: [], replace: text }); this.check();
        next.working = material.state; next.text = material.text; next.pending = []; next.draftReview = true;
      }
      this.save(next);
    });
  }
  snapshot(token: string, label: string): Promise<DocumentLocalSnapshot> {
    return this.run(async () => {
      if (typeof label !== 'string' || label.length > 120 || /[\p{Cc}\p{Cf}]/u.test(label)) throw new Error('Invalid document snapshot label');
      const d = this.document(this.session(token).documentId), s = { id: crypto.randomUUID(), label: label.trim(), at: Date.now(), text: d.text, seq: seq(d) };
      const next = structuredClone(d); next.snapshots = snapshotLimit([...next.snapshots, s]); this.save(next); return s;
    });
  }
  restoreSnapshot(token: string, snapshotId: string): Promise<DocumentOpenView> {
    return this.run(async () => {
      this.mutable();
      const id = this.session(token).documentId, d = this.document(id), s = d.snapshots.find(s => s.id === snapshotId);
      if (!s || !this.writable(d) || this.blocked(d)) throw new Error('Snapshot restoration is not authorized');
      const material = await this.validate({ state: d.working, updates: [], replace: s.text }); this.check();
      const next = structuredClone(d); next.snapshots = snapshotLimit([...next.snapshots, { id: crypto.randomUUID(), label: '', at: Date.now(), text: d.text, seq: seq(d) }]);
      return this.replaceDraft(token, material, next);
    });
  }
  private async replaceDraft(token: string, material: MaterializedDocument, base?: StoredDocument): Promise<DocumentOpenView> {
    const d = base ?? this.document(this.session(token).documentId);
    if (!this.writable(d) || d.pending.length >= DOCUMENT_PENDING_LIMIT) throw new Error('Document draft capacity or rights changed');
    const proposal = signDocumentProposal(this.options.scope, { documentId: policy(d).documentId, policyId: policy(d).id,
      authorId: this.selfId, nonce: crypto.randomUUID(), data: material.delta! }, this.options.identity);
    if (this.selfId === this.options.ownerId) await this.admit(proposal, this.selfId, material, base);
    else {
      const next = structuredClone(d); next.pending = [...next.pending, { proposal }];
      if (Buffer.byteLength(JSON.stringify(next.pending)) > 2 * 1024 * 1024) throw new Error('Document offline draft capacity reached');
      next.working = material.state; next.text = material.text; this.save(next); this.wake();
    }
    return this.openView(token);
  }
  reviewDraft(token: string, choice: 'apply' | 'discard'): Promise<DocumentOpenView> {
    return this.run(async () => {
      this.mutable();
      const d = this.document(this.session(token).documentId); if (d.recovery || !['apply', 'discard'].includes(choice) || choice === 'apply' && !this.writable(d)) throw new Error('Draft review is not authorized');
      const material = await this.validate({ state: d.state, updates: [], ...(choice === 'apply' ? { replace: d.text } : {}) }); this.check();
      const next = structuredClone(d); next.snapshots = snapshotLimit([...next.snapshots, { id: crypto.randomUUID(), label: '', at: Date.now(), text: d.text, seq: seq(d) }]);
      next.pending = []; delete next.draftReview; next.working = next.state; next.text = (await this.validate({ state: next.state, updates: [] })).text; this.check();
      if (choice === 'apply') return this.replaceDraft(token, material, next);
      this.save(next); return this.openView(token);
    });
  }
  exportText(token: string): Promise<{ title: string; language: 'markdown' | 'text'; text: string }> {
    return this.run(async () => { const d = this.document(this.session(token).documentId); return { title: policy(d).title, language: policy(d).language, text: d.text }; });
  }
}
