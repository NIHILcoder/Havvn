/**
 * Custom themes — the trust boundary for user-authored and *imported* themes.
 *
 * A theme is a JSON token map layered over a built-in base (dark/light). It is
 * applied by writing each token with `documentElement.style.setProperty` — never
 * by injecting a CSS string — so there is no stylesheet-parse surface and the
 * strict production CSP (`script-src 'self'`, `connect-src 'self'`,
 * `font-src 'self' data:`) stays intact.
 *
 * The one real malicious-theme vector is a *value* that phones home or breaks
 * out — e.g. `background-image: url(https://evil/beacon)` reached through a
 * tokenized `var(--…)`. None of the 122 whitelisted tokens legitimately needs
 * `url()`, `@import`, `expression()`, `var()`, `javascript:` or CSS-breakout
 * punctuation, so every value is run through a global blocklist and then a
 * per-category shape check. Anything that does not match is dropped.
 *
 * This module is pure (no Node/Electron/DOM-global imports) so the renderer, the
 * IPC import path in main, and vitest all use the exact same validator.
 */

export type ThemeBase = 'dark' | 'light';
/** Which palette variant is showing — follows the app's dark/light/system mode. */
export type ThemeMode = ThemeBase;

/**
 * A custom theme carries a full palette for BOTH modes; the active variant
 * follows the app's dark/light/system selection (so one theme can paint dark
 * and light independently, like the built-in Ember). Either map may be empty —
 * that mode then falls back to the built-in palette.
 */
export interface Theme {
  id: string;
  name: string;
  /** Whitelisted `--token` → sanitized value overrides for dark mode. */
  dark: Record<string, string>;
  /** …and for light mode. */
  light: Record<string, string>;
  /** Optional font stack (applies in both modes); mirror of --font-family. */
  font?: string;
  /**
   * Optional embedded custom font as a self-contained `data:font/…;base64,…`
   * URL. Registered via the FontFace API (never a CSS `url()` in a token), so it
   * stays within `font-src 'self' data:` and carries with an exported theme. The
   * family it defines is the first name in `font`.
   */
  fontData?: string;
}

export type ValidateResult =
  | { ok: true; theme: Theme; warnings: string[] }
  | { ok: false; errors: string[] };

/* ------------------------------------------------------------------ *
 * Token whitelist — the exact 122 custom properties defined in the
 * `:root` block of renderer/styles/variables.css. Grouped only for
 * readability; membership is what matters. Keep in sync if variables.css
 * grows a new token that themes should be allowed to override.
 * ------------------------------------------------------------------ */
const TOKEN_NAMES: readonly string[] = [
  // backgrounds + legacy/compat aliases + glass
  '--color-bg-primary', '--color-bg-secondary', '--color-bg-tertiary',
  '--color-bg-elevated', '--color-bg-hover', '--color-bg-active',
  '--color-bg-base', '--color-bg-subtle',
  '--color-border', '--color-border-hover', '--color-accent',
  '--color-accent-hover', '--color-accent-rgb', '--color-text-muted',
  '--glass-bg', '--glass-border', '--glass-blur',
  // borders
  '--color-border-default', '--color-border-subtle', '--color-border-strong',
  '--color-border-focus',
  // text
  '--color-text-primary', '--color-text-secondary', '--color-text-tertiary',
  '--color-text-disabled',
  // accent
  '--color-accent-primary', '--color-accent-primary-hover', '--color-accent-bg',
  '--color-accent-secondary', '--color-accent-secondary-hover',
  // brand mark (logo is themeable)
  '--color-logo', '--color-logo-outline', '--color-logo-glare',
  // gradients
  '--gradient-primary', '--gradient-success', '--gradient-warning',
  '--gradient-danger', '--gradient-elevated', '--gradient-sidebar',
  '--gradient-card',
  // status
  '--color-status-queued', '--color-status-downloading', '--color-status-paused',
  '--color-status-completed', '--color-status-seeding', '--color-status-error',
  '--color-status-removed', '--color-status-connected', '--color-status-download',
  '--color-status-upload',
  // semantic
  '--color-success', '--color-success-bg', '--color-success-rgb',
  '--color-warning', '--color-warning-bg', '--color-warning-rgb',
  '--color-error', '--color-error-bg', '--color-error-rgb',
  '--color-info', '--color-info-bg', '--color-info-rgb',
  // file-type
  '--color-video', '--color-audio', '--color-image', '--color-archive',
  '--color-document',
  // spacing
  '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6',
  '--space-8', '--space-10', '--space-12', '--space-16',
  // typography
  '--font-family', '--font-family-mono', '--font-primary', '--font-display',
  '--font-size-xs', '--font-size-sm', '--font-size-base', '--font-size-md',
  '--font-size-lg', '--font-size-xl', '--font-size-2xl', '--font-size-3xl',
  '--font-weight-normal', '--font-weight-medium', '--font-weight-semibold',
  '--font-weight-bold',
  '--line-height-tight', '--line-height-normal', '--line-height-relaxed',
  // radius
  '--radius-scale',
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl',
  '--radius-full',
  // shadows
  '--shadow-xs', '--shadow-sm', '--shadow-md', '--shadow-lg', '--shadow-xl',
  '--shadow-glow', '--shadow-glow-sm', '--shadow-focus',
  // transitions
  '--transition-fast', '--transition-normal', '--transition-slow',
  '--transition-spring',
  // layout
  '--sidebar-width', '--sidebar-collapsed-width', '--header-height',
  '--topbar-height', '--footer-height', '--settings-content-max-width',
  // z-index
  '--z-dropdown', '--z-sticky', '--z-modal-backdrop', '--z-modal', '--z-popover',
  '--z-tooltip',
];

