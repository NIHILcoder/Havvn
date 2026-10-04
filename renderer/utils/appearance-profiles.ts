import { validateAppearanceProfile, type AppearanceProfile } from '../../shared/appearance-profile';
import { readEffectiveAppearance, saveAppearance } from './appearance';
import { getActiveTheme, loadLibrary, saveLibrary, activateTheme, deactivateTheme } from './theme-library';
import { setAccentPref, setFontPref, currentFontId } from './theme-prefs';
const KEY = 'havvn.appearance.profiles.v1';
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
}
export function removeAppearanceProfile(name: string): void {
  localStorage.setItem(KEY, JSON.stringify(loadAppearanceProfiles().filter(p => p.name !== name)));
}
export async function applyAppearanceProfile(profile: AppearanceProfile): Promise<void> {
  const p = validateAppearanceProfile(profile);
  if (!p) throw new Error('Invalid profile');
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
}
