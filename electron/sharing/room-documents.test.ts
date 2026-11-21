import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { RoomDocuments, type RoomDocumentsOptions } from './room-documents';
import { DocumentValidationUnavailableError } from './room-document-validator';
import { materializeDocument } from './room-document-model';
import { deriveMemberId } from './room-crypto';
import { signDocumentRecord, verifyDocumentRecord } from './room-document-proofs';
import { DOCUMENT_PART_BYTES, type DocumentCheckpoint, type DocumentWireBody } from '../../shared/room-documents';
import type { StoredDocument, DocumentRecoverySource } from '../db/room-documents-store';

const services: RoomDocuments[] = [];
afterEach(() => { services.splice(0).forEach(s => s.close()); vi.useRealTimers(); vi.restoreAllMocks(); });
function setup() {
  const identities = Array.from({ length: 3 }, () => { const pair = crypto.generateKeyPairSync('ed25519'); return { pub: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }; });
  const ids = identities.map(i => deriveMemberId(i.pub)), nodes: RoomDocuments[] = [], stores = identities.map(() => new Map<string, StoredDocument>());
  const bus: Array<{ from: string; to: string; body: DocumentWireBody }> = [], offline = new Set<number>(), unsupported = new Set<number>();
  const sources: DocumentRecoverySource[][] = identities.map(() => []), banned: string[] = [];
  let scope = 'test-scope', owner = 0, generation = 0;
  let broken = -1, writesLeft = 0;
  const start = (index: number, sessions?: ReturnType<RoomDocuments['sessions']>, overrides: Partial<Pick<RoomDocumentsOptions, 'validate' | 'warn'>> = {}) => {
    nodes[index]?.close(); const service = new RoomDocuments({ scope, ownerId: ids[owner], identity: identities[index], recoverySources: sources[index], sessions, banned: () => banned,
      persistence: { list: () => [...stores[index].keys()], read: id => structuredClone(stores[index].get(id)), write: (id, d) => { if (index === broken && writesLeft-- <= 0) throw new Error('disk full'); stores[index].set(id, structuredClone(d)); } },
      current: () => true, validate: async input => materializeDocument(input),
      members: () => ids.map((memberId, i) => ({ memberId, name: 'Person ' + i, online: !offline.has(i), capable: true, accessCapable: !unsupported.has(i) })),
      send: async (to, body) => { if (offline.has(index)) throw new Error('offline'); bus.push({ from: ids[index], to, body: structuredClone(body) }); },
      ...overrides,
    }); nodes[index] = service; services.push(service); return service;
  };
  identities.forEach((_, i) => start(i));
  const pump = async () => {
    for (let step = 0; step < 2000; step++) {
      await Promise.all(nodes.map(n => n.idle())); await Promise.resolve();
      const message = bus.shift(); if (!message) { await new Promise(resolve => setTimeout(resolve, 0)); if (!bus.length) return; continue; }
      for (let i = 0; i < nodes.length; i++) if (ids[i] !== message.from && !offline.has(i) && (!message.to || message.to === ids[i])) await nodes[i].receive(message.from, message.body);
    }
    throw new Error('document bus did not settle');
  };
  const create = async (text = 'start') => { const d = await nodes[0].create('Team notes', 'markdown', text, ids); await pump(); return d.documentId; };
  const transition = (newOwner: number, newScope = scope) => {
    const key = crypto.createHash('sha256').update(String(generation++)).digest('hex');
    const sessions = nodes.map(n => n.sessions());
    for (let i = 0; i < stores.length; i++) {
      const old = stores[i]; sources[i] = [{ key, context: { scope, ownerId: ids[owner], e2e: true }, persistence: { list: () => [...old.keys()], read: id => structuredClone(old.get(id)), write: () => { throw new Error('Source must remain immutable'); } } }, ...sources[i]];
      stores[i] = new Map();
    }
    scope = newScope; owner = newOwner; bus.length = 0; identities.forEach((_, i) => start(i, sessions[i]));
  };
  return { ids, identities, nodes, stores, bus, offline, unsupported, start, pump, create, transition, sources, banned, fail: (i: number, writes = 0) => { broken = i; writesLeft = writes; } };
}
function edit(state: string, insert: string, at = 0) {
  const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(state, 'base64')); const vector = Y.encodeStateVector(doc); doc.getText('text').insert(at, insert);
  const data = Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64'); doc.destroy(); return data;
}
const text = (state: string) => materializeDocument({ state, updates: [] }).text;
async function deliverRecord(node: RoomDocuments, from: string, record: DocumentCheckpoint) {
  const bytes = Buffer.from(JSON.stringify(record)), digest = crypto.createHash('sha256').update(bytes).digest('hex');
  for (let offset = 0; offset < bytes.length; offset += DOCUMENT_PART_BYTES) await node.receive(from, { kind: 'part', documentId: record.policy.documentId, digest, bytes: bytes.length, offset, data: bytes.subarray(offset, offset + DOCUMENT_PART_BYTES).toString('base64') });
}
describe('collaborative room documents', () => {
  it('retries a temporary worker startup failure and preserves the stored document', async () => {
    const t = setup(), id = await t.create('Cold startup fixture'), before = structuredClone([...t.stores[0]]);
    t.nodes.forEach(n => n.close()); vi.useFakeTimers();
    const warn = vi.fn(), validate = vi.fn(async (input: Parameters<typeof materializeDocument>[0]) => materializeDocument(input));
    validate.mockRejectedValueOnce(new DocumentValidationUnavailableError('Temporary worker startup failure'));
    const restored = t.start(0, undefined, { validate, warn }); await restored.idle();
    await expect(restored.view()).rejects.toBeInstanceOf(DocumentValidationUnavailableError);
    expect(warn).toHaveBeenCalledOnce(); expect(validate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1100);
    expect((await restored.view()).items).toHaveLength(1);
    expect(text((await restored.open(id)).state)).toBe('Cold startup fixture');
    expect([...t.stores[0]]).toEqual(before); expect(warn).toHaveBeenCalledOnce();
  });
  it('automatically retries temporary failures with bounded backoff and no repeated warning', async () => {
    const t = setup(); await t.create(); t.nodes.forEach(n => n.close()); vi.useFakeTimers();
    const warn = vi.fn(), validate = vi.fn(async (input: Parameters<typeof materializeDocument>[0]) => materializeDocument(input));
    validate.mockRejectedValueOnce(new DocumentValidationUnavailableError('Temporary worker startup failure'));
    validate.mockRejectedValueOnce(new DocumentValidationUnavailableError('Temporary worker startup failure'));
    const restored = t.start(0, undefined, { validate, warn }); await restored.idle();
    await vi.advanceTimersByTimeAsync(2000); await restored.idle();
    expect(validate).toHaveBeenCalledTimes(2); expect(warn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000); await restored.idle();
    expect((await restored.view()).items).toHaveLength(1); expect(warn).toHaveBeenCalledOnce();
  });
  it('does not reject an offline draft when its validation worker is temporarily unavailable', async () => {
    const t = setup(), id = await t.create(), opened = await t.nodes[2].open(id);
    t.offline.add(2); await t.nodes[2].update(opened.token, edit(opened.state, 'Private '));
    const before = structuredClone([...t.stores[2]]); t.nodes.forEach(n => n.close()); vi.useFakeTimers();
    const validate = vi.fn(async (input: Parameters<typeof materializeDocument>[0]) => materializeDocument(input));
    validate.mockImplementationOnce(async input => materializeDocument(input));
    validate.mockImplementationOnce(async input => materializeDocument(input));
    validate.mockRejectedValueOnce(new DocumentValidationUnavailableError('Temporary worker startup failure'));
    const restored = t.start(2, undefined, { validate }); await restored.idle();
    await expect(restored.view()).rejects.toBeInstanceOf(DocumentValidationUnavailableError);
    await vi.advanceTimersByTimeAsync(1100);
    const draft = await restored.open(id); expect(text(draft.state)).toBe('Private start'); expect(draft.blockedPending).toBe(false);
    expect([...t.stores[2]]).toEqual(before);
  });
  it('can retry validation while migrating a previous room context', async () => {
    const t = setup(), id = await t.create(); t.transition(1, 'new-context'); await Promise.all(t.nodes.map(n => n.idle()));
    t.nodes.forEach(n => n.close()); t.stores[0].clear(); vi.useFakeTimers();
    const validate = vi.fn(async (input: Parameters<typeof materializeDocument>[0]) => materializeDocument(input));
    validate.mockRejectedValueOnce(new DocumentValidationUnavailableError('Temporary worker startup failure'));
    const restored = t.start(0, undefined, { validate }); await restored.idle();
    await vi.advanceTimersByTimeAsync(1100);
    expect(text((await restored.open(id)).state)).toBe('start'); expect(t.stores[0].size).toBe(1);
  });
  it('keeps real validation failures blocked without retrying or flooding warnings', async () => {
    const t = setup(); await t.create(); const before = structuredClone([...t.stores[0]]);
    t.nodes.forEach(n => n.close()); vi.useFakeTimers();
    const warn = vi.fn(), validate = vi.fn(async () => { throw new Error('Document validation timed out'); });
    const restored = t.start(0, undefined, { validate, warn }); await restored.idle();
    await expect(restored.view()).rejects.toThrow('Protected documents unavailable');
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(restored.view()).rejects.toThrow('Protected documents unavailable');
    expect(warn).toHaveBeenCalledOnce(); expect(validate).toHaveBeenCalledOnce(); expect([...t.stores[0]]).toEqual(before);
  });
  it('freezes even an empty catalog until the authority command completes', async () => {
    const t = setup(); t.offline.add(1); const release = await t.nodes[0].prepareHandoff(t.ids[1]);
    await expect(t.nodes[0].create('Racing document', 'text', 'x', t.ids)).rejects.toThrow('handoff');
    release(); expect((await t.nodes[0].view()).canCreate).toBe(true);
  });
  it('requires durable successor confirmation and freezes admission until the transfer ends', async () => {
    const t = setup(), id = await t.create(), a = await t.nodes[0].open(id);
    const prepared = t.nodes[0].prepareHandoff(t.ids[1]); await t.pump(); const release = await prepared;
    await expect(t.nodes[0].update(a.token, edit(a.state, 'late '))).rejects.toThrow('handoff');
    expect((await t.nodes[0].poll(a.token)).writable).toBe(false);
    release(); expect((await t.nodes[0].poll(a.token)).writable).toBe(true);
    t.offline.add(1); await expect(t.nodes[0].prepareHandoff(t.ids[1])).rejects.toThrow('online');
  });
  it('copies missed and archived documents before accepting a handoff, and rejects forged acknowledgements', async () => {
    const t = setup(); t.offline.add(1); const id = await t.create(), a = await t.nodes[0].open(id);
    await t.nodes[0].changePolicy(id, a.policyId, a.title, t.ids, true); await t.pump(); t.offline.delete(1);
    const prepared = t.nodes[0].prepareHandoff(t.ids[1]); await t.nodes[0].idle(); await Promise.resolve();
    const request = t.bus.find(m => m.body.kind === 'prepare-handoff')!.body;
    if (request.kind !== 'prepare-handoff') throw new Error('Missing handoff request');
    await t.nodes[0].receive(t.ids[2], { kind: 'handoff-ready', nonce: request.nonce });
    await t.pump(); const release = await prepared;
    expect(t.stores[1].get(id)!.checkpoint.policy.archived).toBe(true); release();
  });
  it('times out without handing off authority if the successor never acknowledges', async () => {
    const t = setup(); await t.create();
    await expect(t.nodes[0].prepareHandoff(t.ids[1], 30)).rejects.toThrow('did not confirm');
    expect((await t.nodes[0].view()).canCreate).toBe(true);
  });
  it('never acknowledges handoff if saving a missed checkpoint fails', async () => {
    const t = setup(); t.offline.add(1); await t.create(); t.offline.delete(1); t.fail(1);
    const prepared = t.nodes[0].prepareHandoff(t.ids[1], 100); void prepared.catch(() => {});
    await expect(t.pump()).rejects.toThrow('disk full'); await expect(prepared).rejects.toThrow('did not confirm');
    expect((await t.nodes[0].view()).canCreate).toBe(true); expect(t.stores[1].size).toBe(0);
  });
  it('migrates confirmed text, local history and private drafts without publishing the drafts', async () => {
    const t = setup(), id = await t.create(), owner = await t.nodes[0].open(id), writer = await t.nodes[2].open(id);
    const snapshot = await t.nodes[0].snapshot(owner.token, 'Before transfer');
    t.offline.add(2); await t.nodes[2].update(writer.token, edit(writer.state, 'Private ')); await t.pump();
    const originals = t.stores.map(s => structuredClone([...s])); t.transition(1);
    const local = await t.nodes[2].poll(writer.token); expect(local.recovering).toBe(true); expect(local.blockedPending).toBe(true); expect(text(local.state)).toBe('Private start');
    expect((await t.nodes[0].history(owner.token)).some(s => s.id === snapshot.id)).toBe(true);
    expect(text((await t.nodes[1].open(id)).state)).toBe('start');
    t.offline.delete(2); await t.nodes[1].peer(t.ids[0]); await t.pump();
    const adopted = await t.nodes[2].poll(writer.token); expect(adopted.recovering).toBeUndefined(); expect(adopted.blockedPending).toBe(true); expect(text(adopted.state)).toBe('Private start');
    expect(text((await t.nodes[1].open(id)).state)).toBe('start');
    const reviewed = await t.nodes[2].reviewDraft(writer.token, 'apply'); await t.pump(); expect(text(reviewed.state)).toBe('Private start');
    expect(text((await t.nodes[1].open(id)).state)).toBe('Private start');
    for (let i = 0; i < 3; i++) expect(originals[i]).toEqual([...t.sources[i][0].persistence.list().map(id => [id, t.sources[i][0].persistence.read(id)])]);
    t.start(2); expect(text((await t.nodes[2].open(id)).state)).toBe('Private start');
  });
  it('rekeys twice, keeps archive/history across restarts and never restores banned edit access', async () => {
    const t = setup(), id = await t.create(), a = await t.nodes[0].open(id); await t.nodes[0].snapshot(a.token, 'Local history');
    await t.nodes[0].changePolicy(id, a.policyId, a.title, t.ids, true); await t.pump();
    t.banned.push(t.ids[2]); t.transition(0, 'new-secret-topic');
    const migrated = await t.nodes[0].poll(a.token); expect(migrated.archived).toBe(true); expect(migrated.writers).not.toContain(t.ids[2]);
    expect((await t.nodes[0].history(a.token))[0].label).toBe('Local history');
    t.start(0); const reopened = await t.nodes[0].open(id); expect(reopened.archived).toBe(true);
    t.transition(0, 'third-secret-topic'); await t.nodes[0].peer(t.ids[1]); await t.pump();
    expect(text((await t.nodes[1].open(id)).state)).toBe('start'); expect((await t.nodes[0].history(reopened.token))).toHaveLength(1);
    t.start(1); expect((await t.nodes[1].open(id)).archived).toBe(true);
  });
  it('keeps the latest state on a return transfer and rejects replayed records from that previous owner', async () => {
    const t = setup(), id = await t.create(), original = structuredClone(t.stores[0].get(id)!.checkpoint);
    t.transition(1, 'authority-generation-b'); await t.nodes[1].peer(t.ids[0]); await t.pump();
    const successor = await t.nodes[1].open(id); await t.nodes[1].update(successor.token, edit(successor.state, 'Successor ')); await t.pump();
    t.transition(0, 'authority-generation-c'); const local = await t.nodes[2].open(id);
    await expect(deliverRecord(t.nodes[2], t.ids[0], original)).rejects.toThrow('owner'); expect(text((await t.nodes[2].poll(local.token)).state)).toBe('Successor start');
    await t.nodes[0].peer(t.ids[2]); await t.pump(); expect(text((await t.nodes[2].poll(local.token)).state)).toBe('Successor start');
    expect((await t.nodes[2].poll(local.token)).recovering).toBeUndefined();
  });
  it('keeps a read-only recovery copy exportable while the new owner is offline', async () => {
    const t = setup(), id = await t.create(), a = await t.nodes[2].open(id); t.transition(1, 'new-topic');
    expect((await t.nodes[2].poll(a.token)).recovering).toBe(true); await expect(t.nodes[2].update(a.token, edit(a.state, 'x'))).rejects.toThrow('access');
    expect((await t.nodes[2].exportText(a.token)).text).toBe('start');
    await t.nodes[2].keepDraft(a.token, 'Last half-second of typing');
    t.start(2); const reopened = await t.nodes[2].open(id); expect(reopened.blockedPending).toBe(true); expect(text(reopened.state)).toBe('Last half-second of typing');
    await expect(t.nodes[2].reviewDraft(reopened.token, 'discard')).rejects.toThrow('authorized');
  });
  it('does not erase the source on a failed destination write and resumes idempotently', async () => {
    const t = setup(), id = await t.create(); t.fail(1); t.transition(1, 'rotated');
    await expect(t.nodes[1].view()).rejects.toThrow('Protected'); expect(t.stores[1].size).toBe(0); expect(t.sources[1][0].persistence.list()).toContain(id);
    t.fail(-1); t.start(1); const a = await t.nodes[1].open(id); expect(text(a.state)).toBe('start');
    const saved = structuredClone(t.stores[1].get(id)); t.start(1); expect(t.stores[1].get(id)).toEqual(saved);
  });
  it('resumes a partially copied catalog without rewriting the documents already committed', async () => {
    const t = setup(), first = await t.create(); const second = await t.nodes[0].create('Second', 'text', 'two', t.ids); await t.pump();
    t.fail(1, 1); t.transition(1, 'next-topic'); await expect(t.nodes[1].view()).rejects.toThrow('Protected');
    expect(t.stores[1].size).toBe(1); const committed = structuredClone(t.stores[1].get(first));
    t.fail(-1); t.start(1); expect((await t.nodes[1].view()).items).toHaveLength(2); expect(t.stores[1].get(first)).toEqual(committed);
    expect(text((await t.nodes[1].open(second.documentId)).state)).toBe('two');
  });
  it('rejects forged old proofs and unrelated recovery pointers before migration', async () => {
    const t = setup(), id = await t.create(); t.stores[1].get(id)!.checkpoint.sig = Buffer.alloc(64).toString('base64'); t.transition(1);
    await expect(t.nodes[1].view()).rejects.toThrow('Protected'); expect(t.stores[1].size).toBe(0);
    await t.nodes[2].view(); t.stores[2].get(id)!.recovery!.key = 'a'.repeat(64); t.start(2); await expect(t.nodes[2].view()).rejects.toThrow('Protected');
  });
  it('coalesces long offline typing instead of exhausting one pending slot per autosave', async () => {
    const t = setup(), id = await t.create(), a = await t.nodes[1].open(id); t.offline.add(0);
    let state = a.state;
    for (let i = 0; i < 260; i++) { state = (await t.nodes[1].update(a.token, edit(state, 'x'))).state; await t.pump(); }
    expect((await t.nodes[1].poll(a.token)).pending).toBeLessThanOrEqual(32); t.start(1);
    const reopened = await t.nodes[1].open(id); expect(text(reopened.state)).toBe('x'.repeat(260) + 'start');
    t.offline.delete(0); await t.nodes[1].peer(t.ids[0]); await t.pump();
    expect((await t.nodes[1].poll(reopened.token)).pending).toBe(0); expect(text((await t.nodes[0].open(id)).state)).toBe('x'.repeat(260) + 'start');
  });
  it('retries reordered dependent updates without rejecting the offline draft', async () => {
    const t = setup(), id = await t.create(), a = await t.nodes[1].open(id); t.offline.add(0);
    const first = await t.nodes[1].update(a.token, edit(a.state, 'first ')); await t.nodes[1].update(a.token, edit(first.state, 'second ')); await t.pump();
    const pending = t.stores[1].get(id)!.pending; expect(pending.length).toBe(2); t.offline.delete(0);
    await t.nodes[0].receive(t.ids[1], { kind: 'proposal', proposal: pending[1].proposal }); await t.pump();
    expect((await t.nodes[1].poll(a.token)).blockedPending).toBe(false);
    await t.nodes[1].peer(t.ids[0]); await t.pump(); const result = await t.nodes[1].poll(a.token);
    expect(result.pending).toBe(0); expect(text(result.state)).toBe('second first start');
  });
  it('keeps unsent text as a bounded local snapshot even after edit access is revoked', async () => {
    const t = setup(), id = await t.create(), owner = await t.nodes[0].open(id), a = await t.nodes[1].open(id);
    await t.nodes[0].changePolicy(id, owner.policyId, owner.title, [t.ids[0]], false); await t.pump();
    for (let i = 0; i < 22; i++) await t.nodes[1].keepDraft(a.token, 'unsent ' + i);
    await t.nodes[1].keepDraft(a.token, 'unsent 21'); const snapshots = await t.nodes[1].history(a.token);
    expect(snapshots).toHaveLength(20); expect(snapshots[0].text).toBe('unsent 21'); expect(t.stores[0].get(id)!.snapshots).toHaveLength(0);
    t.start(1); expect((await t.nodes[1].history((await t.nodes[1].open(id)).token))[0].text).toBe('unsent 21');
  });
  it('detects tampering with protected confirmed and working state before exposing an editor', async () => {
    const t = setup(), id = await t.create(); t.stores[1].get(id)!.working = materializeDocument({ updates: [], replace: 'changed' }).state;
    t.start(1); await expect(t.nodes[1].open(id)).rejects.toThrow('Protected');
    t.stores[2].get(id)!.state = 'AAAA'; t.start(2); await expect(t.nodes[2].view()).rejects.toThrow('Protected');
  });
  it('merges concurrent authors and confirms both without losing text', async () => {
    const t = setup(), id = await t.create(), a = await t.nodes[1].open(id), b = await t.nodes[2].open(id);
    await Promise.all([t.nodes[1].update(a.token, edit(a.state, 'Alice ')), t.nodes[2].update(b.token, edit(b.state, 'Bob '))]); await t.pump();
    const left = await t.nodes[1].poll(a.token), right = await t.nodes[2].poll(b.token);
    expect(text(left.state)).toBe(text(right.state)); expect(text(left.state)).toContain('Alice '); expect(text(left.state)).toContain('Bob '); expect(left.pending).toBe(0); expect(left.seq).toBe(2);
  });
  it('persists offline work across a restart and retries it after the owner returns', async () => {
    const t = setup(), id = await t.create(); t.offline.add(0); const a = await t.nodes[1].open(id);
    const changed = await t.nodes[1].update(a.token, edit(a.state, 'Offline ')); expect(changed.localDraft).toBe(true); await t.pump();
    t.start(1); const reopened = await t.nodes[1].open(id); expect(text(reopened.state)).toBe('Offline start'); expect(reopened.pending).toBe(1);
    t.offline.delete(0); await t.nodes[1].peer(t.ids[0]); await t.pump(); expect((await t.nodes[1].poll(reopened.token)).pending).toBe(0);
  });
  it('preserves a draft when rights change, and requires explicit review', async () => {
    const t = setup(), id = await t.create(), a = await t.nodes[1].open(id), owner = await t.nodes[0].open(id);
    t.offline.add(1); await t.nodes[1].update(a.token, edit(a.state, 'Private '));
    await t.nodes[0].changePolicy(id, owner.policyId, 'Renamed', [t.ids[0]], false); await t.pump();
    t.offline.delete(1); await t.nodes[1].peer(t.ids[0]); await t.pump(); const denied = await t.nodes[1].poll(a.token);
    expect(denied.blockedPending).toBe(true); expect(denied.writable).toBe(false); expect(text(denied.state)).toBe('Private start');
    await expect(t.nodes[1].reviewDraft(a.token, 'apply')).rejects.toThrow('authorized');
    const reviewed = await t.nodes[1].reviewDraft(a.token, 'discard'); expect(text(reviewed.state)).toBe('start'); expect(reviewed.pending).toBe(0);
    expect((await t.nodes[1].history(a.token))[0].text).toBe('Private start');
  });
  it('restores a local snapshot as a new synchronized edit', async () => {
    const t = setup(), id = await t.create(), a = await t.nodes[0].open(id); const s = await t.nodes[0].snapshot(a.token, 'Before change');
    await t.nodes[0].update(a.token, edit(a.state, 'new ')); await t.pump();
    const restored = await t.nodes[0].restoreSnapshot(a.token, s.id); await t.pump();
    expect(text(restored.state)).toBe('start'); expect(restored.seq).toBe(2); expect(text((await t.nodes[2].open(id)).state)).toBe('start');
  });
  it('compacts commit tails and reconnects a client that missed the entire tail', async () => {
    const t = setup(), id = await t.create(), a = await t.nodes[0].open(id); t.offline.add(2);
    let state = a.state; for (let i = 0; i < 66; i++) { const next = await t.nodes[0].update(a.token, edit(state, 'x')); state = next.state; await t.pump(); }
    expect(t.stores[0].get(id)!.commits.length).toBe(2); expect(t.stores[0].get(id)!.checkpoint.seq).toBe(64);
    t.offline.delete(2); await t.nodes[2].peer(t.ids[0]); await t.pump(); expect(text((await t.nodes[2].open(id)).state)).toBe('x'.repeat(66) + 'start');
    t.start(0); expect(text((await t.nodes[0].open(id)).state)).toBe('x'.repeat(66) + 'start');
  });
  it('receives large checkpoints in reversed multipart order and rejects corruption', async () => {
    const t = setup(); t.offline.add(1); const id = await t.nodes[0].create('Large', 'text', 'я'.repeat(50000), t.ids); await t.nodes[0].idle(); await new Promise(resolve => setTimeout(resolve, 0));
    const packets = t.bus.filter(p => p.body.kind === 'part'); expect(packets.length).toBeGreaterThan(1);
    for (const p of [...packets].reverse()) await t.nodes[1].receive(p.from, p.body);
    expect(text((await t.nodes[1].open(id.documentId)).state)).toBe('я'.repeat(50000));
    const cp = structuredClone(t.stores[0].get(id.documentId)!.checkpoint); cp.state = edit(cp.state, 'tampered');
    await expect(deliverRecord(t.nodes[2], t.ids[0], cp)).rejects.toThrow('owner');
  });
  it('binds signed checkpoints to the room and rejects same-sequence owner forks', async () => {
    const t = setup(), id = await t.create(), cp = t.stores[0].get(id)!.checkpoint;
    expect(verifyDocumentRecord('other-room', t.ids[0], cp)).toBe(false);
    const changed = materializeDocument({ state: cp.state, updates: [], replace: 'fork' });
    const fork = signDocumentRecord<DocumentCheckpoint>('test-scope', { ...cp, state: changed.state }, t.identities[0]);
    await expect(deliverRecord(t.nodes[1], t.ids[0], fork)).rejects.toThrow('Conflicting');
    await expect(deliverRecord(t.nodes[1], t.ids[2], cp)).rejects.toThrow('owner');
  });
  it('does not acknowledge an update that failed to persist and blocks later writes', async () => {
    const t = setup(), id = await t.create(), a = await t.nodes[1].open(id); t.fail(1);
    await expect(t.nodes[1].update(a.token, edit(a.state, 'unsaved'))).rejects.toThrow('disk full');
    expect(t.stores[1].get(id)!.text).toBe('start'); await expect(t.nodes[1].poll(a.token)).rejects.toThrow('Protected');
    t.fail(-1); t.start(1); expect(text((await t.nodes[1].open(id)).state)).toBe('start');
  });
  it('uses authenticated member names for cursor views and expires document tokens', async () => {
    const t = setup(), id = await t.create(), a = await t.nodes[0].open(id), b = await t.nodes[1].open(id), doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(b.state, 'base64'));
    const position = Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.getText('text'), 2))).toString('base64');
    await t.nodes[1].presence(b.token, { clientId: doc.clientID, anchor: position, head: position }); await t.pump();
    expect((await t.nodes[0].poll(a.token)).cursors[0]).toMatchObject({ memberId: t.ids[1], name: 'Person 1' });
    t.nodes[1].closeDocument(b.token); await t.pump(); expect((await t.nodes[0].poll(a.token)).cursors).toHaveLength(0);
    await expect(t.nodes[1].poll(b.token)).rejects.toThrow('expired'); doc.destroy();
  });
  it('enforces owner-only creation, archive rights and stale policy guards', async () => {
    const t = setup(); await expect(t.nodes[1].create('No', 'text', '', t.ids)).rejects.toThrow('authorized');
    const id = await t.create(), a = await t.nodes[0].open(id); await t.nodes[0].changePolicy(id, a.policyId, 'Archived', t.ids, true); await t.pump();
    await expect(t.nodes[0].update(a.token, edit(a.state, 'no'))).rejects.toThrow('access');
    await expect(t.nodes[0].changePolicy(id, a.policyId, 'Old', t.ids, false)).rejects.toThrow('changed');
    expect((await t.nodes[2].open(id)).archived).toBe(true);
    await expect(t.nodes[0].receive('f'.repeat(32), { kind: 'catalog' })).rejects.toThrow('Unknown');
  });
});
describe('bounded plain-text Yjs model', () => {
  it('keeps Unicode and canonical LF offsets, rejecting carriage returns and idempotently replaying updates', () => {
    const initial = materializeDocument({ updates: [], replace: 'Привет 🙂\nтекст\t✓' });
    expect(initial.text).toBe('Привет 🙂\nтекст\t✓'); expect(materializeDocument({ state: initial.state, updates: [initial.state] }).changed).toBe(false);
    expect(() => materializeDocument({ updates: [], replace: 'a\r\nb' })).toThrow();
  });
  it.each(['binary', 'format', 'root', 'oversize', 'dependencies'])('rejects %s content', kind => {
    const doc = new Y.Doc(), value = doc.getText('text'); let update: Uint8Array;
    if (kind === 'binary') value.insertEmbed(0, new Uint8Array([1]));
    if (kind === 'format') value.insert(0, 'rich', { bold: true });
    if (kind === 'root') doc.getMap('extra').set('x', 1);
    if (kind === 'oversize') value.insert(0, 'я'.repeat(140000));
    if (kind === 'dependencies') { value.insert(0, 'a'); const vector = Y.encodeStateVector(doc); value.insert(1, 'b'); update = Y.encodeStateAsUpdate(doc, vector); }
    else update = Y.encodeStateAsUpdate(doc);
    expect(() => materializeDocument({ updates: [Buffer.from(update).toString('base64')] })).toThrow(); doc.destroy();
  });
  it('own undo preserves a concurrent remote edit', () => {
    const a = new Y.Doc(), b = new Y.Doc(), source = materializeDocument({ updates: [], replace: 'base' });
    Y.applyUpdate(a, Buffer.from(source.state, 'base64')); Y.applyUpdate(b, Buffer.from(source.state, 'base64'));
    const undo = new Y.UndoManager(a.getText('text'), { trackedOrigins: new Set(['local']) });
    a.transact(() => a.getText('text').insert(0, 'mine '), 'local'); b.getText('text').insert(0, 'theirs '); Y.applyUpdate(a, Y.encodeStateAsUpdate(b), 'remote'); undo.undo();
    expect(a.getText('text').toString()).toBe('theirs base'); undo.destroy(); a.destroy(); b.destroy();
  });
});

