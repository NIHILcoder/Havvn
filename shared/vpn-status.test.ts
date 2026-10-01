import { describe, expect, it } from 'vitest';
import { assessVpn, privacyPosture, shouldTripVpnGuard, type NetworkEvidence } from './vpn-status';
import { sessionSubnet } from './lan-ip';
import { numToIp } from './ip-range';

function network(): NetworkEvidence {
  return {
    adapters: [
      { name: 'Ethernet', description: 'Realtek', index: 1, up: true, metric: 25, ipv4: ['192.168.1.10'] },
      { name: 'NekoTun', description: 'sing-box Tunnel', index: 2, up: true, metric: 1, ipv4: ['172.19.0.1'] },
    ],
    routes: [{ destination: '0.0.0.0/0', index: 1, metric: 0 }, { destination: '0.0.0.0/0', index: 2, metric: 0 }],
    routesKnown: true, ipv6Known: true, proxyConfigured: true,
  };
}

describe('local tunnel routing assessment', () => {
  it('recognizes NekoTun with system proxy plus TUN, without IP geography', () => {
    expect(assessVpn(network())).toMatchObject({ state: 'routed', routedInterface: 'NekoTun', bind: { iface: 'NekoTun', address: '172.19.0.1' } });
  });
  it('recognizes a renamed Wintun adapter by its description', () => {
    const n = network(); n.adapters[1].name = 'Эстония'; n.adapters[1].description = 'Wintun Userspace Tunnel';
    expect(assessVpn(n).state).toBe('routed');
  });
  it('recognizes connected Windows built-in VPN protocols without counting disconnected miniports', () => {
    const n = network(); n.adapters[1].name = 'Work'; n.adapters[1].description = 'WAN Miniport (IKEv2)';
    expect(assessVpn(n).state).toBe('routed');
    n.adapters[1].up = false;
    expect(assessVpn(n).state).toBe('not-detected');
  });
  it('does not call an installed adapter a routed VPN', () => {
    const n = network(); n.routes = n.routes.filter(r => r.index === 1);
    expect(assessVpn(n)).toMatchObject({ state: 'detected', bind: null });
  });
  it('does not count proxy-only mode or a private router address as VPN', () => {
    const n = network(); n.adapters.pop();
    expect(assessVpn(n)).toMatchObject({ state: 'not-detected', bind: null });
  });
  it('does not count a disconnected VPN adapter', () => {
    const n = network(); n.adapters[1].up = false;
    expect(assessVpn(n).state).toBe('not-detected');
  });
  it('requires routes in both IPv4 halves, using longest prefixes before metrics', () => {
    const n = network(); n.adapters[1].metric = 100;
    n.routes = [{ destination: '0.0.0.0/0', index: 1, metric: 0 }, { destination: '0.0.0.0/1', index: 2, metric: 100 }];
    expect(assessVpn(n).state).toBe('detected');
    n.routes.push({ destination: '128.0.0.0/1', index: 2, metric: 100 });
    expect(assessVpn(n).state).toBe('routed');
  });
  it('selects the routed tunnel rather than the first matching adapter', () => {
    const n = network(); n.adapters.unshift({ ...n.adapters[1], name: 'wg0', index: 3, ipv4: ['10.8.0.2'] });
    expect(assessVpn(n).bind?.iface).toBe('NekoTun');
  });
  it('keeps equal-cost routes to different interfaces unconfirmed', () => {
    const n = network(); n.adapters[1].metric = 25;
    expect(assessVpn(n)).toMatchObject({ state: 'detected', bind: null });
  });
  it('detects a physical IPv6 bypass while still allowing a v4-only engine bind', () => {
    const n = network(); n.routes.push({ destination: '::/0', index: 1, metric: 0 });
    expect(assessVpn(n)).toMatchObject({ state: 'detected', ipv6Bypass: true, bind: { iface: 'NekoTun' } });
  });
  it('accepts IPv6 through a tunnel and specific physical overrides are a bypass', () => {
    const n = network(); n.routes.push({ destination: '::/0', index: 2, metric: 0 });
    expect(assessVpn(n).state).toBe('routed');
    n.routes.push({ destination: '2606:4700:4700::1111/128', index: 1, metric: 500 });
    expect(assessVpn(n).ipv6Bypass).toBe(true);
  });
  it('fails to unknown when OS route checks fail, not to a high-confidence absence', () => {
    const n = network(); n.routesKnown = false; n.adapters.pop();
    expect(assessVpn(n)).toMatchObject({ state: 'unknown', confidence: 'unknown' });
  });
  it('does not confirm protection when IPv6 inspection failed', () => {
    const n = network(); n.ipv6Known = false;
    expect(assessVpn(n).state).toBe('detected');
  });
  it('excludes Havvn LAN adapters by name and active subnet even if renamed', () => {
    const n = network(); n.adapters[1].name = 'Havvn LAN-1';
    expect(assessVpn(n).bind).toBeNull();
    n.adapters[1].name = 'wg-renamed';
    const subnet = sessionSubnet('test-session'); n.adapters[1].ipv4 = [numToIp(subnet.base + 258)];
    expect(assessVpn(n, [{ sessionId: 'test-session', subnet }]).bind).toBeNull();
  });
  it('ignores malformed prefixes and invalid adapter addresses', () => {
    const n = network(); n.routes[1].destination = '0.0.0.0/33';
    expect(assessVpn(n).bind).toBeNull();
    n.routes[1].destination = '0.0.0.0/0'; n.adapters[1].ipv4 = ['not-an-ip'];
    expect(assessVpn(n).bind).toBeNull();
  });
});

it('uses evidence state for posture; legacy bool, unknown and partial routes cannot turn green', () => {
  expect(privacyPosture(undefined, false, true)).toBe('unknown');
  expect(privacyPosture('unknown', false, true)).toBe('unknown');
  expect(privacyPosture('detected', false, true)).toBe('caution');
  expect(privacyPosture('routed', false, true)).toBe('protected');
  expect(privacyPosture('routed', true, true)).toBe('checking');
});

it('trips on unverified routes with new activity, including unknown and partial states', () => {
  for (const state of ['unknown', 'not-detected', 'detected'] as const) expect(shouldTripVpnGuard(state, true)).toBe(true);
  expect(shouldTripVpnGuard('routed', true)).toBe(false);
  expect(shouldTripVpnGuard('not-detected', false)).toBe(false);
});
