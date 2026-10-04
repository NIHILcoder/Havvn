/** Cosmetic preferences are separate from palette tokens: no executable CSS or remote assets. */
export const APPEARANCE_VERSION = 1;
export const MAX_WALLPAPER_LENGTH = 2_800_000;
export const APPEARANCE_SCOPES = ['sidebar', 'header', 'menus', 'dialogs', 'panels', 'player'] as const;
export type AppearanceScope = typeof APPEARANCE_SCOPES[number];
export interface Appearance {
  version: 1;
  material: 'solid' | 'frosted' | 'liquid';
  acrylic: boolean;
  intensity: number;
  opacity: number;
  blur: number;
  tint: number;
  highlight: number;
  depth: number;
  quality: 'full' | 'light';
  motion: boolean;
  scopes: AppearanceScope[];
  background: 'none' | 'aurora' | 'aero' | 'sunset' | 'image';
  wallpaper: string;
  backgroundDim: number;
  radii: { panels: number | null; cards: number | null; buttons: number | null; inputs: number | null };
}
export interface AcrylicStatus {
  enabled: boolean;
  active: boolean;
  reason: 'off' | 'active' | 'unsupported' | 'failed';
}
export const DEFAULT_APPEARANCE: Appearance = {
  version: 1, material: 'solid', acrylic: false, intensity: 55,
  opacity: 78, blur: 22, tint: 8, highlight: 35, depth: 25,
  quality: 'full', motion: true, scopes: [...APPEARANCE_SCOPES],
  background: 'none', wallpaper: '', backgroundDim: 30,
  radii: { panels: null, cards: null, buttons: null, inputs: null },
};
/** Portable theme material; native window composition and wallpaper stay local. */
export type ThemeGlass = Pick<Appearance, 'material' | 'intensity' | 'opacity' | 'blur' | 'tint' |
  'highlight' | 'depth' | 'quality' | 'motion' | 'scopes' | 'radii'>;
const GLASS_KEYS = ['material', 'intensity', 'opacity', 'blur', 'tint', 'highlight', 'depth',
  'quality', 'motion', 'scopes', 'radii'] as const;
export function getThemeGlass(p: Appearance): ThemeGlass {
  const { material, intensity, opacity, blur, tint, highlight, depth, quality, motion, scopes, radii } = p;
  return { material, intensity, opacity, blur, tint, highlight, depth, quality, motion, scopes: [...scopes], radii: { ...radii } };
}
export function validateThemeGlass(value: unknown): ThemeGlass | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== GLASS_KEYS.length || !GLASS_KEYS.every(key => Object.prototype.hasOwnProperty.call(v, key))) return null;
  const appearance = validateAppearance({ ...DEFAULT_APPEARANCE, ...v });
  return appearance ? getThemeGlass(appearance) : null;
}
/** Only self-contained raster images. A quote, SVG, URL or CSS payload never reaches url(). */
let lastValidWallpaper = '';
export function validWallpaper(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_WALLPAPER_LENGTH) return false;
  if (value === '' || value === lastValidWallpaper) return true;
  if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    lastValidWallpaper = value; return true;
  }
  return false;
}
const ranges = { intensity: [0, 100], opacity: [45, 98], blur: [0, 40], tint: [0, 25],
  highlight: [0, 100], depth: [0, 100], backgroundDim: [0, 85] } as const;
/** Strict at import/storage boundaries; invalid settings fall back as a unit. */
export function validateAppearance(value: unknown): Appearance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !Object.prototype.hasOwnProperty.call(DEFAULT_APPEARANCE, key)) || v.version !== 1 ||
      typeof v.material !== 'string' || !['solid', 'frosted', 'liquid'].includes(v.material) ||
      typeof v.quality !== 'string' || !['full', 'light'].includes(v.quality) ||
      typeof v.background !== 'string' || !['none', 'aurora', 'aero', 'sunset', 'image'].includes(v.background) ||
      typeof v.acrylic !== 'boolean' || typeof v.motion !== 'boolean' || !validWallpaper(v.wallpaper) ||
      !Array.isArray(v.scopes) || v.scopes.length > APPEARANCE_SCOPES.length ||
      v.scopes.some(scope => !APPEARANCE_SCOPES.includes(scope)) || new Set(v.scopes).size !== v.scopes.length) return null;
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) return null;
  }
  if (!v.radii || typeof v.radii !== 'object' || Array.isArray(v.radii)) return null;
  const radii = v.radii as Record<string, unknown>;
  if (Object.keys(radii).length !== 4 || !['panels', 'cards', 'buttons', 'inputs'].every(key =>
    key in radii && (radii[key] === null || (typeof radii[key] === 'number' && Number.isFinite(radii[key]) &&
      (radii[key] as number) >= 0 && (radii[key] as number) <= 32)))) return null;
  if (v.background === 'image' && !v.wallpaper) return null;
  return { ...v, scopes: [...v.scopes], radii: { ...radii } } as unknown as Appearance;
}
export const APPEARANCE_PRESETS: Record<string, Appearance> = {
  minimal: { ...DEFAULT_APPEARANCE, scopes: [...APPEARANCE_SCOPES] },
  frosted: { ...DEFAULT_APPEARANCE, material: 'frosted', opacity: 86, blur: 28, intensity: 45, scopes: [...APPEARANCE_SCOPES] },
  liquid: { ...DEFAULT_APPEARANCE, material: 'liquid', background: 'aurora', opacity: 70, highlight: 65,
    intensity: 70, depth: 45, scopes: [...APPEARANCE_SCOPES] },
  aero: { ...DEFAULT_APPEARANCE, material: 'liquid', background: 'aero', opacity: 74, highlight: 80,
    tint: 14, intensity: 75, depth: 35, scopes: [...APPEARANCE_SCOPES] },
};
export const APPEARANCE_MIRROR_ATTRS = ['data-material', 'data-acrylic', 'data-glass-scopes', 'data-glass-quality',
  'data-glass-motion', 'data-app-background', 'data-radius-overrides'] as const;
export function supportsAcrylic(platform: string, release: string): boolean {
  const parts = release.split('.').map(Number);
  return platform === 'win32' && parts.length >= 3 && parts.every(Number.isFinite) &&
    (parts[0] > 10 || (parts[0] === 10 && parts[2] >= 22621));
}
