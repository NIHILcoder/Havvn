import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db/secrets', () => ({ encryptSecret: () => { throw new Error('Use fixture persistence'); }, decryptSecretStrict: () => { throw new Error('Use fixture persistence'); } }));
import { RoomSyncStore, type SyncPersistence } from '../db/room-sync-store';
import { RoomSyncSession } from './room-sync-session';
import { RoomSyncApplier } from './room-sync-apply';
import { RoomSyncTrash } from './room-sync-trash';
import { deriveMemberId } from './room-crypto';
import { generateRoomSecret } from './room-e2e';
import { contentKeyEpoch } from './room-keyring';
import { signSyncRevision } from './room-sync-proofs';
import { prepareSyncSnapshot } from './room-sync-snapshot';
import { syncWorkQueue } from './room-sync-work';

function identity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { pub, priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
const publisher = identity(), receiver = identity();
class Persistence implements SyncPersistence {
  data: unknown; fail = false;
  read() { return structuredClone(this.data); }
  write(value: unknown) { if (this.fail) throw new Error('disk full'); this.data = structuredClone(value); }
}
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sync-session-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
function setup(e2e = false) {
  const context = { scope: 'room-context', rootId: crypto.randomUUID(), ownerId: deriveMemberId(publisher.pub), e2e };
  const out = new Persistence(), incoming = new Persistence();
  const senderStore = new RoomSyncStore(out, 'sender-local-room-id', context), receiverStore = new RoomSyncStore(incoming, 'receiver-local-room-id', context);
  const secret = e2e ? generateRoomSecret() : undefined;
  const publisherPath = path.join(root, 'publisher'), receiverPath = path.join(root, 'receiver');
  fs.mkdirSync(publisherPath); fs.mkdirSync(receiverPath);
  senderStore.bind(publisherPath); receiverStore.bind(receiverPath); receiverStore.setAutoApply(true);
  let live = true;
  const sender = new RoomSyncSession({ context, store: senderStore, storage: path.join(root, 'outgoing'), identity: publisher,
    isCurrent: () => live, contentSecret: () => secret!, resolveSecret: epoch => secret && epoch === contentKeyEpoch(secret) ? secret : undefined });
  const options = { context, store: receiverStore, storage: path.join(root, 'incoming'), identity: receiver, isCurrent: () => live, contentSecret: () => secret!,
    resolveSecret: (epoch: string) => secret && epoch === contentKeyEpoch(secret) ? secret : undefined };
  const received = new RoomSyncSession(options);
  sender.createRoot('Configs'); receiverStore.acceptPolicy(senderStore.policy());
  fs.writeFileSync(path.join(publisherPath, 'config.ini'), 'first config');
  return { context, out, incoming, senderStore, receiverStore, sender, received, publisherPath, receiverPath,
    options, secret, cancel: () => { live = false; } };
}

async function deletionSetup(e2e = false) {
  const f = setup(e2e), first = await f.sender.publish('config.ini');
  f.receiverStore.acceptRevision(first.revision); await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
  await f.sender.changeWriters([deriveMemberId(publisher.pub), deriveMemberId(receiver.pub)].sort(), f.sender.rightsStamp(), true, true);
  f.receiverStore.acceptRecords(f.senderStore.records()); f.receiverStore.setAutoApply(true);
  return { ...f, first, entry: first.revision.entryId };
}

async function pathFixture(e2e = false, relativePath = 'config.ini') {
  const f = await deletionSetup(e2e), source = path.join(root, 'competing', relativePath.split('/').at(-1)!); fs.mkdirSync(path.dirname(source)); fs.writeFileSync(source, 'second independent document');
  const snapshot = await prepareSyncSnapshot({ source, storage: path.join(root, 'outgoing'), authorId: deriveMemberId(receiver.pub), secret: f.secret });
  const second = signSyncRevision(f.context.scope, { v: 6, rootId: f.context.rootId, policyId: f.senderStore.policy()!.policyId, entryId: crypto.randomUUID(), parents: [],
    relativePath, op: 'put', blob: { infoHash: snapshot.file.infoHash, name: snapshot.file.name, size: snapshot.file.size, enc: !!snapshot.file.enc, keyEpoch: snapshot.file.keyEpoch ?? null },
    authorId: deriveMemberId(receiver.pub), createdAt: Date.now(), pub: receiver.pub }, receiver.priv);
  f.senderStore.acceptRevision(second); f.receiverStore.acceptRevision(second);
  await f.sender.retainHistorical(second.revisionId, snapshot.sourcePath, snapshot.metadata, 'path');
  await f.received.retainHistorical(second.revisionId, snapshot.sourcePath, snapshot.metadata, 'path');
  return { ...f, second };
}

it('cancels queued session operations before writing and resumes once after a restart', async () => {
  const f = setup(); let finish!: () => void;
  const blocker = syncWorkQueue.run({ owner: {} }, () => new Promise<void>(resolve => { finish = resolve; }));
  const first = f.sender.publish('config.ini').catch(error => error.message), second = f.sender.publish('config.ini').catch(error => error.message);
  try {
    await vi.waitFor(() => expect(f.sender.workView()?.waiting).toBe(1)); await f.sender.cancelWork();
    expect(await first).toBe('Sync preparation canceled'); expect(await second).toBe('Sync preparation canceled');
    expect(f.senderStore.heads()).toEqual([]); expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('first config');
    expect(fs.existsSync(path.join(root, 'outgoing'))).toBe(false);
  } finally { finish(); await blocker; }
  const published = await f.sender.publish('config.ini');
  const restarted = new RoomSyncSession({ context: f.context, store: f.senderStore, storage: path.join(root, 'outgoing'), identity: publisher, isCurrent: () => true });
  const replay = await restarted.publish('config.ini'); expect(replay.snapshot).toBeNull();
  expect(replay.revision.revisionId).toBe(published.revision.revisionId); expect(f.senderStore.heads()).toHaveLength(1);
});

it('reports a failed private-snapshot cleanup to both the operation and its cancel command', async () => {
  const f = setup(), copy = fs.promises.copyFile.bind(fs.promises), rm = fs.promises.rm.bind(fs.promises);
  let finish!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; }), copying = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce(async (...args) => { entered(); await gate; await copy(...args); });
  vi.spyOn(fs.promises, 'rm').mockImplementation(async (candidate, ...args) => {
    if (String(candidate).startsWith(path.join(root, 'outgoing', 'snapshot-'))) throw Error('cleanup denied');
    return rm(candidate, ...args);
  });
  const publication = f.sender.publish('config.ini').catch(error => error.message);
  await copying; const canceled = f.sender.cancelWork().catch(error => error.message); finish();
  expect(await publication).toBe('cleanup denied'); expect(await canceled).toBe('cleanup denied'); expect(f.senderStore.heads()).toEqual([]);
});

it('cancels a publication still recovering its binding before it enters the preparation queue', async () => {
  const f = setup(); let finish!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; }), recovering = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(RoomSyncApplier.prototype, 'recover').mockImplementationOnce(async () => { entered(); await gate; return []; });
  const publication = f.sender.publish('config.ini').catch(error => error.message);
  await recovering; const canceled = f.sender.cancelWork(); finish(); await canceled;
  expect(await publication).toBe('Sync preparation canceled'); expect(f.senderStore.heads()).toEqual([]);
  expect(fs.existsSync(path.join(root, 'outgoing'))).toBe(false);
});

