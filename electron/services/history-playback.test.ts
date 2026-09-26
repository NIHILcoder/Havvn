import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Download, TorrentFile } from '../../shared/types';
import { HistoryPlayback } from './history-playback';

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
