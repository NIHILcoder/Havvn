import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exec: vi.fn(), platform: vi.fn(), interfaces: vi.fn() }));
vi.mock('child_process', () => ({ execFile: mocks.exec }));
vi.mock('util', () => ({ promisify: (fn: (...args: any[]) => void) => (...args: any[]) => new Promise((resolve, reject) => {
  fn(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }));
}) }));
vi.mock('os', () => ({ default: { platform: mocks.platform, networkInterfaces: mocks.interfaces } }));

const snapshot = {
  adapters: [{ name: 'Мой туннель', description: 'Wintun', index: 2, metric: 0, up: true, ipv4: ['172.19.0.1'] }],
  routes: [{ destination: '0.0.0.0/0', index: 2, metric: 5 }], proxyConfigured: true,
};
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.platform.mockReturnValue('win32'); mocks.interfaces.mockReturnValue({});
  mocks.exec.mockImplementation((_file, _args, _options, callback) => callback(null, JSON.stringify(snapshot), ''));
});
it('uses structured localized Windows data and bounded execution', async () => {
  const { readNetworkEvidence, getRoutedVpnIPv4 } = await import('./vpn-network');
  expect(await readNetworkEvidence()).toMatchObject({ routesKnown: true, proxyConfigured: true, adapters: [{ name: 'Мой туннель' }] });
  expect(await getRoutedVpnIPv4()).toEqual({ iface: 'Мой туннель', address: '172.19.0.1' });
  expect(mocks.exec).toHaveBeenCalledTimes(1);
  expect(mocks.exec.mock.calls[0][2]).toMatchObject({ timeout: 6000, windowsHide: true, maxBuffer: 2097152 });
});
it('coalesces simultaneous reads and refreshes expired snapshots', async () => {
  vi.useFakeTimers();
  try {
    const { readNetworkEvidence } = await import('./vpn-network');
    await Promise.all([readNetworkEvidence(), readNetworkEvidence()]);
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2001); await readNetworkEvidence();
    expect(mocks.exec).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it('command failures and invalid JSON fall back to unverified routes', async () => {
  mocks.exec.mockImplementation((_file, _args, _options, callback) => callback(new Error('Access denied')));
  const { readNetworkEvidence } = await import('./vpn-network');
  expect(await readNetworkEvidence()).toMatchObject({ routesKnown: false, ipv6Known: false, proxyConfigured: null });
});
it('rejects malformed snapshots and ignores invalid route metrics', async () => {
  const { parseWindowsEvidence } = await import('./vpn-network');
  expect(() => parseWindowsEvidence('{}')).toThrow();
  expect(parseWindowsEvidence(JSON.stringify({ ...snapshot, routes: [{ destination: '0.0.0.0/0', index: 2, metric: -1 }] })).routes).toEqual([]);
});