describe('reviewed path conflict resolution', () => {
  it('redirects an incoming child away from an existing file that occupies its parent path', async () => {
    const f = await pathFixture(false, 'config.ini/child.ini'); expect(f.senderStore.pathConflicts()).toHaveLength(2);
    await expect(f.sender.preparePathResolution(f.second.revisionId, 'config.ini/other.ini')).rejects.toThrow();
    const result = await f.sender.resolvePath(await f.sender.preparePathResolution(f.second.revisionId, 'copies/child.ini'));
    expect(f.senderStore.pathConflicts()).toEqual([]); expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('first config');
    expect(fs.readFileSync(path.join(f.publisherPath, 'copies/child.ini'), 'utf8')).toBe('second independent document');
    f.receiverStore.acceptRevision(result.revision); await f.received.applyReceived(result.revision.revisionId, result.snapshot.sourcePath, result.snapshot.metadata);
    expect(fs.readFileSync(path.join(f.receiverPath, 'copies/child.ini'), 'utf8')).toBe('second independent document');
  });
  it.each([false, true])('keeps both independent documents and stable history through receive/restart (E2E %s)', async encrypted => {
    const f = await pathFixture(encrypted), guard = await f.sender.preparePathResolution(f.second.revisionId, 'copies/second.ini');
    const result = await f.sender.resolvePath(guard);
    expect(result.revision.entryId).toBe(f.second.entryId); expect(result.revision.parents).toEqual([f.second.revisionId]);
    expect(f.senderStore.pathConflicts()).toEqual([]); expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('first config');
    expect(fs.readFileSync(path.join(f.publisherPath, 'copies/second.ini'), 'utf8')).toBe('second independent document');
    f.receiverStore.acceptRevision(result.revision); await f.received.applyReceived(result.revision.revisionId, result.snapshot.sourcePath, result.snapshot.metadata);
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('first config');
    expect(fs.readFileSync(path.join(f.receiverPath, 'copies/second.ini'), 'utf8')).toBe('second independent document');
    const store = new RoomSyncStore(f.incoming, 'receiver-local-room-id', f.context), session = new RoomSyncSession({ ...f.options, store });
    await session.recoverApplied(); expect(store.applied().find(a => a.entryId === f.second.entryId)?.revisionId).toBe(result.revision.revisionId);
  });
  it('preserves late local edits and defers the other document when renaming the applied entry', async () => {
    const f = await pathFixture(), guard = await f.sender.preparePathResolution(f.first.revision.revisionId, 'first-copy.ini');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'unpublished local edit');
    const result = await f.sender.resolvePath(guard);
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('unpublished local edit');
    expect(fs.readFileSync(path.join(f.publisherPath, 'first-copy.ini'), 'utf8')).toBe('first config');
    expect(f.senderStore.deferred()).toContain(f.second.entryId); await expect(f.sender.publish('config.ini')).rejects.toThrow('base');
    f.receiverStore.acceptRevision(result.revision); await f.received.applyReceived(result.revision.revisionId, result.snapshot.sourcePath, result.snapshot.metadata);
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('first config'); expect(f.receiverStore.deferred()).toContain(f.second.entryId);
    const preview = await f.received.prepareConflict(f.second.revisionId), resolved = await f.received.resolveConflict(preview.guard, 'keep-both');
    expect(fs.readFileSync(path.join(f.receiverPath, resolved.copyPath!), 'utf8')).toBe('first config');
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('second independent document');
  });
  it.each(['occupied', 'head', 'rights', 'binding', 'excluded'] as const)('refuses a stale review after %s without touching existing bytes', async change => {
    const f = await pathFixture(), guard = await f.sender.preparePathResolution(f.second.revisionId, 'second.ini');
    if (change === 'occupied') fs.writeFileSync(path.join(f.publisherPath, 'second.ini'), 'new unshared file');
    if (change === 'head') f.senderStore.acceptRevision(signSyncRevision(f.context.scope, { ...f.second, parents: [f.second.revisionId], createdAt: f.second.createdAt + 1 }, receiver.priv));
    if (change === 'rights') await f.sender.changeWriters([deriveMemberId(publisher.pub)], f.sender.rightsStamp());
    if (change === 'binding') { f.senderStore.bind(null); f.senderStore.bind(f.publisherPath); }
    if (change === 'excluded') f.senderStore.setExclusions(['second.ini']);
    await expect(f.sender.resolvePath(guard)).rejects.toThrow();
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('first config');
    expect(fs.existsSync(path.join(f.publisherPath, 'second.ini'))).toBe(change === 'occupied');
  });
  it('rejects overlapping destinations and corrupt retained contents', async () => {
    const f = await pathFixture();
    for (const target of ['CONFIG.INI', 'config.ini/child', '../escape', '.havvn-sync/private']) await expect(f.sender.preparePathResolution(f.second.revisionId, target)).rejects.toThrow();
    const guard = await f.sender.preparePathResolution(f.second.revisionId, 'second.ini');
    fs.writeFileSync(f.senderStore.sources().find(s => s.revisionId === f.second.revisionId)!.path, 'corrupt');
    await expect(f.sender.resolvePath(guard)).rejects.toThrow(); expect(fs.existsSync(path.join(f.publisherPath, 'second.ini'))).toBe(false);
  });
  it('refuses linked destinations and a new colliding head arriving during staging', async () => {
    const f = await pathFixture(), outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel'), 'unrelated');
    fs.symlinkSync(outside, path.join(f.publisherPath, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.sender.preparePathResolution(f.second.revisionId, 'linked/copy.ini')).rejects.toThrow('Linked');
    const guard = await f.sender.preparePathResolution(f.second.revisionId, 'race.ini'), apply = RoomSyncApplier.prototype.apply;
    vi.spyOn(RoomSyncApplier.prototype, 'apply').mockImplementationOnce(function(request) { return apply.call(this, request, step => {
      if (step === 'prepared') f.senderStore.acceptRevision(signSyncRevision(f.context.scope, { ...f.second, entryId: crypto.randomUUID(), relativePath: 'race.ini',
        blob: { ...f.second.blob!, name: 'race.ini' }, createdAt: f.second.createdAt + 1 }, receiver.priv));
    }); });
    await expect(f.sender.resolvePath(guard)).rejects.toThrow('canceled');
    expect(fs.existsSync(path.join(f.publisherPath, 'race.ini'))).toBe(false); expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('unrelated');
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('first config');
  });
  it('joins concurrent move heads at a new path and does not republish preserved old paths', async () => {
    const f = await deletionSetup(), leftMove = await f.sender.moveFile(await f.sender.prepareMove(f.entry, 'left.ini'));
    const rightMove = await f.received.moveFile(await f.received.prepareMove(f.entry, 'right.ini'));
    f.senderStore.acceptRevision(rightMove.revision); f.receiverStore.acceptRevision(leftMove.revision);
    await f.sender.retainHistorical(rightMove.revision.revisionId, rightMove.snapshot.sourcePath, rightMove.snapshot.metadata, 'path');
    const result = await f.sender.resolvePath(await f.sender.preparePathResolution(rightMove.revision.revisionId, 'resolved.ini'));
    expect(result.revision.parents).toHaveLength(2); expect(result.revision.previousPaths).toEqual(['left.ini', 'right.ini']);
    expect(fs.readFileSync(path.join(f.publisherPath, 'left.ini'), 'utf8')).toBe('first config');
    await expect(f.sender.publish('left.ini')).rejects.toThrow('Preserved move source');
    f.receiverStore.acceptRevision(result.revision); await f.received.applyReceived(result.revision.revisionId, result.snapshot.sourcePath, result.snapshot.metadata);
    expect(fs.readFileSync(path.join(f.receiverPath, 'resolved.ini'), 'utf8')).toBe('first config');
  });
  it('recovers a crash after publishing the destination without touching either source document', async () => {
    const f = await pathFixture(), guard = await f.sender.preparePathResolution(f.second.revisionId, 'recovered.ini'), apply = RoomSyncApplier.prototype.apply;
    vi.spyOn(RoomSyncApplier.prototype, 'apply').mockImplementationOnce(function(request) { return apply.call(this, request, step => { if (step === 'published') throw new Error('crashed'); }); });
    await expect(f.sender.resolvePath(guard)).rejects.toThrow('crashed'); await f.sender.recoverApplied();
    expect(fs.readFileSync(path.join(f.publisherPath, 'recovered.ini'), 'utf8')).toBe('second independent document');
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('first config');
    expect(f.senderStore.applied().find(a => a.entryId === f.second.entryId)?.revisionId).toBe(f.senderStore.heads().find(h => h.entryId === f.second.entryId)!.revisionIds[0]);
  });
});
describe('safe shared deletion', () => {
  it('does not publish a tombstone when the local trash preflight fails', async () => {
    const f = await deletionSetup(), preview = await f.sender.prepareDelete(f.entry);
    vi.spyOn(RoomSyncTrash.prototype, 'ensureCapacity').mockRejectedValueOnce(new Error('Sync trash size limit reached'));
    await expect(f.sender.confirmDelete(preview)).rejects.toThrow('size limit');
    expect(f.senderStore.heads()[0].revisionIds).toEqual([f.first.revision.revisionId]);
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('first config');
  });
  it.each([false, true])('deletes, restarts, restores content and pins trash snapshots through cache cleanup (E2E %s)', async encrypted => {
    const f = await deletionSetup(encrypted), result = await f.sender.confirmDelete(await f.sender.prepareDelete(f.entry));
    expect(result.revision.op).toBe('delete'); expect(result.revision.blob).toBeNull(); expect(result.revision.v).toBe(6);
    f.receiverStore.acceptRevision(result.revision); await f.received.applyDeletion(result.revision.revisionId);
    expect(fs.existsSync(path.join(f.publisherPath, 'config.ini'))).toBe(false); expect(fs.existsSync(path.join(f.receiverPath, 'config.ini'))).toBe(false);
    expect(f.receiverStore.applied()[0].digest).toBeNull();
    const store = new RoomSyncStore(f.incoming, 'receiver-local-room-id', f.context), session = new RoomSyncSession({ ...f.options, store });
    await session.recoverApplied(); expect(store.applied()[0].revisionId).toBe(result.revision.revisionId);
    const restored = await f.sender.restoreRevision(await f.sender.prepareRestore(f.first.revision.revisionId));
    expect(restored.revision.parents).toEqual([result.revision.revisionId]);
    f.receiverStore.acceptRevision(restored.revision); await f.received.applyReceived(restored.revision.revisionId, restored.snapshot.sourcePath, restored.snapshot.metadata);
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('first config');
    f.senderStore.setCacheLimit(0); await f.sender.cache(async () => true, true);
    expect(f.senderStore.sources().some(s => s.revisionId === f.first.revision.revisionId)).toBe(true);
    await f.sender.recoverApplied(); expect(f.senderStore.applied()[0].revisionId).toBe(restored.revision.revisionId);
  });
  it('rejects a stale preview without publishing or moving the later edit', async () => {
    const f = await deletionSetup(), preview = await f.sender.prepareDelete(f.entry);
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'saved after preview');
    await expect(f.sender.confirmDelete(preview)).rejects.toThrow('preview changed');
    expect(f.senderStore.heads()[0].revisionIds).toEqual([f.first.revision.revisionId]);
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('saved after preview');
  });
  it('keeps local edits until reviewed, then preserves a separate copy and trash bytes', async () => {
    const f = await deletionSetup(), result = await f.sender.confirmDelete(await f.sender.prepareDelete(f.entry));
    fs.writeFileSync(path.join(f.receiverPath, 'config.ini'), 'independent local edit'); f.receiverStore.acceptRevision(result.revision);
    await expect(f.received.applyDeletion(result.revision.revisionId)).rejects.toThrow('local changes');
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('independent local edit');
    const resolved = await f.received.confirmDelete(await f.received.prepareDelete(f.entry, true), true);
    expect(fs.readFileSync(path.join(f.receiverPath, ...resolved.copyPath!.split('/')), 'utf8')).toBe('independent local edit');
    expect(fs.existsSync(path.join(f.receiverPath, 'config.ini'))).toBe(false);
    const trash = path.join(f.receiverPath, '.havvn-sync', 'trash');
    expect(fs.readFileSync(path.join(trash, fs.readdirSync(trash)[0], 'previous'), 'utf8')).toBe('independent local edit');
  });
  it('retains edit/delete branches and explicitly restores one content branch over both', async () => {
    const f = await deletionSetup(), editor = await f.received.readEditor(f.entry);
    const removed = await f.sender.confirmDelete(await f.sender.prepareDelete(f.entry)), edited = await f.received.saveEditor(editor.guard, 'offline edit');
    f.receiverStore.acceptRevision(removed.revision); f.senderStore.acceptRevision(edited.revision);
    expect(f.senderStore.heads()[0].revisionIds).toHaveLength(2);
    await expect(f.received.applyDeletion(removed.revision.revisionId)).rejects.toThrow();
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('offline edit');
    await f.sender.retainHistorical(edited.revision.revisionId, edited.snapshot!.sourcePath, edited.snapshot!.metadata);
    const merged = await f.sender.restoreRevision(await f.sender.prepareRestore(edited.revision.revisionId));
    expect(merged.revision.parents).toHaveLength(2); expect(f.senderStore.heads()[0].revisionIds).toEqual([merged.revision.revisionId]);
  });
  it('carries tombstones through a v6 checkpoint and restores archived bytes', async () => {
    const f = await deletionSetup(), removed = await f.sender.confirmDelete(await f.sender.prepareDelete(f.entry));
    await f.sender.confirmCheckpoint(await f.sender.prepareCheckpoint()); expect(f.senderStore.policy()?.v).toBe(6);
    expect(f.senderStore.heads()[0].revisionIds).toEqual([removed.revision.revisionId]); await f.sender.recoverApplied();
    const restored = await f.sender.restoreRevision(await f.sender.prepareRestore(f.first.revision.revisionId));
    expect(restored.revision.v).toBe(6); expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('first config');
  });
  it('does not apply a deletion over a different entry at the same path, even with identical bytes', async () => {
    const f = await deletionSetup(), removed = await f.sender.confirmDelete(await f.sender.prepareDelete(f.entry));
    const another = signSyncRevision(f.context.scope, { v: 6, rootId: f.context.rootId, policyId: f.senderStore.policy()!.policyId,
      entryId: crypto.randomUUID(), parents: [], relativePath: 'config.ini', op: 'put', blob: f.first.revision.blob,
      authorId: f.context.ownerId, createdAt: Date.now(), pub: publisher.pub }, publisher.priv);
    f.receiverStore.acceptRevision(removed.revision); f.receiverStore.acceptRevision(another);
    await expect(f.received.applyDeletion(removed.revision.revisionId)).rejects.toThrow('path conflict');
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('first config');
  });
});

