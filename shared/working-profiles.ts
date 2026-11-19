import { validateAppearanceProfile, type AppearanceProfile } from './appearance-profile';
import { DOWNLOAD_VIEWS_KEY, emptyDownloadViews, validateDownloadViews } from './download-views';
import { captureInterfacePreferences, interfaceAppearance, validateInterfacePreferences, type InterfacePreferences } from './interface-preferences';
import { PANELS_KEY, WORKING_PROFILES_KEY, WorkingProfileError, defaultPanels, emptyWorkingProfiles, validatePanels, validateProfileNotifications,
  validateWorkingProfiles, type ProfileNotifications, type WorkingCheckpoint, type WorkingValues } from './working-profile-schema';
import { FONT_OPTIONS } from './theme';

export interface WorkingProfileRequest { id: string | null; expected: InterfacePreferences; notifications: ProfileNotifications }
export type WorkingDifference = 'startPage' | 'viewId' | 'panels' | 'appearance' | 'notifications';
export interface WorkingProfilePlan {
  request: WorkingProfileRequest;
  before: WorkingCheckpoint;
  after: WorkingCheckpoint;
  preferences: InterfacePreferences;
  differences: WorkingDifference[];
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function workingCatalog(preferences: InterfacePreferences) {
  const raw = preferences.values[WORKING_PROFILES_KEY];
  return raw == null ? emptyWorkingProfiles() : validateWorkingProfiles(JSON.parse(raw));
}
export function captureWorkingState(preferences: InterfacePreferences, notifications: ProfileNotifications): WorkingCheckpoint {
  const { values } = preferences, catalog = workingCatalog(preferences);
  const views = values[DOWNLOAD_VIEWS_KEY] ? validateDownloadViews(JSON.parse(values[DOWNLOAD_VIEWS_KEY])) : emptyDownloadViews();
  const appearance = validateAppearanceProfile({ version: 1, name: 'Checkpoint', appearance: interfaceAppearance(preferences),
    theme: values['havvn.theme.active'] ? JSON.parse(values['havvn.theme.library'] || '[]').find((t: { id: string }) => t.id === values['havvn.theme.active']) ?? null : null,
    mode: values.theme ?? 'system', accent: values.accentColor, font: values.fontChoice ?? FONT_OPTIONS[0].id,
    density: values.density === 'compact' ? 'compact' : 'normal', reduceMotion: values.reduceMotion === '1' });
  if (!appearance) throw new WorkingProfileError('invalid');
  return { activeId: catalog.activeId, values: { startPage: values.startPage === 'rooms' ? 'rooms' : 'downloads', viewId: views.activeId,
    panels: values[PANELS_KEY] ? validatePanels(JSON.parse(values[PANELS_KEY])) : defaultPanels(), appearanceName: null, notifications: validateProfileNotifications(notifications) }, appearance };
}
export function resolveWorkingAppearance(preferences: InterfacePreferences, values: WorkingValues): AppearanceProfile | null {
  if (values.appearanceName === null) return null;
  const profiles: unknown[] = JSON.parse(preferences.values['havvn.appearance.profiles.v1'] ?? '[]');
  const found = profiles.map(validateAppearanceProfile).find(p => p?.name === values.appearanceName);
  if (!found) throw new WorkingProfileError('missing');
  return found;
}
export function workingDifferences(before: WorkingCheckpoint, target: WorkingValues, appearance: AppearanceProfile | null): WorkingDifference[] {
  const result: WorkingDifference[] = [];
  for (const key of ['startPage', 'viewId', 'panels', 'notifications'] as const) if (!same(before.values[key], target[key])) result.push(key);
  const comparable = (p: AppearanceProfile) => ({ ...p, name: '', theme: p.theme ? { ...p.theme, id: '' } : null });
  if (appearance && !same(comparable(before.appearance), comparable(appearance))) result.push('appearance');
  return result;
}
/** Pure projection: touches only profile-owned UI values; the caller journals both stores. */
export function planWorkingProfile(preferencesInput: InterfacePreferences, notificationInput: ProfileNotifications, id: string | null, themeId: string): WorkingProfilePlan {
  const preferences = validateInterfacePreferences(preferencesInput), notifications = validateProfileNotifications(notificationInput);
  const catalog = workingCatalog(preferences), before = captureWorkingState(preferences, notifications);
  const profile = id === null ? null : catalog.profiles.find(item => item.id === id);
  if (id !== null && !profile || id === null && !catalog.previous) throw new WorkingProfileError('missing');
  const target = profile?.values ?? catalog.previous!.values;
  const appearance = profile ? resolveWorkingAppearance(preferences, target) : catalog.previous!.appearance;
  const values = { ...preferences.values }, views = values[DOWNLOAD_VIEWS_KEY] ? validateDownloadViews(JSON.parse(values[DOWNLOAD_VIEWS_KEY])) : emptyDownloadViews();
  if (target.viewId && !views.views.some(view => view.id === target.viewId)) throw new WorkingProfileError('missing');
  values.startPage = target.startPage; values[PANELS_KEY] = JSON.stringify(target.panels);
  values[DOWNLOAD_VIEWS_KEY] = JSON.stringify({ ...views, activeId: target.viewId });
  if (appearance) {
    values.theme = appearance.mode; values.accentColor = appearance.accent; values.fontChoice = appearance.font === 'inter' ? null : appearance.font;
    values.density = appearance.density; values.reduceMotion = appearance.reduceMotion ? '1' : '0';
    values['havvn.appearance.v1'] = JSON.stringify({ ...appearance.appearance, wallpaper: '' });
    values['havvn.appearance.wallpaper.v1'] = appearance.appearance.wallpaper || null;
    if (appearance.theme) {
      const library = JSON.parse(values['havvn.theme.library'] ?? '[]') as NonNullable<AppearanceProfile['theme']>[];
      const match = library.find(theme => same({ ...theme, id: '' }, { ...appearance.theme, id: '' }));
      const theme = match ?? { ...appearance.theme, id: themeId };
      if (!match && library.length >= 64) throw new WorkingProfileError('limit');
      if (!match) library.push(theme);
      values['havvn.theme.library'] = JSON.stringify(library); values['havvn.theme.active'] = theme.id;
    } else values['havvn.theme.active'] = null;
  }
  const restoredId = id === null ? catalog.previous!.activeId : id;
  values[WORKING_PROFILES_KEY] = JSON.stringify({ ...catalog, activeId: catalog.profiles.some(p => p.id === restoredId) ? restoredId : null, previous: before });
  const next = validateInterfacePreferences({ version: 1, values });
  return { request: { id, expected: preferences, notifications }, before, after: { ...captureWorkingState(next, target.notifications), values: target, appearance: appearance ?? before.appearance },
    preferences: next, differences: workingDifferences(before, target, appearance) };
}
export function validateWorkingRequest(input: unknown): WorkingProfileRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id', 'expected', 'notifications'].includes(key))) throw new WorkingProfileError('invalid');
  const request = input as WorkingProfileRequest;
  if (request.id !== null && (typeof request.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.id))) throw new WorkingProfileError('invalid');
  return { id: request.id, expected: validateInterfacePreferences(request.expected), notifications: validateProfileNotifications(request.notifications) };
}
/** Useful for storage adapters and tests; exported snapshots never dump arbitrary keys. */
export { captureInterfacePreferences };
