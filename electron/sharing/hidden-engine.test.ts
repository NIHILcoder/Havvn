/* eslint-disable @typescript-eslint/no-explicit-any -- Electron window and IPC doubles. */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const env = vi.hoisted(() => ({ ipc: null as any, windows: [] as any[], load: null as null | (() => Promise<void>) }));
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: any) => env.ipc.on(channel, listener),
    removeListener: (channel: string, listener: any) => env.ipc.removeListener(channel, listener),
  },
  BrowserWindow: class extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, send: vi.fn() });
    constructor() { super(); env.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    loadURL() { return env.load?.() ?? Promise.resolve(); }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  },
}));
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn() }) } }));
vi.mock('../db/store', () => ({ getSettings: async () => ({}) }));
vi.mock('../torrent', () => ({ getTorrentManager: () => ({
  getCastFileInfo: async () => ({ kind: 'video', diskPath: '/film.mp4' }), ffmpegBinary: '/ffmpeg',
}) }));
vi.mock('./ice-servers', () => ({ customTurnToIce: () => [], resolveTrackers: () => [] }));
import { HiddenEngine } from './hidden-engine';
import { ShareManager } from './share-manager';
import { RemoteCastManager } from './remote-cast-manager';
let engine: HiddenEngine;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const event = (win: any) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
const ready = async (win: any) => { env.ipc.emit('share-ready', event(win)); await flush(); };
function respond(win: any, type: string, count: number, data: any = { ok: true }, ok = true, channel = 'share') {
  const command = win.webContents.send.mock.calls.findLast(([, msg]: any[]) => msg.type === type)[1];
  env.ipc.emit(channel + '-res', event(win), { reqId: command.reqId, ok, data, error: 'failed', activeCount: count });
}
beforeEach(() => { vi.useFakeTimers(); env.ipc = new EventEmitter(); env.windows = []; env.load = null; engine = new HiddenEngine('share', '/preload'); });
afterEach(() => { engine.destroy(); vi.useRealTimers(); });

