import { describe, expect, it, vi } from 'vitest';
import { EffectiveSettingsController } from './effective-settings';
import type { AppSettings, SchedulerConfig, NetworkProfile } from '../../shared/types';

function fixture() {
  const state = { base: { maxDownKbps: 1000, maxUpKbps: 0, altDownKbps: 100, altUpKbps: 0, altSpeedEnabled: false,
    maxConnectionsGlobal: 200, networkProfilesEnabled: true, adaptiveUpload: false, dohEnabled: false } as AppSettings,
  scheduler: { enabled: false, schedules: [] } as SchedulerConfig };
  const apply = vi.fn<(patch: Partial<AppSettings>) => Promise<void>>().mockResolvedValue(undefined);
  const controller = new EffectiveSettingsController({ readBase: async () => ({ ...state.base }), readScheduler: async () => structuredClone(state.scheduler), apply });
  return { state, controller, apply };
}
const mobile: NetworkProfile = { id: 'phone', name: 'Phone', networkKey: 'key', networkLabel: 'Phone', overrides: { maxDownKbps: 250 } };

describe('effective engine controller', () => {
  it('recomputes from the latest persisted base when leaving a network', async () => {
    const f = fixture(); await f.controller.setNetwork(mobile);
    expect(f.apply.mock.lastCall?.[0].maxDownKbps).toBe(250);
    f.state.base.maxDownKbps = 60; await f.controller.setNetwork(null);
    expect(f.apply.mock.lastCall?.[0].maxDownKbps).toBe(60);
    expect(f.state.base.maxUpKbps).toBe(0);
  });
  it('serializes concurrent engine writes and resolves queued policies from current state', async () => {
    const f = fixture(); let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    f.apply.mockImplementationOnce(async () => { entered(); await new Promise<void>(r => { release = r; }); });
    const first = f.controller.setNetwork(mobile); await started;
    f.state.base.maxDownKbps = 70;
    const second = f.controller.setNetwork(null); expect(f.apply).toHaveBeenCalledTimes(1);
    release(); await Promise.all([first, second]);
    expect(f.apply).toHaveBeenCalledTimes(2); expect((await f.controller.getSnapshot()).download.value).toBe(70);
  });
  it('does not allow an unrelated settings save to replace a policy cap', async () => {
    const f = fixture(); await f.controller.setNetwork(mobile);
    await f.controller.refresh({ maxDownKbps: 1000, maxConnections: 40 });
    expect(f.apply.mock.lastCall?.[0]).toMatchObject({ maxDownKbps: 250, maxConnections: 40 });
  });
  it('reports unsuccessful application and recovers on the next refresh', async () => {
    const f = fixture(); f.apply.mockRejectedValueOnce(new Error('engine unavailable'));
    await expect(f.controller.refresh()).rejects.toThrow('engine unavailable');
    expect((await f.controller.getSnapshot()).applied).toBe(false);
    await f.controller.refresh(); expect((await f.controller.getSnapshot()).applied).toBe(true);
  });
  it('removing one protection cannot clear another or resume transfers', async () => {
    const f = fixture(); await f.controller.refresh();
    f.controller.setBlock('vpn', true); f.controller.setBlock('disk', true); f.controller.setBlock('vpn', false);
    expect((await f.controller.getSnapshot()).blocks).toEqual(['disk']); expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it('updates alternative mode from persisted state and retains a policy on both pairs', async () => {
    const f = fixture(); await f.controller.setNetwork(mobile); f.state.base.altSpeedEnabled = true;
    await f.controller.refresh(); const snapshot = await f.controller.getSnapshot();
    expect(snapshot.download.value).toBe(100); expect(snapshot.engine.maxDownKbps).toBe(250);
  });
  it('invalidates an applied snapshot when the host becomes unavailable', async () => {
    const f = fixture(); await f.controller.refresh(); f.controller.invalidate();
    expect((await f.controller.getSnapshot()).applied).toBe(false);
    await f.controller.refresh(); expect((await f.controller.getSnapshot()).applied).toBe(true);
  });
  it('a late settings acknowledgment cannot mark a stopped host as applied', async () => {
    const f = fixture(); let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    f.apply.mockImplementationOnce(async () => { entered(); await new Promise<void>(r => { release = r; }); });
    const pending = f.controller.refresh(); await started; f.controller.invalidate(); release(); await pending;
    expect((await f.controller.getSnapshot()).applied).toBe(false);
  });
});