export const TOKEN_WHITELIST: ReadonlySet<string> = new Set(TOKEN_NAMES);

/* ------------------------------------------------------------------ *
 * Bounds — cheap denial-of-service and abuse guards.
 * ------------------------------------------------------------------ */
const MAX_VALUE_LEN = 256;
const MAX_TOKENS = 200;
const MAX_NAME_LEN = 60;
const MAX_ID_LEN = 64;
const MAX_FONT_DATA_LEN = 2_000_000; // ~1.5 MB embedded font, base64

/**
 * Validate an embedded-font data URL: `data:<font-mime>;base64,<payload>`, size
 * capped, strict base64. Returned as-is or null. The font is loaded through the
 * FontFace API (not a CSS url()), so this is the only gate it crosses.
 */
export function sanitizeFontData(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > MAX_FONT_DATA_LEN) return null;
  return /^data:(?:font\/(?:woff2|woff|ttf|otf|sfnt)|application\/(?:font-woff|x-font-ttf|octet-stream));base64,[A-Za-z0-9+/]+=*$/.test(v)
    ? v : null;
}

/* ------------------------------------------------------------------ *
 * Value category per token — drives which shape check a value must pass.
 * ------------------------------------------------------------------ */
type ValueCategory =
  | 'color' | 'colorTriplet' | 'gradient' | 'filter' | 'length'
  | 'number' | 'fontWeight' | 'integer' | 'shadow' | 'transition' | 'fontFamily';

/** Classify a whitelisted token by its expected value shape. */
export function tokenCategory(name: string): ValueCategory | null {
  if (name.endsWith('-rgb')) return 'colorTriplet';
  if (name === '--glass-blur') return 'filter';
  if (name.startsWith('--gradient-')) return 'gradient';
  if (name.startsWith('--shadow-')) return 'shadow';
  if (name.startsWith('--transition-')) return 'transition';
  if (name.startsWith('--line-height-')) return 'number';
  if (name.startsWith('--font-weight-')) return 'fontWeight';
  if (name.startsWith('--font-size-')) return 'length';
  if (name === '--font-family' || name === '--font-family-mono' || name === '--font-primary' || name === '--font-display') return 'fontFamily';
  if (name.startsWith('--z-')) return 'integer';
  if (name.startsWith('--space-') || name.startsWith('--radius-')) return 'length';
  if (name.startsWith('--color-') || name === '--glass-bg' || name === '--glass-border') return 'color';
  if (/(width|height)/.test(name)) return 'length';
  return null;
}

/* ------------------------------------------------------------------ *
 * Global blocklist — applied to EVERY value before any shape check.
 * These sequences never appear in a legitimate token value, and each is
 * a known exfiltration / breakout vector, so rejecting them outright is
 * both safe and the cheapest possible defense.
 * ------------------------------------------------------------------ */
