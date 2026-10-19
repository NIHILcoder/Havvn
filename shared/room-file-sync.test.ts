import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FileSyncIndex, SYNC_ROOT_FILE_LIMIT, SYNC_REVISION_LIMIT, SYNC_POLICY_LIMIT, syncRevisionCanonical, validSyncRevision, type SyncPolicy, type SyncRevision } from './room-file-sync';
import { deriveMemberId } from '../electron/sharing/room-crypto';
import { signSyncPolicy, signSyncRevision, verifySyncProof } from '../electron/sharing/room-sync-proofs';

function identity() {
  const keys = crypto.generateKeyPairSync('ed25519');
  const pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { pub, id: deriveMemberId(pub), priv: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
const owner = identity(), publisher = identity(), other = identity();
const context = { scope: 'private-room-context', rootId: crypto.randomUUID(), ownerId: owner.id, e2e: false };
const entryId = crypto.randomUUID();
function policy(changes: Partial<Omit<SyncPolicy, 'policyId' | 'sig'>> = {}) {
  return signSyncPolicy(context.scope, { v: 1, rootId: context.rootId, epoch: 1, parentPolicyId: null,
    ownerId: owner.id, publisherId: publisher.id, name: 'Shared config', allowDeletes: false, baseHeads: [], pub: owner.pub, ...changes }, owner.priv);
}
function revision(p: SyncPolicy, changes: Partial<Omit<SyncRevision, 'revisionId' | 'sig'>> = {}, signer = publisher) {
  return signSyncRevision(context.scope, { v: 1, rootId: context.rootId, policyId: p.policyId, entryId,
    parents: [], relativePath: 'config.ini', op: 'put', blob: { infoHash: 'a'.repeat(40), name: 'config.ini', size: 5, enc: false, keyEpoch: null },
    authorId: signer.id, createdAt: 100, pub: signer.pub, ...changes }, signer.priv);
}
function fixture() { const index = new FileSyncIndex(context, verifySyncProof), p = policy(); index.acceptPolicy(p); return { index, p }; }

describe('v6 shared deletion authority', () => {
  it('requires owner opt-in, a compatible revision version and a valid content parent', () => {
    const { index, p } = fixture(), first = revision(p); index.acceptRevision(first);
    const next = policy({ v: 6, writers: [owner.id, publisher.id].sort(), epoch: 2, parentPolicyId: p.policyId,
      baseHeads: [{ entryId, revisionId: first.revisionId }], allowDeletes: true }); index.acceptPolicy(next);
    const deleted = revision(next, { v: 6, parents: [first.revisionId], op: 'delete', blob: null });
    expect(() => index.acceptRevision({ ...deleted, v: 5 })).toThrow(); index.acceptRevision(deleted);
    expect(index.heads()[0].revisionIds).toEqual([deleted.revisionId]);
    const restored = revision(next, { v: 6, parents: [deleted.revisionId] }); index.acceptRevision(restored);
    expect(index.heads()[0].revisionIds).toEqual([restored.revisionId]);
  });
  it('rejects deletion when the current owner policy does not allow it', () => {
    const { index, p } = fixture(), first = revision(p); index.acceptRevision(first);
    const next = policy({ v: 6, writers: [owner.id, publisher.id].sort(), epoch: 2, parentPolicyId: p.policyId, baseHeads: [{ entryId, revisionId: first.revisionId }] }); index.acceptPolicy(next);
    expect(() => index.acceptRevision(revision(next, { v: 6, parents: [first.revisionId], op: 'delete', blob: null }))).toThrow('authorized');
  });
});

describe('owner-signed checkpoint floors', () => {
  function cut(p: SyncPolicy, anchors: SyncRevision[], generation = 1, parentCheckpointId: string | null = null) {
    const sorted = [...anchors].sort((a, b) => a.entryId.localeCompare(b.entryId) || a.revisionId.localeCompare(b.revisionId));
    return policy({ v: 4, writers: [owner.id, publisher.id].sort(), epoch: p.epoch + 1, parentPolicyId: p.policyId,
      baseHeads: sorted.map(r => ({ entryId: r.entryId, revisionId: r.revisionId })), checkpoint: { generation, parentCheckpointId,
        archiveDigest: 'a'.repeat(64), archiveRecords: 2, anchors: sorted, origins: [] } });
  }
  it('bootstraps verified current versions and rights without importing the previous causal log', () => {
    const { index, p } = fixture(), a = revision(p), b = revision(p, { parents: [a.revisionId], createdAt: 200 });
    index.acceptRevision(a); index.acceptRevision(b); const checkpoint = cut(p, [b]); index.acceptPolicy(checkpoint);
    expect(index.revision(a.revisionId)).toBeUndefined(); expect(index.revision(b.revisionId)).toEqual(b);
    const fresh = new FileSyncIndex(context, verifySyncProof); fresh.acceptPolicy(checkpoint); expect(fresh.heads()).toEqual(index.heads());
    const next = revision(checkpoint, { v: 4, parents: [b.revisionId], createdAt: 300 });
    fresh.acceptRevision(next); index.acceptRevision(next); expect(fresh.heads()).toEqual(index.heads());
    expect(() => index.acceptPolicy(p)).toThrow();
    const later = cut(checkpoint, [next], 2, checkpoint.policyId); index.acceptPolicy(later);
    expect(() => index.acceptPolicy(checkpoint)).toThrow(); expect(index.checkpoint()?.policyId).toBe(later.policyId);
  });
  it('refuses forged anchors, foreign rooms, wrong predecessor and same-generation forks', () => {
    const { index, p } = fixture(), a = revision(p); index.acceptRevision(a); const cp = cut(p, [a]);
    expect(() => new FileSyncIndex({ ...context, scope: 'foreign' }, verifySyncProof).acceptPolicy(cp)).toThrow();
    const forged = structuredClone(cp); forged.checkpoint!.anchors[0].createdAt++;
    expect(() => new FileSyncIndex(context, verifySyncProof).acceptPolicy(forged)).toThrowError(expect.objectContaining({ code: 'authority' }));
    index.acceptPolicy(cp); expect(index.acceptPolicy(cp)).toBe('duplicate');
    expect(() => index.acceptPolicy(cut(cp, [a], 2, 'b'.repeat(64)))).toThrow();
    expect(() => index.acceptPolicy(cut(cp, [a], 1))).toThrow();
  });
  it('continues beyond the old 10,000 revision ceiling while keeping each active index bounded', () => {
    const p = policy(), seed = revision(p), index = new FileSyncIndex(context, () => true); index.acceptPolicy(p);
    let last = seed;
    for (let n = 1; n <= SYNC_REVISION_LIMIT; n++) {
      last = { ...seed, revisionId: n.toString(16).padStart(64, '0'), parents: n === 1 ? [] : [last.revisionId] }; index.acceptRevision(last);
    }
    expect(() => index.acceptRevision({ ...last, revisionId: 'e'.repeat(64), parents: [last.revisionId] })).toThrow();
    const checkpoint = cut(p, [last]); index.acceptPolicy(checkpoint);
    index.acceptRevision({ ...last, v: 4, policyId: checkpoint.policyId, revisionId: 'e'.repeat(64), parents: [last.revisionId] });
    expect(index.heads()[0].revisionIds).toEqual(['e'.repeat(64)]); expect(index.revision(seed.revisionId)).toBeUndefined();
  });
});

describe('signed v3 moves', () => {
  const writers = [owner.id, publisher.id].sort();
  it('preserves entry identity and authenticates each old parent path', () => {
    const p = policy({ v: 3, writers }), index = new FileSyncIndex(context, verifySyncProof); index.acceptPolicy(p);
    const a = revision(p, { v: 3 }); index.acceptRevision(a);
    const change = { v: 3 as const, parents: [a.revisionId], relativePath: 'nested/renamed.ini', blob: { ...a.blob!, name: 'renamed.ini' } };
    expect(() => index.acceptRevision(revision(p, change))).toThrowError(expect.objectContaining({ code: 'parent' }));
    expect(() => index.acceptRevision(revision(p, { ...change, previousPaths: ['other.ini'] }))).toThrow();
    const b = revision(p, { ...change, previousPaths: [a.relativePath] }); index.acceptRevision(b);
    expect(index.heads()).toEqual([{ entryId, revisionIds: [b.revisionId] }]); expect(index.revision(a.revisionId)).toEqual(a);
    expect(() => index.acceptRevision({ ...b, previousPaths: ['forged.ini'] })).toThrowError(expect.objectContaining({ code: 'authority' }));
    const next = policy({ v: 2, writers, epoch: 2, parentPolicyId: p.policyId, baseHeads: [{ entryId, revisionId: b.revisionId }] });
    expect(() => index.acceptPolicy(next)).toThrowError(expect.objectContaining({ code: 'policy-chain' }));
  });
  it('keeps parallel moves as branches until a signed choice covers both paths', () => {
    const p = policy({ v: 3, writers }), index = new FileSyncIndex(context, verifySyncProof); index.acceptPolicy(p);
    const a = revision(p, { v: 3 }); index.acceptRevision(a);
    const move = (name: string) => revision(p, { v: 3, parents: [a.revisionId], relativePath: name, previousPaths: [a.relativePath], blob: { ...a.blob!, name } });
    const b = move('b.ini'), c = move('c.ini'); index.acceptRevision(b); index.acceptRevision(c);
    expect(index.heads()[0].revisionIds).toHaveLength(2);
    const resolved = revision(p, { v: 3, parents: [b.revisionId, c.revisionId].sort(), relativePath: b.relativePath, previousPaths: [c.relativePath], blob: b.blob });
    index.acceptRevision(resolved); expect(index.heads()[0].revisionIds).toEqual([resolved.revisionId]);
  });
  it.each(['CONFIG.ini', 'config.ini/child.ini', '../outside.ini'])('rejects ambiguous or unsafe move path %s', name => {
    const p = policy({ v: 3, writers });
    expect(() => revision(p, { v: 3, parents: ['b'.repeat(64)], relativePath: name, previousPaths: ['config.ini'], blob: { infoHash: 'a'.repeat(40), name: name.split('/').at(-1)!, size: 5, enc: false, keyEpoch: null } })).toThrow();
  });
});

describe('multi-writer signed epochs', () => {
  const writers = [owner.id, publisher.id, other.id].sort();
  const multi = () => policy({ v: 2, writers });
  it('keeps concurrent edits and resolves them only with a signed descendant of both heads', () => {
    const p = multi(), a = revision(p, { v: 2 }), b = revision(p, { v: 2, parents: [a.revisionId] }), c = revision(p, { v: 2, parents: [a.revisionId] }, other);
    const left = new FileSyncIndex(context, verifySyncProof), right = new FileSyncIndex(context, verifySyncProof);
    for (const index of [left, right]) { index.acceptPolicy(p); index.acceptRevision(a); }
    left.acceptRevision(b); left.acceptRevision(c); right.acceptRevision(c); right.acceptRevision(b);
    expect(left.heads()).toEqual(right.heads()); expect(left.heads()[0].revisionIds).toHaveLength(2);
    const merged = revision(p, { v: 2, parents: [b.revisionId, c.revisionId].sort() }, owner);
    for (const index of [left, right]) { index.acceptRevision(merged); expect(index.heads()[0].revisionIds).toEqual([merged.revisionId]); }
  });
  it('retains revoked offline content as history without advancing the owner checkpoint', () => {
    const p = multi(), a = revision(p, { v: 2 }), offline = revision(p, { v: 2, parents: [a.revisionId] }, other);
    const next = policy({ v: 2, writers: [owner.id, publisher.id].sort(), epoch: 2, parentPolicyId: p.policyId, baseHeads: [{ entryId, revisionId: a.revisionId }] });
    for (const before of [true, false]) {
      const index = new FileSyncIndex(context, verifySyncProof); index.acceptPolicy(p); index.acceptRevision(a);
      if (before) index.acceptRevision(offline); index.acceptPolicy(next); if (!before) index.acceptRevision(offline);
      expect(index.revision(offline.revisionId)).toEqual(offline); expect(index.heads()[0].revisionIds).toEqual([a.revisionId]);
      expect(() => index.acceptRevision(revision(next, { v: 2, parents: [a.revisionId] }, other))).toThrowError(expect.objectContaining({ code: 'authority' }));
    }
  });
  it('carries every conflicting baseline and rejects unsigned writer-list mutations and downgrades', () => {
    const p = multi(), index = new FileSyncIndex(context, verifySyncProof); index.acceptPolicy(p);
    const a = revision(p, { v: 2 }), b = revision(p, { v: 2, parents: [a.revisionId] }), c = revision(p, { v: 2, parents: [a.revisionId] }, other);
    for (const r of [a, b, c]) index.acceptRevision(r);
    const next = policy({ v: 2, writers, epoch: 2, parentPolicyId: p.policyId, baseHeads: [b, c].map(r => ({ entryId, revisionId: r.revisionId })).sort((a, b) => a.revisionId.localeCompare(b.revisionId)) });
    expect(() => index.acceptPolicy({ ...next, writers: [owner.id, publisher.id].sort() })).toThrowError(expect.objectContaining({ code: 'authority' }));
    index.acceptPolicy(next); expect(index.heads()[0].revisionIds).toEqual([b.revisionId, c.revisionId].sort());
    expect(() => index.acceptPolicy(policy({ epoch: 3, parentPolicyId: next.policyId, baseHeads: [{ entryId, revisionId: b.revisionId }] }))).toThrowError(expect.objectContaining({ code: 'policy-chain' }));
  });
  it('requires canonical bounded writers, version matches, and excludes writer lists from v1', () => {
    expect(() => policy({ writers })).toThrow();
    expect(() => policy({ v: 2, writers: [...writers, writers[0]] })).toThrow();
    const p = multi(), index = new FileSyncIndex(context, verifySyncProof); index.acceptPolicy(p);
    expect(() => index.acceptRevision(revision(p))).toThrowError(expect.objectContaining({ code: 'authority' }));
  });
});

describe('signed file-sync revision index', () => {
  it('keeps a document ID while advancing its content hash, regardless of clock order', () => {
    const { index, p } = fixture(), a = revision(p);
    index.acceptRevision(a);
    const b = revision(p, { parents: [a.revisionId], createdAt: 1, blob: { ...a.blob!, infoHash: 'b'.repeat(40) } });
    index.acceptRevision(b);
    expect(index.heads()).toEqual([{ entryId, revisionIds: [b.revisionId] }]);
    expect(index.revision(a.revisionId)?.blob?.infoHash).toBe('a'.repeat(40));
  });

  it('is idempotent and never rolls back on a repeated old policy or revision', () => {
    const { index, p } = fixture(), a = revision(p);
    index.acceptRevision(a);
    const next = policy({ epoch: 2, parentPolicyId: p.policyId, baseHeads: [{ entryId, revisionId: a.revisionId }] });
    index.acceptPolicy(next);
    expect(index.acceptPolicy(p)).toBe('duplicate'); expect(index.acceptRevision(a)).toBe('duplicate');
    expect(index.policy()?.policyId).toBe(next.policyId);
  });

  it('rejects a valid member signature from someone other than the publisher', () => {
    const { index, p } = fixture();
    expect(() => index.acceptRevision(revision(p, {}, other))).toThrowError(expect.objectContaining({ code: 'authority' }));
    expect(index.heads()).toEqual([]);
  });

  it('rejects a policy signed by a member pretending to be the owner', () => {
    const p = policy();
    expect(() => signSyncPolicy(context.scope, { ...p, pub: other.pub }, other.priv)).toThrow('signer');
    const index = new FileSyncIndex({ ...context, ownerId: other.id }, verifySyncProof);
    expect(() => index.acceptPolicy(p)).toThrowError(expect.objectContaining({ code: 'authority' }));
  });

  it('binds proofs to the room context and recomputes the content-addressed ID', () => {
    const { index, p } = fixture(), r = revision(p);
    const foreign = new FileSyncIndex({ ...context, scope: 'other-room' }, verifySyncProof);
    expect(() => foreign.acceptPolicy(p)).toThrowError(expect.objectContaining({ code: 'authority' }));
    expect(() => index.acceptRevision({ ...r, revisionId: 'f'.repeat(64) })).toThrowError(expect.objectContaining({ code: 'authority' }));
    expect(() => index.acceptRevision({ ...r, createdAt: 101 })).toThrowError(expect.objectContaining({ code: 'authority' }));
    expect(index.heads()).toEqual([]);
  });

  it('rejects a correctly signed descriptor for a different root', () => {
    const { index, p } = fixture();
    expect(() => index.acceptRevision(revision(p, { rootId: crypto.randomUUID() }))).toThrowError(expect.objectContaining({ code: 'invalid' }));
  });

  it('requires missing parents rather than guessing based on timestamps', () => {
    const { index, p } = fixture();
    expect(() => index.acceptRevision(revision(p, { parents: ['d'.repeat(64)] }))).toThrowError(expect.objectContaining({ code: 'missing-parent' }));
    expect(index.heads()).toEqual([]);
  });

  it('rejects a parent belonging to another document', () => {
    const { index, p } = fixture(), a = revision(p);
    index.acceptRevision(a);
    expect(() => index.acceptRevision(revision(p, { entryId: crypto.randomUUID(), parents: [a.revisionId] }))).toThrowError(expect.objectContaining({ code: 'parent' }));
  });

  it('retains publisher forks and converges regardless of branch arrival order', () => {
    const { index, p } = fixture(), a = revision(p);
    index.acceptRevision(a);
    const b = revision(p, { parents: [a.revisionId], createdAt: 200 });
    const c = revision(p, { parents: [a.revisionId], createdAt: 300 });
    const second = index.clone();
    index.acceptRevision(b); index.acceptRevision(c); second.acceptRevision(c); second.acceptRevision(b);
    expect(index.heads()).toEqual(second.heads());
    expect(index.heads()[0].revisionIds).toHaveLength(2);
    const merged = revision(p, { parents: [b.revisionId, c.revisionId].sort(), createdAt: 400 });
    index.acceptRevision(merged); expect(index.heads()[0].revisionIds).toEqual([merged.revisionId]);
  });

  it('preserves all old bytes and rejects new late writes from the revoked publisher', () => {
    const { index, p } = fixture(), a = revision(p); index.acceptRevision(a);
    const next = policy({ epoch: 2, parentPolicyId: p.policyId, publisherId: other.id, baseHeads: [{ entryId, revisionId: a.revisionId }] });
    index.acceptPolicy(next);
    expect(() => index.acceptRevision(revision(p, { parents: [a.revisionId], createdAt: 200 }))).toThrowError(expect.objectContaining({ code: 'stale-policy' }));
    expect(() => index.acceptRevision(revision(next, { parents: [a.revisionId] }))).toThrowError(expect.objectContaining({ code: 'authority' }));
    const b = revision(next, { parents: [a.revisionId] }, other); index.acceptRevision(b);
    expect(index.heads()[0].revisionIds).toEqual([b.revisionId]); expect(index.revision(a.revisionId)).toEqual(a);
  });

  it('does not revive a branch excluded by a policy baseline', () => {
    const { index, p } = fixture(), a = revision(p); index.acceptRevision(a);
    const b = revision(p, { parents: [a.revisionId], createdAt: 200 }); index.acceptRevision(b);
    const next = policy({ epoch: 2, parentPolicyId: p.policyId, baseHeads: [{ entryId, revisionId: b.revisionId }] }); index.acceptPolicy(next);
    expect(() => index.acceptRevision(revision(next, { parents: [a.revisionId], createdAt: 300 }))).toThrowError(expect.objectContaining({ code: 'parent' }));
  });

  it('requires a complete known baseline when changing policy', () => {
    const { index, p } = fixture(), a = revision(p); index.acceptRevision(a);
    expect(() => index.acceptPolicy(policy({ epoch: 2, parentPolicyId: p.policyId }))).toThrowError(expect.objectContaining({ code: 'missing-parent' }));
    expect(index.policy()).toEqual(p);
  });

  it('requires an explicit delete permission and preserves the deletion revision', () => {
    const { index, p } = fixture(), a = revision(p); index.acceptRevision(a);
    expect(() => index.acceptRevision(revision(p, { parents: [a.revisionId], op: 'delete', blob: null }))).toThrowError(expect.objectContaining({ code: 'authority' }));
    const next = policy({ epoch: 2, parentPolicyId: p.policyId, allowDeletes: true, baseHeads: [{ entryId, revisionId: a.revisionId }] }); index.acceptPolicy(next);
    const deletion = revision(next, { parents: [a.revisionId], op: 'delete', blob: null }); index.acceptRevision(deletion);
    expect(index.revision(deletion.revisionId)?.blob).toBeNull(); expect(index.heads()[0].revisionIds).toEqual([deletion.revisionId]);
  });

  it('enforces the room content mode rather than trusting an encrypted flag', () => {
    const { index, p } = fixture();
    const enc = revision(p, { blob: { infoHash: 'a'.repeat(40), name: 'config.ini', size: 5, enc: true, keyEpoch: 'a'.repeat(64) } });
    expect(() => index.acceptRevision(enc)).toThrowError(expect.objectContaining({ code: 'authority' }));
    const encrypted = new FileSyncIndex({ ...context, e2e: true }, verifySyncProof); encrypted.acceptPolicy(p);
    expect(() => encrypted.acceptRevision(revision(p))).toThrowError(expect.objectContaining({ code: 'authority' }));
    encrypted.acceptRevision(enc);
  });

  it('reports cross-document path collisions conservatively across platforms', () => {
    const { index, p } = fixture(); index.acceptRevision(revision(p));
    const otherId = crypto.randomUUID();
    index.acceptRevision(revision(p, { entryId: otherId, relativePath: 'CONFIG.INI', blob: { infoHash: 'a'.repeat(40), name: 'CONFIG.INI', size: 5, enc: false, keyEpoch: null } }));
    expect(index.pathConflicts()).toEqual([{ path: 'config.ini', entryIds: [entryId, otherId].sort() }]);
  });

  it('drops unsigned extension fields and prevents mutation through input or getters', () => {
    const { index, p } = fixture(), a = revision(p);
    index.acceptRevision({ ...a, localPath: '/never-trust-this', blob: { ...a.blob, secret: 'do not retain' } });
    const copy = index.revision(a.revisionId)!; copy.parents.push('f'.repeat(64)); copy.blob!.name = 'changed';
    expect(index.revision(a.revisionId)).toEqual(a);
    const cloned = index.clone(); cloned.acceptRevision(revision(p, { parents: [a.revisionId], createdAt: 200 }));
    expect(index.heads()[0].revisionIds).toEqual([a.revisionId]);
  });
  it('detects file/ancestor collisions independent of order, case and intervening sibling names', () => {
    const { index, p } = fixture(), ids = [entryId, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const [i, relativePath] of ['MODS/a/config.ini', 'mods', 'mods-old', 'elsewhere/config.ini'].entries()) index.acceptRevision(revision(p, {
      entryId: ids[i], relativePath, blob: { infoHash: 'a'.repeat(40), name: relativePath.split('/').at(-1)!, size: 5, enc: false, keyEpoch: null }
    }));
    expect(index.pathConflicts()).toEqual([{ path: 'mods', entryIds: [ids[0], ids[1]].sort() }, { path: 'mods/a/config.ini', entryIds: [ids[0], ids[1]].sort() }]);
  });

  it('canonicalizes semantic fields consistently without relying on object key order', () => {
    const p = policy(), r = revision(p);
    const reversed = Object.fromEntries(Object.entries(r).reverse()) as unknown as SyncRevision;
    expect(syncRevisionCanonical(context.scope, reversed)).toEqual(syncRevisionCanonical(context.scope, r));
    expect(validSyncRevision({ ...r, parents: [r.revisionId] })).toBe(false);
  });

  it('bounds file admission without evicting accepted documents', () => {
    // Proof verification is tested above; bypass only the expensive crypto in the capacity fixture.
    const index = new FileSyncIndex(context, () => true), p = policy(), seed = revision(p);
    index.acceptPolicy(p);
    for (let n = 0; n < SYNC_ROOT_FILE_LIMIT; n++) index.acceptRevision({ ...seed, entryId: crypto.randomUUID(), revisionId: (n + 1).toString(16).padStart(64, '0') });
    expect(() => index.acceptRevision({ ...seed, entryId: crypto.randomUUID(), revisionId: 'f'.repeat(64) })).toThrowError(expect.objectContaining({ code: 'limit' }));
    expect(index.heads()).toHaveLength(SYNC_ROOT_FILE_LIMIT);
  });

  it('bounds revision history without forgetting the replay floor', () => {
    const index = new FileSyncIndex(context, () => true), p = policy(), seed = revision(p); index.acceptPolicy(p);
    let parent: string | undefined;
    for (let n = 0; n < SYNC_REVISION_LIMIT; n++) {
      const id = (n + 1).toString(16).padStart(64, '0');
      index.acceptRevision({ ...seed, revisionId: id, parents: parent ? [parent] : [] }); parent = id;
    }
    expect(() => index.acceptRevision({ ...seed, revisionId: 'f'.repeat(64), parents: [parent!] })).toThrowError(expect.objectContaining({ code: 'limit' }));
    expect(index.heads()[0].revisionIds).toEqual([parent]);
  });

  it('bounds policy history instead of dropping old policy proofs', () => {
    const index = new FileSyncIndex(context, () => true), seed = policy(); let parent: string | null = null;
    for (let n = 0; n < SYNC_POLICY_LIMIT; n++) {
      const id = (n + 1).toString(16).padStart(64, '0');
      index.acceptPolicy({ ...seed, epoch: n + 1, policyId: id, parentPolicyId: parent }); parent = id;
    }
    expect(() => index.acceptPolicy({ ...seed, epoch: SYNC_POLICY_LIMIT + 1, policyId: 'f'.repeat(64), parentPolicyId: parent })).toThrowError(expect.objectContaining({ code: 'limit' }));
    expect(index.policy()?.policyId).toBe(parent);
  });

  it.each(['../config.ini', '/config.ini', 'x\\config.ini', 'a/CON.txt', '.havvn-sync/config.ini', 'a//config.ini', 'a/COM¹.txt', 'a/\uD800.ini'])('rejects unsafe signed paths: %s', relativePath => {
    expect(() => revision(policy(), { relativePath })).toThrow();
  });
});
