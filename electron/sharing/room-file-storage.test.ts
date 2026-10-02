import { ROOM_FILE_LIMIT, storeRoomManifestFile } from '../../shared/room-manifest-sync';
/* eslint-disable @typescript-eslint/no-explicit-any -- Execute the real preload functions with a local swarm double. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import parseTorrent from 'parse-torrent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptFile, decryptFile, generateRoomSecret } from './room-e2e';
import * as storage from './room-file-storage';
import { RoomReceiveQueue } from './room-receive-queue';
import { RoomDiskBudget } from './room-disk-budget';
import { contentKeyEpoch } from './room-keyring';
import { currentRoomDeletion } from '../../shared/room-authority';
import type { RoomFile } from '../../shared/types';

let root: string;
const fixtures: any[] = [];
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-room-files-')); });
afterEach(() => {
  for (const context of fixtures.splice(0)) { const rooms = [...context.rooms.values()]; context.rooms.clear(); for (const room of rooms) context.cancelReceives(room); }
  fs.rmSync(root, { recursive: true, force: true });
});

async function sharedFile(body: string | Buffer, name = 'film.mkv', enc = false, pieceLength?: number) {
  const dir = fs.mkdtempSync(path.join(root, 'source-'));
  const source = path.join(dir, name + (enc ? '.enc' : ''));
  fs.writeFileSync(source, body);
  const { default: createTorrent } = await import('create-torrent');
  const metadata = await new Promise<Buffer>((resolve, reject) => createTorrent(source,
    { name: path.basename(source), announce: [], pieceLength }, (error, result) => error ? reject(error) : resolve(Buffer.from(result!))));
  const hash = parseTorrent(metadata).infoHash;
  const file: RoomFile = { fileId: hash, infoHash: hash, name, size: Buffer.byteLength(body) - (enc ? 28 : 0),
    magnetURI: 'magnet:?xt=urn:btih:' + hash, addedBy: 'remote', addedByName: 'Remote', addedAt: 1, ...(enc ? { enc: true } : {}) };
  return { file, metadata, source };
}

describe('room storage integrity and migration', () => {
  it('isolates same names by file ID and uses fresh slots even for the same ID', async () => {
    const a = await sharedFile('aaaa'), b = await sharedFile('bbbb');
    const targets = [a, b, a].map(item => storage.newRoomFilePath(root, item.file.fileId, item.file.name));
    expect(new Set(targets).size).toBe(3);
    expect(storage.isManagedRoomPath(root, a.file.fileId, targets[1])).toBe(false);
    expect(storage.isManagedRoomPath(root, a.file.fileId, path.join(root, a.file.name))).toBe(false);
  });
  it.each(['../film', 'stream:ads', 'CON.txt', 'nul', 'bad.', 'bad ', 'x\\film', 'a/b'])('refuses unsafe disk names: %s', name => {
    expect(() => storage.roomDiskName({ name })).toThrow();
  });
  it('rejects same-size substitution and changed original bytes against saved metadata', async () => {
    const item = await sharedFile('original');
    expect(await storage.verifyRoomFile(item.source, item.file, item.metadata)).toEqual(item.metadata);
    fs.writeFileSync(item.source, 'replaced');
    await expect(storage.verifyRoomFile(item.source, item.file, item.metadata)).rejects.toThrow('contents have changed');
  });
  it('checks multi-piece files using their original piece length', async () => {
    const item = await sharedFile('x'.repeat(40000) + 'z', 'film.mkv', false, 16384);
    await storage.verifyRoomFile(item.source, item.file, item.metadata);
    const fd = fs.openSync(item.source, 'r+'); fs.writeSync(fd, Buffer.from('y'), 0, 1, 20000); fs.closeSync(fd);
    await expect(storage.verifyRoomFile(item.source, item.file, item.metadata)).rejects.toThrow();
  });
  it('reconstructs legacy metadata only when the complete info hash matches', async () => {
    const item = await sharedFile('original');
    await storage.verifyRoomFile(item.source, item.file);
    fs.writeFileSync(item.source, 'replaced');
    await expect(storage.verifyRoomFile(item.source, item.file)).rejects.toThrow('metadata does not match');
  });
  it('copies a verified legacy file without removing or changing the source', async () => {
    const item = await sharedFile('original');
    const target = await storage.migrateRoomFile(item.source, root, item.file, item.metadata, () => true);
    expect(target).not.toBe(item.source);
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
    expect(fs.readFileSync(item.source, 'utf8')).toBe('original');
  });
  it('never migrates unrelated bytes just because name and length match', async () => {
    const item = await sharedFile('original'); fs.writeFileSync(item.source, 'replaced');
    await expect(storage.migrateRoomFile(item.source, root, item.file, item.metadata, () => true)).rejects.toThrow();
    expect(fs.readFileSync(item.source, 'utf8')).toBe('replaced');
    expect(fs.existsSync(path.join(root, '.havvn-files'))).toBe(false);
  });
  it('cancels a migration after copying without publishing or removing the source', async () => {
    const item = await sharedFile('original'); let checks = 0;
    await expect(storage.migrateRoomFile(item.source, root, item.file, item.metadata, () => ++checks === 1)).rejects.toThrow('canceled');
    expect(fs.readFileSync(item.source, 'utf8')).toBe('original');
    const parent = storage.roomFileDir(root, item.file.fileId);
    expect(fs.readdirSync(parent).every(dir => fs.readdirSync(path.join(parent, dir)).length === 0)).toBe(true);
  });
  it('rejects metadata with an unexpected hash, layout, name or length', async () => {
    const item = await sharedFile('original');
    for (const patch of [{ infoHash: '0'.repeat(40) }, { name: 'other.mkv' }, { size: 100 }]) {
      expect(() => storage.roomTorrentMetadata({ ...item.file, ...patch }, item.metadata)).toThrow();
    }
  });
});

describe('authenticated publication', () => {
  async function encrypted(body = 'authenticated content') {
    const source = path.join(root, 'source'); fs.writeFileSync(source, body);
    const cipher = path.join(root, 'cipher'), key = generateRoomSecret();
    await encryptFile(source, cipher, key);
    return { cipher, key, body };
  }
  it('decrypts empty files as well as nonempty files', async () => {
    const { cipher, key } = await encrypted(''); const dst = path.join(root, 'plain');
    await decryptFile(cipher, dst, key, { expectedSize: 0 });
    expect(fs.statSync(dst).size).toBe(0);
  });
  it('keeps an existing destination intact even when authentication succeeds', async () => {
    const { cipher, key } = await encrypted(); const dst = path.join(root, 'plain'); fs.writeFileSync(dst, 'keep me');
    await expect(decryptFile(cipher, dst, key)).rejects.toThrow();
    expect(fs.readFileSync(dst, 'utf8')).toBe('keep me');
    expect(fs.readdirSync(root).some(name => name.includes('.decrypt-'))).toBe(false);
  });
  it('refuses to overwrite a prior ciphertext during encryption', async () => {
    const { cipher, key } = await encrypted(); const before = fs.readFileSync(cipher);
    const source = path.join(root, 'different'); fs.writeFileSync(source, 'other content');
    await expect(encryptFile(source, cipher, key)).rejects.toThrow();
    expect(fs.readFileSync(cipher)).toEqual(before);
  });
  it('does not leave unauthenticated output or temporary files after a wrong key', async () => {
    const { cipher } = await encrypted(); const dst = path.join(root, 'plain');
    await expect(decryptFile(cipher, dst, generateRoomSecret())).rejects.toThrow();
    expect(fs.existsSync(dst)).toBe(false);
    expect(fs.readdirSync(root).some(name => name.includes('.decrypt-'))).toBe(false);
  });
  it('keeps equally named E2E files independent when decrypting in parallel', async () => {
    const { cipher, key } = await encrypted('first film');
    const second = path.join(root, 'second.enc'), source = path.join(root, 'second'); fs.writeFileSync(source, 'other film');
    await encryptFile(source, second, key);
    const a = storage.newRoomFilePath(root, 'first-id', 'film.mkv');
    const b = storage.newRoomFilePath(root, 'other-id', 'film.mkv');
    await Promise.all([decryptFile(cipher, a, key), decryptFile(second, b, key)]);
    expect(fs.readFileSync(a, 'utf8')).toBe('first film'); expect(fs.readFileSync(b, 'utf8')).toBe('other film');
  });
  it('lets only one concurrent operation publish the same destination', async () => {
    const { cipher, key, body } = await encrypted('data'.repeat(200000)); const dst = path.join(root, 'plain');
    const results = await Promise.allSettled([decryptFile(cipher, dst, key), decryptFile(cipher, dst, key)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(fs.readFileSync(dst, 'utf8')).toBe(body);
    expect(fs.readdirSync(root).some(name => name.includes('.decrypt-'))).toBe(false);
  });
  it('does not publish after the room operation was canceled', async () => {
    const { cipher, key } = await encrypted(); const dst = path.join(root, 'plain');
    await expect(decryptFile(cipher, dst, key, { isCurrent: () => false })).rejects.toThrow('canceled');
    expect(fs.existsSync(dst)).toBe(false);
    expect(fs.readdirSync(root).some(name => name.includes('.decrypt-'))).toBe(false);
  });
});

const engineSource = fs.readFileSync(new URL('./room-engine.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(start: string, end: string) {
  return engineSource.slice(engineSource.indexOf(start), engineSource.indexOf(end, engineSource.indexOf(start)));
}
async function engineFixture(item: Awaited<ReturnType<typeof sharedFile>>, complete = false) {
  const { default: RoomChunkStore } = await import('fs-chunk-store');
  const torrent: any = Object.assign(new EventEmitter(), { infoHash: item.file.infoHash, torrentFile: item.metadata,
    progress: complete ? 1 : 0, done: complete, downloadSpeed: 0 });
  const client: any = { add: vi.fn((_src, options, cb) => { client.options = options; queueMicrotask(() => cb(torrent)); return torrent; }), remove: vi.fn() };
  const room: any = { roomId: 'room', folder: root, cacheDir: path.join(root, 'cache'), files: new Map([[item.file.fileId, item.file]]),
    transfers: new Map(), folders: new Map(), tombstones: new Map(), revives: new Map(), members: new Map(), self: { memberId: 'self' }, trackers: [], prevSecrets: [] };
  const context: any = { ROOM_FILE_LIMIT, storeRoomManifestFile, RoomReceiveQueue, RoomDiskBudget, setTimeout, clearTimeout, ...storage, contentKeyEpoch, currentRoomDeletion, fs, path, crypto, Buffer, WeakMap, Map, Promise, queueMicrotask, RoomChunkStore, decryptFile,
    rooms: new Map([['room', room]]), clients: new Map([['room', client]]), netSuspended: false,
    isTombstonedAt: () => false, ensureClient: () => client, findTorrent: () => undefined,
    addKnownTorrent: (_c: unknown, _hash: string, source: unknown, opts: unknown, cb: unknown) => client.add(source, opts, cb),
    safeDirSegment: (name: string) => name, effectiveAutoFetch: () => true,
    closeStreamServers: vi.fn(), broadcast: vi.fn(), maybeBroadcastProg: vi.fn(), pushState: vi.fn(), log: vi.fn(), logEvent: vi.fn(),
    ipcRenderer: { send: vi.fn() },
  };
  const code = extract('type ReceiveLease', '/** Append an activity-log event')
    + extract('function applyTombstone(', '\n/**')
    + extract('function setTransfer(', '/** Seed a local file')
    + extract('function ensureLocal(', '// ── Rendezvous tracker');
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  fixtures.push(context);
  return { room, client, torrent, context };
}

describe('room engine uses verified paths', () => {
  async function encryptedItem() {
    const source = path.join(root, 'original'), cipher = path.join(root, 'encrypted'); fs.writeFileSync(source, 'encrypted film');
    const key = generateRoomSecret(); await encryptFile(source, cipher, key);
    const item = await sharedFile(fs.readFileSync(cipher), 'film.mkv', true);
    const fixture = await engineFixture(item, true);
    fixture.room.e2e = true; fixture.room.secret = key;
    fixture.context.storageFor(fixture.room).metadata.set(item.file.fileId, item.metadata);
    fixture.room.transfers.set(item.file.fileId, { status: 'done', phase: 'ciphertext-ready', progress: 1, haveLocally: false, cipherReady: true, cipherPath: item.source });
    return { ...fixture, item, key };
  }
  it('waits for a key with 100% ciphertext, then decrypts locally on key arrival', async () => {
    const { context, room, item, key, client } = await encryptedItem(); room.secret = '';
    await context.decryptOne(room, item.file, item.source);
    expect(room.transfers.get(item.file.fileId)).toMatchObject({ phase: 'waiting-key', cipherReady: true, haveLocally: false, progress: 1 });
    expect(() => context.verifiedLocalFile('room', item.file.fileId)).toThrow();
    room.secret = key; await context.decryptPending(room);
    expect(room.transfers.get(item.file.fileId)).toMatchObject({ phase: 'ready', haveLocally: true });
    expect(client.add).not.toHaveBeenCalled();
  });
  it('retries a wrong-key error from ciphertext even with an existing torrent and coalesces repeated clicks', async () => {
    const { context, room, item, key, client, torrent } = await encryptedItem(); room.secret = generateRoomSecret();
    await context.decryptOne(room, item.file, item.source);
    const failed = room.transfers.get(item.file.fileId);
    expect(failed).toMatchObject({ phase: 'error', cipherReady: true, haveLocally: false, error: { stage: 'decryption', code: 'authentication' } });
    const saved = context.ipcRenderer.send.mock.calls.findLast((c: any[]) => c[0] === 'room-manifest-add')[1].file;
    expect(saved.localError).toEqual(failed.error); expect(saved.cipherPath).toBe(item.source);
    context.wireTorrentStats(room, torrent); torrent.emit('upload'); torrent.emit('error', new Error('Seeding connection closed'));
    expect(room.transfers.get(item.file.fileId).error).toEqual(failed.error);
    room.secret = key; context.findTorrent = () => torrent;
    const verify = vi.fn(context.verifyRoomFile); context.verifyRoomFile = verify;
    const phases: string[] = []; context.pushState = () => phases.push(room.transfers.get(item.file.fileId).phase);
    context.retryDecrypt('room', item.file.fileId); context.retryDecrypt('room', item.file.fileId);
    await vi.waitFor(() => expect(room.transfers.get(item.file.fileId).haveLocally).toBe(true));
    expect(verify).toHaveBeenCalledOnce(); expect(client.add).not.toHaveBeenCalled(); expect(client.remove).not.toHaveBeenCalled();
    expect(phases).toEqual(['verifying', 'decrypting', 'ready']);
    expect(room.transfers.get(item.file.fileId).error).toBeUndefined();
    const ready = context.ipcRenderer.send.mock.calls.findLast((c: any[]) => c[0] === 'room-manifest-add')[1].file;
    expect(ready.localError).toBeUndefined(); expect(fs.readFileSync(ready.localPath, 'utf8')).toBe('encrypted film');
  });
  it('keeps a saved decrypt failure after restart and revalidates ciphertext before offering a retry', async () => {
    const { context, room, item, client } = await encryptedItem(); room.files.clear(); room.transfers.clear(); room.secret = generateRoomSecret();
    const error = { stage: 'decryption', code: 'authentication', message: 'Old key unavailable' };
    context.restoreManifestFile(room, { ...item.file, cipherPath: item.source, torrentFile: item.metadata.toString('base64'), localError: error });
    expect(room.transfers.get(item.file.fileId).cipherReady).toBe(false);
    await vi.waitFor(() => expect(room.transfers.get(item.file.fileId).cipherReady).toBe(true));
    expect(room.transfers.get(item.file.fileId)).toMatchObject({ phase: 'error', haveLocally: false, error });
    expect(client.add).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'changed'])('refuses a %s ciphertext during retry without silently downloading it', async kind => {
    const { context, room, item, client } = await encryptedItem();
    if (kind === 'missing') fs.unlinkSync(item.source);
    else { const buf = fs.readFileSync(item.source); buf[14] ^= 1; fs.writeFileSync(item.source, buf); }
    context.retryDecrypt('room', item.file.fileId);
    await vi.waitFor(() => expect(room.transfers.get(item.file.fileId).phase).toBe('error'));
    expect(room.transfers.get(item.file.fileId)).toMatchObject({ cipherReady: false, haveLocally: false, error: { stage: 'verification', code: kind === 'missing' ? 'missing-file' : 'changed-file' } });
    expect(client.add).not.toHaveBeenCalled();
  });
  it('reports disk exhaustion and preserves ciphertext without trying every old key', async () => {
    const { context, room, item, client } = await encryptedItem(); room.prevSecrets = [generateRoomSecret()];
    context.decryptFile = vi.fn(async () => { throw Object.assign(new Error('No space left'), { code: 'ENOSPC' }); });
    await context.decryptOne(room, item.file, item.source);
    expect(room.transfers.get(item.file.fileId)).toMatchObject({ cipherReady: true, haveLocally: false, error: { stage: 'decryption', code: 'disk-full' } });
    expect(context.decryptFile).toHaveBeenCalledOnce(); expect(fs.existsSync(item.source)).toBe(true); expect(client.add).not.toHaveBeenCalled();
  });
  it.each(['valid replacement', 'broken authentication'])('rejects ciphertext changed mid-decrypt: %s', async kind => {
    const { context, room, item, key } = await encryptedItem();
    const alternateSource = path.join(root, 'alternate'), alternateCipher = path.join(root, 'alternate.enc');
    fs.writeFileSync(alternateSource, 'different film'); await encryptFile(alternateSource, alternateCipher, key);
    context.decryptFile = async (...args: Parameters<typeof decryptFile>) => {
      const replacement = fs.readFileSync(alternateCipher);
      if (kind === 'broken authentication') replacement[14] ^= 1;
      fs.writeFileSync(item.source, replacement);
      return decryptFile(...args);
    };
    await context.decryptOne(room, item.file, item.source);
    expect(room.transfers.get(item.file.fileId)).toMatchObject({ phase: 'error', cipherReady: false, haveLocally: false,
      error: { stage: 'verification', code: 'changed-file' } });
    expect(context.broadcast).not.toHaveBeenCalled();
    const parent = storage.roomFileDir(root, item.file.fileId);
    expect(fs.readdirSync(parent).every(dir => fs.readdirSync(path.join(parent, dir)).length === 0)).toBe(true);
  });
  it('does not lose a key received during an active decrypt operation', async () => {
    const { context, room, item, key } = await encryptedItem(); room.secret = generateRoomSecret();
    let unblock!: () => void; const gate = new Promise<void>(resolve => { unblock = resolve; });
    context.decryptFile = vi.fn(async (...args: Parameters<typeof decryptFile>) => { await gate; return decryptFile(...args); });
    const first = context.decryptOne(room, item.file, item.source);
    await vi.waitFor(() => expect(context.decryptFile).toHaveBeenCalledOnce());
    room.secret = key; const joined = context.decryptPending(room); unblock(); await Promise.all([first, joined]);
    await vi.waitFor(() => expect(room.transfers.get(item.file.fileId).haveLocally).toBe(true));
    expect(context.decryptFile).toHaveBeenCalledTimes(2);
  });
  it('decrypts a released file locally without restarting its seeding', async () => {
    const { context, room, item, client } = await encryptedItem(); room.transfers.get(item.file.fileId).released = true;
    context.retryDecrypt('room', item.file.fileId);
    await vi.waitFor(() => expect(room.transfers.get(item.file.fileId).haveLocally).toBe(true));
    expect(room.transfers.get(item.file.fileId)).toMatchObject({ status: 'done', phase: 'ready', released: true });
    expect(client.add).not.toHaveBeenCalled();
  });
  it('does not publish a late decrypt result after file removal or leaving', async () => {
    const { context, room, item } = await encryptedItem();
    let unblock!: () => void; const gate = new Promise<void>(resolve => { unblock = resolve; });
    context.decryptFile = vi.fn(async (...args: Parameters<typeof decryptFile>) => { await gate; return decryptFile(...args); });
    const operation = context.decryptOne(room, item.file, item.source);
    await vi.waitFor(() => expect(context.decryptFile).toHaveBeenCalledOnce());
    context.rooms.delete('room'); unblock(); await operation;
    expect(room.transfers.get(item.file.fileId).haveLocally).toBe(false);
    expect(context.broadcast).not.toHaveBeenCalled();
    const parent = storage.roomFileDir(root, item.file.fileId);
    expect(fs.readdirSync(parent).every(dir => fs.readdirSync(path.join(parent, dir)).length === 0)).toBe(true);
  });
  it('does not try to decrypt a partial download when a key arrives', async () => {
    const { context, room, item } = await encryptedItem(); room.transfers.get(item.file.fileId).cipherReady = false;
    const verify = vi.fn(context.verifyRoomFile); context.verifyRoomFile = verify;
    await context.decryptPending(room); expect(verify).not.toHaveBeenCalled();
    expect(() => context.retryDecrypt('room', item.file.fileId)).toThrow('Download');
  });
  it('downloads into a new slot instead of adopting an unrelated same-name file', async () => {
    const item = await sharedFile('original'); const foreign = path.join(root, item.file.name); fs.writeFileSync(foreign, 'replaced');
    const { context, room, client } = await engineFixture(item);
    await context.ensureLocal(room, item.file);
    expect(client.add).toHaveBeenCalledOnce(); expect(client.options.path).not.toBe(root);
    expect(room.transfers.get(item.file.fileId).haveLocally).toBe(false);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('replaced');
  });
  it('restores a downloaded legacy file into an isolated copy before marking it ready', async () => {
    const item = await sharedFile('original'); const legacy = path.join(root, item.file.name); fs.copyFileSync(item.source, legacy);
    const { context, room } = await engineFixture(item, true);
    room.files.clear(); context.restoreManifestFile(room, { ...item.file, localPath: legacy, torrentFile: item.metadata.toString('base64') });
    expect(room.transfers.get(item.file.fileId).haveLocally).toBe(false);
    await vi.waitFor(() => expect(room.transfers.get(item.file.fileId).haveLocally).toBe(true));
    const tr = room.transfers.get(item.file.fileId);
    expect(tr.localPath).not.toBe(legacy); expect(context.verifiedLocalFile('room', item.file.fileId)).toBe(tr.localPath);
    expect(fs.readFileSync(legacy, 'utf8')).toBe('original');
  });
  it('preserves the original author path and refuses it after a later modification', async () => {
    const item = await sharedFile('original'); const { context, room } = await engineFixture(item, true);
    room.files.clear(); context.restoreManifestFile(room, { ...item.file, localOriginal: true, localPath: item.source, torrentFile: item.metadata.toString('base64') });
    await vi.waitFor(() => expect(room.transfers.get(item.file.fileId).haveLocally).toBe(true));
    expect(context.verifiedLocalFile('room', item.file.fileId)).toBe(item.source);
    fs.writeFileSync(item.source, 'replaced');
    expect(() => context.verifiedLocalFile('room', item.file.fileId)).toThrow('changed');
    expect(room.transfers.get(item.file.fileId).haveLocally).toBe(false);
    expect(fs.readFileSync(item.source, 'utf8')).toBe('replaced');
  });
  it('does not advertise ciphertext completion as a verified plaintext file or clear a decrypt error', async () => {
    const item = await sharedFile('original'); const { context, room, torrent } = await engineFixture(item, true);
    room.transfers.set(item.file.fileId, { haveLocally: false, status: 'error' });
    context.wireTorrentStats(room, torrent); torrent.emit('upload');
    expect(room.transfers.get(item.file.fileId).haveLocally).toBe(false);
    expect(room.transfers.get(item.file.fileId).status).toBe('error');
  });
  it('restores E2E files by authenticating ciphertext, never by trusting an old plaintext path', async () => {
    const plain = path.join(root, 'original.mkv'), cipher = path.join(root, 'cipher'); fs.writeFileSync(plain, 'encrypted film');
    const key = generateRoomSecret(); await encryptFile(plain, cipher, key);
    const item = await sharedFile(fs.readFileSync(cipher), 'film.mkv', true);
    const { context, room } = await engineFixture(item, true); room.e2e = true; room.secret = key; room.files.clear();
    const oldPlain = path.join(root, 'film.mkv'); fs.writeFileSync(oldPlain, 'unrelated film');
    context.restoreManifestFile(room, { ...item.file, localPath: oldPlain, cipherPath: item.source, torrentFile: item.metadata.toString('base64') });
    expect(room.transfers.get(item.file.fileId).haveLocally).toBe(false);
    await vi.waitFor(() => expect(room.transfers.get(item.file.fileId).haveLocally).toBe(true));
    const result = context.verifiedLocalFile('room', item.file.fileId);
    expect(result).not.toBe(oldPlain); expect(fs.readFileSync(result, 'utf8')).toBe('encrypted film');
    expect(fs.readFileSync(oldPlain, 'utf8')).toBe('unrelated film');
  });
  it('keeps a wrong-key failure visible even when the ciphertext is being seeded', async () => {
    const plain = path.join(root, 'original'), cipher = path.join(root, 'cipher'); fs.writeFileSync(plain, 'encrypted film');
    await encryptFile(plain, cipher, generateRoomSecret());
    const item = await sharedFile(fs.readFileSync(cipher), 'film.mkv', true);
    const { context, room, torrent } = await engineFixture(item, true); room.e2e = true; room.secret = generateRoomSecret(); room.files.clear();
    context.restoreManifestFile(room, { ...item.file, cipherPath: item.source, torrentFile: item.metadata.toString('base64') });
    await vi.waitFor(() => expect(room.transfers.get(item.file.fileId).status).toBe('error'));
    torrent.emit('upload');
    expect(room.transfers.get(item.file.fileId).haveLocally).toBe(false);
    expect(room.transfers.get(item.file.fileId).status).toBe('error');
    expect(() => context.verifiedLocalFile('room', item.file.fileId)).toThrow();
  });
  it('reuses an unchanged managed plaintext after authenticating it again', async () => {
    const source = path.join(root, 'original'), cipher = path.join(root, 'cipher'); fs.writeFileSync(source, 'encrypted film');
    const key = generateRoomSecret(); await encryptFile(source, cipher, key);
    const item = await sharedFile(fs.readFileSync(cipher), 'film.mkv', true);
    const cachedPlain = storage.newRoomFilePath(root, item.file.fileId, item.file.name); fs.writeFileSync(cachedPlain, 'encrypted film');
    const { context, room } = await engineFixture(item, true); room.e2e = true; room.secret = key; room.files.clear();
    context.restoreManifestFile(room, { ...item.file, localPath: cachedPlain, cipherPath: item.source, torrentFile: item.metadata.toString('base64') });
    await vi.waitFor(() => expect(room.transfers.get(item.file.fileId).haveLocally).toBe(true));
    expect(context.verifiedLocalFile('room', item.file.fileId)).toBe(cachedPlain);
    const parent = storage.roomFileDir(root, item.file.fileId);
    expect(fs.readdirSync(parent).flatMap(dir => fs.readdirSync(path.join(parent, dir)))).toEqual(['film.mkv']);
  });
  it('does not complete migration or add a torrent after leaving the room', async () => {
    const item = await sharedFile('original'); const { context, room, client } = await engineFixture(item, true);
    room.transfers.set(item.file.fileId, { localPath: item.source });
    const pending = context.ensureLocal(room, item.file); context.rooms.delete('room'); await pending;
    expect(client.add).not.toHaveBeenCalled(); expect(room.transfers.get(item.file.fileId).haveLocally).toBe(false);
  });
  it('deduplicates preparation when the same file is requested twice', async () => {
    const item = await sharedFile('original'); const { context, room, client } = await engineFixture(item);
    room.transfers.set(item.file.fileId, { localPath: item.source });
    await Promise.all([context.ensureLocal(room, item.file), context.ensureLocal(room, item.file)]);
    expect(client.add).toHaveBeenCalledOnce();
  });
  it('does not start a replacement download during restore in manual mode', async () => {
    const item = await sharedFile('original'); const { context, room, client } = await engineFixture(item);
    room.transfers.set(item.file.fileId, { localPath: item.source }); fs.writeFileSync(item.source, 'replaced');
    await context.ensureLocal(room, item.file, false);
    expect(client.add).not.toHaveBeenCalled(); expect(room.transfers.get(item.file.fileId).haveLocally).toBe(false);
  });
  it('resumes a persisted partial download only in its owned file-ID slot', async () => {
    const item = await sharedFile('original film'); const { context, room, client } = await engineFixture(item);
    const partial = storage.newRoomFilePath(root, item.file.fileId, item.file.name); fs.writeFileSync(partial, 'ori');
    room.files.clear();
    context.restoreManifestFile(room, { ...item.file, localPath: partial, partialDownload: true, torrentFile: item.metadata.toString('base64') });
    await vi.waitFor(() => expect(client.add).toHaveBeenCalledOnce());
    expect(client.options.path).toBe(path.dirname(partial)); expect(room.transfers.get(item.file.fileId).haveLocally).toBe(false);
    expect(fs.readFileSync(partial, 'utf8')).toBe('ori');
  });
  it('ignores a partial-download marker on a legacy or foreign path', async () => {
    const item = await sharedFile('original film'); const { context, room, client } = await engineFixture(item);
    const foreign = path.join(root, item.file.name); fs.writeFileSync(foreign, 'other film'); room.files.clear();
    context.restoreManifestFile(room, { ...item.file, localPath: foreign, partialDownload: true, torrentFile: item.metadata.toString('base64') });
    await vi.waitFor(() => expect(client.add).toHaveBeenCalledOnce());
    expect(client.options.path).not.toBe(root); expect(fs.readFileSync(foreign, 'utf8')).toBe('other film');
  });
  it('never deletes an explicitly shared original even inside the managed tree', async () => {
    const item = await sharedFile('original'); const { context, room } = await engineFixture(item);
    const original = storage.newRoomFilePath(root, item.file.fileId, item.file.name); fs.copyFileSync(item.source, original);
    context.storageFor(room).originals.add(item.file.fileId);
    room.transfers.set(item.file.fileId, { localPath: original, haveLocally: true });
    context.applyTombstone(room, item.file.fileId, 2);
    expect(fs.readFileSync(original, 'utf8')).toBe('original'); expect(room.files.has(item.file.fileId)).toBe(false);
  });
  it('does not delete an unverified legacy ciphertext outside its owned cache', async () => {
    const item = await sharedFile('original'); const { context, room } = await engineFixture(item);
    room.transfers.set(item.file.fileId, { cipherPath: item.source, haveLocally: false });
    context.applyTombstone(room, item.file.fileId, 2);
    expect(fs.readFileSync(item.source, 'utf8')).toBe('original');
  });
  it('rejects unexpected torrent metadata before its store can write files', async () => {
    const item = await sharedFile('original'); const other = await sharedFile('replaced', 'other.mkv');
    const { context, room, client } = await engineFixture(item); await context.ensureLocal(room, item.file);
    const store = new client.options.store(16384, { torrent: { torrentFile: other.metadata } });
    await new Promise<void>(resolve => store.put(0, Buffer.from('malicious'), (error: Error) => { expect(error).toBeTruthy(); resolve(); }));
    expect(fs.readdirSync(client.options.path)).toHaveLength(0);
  });
  it('verifies and seeds two same-name restored files with the real WebTorrent store', async () => {
    const a = await sharedFile('first film'), b = await sharedFile('other film');
    const { context, room } = await engineFixture(a);
    const { default: WebTorrent } = await import('webtorrent');
    const client: any = new WebTorrent({ dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false });
    context.ensureClient = () => client; context.clients.set('room', client);
    context.findTorrent = (_client: unknown, hash: string) => client.torrents.find((t: any) => t.infoHash === hash);
    context.addKnownTorrent = (_client: unknown, _hash: string, source: unknown, options: unknown, cb: unknown) => client.add(source, options, cb);
    room.files.clear();
    try {
      for (const item of [a, b]) context.restoreManifestFile(room, { ...item.file, localPath: item.source, torrentFile: item.metadata.toString('base64') });
      await vi.waitFor(() => expect([a, b].every(item => room.transfers.get(item.file.fileId)?.haveLocally)).toBe(true), { timeout: 10000 });
      const p1 = context.verifiedLocalFile('room', a.file.fileId), p2 = context.verifiedLocalFile('room', b.file.fileId);
      expect(p1).not.toBe(p2); expect(fs.readFileSync(p1, 'utf8')).toBe('first film'); expect(fs.readFileSync(p2, 'utf8')).toBe('other film');
      expect(client.torrents.map((t: any) => t.infoHash).sort()).toEqual([a.file.fileId, b.file.fileId].sort());
    } finally { context.rooms.delete('room'); await new Promise<void>(resolve => client.destroy(resolve)); }
  }, 15000);
});
