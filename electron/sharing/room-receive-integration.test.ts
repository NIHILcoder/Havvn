import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import createTorrent from 'create-torrent';
import type { PersistedRoomFile } from '../../shared/types';

const H = vi.hoisted(() => ({ clients: [] as any[], stores: 0, puts: 0 }));
vi.mock('webtorrent', async () => {
  const { default: parse } = await import('parse-torrent');
  class Torrent {
    handlers = new Map<string, Array<(...args: any[]) => void>>();
    done = false; progress = 0; destroyed = false; torrentFile?: Buffer;
    constructor(public infoHash: string, public opts: any, public ready: (t: Torrent) => void) {}
    on(event: string, fn: (...args: any[]) => void) { this.handlers.set(event, [...(this.handlers.get(event) || []), fn]); return this; }
    once(event: string, fn: (...args: any[]) => void) { return this.on(event, fn); }
    emit(event: string, ...args: any[]) { for (const fn of this.handlers.get(event) || []) fn(...args); }
    complete(raw: Buffer, contents: string) {
      this.torrentFile = raw; this.ready(this);
      fs.writeFileSync(path.join(this.opts.path, parse(raw).name), contents);
      this.done = true; this.progress = 1; this.emit('done');
    }
  }
  return { default: class {
    torrents = new Map<string, Torrent>();
    destroyed = false;
    constructor() { H.clients.push(this); }
    throttleUpload() {} throttleDownload() {}
    on() {} once() {} removeListener() {}
    get(id: string) { return this.torrents.get(id); }
    add(source: any, opts: any, ready: any) {
      const id = parse(source).infoHash;
      const t = new Torrent(id, opts, ready); this.torrents.set(id, t); return t;
    }
    remove(t: Torrent, cb?: () => void) { this.torrents.delete(t.infoHash); t.destroyed = true; t.emit('close'); cb?.(); }
    destroy(cb?: () => void) { this.destroyed = true; this.torrents.clear(); cb?.(); }
  } };
});
vi.mock('bittorrent-tracker', () => ({ default: class { on() {} start() {} stop() {} destroy() {} } }));
vi.mock('fs-chunk-store', () => ({ default: class {
  constructor() { H.stores++; }
  put(_index: number, _data: unknown, cb: (error?: Error) => void) { H.puts++; cb(); }
} }));

let dir: string, listener: (e: unknown, msg: any) => Promise<void>, responses: any[], sequence = 0;
let files: PersistedRoomFile[], metadata: Buffer[];
const contents = ['one', 'two', 'three', 'four'];
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
async function cmd(type: string, args: Record<string, unknown> = {}) {
  const reqId = ++sequence;
  await listener(null, { type, reqId, ...args });
  const res = responses.find(r => r.reqId === reqId);
  if (!res?.ok) throw new Error(res?.error || 'Missing response');
  return res.data;
}
async function join(roomId: string, manifest: PersistedRoomFile[], autoFetch = true, e2e = false) {
  const folder = path.join(dir, roomId); fs.mkdirSync(folder, { recursive: true });
  return cmd('join', { payload: { roomId, code: 'queue-test-' + roomId, name: roomId, folder, cacheDir: path.join(dir, 'cache'),
    self: { memberId: 'self', name: 'self', avatarSeed: 'self', pub: '', priv: '' }, ownerId: 'self',
    manifest, tombstones: {}, mutes: [], identities: {}, chat: [], history: [], e2e, secret: '', autoFetch,
    useTurn: false, turnServers: [] } });
}
const snapshot = (roomId: string) => cmd('snapshot', { roomId });
const clients = () => (globalThis as any).__clients as Map<string, any>;

