import { resolveRuntimeFeatures } from './effective-settings';

export type ResourceMode = 'normal' | 'economy' | 'auto';
export type PowerSource = 'ac' | 'battery' | 'unknown';
export interface ResourceModeSnapshot {
  mode: ResourceMode;
  power: PowerSource;
  economy: boolean;
  source: 'manual' | PowerSource;
  revision: number;
}
export const RESOURCE_ECONOMY = { statsIntervalMs: 1000, previewIntervalMs: 5000, thumbnails: false, prefetch: false, quality: 'light' as const };
export function validateResourceMode(value: unknown): ResourceMode {
  if (value !== 'normal' && value !== 'economy' && value !== 'auto') throw new Error('Invalid resource mode');
  return value;
}
export function resolveResourceMode(mode: ResourceMode, power: PowerSource, revision = 0): ResourceModeSnapshot {
  return { mode, power, economy: mode === 'economy' || mode === 'auto' && power === 'battery', source: mode === 'auto' ? power : 'manual', revision };
}
export function validResourceSnapshot(value: unknown): value is ResourceModeSnapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as ResourceModeSnapshot;
  if (!['normal', 'economy', 'auto'].includes(s.mode) || !['ac', 'battery', 'unknown'].includes(s.power)
    || !Number.isSafeInteger(s.revision) || s.revision < 0) return false;
  const expected = resolveResourceMode(s.mode, s.power, s.revision);
  return s.economy === expected.economy && s.source === expected.source;
}
export function resourceFeatures(base: { quality: 'light' | 'full'; motion: boolean; prefetch: boolean }, economy: boolean): typeof base {
  return { ...resolveRuntimeFeatures(base, economy ? [{ quality: 'light', prefetch: false }] : []), motion: base.motion && !economy };
}
