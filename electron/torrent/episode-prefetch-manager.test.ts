import { expect, it, vi } from 'vitest';
import type { Download } from '../../shared/types';
import { EpisodePrefetcher } from './episode-prefetch';

vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('./host/env', () => ({ getHostEnv: () => ({ isPackaged: false }) }));
import { TorrentManager } from './manager';

function fixture() {
  const manager = new TorrentManager();
  const selection = { from: 0, to: 3, priority: 1, notify: () => {} };
  const items = [selection];
  const torrent = { pieceLength: 1024, bitfield: { get: () => false }, _selections: { _items: items },
    files: [0, 1].map(index => ({ name: `episode${index}.webm`, offset: index * 4096, length: 4096, deselect: vi.fn() })),
    _select: vi.fn((from: number, to: number, priority: number, notify: () => void) => items.push({ from, to, priority, notify })),
    _updateSelections: vi.fn(), deselect: vi.fn() };
  const download = { status: 'downloading', filePriorities: { 1: 'skip' } } as Download;
  const managed = { id: 'test', torrent, download, selectedFiles: [0], streamHead: { fileIndex: 0, startPiece: 0, endPiece: 3 } };
  Object.assign(manager, { initDone: Promise.resolve(), managedTorrents: new Map([['test', managed]]), episodePrefetcher: new EpisodePrefetcher() });
  const request = { currentFile: 0, nextFile: 1, budgetBytes: 2048, allowExcluded: false, lease: 'owner-test' };
  return { manager, torrent, download, managed, request, selection };
}

it('requires consent for both skipped files and a selected-files subset', async () => {
  const { manager, torrent, download, request } = fixture();
  expect((await manager.prefetchEpisode('test', request)).state).toBe('skipped');
  download.filePriorities = {};
  expect((await manager.prefetchEpisode('test', request)).state).toBe('skipped');
  expect(torrent._select).not.toHaveBeenCalled();
});
it('prefetches an excluded head with consent without changing persisted priorities', async () => {
  const { manager, torrent, download, managed, request, selection } = fixture();
  expect((await manager.prefetchEpisode('test', { ...request, allowExcluded: true })).state).toBe('active');
  expect(download.filePriorities).toEqual({ 1: 'skip' });
  expect(managed.selectedFiles).toEqual([0]);
  await manager.stopEpisodePrefetch('test', request.lease);
  expect(torrent._selections._items).toEqual([selection]);
  expect(download.status).toBe('downloading');
});
it('does not select pieces or resume a paused or completed download', async () => {
  const { manager, torrent, download, request } = fixture();
  for (const status of ['paused', 'completed', 'seeding', 'queued', 'error'] as const) {
    download.status = status;
    expect((await manager.prefetchEpisode('test', { ...request, allowExcluded: true })).state).toBe('inactive');
    expect(download.status).toBe(status);
  }
  expect(torrent._select).not.toHaveBeenCalled();
});
it('rejects a stale current file and cancels the active selection on stream close', async () => {
  const { manager, torrent, request, selection } = fixture();
  expect((await manager.prefetchEpisode('test', { ...request, currentFile: 2, allowExcluded: true })).state).toBe('inactive');
  await manager.prefetchEpisode('test', { ...request, allowExcluded: true });
  await manager.stopStream('test', 0);
  expect(torrent._selections._items).toEqual([selection]);
});
it('rejects invalid targets before adding any selection', async () => {
  const { manager, torrent, request } = fixture();
  torrent.files[1].name = 'readme.txt';
  await expect(manager.prefetchEpisode('test', { ...request, allowExcluded: true })).rejects.toThrow('Invalid next episode');
  await expect(manager.prefetchEpisode('test', { ...request, nextFile: 9, allowExcluded: true })).rejects.toThrow('Invalid next episode');
  expect(torrent._select).not.toHaveBeenCalled();
});
