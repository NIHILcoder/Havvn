/**
 * WCAG contrast — pure luminance + ratio + level, for the theme editor's
 * readability checker. Given two resolved token colors (text on background) it
 * reports the contrast ratio and the AA/AAA/fail level, so the editor can warn
 * when a custom palette makes text unreadable.
 *
 * No DOM/Node imports (shares the color parser with color.ts) and unit tested.
 */
import { parseColor, Rgba } from './color';

/** sRGB channel (0-1) → linear light. */
function toLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an opaque rgb. */
export function relativeLuminance({ r, g, b }: Rgba): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Alpha-composite `fg` over opaque `bg` (straight alpha). */
export function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

export type WcagLevel = 'AAA' | 'AA' | 'AA-large' | 'fail';

const WHITE = { r: 255, g: 255, b: 255, a: 1 };

/**
 * Contrast ratio between a foreground and background color string (1..21), or
 * null if either can't be parsed. A translucent foreground is composited over
 * the (resolved) background; a translucent background is composited over `base`
 * — the surface it actually sits on. `base` defaults to white, so callers that
 * know the real page surface (e.g. a dark theme's --color-bg-primary) should
 * pass it, or a frosted/translucent surface on a dark theme reads as failing
 * when it is in fact fine.
 */
export function contrastRatio(fg: string, bg: string, base?: string): number | null {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return null;
  const parsedBase = (base ? parseColor(base) : null) ?? WHITE;
  const baseSolid = parsedBase.a < 1 ? compositeOver(parsedBase, WHITE) : parsedBase;
  const bgSolid = b.a < 1 ? compositeOver(b, baseSolid) : b;
  const fgSolid = f.a < 1 ? compositeOver(f, bgSolid) : f;
  const l1 = relativeLuminance(fgSolid);
  const l2 = relativeLuminance(bgSolid);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Classify a ratio against WCAG 2.1 thresholds (normal-weight body text). */
export function wcagLevel(ratio: number): WcagLevel {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA-large';
  return 'fail';
}
