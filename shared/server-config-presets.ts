import type { ConfigField } from './gameserver-types';
import { validateConfigValues } from './gameserver-core';

export interface ServerConfigPreset { id: string; name: string; values: Record<string, string> }
export const CONFIG_PRESET_KEYS = ['gamemode', 'difficulty', 'pvp', 'max-players', 'havvn-memory-mb', 'view-distance', 'simulation-distance', 'spawn-protection', 'enable-command-block'] as const;
export const CONFIG_PRESET_IDS = ['survival', 'creative', 'modded', 'lightweight'] as const;
export type ConfigPresetId = typeof CONFIG_PRESET_IDS[number];
const DEFAULTS: Record<ConfigPresetId, Record<string, string>> = {
  survival: { gamemode: 'survival', difficulty: 'normal', pvp: 'true', 'max-players': '10', 'havvn-memory-mb': '2048', 'view-distance': '10', 'simulation-distance': '8' },
  creative: { gamemode: 'creative', difficulty: 'peaceful', pvp: 'false', 'max-players': '10', 'havvn-memory-mb': '2048', 'view-distance': '10', 'simulation-distance': '6' },
  modded: { 'havvn-memory-mb': '4096', 'view-distance': '8', 'simulation-distance': '6', 'max-players': '8' },
  lightweight: { 'havvn-memory-mb': '1536', 'view-distance': '5', 'simulation-distance': '3', 'max-players': '4' },
};
export function presetValues(values: Record<string, string>, schema: ConfigField[]): Record<string, string> {
  const allowed = schema.filter(f => (CONFIG_PRESET_KEYS as readonly string[]).includes(f.key));
  // The main process validates again on Save. Preserve network, identity, seed,
  // authentication and any module-specific settings outside this allow-list.
  const subset = Object.fromEntries(Object.entries(values).filter(([key]) => allowed.some(f => f.key === key)));
  const valid = validateConfigValues(allowed, subset).values;
  return Object.fromEntries(Object.keys(subset).filter(key => valid[key] === subset[key]).map(key => [key, subset[key]]));
}
export function builtinConfigPreset(id: ConfigPresetId, schema: ConfigField[]): Record<string, string> {
  return presetValues(DEFAULTS[id], schema);
}
export function configPresetChanges(current: Record<string, string>, preset: Record<string, string>, schema: ConfigField[]): { field: ConfigField; before: string; after: string }[] {
  const clean = presetValues(preset, schema);
  return schema.filter(f => clean[f.key] !== undefined && clean[f.key] !== current[f.key]).map(field => ({ field, before: current[field.key] ?? '', after: clean[field.key] }));
}
export function parseConfigPresets(raw: unknown): ServerConfigPreset[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.slice(0, 12).flatMap(p => {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^custom-[\w-]{1,80}$/.test(p.id) || seen.has(p.id)
      || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 || !p.values || typeof p.values !== 'object' || Array.isArray(p.values)) return [];
    seen.add(p.id);
    const values = Object.fromEntries(Object.entries(p.values).filter(([key, value]) => (CONFIG_PRESET_KEYS as readonly string[]).includes(key) && typeof value === 'string' && value.length <= 64)) as Record<string, string>;
    return [{ id: p.id, name: p.name.trim(), values }];
  });
}
