/** Collaborative documents have their own identity and never compete with watched files. */
export const DOCUMENT_CAPABILITY = 'room-documents-v2';
export const DOCUMENT_ACCESS_CAPABILITY = 'document-access-v1';
export const DOCUMENT_TEXT_BYTES = 256 * 1024;
export const DOCUMENT_STATE_BYTES = 2 * 1024 * 1024;
export const DOCUMENT_UPDATE_BYTES = 384 * 1024;
export const DOCUMENT_RECORD_BYTES = 4 * 1024 * 1024;
export const DOCUMENT_PART_BYTES = 24 * 1024;
export const DOCUMENT_LIMIT = 32;
export const DOCUMENT_PENDING_LIMIT = 128;
export const DOCUMENT_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const DOCUMENT_HASH = /^[a-f0-9]{64}$/;
export const DOCUMENT_MEMBER = /^[a-f0-9]{32}$/;
export interface DocumentPolicy {
  v: 1; documentId: string; epoch: number; previous: string | null; ownerId: string; title: string;
  language: 'markdown' | 'text'; writers: string[]; archived: boolean; createdAt: number; pub: string; sig: string; id: string;
}
export interface DocumentProposal { documentId: string; policyId: string; authorId: string; nonce: string; data: string; pub: string; sig: string; id: string }
export interface DocumentCommit { kind: 'change'; documentId: string; policyId: string; seq: number; previous: string; proposal: DocumentProposal; at: number; pub: string; sig: string; id: string }
export interface DocumentCheckpoint { kind: 'checkpoint'; policy: DocumentPolicy; seq: number; head: string; state: string; acks: string[]; at: number; pub: string; sig: string; id: string }
export type DocumentRecord = DocumentCommit | DocumentCheckpoint;
export interface DocumentPresence { documentId: string; policyId: string; sessionId: string; clientId: number; clock: number; at: number; anchor: string | null; head: string | null }
export interface DocumentHead { documentId: string; seq: number; head: string; policyId: string }
export type DocumentWireBody =
  | { kind: 'access-request'; documentId: string; policyId: string; requestId: string; at: number }
  | { kind: 'access-receipt'; documentId: string; policyId: string; requestId: string; status: 'received' | 'declined' }
  | { kind: 'catalog' }
  | { kind: 'heads'; items: DocumentHead[] }
  | { kind: 'prepare-handoff'; nonce: string; items: DocumentHead[] }
  | { kind: 'handoff-ready'; nonce: string }
  | { kind: 'request'; documentId: string; seq: number; head: string; policyId: string }
  | { kind: 'part'; documentId: string; digest: string; bytes: number; offset: number; data: string }
  | { kind: 'proposal'; proposal: DocumentProposal }
  | { kind: 'presence'; presence: DocumentPresence }
  | { kind: 'rejected'; documentId: string; proposalId: string; reason: 'rights' | 'limit' | 'invalid' };
