import crypto from 'node:crypto';
import { deriveMemberId } from './room-crypto';
import { verifySyncProof } from './room-sync-proofs';
import { documentPolicyCanonical, documentProposalCanonical, documentRecordCanonical, validDocumentPolicy, validDocumentProposal, validDocumentRecord,
  type DocumentPolicy, type DocumentProposal, type DocumentCommit, type DocumentCheckpoint, type DocumentRecord } from '../../shared/room-documents';
type Identity = { pub: string; priv: string };
export const cleanDocumentPolicy = (p: DocumentPolicy): DocumentPolicy => ({ v: 1, documentId: p.documentId, epoch: p.epoch, previous: p.previous, ownerId: p.ownerId, title: p.title, language: p.language, writers: [...p.writers], archived: p.archived, createdAt: p.createdAt, pub: p.pub, sig: p.sig, id: p.id });
export const cleanDocumentProposal = (p: DocumentProposal): DocumentProposal => ({ documentId: p.documentId, policyId: p.policyId, authorId: p.authorId, nonce: p.nonce, data: p.data, pub: p.pub, sig: p.sig, id: p.id });
export const cleanDocumentRecord = (r: DocumentRecord): DocumentRecord => r.kind === 'change'
  ? { kind: 'change', documentId: r.documentId, policyId: r.policyId, seq: r.seq, previous: r.previous, proposal: cleanDocumentProposal(r.proposal), at: r.at, pub: r.pub, sig: r.sig, id: r.id }
  : { kind: 'checkpoint', policy: cleanDocumentPolicy(r.policy), seq: r.seq, head: r.head, state: r.state, acks: [...r.acks], at: r.at, pub: r.pub, sig: r.sig, id: r.id };
const sign = (bytes: Uint8Array, identity: Identity) => ({ id: crypto.createHash('sha256').update(bytes).digest('hex'), sig: crypto.sign(null, bytes, identity.priv).toString('base64') });
export function signDocumentPolicy(scope: string, body: Omit<DocumentPolicy, 'id' | 'sig' | 'pub'>, identity: Identity): DocumentPolicy {
  const p = { ...body, pub: identity.pub }; const result = { ...p, ...sign(documentPolicyCanonical(scope, p), identity) };
  if (!verifyDocumentPolicy(scope, body.ownerId, result)) throw new Error('Invalid document policy'); return result;
}
export function signDocumentProposal(scope: string, body: Omit<DocumentProposal, 'id' | 'sig' | 'pub'>, identity: Identity): DocumentProposal {
  const p = { ...body, pub: identity.pub }; const result = { ...p, ...sign(documentProposalCanonical(scope, p), identity) };
  if (!verifyDocumentProposal(scope, result)) throw new Error('Invalid document proposal'); return result;
}
export function signDocumentRecord<T extends DocumentRecord>(scope: string, body: Omit<T, 'id' | 'sig' | 'pub'>, identity: Identity): T {
  const p = { ...body, pub: identity.pub } as unknown as Omit<DocumentCommit, 'id' | 'sig'> | Omit<DocumentCheckpoint, 'id' | 'sig'>;
  return { ...p, ...sign(documentRecordCanonical(scope, p), identity) } as T;
}
export function verifyDocumentPolicy(scope: string, ownerId: string, p: unknown): p is DocumentPolicy {
  return validDocumentPolicy(p) && p.ownerId === ownerId && verifySyncProof(ownerId, p.pub, p.sig, documentPolicyCanonical(scope, p), p.id);
}
export function verifyDocumentProposal(scope: string, p: unknown): p is DocumentProposal {
  return validDocumentProposal(p) && verifySyncProof(p.authorId, p.pub, p.sig, documentProposalCanonical(scope, p), p.id);
}
export function verifyDocumentRecord(scope: string, ownerId: string, r: unknown): r is DocumentRecord {
  return validDocumentRecord(r) && deriveMemberId(r.pub) === ownerId
    && (r.kind === 'checkpoint' ? verifyDocumentPolicy(scope, ownerId, r.policy) : verifyDocumentProposal(scope, r.proposal))
    && verifySyncProof(ownerId, r.pub, r.sig, documentRecordCanonical(scope, r), r.id);
}
