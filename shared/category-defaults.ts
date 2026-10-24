import type { AddDownloadRequest, AppSettings, Category, DownloadDefaults } from './types';
import { validateNotificationRule } from './notification-policy';

const keys = ['savePath', 'seedRatioLimit', 'seedTimeLimitMinutes', 'paused', 'sequentialDownload'] as const;
export type DefaultSource = 'explicit' | 'category' | 'global';
export interface ResolvedDownloadDefaults {
  values: Required<DownloadDefaults>;
  sources: Record<keyof DownloadDefaults, DefaultSource>;
}

/** Shared by preview and main; false/zero are intentional overrides. */
export function resolveDownloadDefaults(request: DownloadDefaults, category: Category | undefined,
  settings: Pick<AppSettings, 'defaultDownloadDir' | 'defaultSeedRatioLimit' | 'defaultSeedTimeLimitMinutes'>): ResolvedDownloadDefaults {
  const global: Required<DownloadDefaults> = { savePath: settings.defaultDownloadDir, seedRatioLimit: settings.defaultSeedRatioLimit ?? 0,
    seedTimeLimitMinutes: settings.defaultSeedTimeLimitMinutes ?? 0, paused: false, sequentialDownload: false };
  const values = { ...global }, sources = {} as ResolvedDownloadDefaults['sources'];
  for (const key of keys) {
    const explicit = request[key], inherited = category?.downloadDefaults?.[key];
    const source: DefaultSource = explicit !== undefined ? 'explicit' : inherited !== undefined ? 'category' : 'global';
    sources[key] = source;
    Object.assign(values, { [key]: source === 'explicit' ? explicit : source === 'category' ? inherited : global[key] });
  }
  return { values, sources };
}

export function validateDownloadDefaults(input: unknown): DownloadDefaults {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('Invalid category defaults');
  const source = input as Record<string, unknown>, result: DownloadDefaults = {};
  for (const key of keys) {
    const value = source[key];
    if (value === undefined) continue;
    if (key === 'savePath') {
      // Portable syntax only. The current machine validates access before add.
      // eslint-disable-next-line no-control-regex
      if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid category savePath');
      result.savePath = value;
    } else if (key === 'paused' || key === 'sequentialDownload') {
      if (typeof value !== 'boolean') throw new Error(`Invalid category ${key}`);
      result[key] = value;
    } else {
      const max = key === 'seedRatioLimit' ? 10_000 : 52_560_000;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (key === 'seedTimeLimitMinutes' && !Number.isSafeInteger(value))) throw new Error(`Invalid category ${key}`);
      result[key] = value;
    }
  }
  return result;
}

export function validateCategory(input: unknown): Category {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid category');
  const c = input as Category;
  // eslint-disable-next-line no-control-regex
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
  if (!text(c.id, 128) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(c.id) || ['__proto__', 'constructor', 'prototype'].includes(c.id)
    || !text(c.name, 256) || !text(c.icon, 128) || !/^[a-zA-Z0-9-]+$/.test(c.icon)
    || typeof c.color !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(c.color)) throw new Error('Invalid category');
  return { id: c.id, name: c.name.trim(), icon: c.icon, color: c.color,
    ...(c.notificationRule !== undefined ? { notificationRule: validateNotificationRule(c.notificationRule) } : {}),
    ...(c.downloadDefaults !== undefined ? { downloadDefaults: validateDownloadDefaults(c.downloadDefaults) } : {}) };
}

/** Global seed limits retain their existing live inheritance; category/explicit limits are copied. */
export function applyDownloadDefaults(request: AddDownloadRequest, category: Category | undefined, settings: Parameters<typeof resolveDownloadDefaults>[2]): AddDownloadRequest {
  validateDownloadDefaults(request);
  const { values, sources } = resolveDownloadDefaults(request, category, settings);
  return { ...request, ...values,
    seedRatioLimit: sources.seedRatioLimit === 'global' ? undefined : values.seedRatioLimit,
    seedTimeLimitMinutes: sources.seedTimeLimitMinutes === 'global' ? undefined : values.seedTimeLimitMinutes };
}
