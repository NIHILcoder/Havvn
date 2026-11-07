import { validateAppearanceProfile, type AppearanceProfile } from '../../shared/appearance-profile';
import { readEffectiveAppearance, saveAppearance } from './appearance';
import { getActiveTheme, loadLibrary, saveLibrary, activateTheme, deactivateTheme } from './theme-library';
import { setAccentPref, setFontPref, currentFontId } from './theme-prefs';
import { DEFAULT_APPEARANCE } from '../../shared/appearance';
const KEY = 'havvn.appearance.profiles.v1';
const PREVIOUS_KEY = 'havvn.appearance.previous.v1';
let previousAppearance: AppearanceProfile | null | undefined;
export const APPEARANCE_PROFILES_EVENT = 'havvn:appearance-profiles';
export function loadPreviousAppearanceProfile(): AppearanceProfile | null {
  if (previousAppearance !== undefined) return previousAppearance;
  try { return validateAppearanceProfile(JSON.parse(localStorage.getItem(PREVIOUS_KEY) || 'null')); }
  catch { return null; }
}
function rememberAppearance(profile: AppearanceProfile | null): void {
  previousAppearance = profile;
  try {
    if (profile) localStorage.setItem(PREVIOUS_KEY, JSON.stringify(profile));
    else localStorage.removeItem(PREVIOUS_KEY);
  } catch {
    // A large wallpaper must not prevent changing themes. Keep undo in memory
    // for this session if the persistent storage quota is already exhausted.
    try { localStorage.removeItem(PREVIOUS_KEY); } catch { /* storage unavailable */ }
  }
  window.dispatchEvent(new Event(APPEARANCE_PROFILES_EVENT));
}
export function standardAppearanceProfile(): AppearanceProfile {
  return { version: 1, name: 'Havvn', appearance: structuredClone(DEFAULT_APPEARANCE), theme: null,
    mode: 'system', accent: null, font: 'inter',
    density: localStorage.getItem('density') === 'compact' ? 'compact' : 'normal',
    reduceMotion: localStorage.getItem('reduceMotion') === '1' };
}
export async function restorePreviousAppearanceProfile(): Promise<AppearanceProfile | null> {
  const profile = loadPreviousAppearanceProfile();
  if (!profile) return null;
  await applyAppearanceProfile(profile, false);
  rememberAppearance(null);
  return profile;
}
export function loadAppearanceProfiles(): AppearanceProfile[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, 8).map(validateAppearanceProfile).filter((p): p is AppearanceProfile => !!p) : [];
  } catch { return []; }
}
export function captureAppearanceProfile(name: string): AppearanceProfile {
  const mode = localStorage.getItem('theme');
  const p = validateAppearanceProfile({ version: 1, name, appearance: readEffectiveAppearance(), theme: getActiveTheme(),
    mode: mode === 'light' || mode === 'dark' ? mode : 'system', accent: localStorage.getItem('accentColor'),
    font: currentFontId(), density: localStorage.getItem('density') === 'compact' ? 'compact' : 'normal',
    reduceMotion: localStorage.getItem('reduceMotion') === '1' });
  if (!p) throw new Error('Invalid profile');
  return p;
}
export function saveAppearanceProfile(p: AppearanceProfile): void {
  const valid = validateAppearanceProfile(p);
  if (!valid) throw new Error('Invalid profile');
  const profiles = loadAppearanceProfiles().filter(item => item.name !== valid.name);
  if (profiles.length >= 8) throw new Error('Profile limit');
  localStorage.setItem(KEY, JSON.stringify([...profiles, valid]));
  window.dispatchEvent(new Event(APPEARANCE_PROFILES_EVENT));
}
export function removeAppearanceProfile(name: string): void {
  localStorage.setItem(KEY, JSON.stringify(loadAppearanceProfiles().filter(p => p.name !== name)));
  window.dispatchEvent(new Event(APPEARANCE_PROFILES_EVENT));
}
export async function applyAppearanceProfile(profile: AppearanceProfile, rememberPrevious = true): Promise<void> {
  const p = validateAppearanceProfile(profile);
  if (!p) throw new Error('Invalid profile');
  const previous = rememberPrevious ? captureAppearanceProfile('Previous appearance') : null;
  await saveAppearance(p.appearance);
  localStorage.setItem('theme', p.mode);
  // Clear quick overrides before painting the palette, otherwise clearing an
  // old accent also removes that token from the newly activated custom theme.
  setAccentPref(p.accent); setFontPref(p.font);
  if (p.theme) {
    // Imported profiles cannot overwrite an existing palette with the same ID.
    const theme = { ...p.theme, id: `profile-${crypto.randomUUID()}` };
    const library = loadLibrary();
    const identical = library.find(t => t.name === theme.name && JSON.stringify(t.dark) === JSON.stringify(theme.dark) &&
      JSON.stringify(t.light) === JSON.stringify(theme.light) && t.fontData === theme.fontData && t.font === theme.font &&
      JSON.stringify(t.glass) === JSON.stringify(theme.glass));
    if (!identical) {
      saveLibrary([...library, theme]);
      if (!loadLibrary().some(saved => saved.id === theme.id)) throw new Error('Theme storage is full');
    }
    activateTheme(identical || theme);
    if (getActiveTheme()?.id !== (identical || theme).id) throw new Error('Theme activation was not saved');
  } else deactivateTheme();
  localStorage.setItem('density', p.density); localStorage.setItem('reduceMotion', p.reduceMotion ? '1' : '0');
  const root = document.documentElement;
  if (p.density === 'compact') root.dataset.density = 'compact'; else delete root.dataset.density;
  if (p.reduceMotion) root.dataset.reduceMotion = 'true'; else delete root.dataset.reduceMotion;
  if (previous) rememberAppearance(previous);
}
