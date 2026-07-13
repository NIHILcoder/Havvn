/**
 * Level-1 appearance overlays — accent color + font family.
 *
 * These are lightweight overrides layered on whichever base theme
 * (system/dark/light) is active, in the exact spirit of the reduceMotion /
 * density prefs: write inline custom properties on <html> and mirror the choice
 * in localStorage; App.tsx re-applies them on boot. An inline `setProperty` on
 * :root beats the `[data-theme=…]` selector blocks, so the override wins in both
 * light and dark without touching the stylesheet.
 *
 * The full theme editor (a proper Theme with its own `base`) is a separate,
 * richer path; these two knobs stay deliberately simple.
 */
import { deriveAccent, FONT_OPTIONS } from '../../shared/theme';

const ACCENT_KEY = 'accentColor';
const FONT_KEY = 'fontChoice';

/** Fallback the picker shows before the user has ever set an accent. */
export const DEFAULT_FONT_ID = 'inter';

/** The accent tokens deriveAccent produces — cleared together on reset. */
const ACCENT_TOKENS = [
  '--color-accent-primary',
  '--color-accent-primary-hover',
  '--color-accent-bg',
  '--color-accent-rgb',
];

const readPref = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const writePref = (key: string, value: string | null): void => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* cosmetic */ }
};

const rootStyle = (): CSSStyleDeclaration => document.documentElement.style;

/** The current accent hex — the persisted override, else the theme's own value. */
export function currentAccent(): string {
  const saved = readPref(ACCENT_KEY);
  if (saved) return saved;
  // Guard for SSR / no-DOM render paths (e.g. renderToStaticMarkup in tests).
  try {
    if (typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
      const computed = getComputedStyle(document.documentElement).getPropertyValue('--color-accent-primary').trim();
      if (/^#[0-9a-f]{6}$/i.test(computed)) return computed;
    }
  } catch { /* no DOM — fall through to the default */ }
  return '#F2913F';
}

/** Apply an accent hex live (no persistence). Returns false for an unparseable color. */
export function applyAccent(hex: string): boolean {
  const derived = deriveAccent(hex);
  if (!derived) return false;
  const s = rootStyle();
  for (const [token, value] of Object.entries(derived)) s.setProperty(token, value);
  return true;
}

/** Drop the accent override, reverting to the base theme's accent. */
export function clearAccent(): void {
  const s = rootStyle();
  for (const token of ACCENT_TOKENS) s.removeProperty(token);
}

/** Set + persist (hex) or reset + forget (null) the accent override. */
export function setAccentPref(hex: string | null): void {
  if (hex && applyAccent(hex)) writePref(ACCENT_KEY, hex);
  else { clearAccent(); writePref(ACCENT_KEY, null); }
}

export function hasAccentOverride(): boolean {
  return readPref(ACCENT_KEY) !== null;
}

const fontStack = (id: string): string | undefined => FONT_OPTIONS.find((o) => o.id === id)?.stack;

/** Current font choice id (defaults to the bundled Inter). */
export function currentFontId(): string {
  return readPref(FONT_KEY) || DEFAULT_FONT_ID;
}

/** Apply a font choice live (no persistence). Returns false for an unknown id. */
export function applyFont(id: string): boolean {
  const stack = fontStack(id);
  if (!stack) return false;
  rootStyle().setProperty('--font-family', stack);
  return true;
}

/** Set + persist the font choice. Inter is the built-in default, so it clears the override. */
export function setFontPref(id: string): void {
  if (id === DEFAULT_FONT_ID) {
    rootStyle().removeProperty('--font-family');
    writePref(FONT_KEY, null);
  } else if (applyFont(id)) {
    writePref(FONT_KEY, id);
  }
}

/** Boot restore — call once alongside the other appearance prefs in App.tsx. */
export function restoreThemePrefs(): void {
  const accent = readPref(ACCENT_KEY);
  if (accent) applyAccent(accent);
  const font = readPref(FONT_KEY);
  if (font) applyFont(font);
}
