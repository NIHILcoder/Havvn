import { afterEach, expect, it, vi } from 'vitest';
import { RoomNetworkMonitor, roomNetworkFingerprint } from './room-network-monitor';

afterEach(() => vi.useRealTimers());

it('ignores interface enumeration order, loopback and our own LAN adapter', () => {
  const row = { address: '10.0.0.2', family: 'IPv4', netmask: '255.255.255.0', internal: false, mac: '00' } as const;
  expect(roomNetworkFingerprint({ Ethernet: [row], 'Havvn LAN-test': [row], Loopback: [{ ...row, internal: true }] }))
    .toBe(roomNetworkFingerprint({ Ethernet: [row] }));
  expect(roomNetworkFingerprint({ Ethernet: [row] })).not.toBe(roomNetworkFingerprint({ TUN: [row] }));
});

it('debounces interface changes, serializes recovery and cancels queued work on shutdown', async () => {
  vi.useFakeTimers(); let current = 'ethernet';
  let finish!: () => void;
  const changed = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const monitor = new RoomNetworkMonitor({ fingerprint: () => current, changed, suspend: vi.fn(), resume: vi.fn(), error: vi.fn() });
  current = 'tun'; monitor.poll(); expect(changed).not.toHaveBeenCalled();
  current = 'ethernet'; monitor.poll(); monitor.poll(); expect(changed).not.toHaveBeenCalled();
  current = 'tun'; monitor.poll(); monitor.poll(); await Promise.resolve(); expect(changed).toHaveBeenCalledOnce();
  current = 'wifi'; monitor.poll(); monitor.poll(); await Promise.resolve(); expect(changed).toHaveBeenCalledOnce();
  monitor.dispose(); finish(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(changed).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it('gates sleep synchronously, suppresses polling while asleep and resumes once', async () => {
  vi.useFakeTimers(); let current = 'ethernet'; const suspend = vi.fn(async () => {}), resume = vi.fn(async () => {}), changed = vi.fn(async () => {});
  const monitor = new RoomNetworkMonitor({ fingerprint: () => current, suspend, resume, changed, error: vi.fn() });
  monitor.suspend(); monitor.suspend(); expect(suspend).toHaveBeenCalledOnce();
  current = 'tun'; await vi.advanceTimersByTimeAsync(6000); expect(changed).not.toHaveBeenCalled();
  monitor.resume(); monitor.resume(); await vi.advanceTimersByTimeAsync(6000);
  expect(resume).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled(); monitor.dispose();
});

it('reports failed recovery and continues polling', async () => {
  vi.useFakeTimers(); let current = 'one'; const error = vi.fn();
  const changed = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const monitor = new RoomNetworkMonitor({ fingerprint: () => current, changed, suspend: vi.fn(), resume: vi.fn(), error });
  current = 'two'; await vi.advanceTimersByTimeAsync(6000); expect(error).toHaveBeenCalledOnce();
  current = 'three'; await vi.advanceTimersByTimeAsync(6000); expect(changed).toHaveBeenCalledTimes(2); monitor.dispose();
});

it('discards an interface reconnect queued before sleep and keeps the fresh wake fingerprint', async () => {
  vi.useFakeTimers(); let current = 'old'; const changed = vi.fn(async () => {}), suspend = vi.fn(async () => {}), resume = vi.fn(async () => {});
  const monitor = new RoomNetworkMonitor({ fingerprint: () => current, changed, suspend, resume, error: vi.fn() });
  current = 'new'; monitor.poll(); monitor.poll(); monitor.suspend();
  await vi.advanceTimersByTimeAsync(6000); expect(changed).not.toHaveBeenCalled();
  monitor.resume(); await vi.advanceTimersByTimeAsync(6000);
  expect(resume).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled(); monitor.dispose();
});
