import { beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), scan: vi.fn(async () => ({ status: 'complete' })), cancel: vi.fn(), close: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => state.handlers.set(name, handler) } }));
vi.mock('../services/storage-sources', () => ({ storageSources: vi.fn(() => ({})) }));
vi.mock('../services/storage-overview', () => ({ StorageOverviewController: class { scan = state.scan; cancel = state.cancel; close = state.close; } }));
import { registerStorageOverviewIpc } from './storage-overview';
const id = '11111111-1111-4111-8111-111111111111', frame = {}, sender = { mainFrame: frame, isDestroyed: () => false, send: vi.fn(), once: vi.fn() }, event = { sender, senderFrame: frame };
beforeEach(() => { vi.clearAllMocks(); state.handlers.clear(); registerStorageOverviewIpc({ webContents: sender } as unknown as BrowserWindow, {} as never); });
it('accepts only a request id from the trusted main frame', async () => {
  const scan = state.handlers.get('storage:scan')!;
  expect(() => scan({ sender: {}, senderFrame: frame }, id)).toThrow('Untrusted');
  expect(() => scan({ sender, senderFrame: {} }, id)).toThrow('Untrusted');
  for (const invalid of ['C:/secret', '../userData', '', null, {}]) expect(() => scan(event, invalid)).toThrow('Invalid');
  expect(state.scan).not.toHaveBeenCalled(); await scan(event, id); expect(state.scan.mock.calls[0][0]).toBe(id);
});
it('uses a separate cancel endpoint and releases the census on renderer destruction', () => {
  state.handlers.get('storage:cancel')!(event, id); expect(state.cancel).toHaveBeenCalledWith(id);
  expect([...state.handlers.keys()].sort()).toEqual(['storage:cancel', 'storage:scan']);
  sender.once.mock.calls[0][1](); expect(state.close).toHaveBeenCalledOnce();
});
