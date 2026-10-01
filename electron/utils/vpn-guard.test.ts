import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VpnState } from '../../shared/vpn-status';

const mocks = vi.hoisted(() => ({ config: vi.fn(), downloads: vi.fn(), pause: vi.fn(), status: vi.fn(), restart: vi.fn(),
  detect: vi.fn(), address: vi.fn(), rooms: vi.fn(), suspend: vi.fn(), resume: vi.fn(), notify: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('./vpn-detector', () => ({ detectVPN: mocks.detect, getVpnInterfaceIPv4: mocks.address }));
vi.mock('./logger', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock('./os-notify', () => ({ showOsNotification: mocks.notify }));
vi.mock('../db/store', () => ({ getPrivacyConfig: mocks.config, getEngineChoice: () => 'native', getPersistedRooms: mocks.rooms }));
vi.mock('../torrent', () => ({ getTorrentManager: () => ({ getDownloads: mocks.downloads, pauseAllActive: mocks.pause, getVpnBindStatus: mocks.status, restartEngine: mocks.restart }) }));
vi.mock('../sharing/room-manager', () => ({ getRoomManager: () => ({ suspendNetworking: mocks.suspend, resumeNetworking: mocks.resume }) }));
vi.mock('../i18n', () => ({ t: (key: string) => key }));

let guard: typeof import('./vpn-guard');
const result = (state: VpnState) => ({ state, isVPNActive: state === 'routed', details: {}, confidence: 'medium' });
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  mocks.config.mockResolvedValue({ vpnKillSwitch: true, vpnBindEngine: false });
  mocks.downloads.mockResolvedValue([]); mocks.pause.mockResolvedValue(1);
  mocks.status.mockReturnValue(null); mocks.address.mockResolvedValue(null); mocks.restart.mockResolvedValue(undefined);
  mocks.detect.mockResolvedValue(result('not-detected')); mocks.rooms.mockReturnValue([]);
  mocks.suspend.mockResolvedValue(undefined); mocks.resume.mockResolvedValue(undefined);
  guard = await import('./vpn-guard');
});
afterEach(() => { guard.stopVpnGuard(); vi.useRealTimers(); });

it('pauses a torrent started after an earlier negative check, and repeated manual resumes', async () => {
  await guard.restartGuardFromConfig(); await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.pause).not.toHaveBeenCalled();
  mocks.downloads.mockResolvedValue([{ status: 'downloading' }]);
  await vi.advanceTimersByTimeAsync(5000); expect(mocks.pause).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000); expect(mocks.pause).toHaveBeenCalledTimes(2);
});
it.each(['unknown', 'detected'] as const)('fails closed for %s routes with active torrents', async state => {
  mocks.detect.mockResolvedValue(result(state)); mocks.downloads.mockResolvedValue([{ status: 'seeding' }]);
  await guard.restartGuardFromConfig(); await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.pause).toHaveBeenCalledOnce(); expect(mocks.suspend).toHaveBeenCalledOnce();
});
it('restores rooms only on a routed tunnel; a partial route cannot restore them', async () => {
  mocks.rooms.mockReturnValue([{}]);
  await guard.restartGuardFromConfig(); await vi.advanceTimersByTimeAsync(2000);
  mocks.detect.mockResolvedValue(result('detected')); await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.resume).not.toHaveBeenCalled();
  mocks.detect.mockResolvedValue(result('routed')); await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.resume).toHaveBeenCalledOnce();
});
it('ignores stale detection when the guard is disabled and re-enabled during a check', async () => {
  let finish!: (value: ReturnType<typeof result>) => void;
  mocks.detect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mocks.downloads.mockResolvedValue([{ status: 'downloading' }]);
  await guard.restartGuardFromConfig(); await vi.advanceTimersByTimeAsync(2000);
  mocks.config.mockResolvedValue({ vpnKillSwitch: false }); await guard.restartGuardFromConfig();
  mocks.config.mockResolvedValue({ vpnKillSwitch: true }); await guard.restartGuardFromConfig();
  finish(result('not-detected')); await vi.advanceTimersByTimeAsync(0);
  expect(mocks.pause).not.toHaveBeenCalled();
});
it('does not suspend rooms after disable while pauseAllActive is pending', async () => {
  let finish!: (value: number) => void;
  mocks.pause.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mocks.downloads.mockResolvedValue([{ status: 'queued' }]);
  await guard.restartGuardFromConfig(); await vi.advanceTimersByTimeAsync(2000);
  mocks.config.mockResolvedValue({ vpnKillSwitch: false }); await guard.restartGuardFromConfig();
  finish(1); await vi.advanceTimersByTimeAsync(0);
  expect(mocks.suspend).not.toHaveBeenCalled();
});
it('cancels the initial timer when stopped', async () => {
  await guard.restartGuardFromConfig(); guard.stopVpnGuard(); await vi.advanceTimersByTimeAsync(10000);
  expect(mocks.detect).not.toHaveBeenCalled();
});
it('debounces a new routed bind address and restarts once', async () => {
  mocks.config.mockResolvedValue({ vpnKillSwitch: false, vpnBindEngine: true });
  mocks.status.mockReturnValue({ enabled: true, boundIp: '10.8.0.1' });
  mocks.address.mockResolvedValue({ iface: 'NekoTun', address: '172.19.0.1' });
  await guard.restartGuardFromConfig(); await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.restart).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000); expect(mocks.restart).toHaveBeenCalledOnce();
});

it('restarts a bound engine into fallback when an adapter loses its route', async () => {
  mocks.config.mockResolvedValue({ vpnKillSwitch: false, vpnBindEngine: true });
  mocks.status.mockReturnValue({ enabled: true, boundIp: '172.19.0.1' });
  mocks.address.mockResolvedValue(null);
  await guard.restartGuardFromConfig(); await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.restart).toHaveBeenCalledOnce();
});

it('preserves an enabled guard on a settings read failure', async () => {
  await guard.restartGuardFromConfig();
  mocks.config.mockRejectedValue(new Error('Store unavailable'));
  await guard.restartGuardFromConfig();
  mocks.downloads.mockResolvedValue([{ status: 'downloading' }]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.pause).toHaveBeenCalledOnce();
});
