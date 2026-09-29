import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { Download, TorrentFile } from '../../shared/types';
import type { ExternalPlayerPreferences } from '../../shared/external-player';
import { externalStartTime } from '../../shared/external-player';
import { ExternalPlayer, type LocalMedia } from './external-player';
import { HistoryPlayback } from './history-playback';
import net from 'node:net';
import { watchKey } from '../../shared/watch-history';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  // All targets were created by this fixture under the OS temporary directory.
  expect(path.dirname(root)).toBe(fs.realpathSync(os.tmpdir()));
  for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file)); fs.rmdirSync(root);
} });
function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-external-')); roots.push(root);
  const name = 'Фильм $() & 01.mp4', disk = path.join(root, name); fs.writeFileSync(disk, '0123456789');
  const d = { id: 'test', infoHash: 'hash', name: 'Film', savePath: root, progress: 1, status: 'paused' } as Download;
  let files = [{ name, path: name, index: 7, length: 10, downloaded: 10, progress: 1 }] as TorrentFile[];
  const torrentStream = vi.fn();
  const history = new HistoryPlayback({ download: async () => d, files: async () => files, cached: () => [], cache: () => {}, stream: torrentStream, ffmpeg: () => null });
  let prefs: ExternalPlayerPreferences = { kind: 'default', executable: null };
  const openPath = vi.fn(async () => '');
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const spawn = vi.fn(() => { queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0, null); }); return child as unknown as ChildProcess; });
  const saveWatch = vi.fn();
  const player = new ExternalPlayer({ read: () => prefs, write: p => { prefs = p; }, resolve: (id, rel) => history.localFile(id, rel),
    watchTarget: (id, rel) => history.watchTarget(id, rel), saveWatch, openPath, spawn });
  const exe = (kind: 'vlc' | 'mpv') => { const p = path.join(root, kind + (process.platform === 'win32' ? '.exe' : '')); fs.writeFileSync(p, 'fixture'); fs.chmodSync(p, 0o700); return p; };
  return { root, name, disk, d, history, player, openPath, spawn, child, torrentStream, saveWatch, exe, setFiles: (f: TorrentFile[]) => { files = f; } };
}
it('tracks the trusted torrent file through a private pipe, including seeks and completion, without altering downloads', async () => {
  const f = fixture(); f.player.select(f.exe('mpv'));
  const target = (await f.history.watchTarget('test', f.name))!, session = { key: watchKey(target), epoch: 1, revision: 2 };
  let position = 150, socket: net.Socket | null = null;
  const server = net.createServer(s => {
    socket = s; s.setEncoding('utf8'); s.on('error', () => {}); let buffer = '';
    s.on('data', chunk => { buffer += chunk; let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        const data = m.command[1] === 'path' ? f.disk : m.command[1] === 'time-pos' ? position : 1000;
        s.write(JSON.stringify({ request_id: m.request_id, error: 'success', data }) + '\n');
      }
    });
  });
  f.spawn.mockImplementation((_exe, args) => {
    const ipc = args.find(a => a.startsWith('--input-ipc-server='))!.slice('--input-ipc-server='.length);
    expect(args.slice(-2)).toEqual(['--', f.disk]);
    server.listen(ipc, () => f.child.emit('spawn')); return f.child as unknown as ChildProcess;
  });
  try {
    expect((await f.player.open('test', f.name, 42, session)).ok).toBe(true);
    await vi.waitFor(() => expect(f.saveWatch.mock.calls.at(-1)?.[1]).toMatchObject({ ...target, position: 150, duration: 1000, completed: false }));
    position = 12; await vi.waitFor(() => expect(f.saveWatch.mock.calls.at(-1)?.[1].position).toBe(12), { timeout: 2500 });
    position = 970; await vi.waitFor(() => expect(f.saveWatch.mock.calls.at(-1)?.[1].completed).toBe(true), { timeout: 2500 });
    expect(f.saveWatch.mock.calls.at(-1)?.[2]).toEqual(session);
    f.child.emit('exit', 0, null); expect(f.saveWatch.mock.calls.at(-1)?.[1].position).toBe(970);
    const count = f.saveWatch.mock.calls.length; await new Promise(r => setTimeout(r, 1100)); expect(f.saveWatch).toHaveBeenCalledTimes(count);
    expect(f.d.status).toBe('paused'); expect(f.torrentStream).not.toHaveBeenCalled();
  } finally { f.player.close(); (socket as net.Socket | null)?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
it('rejects a forged history target and releases tracking when launch fails or Havvn closes', async () => {
  const f = fixture(); f.player.select(f.exe('mpv'));
  expect(await f.player.open('test', f.name, 0, { key: 'different-film', epoch: 0, revision: 1 })).toEqual({ ok: false, reason: 'unavailable' });
  expect(f.spawn).not.toHaveBeenCalled();
  f.spawn.mockImplementation(() => { queueMicrotask(() => f.child.emit('error', Error('launch'))); return f.child as unknown as ChildProcess; });
  const target = (await f.history.watchTarget('test', f.name))!;
  expect(await f.player.open('test', f.name, 0, { key: watchKey(target), epoch: 0, revision: 1 })).toEqual({ ok: false, reason: 'launch-failed' });
  f.player.close(); expect(f.saveWatch).not.toHaveBeenCalled();
});
it('opens a completed paused media file in the system application without starting the torrent', async () => {
  const f = fixture();
  expect(await f.player.open('test', f.name, 120)).toEqual({ ok: true, kind: 'default', startTime: 0 });
  expect(f.openPath).toHaveBeenCalledWith(f.disk); expect(f.spawn).not.toHaveBeenCalled(); expect(f.torrentStream).not.toHaveBeenCalled(); expect(f.d.status).toBe('paused');
});
it.each(['vlc', 'mpv'] as const)('persists %s and passes position and the whole Unicode path as separate arguments', async kind => {
  const f = fixture(), exe = f.exe(kind); expect(f.player.select(exe)).toEqual({ ok: true, config: { kind, executable: exe, available: true } });
  expect(await f.player.open('test', f.name, 12.3456)).toEqual({ ok: true, kind, startTime: 12.346 });
  expect(f.spawn).toHaveBeenCalledWith(exe, kind === 'vlc' ? ['--start-time=12.346', f.disk] : ['--start=12.346', '--', f.disk]);
  expect(f.child.unref).toHaveBeenCalled(); expect(f.openPath).not.toHaveBeenCalled();
  expect(f.player.getConfig().kind).toBe(kind); expect(f.player.useDefault().kind).toBe('default');
});
it('does not fall back silently when a saved executable disappears; rejects unsupported choices', async () => {
  const f = fixture(), exe = f.exe('mpv'); f.player.select(exe); fs.unlinkSync(exe);
  expect(f.player.getConfig()).toEqual({ kind: 'mpv', executable: exe, available: false });
  expect(await f.player.open('test', f.name)).toEqual({ ok: false, reason: 'missing-player' });
  expect(f.player.select(f.disk)).toEqual({ ok: false, reason: 'unsupported-player' });
  expect(f.player.getConfig().kind).toBe('mpv'); expect(f.openPath).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});
it('rejects absolute, traversing, removed, missing, partial and executable torrent files', async () => {
  const f = fixture();
  for (const name of [f.disk, '../' + f.name, 'folder/../' + f.name, 'app.exe', f.name + '\0']) expect((await f.player.open('test', name)).ok).toBe(false);
  f.d.progress = 0.5; f.setFiles([{ name: f.name, path: f.name, index: 7, length: 10, downloaded: 5, progress: 0.5 }]);
  // Even a preallocated full-size file is not complete until verified metadata agrees.
  expect(await f.player.open('test', f.name)).toEqual({ ok: false, reason: 'incomplete-file' });
  f.d.status = 'removed'; expect(await f.player.open('test', f.name)).toEqual({ ok: false, reason: 'missing-file' });
  f.d.status = 'paused'; f.d.progress = 1; fs.unlinkSync(f.disk);
  expect(await f.player.open('test', f.name)).toEqual({ ok: false, reason: 'missing-file' });
  f.setFiles([{ name: 'movie.mp4', path: 'app.exe', length: 10, downloaded: 10, progress: 1 }]);
  expect(await f.player.open('test', 'app.exe')).toEqual({ ok: false, reason: 'invalid-file' });
  expect(f.spawn).not.toHaveBeenCalled(); expect(f.openPath).not.toHaveBeenCalled(); expect(f.torrentStream).not.toHaveBeenCalled();
});
it('reports a missing system association, spawn error and immediate nonzero exit', async () => {
  const f = fixture(); f.openPath.mockResolvedValue('No association');
  expect(await f.player.open('test', f.name)).toEqual({ ok: false, reason: 'launch-failed' });
  f.player.select(f.exe('mpv'));
  for (const signal of ['error', 'exit']) {
    f.spawn.mockImplementationOnce(() => { queueMicrotask(() => signal === 'error' ? f.child.emit('error', Error('ENOENT')) : f.child.emit('exit', 1, null)); return f.child as unknown as ChildProcess; });
    expect(await f.player.open('test', f.name)).toEqual({ ok: false, reason: 'launch-failed' });
  }
});
it('accepts completed audio and sanitizes invalid position values', async () => {
  const f = fixture(), name = 'Музыка.flac'; fs.writeFileSync(path.join(f.root, name), '0123456789');
  f.setFiles([{ name, path: name, length: 10, downloaded: 10, progress: 1 }]);
  expect((await f.player.open('test', name)).ok).toBe(true);
  for (const value of [NaN, Infinity, -1, 604801, '--script=bad', null]) expect(externalStartTime(value)).toBe(0);
});
function streamFixture() {
  const f = fixture(); let allowed = true;
  const children: typeof f.child[] = [];
  const readMedia = vi.fn(async (_id, _path, _key, start: number, max: number) => ({ data: Buffer.from('0123456789').subarray(start, start + max).toString('base64') }));
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() }); children.push(child);
    queueMicrotask(() => child.emit('spawn')); return child as unknown as ChildProcess;
  });
  let prefs: ExternalPlayerPreferences = { kind: 'default', executable: null };
  const resolve = vi.fn(async (): Promise<LocalMedia> => ({ ok: false, reason: 'incomplete-file' }));
  const snapshot = vi.fn(async () => allowed ? { ok: true as const, key: 'engine-and-file', name: f.name, length: 10 } : { ok: false as const, reason: 'paused-file' as const });
  const player = new ExternalPlayer({ read: () => prefs, write: p => prefs = p, resolve, snapshot, readMedia, openPath: f.openPath, spawn });
  return { ...f, player, spawn, snapshot, resolve, children, readMedia, deny: () => allowed = false };
}
it('requires an explicit player for incomplete files and refuses a stopped source', async () => {
  const f = streamFixture();
  expect(await f.player.inspect('test', f.name)).toBe('stream');
  expect(await f.player.open('test', f.name)).toEqual({ ok: false, reason: 'stream-player' });
  f.deny(); f.player.select(f.exe('mpv'));
  expect(await f.player.open('test', f.name)).toEqual({ ok: false, reason: 'paused-file' });
  expect(f.spawn).not.toHaveBeenCalled(); expect(f.openPath).not.toHaveBeenCalled();
});
it('keeps a deleted complete file unavailable instead of replacing its error with a paused-stream message', async () => {
  const f = streamFixture(); f.resolve.mockResolvedValue({ ok: false, reason: 'missing-file' });
  expect(await f.player.inspect('test', f.name)).toBe('missing-file');
  expect(await f.player.open('test', f.name)).toEqual({ ok: false, reason: 'missing-file' });
  expect(f.snapshot).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});