describe('hidden sharing engine lifecycle', () => {
  it('coalesces boots and waits for both commands before closing an idle renderer', async () => {
    const first = engine.call('one'), second = engine.call('two'); await flush();
    expect(env.windows).toHaveLength(1); const win = env.windows[0]; await ready(win);
    respond(win, 'one', 0); await first; vi.advanceTimersByTime(7000); expect(win.destroyed).toBe(false);
    respond(win, 'two', 0); await second; vi.advanceTimersByTime(5000); expect(win.destroyed).toBe(true);
    const again = engine.call('again'); await flush(); expect(env.windows).toHaveLength(2);
    await ready(env.windows[1]); respond(env.windows[1], 'again', 0); await again;
  });
  it('keeps live shares even with no peers and retires only after the last stop', async () => {
    const start = engine.call('start'); const win = env.windows[0]; await ready(win); respond(win, 'start', 2); await start;
    vi.advanceTimersByTime(60000); expect(win.destroyed).toBe(false);
    const stop = engine.call('stop'); await flush(); respond(win, 'stop', 1); await stop;
    vi.advanceTimersByTime(10000); expect(win.destroyed).toBe(false);
    const last = engine.call('last'); await flush(); respond(win, 'last', 0); await last;
    vi.advanceTimersByTime(5000); expect(win.destroyed).toBe(true);
  });
  it('cancels retirement for a new command and clears response timers', async () => {
    const first = engine.call('first'); const win = env.windows[0]; await ready(win); respond(win, 'first', 0); await first;
    expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(4000);
    const hashing = engine.call('hash', {}, 0); await flush(); vi.advanceTimersByTime(30000); expect(win.destroyed).toBe(false);
    respond(win, 'hash', 1); await hashing; expect(vi.getTimerCount()).toBe(0);
  });
  it('does not keep an empty renderer alive through repeated UI polling', async () => {
    const first = engine.call('stop'); const win = env.windows[0]; await ready(win); respond(win, 'stop', 0); await first;
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(1000);
      const query = engine.call('list'); await flush(); respond(win, 'list', 0, []); await query;
    }
    vi.advanceTimersByTime(1000); expect(win.destroyed).toBe(true);
  });
  it('ignores foreign, subframe, and old-window replies', async () => {
    const pending = engine.call('start'); const win = env.windows[0];
    env.ipc.emit('share-ready', { sender: {}, senderFrame: {} }); await flush(); expect(win.webContents.send).not.toHaveBeenCalled();
    await ready(win);
    env.ipc.emit('share-res', { sender: win.webContents, senderFrame: {} }, { reqId: 1, ok: true, activeCount: 0 });
    expect((engine as any).pending.size).toBe(1);
    win.webContents.emit('render-process-gone'); await expect(pending).rejects.toThrow('crashed');
    const second = engine.call('new'); const newWin = env.windows[1]; await ready(newWin);
    env.ipc.emit('share-count', event(win), 2); respond(newWin, 'new', 0); await second;
    vi.advanceTimersByTime(5000); expect(newWin.destroyed).toBe(true);
  });
  it('rejects boot waiters on shutdown and on boot timeout', async () => {
    const boot = engine.call('start'); engine.destroy(); await expect(boot).rejects.toThrow('Shutting down');
    const timeout = engine.call('start'); const result = expect(timeout).rejects.toThrow('20 seconds');
    await vi.advanceTimersByTimeAsync(20000); await result; expect(env.windows[1].destroyed).toBe(true);
  });
  it('closes a failed boot and a failed empty command', async () => {
    env.load = () => Promise.reject(new Error('load failed'));
    await expect(engine.call('start')).rejects.toThrow('load failed'); expect(env.windows[0].destroyed).toBe(true);
    env.load = null;
    const pending = engine.call('start'); await ready(env.windows[1]); respond(env.windows[1], 'start', 0, null, false);
    await expect(pending).rejects.toThrow('failed'); vi.advanceTimersByTime(5000); expect(env.windows[1].destroyed).toBe(true);
  });
  it('handles request timeout and unsolicited last-share errors without retaining timers', async () => {
    const pending = engine.call('start', {}, 100); const win = env.windows[0]; await ready(win);
    const result = expect(pending).rejects.toThrow('did not respond'); await vi.advanceTimersByTimeAsync(100); await result;
    vi.advanceTimersByTime(5000); expect(win.destroyed).toBe(true);
    const newCall = engine.call('start'); const next = env.windows[1]; await ready(next); respond(next, 'start', 1); await newCall;
    env.ipc.emit('share-count', event(next), 0); vi.advanceTimersByTime(5000); expect(next.destroyed).toBe(true);
    engine.destroy(); expect(env.ipc.eventNames()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('lazy managers', () => {
  it('does not create a share window just to list, query, or stop empty shares', async () => {
    const manager = new ShareManager();
    expect(await manager.list()).toEqual([]); expect(await manager.get('download')).toBeNull();
    expect(await manager.stop('download')).toEqual({ ok: true }); expect(env.windows).toHaveLength(0); manager.destroy();
  });
  it('does not create a remote-cast window for an empty stop, and republishes after idle retirement', async () => {
    const manager = new RemoteCastManager(); await manager.stop('absent'); expect(env.windows).toHaveLength(0);
    const start = manager.start('download', 0); await flush(); const win = env.windows[0];
    env.ipc.emit('rcast-ready', event(win)); await flush(); respond(win, 'start', 1, { ok: true }, true, 'rcast');
    const link = await start;
    const stop = manager.stop(link.sessionId); await flush(); respond(win, 'stop', 0, { ok: true }, true, 'rcast'); await stop;
    vi.advanceTimersByTime(5000); expect(win.destroyed).toBe(true);
    const next = manager.start('download', 0); await flush(); const newWin = env.windows[1];
    env.ipc.emit('rcast-ready', event(newWin)); await flush(); respond(newWin, 'start', 1, {}, true, 'rcast');
    expect((await next).sessionId).not.toBe(link.sessionId); manager.destroy();
  });
  it('coalesces remote starts and does not resurrect a host after shutdown during metadata lookup', async () => {
    const manager = new RemoteCastManager();
    const first = manager.start('download', 0), second = manager.start('download', 0);
    expect(first).toBe(second); manager.destroy();
    await expect(first).rejects.toThrow('canceled'); expect(env.windows).toHaveLength(0);
    const start = manager.start('download', 0); await flush(); const win = env.windows[0];
    env.ipc.emit('rcast-ready', event(win)); await flush(); respond(win, 'start', 1, {}, true, 'rcast'); await start;
    expect(win.webContents.send).toHaveBeenCalledOnce(); manager.destroy();
  });
});