export interface DocumentWireMessage { t: typeof DOCUMENT_CAPABILITY; memberId: string; to: string; body: DocumentWireBody; pub: string; sig: string }
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const integer = (x: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) <= max;
const hash = (x: unknown) => typeof x === 'string' && DOCUMENT_HASH.test(x);
const uuid = (x: unknown) => typeof x === 'string' && DOCUMENT_UUID.test(x);
const member = (x: unknown) => typeof x === 'string' && DOCUMENT_MEMBER.test(x);
const proof = (x: Record<string, unknown>) => typeof x.pub === 'string' && x.pub.length <= 2048 && typeof x.sig === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(x.sig) && hash(x.id);
export function documentBase64(x: unknown, bytes: number): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= Math.ceil(bytes / 3) * 4 && x.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(x);
}
export function validDocumentText(x: unknown): x is string {
  // Shared documents use canonical LF so CodeMirror and Y.Text share the same offsets.
  // eslint-disable-next-line no-control-regex -- Prevent binary/control data in text documents.
  return typeof x === 'string' && x.length <= DOCUMENT_TEXT_BYTES && !/[\u0000-\u0008\u000b-\u001f\u007f\uD800-\uDFFF]/u.test(x) && new TextEncoder().encode(x).length <= DOCUMENT_TEXT_BYTES;
}
export function validDocumentTitle(x: unknown): x is string { return typeof x === 'string' && x.trim() === x && x.length > 0 && x.length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(x); }
export function validDocumentPolicy(x: unknown): x is DocumentPolicy {
  return object(x) && x.v === 1 && uuid(x.documentId) && integer(x.epoch) && (x.epoch as number) > 0 && (x.previous === null || hash(x.previous)) && member(x.ownerId)
    && validDocumentTitle(x.title) && (x.language === 'markdown' || x.language === 'text') && typeof x.archived === 'boolean' && integer(x.createdAt)
    && Array.isArray(x.writers) && x.writers.length > 0 && x.writers.length <= 32 && x.writers.every(member) && new Set(x.writers).size === x.writers.length
    && x.writers.includes(x.ownerId) && x.writers.join(',') === [...x.writers].sort().join(',') && proof(x);
}
export function validDocumentProposal(x: unknown): x is DocumentProposal { return object(x) && uuid(x.documentId) && hash(x.policyId) && member(x.authorId) && uuid(x.nonce) && documentBase64(x.data, DOCUMENT_UPDATE_BYTES) && proof(x); }
export function validDocumentRecord(x: unknown): x is DocumentRecord {
  if (!object(x) || !proof(x) || !integer(x.at) || !integer(x.seq)) return false;
  return x.kind === 'change' ? (x.seq as number) > 0 && uuid(x.documentId) && hash(x.policyId) && hash(x.previous) && validDocumentProposal(x.proposal) && x.proposal.documentId === x.documentId && x.proposal.policyId === x.policyId
    : x.kind === 'checkpoint' && validDocumentPolicy(x.policy) && hash(x.head) && documentBase64(x.state, DOCUMENT_STATE_BYTES) && Array.isArray(x.acks) && x.acks.length <= 256 && x.acks.every(hash) && new Set(x.acks).size === x.acks.length;
}
export function validDocumentPresence(x: unknown): x is DocumentPresence {
  return object(x) && uuid(x.documentId) && hash(x.policyId) && uuid(x.sessionId) && integer(x.clientId, 0xffffffff) && integer(x.clock) && integer(x.at)
    && (x.anchor === null || documentBase64(x.anchor, 256)) && (x.head === null || documentBase64(x.head, 256));
}
export function validDocumentWireBody(x: unknown): x is DocumentWireBody {
  if (!object(x)) return false;
  switch (x.kind) {
    case 'access-request': return uuid(x.documentId) && hash(x.policyId) && uuid(x.requestId) && integer(x.at);
    case 'access-receipt': return uuid(x.documentId) && hash(x.policyId) && uuid(x.requestId) && ['received', 'declined'].includes(String(x.status));
    case 'catalog': return true;
    case 'prepare-handoff':
    case 'heads': return (x.kind === 'heads' || uuid(x.nonce)) && Array.isArray(x.items) && x.items.length <= DOCUMENT_LIMIT && x.items.every(i => object(i) && uuid(i.documentId) && integer(i.seq) && hash(i.head) && hash(i.policyId)) && new Set(x.items.map(i => (i as Record<string, unknown>).documentId)).size === x.items.length;
    case 'handoff-ready': return uuid(x.nonce);
    case 'request': return uuid(x.documentId) && integer(x.seq) && hash(x.head) && hash(x.policyId);
    case 'part': return uuid(x.documentId) && hash(x.digest) && integer(x.bytes, DOCUMENT_RECORD_BYTES) && (x.bytes as number) > 0 && integer(x.offset, DOCUMENT_RECORD_BYTES) && (x.offset as number) < (x.bytes as number) && documentBase64(x.data, DOCUMENT_PART_BYTES);
    case 'proposal': return validDocumentProposal(x.proposal);
    case 'presence': return validDocumentPresence(x.presence);
    case 'rejected': return uuid(x.documentId) && hash(x.proposalId) && ['rights', 'limit', 'invalid'].includes(String(x.reason));
    default: return false;
  }
}
export function validDocumentWireMessage(x: unknown): x is DocumentWireMessage {
  return object(x) && x.t === DOCUMENT_CAPABILITY && member(x.memberId) && (x.to === '' || member(x.to)) && typeof x.pub === 'string' && x.pub.length <= 2048
    && typeof x.sig === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(x.sig) && validDocumentWireBody(x.body);
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export const documentPolicyCanonical = (scope: string, p: Omit<DocumentPolicy, 'id' | 'sig'>) => bytes(['havvn-doc-policy-v1', scope, p.documentId, p.epoch, p.previous, p.ownerId, p.title, p.language, p.writers, p.archived, p.createdAt, p.pub]);
export const documentProposalCanonical = (scope: string, p: Omit<DocumentProposal, 'id' | 'sig'>) => bytes(['havvn-doc-edit-v1', scope, p.documentId, p.policyId, p.authorId, p.nonce, p.data, p.pub]);
export const documentRecordCanonical = (scope: string, r: Omit<DocumentCommit, 'id' | 'sig'> | Omit<DocumentCheckpoint, 'id' | 'sig'>) => r.kind === 'change'
  ? bytes(['havvn-doc-commit-v1', scope, r.documentId, r.policyId, r.seq, r.previous, r.proposal.id, r.at, r.pub])
  : bytes(['havvn-doc-checkpoint-v1', scope, r.policy.id, r.seq, r.head, r.state, r.acks, r.at, r.pub]);
export const documentWireCanonical = (scope: string, memberId: string, to: string, body: DocumentWireBody) => bytes(['havvn-doc-wire-v2', scope, memberId, to, body]);
export interface DocumentMemberView { memberId: string; name: string; capable: boolean; online: boolean; accessCapable?: boolean }
export interface DocumentAccessRequest { documentId: string; policyId: string; requestId: string; memberId: string; at: number }
export interface DocumentAccessView { supported: boolean; nextRequestAt: number; own: { status: 'sent' | 'received' | 'declined'; at: number } | null; pending: DocumentAccessRequest[] }
export interface DocumentSummary { documentId: string; title: string; language: 'markdown' | 'text'; archived: boolean; writable: boolean; seq: number; pending: number; updatedAt: number; error?: string; recovering?: boolean; transferring?: boolean; accessRequestCount?: number }
export interface DocumentsView { enabled: boolean; selfId: string; ownerId: string; canCreate: boolean; ownerOnline: boolean; members: DocumentMemberView[]; items: DocumentSummary[] }
export interface DocumentCursor extends DocumentPresence { memberId: string; name: string; color: string }
export interface DocumentOpenView extends DocumentSummary { token: string; policyId: string; state: string; version: number; selfId: string; ownerId: string; ownerOnline: boolean; writers: string[]; cursors: DocumentCursor[]; localDraft: boolean; blockedPending: boolean; access?: DocumentAccessView }
export interface DocumentLocalSnapshot { id: string; label: string; at: number; text: string; seq: number }
export interface DocumentsApi {
  requestAccess(roomId: string, documentId: string, policyId: string): Promise<DocumentAccessView>;
  dismissAccess(roomId: string, documentId: string, requestId: string): Promise<void>;
  view(roomId: string): Promise<DocumentsView>;
  create(roomId: string, title: string, language: 'markdown' | 'text', text: string, writers: string[]): Promise<DocumentSummary>;
  open(roomId: string, documentId: string): Promise<DocumentOpenView>;
  poll(roomId: string, token: string, version: number): Promise<DocumentOpenView>;
  update(roomId: string, token: string, data: string): Promise<DocumentOpenView>;
  close(roomId: string, token: string): Promise<void>;
  presence(roomId: string, token: string, value: Pick<DocumentPresence, 'clientId' | 'anchor' | 'head'>): Promise<void>;
  policy(roomId: string, documentId: string, expected: string, title: string, writers: string[], archived: boolean): Promise<DocumentSummary>;
  history(roomId: string, token: string): Promise<DocumentLocalSnapshot[]>;
  snapshot(roomId: string, token: string, label: string): Promise<DocumentLocalSnapshot>;
  keepDraft(roomId: string, token: string, text: string): Promise<void>;
  restore(roomId: string, token: string, snapshotId: string): Promise<DocumentOpenView>;
  review(roomId: string, token: string, choice: 'apply' | 'discard'): Promise<DocumentOpenView>;
  export(roomId: string, token: string): Promise<boolean>;
}
