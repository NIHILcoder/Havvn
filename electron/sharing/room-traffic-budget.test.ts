import { describe, expect, it, vi } from 'vitest';
import { allocateRoomRates, DEFAULT_ROOM_RESOURCES, readRoomResources, roomFileBudget, validateRoomResources } from '../../shared/room-resources';
import { RoomTrafficBudget } from './room-traffic-budget';
import { createRequire } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';

function fixture() {
  const stopped = vi.fn(), budget = new RoomTrafficBudget(stopped);
  const clients: Array<{ up: number; down: number; throttleUpload: ReturnType<typeof vi.fn>; throttleDownload: ReturnType<typeof vi.fn> }> = [];
  const add = (id: string, up = 0, down = 0) => {
    const client = { up: 0, down: 0, throttleUpload: vi.fn(), throttleDownload: vi.fn() };
    client.throttleUpload.mockImplementation((rate: number) => { client.up = rate; });
    client.throttleDownload.mockImplementation((rate: number) => { client.down = rate; });
    clients.push(client); budget.register(id, client, up, down); return client;
  };
  return { budget, add, stopped, clients };
}

describe('shared room file budget', () => {
  it('limits actual byte streams through WebTorrent’s installed throttle groups', async () => {
    const { ThrottleGroup } = createRequire(import.meta.url)('speed-limiter');
    const budget = new RoomTrafficBudget(() => {});
    budget.configure({ ...DEFAULT_ROOM_RESOURCES, maxUpKbps: 64 });
    const groups = [0, 1].map(() => new ThrottleGroup({ rate: 0, enabled: true }));
    let received = 0;
    try {
      groups.forEach((group, i) => budget.register(String(i), {
        throttleUpload: rate => { group.setEnabled(rate >= 0); group.setRate(Math.max(0, rate)); },
        throttleDownload: () => {},
      }, 0, 0));
      const start = performance.now();
      await Promise.all(groups.map(group => pipeline(Readable.from([Buffer.alloc(128 * 1024)]), group.throttle(),
        new Writable({ write(chunk, _encoding, done) { received += chunk.length; done(); } }))));
      const elapsed = (performance.now() - start) / 1000;
      expect(received).toBe(256 * 1024);
      // The limiter allows a token-bucket burst. Separate 64 KB/s budgets would
      // finish in ~2s; the shared budget needs ~4s (allow one bucket of burst).
      expect(elapsed).toBeGreaterThan(2.8);
    } finally { groups.forEach(group => group.destroy()); }
  }, 20_000);
  it('divides one ceiling across clients and redistributes a capped room’s spare share', () => {
    const f = fixture(), a = f.add('a'), b = f.add('b');
    expect(a.up + b.up).toBe(256 * 1024);
    expect(a.up).toBe(b.up);
    f.budget.setLimits('b', 32, 10);
    expect([a.up, b.up, b.down]).toEqual([224 * 1024, 32 * 1024, 10 * 1024]);
    f.budget.remove('b'); expect(a.up).toBe(256 * 1024);
  });
  it('uses all bytes even for uneven shares and never exceeds individual caps', () => {
    for (let n = 1; n < 100; n++) {
      const rates = allocateRoomRates(1, Array(n).fill(0));
      expect(rates.reduce((sum, rate) => sum + rate, 0)).toBe(1024);
      expect(Math.max(...rates) - Math.min(...rates)).toBeLessThanOrEqual(1);
    }
    expect(allocateRoomRates(256, [10, 20, 0])).toEqual([10240, 20480, 231424]);
    expect(allocateRoomRates(0, [0, 32])).toEqual([-1, 32768]);
  });
  it('reduces a shared budget for an active call and restores it afterwards', () => {
    const f = fixture(), a = f.add('a'), b = f.add('b');
    f.budget.setVoiceActive(true);
    expect([a.up + b.up, a.down + b.down]).toEqual([64 * 1024, 2048 * 1024]);
    const before = a.throttleUpload.mock.calls.length;
    f.budget.setVoiceActive(true); expect(a.throttleUpload).toHaveBeenCalledTimes(before);
    f.budget.setVoiceActive(false);
    expect(a.up + b.up).toBe(256 * 1024); expect(a.down).toBe(-1);
    f.budget.configure({ ...DEFAULT_ROOM_RESOURCES, maxUpKbps: 16, maxDownKbps: 32 });
    f.budget.setVoiceActive(true);
    expect([a.up + b.up, a.down + b.down]).toEqual([16 * 1024, 32 * 1024]);
  });
  it('applies live configuration and allows explicitly disabling voice priority', () => {
    const f = fixture(), a = f.add('a'), b = f.add('b');
    f.budget.setVoiceActive(true);
    f.budget.configure({ ...DEFAULT_ROOM_RESOURCES, maxUpKbps: 0, maxDownKbps: 100, voicePriority: false });
    expect([a.up, b.up, a.down + b.down]).toEqual([-1, -1, 102400]);
    expect(f.budget.isVoicePriorityActive()).toBe(false);
  });
  it('lowers the old client before allowing a new client to consume its share', () => {
    const f = fixture(), a = f.add('a'), order: number[] = [];
    a.throttleUpload.mockImplementation((rate: number) => { a.up = rate; order.push(rate); });
    const b = { throttleUpload: vi.fn((rate: number) => { order.push(rate); }), throttleDownload: vi.fn() };
    f.budget.register('b', b, 0, 0);
    expect(order).toEqual([128 * 1024, 128 * 1024]);
  });
  it('rolls back every client, including a setter which mutates then throws', () => {
    const f = fixture(), a = f.add('a'), b = f.add('b');
    b.throttleDownload.mockImplementationOnce((rate: number) => { b.down = rate; throw new Error('failed'); });
    expect(() => f.budget.configure({ ...DEFAULT_ROOM_RESOURCES, maxUpKbps: 32, maxDownKbps: 16 })).toThrow('failed');
    expect([a.up, b.up, a.down, b.down]).toEqual([131072, 131072, -1, -1]);
    expect(f.budget.getPolicy()).toEqual(DEFAULT_ROOM_RESOURCES); expect(f.stopped).not.toHaveBeenCalled();
  });
  it('fails closed if rollback fails, and accepts a fresh replacement client', () => {
    const f = fixture(), a = f.add('a'); f.add('b');
    a.throttleDownload.mockImplementation(() => { throw new Error('broken'); });
    expect(() => f.budget.setVoiceActive(true)).toThrow('broken');
    expect(f.stopped.mock.calls).toEqual([['a'], ['b']]); expect(f.budget.rates('a')).toBeUndefined();
    expect(f.add('a').up).toBe(256 * 1024);
  });
  it('rolls back an unsuccessful registration without retaining a ghost allocation', () => {
    const f = fixture(), a = f.add('a');
    const broken = { throttleUpload: vi.fn().mockImplementationOnce(() => { throw new Error('failed'); }), throttleDownload: vi.fn() };
    expect(() => f.budget.register('b', broken, 0, 0)).toThrow('failed');
    expect(a.up).toBe(256 * 1024); expect(f.budget.rates('b')).toBeUndefined();
    expect(f.stopped).toHaveBeenCalledWith('b');
  });
  it('validates live edits, migrates old settings and bounds voice fallback', () => {
    expect(readRoomResources()).toEqual(DEFAULT_ROOM_RESOURCES);
    expect(readRoomResources({ maxUpKbps: NaN })).toEqual(DEFAULT_ROOM_RESOURCES);
    for (const patch of [{ maxUpKbps: -1 }, { maxDownKbps: Infinity }, { maxUpKbps: 1.5 }, { voicePriority: 'yes' }, { screenBitrateKbps: 0 }]) {
      expect(() => validateRoomResources({ ...DEFAULT_ROOM_RESOURCES, ...patch })).toThrow('Invalid');
    }
    expect(roomFileBudget({ ...DEFAULT_ROOM_RESOURCES, maxUpKbps: 0 }, true)).toEqual({ up: 64, down: 2048 });
  });
});
