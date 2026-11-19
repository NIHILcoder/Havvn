import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import type { ResourceMode } from '../../shared/resource-mode';
const f = vi.hoisted(() => ({ mode: 'normal' as ResourceMode, sample: vi.fn(), monitor: null as unknown as EventEmitter,
  handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events'); f.monitor = new EventEmitter();
  return { app: { isReady: () => true }, BrowserWindow: { getAllWindows: () => [] },
    powerMonitor: Object.assign(f.monitor, { isOnBatteryPower: f.sample }),
    ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => f.handlers.set(name, handler), removeHandler: (name: string) => f.handlers.delete(name) } };
});
vi.mock('../db/store', () => ({ getSettings: async () => ({ resourceMode: f.mode }), updateSettings: async ({ resourceMode }: { resourceMode: ResourceMode }) => { f.mode = resourceMode; } }));
vi.mock('../utils', () => ({ logger: { child: () => ({ warn: vi.fn() }) } }));
let runtime: typeof import('./resource-mode');
const mainFrame = {}, sender = { mainFrame }, owner = { webContents: sender, isDestroyed: () => false } as BrowserWindow;
const event = { sender, senderFrame: mainFrame }, getWindow = () => owner;
beforeEach(async () => { vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); f.mode = 'normal'; f.sample.mockReturnValue(false); runtime = await import('./resource-mode'); });
afterEach(() => { runtime.stopResourceMode(); vi.useRealTimers(); });
it('registers one monitor, accepts saved modes over IPC, and removes only its listeners on stop', async () => {
  await runtime.initResourceMode(getWindow); await runtime.initResourceMode(getWindow);
  expect(f.monitor.listenerCount('on-battery')).toBe(1); expect(f.monitor.listenerCount('on-ac')).toBe(1);
  await f.handlers.get('resources:set')!(event, 'auto'); f.monitor.emit('on-battery');
  expect(runtime.getResourceModeService().peek()).toMatchObject({ mode: 'auto', power: 'battery', economy: true });
  await f.handlers.get('resources:set')!(event, 'normal'); f.monitor.emit('on-battery');
  expect(runtime.getResourceModeService().peek().economy).toBe(false); expect(f.mode).toBe('normal');
  runtime.stopResourceMode(); expect(f.monitor.listenerCount('on-battery')).toBe(0); expect(f.handlers.has('resources:get')).toBe(false);
});
it('a failed platform query reports unknown power rather than claiming AC', async () => {
  f.mode = 'auto'; f.sample.mockImplementation(() => { throw Error('power unavailable'); });
  await runtime.initResourceMode(getWindow); expect(runtime.getResourceModeService().peek()).toMatchObject({ power: 'unknown', economy: false, source: 'unknown' });
});
it('rejects foreign windows and child frames before changing settings', async () => {
  await runtime.initResourceMode(getWindow);
  for (const untrusted of [{ sender: {}, senderFrame: mainFrame }, { sender, senderFrame: {} }, { sender, senderFrame: null }]) {
    expect(() => f.handlers.get('resources:set')!(untrusted, 'economy')).toThrow('Untrusted');
    expect(() => f.handlers.get('resources:get')!(untrusted)).toThrow('Untrusted');
  }
  expect(f.mode).toBe('normal');
});