beforeEach(async () => {
  (globalThis as any).window = globalThis;
  H.clients.length = 0; H.stores = 0; H.puts = 0; responses = []; vi.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-receive-test-'));
  metadata = []; files = [];
  for (let i = 0; i < contents.length; i++) {
    const name = `file-${i}.txt`, source = path.join(dir, name); fs.writeFileSync(source, contents[i]);
    const raw = await new Promise<Buffer>((resolve, reject) => createTorrent(source, { name, announce: [] }, (err, bytes) => err ? reject(err) : resolve(Buffer.from(bytes!))));
    const { default: parse } = await import('parse-torrent'); const meta = parse(raw);
    metadata.push(raw); files.push({ fileId: meta.infoHash, infoHash: meta.infoHash, name, size: contents[i].length,
      magnetURI: `magnet:?xt=urn:btih:${meta.infoHash}`, addedBy: 'peer', addedByName: 'peer', addedAt: 1 });
  }
  vi.doMock('electron', () => ({ ipcRenderer: {
    on: (channel: string, fn: any) => { if (channel === 'room-cmd') listener = fn; },
    send: (channel: string, data: any) => { if (channel === 'room-res') responses.push(data); },
  } }));
  await import('./room-engine');
});
afterEach(async () => {
  await cmd('netSuspend'); vi.restoreAllMocks();
  // Only this test's freshly-created fixture is removed.
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('room engine receive resources', () => {
  it('shares two live slots across rooms, advances after errors and prioritizes waiting work', async () => {
    await join('a', files.slice(0, 2)); await join('b', files.slice(2)); await settle();
    expect(clients().get('a').torrents.size).toBe(2); expect(clients().has('b')).toBe(false);
    const b = await snapshot('b');
    expect(b.receiveQueue).toEqual({ active: 0, waiting: 2, waitingBytes: 9, concurrency: 2 });
    expect(b.transfers[files[2].fileId].queuePosition).toBe(1);
    await cmd('prioritizeReceive', { roomId: 'b', fileId: files[3].fileId });
    clients().get('a').get(files[0].fileId).emit('error', new Error('Peer closed'));
    await settle(); expect(clients().get('b').get(files[3].fileId)).toBeDefined();
    expect((await snapshot('b')).transfers[files[2].fileId].queuePosition).toBe(1);
    expect((await snapshot('a')).transfers[files[0].fileId].phase).toBe('error');
    await cmd('fetchFile', { roomId: 'a', fileId: files[0].fileId }); await settle();
    expect((await snapshot('a')).transfers[files[0].fileId].queuePosition).toBe(2);
  });
  it('holds a slot through content verification and releases it after completion', async () => {
    await join('a', files.slice(0, 3)); await settle();
    const client = clients().get('a'); expect(client.torrents.size).toBe(2);
    client.get(files[0].fileId).complete(metadata[0], contents[0]);
    await vi.waitFor(async () => expect((await snapshot('a')).transfers[files[0].fileId].haveLocally).toBe(true));
    expect(client.get(files[2].fileId)).toBeDefined();
  });
  it('pauses waiting and active files, preserves partial paths and resumes only explicitly', async () => {
    await join('a', files.slice(0, 3)); await settle();
    const active = (await snapshot('a')).transfers[files[0].fileId].localPath;
    fs.writeFileSync(active, contents[0].slice(0, 1));
    await cmd('pauseReceive', { roomId: 'a', fileId: files[2].fileId });
    const old = clients().get('a').get(files[0].fileId);
    await cmd('pauseReceive', { roomId: 'a', fileId: files[0].fileId });
    old.emit('error', new Error('Late failure')); await settle();
    expect((await snapshot('a')).transfers[files[0].fileId]).toMatchObject({ phase: 'paused', receivePaused: true });
    expect(clients().get('a').get(files[2].fileId)).toBeUndefined();
    await cmd('fetchFile', { roomId: 'a', fileId: files[0].fileId }); await settle();
    expect((await snapshot('a')).transfers[files[0].fileId]).toMatchObject({ phase: 'downloading', receivePaused: false, localPath: active });
    expect(fs.readFileSync(active, 'utf8')).toBe(contents[0].slice(0, 1));
  });
  it('restores a persisted pause without starting a torrent in auto mode', async () => {
    await join('a', [{ ...files[0], receivePaused: true }]); await settle();
    expect(clients().size).toBe(0);
    expect((await snapshot('a')).transfers[files[0].fileId].phase).toBe('paused');
    await cmd('fetchFile', { roomId: 'a', fileId: files[0].fileId }); await settle();
    expect(clients().get('a').get(files[0].fileId)).toBeDefined();
  });
  it('waits for closing a torrent before accepting a rapid resume or starting the next file', async () => {
    await join('a', files.slice(0, 3)); await settle();
    const client = clients().get('a'), old = client.get(files[0].fileId), remove = client.remove.bind(client);
    let close!: () => void;
    vi.spyOn(client, 'remove').mockImplementationOnce((t: any, cb: any) => { close = () => remove(t, cb); });
    const pause = cmd('pauseReceive', { roomId: 'a', fileId: files[0].fileId }); await settle();
    const resume = cmd('fetchFile', { roomId: 'a', fileId: files[0].fileId }); await settle();
    expect(client.get(files[2].fileId)).toBeUndefined(); expect(client.get(files[0].fileId)).toBe(old);
    close(); await Promise.all([pause, resume]); await settle();
    expect(client.get(files[2].fileId)).toBeDefined();
    expect((await snapshot('a')).transfers[files[0].fileId]).toMatchObject({ phase: 'queued', receivePaused: false, queuePosition: 1 });
  });
  it('reports disk-full before adding a torrent or opening its store', async () => {
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 0n, bsize: 4096n } as any);
    await join('a', [files[0]]); await settle();
    expect((await snapshot('a')).transfers[files[0].fileId].error.code).toBe('disk-full');
    expect(clients().get('a').torrents.size).toBe(0); expect(H.stores).toBe(0);
  });
  it('reserves both encrypted cache and plaintext destination before an E2E download', async () => {
    const probe = fs.statfsSync.bind(fs);
    vi.spyOn(fs, 'statfsSync').mockImplementation((target: any, options: any) => path.resolve(target) === path.join(dir, 'a')
      ? { bavail: 256n * 1024n * 1024n, bsize: 1n } as any : probe(target, options));
    await join('a', [{ ...files[0], enc: true }], true, true); await settle();
    expect((await snapshot('a')).transfers[files[0].fileId].error.code).toBe('disk-full');
    expect(clients().get('a').torrents.size).toBe(0);
  });
  it('refuses writes after pause and stops on space consumed during the download', async () => {
    await join('a', [files[0]]); await settle(); const t = clients().get('a').get(files[0].fileId);
    const store = new t.opts.store(16384, { torrent: { torrentFile: metadata[0] } });
    expect(H.stores).toBe(1);
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 0n, bsize: 4096n } as any);
    await new Promise<void>(resolve => store.put(0, Buffer.from(contents[0]), (err: any) => { expect(err.code).toBe('ENOSPC'); resolve(); }));
    expect(H.puts).toBe(0);
    await cmd('pauseReceive', { roomId: 'a', fileId: files[0].fileId });
    await new Promise<void>(resolve => store.put(0, Buffer.from(contents[0]), (err: Error) => { expect(err.message).toMatch(/canceled/); resolve(); }));
    expect(H.puts).toBe(0);
  });
  it('rejects metadata before opening a writable store and makes retry possible', async () => {
    await join('a', [files[0]]); await settle(); const c = clients().get('a'), t = c.get(files[0].fileId);
    const store = new t.opts.store(16384, { torrent: { torrentFile: metadata[1] } });
    expect(H.stores).toBe(0);
    await new Promise<void>(resolve => store.put(0, Buffer.from(contents[1]), (err: Error) => { expect(err).toBeInstanceOf(Error); resolve(); }));
    t.torrentFile = metadata[1]; t.ready(t); await settle();
    expect((await snapshot('a')).transfers[files[0].fileId].phase).toBe('error');
    await cmd('fetchFile', { roomId: 'a', fileId: files[0].fileId }); await settle();
    expect(c.get(files[0].fileId)).not.toBe(t);
  });
  it('cancels queued work on leaving and on VPN suspension without ghost clients', async () => {
    await join('a', files.slice(0, 3)); await join('b', [files[3]]); await settle();
    const old = clients().get('a'); await cmd('leave', { roomId: 'a' }); await settle();
    expect(old.destroyed).toBe(true); expect(clients().has('a')).toBe(false);
    expect(clients().get('b').get(files[3].fileId)).toBeDefined();
    await cmd('netSuspend'); await settle(); expect(clients().size).toBe(0);
  });
});