const FORBIDDEN_SUBSTRINGS = [
  'url(',        // remote/data fetch — the beacon vector
  '@import',     // pulls a remote stylesheet
  'expression(', // legacy IE script execution
  'javascript:', // scheme-based execution
  'image-set',   // can reference remote images
  'cross-fade',  // ditto
  'element(',    // references live DOM as an image source
  'paint(',      // CSS Houdini paint worklet
  'var(',        // no token value needs indirection; blocks alias abuse
  '/*', '*/',    // CSS comments — no legitimate use here
  '\\',          // escapes could smuggle blocked sequences past a naive scan
];

/** True if the value contains any forbidden sequence, breakout punctuation, or control chars. */
function hasForbiddenSequence(value: string): boolean {
  const lower = value.toLowerCase();
  if (FORBIDDEN_SUBSTRINGS.some((s) => lower.includes(s))) return true;
  // Stylesheet-breakout punctuation and angle brackets — never valid in a value.
  if (/[<>{};]/.test(value)) return true;
  // Absurd numeric runs — no legitimate token value has a 7+ digit number, but a
  // shared theme could grief the UI with blur(99999999px) / 99999999s / huge
  // shadows. Per-category caps below handle the smaller-but-harmful magnitudes.
  if (/\d{7,}/.test(value)) return true;
  // Control characters (incl. NUL, newlines, DEL). A numeric scan avoids
  // embedding raw control bytes in this source file.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Balanced, shallow parentheses — rejects malformed/deeply-nested function soup. */
function balancedParens(value: string): boolean {
  let depth = 0;
  for (const ch of value) {
    if (ch === '(') { depth++; if (depth > 3) return false; }
    else if (ch === ')') { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

/* ---- per-category shape checks (input is already blocklist-clean) ---- */

const NAMED_COLORS: ReadonlySet<string> = new Set([
  'transparent', 'currentcolor', 'white', 'black', 'red', 'green', 'blue',
  'gray', 'grey', 'silver', 'orange', 'yellow', 'purple', 'teal', 'navy',
]);

function isColorValue(v: string): boolean {
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return true;
  const fn = /^(rgb|rgba|hsl|hsla)\(([^()]*)\)$/i.exec(v);
  if (fn) {
    const inner = fn[2].trim();
    if (!inner) return false;
    // Every component must be a real number (optionally %/angle) — this rejects
    // junk like rgb(zz) that a bare charset check would wave through. Separators
    // are comma / slash / whitespace; no parens can hide (the [^()] guarantees).
    const parts = inner.split(/[\s,/]+/).filter(Boolean);
    return parts.length > 0 && parts.every((p) => /^-?(\d+\.?\d*|\.\d+)(%|deg|turn|rad|grad)?$/i.test(p));
  }
  return NAMED_COLORS.has(v.toLowerCase());
}

function isRgbTriplet(v: string): boolean {
  const m = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(v);
  if (!m) return false;
  return [m[1], m[2], m[3]].every((n) => Number(n) <= 255);
}

function isGradientValue(v: string): boolean {
  if (!/^(linear|radial|conic)-gradient\(/i.test(v) || !v.endsWith(')')) return false;
  return /^[-a-z0-9#%.,()/\s]+$/i.test(v) && balancedParens(v);
}

function isBlurValue(v: string): boolean {
  const m = /^blur\(\s*(\d+(?:\.\d+)?)(px|rem|em)\s*\)$/i.exec(v);
  return m !== null && parseFloat(m[1]) <= 1000; // default is 20px; cap absurd radii
}

const LENGTH_RE = /^-?\d+(\.\d+)?(px|rem|em|%|vh|vw|vmin|vmax|ch)$/i;
function isLengthValue(v: string): boolean {
  if (v === '0') return true;
  const m = LENGTH_RE.exec(v);
  if (!m) return false;
  const n = Math.abs(parseFloat(v));
  // No real token exceeds 9999px; viewport units are capped far tighter so a
  // shared theme can't set a gap to 99999vw and blow the layout apart.
  const cap = /^(vh|vw|vmin|vmax)$/i.test(m[2]) ? 200 : 10000;
  return Number.isFinite(n) && n <= cap;
}

function isNumberOrLength(v: string): boolean {
  if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v) <= 1000;
  return isLengthValue(v);
}

function isFontWeight(v: string): boolean {
  return /^(normal|bold|lighter|bolder|[1-9]00)$/i.test(v);
}

function isIntegerValue(v: string): boolean {
  return /^\d{1,5}$/.test(v) && Number(v) <= 10000; // z-scale tops out at 600
}

function isShadowValue(v: string): boolean {
  if (v.toLowerCase() === 'none') return true;
  // Lengths + optional `inset` + colors, possibly comma-joined layers. Reachable
  // only via import (not an editor field), so a strict charset + balance gate.
  return /^[-a-z0-9#%.,()/\s]+$/i.test(v) && balancedParens(v) && /\d/.test(v);
}

function isTransitionValue(v: string): boolean {
  return /^[-a-z0-9.,()%/\s]+$/i.test(v) && balancedParens(v) && /\d(ms|s)\b/i.test(v);
}

/** A font stack of quoted or bare family names — remote fonts are CSP-blocked anyway. */
function isFontStack(v: string): boolean {
  return v.length <= 200 && /^[-a-z0-9 ,'"_]+$/i.test(v);
}

/**
 * Validate and normalize one token value. Returns the trimmed value if it is a
 * safe, well-shaped value for `key`, or null to drop it.
 */
export function sanitizeTokenValue(key: string, rawValue: unknown): string | null {
  if (typeof rawValue !== 'string') return null;
  const value = rawValue.trim();
  if (!value || value.length > MAX_VALUE_LEN) return null;
  if (hasForbiddenSequence(value)) return null;
  const cat = tokenCategory(key);
  switch (cat) {
    case 'color': return isColorValue(value) ? value : null;
    case 'colorTriplet': return isRgbTriplet(value) ? value : null;
    case 'gradient': return isGradientValue(value) ? value : null;
    case 'filter': return isBlurValue(value) ? value : null;
    case 'length': return isLengthValue(value) ? value : null;
    case 'number': return isNumberOrLength(value) ? value : null;
    case 'fontWeight': return isFontWeight(value) ? value : null;
    case 'integer': return isIntegerValue(value) ? value : null;
    case 'shadow': return isShadowValue(value) ? value : null;
    case 'transition': return isTransitionValue(value) ? value : null;
    case 'fontFamily': return isFontStack(value) ? value : null;
    default: return null; // unknown/non-whitelisted token
  }
}

/* ------------------------------------------------------------------ *
 * Accent derivation — one picked color fans out to the accent tokens.
 * ------------------------------------------------------------------ */
interface Rgb { r: number; g: number; b: number; }

function parseHexColor(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

function toHex({ r, g, b }: Rgb): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Derive the accent token group from a single picked hex color. Hover is a
 * hue-preserving darken; `-bg` is a low-alpha wash; `-rgb` feeds the rgba()
 * shadows/rings. Returns null for an unparseable color.
 */
export function deriveAccent(hex: string): Record<string, string> | null {
  const rgb = parseHexColor(hex);
  if (!rgb) return null;
  const darken = (n: number) => n * 0.86;
  const hover: Rgb = { r: darken(rgb.r), g: darken(rgb.g), b: darken(rgb.b) };
  return {
    '--color-accent-primary': toHex(rgb),
    '--color-accent-primary-hover': toHex(hover),
    '--color-accent-bg': `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`,
    '--color-accent-rgb': `${rgb.r}, ${rgb.g}, ${rgb.b}`,
  };
}

/* ------------------------------------------------------------------ *
 * Bundled font stacks — the only families guaranteed to resolve locally
 * (Inter is self-hosted via @fontsource; the rest are system fallbacks).
 * The Level-1 font picker offers exactly these.
 * ------------------------------------------------------------------ */
export interface FontOption { id: string; label: string; stack: string; }
export const FONT_OPTIONS: readonly FontOption[] = [
  { id: 'inter', label: 'Inter', stack: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif" },
  { id: 'system', label: 'System', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif" },
  { id: 'mono', label: 'Monospace', stack: "'SF Mono', 'Fira Code', 'Consolas', ui-monospace, monospace" },
];

/* ------------------------------------------------------------------ *
 * Editable groups — the curated subset the live editor exposes. Not all
 * 122 tokens: spacing / z-index / layout / shadows are intentionally left
 * out of the GUI (still overridable by a hand-authored import).
 * Label keys resolve against the i18n dictionaries.
 * ------------------------------------------------------------------ */
export interface EditableToken { token: string; labelKey: string; }
export interface EditableGroup {
  id: string;
  labelKey: string;
  /** 'accent' = single picker → deriveAccent; others edit their tokens directly. */
  kind: 'color' | 'accent' | 'font' | 'length';
  tokens: EditableToken[];
}

export const EDITABLE_TOKENS: readonly EditableGroup[] = [
  { id: 'backgrounds', labelKey: 'settings.theme.group.backgrounds', kind: 'color', tokens: [
    { token: '--color-bg-primary', labelKey: 'settings.theme.token.bgPrimary' },
    { token: '--color-bg-secondary', labelKey: 'settings.theme.token.bgSecondary' },
    { token: '--color-bg-tertiary', labelKey: 'settings.theme.token.bgTertiary' },
    { token: '--color-bg-elevated', labelKey: 'settings.theme.token.bgElevated' },
  ] },
  { id: 'text', labelKey: 'settings.theme.group.text', kind: 'color', tokens: [
    { token: '--color-text-primary', labelKey: 'settings.theme.token.textPrimary' },
    { token: '--color-text-secondary', labelKey: 'settings.theme.token.textSecondary' },
    { token: '--color-text-tertiary', labelKey: 'settings.theme.token.textTertiary' },
    { token: '--color-text-disabled', labelKey: 'settings.theme.token.textDisabled' },
  ] },
  { id: 'accent', labelKey: 'settings.theme.group.accent', kind: 'accent', tokens: [
    { token: '--color-accent-primary', labelKey: 'settings.theme.token.accentPrimary' },
  ] },
  { id: 'brand', labelKey: 'settings.theme.group.brand', kind: 'color', tokens: [
    { token: '--color-logo', labelKey: 'settings.theme.token.logo' },
    { token: '--color-logo-outline', labelKey: 'settings.theme.token.logoOutline' },
    { token: '--color-logo-glare', labelKey: 'settings.theme.token.logoGlare' },
  ] },
  { id: 'borders', labelKey: 'settings.theme.group.borders', kind: 'color', tokens: [
    { token: '--color-border-default', labelKey: 'settings.theme.token.borderDefault' },
    { token: '--color-border-subtle', labelKey: 'settings.theme.token.borderSubtle' },
    { token: '--color-border-strong', labelKey: 'settings.theme.token.borderStrong' },
    { token: '--color-border-focus', labelKey: 'settings.theme.token.borderFocus' },
  ] },
  { id: 'semantic', labelKey: 'settings.theme.group.semantic', kind: 'color', tokens: [
    { token: '--color-success', labelKey: 'settings.theme.token.success' },
    { token: '--color-warning', labelKey: 'settings.theme.token.warning' },
    { token: '--color-error', labelKey: 'settings.theme.token.error' },
    { token: '--color-info', labelKey: 'settings.theme.token.info' },
  ] },
  { id: 'statuses', labelKey: 'settings.theme.group.statuses', kind: 'color', tokens: [
    { token: '--color-status-downloading', labelKey: 'settings.theme.token.statusDownloading' },
    { token: '--color-status-seeding', labelKey: 'settings.theme.token.statusSeeding' },
    { token: '--color-status-paused', labelKey: 'settings.theme.token.statusPaused' },
    { token: '--color-status-error', labelKey: 'settings.theme.token.statusError' },
  ] },
  { id: 'font', labelKey: 'settings.theme.group.font', kind: 'font', tokens: [
    { token: '--font-family', labelKey: 'settings.theme.token.font' },
  ] },
  { id: 'fontSize', labelKey: 'settings.theme.group.fontSize', kind: 'length', tokens: [
    { token: '--font-size-xs', labelKey: 'settings.theme.token.fsXs' },
    { token: '--font-size-sm', labelKey: 'settings.theme.token.fsSm' },
    { token: '--font-size-base', labelKey: 'settings.theme.token.fsBase' },
    { token: '--font-size-md', labelKey: 'settings.theme.token.fsMd' },
    { token: '--font-size-lg', labelKey: 'settings.theme.token.fsLg' },
    { token: '--font-size-xl', labelKey: 'settings.theme.token.fsXl' },
    { token: '--font-size-2xl', labelKey: 'settings.theme.token.fs2xl' },
    { token: '--font-size-3xl', labelKey: 'settings.theme.token.fs3xl' },
  ] },
  { id: 'radius', labelKey: 'settings.theme.group.radius', kind: 'length', tokens: [
    // One master knob rounds the whole UI; the per-step tokens (sm/md/lg/xl) live
    // in Advanced for fine control and derive from this by default.
    { token: '--radius-scale', labelKey: 'settings.theme.token.roundness' },
  ] },
];

/* ------------------------------------------------------------------ *
 * Advanced groups — EVERY whitelisted token, partitioned into semantic
 * groups (first match wins) for the editor's Advanced mode. Unlike
 * EDITABLE_TOKENS, these are keyed by the raw token name: the Advanced UI
 * shows the name itself plus a category-appropriate control, and only the
 * group header is translated. Derived from TOKEN_NAMES, so it can never
 * drift out of sync with the whitelist (a test asserts full coverage).
 * ------------------------------------------------------------------ */
export interface AdvancedGroup { id: string; labelKey: string; tokens: string[]; }

const ADVANCED_GROUP_DEFS: { id: string; labelKey: string; match: (n: string) => boolean }[] = [
  { id: 'backgrounds', labelKey: 'settings.theme.adv.backgrounds', match: (n) => n.startsWith('--color-bg-') },
  { id: 'borders', labelKey: 'settings.theme.adv.borders', match: (n) => n.startsWith('--color-border') },
  { id: 'text', labelKey: 'settings.theme.adv.text', match: (n) => n.startsWith('--color-text') },
  { id: 'accent', labelKey: 'settings.theme.adv.accent', match: (n) => n.startsWith('--color-accent') },
  { id: 'brand', labelKey: 'settings.theme.adv.brand', match: (n) => n.startsWith('--color-logo') },
  { id: 'statuses', labelKey: 'settings.theme.adv.statuses', match: (n) => n.startsWith('--color-status-') },
  { id: 'semantic', labelKey: 'settings.theme.adv.semantic', match: (n) => /^--color-(success|warning|error|info)/.test(n) },
  { id: 'filetypes', labelKey: 'settings.theme.adv.filetypes', match: (n) => /^--color-(video|audio|image|archive|document)$/.test(n) },
  { id: 'glass', labelKey: 'settings.theme.adv.glass', match: (n) => n.startsWith('--glass-') },
  { id: 'gradients', labelKey: 'settings.theme.adv.gradients', match: (n) => n.startsWith('--gradient-') },
  { id: 'shadows', labelKey: 'settings.theme.adv.shadows', match: (n) => n.startsWith('--shadow-') },
  { id: 'spacing', labelKey: 'settings.theme.adv.spacing', match: (n) => n.startsWith('--space-') },
  { id: 'corners', labelKey: 'settings.theme.adv.corners', match: (n) => n.startsWith('--radius-') },
  { id: 'typography', labelKey: 'settings.theme.adv.typography', match: (n) => n.startsWith('--font-') || n.startsWith('--line-height-') },
  { id: 'motion', labelKey: 'settings.theme.adv.motion', match: (n) => n.startsWith('--transition-') },
  { id: 'layering', labelKey: 'settings.theme.adv.layering', match: (n) => n.startsWith('--z-') },
  { id: 'layout', labelKey: 'settings.theme.adv.layout', match: () => true }, // catch-all (sidebar/header/footer/…)
];

export const ADVANCED_GROUPS: readonly AdvancedGroup[] = (() => {
  const groups: AdvancedGroup[] = ADVANCED_GROUP_DEFS.map((d) => ({ id: d.id, labelKey: d.labelKey, tokens: [] }));
  for (const name of TOKEN_NAMES) {
    const idx = ADVANCED_GROUP_DEFS.findIndex((d) => d.match(name));
    groups[idx].tokens.push(name);
  }
  return groups.filter((g) => g.tokens.length > 0);
})();

/* ------------------------------------------------------------------ *
 * Whole-theme validation — the gate every imported file passes before it
 * can touch the DOM. Structural problems fail closed; individual bad
 * tokens are dropped with a warning so one hostile value can't poison an
 * otherwise-valid theme.
 * ------------------------------------------------------------------ */
function clampName(name: string): string {
  let stripped = '';
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) stripped += name[i];
  }
  return stripped.trim().slice(0, MAX_NAME_LEN);
}

function sanitizeId(id: unknown): string {
  return typeof id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(id) ? id.slice(0, MAX_ID_LEN) : '';
}

/** Sanitize one palette map: keep whitelisted tokens with valid values, drop the rest. */
function sanitizeTokenMap(raw: unknown, label: string, warnings: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_TOKENS) warnings.push(`too many tokens (${label}); only the first ${MAX_TOKENS} were considered`);
  for (const [key, val] of entries.slice(0, MAX_TOKENS)) {
    if (!TOKEN_WHITELIST.has(key)) { warnings.push(`unknown token dropped (${label}): ${key}`); continue; }
    const clean = sanitizeTokenValue(key, val);
    if (clean === null) { warnings.push(`invalid value dropped (${label}): ${key}`); continue; }
    out[key] = clean;
  }
  return out;
}

export function validateTheme(input: unknown): ValidateResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['theme must be a JSON object'] };
  }
  const obj = input as Record<string, unknown>;

  const name = typeof obj.name === 'string' ? clampName(obj.name) : '';
  if (!name) errors.push('name is required');

  const warnings: string[] = [];
  let dark: Record<string, string>;
  let light: Record<string, string>;

  if ('tokens' in obj && obj.dark === undefined && obj.light === undefined) {
    // Legacy single-base theme { base, tokens } → migrate into one variant.
    const base = obj.base;
    if (base !== 'dark' && base !== 'light') errors.push('base must be "dark" or "light"');
    if (typeof obj.tokens !== 'object' || obj.tokens === null || Array.isArray(obj.tokens)) errors.push('tokens must be an object');
    if (errors.length) return { ok: false, errors };
    const migrated = sanitizeTokenMap(obj.tokens, base as string, warnings);
    dark = base === 'dark' ? migrated : {};
    light = base === 'light' ? migrated : {};
  } else {
    // Dual-mode theme { dark, light }.
    if (errors.length) return { ok: false, errors };
    dark = sanitizeTokenMap(obj.dark, 'dark', warnings);
    light = sanitizeTokenMap(obj.light, 'light', warnings);
  }

  let font: string | undefined;
  if (obj.font !== undefined) {
    const f = typeof obj.font === 'string' ? obj.font.trim() : '';
    if (f && !hasForbiddenSequence(f) && isFontStack(f)) font = f;
    else warnings.push('invalid font dropped');
  }

  let fontData: string | undefined;
  if (obj.fontData !== undefined) {
    const fd = sanitizeFontData(obj.fontData);
    if (fd) fontData = fd; else warnings.push('invalid font data dropped');
  }

  const theme: Theme = {
    id: sanitizeId(obj.id),
    name,
    dark,
    light,
    ...(font ? { font } : {}),
    ...(fontData ? { fontData } : {}),
  };
  return { ok: true, theme, warnings };
}

/* ------------------------------------------------------------------ *
 * DOM application — the only impure surface, kept behind a minimal
 * structural type so it runs against a real HTMLElement in the app and a
 * plain stub in tests (no jsdom needed).
 * ------------------------------------------------------------------ */
export interface ThemeApplyTarget {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
  setAttribute(name: string, value: string): void;
}

/** Remove every inline token override, reverting to the stylesheet base. */
export function clearAppliedTheme(root: ThemeApplyTarget): void {
  for (const name of TOKEN_WHITELIST) root.style.removeProperty(name); // --font-display is whitelisted, so it's cleared here too
}

/**
 * Apply a theme's `mode` variant: set `data-theme`, wipe any prior inline
 * overrides, then write each whitelisted token from that variant. Idempotent and
 * self-cleaning, so switching modes or themes never leaves a stale override.
 *
 * Self-defending: every value is re-run through sanitizeTokenValue here, so a
 * caller that hands over un-validated tokens (e.g. the editor's live preview of
 * a draft the user is still typing) can never push a dangerous or malformed
 * value onto :root — safety no longer depends on every call site pre-validating.
 */
export function applyTheme(root: ThemeApplyTarget, theme: Theme, mode: ThemeMode): void {
  clearAppliedTheme(root);
  root.setAttribute('data-theme', mode);
  const tokens = mode === 'light' ? theme.light : theme.dark;
  let appliedFont: string | null = null;
  for (const [key, value] of Object.entries(tokens)) {
    if (!TOKEN_WHITELIST.has(key)) continue;
    const clean = sanitizeTokenValue(key, value);
    if (clean !== null) {
      root.style.setProperty(key, clean);
      if (key === '--font-family') appliedFont = clean;
    }
  }
  if (theme.font) {
    const cleanFont = sanitizeTokenValue('--font-family', theme.font);
    if (cleanFont !== null) { root.style.setProperty('--font-family', cleanFont); appliedFont = cleanFont; }
  }
  // A custom theme font must also drive the display face (headings, eyebrows,
  // primary buttons ride --font-display), else they'd keep the brand face while
  // body text changed. No custom font → leave --font-display at the brand default.
  if (appliedFont !== null) root.style.setProperty('--font-display', appliedFont);
}
