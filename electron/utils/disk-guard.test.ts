import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ enabled: true, free: vi.fn(), setBlock: vi.fn(), pause: vi.fn(), active: true }));
vi.mock('electron', () => ({}));
vi.mock('../db/store', () => ({ getSettings: async () => ({ diskGuardEnabled: f.enabled, diskGuardMinFreeMB: 1, defaultDownloadDir: 'D:/test' }) }));
vi.mock('../torrent', () => ({ getTorrentManager: () => ({ setTransferBlock: f.setBlock, pauseAllActive: f.pause,
  getDownloads: async () => [{ status: f.active ? 'downloading' : 'paused', savePath: 'D:/test' }] }) }));
vi.mock('./index', () => ({ checkDiskSpace: f.free, formatBytes: String, logger: { child: () => ({ info() {}, warn() {}, error() {} }) } }));
vi.mock('./os-notify', () => ({ showOsNotification() {} }));
vi.mock('../i18n', () => ({ t: (key: string) => key }));
vi.mock('../services/app-events', () => ({ getAppEvents: () => ({ isActive: () => false }), recordAppEvent() {}, resolveAppEvent() {} }));
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks(); f.enabled = true; f.active = true; f.free.mockResolvedValue(0); f.pause.mockImplementation(async () => { f.active = false; return 1; }); });
afterEach(() => vi.useRealTimers());
it('blocks before pausing and clears only the disk reason on recovery', async () => {
  const guard = await import('./disk-guard'); await guard.restartGuardFromConfig(); await vi.advanceTimersByTimeAsync(3000);
  expect(f.setBlock).toHaveBeenLastCalledWith('disk', true);
  expect(f.setBlock.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.pause.mock.invocationCallOrder[0]);
  f.free.mockResolvedValue(2 * 1024 * 1024); await vi.advanceTimersByTimeAsync(30000);
  expect(f.setBlock).toHaveBeenLastCalledWith('disk', false); expect(f.pause).toHaveBeenCalledTimes(1); guard.stopDiskGuard();
});
it('an obsolete disk probe cannot re-block transfers after the guard is disabled', async () => {
  let finish!: (value: number) => void; f.free.mockImplementationOnce(() => new Promise<number>(r => { finish = r; }));
  const guard = await import('./disk-guard'); await guard.restartGuardFromConfig(); await vi.advanceTimersByTimeAsync(3000);
  f.enabled = false; await guard.restartGuardFromConfig(); finish(0); await vi.advanceTimersByTimeAsync(1);
  expect(f.setBlock).toHaveBeenLastCalledWith('disk', false); expect(f.pause).not.toHaveBeenCalled(); guard.stopDiskGuard();
});
