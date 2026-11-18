import { describe, expect, it } from 'vitest';
import { resolveEffectiveSettings, resolveRuntimeFeatures, scheduleDayTimeline, scheduleMatches, type SpeedBase } from './effective-settings';
import type { NetworkProfile, SchedulerConfig } from './types';

const base = (patch: Partial<SpeedBase> = {}): SpeedBase => ({ maxDownKbps: 500, maxUpKbps: 100, altDownKbps: 80, altUpKbps: 0,
  altSpeedEnabled: false, maxConnectionsGlobal: 200, adaptiveUpload: true, dohEnabled: false, networkProfilesEnabled: true, ...patch });
const now = new Date(2026, 9, 26, 23, 30); // Monday, local time.
const schedule: SchedulerConfig = { enabled: true, schedules: [{ id: 'night', days: [1], startTime: '23:00', endTime: '02:00', speedLimit: 300 }] };
const network: NetworkProfile = { id: 'mobile', name: 'Phone', networkKey: 'abc', networkLabel: 'Phone', overrides: { maxDownKbps: 150, maxUpKbps: 200 } };

describe('effective settings contract', () => {
  it('composes manual, network and schedule ceilings without lifting a smaller upload base', () => {
    const result = resolveEffectiveSettings(base(), { scheduler: schedule, network, now });
    expect(result.download.value).toBe(150); expect(result.upload.value).toBe(100);
    expect(result.download.sources).toEqual([{ kind: 'network', id: 'mobile', name: 'Phone' }]);
    expect(result.upload.sources).toEqual([{ kind: 'manual' }]);
  });
  it('zero is unlimited in a manual pair and contributes no policy ceiling', () => {
    expect(resolveEffectiveSettings(base({ maxDownKbps: 0 }), { network }).download.value).toBe(150);
    expect(resolveEffectiveSettings(base(), { network: { ...network, overrides: { maxDownKbps: 0 } } }).download.value).toBe(500);
  });
  it('caps both normal and alternative pairs, including an unlimited alternative upload', () => {
    const result = resolveEffectiveSettings(base({ altSpeedEnabled: true }), { scheduler: schedule, network, now });
    expect(result.engine).toMatchObject({ maxDownKbps: 150, maxUpKbps: 100, altDownKbps: 80, altUpKbps: 200, altSpeedEnabled: true });
    expect(result.download.base).toBe(80); expect(result.upload.value).toBe(200);
  });
  it('intersects overlapping schedules instead of choosing whichever is stored first', () => {
    const config = { enabled: true, schedules: [...schedule.schedules, { ...schedule.schedules[0], id: 'other', speedLimit: 50 }] };
    expect(resolveEffectiveSettings(base(), { scheduler: config, now }).download.value).toBe(50);
    expect(resolveEffectiveSettings(base(), { scheduler: { ...config, schedules: [...config.schedules].reverse() }, now }).download.value).toBe(50);
  });
  it('shows the tightest scheduled limit through unlimited and overnight overlaps in either rule order', () => {
    const windows = [
      { id: 'unlimited', days: [2], startTime: '00:00', endTime: '23:59', speedLimit: 0 },
      schedule.schedules[0],
      { id: 'inner', days: [2], startTime: '01:00', endTime: '03:00', speedLimit: 50 },
    ];
    const expected = [
      { start: 0, end: 60, limit: 300 },
      { start: 60, end: 180, limit: 50 },
      { start: 180, end: 1439, limit: 0 },
    ];
    expect(scheduleDayTimeline(windows, 2)).toEqual(expected);
    expect(scheduleDayTimeline([...windows].reverse(), 2)).toEqual(expected);
    expect(scheduleDayTimeline(windows, 1)).toEqual([{ start: 1380, end: 1440, limit: 300 }]);
    expect(scheduleDayTimeline(windows, 3)).toEqual([]);
  });
  it('a matching unlimited/empty schedule does not leave a previous limit latched', () => {
    for (const speedLimit of [undefined, 0]) expect(resolveEffectiveSettings(base(), { scheduler: { enabled: true, schedules: [{ ...schedule.schedules[0], speedLimit }] }, network, now }).download.value).toBe(150);
  });
  it('removing one policy retains all remaining policies and reads the new manual base', () => {
    expect(resolveEffectiveSettings(base({ maxDownKbps: 70 }), { network, now }).download.value).toBe(70);
    expect(resolveEffectiveSettings(base(), { scheduler: schedule, now }).download.value).toBe(300);
    expect(resolveEffectiveSettings(base(), { network, now: new Date(2026, 9, 27, 3) }).download.value).toBe(150);
  });
  it('matches an overnight window against its starting day, with an exclusive end and week wrap', () => {
    expect(scheduleMatches(schedule.schedules[0], new Date(2026, 9, 27, 1))).toBe(true);
    expect(scheduleMatches(schedule.schedules[0], new Date(2026, 9, 26, 1))).toBe(false);
    expect(scheduleMatches(schedule.schedules[0], new Date(2026, 9, 27, 2))).toBe(false);
    expect(scheduleMatches({ ...schedule.schedules[0], days: [6] }, new Date(2026, 9, 25, 1))).toBe(true);
  });
  it('rejects invalid clock syntax and treats an equal start/end as an empty interval', () => {
    expect(scheduleMatches({ ...schedule.schedules[0], startTime: '25:00' }, now)).toBe(false);
    expect(scheduleMatches({ ...schedule.schedules[0], endTime: '23:00' }, now)).toBe(false);
  });
  it('preserves all equally restrictive sources', () => {
    const result = resolveEffectiveSettings(base({ maxDownKbps: 150 }), { network, economy: { maxDownKbps: 150 } });
    expect(result.download.sources.map(s => s.kind)).toEqual(['manual', 'network', 'economy']);
  });
  it('disabled network policies do not affect speeds, connections or explicit boolean preferences', () => {
    const result = resolveEffectiveSettings(base({ networkProfilesEnabled: false }), { network: { ...network, overrides: { maxDownKbps: 10, maxConnectionsGlobal: 10, adaptiveUpload: false, dohEnabled: true } } });
    expect(result.engine).toMatchObject({ maxDownKbps: 500, maxConnectionsGlobal: 200, adaptiveUpload: true, dohEnabled: false });
  });
  it('keeps independent protection reasons regardless of a speed policy or alternative mode', () => {
    expect(resolveEffectiveSettings(base({ altSpeedEnabled: true }), { blocks: ['vpn', 'disk', 'vpn'], economy: {} }).blocks).toEqual(['vpn', 'disk']);
  });
  it('does not mutate persisted settings or feature preferences', () => {
    const settings = Object.freeze(base()); const original = { ...settings };
    resolveEffectiveSettings(settings, { network, scheduler: schedule, now }); expect(settings).toEqual(original);
    const features = { quality: 'full' as const, prefetch: true };
    expect(resolveRuntimeFeatures(features, [{ quality: 'light' }, { prefetch: false }])).toEqual({ quality: 'light', prefetch: false });
    expect(resolveRuntimeFeatures(features, [])).toEqual(features);
    expect(resolveRuntimeFeatures({ quality: 'light', prefetch: false }, [{ quality: 'full', prefetch: true }])).toEqual({ quality: 'light', prefetch: false });
  });
});