async function readOnlyFixture() {
  const t = setup(), id = await t.create(), owner = await t.nodes[0].open(id);
  await t.nodes[0].changePolicy(id, owner.policyId, owner.title, [t.ids[0]], false); await t.pump();
  return { ...t, id, reader: await t.nodes[1].open(id) };
}
describe('explicit document access requests', () => {
  it('distinguishes sent from owner receipt and never grants access without a signed owner policy', async () => {
    const t = await readOnlyFixture();
    expect(t.reader.writable).toBe(false);
    expect((await t.nodes[1].requestAccess(t.id, t.reader.policyId)).own?.status).toBe('sent');
    await t.pump();
    expect((await t.nodes[1].poll(t.reader.token)).access?.own?.status).toBe('received');
    const owner = await t.nodes[0].open(t.id);
    expect(owner.access?.pending.map(r => r.memberId)).toEqual([t.ids[1]]);
    expect((await t.nodes[0].view()).items[0].accessRequestCount).toBe(1);
    expect((await t.nodes[1].poll(t.reader.token)).writable).toBe(false);
    await expect(t.nodes[1].dismissAccess(t.id, owner.access!.pending[0].requestId)).rejects.toThrow('authorized');
    await t.nodes[0].changePolicy(t.id, owner.policyId, owner.title, [t.ids[0], t.ids[1]], false); await t.pump();
    expect((await t.nodes[1].poll(t.reader.token)).writable).toBe(true);
    expect((await t.nodes[2].open(t.id)).writable).toBe(false);
    expect((await t.nodes[0].view()).items[0].accessRequestCount).toBe(0);
  });
  it('refuses offline, old-client, archived, stale-policy and banned requests before sending', async () => {
    const t = await readOnlyFixture();
    const request = () => t.nodes[1].requestAccess(t.id, t.reader.policyId);
    t.offline.add(0); await expect(request()).rejects.toThrow('unavailable'); t.offline.clear();
    t.unsupported.add(0); await expect(request()).rejects.toThrow('unavailable'); t.unsupported.clear();
    t.banned.push(t.ids[1]); await expect(request()).rejects.toThrow('unavailable'); t.banned.length = 0;
    await expect(t.nodes[1].requestAccess(t.id, '0'.repeat(64))).rejects.toThrow('unavailable');
    const owner = await t.nodes[0].open(t.id);
    await t.nodes[0].changePolicy(t.id, owner.policyId, owner.title, [t.ids[0]], true); await t.pump();
    await expect(request()).rejects.toThrow('unavailable');
    expect(t.bus.filter(m => m.body.kind === 'access-request')).toHaveLength(0);
  });
  it('ignores forged receipts and prevents repeated requests across documents', async () => {
    const t = await readOnlyFixture(); await t.nodes[1].requestAccess(t.id, t.reader.policyId);
    const body = t.bus.find(m => m.body.kind === 'access-request')!.body;
    if (body.kind !== 'access-request') throw Error('Missing request');
    await t.nodes[1].receive(t.ids[2], { kind: 'access-receipt', documentId: t.id, policyId: body.policyId, requestId: body.requestId, status: 'received' });
    expect((await t.nodes[1].poll(t.reader.token)).access?.own?.status).toBe('sent');
    await t.pump(); await t.nodes[0].dismissAccess(t.id, body.requestId); await t.pump();
    expect((await t.nodes[1].poll(t.reader.token)).access?.own?.status).toBe('declined');
    await expect(t.nodes[1].requestAccess(t.id, t.reader.policyId)).rejects.toThrow('unavailable');
    const second = await t.nodes[0].create('Second', 'text', '', [t.ids[0]]); await t.pump();
    const reader = await t.nodes[1].open(second.documentId);
    await expect(t.nodes[1].requestAccess(second.documentId, reader.policyId)).rejects.toThrow('unavailable');
  });
  it('rejects replay after decline, then accepts a fresh request and expires old inbox entries', async () => {
    const t = await readOnlyFixture(); let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const request = { kind: 'access-request', documentId: t.id, policyId: t.reader.policyId, requestId: crypto.randomUUID(), at: now + 50_000 } as const;
    await t.nodes[0].receive(t.ids[1], request); await t.pump();
    expect((await t.nodes[0].view()).items[0].accessRequestCount).toBe(1);
    await t.nodes[0].dismissAccess(t.id, request.requestId); await t.pump();
    now += 60_001; await t.nodes[0].receive(t.ids[1], request); await t.pump();
    expect((await t.nodes[0].view()).items[0].accessRequestCount).toBe(0);
    await t.nodes[0].receive(t.ids[1], { ...request, requestId: crypto.randomUUID(), at: now }); await t.pump();
    expect((await t.nodes[0].view()).items[0].accessRequestCount).toBe(1);
    now += 600_001;
    expect((await t.nodes[0].view()).items[0].accessRequestCount).toBe(0);
  });
});
