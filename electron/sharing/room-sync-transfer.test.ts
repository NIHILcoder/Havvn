/** Real WebTorrent over loopback TCP. No tracker, DHT, LAN discovery, NAT mapping or room manifest. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db/secrets', () => ({ encryptSecret: () => { throw new Error('Use fixture persistence'); }, decryptSecretStrict: () => { throw new Error('Use fixture persistence'); } }));
import type { SyncSnapshot } from './room-sync-snapshot';
import { RoomSyncSession } from './room-sync-session';
import { RoomSyncStore, type SyncPersistence } from '../db/room-sync-store';
import { deriveMemberId } from './room-crypto';
import { contentKeyEpoch } from './room-keyring';
import { generateRoomSecret } from './room-e2e';
import { verifyRoomFile } from './room-file-storage';

let root: string;
const clients: WebTorrent[] = [];
const errors: Error[] = [];
const keys = crypto.generateKeyPairSync('ed25519');
const pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const identity = { pub, priv: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
function persistence(): SyncPersistence {
  let snapshot: unknown;
  return { read: () => structuredClone(snapshot), write: value => { snapshot = structuredClone(value); } };
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sync-transfer-')); });
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => new Promise<void>(resolve => client.destroy(() => resolve()))));
  fs.rmSync(root, { recursive: true, force: true });
  errors.length = 0;
});

async function client(): Promise<WebTorrent> {
  const { default: WebTorrentClient } = await import('webtorrent');
  const instance = new WebTorrentClient({ tracker: false, dht: false, lsd: false, utPex: false,
    natUpnp: false, natPmp: false, utp: false, webSeeds: false });
  clients.push(instance);
  instance.on('error', error => errors.push(error));
  if (!instance.listening) await boundedEvent(instance, 'listening');
  return instance;
}

function boundedEvent(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); emitter.removeListener(event, done); emitter.removeListener('error', fail); };
    const done = () => { cleanup(); resolve(); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => fail(new Error(`Loopback ${event} timed out`)), 15_000);
    emitter.once(event, done); emitter.once('error', fail);
  });
}

async function add(instance: WebTorrent, metadata: Uint8Array, directory: string): Promise<Torrent> {
  const torrent = instance.add(metadata, { path: directory, announce: [] });
  torrent.on('error', error => errors.push(error));
  if (!torrent.ready) await boundedEvent(torrent, 'ready');
  return torrent;
}

it.each([false, true])('transfers and applies two versions through a private blob swarm (E2E: %s)', async encrypted => {
  const sender = await client(), receiver = await client();
  const publisher = path.join(root, 'publisher'), destination = path.join(root, 'receiver');
  fs.mkdirSync(publisher); fs.mkdirSync(destination);
  const source = path.join(publisher, 'config.ini');
  const secret = encrypted ? generateRoomSecret() : undefined;
  const context = { scope: 'loopback-room-context', rootId: crypto.randomUUID(), ownerId: deriveMemberId(pub), e2e: encrypted };
  const senderStore = new RoomSyncStore(persistence(), 'sender-local-id', context);
  const receiverStore = new RoomSyncStore(persistence(), 'receiver-local-id', context);
  senderStore.bind(publisher); receiverStore.bind(destination); receiverStore.setAutoApply(true);
  const senderSession = new RoomSyncSession({ context, store: senderStore, storage: path.join(root, 'snapshots'), identity,
    isCurrent: () => true, contentSecret: () => secret! });
  const receiverSession = new RoomSyncSession({ context, store: receiverStore, storage: path.join(root, 'received'), identity,
    isCurrent: () => true, resolveSecret: epoch => secret && epoch === contentKeyEpoch(secret) ? secret : undefined });
  senderSession.createRoot('Shared configs'); receiverStore.acceptPolicy(senderStore.policy());
  const firstBody = 'first configuration\n'.repeat(4096), secondBody = 'second configuration\n'.repeat(4096);
  const snapshots: SyncSnapshot[] = [];
  const entryIds: string[] = [];
  for (const body of [firstBody, secondBody]) {
    fs.writeFileSync(source, body);
    const publication = await senderSession.publish('config.ini');
    const snapshot = publication.snapshot!;
    entryIds.push(publication.revision.entryId);
    receiverStore.acceptRevision(publication.revision);
    snapshots.push(snapshot);
    const seed = await add(sender, snapshot.metadata, snapshot.directory);
    if (!seed.done) await boundedEvent(seed, 'done');
    const download = path.join(root, 'downloads', snapshot.file.infoHash);
    fs.mkdirSync(download, { recursive: true });
    const received = await add(receiver, snapshot.metadata, download);
    if (!received.done) {
      expect(received.addPeer(`127.0.0.1:${sender.torrentPort}`)).toBe(true);
      await boundedEvent(received, 'done');
    }
    const downloaded = path.join(download, path.basename(snapshot.sourcePath));
    await verifyRoomFile(downloaded, snapshot.file, snapshot.metadata);
    if (secret) {
      expect(fs.readFileSync(downloaded).includes(Buffer.from('configuration'))).toBe(false);
    }
    await receiverSession.applyReceived(publication.revision.revisionId, downloaded, snapshot.metadata);
    expect(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8')).toBe(body);
  }
  expect(snapshots[0].file.infoHash).not.toBe(snapshots[1].file.infoHash);
  // The first swarm still serves its snapshot after saving the second source.
  await verifyRoomFile(snapshots[0].sourcePath, snapshots[0].file, snapshots[0].metadata);
  expect(new Set(entryIds).size).toBe(1);
  expect(senderStore.outbox()).toHaveLength(3);
  const receipts = await receiverSession.recoverApplied();
  expect(receipts).toHaveLength(2);
  expect(fs.readFileSync(receipts.find(receipt => receipt.previousPath)!.previousPath!, 'utf8')).toBe(firstBody);
  expect(errors).toEqual([]);
}, 60_000);
