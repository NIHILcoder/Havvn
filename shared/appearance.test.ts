import { describe, it, expect } from 'vitest';
import { DEFAULT_APPEARANCE, APPEARANCE_PRESETS, validateAppearance, validWallpaper, supportsAcrylic, MAX_WALLPAPER_LENGTH, getThemeGlass, validateThemeGlass } from './appearance';
import { validateTheme } from './theme';
import { validateAppearanceProfile } from './appearance-profile';
describe('appearance boundaries', () => {
  it('round-trips portable glass in a theme without native settings or wallpaper', () => {
    const glass = getThemeGlass(APPEARANCE_PRESETS.liquid);
    const input = { id: 'glass', name: 'Glass', dark: {}, light: {}, glass };
    expect(validateTheme(JSON.parse(JSON.stringify(input)))).toEqual({ ok: true, theme: input, warnings: [] });
    const cloned = validateThemeGlass(glass)!;
    cloned.scopes.pop(); cloned.radii.cards = 17;
    expect(cloned).not.toEqual(glass);
    for (const patch of [{ acrylic: true }, { wallpaper: 'data:image/png;base64,YQ==' }, { blur: 41 },
      { opacity: NaN }, { material: { toString: 5 } }, { scopes: ['sidebar', 'sidebar'] },
      { radii: { ...glass.radii, cards: -1 } }, { motion: undefined }]) {
      expect(validateTheme({ ...input, glass: { ...glass, ...patch } }).ok).toBe(false);
    }
    const legacy = { id: 'old', name: 'Old', dark: {}, light: {} };
    expect(validateTheme(legacy)).toEqual({ ok: true, theme: legacy, warnings: [] });
  });
  it('accepts complete presets without changing palette tokens', () => {
    for (const preset of Object.values(APPEARANCE_PRESETS)) expect(validateAppearance(preset)).toEqual(preset);
    const p = validateAppearance(DEFAULT_APPEARANCE)!;
    p.scopes.pop(); p.radii.cards = 12;
    expect(DEFAULT_APPEARANCE.scopes).toHaveLength(6); expect(DEFAULT_APPEARANCE.radii.cards).toBeNull();
  });
  it('rejects non-finite values, missing settings and unsupported enums', () => {
    for (const patch of [{ intensity: NaN }, { opacity: 0 }, { blur: 41 }, { acrylic: 'yes' }, { scopes: ['sidebar', 'sidebar'] },
      { quality: 'ultra' }, { background: 'url(https://example.org)' }, { version: 2 }, { radii: { ...DEFAULT_APPEARANCE.radii, cards: -1 } },
      { scopes: ['video'] }, { constructor: 'unexpected' }, { material: undefined }]) {
      expect(validateAppearance({ ...DEFAULT_APPEARANCE, ...patch })).toBeNull();
    }
  });
  it('allows only bounded, self-contained raster image payloads', () => {
    expect(validWallpaper('data:image/png;base64,aGVsbG8=')).toBe(true);
    expect(validWallpaper('')).toBe(true); // removing an image after a cached validation
    expect(validateAppearance(DEFAULT_APPEARANCE)).not.toBeNull();
    for (const image of ['https://example.org/bg.png','data:image/svg+xml;base64,aGVsbG8=',
      'data:image/png;base64,aGVsbG8=");color:red;/*', 'data:image/png;base64,' + 'A'.repeat(MAX_WALLPAPER_LENGTH)]) {
      expect(validWallpaper(image)).toBe(false);
    }
    expect(validateAppearance({ ...DEFAULT_APPEARANCE, background: 'image' })).toBeNull();
  });
  it('gates native Acrylic at Windows 11 22H2, not Windows 10 or other systems', () => {
    expect(supportsAcrylic('win32','10.0.22621')).toBe(true);
    expect(supportsAcrylic('win32','10.0.26100')).toBe(true);
    for (const [platform, release] of [['win32','10.0.22000'], ['win32','10.0.19045'], ['win32','junk'], ['darwin','24.0.0'], ['linux','6.12.0']]) {
      expect(supportsAcrylic(platform,release)).toBe(false);
    }
  });
});
describe('appearance profile import', () => {
  const profile = { version: 1, name: 'My Aero', appearance: DEFAULT_APPEARANCE, theme: null,
    mode: 'system', accent: null, font: 'inter', density: 'normal', reduceMotion: false };
  it('accepts a full profile and rejects untrusted CSS or settings', () => {
    expect(validateAppearanceProfile(profile)).toEqual(profile);
    for (const patch of [{ name: '' }, { font: 'url(evil)' }, { accent: 'red;background:url(evil)' },
      { theme: { id: 'evil', name: 'evil', dark: { '--color-bg-primary': 'url(evil)' }, light: {} } },
      { appearance: { ...DEFAULT_APPEARANCE, wallpaper: 'file:///private.png' } }, { mode: 'unknown' }]) {
      expect(validateAppearanceProfile({ ...profile, ...patch })).toBeNull();
    }
  });
});