it('releases an idle stream when its source is paused or removed, without waiting for another HTTP request', async () => {
  const f = streamFixture(); f.player.select(f.exe('mpv'));
  try {
    await f.player.open('test', f.name); expect(f.player.sessions()).toHaveLength(1); f.deny();
    const deadline = Date.now() + 4000;
    while (f.player.sessions().length && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    expect(f.player.sessions()).toEqual([]);
  } finally { f.player.close(); }
});
it.each(['mpv', 'vlc'] as const)('owns a %s stream until process exit or explicit stop, without pausing the torrent', async kind => {
  const f = streamFixture(); f.player.select(f.exe(kind));
  try {
    expect(await f.player.open('test', f.name, 17)).toEqual({ ok: true, kind, startTime: 17 });
    const args = f.spawn.mock.calls[0] as unknown as [string, string[]], url = args[1].at(-1)!;
    expect(args[1].slice(0, -1)).toEqual(kind === 'mpv' ? ['--start=17', '--'] : ['--no-one-instance', '--no-one-instance-when-started-from-file', '--start-time=17']);
    const response = await fetch(url, { headers: { Range: 'bytes=7-9' } }); expect(await response.text()).toBe('789');
    expect(f.player.sessions()).toHaveLength(1); expect(JSON.stringify(f.player.sessions())).not.toContain('http');
    f.player.stop(f.player.sessions()[0].id); expect(f.player.sessions()).toEqual([]); await expect(fetch(url)).rejects.toThrow();
    await f.player.open('test', f.name); f.children[1].emit('exit', 0, null); expect(f.player.sessions()).toEqual([]);
    expect(f.d.status).toBe('paused'); expect(f.torrentStream).not.toHaveBeenCalled();
  } finally { f.player.close(); }
});
it('bounds concurrent launches and revokes streams on app shutdown, including launches still binding', async () => {
  const f = streamFixture(); f.player.select(f.exe('mpv'));
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => f.player.open('test', f.name)));
    expect(results.filter(r => r.ok)).toHaveLength(4); expect(results).toContainEqual({ ok: false, reason: 'too-many-streams' });
    const urls = (f.spawn.mock.calls as unknown as Array<[string, string[]]>).map(call => call[1].at(-1)!);
    f.player.close(); expect(f.player.sessions()).toEqual([]);
    for (const url of urls) await expect(fetch(url)).rejects.toThrow();
    expect(await f.player.open('test', f.name)).toEqual({ ok: false, reason: 'unavailable' });
  } finally { f.player.close(); }
});
it('releases a stream on launch failure and source invalidation', async () => {
  const f = streamFixture(); f.player.select(f.exe('mpv'));
  f.spawn.mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit('error', Error('ENOENT'))); return child as unknown as ChildProcess;
  });
  try {
    expect(await f.player.open('test', f.name)).toEqual({ ok: false, reason: 'launch-failed' }); expect(f.player.sessions()).toEqual([]);
    await f.player.open('test', f.name); const url = (f.spawn.mock.calls[1] as unknown as [string, string[]])[1].at(-1)!;
    f.readMedia.mockImplementationOnce(async () => ({ reason: 'paused-file' } as never));
    await expect(fetch(url).then(r => r.text())).rejects.toThrow(); expect(f.player.sessions()).toEqual([]);
  } finally { f.player.close(); }
});
