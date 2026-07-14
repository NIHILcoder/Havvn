/**
 * Palette generation — the theme editor's "magic" helpers.
 *
 *  - generatePalette(accent, bg, mode): fan a whole coherent surface/text/border
 *    palette out of just an accent + a background color, so a user can seed a
 *    theme from two picks. Text/border lightness is chosen for readable contrast
 *    against the background; the accent group reuses deriveAccent().
 *  - adaptVariant(tokens): build the opposite mode from an existing one by
 *    inverting the lightness of each color token (hue + saturation preserved),
 *    keeping the accent as-is. "Light from dark" / "dark from light".
 *
 * Pure (no DOM/Node) and unit tested. NOT a trust boundary: the maps returned
 * here are still run through sanitizeTokenValue when the editor applies or saves
 * them, exactly like a hand-typed value.
 */
import { parseColor, rgbToHsl, hslToRgb, toHex, toRgbString, toTriplet } from './color';
import { relativeLuminance } from './contrast';
import { deriveAccent, tokenCategory } from './theme';

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export interface PaletteInput { accent: string; bg: string; }

/**
 * Derive a coherent partial palette (backgrounds, text, borders, accent) from an
 * accent + background color. The light/dark direction is taken from the
 * background's own lightness, so the caller doesn't pass a mode. Returned tokens
 * are overrides layered on the base theme; everything else falls back to it.
 */
export function generatePalette({ accent, bg }: PaletteInput): Record<string, string> {
  const bgRgba = parseColor(bg);
  const accentRgba = parseColor(accent);
  if (!bgRgba || !accentRgba) return {};

  const bgHsl = rgbToHsl(bgRgba);
  const h = bgHsl.h;
  const s = Math.min(bgHsl.s, 12); // tinted neutral — nicer than pure gray
  const bgL = bgHsl.l;
  const surf = (l: number): string => toHex(hslToRgb({ h, s, l: clamp(l, 0, 100), a: 1 }));
  // Surfaces + borders follow the background's own lightness (lighter panels on a
  // dark page, darker on a light page).
  const darkBg = bgL < 50;

  const out: Record<string, string> = {};
  out['--color-bg-primary'] = toHex({ ...bgRgba, a: 1 });

  if (darkBg) {
    out['--color-bg-secondary'] = surf(bgL + 3);
    out['--color-bg-tertiary'] = surf(bgL + 6);
    out['--color-bg-elevated'] = surf(bgL + 8);
    out['--color-bg-hover'] = surf(bgL + 5);
    out['--color-bg-active'] = surf(bgL + 9);
    out['--color-border-default'] = surf(bgL + 16);
    out['--color-border-subtle'] = surf(bgL + 10);
    out['--color-border-strong'] = surf(bgL + 26);
  } else {
    out['--color-bg-secondary'] = surf(bgL - 3);
    out['--color-bg-tertiary'] = surf(bgL - 6);
    // Raise the elevated surface above the page, but on a near-white seed there is
    // no headroom above → drop it slightly instead, so cards never collapse onto
    // the page.
    out['--color-bg-elevated'] = surf(bgL <= 97 ? Math.min(bgL + 3, 100) : bgL - 3);
    out['--color-bg-hover'] = surf(bgL - 4);
    out['--color-bg-active'] = surf(bgL - 8);
    out['--color-border-default'] = surf(bgL - 14);
    out['--color-border-subtle'] = surf(bgL - 7);
    out['--color-border-strong'] = surf(bgL - 24);
  }

  // Text direction is chosen for MAX contrast against the background, not the
  // surface direction — a mid-tone page needs whichever of near-black / near-white
  // reads best (crossover is ~0.18 relative luminance). Uses extreme lightness so
  // primary text clears WCAG AA even on mid-grays.
  const lightText = relativeLuminance(bgRgba) < 0.18;
  if (lightText) {
    out['--color-text-primary'] = surf(96);
    out['--color-text-secondary'] = surf(76);
    out['--color-text-tertiary'] = surf(60);
    out['--color-text-disabled'] = surf(46);
  } else {
    out['--color-text-primary'] = surf(7);
    out['--color-text-secondary'] = surf(30);
    out['--color-text-tertiary'] = surf(45);
    out['--color-text-disabled'] = surf(60);
  }

  Object.assign(out, deriveAccent(toHex({ ...accentRgba, a: 1 })) ?? {});
  return out;
}

/**
 * Build the opposite-mode palette from one mode's token map: invert the
 * lightness of each color value (hue + saturation kept), carry non-color tokens
 * over unchanged, and preserve the accent group (so the brand color survives the
 * flip). Alpha is preserved.
 */
export function adaptVariant(tokens: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    const isAccent = key.startsWith('--color-accent');
    const cat = tokenCategory(key);

    if (isAccent || (cat !== 'color' && cat !== 'colorTriplet')) {
      out[key] = value; // preserve accent + all non-color tokens verbatim
      continue;
    }
    const p = parseColor(value);
    if (!p) { out[key] = value; continue; }
    const hsl = rgbToHsl(p);
    const flipped = hslToRgb({ h: hsl.h, s: hsl.s, l: 100 - hsl.l, a: 1 });
    if (cat === 'colorTriplet') out[key] = toTriplet(flipped);
    else out[key] = p.a < 1 ? toRgbString({ ...flipped, a: p.a }) : toHex(flipped);
  }
  return out;
}
