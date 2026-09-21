import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upnp: { findGateway: vi.fn(), portMapping: vi.fn(), portUnmapping: vi.fn(), externalIp: vi.fn(), destroy: vi.fn() },
  pmp: { portMapping: vi.fn(), portUnmapping: vi.fn(), externalIp: vi.fn(), close: vi.fn(), on: vi.fn() },
}));
vi.mock('@silentbot1/nat-api/lib/upnp/index.js', () => ({ default: class { constructor() { return mocks.upnp; } } }));
vi.mock('nat-pmp', () => ({ connect: () => mocks.pmp }));
vi.mock('./logger', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) } }));
vi.mock('../db/store', () => ({ getSettings: async () => ({ portForwarding: true }) }));
import { getPortForwarding, stopPortForwarding } from './port-forwarding';

describe('port forwarding callback adapters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.upnp.findGateway.mockResolvedValue({});
    mocks.upnp.portMapping.mockResolvedValue({});
    mocks.upnp.portUnmapping.mockResolvedValue({});
    mocks.upnp.destroy.mockResolvedValue(undefined);
    for (const client of [mocks.pmp]) {
      client.portMapping.mockImplementation((_opts, cb) => cb(null));
      client.portUnmapping.mockImplementation((_opts, cb) => cb(null));
    }
    mocks.upnp.externalIp.mockResolvedValue('203.0.113.1');
    mocks.pmp.externalIp.mockImplementation(cb => cb(null, { ip: [203, 0, 113, 2] }));
  });
  afterEach(async () => { await stopPortForwarding(); vi.useRealTimers(); });

  it('maps and removes using the UPnP promise API', async () => {
    await getPortForwarding().start(51413);
    expect(getPortForwarding().getStatus()).toMatchObject({ state: 'mapped', method: 'upnp' });
    await stopPortForwarding();
    expect(mocks.upnp.portUnmapping).toHaveBeenCalled();
    expect(mocks.upnp.destroy).toHaveBeenCalled();
  });
  it('falls back to NAT-PMP when UPnP discovery fails', async () => {
    mocks.upnp.findGateway.mockRejectedValue(new Error('No gateway'));
    await getPortForwarding().start(51413);
    expect(getPortForwarding().getStatus()).toMatchObject({ state: 'mapped', method: 'nat-pmp', externalIp: '203.0.113.2' });
  });
  it('finishes when neither protocol responds', async () => {
    mocks.upnp.findGateway.mockImplementation(() => new Promise(() => {}));
    mocks.pmp.portMapping.mockImplementation(() => {});
    const pending = getPortForwarding().start(51413);
    await vi.advanceTimersByTimeAsync(8000);
    await pending;
    expect(getPortForwarding().getStatus().state).toBe('unsupported');
  });

  it('removes a mapping that finishes while stop is pending and never renews it', async () => {
    let finishMapping!: (value: unknown) => void;
    mocks.upnp.portMapping.mockImplementation(() => new Promise(resolve => { finishMapping = resolve; }));
    const starting = getPortForwarding().start(51413);
    await vi.waitFor(() => expect(finishMapping).toBeTypeOf('function'));
    const stopping = stopPortForwarding();
    finishMapping({});
    await Promise.all([starting, stopping]);
    expect(getPortForwarding().getStatus().state).toBe('disabled');
    expect(mocks.upnp.portUnmapping).toHaveBeenCalledWith({ public: 51413, protocol: 'tcp' });
    expect(mocks.upnp.destroy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mocks.upnp.portMapping).toHaveBeenCalledTimes(1);
  });

  it('rejects non-integer and out-of-range ports before contacting a gateway', async () => {
    for (const port of [NaN, Infinity, -1, 0, 1.5, 65536]) {
      await getPortForwarding().start(port);
      expect(getPortForwarding().getStatus().state).toBe('failed');
    }
    expect(mocks.upnp.findGateway).not.toHaveBeenCalled();
    expect(mocks.pmp.portMapping).not.toHaveBeenCalled();
  });

  it('keeps exactly one renewal after starting the same mapped port again', async () => {
    await getPortForwarding().start(51413);
    await getPortForwarding().start(51413);
    expect(mocks.upnp.portMapping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mocks.upnp.portMapping).toHaveBeenCalledTimes(2);
  });
});
