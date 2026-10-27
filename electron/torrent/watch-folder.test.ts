import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const env = vi.hoisted(() => ({ files: new Map<string, string[]>(), watchers: [] as any[], add: vi.fn(), unlink: vi.fn() }));
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('./index', () => ({ getTorrentManager: () => ({ addDownload: env.add }) }));
vi.mock('fs', () => ({ default: {
  existsSync: () => true, mkdirSync: vi.fn(), readdirSync: (p: string) => env.files.get(p) ?? [], unlinkSync: env.unlink,
  watch: (_p: string, _opts: unknown, callback: (event: string, name: string) => void) => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), callback }); env.watchers.push(watcher); return watcher;
  },
} }));
import { WatchFolderService } from './watch-folder';
let service: WatchFolderService;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); env.files.clear(); env.watchers.length = 0; env.add.mockReset().mockResolvedValue({ id: 'added' }); env.unlink.mockClear(); service = new WatchFolderService(); });
afterEach(() => { service.stop(); vi.clearAllTimers(); vi.useRealTimers(); });
it('does not add a delayed watch event after monitoring has been disabled', async () => {
  service.start('A', false); env.watchers[0].callback('rename', 'one.torrent'); service.stop();
  await vi.advanceTimersByTimeAsync(600); expect(env.add).not.toHaveBeenCalled();
});
it('does not continue an old directory scan using the newly selected folder', async () => {
  env.files.set('A', ['one.torrent', 'two.torrent']); let finish!: () => void;
  env.add.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  service.start('A', false); service.start('B', false); finish(); await flush();
  expect(env.add.mock.calls.map(c => c[0].sourceUri)).toEqual([path.join('A', 'one.torrent')]);
});
it('does not delete an old source using a later session delete-after-add setting', async () => {
  env.files.set('A', ['one.torrent']); let finish!: () => void;
  env.add.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  service.start('A', false); service.start('B', true); finish(); await flush(); expect(env.unlink).not.toHaveBeenCalled();
});
it('ignores an error from an old watcher instead of stopping the current one', () => {
  service.start('A', false); const old = env.watchers[0]; service.start('B', false); old.emit('error', Error('late'));
  expect(service.isActive).toBe(true); expect(service.currentPath).toBe('B');
});
it('recognizes .TORRENT files during initial scan and later filesystem events', async () => {
  env.files.set('A', ['first.TORRENT']); service.start('A', false); await flush();
  env.watchers[0].callback('rename', 'second.Torrent'); await vi.advanceTimersByTimeAsync(600);
  expect(env.add.mock.calls.map(c => c[0].sourceUri)).toEqual([path.join('A', 'first.TORRENT'), path.join('A', 'second.Torrent')]);
});
it('deduplicates a pending addition across a restart of the same folder', async () => {
  env.files.set('A', ['one.torrent']); let finish!: () => void;
  env.add.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  service.start('A', false); service.start('A', false); finish(); await flush(); expect(env.add).toHaveBeenCalledOnce();
});
