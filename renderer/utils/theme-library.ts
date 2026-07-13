/**
 * Custom theme library — the localStorage-backed store of user themes plus the
 * "which one is active" pointer, and the single apply path.
 *
 * A custom theme is a full Theme (its own base + token overrides). Applying one
 * sets data-theme to its base and writes its overrides inline; deactivating
 * reverts to the built-in base chosen in the ThemeSelector. The Level-1
 * accent/font quick prefs (theme-prefs.ts) are always re-layered on top after a
 * switch, so a personal accent/font rides above whatever theme is selected.
 *
 * Everything read back from disk goes through validateTheme again — the library
 * is as untrusted as an imported file once it has round-tripped through storage.
 */
import { Theme, ThemeMode, validateTheme, applyTheme, clearAppliedTheme } from '../../shared/theme';
import { restoreThemePrefs } from './theme-prefs';

const LIBRARY_KEY = 'havvn.theme.library';
const ACTIVE_KEY = 'havvn.theme.active';
const BASE_PREF_KEY = 'theme'; // the built-in base selector (system/dark/light)

const read = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key: string, value: string | null): void => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* cosmetic */ }
};

const root = (): HTMLElement => document.documentElement;

export function genThemeId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return `thm-${crypto.randomUUID().slice(0, 8)}`;
  } catch { /* fall through */ }
  return `thm-${Math.random().toString(36).slice(2, 10)}`;
}

/** Load + revalidate the saved library; silently drops anything corrupt/hostile. */
export function loadLibrary(): Theme[] {
  const raw = read(LIBRARY_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: Theme[] = [];
  for (const entry of parsed) {
    const result = validateTheme(entry);
    if (result.ok) out.push(result.theme.id ? result.theme : { ...result.theme, id: genThemeId() });
  }
  return out;
}

export function saveLibrary(themes: Theme[]): void {
  write(LIBRARY_KEY, JSON.stringify(themes));
}

export function getActiveId(): string | null {
  return read(ACTIVE_KEY);
}

export function getActiveTheme(): Theme | null {
  const id = getActiveId();
  if (!id) return null;
  return loadLibrary().find((t) => t.id === id) ?? null;
}

/** The current display mode — the built-in dark/light/system selector resolved. */
export function resolvedMode(): ThemeMode {
  const pref = read(BASE_PREF_KEY);
  if (pref === 'dark' || pref === 'light') return pref;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch { return 'dark'; }
}

/** Apply a custom theme's current-mode variant live, then re-layer quick prefs. */
export function applyThemeObject(theme: Theme): void {
  applyTheme(root(), theme, resolvedMode());
  restoreThemePrefs();
}

/** Preview a specific variant of a theme (used by the editor while editing it). */
export function previewTheme(theme: Theme, mode: ThemeMode): void {
  applyTheme(root(), theme, mode);
  restoreThemePrefs();
}

/** Clear any custom overrides, revert to the built-in palette, re-layer quick prefs. */
export function revertToBase(): void {
  clearAppliedTheme(root());
  root().setAttribute('data-theme', resolvedMode());
  restoreThemePrefs();
}

/** Make a theme active (persist the pointer) and apply it. */
export function activateTheme(theme: Theme): void {
  write(ACTIVE_KEY, theme.id);
  applyThemeObject(theme);
}

/** Deactivate the custom theme and go back to the built-in base. */
export function deactivateTheme(): void {
  write(ACTIVE_KEY, null);
  revertToBase();
}

/**
 * Boot: if a custom theme is active, apply it over the base data-theme that the
 * App.tsx theme effect already set. Quick accent/font prefs are restored by the
 * caller right after (App.tsx), so nothing is double-applied here.
 */
export function bootApplyActiveTheme(): void {
  const active = getActiveTheme();
  if (active) applyTheme(root(), active, resolvedMode());
}
