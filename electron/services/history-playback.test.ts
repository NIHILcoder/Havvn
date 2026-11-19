import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Download, TorrentFile } from '../../shared/types';
import { HistoryPlayback } from './history-playback';
it('exports only verified complete exact-size files for device pairing without starting the engine', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-device-media-'));
  const disk = path.join(directory, 'film.mp4'); fs.writeFileSync(disk, Buffer.alloc(10));
  const d = { id: 'one', infoHash: 'a'.repeat(40), name: 'Film', savePath: directory, progress: 1, status: 'paused' } as Download;
  const stream = vi.fn();
  const api = new HistoryPlayback({ download: async () => d, files: async () => [{ name: 'film.mp4', path: 'film.mp4', length: 10, downloaded: 10, progress: 1 }], cached: () => [], cache: vi.fn(), stream, ffmpeg: () => null });
  try {
    expect((await api.deviceFiles('one'))[0]).toMatchObject({ infoHash: d.infoHash, size: 10, path: 'film.mp4', disk });
    fs.appendFileSync(disk, 'extra'); expect(await api.deviceFiles('one')).toEqual([]);
    expect(stream).not.toHaveBeenCalled();
  } finally { api.close(); fs.unlinkSync(disk); fs.rmdirSync(directory); }
});

it('does not reuse cached completion after re-add, even when a preallocated file has its full size', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-library-readd-'));
  const disk = path.join(directory, 'film.mp4'); fs.writeFileSync(disk, Buffer.alloc(10));
  const d = { id: 'new', infoHash: 'same-hash', savePath: directory, progress: 0, status: 'paused' } as Download;
  const cached = [{ path: 'film.mp4', name: 'film.mp4', index: 0, length: 10, downloaded: 10, progress: 1 }];
  const stream = vi.fn(), api = new HistoryPlayback({ download: async () => d, files: async () => [], cached: () => cached, cache: vi.fn(), stream, ffmpeg: () => null });
  try {
    expect((await api.libraryFiles('new')).files[0].availability).toBe('paused');
    await expect(api.stream('new', 0)).rejects.toThrow('resume'); expect(stream).not.toHaveBeenCalled();
    d.progress = 1; expect((await api.files('new'))[0].availability).toBe('local');
    d.filePriorities = ['skip']; expect((await api.files('new'))[0].availability).not.toBe('local');
    d.selectedFiles = [1]; d.filePriorities = ['high'];
    // Enabling a previously excluded file is not proof that its preallocated
    // bytes have been verified: the old overall 100% may predate that change.
    expect((await api.files('new'))[0].availability).not.toBe('local');
  } finally { api.close(); fs.unlinkSync(disk); fs.rmdirSync(directory); }
});

it('bounds library inspection before disk checks, preserves file ordinals and never starts transfers', async () => {
  const d = { id: 'one', infoHash: 'hash', savePath: 'missing-root', status: 'paused', progress: 0 } as Download;
  const media = Array.from({ length: 600 }, (_, i) => ({ name: i % 2 ? 'file.mp4' : 'notes.txt', path: String(i) + (i % 2 ? '.mp4' : '.txt'), length: 100, downloaded: 0, progress: 0 }));
  const stream = vi.fn(), cached = vi.fn(), cache = vi.fn();
  const api = new HistoryPlayback({ download: async () => d, files: async () => media, stream, ffmpeg: () => null, cached: () => cached() || [], cache });
  try {
    const result = await api.libraryFiles('one', 10);
    expect(result.files).toHaveLength(10); expect(result.truncated).toBe(true); expect(result.files[0].index).toBe(1);
    expect(result.files.every(f => f.availability !== 'local')).toBe(true); expect(stream).not.toHaveBeenCalled(); expect(cache).not.toHaveBeenCalled();
    await expect(api.libraryFiles('one', 501)).rejects.toThrow('limit');
  } finally { api.close(); }
});
it('discards a catalog result if the source is removed or replaced while metadata is awaited', async () => {
  let d: Download | null = { id: 'one', infoHash: 'hash', savePath: 'missing-root', status: 'paused' } as Download;
  let release!: (files: TorrentFile[]) => void;
  const api = new HistoryPlayback({ download: async () => d, files: () => new Promise(resolve => { release = resolve; }), stream: vi.fn(), ffmpeg: () => null, cached: () => [], cache: vi.fn() });
  try {
    const pending = api.libraryFiles('one'); await Promise.resolve(); await Promise.resolve();
    d = null; release([{ name: 'film.mp4', path: 'film.mp4', length: 10, downloaded: 10, progress: 1 }]);
    expect((await pending).files).toEqual([]);
  } finally { api.close(); }
});