describe('local copy cleanup commands', () => {
  it('keeps the publication, closes its torrent and holds receive until an explicit fetch', async () => {
    await join('clean',[files[0]]);await settle();const client=clients().get('clean');
    client.get(files[0].fileId).complete(metadata[0],contents[0]);
    await vi.waitFor(async()=>expect((await snapshot('clean')).transfers[files[0].fileId].haveLocally).toBe(true));
    const target=(await snapshot('clean')).transfers[files[0].fileId].localPath;
    const usage=await cmd('diskUsage',{roomId:'clean'});expect(usage.removable).toBe(contents[0].length);
    expect(await cmd('cleanupCopies',{roomId:'clean',previewId:usage.previewId,fileIds:[files[0].fileId]})).toMatchObject({bytes:contents[0].length,files:1});
    expect(fs.existsSync(target)).toBe(false);expect(client.get(files[0].fileId)).toBeUndefined();
    const state=await snapshot('clean');expect(state.files).toHaveLength(1);expect(state.transfers[files[0].fileId]).toMatchObject({phase:'paused',receivePaused:true,haveLocally:false});
    await settle();expect(client.get(files[0].fileId)).toBeUndefined();
    await expect(cmd('cleanupCopies',{roomId:'clean',previewId:usage.previewId,fileIds:[files[0].fileId]})).rejects.toThrow(/expired/);
    await cmd('fetchFile',{roomId:'clean',fileId:files[0].fileId});await settle();expect(client.get(files[0].fileId)).toBeDefined();
  });
  it('rejects a stale preview without removing bytes or stopping the download', async () => {
    await join('clean',[files[0]]);await settle();const target=(await snapshot('clean')).transfers[files[0].fileId].localPath;
    fs.writeFileSync(target,'partial');const usage=await cmd('diskUsage',{roomId:'clean'});fs.writeFileSync(target,'changed');
    // A fast same-size rewrite can share a filesystem timestamp tick on Linux.
    // Make the changed file identity explicit instead of depending on elapsed wall time.
    const modified = new Date(Date.now() + 2000); fs.utimesSync(target, modified, modified);
    await expect(cmd('cleanupCopies',{roomId:'clean',previewId:usage.previewId,fileIds:[files[0].fileId]})).rejects.toThrow(/changed/);
    expect(fs.readFileSync(target,'utf8')).toBe('changed');expect(clients().get('clean').get(files[0].fileId)).toBeDefined();
  });
  it('waits for writers to close and serializes a racing manual fetch', async () => {
    await join('clean',[files[0]]);await settle();const client=clients().get('clean'), target=(await snapshot('clean')).transfers[files[0].fileId].localPath;
    fs.writeFileSync(target,'part');const usage=await cmd('diskUsage',{roomId:'clean'});const remove=client.remove.bind(client);let close!:()=>void;
    vi.spyOn(client,'remove').mockImplementationOnce((torrent:any,callback:any)=>{close=()=>remove(torrent,callback);});
    const cleaning=cmd('cleanupCopies',{roomId:'clean',previewId:usage.previewId,fileIds:[files[0].fileId]});await settle();
    const fetch=cmd('fetchFile',{roomId:'clean',fileId:files[0].fileId});await settle();expect(fs.existsSync(target)).toBe(true);
    close();await Promise.all([cleaning,fetch]);await settle();expect(fs.existsSync(target)).toBe(false);expect(client.get(files[0].fileId)).toBeDefined();
  });
});


it('protects both the selected source and its encrypted publication cache', async () => {
  const source=path.join(dir,files[0].name), cache=path.join(dir,'cache');fs.mkdirSync(cache,{recursive:true});
  const cipherDir=fs.mkdtempSync(path.join(cache,'share-')),cipher=path.join(cipherDir,'cipher.enc');fs.writeFileSync(cipher,'encrypted bytes');
  await join('protected',[{...files[0],enc:true,localOriginal:true,localPath:source,cipherPath:cipher,receivePaused:true}],false,true);
  const usage=await cmd('diskUsage',{roomId:'protected'});
  expect(usage.originals).toBe(contents[0].length);expect(usage.ciphertext).toBe(15);expect(usage.protectedCiphertext).toBe(15);expect(usage.removable).toBe(0);
  await expect(cmd('cleanupCopies',{roomId:'protected',previewId:usage.previewId,fileIds:[files[0].fileId]})).rejects.toThrow(/No managed local copy/);
  expect(fs.readFileSync(source,'utf8')).toBe(contents[0]);expect(fs.readFileSync(cipher,'utf8')).toBe('encrypted bytes');
});
