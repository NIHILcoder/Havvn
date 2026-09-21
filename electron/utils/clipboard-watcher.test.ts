import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), settings: vi.fn(), deliver: vi.fn() }));
vi.mock('electron', () => ({ clipboard: { readText: mocks.read } }));
vi.mock('../db/store', () => ({ getSettings: mocks.settings }));
vi.mock('./logger', () => ({ logger: { child: () => ({ info: vi.fn() }) } }));
import { initClipboardWatcher, stopClipboardWatcher } from './clipboard-watcher';
const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); mocks.settings.mockResolvedValue({ clipboardWatchEnabled: true }); });
afterEach(() => { stopClipboardWatcher(); vi.useRealTimers(); });
it('seeds asynchronously and delivers only a fresh magnet once', async () => {
  mocks.read.mockResolvedValueOnce('initial').mockResolvedValue(magnet);
  initClipboardWatcher({ deliver: mocks.deliver, hasWindow: () => true });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.deliver).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4000);
  expect(mocks.deliver).toHaveBeenCalledExactlyOnceWith(magnet);
});
it('does not deliver a pending read after stop and prevents overlapping reads', async () => {
  let resolve!: (text: string) => void;
  mocks.read.mockResolvedValueOnce('initial').mockImplementation(() => new Promise<string>(r => { resolve = r; }));
  initClipboardWatcher({ deliver: mocks.deliver, hasWindow: () => true });
  await vi.advanceTimersByTimeAsync(6000);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  stopClipboardWatcher();
  resolve(magnet);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.deliver).not.toHaveBeenCalled();
});
it('does not restart polling when stopped during the seed read', async () => {
  let resolve!: (text: string) => void;
  mocks.read.mockImplementation(() => new Promise<string>(r => { resolve = r; }));
  initClipboardWatcher({ deliver: mocks.deliver, hasWindow: () => true });
  await vi.advanceTimersByTimeAsync(0);
  stopClipboardWatcher(); resolve(magnet);
  await vi.advanceTimersByTimeAsync(6000);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(mocks.deliver).not.toHaveBeenCalled();
});