it('plays completed paused files using real HTTP Range without starting torrents; tracks a moved directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-history-'));
  const file = path.join(root, 'film.mp4'); fs.writeFileSync(file, Buffer.from('0123456789'));
  const d = { id: 'test', infoHash: 'hash', savePath: root, status: 'paused', progress: 1 } as Download;
  const f = { name: 'film.mp4', path: 'film.mp4', length: 10, downloaded: 10, progress: 1 } as TorrentFile;
  const stream = vi.fn(), cache = new Map<string, TorrentFile[]>();
  const api = new HistoryPlayback({ download: async () => d, files: async () => [f], stream, ffmpeg: () => null,
    cached: key => cache.get(key) || [], cache: (key, files) => cache.set(key, files) });
  try {
    expect((await api.files('test'))[0].availability).toBe('local');
    let url = (await api.stream('test', 0)).url;
    const res = await fetch(url, { headers: { Range: 'bytes=3-6' } }); expect(res.status).toBe(206); expect(await res.text()).toBe('3456');
    const forged = new URL(url); forged.searchParams.set('k', 'wrong'); expect((await fetch(forged)).status).toBe(403);
    const moved = path.join(root, 'moved'); fs.mkdirSync(moved); fs.renameSync(file, path.join(moved, 'film.mp4')); d.savePath = moved;
    url = (await api.stream('test', 0)).url; expect(await (await fetch(url)).text()).toBe('0123456789');
    fs.unlinkSync(path.join(moved, 'film.mp4')); expect((await api.files('test'))[0].availability).toBe('missing');
    await expect(api.stream('test', 0)).rejects.toThrow('unavailable'); expect(stream).not.toHaveBeenCalled();
  } finally {
    api.close();
    for (const p of [file, path.join(root, 'moved', 'film.mp4')]) if (fs.existsSync(p)) fs.unlinkSync(p);
    if (fs.existsSync(path.join(root, 'moved'))) fs.rmdirSync(path.join(root, 'moved'));
    fs.rmdirSync(root);
  }
});
it('never streams a paused partial file or removed record and rejects traversal and executables', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-history-'));
  const file = path.join(root, 'film.mp4'); fs.writeFileSync(file, 'partial');
  const d = { id: 'test', savePath: root, status: 'paused', progress: 0.5 } as Download;
  let files = [{ name: 'film.mp4', path: 'film.mp4', length: 100, downloaded: 7, progress: 0.07 }]; const stream = vi.fn();
  const api = new HistoryPlayback({ download: async () => d, files: async () => files, stream, ffmpeg: () => null, cached: () => [], cache: () => {} });
  try {
    expect((await api.files('test'))[0].availability).toBe('paused'); await expect(api.stream('test', 0)).rejects.toThrow('resume');
    d.status = 'removed'; expect(await api.files('test')).toEqual([]); await expect(api.stream('test', 0)).rejects.toThrow('unavailable');
    d.status = 'downloading'; files = [{ ...files[0], path: '../film.mp4' }]; await expect(api.stream('test', 0)).rejects.toThrow('unavailable');
    files = [{ ...files[0], name: 'film.exe', path: 'film.mp4' }]; await expect(api.stream('test', 0)).rejects.toThrow('unavailable');
    expect(stream).not.toHaveBeenCalled();
    files = [{ ...files[0], name: 'film.mp4', path: 'film.mp4' }]; stream.mockResolvedValue({ url: 'existing-stream' });
    await api.stream('test', 0, { startTime: 42 }); expect(stream).toHaveBeenCalledWith('test', 0, { startTime: 42, noResume: true });
  } finally { api.close(); fs.unlinkSync(file); fs.rmdirSync(root); }
});
