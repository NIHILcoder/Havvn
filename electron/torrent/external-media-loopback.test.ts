import { expect, it, vi } from 'vitest';
import WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Download } from '../../shared/types';
import { ExternalStream } from '../services/external-stream';
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('./host/env', () => ({ getHostEnv: () => ({ isPackaged: false }) }));
import { TorrentManager } from './manager';

it('streams actual verified WebTorrent pieces from an incomplete loopback download, including a suffix seek', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-external-loopback-'));
  const quiet = { dht: false, tracker: false, lsd: false, webSeeds: false, natUpnp: false, natPmp: false };
  const seeder = new WebTorrent(quiet), leecher = new WebTorrent(quiet), manager = new TorrentManager();
  let stream: ExternalStream | null = null;
  try {
    const content = crypto.randomBytes(2 * 1024 * 1024), source = path.join(root, 'Фильм.webm'); fs.writeFileSync(source, content);
    const seeded = await new Promise<Torrent>(resolve => seeder.seed(source, { announce: [], pieceLength: 256 * 1024 }, resolve));
    const torrent = await new Promise<Torrent>(resolve => leecher.add(seeded.torrentFile, { announce: [], path: path.join(root, 'download') }, resolve));
    torrent.files[0].deselect(); torrent.select(0, 0, 1); torrent.select(7, 7, 1);
    const download = { status: 'downloading', savePath: path.join(root, 'download') } as Download;
    Object.assign(manager, { managedTorrents: new Map([['test', { torrent, download }]]) });
    const rel = torrent.files[0].path, info = await manager.getExternalMedia('test', rel); if (!info.ok) throw Error(info.reason);
    stream = new ExternalStream(content.length, (start, max) => manager.readExternalMedia('test', rel, info.key, start, max), () => stream!.close());
    const url = await stream.url();
    const head = fetch(url, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(15000) }).then(r => r.arrayBuffer());
    torrent.addPeer('127.0.0.1:' + seeder.torrentPort);
    expect(Buffer.from(await head)).toEqual(content.subarray(0, 1024));
    const tail = await fetch(url, { headers: { Range: 'bytes=-1024' }, signal: AbortSignal.timeout(15000) });
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(content.subarray(content.length - 1024));
    expect(torrent.files[0].downloaded).toBeLessThan(content.length);
    stream.close(); expect(download.status).toBe('downloading');
    await expect(fetch(url)).rejects.toThrow();
  } finally {
    stream?.close(); await new Promise<void>(r => leecher.destroy(() => r())); await new Promise<void>(r => seeder.destroy(() => r()));
    expect(path.dirname(root)).toBe(fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
