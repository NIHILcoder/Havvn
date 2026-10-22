import crypto from 'node:crypto';
import { deriveMemberId } from './room-crypto';
import { syncPolicyCanonical, syncRevisionCanonical, validSyncPolicy, validSyncRevision,
  copySyncPolicy, copySyncRevision, type SyncPolicy, type SyncRevision, type SyncProofVerifier } from '../../shared/room-file-sync';

/** Both content-address integrity and the member/public-key binding are mandatory. */
export const verifySyncProof: SyncProofVerifier = (memberId, pub, sig, bytes, id) => {
  try {
    const key = crypto.createPublicKey(pub);
    return key.asymmetricKeyType === 'ed25519' && deriveMemberId(pub) === memberId
      && crypto.createHash('sha256').update(bytes).digest('hex') === id
      && crypto.verify(null, bytes, key, Buffer.from(sig, 'base64'));
  } catch { return false; }
};

export function signSyncPolicy(scope: string, body: Omit<SyncPolicy, 'policyId' | 'sig'>, privateKey: string): SyncPolicy {
  const bytes = syncPolicyCanonical(scope, body);
  const p: SyncPolicy = { ...body, policyId: crypto.createHash('sha256').update(bytes).digest('hex'),
    sig: crypto.sign(null, bytes, privateKey).toString('base64') };
  if (!validSyncPolicy(p) || !verifySyncProof(p.ownerId, p.pub, p.sig, bytes, p.policyId)) throw new Error('Invalid sync policy signer or body');
  return copySyncPolicy(p);
}
export function signSyncRevision(scope: string, body: Omit<SyncRevision, 'revisionId' | 'sig'>, privateKey: string): SyncRevision {
  const bytes = syncRevisionCanonical(scope, body);
  const r: SyncRevision = { ...body, revisionId: crypto.createHash('sha256').update(bytes).digest('hex'),
    sig: crypto.sign(null, bytes, privateKey).toString('base64') };
  if (!validSyncRevision(r) || !verifySyncProof(r.authorId, r.pub, r.sig, bytes, r.revisionId)) throw new Error('Invalid sync revision signer or body');
  return copySyncRevision(r);
}
