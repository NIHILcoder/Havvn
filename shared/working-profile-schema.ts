import { validateAppearanceProfile, type AppearanceProfile } from './appearance-profile';
import { DEFAULT_NOTIFICATION_POLICY, validateNotificationPolicy, type NotificationEnvironment } from './notification-policy';

export const WORKING_PROFILES_KEY = 'havvn.working-profiles.v1';
export const PANELS_KEY = 'havvn.panels.v1';
export const WORKING_PROFILES_LIMIT = 16;
export const WORKING_PROFILES_MAX_CHARS = 8 * 1024 * 1024;
export interface PanelVisibility { sidebar: boolean; statusBar: boolean }
export type ProfileNotifications = Required<NotificationEnvironment['settings']>;
export interface WorkingValues {
  startPage: 'downloads' | 'rooms';
  viewId: string | null;
  panels: PanelVisibility;
  appearanceName: string | null;
  notifications: ProfileNotifications;
}
export interface WorkingProfile { id: string; name: string; values: WorkingValues }
export interface WorkingCheckpoint { activeId: string | null; values: WorkingValues; appearance: AppearanceProfile }
export interface WorkingProfiles {
  version: 1;
  profiles: WorkingProfile[];
  activeId: string | null;
  previous: WorkingCheckpoint | null;
}
export type WorkingErrorCode = 'invalid' | 'storage' | 'name' | 'duplicate' | 'limit' | 'missing' | 'stale' | 'draft';
export class WorkingProfileError extends Error {
  constructor(readonly code: WorkingErrorCode) { super(`Working profile: ${code}`); }
}
const fail = (): never => { throw new WorkingProfileError('invalid'); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) return fail();
  return value as Record<string, unknown>;
}
function id(value: unknown): string { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) return fail(); return value; }
function name(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 60 || [...value].some(char => char.charCodeAt(0) < 32)) return fail(); return value.trim(); }
export const defaultPanels = (): PanelVisibility => ({ sidebar: true, statusBar: true });
export const emptyWorkingProfiles = (): WorkingProfiles => ({ version: 1, profiles: [], activeId: null, previous: null });
export function validatePanels(value: unknown): PanelVisibility {
  const p = object(value, ['sidebar', 'statusBar']);
  if (typeof p.sidebar !== 'boolean' || typeof p.statusBar !== 'boolean') return fail();
  return { sidebar: p.sidebar, statusBar: p.statusBar };
}
export function readProfileNotifications(value: NotificationEnvironment['settings']): ProfileNotifications {
  return { enableNotifications: value.enableNotifications ?? true, enableSounds: value.enableSounds ?? true,
    notifyOnComplete: value.notifyOnComplete ?? true, notifyOnError: value.notifyOnError ?? true,
    notificationPolicy: validateNotificationPolicy(value.notificationPolicy ?? DEFAULT_NOTIFICATION_POLICY) };
}
export function validateProfileNotifications(value: unknown): ProfileNotifications {
  const p = object(value, ['enableNotifications', 'enableSounds', 'notifyOnComplete', 'notifyOnError', 'notificationPolicy']);
  if (['enableNotifications', 'enableSounds', 'notifyOnComplete', 'notifyOnError'].some(key => typeof p[key] !== 'boolean') || !p.notificationPolicy) return fail();
  const policy = object(p.notificationPolicy, ['showContent', 'quietHours', 'summaries']);
  object(policy.quietHours, ['enabled', 'start', 'end']); object(policy.summaries, ['enabled', 'windowSeconds']);
  return readProfileNotifications(p as unknown as ProfileNotifications);
}
export function validateWorkingValues(value: unknown): WorkingValues {
  const p = object(value, ['startPage', 'viewId', 'panels', 'appearanceName', 'notifications']);
  if (!['downloads', 'rooms'].includes(String(p.startPage))) return fail();
  return { startPage: p.startPage as WorkingValues['startPage'], viewId: p.viewId === null ? null : id(p.viewId), panels: validatePanels(p.panels),
    appearanceName: p.appearanceName === null ? null : name(p.appearanceName), notifications: validateProfileNotifications(p.notifications) };
}
export function validateWorkingProfile(value: unknown): WorkingProfile {
  const p = object(value, ['id', 'name', 'values']);
  return { id: id(p.id), name: name(p.name), values: validateWorkingValues(p.values) };
}
export function validateWorkingProfiles(value: unknown): WorkingProfiles {
  const p = object(value, ['version', 'profiles', 'activeId', 'previous']);
  if (p.version !== 1 || !Array.isArray(p.profiles) || p.profiles.length > WORKING_PROFILES_LIMIT) return fail();
  const profiles = p.profiles.map(validateWorkingProfile);
  if (new Set(profiles.map(p => p.id)).size !== profiles.length || new Set(profiles.map(p => p.name.toLocaleLowerCase())).size !== profiles.length) return fail();
  const activeId = p.activeId === null ? null : id(p.activeId);
  if (activeId && !profiles.some(p => p.id === activeId)) return fail();
  let previous: WorkingCheckpoint | null = null;
  if (p.previous !== null) {
    const c = object(p.previous, ['activeId', 'values', 'appearance']), appearance = validateAppearanceProfile(c.appearance);
    if (!appearance) return fail();
    previous = { activeId: c.activeId === null ? null : id(c.activeId), values: validateWorkingValues(c.values), appearance };
  }
  return { version: 1, profiles, activeId, previous };
}
