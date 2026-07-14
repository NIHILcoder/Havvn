/**
 * Pure color parsing + conversion for the theme editor's smart color controls.
 *
 * The editor needs to (a) parse any token color value the user or an import can
 * produce — hex (3/4/6/8), rgb()/rgba(), hsl()/hsla(), a bare "r, g, b" triplet,
 * or a named color — into rgba, (b) drive HSL + alpha sliders off it, and (c)
 * emit a clean value back. It shares this parser with the WCAG contrast checker
 * (contrast.ts), so it lives in shared/ with no DOM/Node imports and is unit
 * tested. It is NOT a trust boundary: every value the editor emits is still run
 * through sanitizeTokenValue before it can touch the DOM or be saved.
 */

/** r,g,b in 0-255; a in 0-1. */
export interface Rgba { r: number; g: number; b: number; a: number; }
/** h in 0-360; s,l in 0-100; a in 0-1. */
export interface Hsla { h: number; s: number; l: number; a: number; }

const NAMED: Record<string, [number, number, number]> = {
  white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  orange: [255, 165, 0], yellow: [255, 255, 0], purple: [128, 0, 128], teal: [0, 128, 128],
  navy: [0, 0, 128],
};

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const round = (n: number): number => Math.round(n);

/** Parse one rgb/hsl component: a plain number, a percentage, or (for hue) an angle. */
function num(token: string): number | null {
  const m = /^-?(\d+\.?\d*|\.\d+)$/.exec(token);
  return m ? parseFloat(token) : null;
}
function pctOrNum(token: string, pctBase: number): number | null {
  if (token.endsWith('%')) {
    const n = num(token.slice(0, -1));
    return n === null ? null : (n / 100) * pctBase;
  }
  return num(token);
}
/** Alpha may be 0-1 or a percentage. Absent → 1; present-but-malformed → null. */
function parseAlpha(token: string | undefined): number | null {
  if (token === undefined) return 1;
  if (token.endsWith('%')) { const n = num(token.slice(0, -1)); return n === null ? null : clamp(n / 100, 0, 1); }
  const n = num(token);
  return n === null ? null : clamp(n, 0, 1);
}

function parseHex(v: string): Rgba | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

/** Split the inside of a color function on commas / whitespace / slashes. */
function parts(inner: string): string[] {
  return inner.trim().split(/[\s,/]+/).filter(Boolean);
}

/**
 * Parse any supported color string to rgba, or null. Accepts a bare "r, g, b"
 * triplet too (the shape the `--*-rgb` tokens store).
 */
export function parseColor(input: string): Rgba | null {
  const v = input.trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  // hasOwnProperty guard: a bare `NAMED[lower]` would find inherited members like
  // "constructor"/"__proto__" (truthy) and then throw destructuring a function.
  if (Object.prototype.hasOwnProperty.call(NAMED, lower)) { const [r, g, b] = NAMED[lower]; return { r, g, b, a: 1 }; }
  if (v[0] === '#') return parseHex(v);

  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(v);
  if (fn) {
    const kind = fn[1].toLowerCase();
    const p = parts(fn[2]);
    if (p.length < 3) return null;
    const a = parseAlpha(p[3]);
    if (a === null) return null; // present-but-malformed alpha rejects the whole color
    if (kind.startsWith('rgb')) {
      const r = pctOrNum(p[0], 255), g = pctOrNum(p[1], 255), b = pctOrNum(p[2], 255);
      if (r === null || g === null || b === null) return null;
      return { r: clamp(round(r), 0, 255), g: clamp(round(g), 0, 255), b: clamp(round(b), 0, 255), a };
    }
    // hsl
    const h = num(p[0]);
    const s = p[1].endsWith('%') ? num(p[1].slice(0, -1)) : num(p[1]);
    const l = p[2].endsWith('%') ? num(p[2].slice(0, -1)) : num(p[2]);
    if (h === null || s === null || l === null) return null;
    const rgb = hslToRgb({ h, s: clamp(s, 0, 100), l: clamp(l, 0, 100), a: 1 });
    return { ...rgb, a };
  }

  // Bare triplet "r, g, b" (the --*-rgb token shape).
  const trip = parts(v);
  if (trip.length === 3) {
    const r = num(trip[0]), g = num(trip[1]), b = num(trip[2]);
    if (r !== null && g !== null && b !== null && [r, g, b].every((n) => n >= 0 && n <= 255)) {
      return { r: round(r), g: round(g), b: round(b), a: 1 };
    }
  }
  return null;
}

/** rgb (0-255) → hsl (h 0-360, s/l 0-100), alpha carried through. */
export function rgbToHsl({ r, g, b, a }: Rgba): Hsla {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case rn: h = ((gn - bn) / d) % 6; break;
      case gn: h = (bn - rn) / d + 2; break;
      default: h = (rn - gn) / d + 4; break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: round(h), s: round(clamp(s * 100, 0, 100)), l: round(clamp(l * 100, 0, 100)), a };
}

/** hsl (h 0-360, s/l 0-100) → rgb (0-255), alpha carried through. */
export function hslToRgb({ h, s, l, a }: Hsla): Rgba {
  const hn = ((h % 360) + 360) % 360;
  const sn = clamp(s, 0, 100) / 100;
  const ln = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hn < 60) { rp = c; gp = x; }
  else if (hn < 120) { rp = x; gp = c; }
  else if (hn < 180) { gp = c; bp = x; }
  else if (hn < 240) { gp = x; bp = c; }
  else if (hn < 300) { rp = x; bp = c; }
  else { rp = c; bp = x; }
  return { r: round((rp + m) * 255), g: round((gp + m) * 255), b: round((bp + m) * 255), a: a ?? 1 };
}

const hex2 = (n: number): string => clamp(round(n), 0, 255).toString(16).padStart(2, '0');

/** #rrggbb (or #rrggbbaa when alpha < 1 and includeAlpha). */
export function toHex({ r, g, b, a }: Rgba, includeAlpha = false): string {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return includeAlpha && a < 1 ? `${base}${hex2(a * 255)}` : base;
}

/** "r, g, b" / "rgba(r, g, b, a)" — rounded, compact. */
export function toRgbString({ r, g, b, a }: Rgba): string {
  const R = clamp(round(r), 0, 255), G = clamp(round(g), 0, 255), B = clamp(round(b), 0, 255);
  if (a >= 1) return `rgb(${R}, ${G}, ${B})`;
  return `rgba(${R}, ${G}, ${B}, ${Number(a.toFixed(3))})`;
}

/** Bare "r, g, b" triplet (the --*-rgb token shape). */
export function toTriplet({ r, g, b }: Rgba): string {
  return `${clamp(round(r), 0, 255)}, ${clamp(round(g), 0, 255)}, ${clamp(round(b), 0, 255)}`;
}
