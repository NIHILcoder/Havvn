import { validateAppearance, type Appearance } from './appearance';
import { validateTheme, FONT_OPTIONS, type Theme } from './theme';
export interface AppearanceProfile {
  version: 1;
  name: string;
  appearance: Appearance;
  theme: Theme | null;
  mode: 'dark' | 'light' | 'system';
  accent: string | null;
  font: string;
  density: 'normal' | 'compact';
  reduceMotion: boolean;
}
export function validateAppearanceProfile(input: unknown): AppearanceProfile | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const p = input as AppearanceProfile;
  if (Object.keys(p).some(key => !['version', 'name', 'appearance', 'theme', 'mode', 'accent', 'font', 'density', 'reduceMotion'].includes(key)) ||
      p.version !== 1 || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60 ||
      !['dark', 'light', 'system'].includes(p.mode) || !['normal', 'compact'].includes(p.density) ||
      typeof p.reduceMotion !== 'boolean' || !FONT_OPTIONS.some(font => font.id === p.font) ||
      !(p.accent === null || (typeof p.accent === 'string' && /^#[0-9a-f]{6}$/i.test(p.accent)))) return null;
  const appearance = validateAppearance(p.appearance);
  if (!appearance) return null;
  let theme: Theme | null = null;
  if (p.theme !== null) {
    const validated = validateTheme(p.theme);
    if (!validated.ok || validated.warnings.length > 0) return null;
    theme = validated.theme;
  }
  return { ...p, name: p.name.trim(), appearance, theme };
}
