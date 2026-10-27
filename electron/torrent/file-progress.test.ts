import { describe, expect, it, vi } from 'vitest';
import WebTorrentFile from 'webtorrent/lib/file.js';
import Piece from 'torrent-piece';
import { verifiedFileProgress } from './file-progress';
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('./host/env', () => ({ getHostEnv: () => ({ isPackaged: false }) }));
import { TorrentManager } from './manager';
import type { Download } from '../../shared/types';

describe('WebTorrent file progress', () => {
  function snapshot(pieceLength = 2 ** 20, count = 3, lastPieceLength = pieceLength) {
    const have = new Set<number>();
    const torrent = { pieceLength, lastPieceLength, pieces: Array.from({ length: count }, (_, i) => new Piece(i === count - 1 ? lastPieceLength : pieceLength)),
      bitfield: { get: (index: number) => have.has(index) }, client: {} };
    return { have, torrent };
  }
  it('reproduces the 61-byte bug in the installed getter and fixes the source mapping', async () => {
    const { torrent, have } = snapshot();
    const file = new WebTorrentFile(torrent, { name: 'autorun.inf', path: 'Pack/autorun.inf', offset: 500_000, length: 61 });
    torrent.pieces[0].set(0, Buffer.alloc(16_384), {});
    expect(file.downloaded).toBe(-16_384);
    expect(file.progress).toBeLessThan(-200);
    const manager = new TorrentManager();
    Object.assign(manager, { managedTorrents: new Map([['test', { download: { filePriorities: [] } as unknown as Download, torrent: { ...torrent, files: [file] } }]]) });
    expect((await manager.getFiles('test'))[0]).toMatchObject({ length: 61, downloaded: 0, progress: 0 });
    have.add(0);
    expect((await manager.getFiles('test'))[0]).toMatchObject({ downloaded: 61, progress: 1 });
  });
  it('counts the final piece when the file ends exactly on a piece boundary', () => {
    const { torrent, have } = snapshot(); have.add(0); have.add(1);
    const file = new WebTorrentFile(torrent, { name: 'data.bin', path: 'Pack/data.bin', offset: 0, length: 2 * torrent.pieceLength });
    expect(file.downloaded).toBe(torrent.pieceLength);
    expect(verifiedFileProgress(torrent, file)).toEqual({ length: file.length, downloaded: file.length, progress: 1 });
  });
  it('counts file overlap, including a short final piece', () => {
    const { torrent, have } = snapshot(1024, 3, 61); have.add(1); have.add(2);
    expect(verifiedFileProgress(torrent, { offset: 1000, length: 1109 })).toEqual({ length: 1109, downloaded: 1085, progress: 1085 / 1109 });
    expect(verifiedFileProgress(torrent, { offset: 2048, length: 61 }).progress).toBe(1);
    expect(verifiedFileProgress(torrent, { offset: 17, length: 0 }).progress).toBe(1);
  });
  it('does not treat in-flight or failed-hash data as completed content', () => {
    const { torrent, have } = snapshot(1024, 1); torrent.pieces[0].missing = 0;
    expect(verifiedFileProgress(torrent, { offset: 10, length: 61 }).downloaded).toBe(0);
    have.add(0); expect(verifiedFileProgress(torrent, { offset: 10, length: 61 }).progress).toBe(1);
    have.delete(0); expect(verifiedFileProgress(torrent, { offset: 10, length: 61 }).progress).toBe(0);
  });
});