describe('verified file-sync session', () => {
  it('recovers a reviewed move after missing the intermediate move history at checkpoint cutover', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'), entry = first.revision.entryId;
    f.receiverStore.acceptRevision(first.revision); await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
    await f.sender.changeWriters([deriveMemberId(publisher.pub), deriveMemberId(receiver.pub)].sort(), f.sender.rightsStamp(), true); f.receiverStore.acceptRecords(f.senderStore.records());
    await f.sender.moveFile(await f.sender.prepareMove(entry, 'middle.ini'));
    const last = await f.sender.moveFile(await f.sender.prepareMove(entry, 'final.ini'));
    await f.sender.confirmCheckpoint(await f.sender.prepareCheckpoint()); f.receiverStore.acceptRecords(f.senderStore.records());
    expect(f.receiverStore.deferred()).toContain(entry); expect(f.receiverStore.revision(last.revision.parents[0])).toBeUndefined();
    await f.received.retainHistorical(last.revision.revisionId, last.snapshot.sourcePath, last.snapshot.metadata);
    const restored = await f.received.restoreRevision(await f.received.prepareRestore(last.revision.revisionId));
    expect(restored.revision.v).toBe(4); expect(fs.existsSync(path.join(f.receiverPath, 'config.ini'))).toBe(false);
    expect(fs.readFileSync(path.join(f.receiverPath, 'final.ini'), 'utf8')).toBe('first config');
    const store = new RoomSyncStore(f.incoming, 'receiver-local-room-id', f.context); await new RoomSyncSession({ ...f.options, store }).recoverApplied();
    expect(store.applied()[0].revisionId).toBe(restored.revision.revisionId);
  });
  it.each([false, true])('archives epochs, protects an offline editor branch, explicitly republishes it and restarts (E2E %s)', async encrypted => {
    const f = setup(encrypted), first = await f.sender.publish('config.ini'), entry = first.revision.entryId;
    f.receiverStore.acceptRevision(first.revision); await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
    await f.sender.changeWriters([deriveMemberId(publisher.pub), deriveMemberId(receiver.pub)].sort(), f.sender.rightsStamp()); f.receiverStore.acceptRecords(f.senderStore.records());
    const editor = await f.received.readEditor(entry), offline = await f.received.saveEditor(editor.guard, 'offline editor branch');
    const before = f.senderStore.records(), plan = await f.sender.prepareCheckpoint(); await f.sender.confirmCheckpoint(plan);
    expect(f.senderStore.records()).toHaveLength(1); expect(f.senderStore.retiredCount()).toBe(1); expect(f.senderStore.revision(first.revision.revisionId)).toEqual(first.revision);
    f.receiverStore.acceptRecords(f.senderStore.records()); expect(f.receiverStore.deferred()).toContain(entry);
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('offline editor branch');
    expect(f.receiverStore.binding()?.autoApply).toBe(false); await expect(f.received.publish('config.ini')).rejects.toThrow('Review');
    const restoredStore = new RoomSyncStore(f.incoming, 'receiver-local-room-id', f.context), restoredSession = new RoomSyncSession({ ...f.options, store: restoredStore });
    expect(restoredStore.revision(offline.revision.revisionId)).toEqual(offline.revision);
    const republished = await restoredSession.restoreRevision(await restoredSession.prepareRestore(offline.revision.revisionId));
    expect(republished.revision.v).toBe(4); expect(restoredStore.deferred()).toEqual([]);
    await restoredSession.recoverApplied(); f.senderStore.acceptRevision(republished.revision); f.senderStore.setAutoApply(true);
    await f.sender.applyReceived(republished.revision.revisionId, republished.snapshot.sourcePath, republished.snapshot.metadata);
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('offline editor branch');
    const again = await f.sender.prepareCheckpoint(); await f.sender.confirmCheckpoint(again);
    expect(f.senderStore.retiredCount()).toBe(2); expect(f.senderStore.historyRecords().filter(r => r.kind === 'revision')).toHaveLength(2);
    const reopened = new RoomSyncStore(f.out, 'sender-local-room-id', f.context);
    expect(reopened.records()).toHaveLength(1); expect(reopened.historyRecords().filter(r => r.kind === 'revision').map(r => r.value)).toEqual(expect.arrayContaining([first.revision, republished.revision]));
    expect(before.length).toBeGreaterThan(1); expect(reopened.checkpoint()?.checkpoint?.generation).toBe(2);
  });
  it.each([false, true])('moves the same entry across paths, catches up over skipped moves and restores content at its current name (E2E %s)', async encrypted => {
    const f = setup(encrypted), first = await f.sender.publish('config.ini');
    f.receiverStore.acceptRevision(first.revision); await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
    await f.sender.changeWriters([deriveMemberId(publisher.pub)], f.sender.rightsStamp(), true);
    f.receiverStore.acceptRecords(f.senderStore.records()); f.receiverStore.setAutoApply(true);
    const staleEditor = await f.sender.readEditor(first.revision.entryId);
    const move = await f.sender.moveFile(await f.sender.prepareMove(first.revision.entryId, 'nested/renamed.ini'));
    expect(move.revision).toMatchObject({ v: 3, entryId: first.revision.entryId, relativePath: 'nested/renamed.ini', previousPaths: ['config.ini'] });
    expect(fs.existsSync(path.join(f.publisherPath, 'config.ini'))).toBe(false);
    await expect(f.sender.saveEditor(staleEditor.guard, 'stale draft')).rejects.toThrow('changed');
    const second = await f.sender.moveFile(await f.sender.prepareMove(first.revision.entryId, 'final.ini'));
    const editor = await f.sender.readEditor(first.revision.entryId), edit = await f.sender.saveEditor(editor.guard, 'new content');
    f.receiverStore.acceptRecords(f.senderStore.records());
    await f.received.applyReceived(edit.revision.revisionId, edit.snapshot!.sourcePath, edit.snapshot!.metadata);
    expect(fs.existsSync(path.join(f.receiverPath, 'config.ini'))).toBe(false);
    expect(fs.existsSync(path.join(f.receiverPath, 'nested/renamed.ini'))).toBe(false);
    expect(fs.readFileSync(path.join(f.receiverPath, 'final.ini'), 'utf8')).toBe('new content');
    f.senderStore.compactLog(f.senderStore.prepareLogCompaction()); f.receiverStore.compactLog(f.receiverStore.prepareLogCompaction());
    expect(f.senderStore.logSummary().pending).toBe(0); expect(f.receiverStore.logSummary().pending).toBe(0);
    const restored = await f.sender.restoreRevision(await f.sender.prepareRestore(first.revision.revisionId));
    expect(restored.revision.relativePath).toBe('final.ini'); expect(restored.revision.entryId).toBe(first.revision.entryId);
    expect(fs.readFileSync(path.join(f.publisherPath, 'final.ini'), 'utf8')).toBe('first config');
    f.receiverStore.acceptRevision(restored.revision); await f.received.applyReceived(restored.revision.revisionId, restored.snapshot.sourcePath, restored.snapshot.metadata);
    expect(fs.readFileSync(path.join(f.receiverPath, 'final.ini'), 'utf8')).toBe('first config');
    expect(f.receiverStore.heads()).toEqual(f.senderStore.heads()); expect(f.senderStore.revision(second.revision.revisionId)).toEqual(second.revision);
    expect((await new RoomSyncSession(f.options).recoverApplied()).every(r => r.state === 'applied')).toBe(true);
  });
  it('rejects stale moves, edited sources, excluded paths and occupied targets before signing', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'), entry = first.revision.entryId;
    await expect(f.sender.prepareMove(entry, 'new.ini')).rejects.toThrow('v3');
    await f.sender.changeWriters([deriveMemberId(publisher.pub)], f.sender.rightsStamp(), true);
    const guard = await f.sender.prepareMove(entry, 'new.ini'), before = f.senderStore.records().length;
    fs.writeFileSync(path.join(f.publisherPath, 'new.ini'), 'untracked');
    await expect(f.sender.moveFile(guard)).rejects.toThrow('changed'); expect(f.senderStore.records()).toHaveLength(before);
    fs.unlinkSync(path.join(f.publisherPath, 'new.ini')); fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'external');
    await expect(f.sender.prepareMove(entry, 'new.ini')).rejects.toThrow('local changes');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'first config'); f.senderStore.setExclusions(['new.ini']);
    await expect(f.sender.prepareMove(entry, 'new.ini')).rejects.toThrow('excluded'); f.senderStore.setExclusions([]);
    await expect(f.sender.moveFile(guard)).rejects.toThrow('changed');
    await expect(f.sender.prepareMove(entry, 'CONFIG.ini')).rejects.toThrow('Invalid');
    fs.writeFileSync(path.join(f.publisherPath, 'taken.ini'), 'tracked'); await f.sender.publish('taken.ini');
    await expect(f.sender.prepareMove(entry, 'taken.ini')).rejects.toThrow('conflict');
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('first config');
  });
  it.each(['edit', 'move'])('preserves simultaneous move/%s branches and explicitly resolves their paths', async kind => {
    const f = setup(), first = await f.sender.publish('config.ini'), entry = first.revision.entryId;
    f.receiverStore.acceptRevision(first.revision); await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
    await f.sender.changeWriters([deriveMemberId(publisher.pub), deriveMemberId(receiver.pub)].sort(), f.sender.rightsStamp(), true);
    f.receiverStore.acceptRecords(f.senderStore.records());
    const left = await f.sender.moveFile(await f.sender.prepareMove(entry, 'left.ini'));
    let right;
    if (kind === 'move') right = await f.received.moveFile(await f.received.prepareMove(entry, 'right.ini'));
    else { fs.writeFileSync(path.join(f.receiverPath, 'config.ini'), 'peer edit'); right = await f.received.publish('config.ini'); }
    f.senderStore.acceptRevision(right.revision); f.receiverStore.acceptRevision(left.revision);
    expect(f.senderStore.heads()[0].revisionIds).toHaveLength(2);
    await f.sender.retainHistorical(right.revision.revisionId, right.snapshot!.sourcePath, right.snapshot!.metadata);
    const guard = await f.sender.prepareRestore(right.revision.revisionId); expect(guard.sourcePath).toBe('left.ini');
    expect(guard.targetPath).toBe(right.revision.relativePath);
    const resolved = await f.sender.restoreRevision(guard);
    expect(resolved.revision.parents).toEqual([left.revision.revisionId, right.revision.revisionId].sort());
    expect(fs.existsSync(path.join(f.publisherPath, 'left.ini'))).toBe(false);
    expect(fs.readFileSync(path.join(f.publisherPath, right.revision.relativePath), 'utf8')).toBe(kind === 'move' ? 'first config' : 'peer edit');
    f.receiverStore.acceptRevision(resolved.revision); f.receiverStore.setAutoApply(true);
    await f.received.applyReceived(resolved.revision.revisionId, resolved.snapshot.sourcePath, resolved.snapshot.metadata);
    expect(f.senderStore.heads()).toEqual(f.receiverStore.heads());
  });
  it.each([false, true])('saves editor text as a backed-up signed revision, preserving BOM and CRLF (E2E %s)', async encrypted => {
    const f = setup(encrypted), target = path.join(f.publisherPath, 'config.ini'); fs.writeFileSync(target, '\uFEFFfirst\r\nsecond\r\n');
    const first = await f.sender.publish('config.ini'), open = await f.sender.readEditor(first.revision.entryId);
    expect(open.view).toMatchObject({ writable: true, bom: true, newline: 'crlf', text: 'first\nsecond\n' });
    const unchanged = await f.sender.saveEditor(open.guard, open.view.text); expect(unchanged.snapshot).toBeNull();
    const saved = await f.sender.saveEditor(open.guard, 'edited\nsecond\n');
    expect(saved.revision.parents).toEqual([first.revision.revisionId]); expect(saved.revision.blob?.enc).toBe(encrypted);
    expect(fs.readFileSync(target, 'utf8')).toBe('\uFEFFedited\r\nsecond\r\n');
    const receipts = await new RoomSyncApplier(f.publisherPath).recover(() => true);
    expect(fs.readFileSync(receipts.find(r => r.revisionId === saved.revision.revisionId)!.previousPath!, 'utf8')).toBe('\uFEFFfirst\r\nsecond\r\n');
    f.receiverStore.acceptRecords(f.senderStore.records()); await f.received.applyReceived(saved.revision.revisionId, saved.snapshot!.sourcePath, saved.snapshot!.metadata);
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('\uFEFFedited\r\nsecond\r\n');
    const readOnly = await f.received.readEditor(saved.revision.entryId); expect(readOnly.view.writable).toBe(false);
    await expect(f.received.saveEditor(readOnly.guard, 'reader')).rejects.toThrow('rights');
  });
  it('keeps external edits and rejects stale editor revisions, exclusions and changed writer rights', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'), opened = await f.sender.readEditor(first.revision.entryId), target = path.join(f.publisherPath, 'config.ini');
    fs.writeFileSync(target, 'external edit'); await expect(f.sender.saveEditor(opened.guard, 'my draft')).rejects.toThrow('externally');
    expect(fs.readFileSync(target, 'utf8')).toBe('external edit'); expect(f.senderStore.records()).toHaveLength(2);
    const newer = await f.sender.publish('config.ini'); await expect(f.sender.saveEditor(opened.guard, 'my draft')).rejects.toThrow('changed');
    const fresh = await f.sender.readEditor(first.revision.entryId); f.senderStore.setExclusions(['config.ini']);
    await expect(f.sender.saveEditor(fresh.guard, 'my draft')).rejects.toThrow('changed'); f.senderStore.setExclusions([]);
    const beforeRights = await f.sender.readEditor(first.revision.entryId);
    await f.sender.changeWriters([deriveMemberId(publisher.pub)], f.sender.rightsStamp());
    await expect(f.sender.saveEditor(beforeRights.guard, 'my draft')).rejects.toThrow('changed');
    expect(fs.readFileSync(target, 'utf8')).toBe('external edit'); expect(f.senderStore.revision(newer.revision.revisionId)).toEqual(newer.revision);
  });
  it('branches from each device applied base, converges, and signs an explicit merge without losing history', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    f.receiverStore.acceptRevision(first.revision); await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
    await f.sender.changeWriters([deriveMemberId(publisher.pub), deriveMemberId(receiver.pub)], f.sender.rightsStamp());
    f.receiverStore.acceptRecords(f.senderStore.records());
    expect(f.senderStore.policy()?.v).toBe(2); expect(f.receiverStore.binding()?.autoApply).toBe(false);
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'owner branch'); fs.writeFileSync(path.join(f.receiverPath, 'config.ini'), 'peer branch');
    const left = await f.sender.publish('config.ini'), right = await f.received.publish('config.ini');
    expect(left.revision.parents).toEqual([first.revision.revisionId]); expect(right.revision.parents).toEqual(left.revision.parents);
    f.senderStore.acceptRevision(right.revision); f.receiverStore.acceptRevision(left.revision);
    expect(f.senderStore.heads()).toEqual(f.receiverStore.heads()); expect(f.senderStore.heads()[0].revisionIds).toHaveLength(2);
    await f.sender.retainHistorical(right.revision.revisionId, right.snapshot!.sourcePath, right.snapshot!.metadata);
    const guard = await f.sender.prepareRestore(right.revision.revisionId);
    const merged = await f.sender.restoreRevision(guard);
    expect(merged.revision.v).toBe(2); expect(merged.revision.parents).toEqual([left.revision.revisionId, right.revision.revisionId].sort());
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('peer branch');
    f.receiverStore.acceptRevision(merged.revision); f.receiverStore.setAutoApply(true);
    await f.received.applyReceived(merged.revision.revisionId, merged.snapshot.sourcePath, merged.snapshot.metadata);
    expect(f.receiverStore.heads()).toEqual(f.senderStore.heads());
    expect(f.senderStore.revision(left.revision.revisionId)).toEqual(left.revision);
    expect(f.receiverStore.applied()[0].revisionId).toBe(merged.revision.revisionId);
  });
  it('revokes writers, pauses automatic writes and preserves excluded offline versions across restart', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    f.receiverStore.acceptRevision(first.revision); await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
    await f.sender.changeWriters([deriveMemberId(publisher.pub), deriveMemberId(receiver.pub)], f.sender.rightsStamp());
    f.receiverStore.acceptRecords(f.senderStore.records()); f.receiverStore.setAutoPublish(true); f.receiverStore.setAutoApply(true);
    fs.writeFileSync(path.join(f.receiverPath, 'config.ini'), 'offline edits'); const offline = await f.received.publish('config.ini');
    await f.sender.changeWriters([deriveMemberId(publisher.pub)], f.sender.rightsStamp());
    f.receiverStore.acceptRecords(f.senderStore.records());
    expect(f.receiverStore.watch().enabled).toBe(false); expect(f.receiverStore.binding()?.autoApply).toBe(false);
    f.receiverStore.compactLog(f.receiverStore.prepareLogCompaction()); f.senderStore.compactLog(f.senderStore.prepareLogCompaction());
    expect(f.receiverStore.deferred()).toContain(first.revision.entryId);
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('offline edits');
    expect(new RoomSyncStore(f.incoming, 'receiver-local-room-id', f.context).revision(offline.revision.revisionId)).toEqual(offline.revision);
    await expect(f.received.publish('config.ini')).rejects.toThrow('publisher binding');
    f.senderStore.acceptRevision(offline.revision); expect(f.senderStore.heads()[0].revisionIds).toEqual([first.revision.revisionId]);
    expect(new RoomSyncStore(f.out, 'sender-local-room-id', f.context).revision(offline.revision.revisionId)).toEqual(offline.revision);
    await expect(f.sender.changeWriters([deriveMemberId(publisher.pub)], 'stale')).rejects.toThrow('review again');
  });
  it('enforces local filters for direct publication, received application and manual conflict/restore operations', async () => {
    const f = setup();
    f.senderStore.setExclusions(['config.ini']); await expect(f.sender.publish('config.ini')).rejects.toThrow('excluded');
    f.senderStore.setExclusions([]); const published = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(published.revision);
    f.receiverStore.setExclusions(['config.ini']);
    await expect(f.received.applyReceived(published.revision.revisionId, published.snapshot!.sourcePath, published.snapshot!.metadata)).rejects.toThrow('not authorized');
    await expect(f.received.prepareConflict(published.revision.revisionId)).rejects.toThrow();
    f.senderStore.setExclusions(['config.ini']); await expect(f.sender.prepareRestore(published.revision.revisionId)).rejects.toThrow();
    expect(fs.existsSync(path.join(f.receiverPath, 'config.ini'))).toBe(false);
  });
  async function conflictFixture(encrypted = false) {
    const f = setup(encrypted), first = await f.sender.publish('config.ini');
    f.receiverStore.acceptRevision(first.revision); await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
    fs.writeFileSync(path.join(f.receiverPath, 'config.ini'), 'my local edits\nkeep these');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'new shared\nconfiguration');
    const second = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(second.revision);
    await expect(f.received.applyReceived(second.revision.revisionId, second.snapshot!.sourcePath, second.snapshot!.metadata)).rejects.toThrow('local changes');
    return { ...f, first, second, target: path.join(f.receiverPath, 'config.ini') };
  }
  it.each([false, true])('accepts a reviewed receiver conflict with backup, optional separate copy and no publication (E2E: %s)', async encrypted => {
    const f = await conflictFixture(encrypted); f.receiverStore.setAutoApply(false); f.receiverStore.defer(f.second.revision.entryId);
    const preview = await f.received.prepareConflict(f.second.revision.revisionId);
    expect(preview.view.diff.kind).toBe('text'); expect(preview.view.local.size).toBe(Buffer.byteLength('my local edits\nkeep these'));
    const result = await f.received.resolveConflict(preview.guard, 'keep-both');
    expect(fs.readFileSync(f.target, 'utf8')).toBe('new shared\nconfiguration');
    expect(fs.readFileSync(path.join(f.receiverPath, result.copyPath!), 'utf8')).toBe('my local edits\nkeep these');
    const receipts = await new RoomSyncApplier(f.receiverPath).recover(() => true);
    expect(fs.readFileSync(receipts.find(r => r.revisionId === f.second.revision.revisionId)!.previousPath!, 'utf8')).toBe('my local edits\nkeep these');
    expect(f.receiverStore.deferred()).toEqual([]); expect(f.receiverStore.binding()?.autoApply).toBe(false);
    expect(f.receiverStore.records().filter(r => r.kind === 'revision')).toHaveLength(2); expect(f.receiverStore.outbox()).toEqual([]);
  });
  it('accepts just the shared version and subsequently applies the next update automatically', async () => {
    const f = await conflictFixture(), preview = await f.received.prepareConflict(f.second.revision.revisionId);
    expect(await f.received.resolveConflict(preview.guard, 'accept')).toEqual({ copyPath: null });
    expect(fs.existsSync(path.join(f.receiverPath, '.havvn-local'))).toBe(false);
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'third'); const third = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(third.revision);
    await f.received.applyReceived(third.revision.revisionId, third.snapshot!.sourcePath, third.snapshot!.metadata);
    expect(fs.readFileSync(f.target, 'utf8')).toBe('third');
  });
  it.each(['edit', 'delete', 'rebind', 'head'] as const)('rejects a conflict review after %s without replacing newer local work', async change => {
    const f = await conflictFixture(), preview = await f.received.prepareConflict(f.second.revision.revisionId);
    if (change === 'edit') fs.writeFileSync(f.target, 'later local work');
    if (change === 'delete') fs.unlinkSync(f.target);
    if (change === 'rebind') { f.receiverStore.bind(null); f.receiverStore.bind(f.receiverPath); }
    if (change === 'head') { fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'third'); const next = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(next.revision); }
    await expect(f.received.resolveConflict(preview.guard, 'accept')).rejects.toThrow();
    expect(fs.existsSync(f.target)).toBe(change !== 'delete');
    if (change !== 'delete') expect(fs.readFileSync(f.target, 'utf8')).toBe(change === 'edit' ? 'later local work' : 'my local edits\nkeep these');
  });
  it('rechecks shared pieces at resolution and refuses a modified cache copy', async () => {
    const f = await conflictFixture(), preview = await f.received.prepareConflict(f.second.revision.revisionId);
    fs.writeFileSync(f.receiverStore.sources().find(s => s.revisionId === f.second.revision.revisionId)!.path, 'corrupt');
    await expect(f.received.resolveConflict(preview.guard, 'accept')).rejects.toThrow();
    expect(fs.readFileSync(f.target, 'utf8')).toBe('my local edits\nkeep these');
  });
  it('preserves the original if the separate copy fails or a reserved copy path already exists', async () => {
    const f = await conflictFixture(), preview = await f.received.prepareConflict(f.second.revision.revisionId);
    const existing = path.join(f.receiverPath, preview.guard.copyPath); fs.mkdirSync(path.dirname(existing), { recursive: true }); fs.writeFileSync(existing, 'keep existing');
    await expect(f.received.resolveConflict(preview.guard, 'keep-both')).rejects.toThrow();
    expect(fs.readFileSync(existing, 'utf8')).toBe('keep existing'); expect(fs.readFileSync(f.target, 'utf8')).toBe('my local edits\nkeep these');
  });
  it('persists deferral across reopening and rejects automatic application until an explicit resolution', async () => {
    const f = await conflictFixture(); f.receiverStore.defer(f.second.revision.entryId);
    const store = new RoomSyncStore(f.incoming, 'receiver-local-room-id', f.context), session = new RoomSyncSession({ ...f.options, store });
    expect(store.deferred()).toEqual([f.second.revision.entryId]);
    await expect(session.applyReceived(f.second.revision.revisionId, f.second.snapshot!.sourcePath, f.second.snapshot!.metadata)).rejects.toThrow();
    expect(fs.readFileSync(f.target, 'utf8')).toBe('my local edits\nkeep these');
    const preview = await session.prepareConflict(f.second.revision.revisionId); await session.resolveConflict(preview.guard, 'accept');
    expect(store.deferred()).toEqual([]); expect(fs.readFileSync(f.target, 'utf8')).toBe('new shared\nconfiguration');
  });
  it('resolves an interrupted same-file intent without deleting its staged bytes or the late local edit', async () => {
    const f = await conflictFixture();
    // A late editor save after journal preparation leaves an ambiguous transaction.
    fs.writeFileSync(f.target, 'first config');
    const apply = RoomSyncApplier.prototype.apply;
    vi.spyOn(RoomSyncApplier.prototype, 'apply').mockImplementationOnce(function (request) {
      return apply.call(this, request, step => { if (step === 'prepared') { fs.writeFileSync(f.target, 'late local edit'); throw new Error('process interrupted'); } });
    });
    await expect(f.received.applyReceived(f.second.revision.revisionId, f.second.snapshot!.sourcePath, f.second.snapshot!.metadata)).rejects.toThrow('interrupted');
    const preview = await f.received.prepareConflict(f.second.revision.revisionId);
    expect(preview.guard.digest).toBe(crypto.createHash('sha256').update('late local edit').digest('hex'));
    await f.received.resolveConflict(preview.guard, 'accept');
    const receipts = await new RoomSyncApplier(f.receiverPath).recover(() => true);
    expect(receipts.some(r => r.state === 'rolled-back')).toBe(true);
    expect(receipts.filter(r => r.state === 'applied' && r.previousPath).some(r => fs.readFileSync(r.previousPath!, 'utf8') === 'late local edit')).toBe(true);
    expect(fs.readFileSync(f.target, 'utf8')).toBe('new shared\nconfiguration');
  });
  it('does not choose a winner when authenticated heads diverge', async () => {
    const f = await conflictFixture();
    f.receiverStore.acceptRevision(signSyncRevision(f.context.scope, { ...f.second.revision, createdAt: f.second.revision.createdAt + 1 }, publisher.priv));
    await expect(f.received.prepareConflict(f.second.revision.revisionId)).rejects.toThrow('unambiguous');
    expect(fs.readFileSync(f.target, 'utf8')).toBe('my local edits\nkeep these');
    await expect(f.sender.prepareConflict(f.second.revision.revisionId)).rejects.toThrow('receiver');
  });
  it('refuses a linked separate-copy directory and keeps both the original and unrelated data', async () => {
    const f = await conflictFixture(), preview = await f.received.prepareConflict(f.second.revision.revisionId);
    const elsewhere = path.join(root, 'elsewhere'); fs.mkdirSync(elsewhere); fs.writeFileSync(path.join(elsewhere, 'sentinel'), 'unrelated');
    fs.symlinkSync(elsewhere, path.join(f.receiverPath, '.havvn-local'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.received.resolveConflict(preview.guard, 'keep-both')).rejects.toThrow('Linked');
    expect(fs.readFileSync(f.target, 'utf8')).toBe('my local edits\nkeep these'); expect(fs.readdirSync(elsewhere)).toEqual(['sentinel']);
  });
  it.each([false, true])('restores old content as a new signed child and backs up unpublished edits (E2E: %s)', async encrypted => {
    const f = setup(encrypted), first = await f.sender.publish('config.ini');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'second config');
    const second = await f.sender.publish('config.ini');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'unpublished local work');
    const guard = await f.sender.prepareRestore(first.revision.revisionId);
    const restored = await f.sender.restoreRevision(guard);
    expect(restored.revision.entryId).toBe(first.revision.entryId);
    expect(restored.revision.parents).toEqual([second.revision.revisionId]);
    expect(restored.revision.revisionId).not.toBe(first.revision.revisionId);
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('first config');
    const receipts = await new RoomSyncApplier(f.publisherPath).recover(() => true);
    expect(fs.readFileSync(receipts[0].previousPath!, 'utf8')).toBe('unpublished local work');
    f.receiverStore.acceptRecords(f.senderStore.records().filter(r => r.kind === 'revision'));
    await f.received.applyReceived(restored.revision.revisionId, restored.snapshot.sourcePath, restored.snapshot.metadata);
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('first config');
    expect(f.senderStore.records().filter(r => r.kind === 'revision')).toHaveLength(3);
  });
  it.each(['edit', 'rebind', 'advance'] as const)('refuses a restore preview after %s without overwriting the file', async change => {
    const f = setup(), first = await f.sender.publish('config.ini'), guard = await f.sender.prepareRestore(first.revision.revisionId);
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'new work');
    if (change === 'rebind') { f.senderStore.bind(null); f.senderStore.bind(f.publisherPath); }
    if (change === 'advance') await f.sender.publish('config.ini');
    await expect(f.sender.restoreRevision(guard)).rejects.toThrow(/preview|changes/);
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('new work');
  });
  it('rechecks cached pieces at confirmation and refuses corrupt history', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'), guard = await f.sender.prepareRestore(first.revision.revisionId);
    fs.writeFileSync(first.snapshot!.sourcePath, 'tampered');
    await expect(f.sender.restoreRevision(guard)).rejects.toThrow();
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('first config');
    expect(f.senderStore.records().filter(r => r.kind === 'revision')).toHaveLength(1);
  });
  it('recovers a restored file when the applied fingerprint could not be committed', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'second config'); await f.sender.publish('config.ini');
    const guard = await f.sender.prepareRestore(first.revision.revisionId);
    vi.spyOn(f.senderStore, 'markApplied').mockImplementationOnce(() => { throw new Error('interrupted'); });
    await expect(f.sender.restoreRevision(guard)).rejects.toThrow('interrupted');
    await f.sender.recoverApplied();
    expect(f.senderStore.applied()[0].revisionId).toBe(f.senderStore.heads()[0].revisionIds[0]);
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('first config');
  });
  it('evicts acknowledged old bytes under a zero budget while retaining signed history, heads and working files', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'second config'); const second = await f.sender.publish('config.ini');
    f.senderStore.acknowledgeMany(f.senderStore.outbox().map(r => r.kind === 'revision' ? r.value.revisionId : r.value.policyId));
    f.senderStore.setCacheLimit(0); const release = vi.fn(async () => true);
    const result = await f.sender.cache(release, true);
    expect(release).toHaveBeenCalledWith(first.revision.blob!.infoHash);
    expect(result.freedBytes).toBe(Buffer.byteLength('first config'));
    expect(result.bytes).toBe(result.protectedBytes);
    expect(fs.existsSync(first.snapshot!.sourcePath)).toBe(false);
    expect(fs.existsSync(second.snapshot!.sourcePath)).toBe(true);
    expect(f.senderStore.revision(first.revision.revisionId)).toEqual(first.revision);
    expect(f.senderStore.sources().map(s => s.revisionId)).toEqual([second.revision.revisionId]);
    expect(fs.readFileSync(path.join(f.publisherPath, 'config.ini'), 'utf8')).toBe('second config');
    expect(new RoomSyncStore(f.out, 'sender-local-room-id', f.context).cacheLimit()).toBe(0);
  });
  it('keeps unacknowledged bytes and content with an active transport lease', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'second config'); await f.sender.publish('config.ini');
    f.senderStore.setCacheLimit(0); const release = vi.fn(async () => false);
    expect((await f.sender.cache(release, true)).freedBytes).toBe(0); expect(release).not.toHaveBeenCalled();
    f.senderStore.acknowledge(first.revision.revisionId);
    expect((await f.sender.cache(release, true)).freedBytes).toBe(0); expect(release).toHaveBeenCalledOnce();
    expect(fs.existsSync(first.snapshot!.sourcePath)).toBe(true);
  });
  it('refuses cleanup before unlinking bytes if durable source removal fails', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'second config'); await f.sender.publish('config.ini');
    f.senderStore.acknowledge(first.revision.revisionId); f.senderStore.setCacheLimit(0); f.out.fail = true;
    await expect(f.sender.cache(async () => true, true)).rejects.toThrow('disk full');
    expect(fs.existsSync(first.snapshot!.sourcePath)).toBe(true);
  });
  it('cancels cleanup when the authenticated head changes during transport release', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'second config'); const second = await f.sender.publish('config.ini');
    f.senderStore.acknowledge(first.revision.revisionId); f.senderStore.setCacheLimit(0);
    await expect(f.sender.cache(async () => {
      f.senderStore.acceptRevision(signSyncRevision(f.context.scope, { ...second.revision, parents: [second.revision.revisionId], createdAt: Date.now() + 1 }, publisher.priv));
      return true;
    }, true)).rejects.toThrow('canceled');
    expect(fs.existsSync(first.snapshot!.sourcePath)).toBe(true);
  });
  it('refuses linked cache contents without touching files outside private storage', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'second'); await f.sender.publish('config.ini');
    f.senderStore.acknowledge(first.revision.revisionId); f.senderStore.setCacheLimit(0);
    const external = path.join(root, 'external'); fs.writeFileSync(external, 'keep me');
    fs.unlinkSync(first.snapshot!.sourcePath); fs.linkSync(external, first.snapshot!.sourcePath);
    await expect(f.sender.cache(async () => true, true)).rejects.toThrow('Linked');
    expect(fs.readFileSync(external, 'utf8')).toBe('keep me');
  });
  it('removes only generated orphan snapshots and leaves recovery backups outside the budget', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'second'); await f.sender.publish('config.ini');
    const restored = await f.sender.restoreRevision(await f.sender.prepareRestore(first.revision.revisionId));
    const receipts = await new RoomSyncApplier(f.publisherPath).recover(() => true);
    const orphan = fs.mkdtempSync(path.join(root, 'outgoing', 'snapshot-')); fs.writeFileSync(path.join(orphan, 'config.ini'), 'orphan');
    f.senderStore.acknowledgeMany(f.senderStore.outbox().map(r => r.kind === 'revision' ? r.value.revisionId : r.value.policyId));
    f.senderStore.setCacheLimit(0); const result = await f.sender.cache(async () => true, true);
    expect(fs.existsSync(orphan)).toBe(false); expect(result.freedBytes).toBeGreaterThan(6);
    expect(fs.readFileSync(receipts[0].previousPath!, 'utf8')).toBe('second');
    expect(fs.existsSync(restored.snapshot.sourcePath)).toBe(true);
  });
  it('pins a selected historical version while a restore confirmation is pending', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'second'); await f.sender.publish('config.ini');
    f.senderStore.acknowledge(first.revision.revisionId); f.senderStore.setCacheLimit(0);
    const session = new RoomSyncSession({ ...f.options, store: f.senderStore, storage: path.join(root, 'outgoing'), identity: publisher, cachePins: () => [first.revision.revisionId] });
    expect((await session.cache(async () => true, true)).freedBytes).toBe(0);
    expect(fs.existsSync(first.snapshot!.sourcePath)).toBe(true);
  });
  it.each([false, true])('publishes a stable document ID and applies two authenticated versions (E2E: %s)', async encrypted => {
    const f = setup(encrypted), first = await f.sender.publish('config.ini');
    f.receiverStore.acceptRevision(first.revision);
    await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'second config');
    const second = await f.sender.publish('config.ini');
    expect(second.revision.entryId).toBe(first.revision.entryId);
    expect(second.revision.parents).toEqual([first.revision.revisionId]);
    expect(second.revision.blob!.infoHash).not.toBe(first.revision.blob!.infoHash);
    f.receiverStore.acceptRevision(second.revision);
    await f.received.applyReceived(second.revision.revisionId, second.snapshot!.sourcePath, second.snapshot!.metadata);
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('second config');
    expect(f.senderStore.outbox()).toHaveLength(3);
    expect(f.receiverStore.applied()[0].revisionId).toBe(second.revision.revisionId);
    for (const cache of fs.readdirSync(path.join(root, 'incoming'))) {
      expect(fs.readdirSync(path.join(root, 'incoming', cache))).toEqual([encrypted ? 'config.ini.enc' : 'config.ini']);
    }
    expect((await f.received.resumeSources()).ready).toHaveLength(2);
  });

  it('deduplicates unchanged source bytes even with randomized E2E encryption', async () => {
    const f = setup(true), first = await f.sender.publish('config.ini'), second = await f.sender.publish('config.ini');
    expect(second.revision).toEqual(first.revision); expect(second.snapshot).toBeNull();
    expect(f.senderStore.outbox()).toHaveLength(2);
    expect(fs.readdirSync(path.join(root, 'outgoing'))).toHaveLength(1);
  });

  it('persists the publication fingerprint atomically with the outgoing revision', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    const restored = new RoomSyncStore(f.out, 'sender-local-room-id', f.context);
    expect(restored.applied()).toEqual([{ entryId: first.revision.entryId, revisionId: first.revision.revisionId, digest: first.snapshot!.plaintextDigest }]);
    expect(restored.outbox()).toHaveLength(2);
    expect(restored.sources()).toEqual([{ revisionId: first.revision.revisionId, path: first.snapshot!.sourcePath,
      metadata: first.snapshot!.metadata.toString('base64') }]);
  });

  it.each([false, true])('resumes verified local source bytes after an index restart (E2E: %s)', async encrypted => {
    const f = setup(encrypted), first = await f.sender.publish('config.ini');
    const store = new RoomSyncStore(f.out, 'sender-local-room-id', f.context);
    const restored = new RoomSyncSession({ ...f.options, store, identity: publisher, storage: path.join(root, 'outgoing') });
    const sources = await restored.resumeSources();
    expect(sources.ready).toHaveLength(1); expect(sources.unavailable).toEqual([]);
    expect(sources.ready[0].sourcePath).toBe(first.snapshot!.sourcePath);
    fs.writeFileSync(first.snapshot!.sourcePath, 'damaged retained source');
    expect((await restored.resumeSources()).unavailable).toEqual([first.revision.revisionId]);
    expect(store.outbox()).toHaveLength(2);
  });

  it('retains source bytes if an atomic publication write completed but reported an error', async () => {
    const f = setup(true);
    vi.spyOn(f.out, 'write').mockImplementationOnce(value => {
      f.out.data = structuredClone(value);
      throw new Error('uncertain write completion');
    });
    await expect(f.sender.publish('config.ini')).rejects.toThrow('uncertain');
    const store = new RoomSyncStore(f.out, 'sender-local-room-id', f.context);
    expect(store.outbox()).toHaveLength(2); expect(store.sources()).toHaveLength(1);
    const restarted = new RoomSyncSession({ ...f.options, store, identity: publisher, storage: path.join(root, 'outgoing') });
    const resumed = await restarted.resumeSources(); expect(resumed.ready).toHaveLength(1); expect(resumed.unavailable).toEqual([]);
  });

  it('requires an accepted signed revision and explicit auto-apply before touching the binding', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    await expect(f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata)).rejects.toThrow('not authorized');
    f.receiverStore.acceptRevision(first.revision); f.receiverStore.setAutoApply(false);
    await expect(f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata)).rejects.toThrow('not authorized');
    expect(fs.existsSync(path.join(f.receiverPath, 'config.ini'))).toBe(false);
  });

  it('rejects substituted bytes before creating an apply transaction', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(first.revision);
    fs.writeFileSync(first.snapshot!.sourcePath, 'bad payload!');
    await expect(f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata)).rejects.toThrow();
    expect(fs.existsSync(path.join(f.receiverPath, '.havvn-sync'))).toBe(false);
    expect(f.receiverStore.applied()).toEqual([]);
  });

  it('verifies a private copy even if the original download changes during subsequent hashing', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(first.revision);
    const createReadStream = fs.createReadStream.bind(fs);
    let copiedPayloadRead = false;
    vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
      if (String(args[0]).includes(path.join(root, 'incoming'))) {
        copiedPayloadRead = true; fs.writeFileSync(first.snapshot!.sourcePath, 'corrupted original');
      }
      return createReadStream(...args);
    });
    await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
    expect(copiedPayloadRead).toBe(true);
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('first config');
  });

  it('does not overwrite an independent local edit with the next remote version', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(first.revision);
    await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
    fs.writeFileSync(path.join(f.receiverPath, 'config.ini'), 'local work');
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'second config'); const second = await f.sender.publish('config.ini');
    f.receiverStore.acceptRevision(second.revision);
    await expect(f.received.applyReceived(second.revision.revisionId, second.snapshot!.sourcePath, second.snapshot!.metadata)).rejects.toThrow('local changes');
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('local work');
  });

  it('does not reapply a duplicate announcement over later local edits', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(first.revision);
    const receipt = await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
    fs.writeFileSync(path.join(f.receiverPath, 'config.ini'), 'later local work');
    expect(await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata)).toEqual(receipt);
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('later local work');
    expect(await f.received.recoverApplied()).toHaveLength(1);
  });

  it('does not advertise a retained source located outside the configured private storage', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    f.senderStore.retainSource(first.revision.revisionId, { path: path.join(f.publisherPath, 'config.ini'), metadata: first.snapshot!.metadata.toString('base64') });
    const resumed = await f.sender.resumeSources();
    expect(resumed.ready).toEqual([]); expect(resumed.unavailable).toEqual([first.revision.revisionId]);
  });

  it('rejects obsolete heads and ambiguous forked heads', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(first.revision);
    const a = signSyncRevision(f.context.scope, { ...first.revision, parents: [first.revision.revisionId], createdAt: 200 }, publisher.priv);
    const b = signSyncRevision(f.context.scope, { ...first.revision, parents: [first.revision.revisionId], createdAt: 300 }, publisher.priv);
    f.receiverStore.acceptRevision(a); f.receiverStore.acceptRevision(b);
    f.senderStore.acceptRevision(a); f.senderStore.acceptRevision(b);
    await expect(f.sender.publish('config.ini')).rejects.toThrow('explicit resolution');
    for (const r of [first.revision, a, b]) await expect(f.received.applyReceived(r.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata)).rejects.toThrow('conflict');
  });

  it('records a completed version as the local base when its successor arrives during receipt persistence', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(first.revision);
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'next configuration'); const next = await f.sender.publish('config.ini');
    const apply = RoomSyncApplier.prototype.apply;
    vi.spyOn(RoomSyncApplier.prototype, 'apply').mockImplementationOnce(function(request) {
      return apply.call(this, request, step => { if (step === 'committed') f.receiverStore.acceptRevision(next.revision); });
    });
    await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
    expect(f.receiverStore.applied()[0].revisionId).toBe(first.revision.revisionId);
    await f.received.applyReceived(next.revision.revisionId, next.snapshot!.sourcePath, next.snapshot!.metadata);
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('next configuration');
  });

  it('recovers a superseded prepared transaction before applying its successor without a process restart', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(first.revision);
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'next configuration'); const next = await f.sender.publish('config.ini');
    const apply = RoomSyncApplier.prototype.apply;
    vi.spyOn(RoomSyncApplier.prototype, 'apply').mockImplementationOnce(function(request) {
      return apply.call(this, request, step => { if (step === 'prepared') f.receiverStore.acceptRevision(next.revision); });
    });
    await expect(f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata)).rejects.toThrow('canceled');
    await f.received.applyReceived(next.revision.revisionId, next.snapshot!.sourcePath, next.snapshot!.metadata);
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('next configuration');
  });

  it('does not let a completed old operation attach a fingerprint to a replaced binding at the same path', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(first.revision);
    const apply = RoomSyncApplier.prototype.apply;
    vi.spyOn(RoomSyncApplier.prototype, 'apply').mockImplementationOnce(function(request) {
      return apply.call(this, request, step => {
        if (step === 'committed') { f.receiverStore.bind(null); f.receiverStore.bind(f.receiverPath); f.receiverStore.setAutoApply(true); }
      });
    });
    await expect(f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata)).rejects.toThrow('context changed');
    expect(f.receiverStore.applied()).toEqual([]);
  });

  it('rejects competing document IDs mapped to the same Windows path', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(first.revision);
    const other = signSyncRevision(f.context.scope, { ...first.revision, entryId: crypto.randomUUID() }, publisher.priv);
    f.receiverStore.acceptRevision(other);
    await expect(f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata)).rejects.toThrow('conflict');
  });

  it('requires the exact content epoch and removes plaintext staging after failure', async () => {
    const f = setup(true), first = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(first.revision);
    const wrong = new RoomSyncSession({ ...f.options, resolveSecret: () => generateRoomSecret() });
    await expect(wrong.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata)).rejects.toThrow('key unavailable');
    for (const cache of fs.readdirSync(path.join(root, 'incoming'))) {
      expect(fs.readdirSync(path.join(root, 'incoming', cache))).toEqual(['config.ini.enc']);
    }
    expect(fs.existsSync(path.join(f.receiverPath, 'config.ini'))).toBe(false);
  });

  it('cancels work belonging to a closed room session', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(first.revision); f.cancel();
    await expect(f.sender.publish('config.ini')).rejects.toThrow('canceled');
    await expect(f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata)).rejects.toThrow('canceled');
    expect(fs.existsSync(path.join(f.receiverPath, 'config.ini'))).toBe(false);
  });

  it('reconciles the durable apply receipt when persisting the applied fingerprint failed', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(first.revision);
    const markApplied = f.receiverStore.markApplied.bind(f.receiverStore);
    vi.spyOn(f.receiverStore, 'markApplied').mockImplementationOnce((...args) => { f.incoming.fail = true; markApplied(...args); });
    await expect(f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata)).rejects.toThrow('disk full');
    expect(fs.readFileSync(path.join(f.receiverPath, 'config.ini'), 'utf8')).toBe('first config');
    f.incoming.fail = false;
    const restartedStore = new RoomSyncStore(f.incoming, 'receiver-local-room-id', f.context);
    const restarted = new RoomSyncSession({ ...f.options, store: restartedStore });
    await restarted.recoverApplied();
    expect(restartedStore.applied()[0].revisionId).toBe(first.revision.revisionId);
    expect(await restarted.recoverApplied()).toHaveLength(1);
  });

  it('does not let recovery mutate files for a journal without an accepted signed revision', async () => {
    const f = setup(), first = await f.sender.publish('config.ini');
    await expect(new RoomSyncApplier(f.receiverPath).apply({ source: first.snapshot!.sourcePath,
      revisionId: first.revision.revisionId, relativePath: 'config.ini', digest: first.snapshot!.plaintextDigest,
      expectedDigest: null }, step => { if (step === 'prepared') throw new Error('interrupted'); })).rejects.toThrow();
    await expect(f.received.recoverApplied()).rejects.toThrow('not authorized');
    expect(fs.existsSync(path.join(f.receiverPath, 'config.ini'))).toBe(false);
  });

  it('does not move an applied fingerprint backward when receipts are listed in random operation order', async () => {
    const f = setup(), first = await f.sender.publish('config.ini'); f.receiverStore.acceptRevision(first.revision);
    await f.received.applyReceived(first.revision.revisionId, first.snapshot!.sourcePath, first.snapshot!.metadata);
    fs.writeFileSync(path.join(f.publisherPath, 'config.ini'), 'second config'); const second = await f.sender.publish('config.ini');
    f.receiverStore.acceptRevision(second.revision);
    await f.received.applyReceived(second.revision.revisionId, second.snapshot!.sourcePath, second.snapshot!.metadata);
    const before = f.receiverStore.applied();
    await f.received.recoverApplied(); expect(f.receiverStore.applied()).toEqual(before);
  });
});
