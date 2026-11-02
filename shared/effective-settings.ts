import type { AppSettings, NetworkProfile, ScheduleEntry, SchedulerConfig } from './types';

export type TransferBlock = 'vpn' | 'disk';
export type PolicySource = 'manual' | 'alternative' | 'network' | 'schedule' | 'economy';
export interface SettingSource { kind: PolicySource; id?: string; name?: string }
export interface SpeedConstraint { source: SettingSource; value: number }
export interface EffectiveLimit {
  base: number;
  value: number;
  sources: SettingSource[];
  constraints: SpeedConstraint[];
}
export type SpeedBase = Pick<AppSettings, 'maxDownKbps' | 'maxUpKbps' | 'altDownKbps' | 'altUpKbps' | 'altSpeedEnabled'
  | 'maxConnectionsGlobal' | 'adaptiveUpload' | 'dohEnabled' | 'networkProfilesEnabled'>;
export interface EconomyLimits { maxDownKbps?: number; maxUpKbps?: number }
export interface EffectiveSettings {
  download: EffectiveLimit;
  upload: EffectiveLimit;
  connections: EffectiveLimit;
  engine: Pick<SpeedBase, 'maxDownKbps' | 'maxUpKbps' | 'altDownKbps' | 'altUpKbps' | 'altSpeedEnabled'
    | 'maxConnectionsGlobal' | 'adaptiveUpload' | 'dohEnabled'>;
  blocks: TransferBlock[];
}
export interface EffectiveSettingsSnapshot extends EffectiveSettings { applied: boolean }

/** Zero is unlimited. A temporary policy can tighten a manual limit, never lift it. */
export function resolveLimit(base: number, source: SettingSource, constraints: SpeedConstraint[]): EffectiveLimit {
  const valid = (value: number): number => Number.isFinite(value) && value > 0 ? value : 0;
  const active = constraints.filter(c => valid(c.value) > 0).map(c => ({ ...c, value: valid(c.value) }));
  const candidates = [{ source, value: valid(base) }, ...active].filter(c => c.value > 0);
  const value = candidates.length ? Math.min(...candidates.map(c => c.value)) : 0;
  return { base: valid(base), value, sources: candidates.length ? candidates.filter(c => c.value === value).map(c => c.source) : [source], constraints: active };
}

/** Days identify the START of a window; after midnight belongs to yesterday's window. */
export function scheduleMatches(schedule: ScheduleEntry, now: Date): boolean {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.endTime)) return false;
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const day = now.getDay();
  if (schedule.startTime <= schedule.endTime) return schedule.days.includes(day) && time >= schedule.startTime && time < schedule.endTime;
  return time >= schedule.startTime ? schedule.days.includes(day) : time < schedule.endTime && schedule.days.includes((day + 6) % 7);
}

export function resolveEffectiveSettings(base: SpeedBase, options: {
  scheduler?: SchedulerConfig; network?: NetworkProfile | null; economy?: EconomyLimits | null;
  blocks?: readonly TransferBlock[]; now?: Date;
} = {}): EffectiveSettings {
  const network = base.networkProfilesEnabled ? options.network : null;
  const schedules = options.scheduler?.enabled ? options.scheduler.schedules.filter(s => scheduleMatches(s, options.now ?? new Date())) : [];
  const constraints = (direction: 'maxDownKbps' | 'maxUpKbps'): SpeedConstraint[] => [
    ...schedules.map(s => ({ source: { kind: 'schedule' as const, id: s.id }, value: s.speedLimit ?? 0 })),
    ...(network ? [{ source: { kind: 'network' as const, id: network.id, name: network.name }, value: network.overrides[direction] ?? 0 }] : []),
    ...(options.economy ? [{ source: { kind: 'economy' as const }, value: options.economy[direction] ?? 0 }] : []),
  ];
  const normal: SettingSource = { kind: 'manual' }, alternative: SettingSource = { kind: 'alternative' };
  const down = constraints('maxDownKbps'), up = constraints('maxUpKbps');
  const maxDownKbps = resolveLimit(base.maxDownKbps, normal, down).value;
  const maxUpKbps = resolveLimit(base.maxUpKbps, normal, up).value;
  const altDownKbps = resolveLimit(base.altDownKbps, alternative, down).value;
  const altUpKbps = resolveLimit(base.altUpKbps, alternative, up).value;
  const connections = resolveLimit(base.maxConnectionsGlobal, normal, network ? [{ source: { kind: 'network', id: network.id, name: network.name }, value: network.overrides.maxConnectionsGlobal ?? 0 }] : []);
  return {
    download: resolveLimit(base.altSpeedEnabled ? base.altDownKbps : base.maxDownKbps, base.altSpeedEnabled ? alternative : normal, down),
    upload: resolveLimit(base.altSpeedEnabled ? base.altUpKbps : base.maxUpKbps, base.altSpeedEnabled ? alternative : normal, up),
    connections,
    engine: { maxDownKbps, maxUpKbps, altDownKbps, altUpKbps, altSpeedEnabled: base.altSpeedEnabled,
      maxConnectionsGlobal: connections.value, adaptiveUpload: network?.overrides.adaptiveUpload ?? base.adaptiveUpload,
      dohEnabled: network?.overrides.dohEnabled ?? base.dohEnabled },
    blocks: [...new Set(options.blocks ?? [])],
  };
}

/** Temporary feature policies restrict cost; removing one recomputes from current preferences. */
export function resolveRuntimeFeatures(base: { quality: 'light' | 'full'; prefetch: boolean }, policies: readonly Partial<typeof base>[]): typeof base {
  return { quality: base.quality === 'light' || policies.some(p => p.quality === 'light') ? 'light' : 'full',
    prefetch: base.prefetch && policies.every(p => p.prefetch !== false) };
}
