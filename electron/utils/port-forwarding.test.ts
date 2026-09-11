import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upnp: { findGateway: vi.fn(), portMapping: vi.fn(), portUnmapping: vi.fn(), externalIp: vi.fn(), close: vi.fn() },
  pmp: { portMapping: vi.fn(), portUnmapping: vi.fn(), externalIp: vi.fn(), close: vi.fn(), on: vi.fn() },
}));
vi.mock('nat-upnp', () => ({ createClient: () => mocks.upnp }));
vi.mock('nat-pmp', () => ({ connect: () => mocks.pmp }));
vi.mock('./logger', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) } }));
vi.mock('../db/store', () => ({ getSettings: async () => ({ portForwarding: true }) }));
import { getPortForwarding, stopPortForwarding } from './port-forwarding';

describe('port forwarding callback adapters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.upnp.findGateway.mockImplementation(cb => cb(null, {}));
    for (const client of [mocks.upnp, mocks.pmp]) {
      client.portMapping.mockImplementation((_opts, cb) => cb(null));
      client.portUnmapping.mockImplementation((_opts, cb) => cb(null));
    }
    mocks.upnp.externalIp.mockImplementation(cb => cb(null, '203.0.113.1'));
    mocks.pmp.externalIp.mockImplementation(cb => cb(null, { ip: [203, 0, 113, 2] }));
  });
  afterEach(async () => { await stopPortForwarding(); vi.useRealTimers(); });

  it('maps and removes using the UPnP callback API', async () => {
    await getPortForwarding().start(51413);
    expect(getPortForwarding().getStatus()).toMatchObject({ state: 'mapped', method: 'upnp' });
    await stopPortForwarding();
    expect(mocks.upnp.portUnmapping).toHaveBeenCalled();
    expect(mocks.upnp.close).toHaveBeenCalled();
  });
  it('falls back to NAT-PMP when UPnP discovery fails', async () => {
    mocks.upnp.findGateway.mockImplementation(cb => cb(new Error('No gateway')));
    await getPortForwarding().start(51413);
    expect(getPortForwarding().getStatus()).toMatchObject({ state: 'mapped', method: 'nat-pmp', externalIp: '203.0.113.2' });
  });
  it('finishes when neither protocol responds', async () => {
    mocks.upnp.findGateway.mockImplementation(() => {});
    mocks.pmp.portMapping.mockImplementation(() => {});
    const pending = getPortForwarding().start(51413);
    await vi.advanceTimersByTimeAsync(8000);
    await pending;
    expect(getPortForwarding().getStatus().state).toBe('unsupported');
  });
});
