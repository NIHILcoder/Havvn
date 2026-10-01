import { beforeEach, expect, it, vi } from 'vitest';
import type { NetworkEvidence } from '../../shared/vpn-status';

const mocks = vi.hoisted(() => ({ read: vi.fn(), direct: vi.fn(), system: vi.fn(), geo: vi.fn() }));
vi.mock('./vpn-network', () => ({ readNetworkEvidence: mocks.read, getRoutedVpnIPv4: vi.fn() }));
vi.mock('./ip-probe', () => ({ getDirectPublicIp: mocks.direct, getSystemPublicIp: mocks.system, fetchIpGeo: mocks.geo }));
import { detectVPN, getIpInfo } from './vpn-detector';

let network: NetworkEvidence;
beforeEach(() => {
  vi.clearAllMocks();
  network = {
    adapters: [{ name: 'Ethernet', description: 'Realtek', index: 1, metric: 0, up: true, ipv4: ['192.168.1.10'] }],
    routes: [{ destination: '0.0.0.0/0', index: 1, metric: 0 }], routesKnown: true, ipv6Known: true, proxyConfigured: true,
  };
  mocks.read.mockImplementation(async () => network);
  mocks.direct.mockResolvedValue('203.0.113.1');
  mocks.system.mockResolvedValue('198.51.100.1');
  mocks.geo.mockImplementation(async (ip: string) => ip === '203.0.113.1' ? { country: 'DE', org: 'AS1 Cloud Hosting VPN Server' } : { country: 'EE' });
});

it('does not equate Germany hosting with VPN, or proxy Estonia with a home country', async () => {
  expect(await getIpInfo()).toMatchObject({ state: 'not-detected', vpnActive: false, ip: '203.0.113.1', country: 'DE', proxyIp: '198.51.100.1', proxyCountry: 'EE' });
});
it('uses the same tunnel verdict in the dashboard and guard', async () => {
  network.adapters.push({ name: 'NekoTun', description: 'sing-box', index: 2, metric: 0, up: true, ipv4: ['172.19.0.1'] });
  network.routes[0].index = 2;
  expect((await detectVPN()).state).toBe('routed');
  expect(await getIpInfo()).toMatchObject({ state: 'routed', vpnActive: true });
});
it('performs no remote request for local guard detection', async () => {
  await detectVPN();
  expect(mocks.direct).not.toHaveBeenCalled(); expect(mocks.geo).not.toHaveBeenCalled(); expect(mocks.system).not.toHaveBeenCalled();
});
it('keeps local VPN evidence even if every IP service is unavailable', async () => {
  network.adapters[0].name = 'NekoTun'; network.adapters[0].description = 'sing-box';
  mocks.direct.mockResolvedValue(undefined); mocks.system.mockResolvedValue(undefined); mocks.geo.mockResolvedValue({});
  const info = await getIpInfo();
  expect(info).toMatchObject({ state: 'routed', vpnActive: true, ip: undefined });
  expect(info.country).toBeUndefined();
});
it('does not label OS command failure as confirmed VPN absence', async () => {
  network.routesKnown = false;
  expect(await getIpInfo()).toMatchObject({ state: 'unknown', confidence: 'unknown', vpnActive: false });
});
