import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MediaRelocations, type MediaRelocationRecord } from './media-relocations';
import { HistoryPlayback } from './history-playback';
import type { MediaRelocationTarget } from '../../shared/media-relocation';
import type { Download } from '../../shared/types';
let directory: string, disk: string, records: MediaRelocationRecord[], now: number;
const target: MediaRelocationTarget = { identity: 'hash', downloadId: 'download', title: 'Movie', path: 'old/movie.mp4', fileIndex: 7, length: 64 };
const registry = (write = (next: MediaRelocationRecord[]) => { records = structuredClone(next); }) => new MediaRelocations(() => structuredClone(records), write, () => now);
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-relocation-')); disk = path.join(directory, 'new-name.mp4'); fs.writeFileSync(disk, Buffer.alloc(64, 1)); records = []; now = 1000; });
afterEach(() => { if (path.dirname(directory) !== fs.realpathSync(os.tmpdir()) && path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('havvn-relocation-')) throw Error('Invalid test directory'); fs.rmSync(directory, { recursive: true, force: true }); });
describe('playback-only media relocation', () => {
  it('does not write while choosing and preserves the original identity, path and ordinal after confirmation', () => {
    const write = vi.fn((rows: MediaRelocationRecord[]) => { records = structuredClone(rows); }), api = registry(write);
    const preview = api.preview(target, disk); expect(preview).toMatchObject({ sizeMatches: true, formatMatches: true }); expect(write).not.toHaveBeenCalled();
    expect(api.confirm(preview.token)).toEqual({ target, available: true }); expect(write).toHaveBeenCalledOnce();
    expect(registry().find('download', 7)?.target.path).toBe('old/movie.mp4'); expect(registry().list()[0].target.identity).toBe('hash');
  });
  it('does not accept a matching name with a different size or media type', () => {
    const api = registry(); fs.writeFileSync(disk, Buffer.alloc(12));
    const small = api.preview(target, disk); expect(small.sizeMatches).toBe(false); expect(() => api.confirm(small.token)).toThrow('does not match');
    const audio = path.join(directory, 'new-name.mp3'); fs.writeFileSync(audio, Buffer.alloc(64));
    const wrong = api.preview(target, audio); expect(wrong.formatMatches).toBe(false); expect(() => api.confirm(wrong.token)).toThrow('does not match'); expect(records).toEqual([]);
  });
  it('rejects changed files, expired previews and replayed confirmations', () => {
    const api = registry(), first = api.preview(target, disk); fs.appendFileSync(disk, '!'); expect(() => api.confirm(first.token)).toThrow('changed');
    fs.writeFileSync(disk, Buffer.alloc(64)); const expired = api.preview(target, disk); now += 120001; expect(() => api.confirm(expired.token)).toThrow('expired');
    const valid = api.preview(target, disk); api.confirm(valid.token); expect(() => api.confirm(valid.token)).toThrow('expired');
  });
  it('keeps the previous binding when persistence fails and notices a removed file after restart', () => {
    const api = registry(); api.confirm(api.preview(target, disk).token);
    const another = path.join(directory, 'other.mp4'); fs.writeFileSync(another, Buffer.alloc(64));
    const failing = registry(() => { throw Error('disk full'); }); expect(() => failing.confirm(failing.preview(target, another).token)).toThrow('disk full');
    expect(registry().find('download', 7)?.disk).toBe(fs.realpathSync(disk)); fs.unlinkSync(disk); expect(registry().list()[0].available).toBe(false);
  });
  it('cancels previews and rejects an absolute logical path', () => {
    const api = registry(), preview = api.preview(target, disk); api.cancel(preview.token); expect(() => api.confirm(preview.token)).toThrow();
    expect(() => api.preview({ ...target, path: 'C:/private/movie.mp4' }, disk)).toThrow('target'); expect(records).toEqual([]);
  });
  it('plays a relocated local file even after the download record is removed, without invoking torrent streaming', async () => {
    const relocations = registry(); relocations.confirm(relocations.preview(target, disk).token);
    const stream = vi.fn(), api = new HistoryPlayback({ relocations, download: async () => null, files: vi.fn(async () => []), stream, ffmpeg: () => null, cached: () => [], cache: vi.fn() });
    try {
      expect(await api.files('download')).toMatchObject([{ index: 7, path: target.path, availability: 'local' }]);
      expect(await api.watchTarget('download', target.path)).toMatchObject({ identity: target.identity, fileIndex: 7, path: target.path });
      const resolved = await api.stream('download', 7); const response = await fetch(resolved.url); expect(response.status).toBe(200); expect((await response.arrayBuffer()).byteLength).toBe(64);
      expect(stream).not.toHaveBeenCalled(); expect(await api.localFile('download', target.path)).toMatchObject({ ok: true, disk: fs.realpathSync(disk) });
    } finally { api.close(); }
  });
  it('does not reuse a binding for a different torrent occupying the old download id', async () => {
    const relocations = registry(); relocations.confirm(relocations.preview(target, disk).token);
    const api = new HistoryPlayback({ relocations, download: async () => ({ id: 'download', infoHash: 'different', savePath: directory, status: 'paused', progress: 0 } as Download), files: async () => [], stream: vi.fn(), ffmpeg: () => null, cached: () => [], cache: vi.fn() });
    try { await expect(api.stream('download', 7)).rejects.toThrow('unavailable'); expect(await api.localFile('download', target.path)).toMatchObject({ ok: false }); }
    finally { api.close(); }
  });
});
