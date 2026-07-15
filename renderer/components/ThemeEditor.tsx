/**
 * Theme editor — a dockable side panel for creating, tuning, saving, sharing and
 * applying dual-mode custom themes.
 *
 * It is NOT a modal: it docks to the left or right edge (resizable, no blocking
 * backdrop) and lives at the app shell level, so the real app stays navigable
 * beside it — click Rooms/Downloads and watch them recolor live. When the live
 * app isn't enough (e.g. you're on Settings and want to see Rooms), the Preview
 * tab renders faithful samples of every surface, painted by the draft.
 *
 * A theme carries a full palette for BOTH dark and light; the "variant" toggle
 * picks which one you are painting, and the live preview switches data-theme to
 * that variant so the app (and the samples) show it. Saving persists the draft
 * into the localStorage library and makes it active; closing without saving
 * re-applies whatever was actually active in the app's current mode.
 *
 * Every typed value is bounced through sanitizeTokenValue for the red-outline
 * hint, and the whole draft goes through validateTheme on save and on import —
 * the same trust boundary an imported file crosses.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import Icon from './Icon';
import { useTranslation } from '../utils/i18nContext';
import {
  Theme, ThemeMode, EDITABLE_TOKENS, ADVANCED_GROUPS, FONT_OPTIONS, deriveAccent, validateTheme,
  sanitizeTokenValue, sanitizeFontData, tokenCategory, clearAppliedTheme, TOKEN_WHITELIST,
} from '../../shared/theme';
import { contrastRatio, wcagLevel } from '../../shared/contrast';
import { parseColor, toRgbString } from '../../shared/color';
import { generatePalette, adaptVariant } from '../../shared/palette';
import {
  loadLibrary, saveLibrary, getActiveId, getActiveTheme, genThemeId,
  applyThemeObject, previewTheme, activateTheme, deactivateTheme, revertToBase, resolvedMode,
  registerThemeFontInto,
} from '../utils/theme-library';
import { ColorField } from './ColorField';
import { DownloadsSample, RoomsSample, ChatSample, FormsSample } from './theme-preview/GallerySamples';
import './ThemeEditor.css';

type EditMode = 'simple' | 'advanced';

// Text-on-background pairs the contrast checker reports (resolved from the draft).
const CONTRAST_PAIRS: [string, string][] = [
  ['--color-text-primary', '--color-bg-primary'],
  ['--color-text-secondary', '--color-bg-primary'],
  ['--color-text-primary', '--color-bg-elevated'],
  ['--color-text-tertiary', '--color-bg-elevated'],
  ['--color-accent-primary', '--color-bg-primary'],
];
const shortToken = (name: string): string => name.replace(/^--color-/, '').replace(/^--/, '');

/**
 * Inspector heuristic: match an element's used background / text / border color
 * to the whitelisted color token whose currently-applied `:root` value resolves
 * to the same RGB. Background wins over text over border. Returns the token or
 * null. Impure (reads the live DOM) — kept module-level so the component stays lean.
 */
function tokenForElement(el: Element): string | null {
  const rootCS = getComputedStyle(document.documentElement);
  const byRgb = new Map<string, string>(); // "r,g,b" -> first token with that resolved value
  for (const tk of TOKEN_WHITELIST) {
    const cat = tokenCategory(tk);
    if (cat !== 'color' && cat !== 'colorTriplet') continue;
    const raw = rootCS.getPropertyValue(tk).trim();
    if (!raw) continue;
    const p = parseColor(cat === 'colorTriplet' ? `rgb(${raw})` : raw);
    if (!p || p.a === 0) continue;
    const key = `${p.r},${p.g},${p.b}`;
    if (!byRgb.has(key)) byRgb.set(key, tk);
  }
  const cs = getComputedStyle(el);
  for (const used of [cs.backgroundColor, cs.color, cs.borderTopColor]) {
    const p = parseColor(used);
    if (!p || p.a === 0) continue;
    const hit = byRgb.get(`${p.r},${p.g},${p.b}`);
    if (hit) return hit;
  }
  return null;
}

// Dock geometry + persistence.
const DOCK_MIN = 320;
const DOCK_MAX = 720;
const DOCK_DEFAULT = 420;
const SIDE_KEY = 'havvn.themeEditor.side';
const WIDTH_KEY = 'havvn.themeEditor.width';

type DockSide = 'left' | 'right';
type EditorTab = 'edit' | 'preview';
type PreviewPage = 'overview' | 'downloads' | 'rooms' | 'chat' | 'forms';

const readPref = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const writePref = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* cosmetic */ }
};

const initialSide = (): DockSide => (readPref(SIDE_KEY) === 'left' ? 'left' : 'right');
/** Clamp a width to [MIN, MAX] and to the viewport. The reserve is the shell's
 *  real minimum — the 260px sidebar plus a usable slice of page — not an
 *  arbitrary 160px, which left less room than the sidebar alone occupies. */
const SHELL_MIN = 480;
const clampWidth = (w: number): number => {
  const viewportCap = (typeof window !== 'undefined' ? window.innerWidth : DOCK_MAX) - SHELL_MIN;
  return Math.max(DOCK_MIN, Math.min(DOCK_MAX, Math.max(DOCK_MIN, viewportCap), w));
};
const initialWidth = (): number => {
  const n = parseInt(readPref(WIDTH_KEY) ?? '', 10);
  return clampWidth(Number.isFinite(n) ? n : DOCK_DEFAULT);
};

/**
 * Read the stylesheet default of every editable token under `mode`, without a
 * visible flash: snapshot inline overrides, clear them, flip data-theme, read
 * (getComputedStyle is synchronous), then restore — all in one JS tick.
 */
function readModeDefaults(mode: ThemeMode): Record<string, string> {
  const el = document.documentElement;
  const prevAttr = el.getAttribute('data-theme');
  // Snapshot EVERY whitelisted inline override, then read the base value of
  // EVERY whitelisted token (Advanced mode edits all 122 — reading only the
  // editable subset left the other ~96 fields blank + flagged invalid). Clearing
  // and restoring the full set also avoids flashing non-editable overrides to
  // base on the live app behind the dock.
  const saved: Record<string, string> = {};
  for (const token of TOKEN_WHITELIST) saved[token] = el.style.getPropertyValue(token);
  clearAppliedTheme(el);
  el.setAttribute('data-theme', mode);
  const out: Record<string, string> = {};
  const cs = getComputedStyle(el);
  for (const token of TOKEN_WHITELIST) out[token] = cs.getPropertyValue(token).trim();
  if (prevAttr) el.setAttribute('data-theme', prevAttr); else el.removeAttribute('data-theme');
  for (const [token, val] of Object.entries(saved)) if (val) el.style.setProperty(token, val);
  return out;
}

/** #rrggbb for the native swatch input, or a neutral gray when the value isn't hex. */
function hexOf(value: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (m) return `#${m[1]}`;
  const short = /^#([0-9a-f]{3})$/i.exec(value.trim());
  if (short) return `#${short[1].split('').map((c) => c + c).join('')}`;
  return '#808080';
}

const emptyTheme = (name: string): Theme => ({ id: genThemeId(), name, dark: {}, light: {} });

interface ThemeEditorProps { onClose: () => void; }

export const ThemeEditor: React.FC<ThemeEditorProps> = ({ onClose }) => {
  const { t } = useTranslation();
  // EDITABLE_TOKENS label keys are typed `string` (they live in shared/, which
  // can't import the renderer's key union); this narrows them for t().
  const label = (key: string): string => t(key as Parameters<typeof t>[0]);
  const [library, setLibrary] = useState<Theme[]>(loadLibrary);
  const [draft, setDraft] = useState<Theme | null>(() => {
    const active = getActiveTheme();
    return active ? structuredClone(active) : null;
  });
  // Which palette the fields edit + preview (defaults to the app's current mode).
  const [variant, setVariant] = useState<ThemeMode>(resolvedMode);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Dock chrome.
  const [side, setSide] = useState<DockSide>(initialSide);
  const [width, setWidth] = useState<number>(initialWidth);
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<EditorTab>('edit');
  const [previewPage, setPreviewPage] = useState<PreviewPage>('overview');
  // Simple (curated groups) vs Advanced (every token + search + only-changed).
  const [editMode, setEditMode] = useState<EditMode>('simple');
  const [search, setSearch] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  // Undo/redo of the draft, and the "inspect element" mode.
  const [undoStack, setUndoStack] = useState<Theme[]>([]);
  const [redoStack, setRedoStack] = useState<Theme[]>([]);
  const [inspecting, setInspecting] = useState(false);
  const [inspectRect, setInspectRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // Coalesces rapid same-target edits (a slider drag) into ONE undo step.
  const coalesceRef = useRef<{ key: string; time: number }>({ key: '', time: 0 });
  // Custom-font upload: hidden file input + the picked file's name for display.
  const fontInputRef = useRef<HTMLInputElement>(null);
  const [customFontName, setCustomFontName] = useState('');
  // Pop-out: the editor rendered into its own OS window (drag to a 2nd monitor).
  // The child is an about:blank window we script directly; the component tree
  // stays HERE (portal), so all state and the live preview keep working.
  const [popout, setPopout] = useState<Window | null>(null);
  const popoutRef = useRef<Window | null>(null);

  // Defaults for the edited variant — seeds every field's shown value.
  const defaults = useMemo(() => readModeDefaults(variant), [variant]);

  // Live preview: apply the draft's edited variant to the running app (and thus
  // to every sample rendered in this same document).
  useEffect(() => { if (draft) previewTheme(draft, variant); }, [draft, variant]);

  // Reserve the dock's width on the shell (push-layout) via <html> data + var,
  // read by the .app-container rules in layout.css. Collapsed → no reservation.
  // useLayoutEffect so the reservation is committed before paint — no open-time
  // frame where the app is full width and then jumps.
  useLayoutEffect(() => {
    const el = document.documentElement;
    if (collapsed || popout) { delete el.dataset.teDock; el.style.removeProperty('--te-dock-w'); }
    else { el.dataset.teDock = side; el.style.setProperty('--te-dock-w', `${width}px`); }
  }, [side, width, collapsed, popout]);
  // Always release the reservation (and any stuck resize state) when the editor
  // unmounts (closed) — including if it unmounts mid-drag.
  useEffect(() => () => {
    const el = document.documentElement;
    delete el.dataset.teDock;
    el.style.removeProperty('--te-dock-w');
    document.body.classList.remove('te-resizing');
  }, []);

  const activeId = getActiveId();
  const note = (kind: 'ok' | 'err', text: string) => setStatus({ kind, text });

  // ── draft history (undo/redo) ──────────────────────────────────────────────
  const resetHistory = () => { setUndoStack([]); setRedoStack([]); coalesceRef.current = { key: '', time: 0 }; };

  /** Load a different draft (or none) and drop the edit history. */
  const loadDraft = (next: Theme | null) => { setDraft(next); resetHistory(); };

  /**
   * Mutate the current draft as ONE undoable step. Rapid edits sharing a
   * coalesceKey within 500ms fold into the same step, so a slider drag is a
   * single undo rather than fifty.
   */
  const editDraft = (updater: (d: Theme) => Theme, coalesceKey?: string) => {
    if (!draft) return;
    const now = Date.now();
    // 200ms gap: a slider drag streams events ~16ms apart (folds into one step),
    // but deliberate discrete edits to the same token land >200ms apart (kept
    // as separate undo steps).
    const coalesce = !!coalesceKey && coalesceRef.current.key === coalesceKey && now - coalesceRef.current.time < 200;
    if (!coalesce) { setUndoStack((s) => [...s.slice(-49), draft]); setRedoStack([]); }
    coalesceRef.current = { key: coalesceKey ?? '', time: now };
    setDraft(updater(draft));
  };

  const undo = () => {
    if (!undoStack.length || !draft) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((s) => [...s, draft]);
    setDraft(prev);
    coalesceRef.current = { key: '', time: 0 };
  };
  const redo = () => {
    if (!redoStack.length || !draft) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((s) => s.slice(0, -1));
    setUndoStack((s) => [...s, draft]);
    setDraft(next);
    coalesceRef.current = { key: '', time: 0 };
  };

  // Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Ctrl+Y redo — while focus is in the
  // dock. Yields to the browser's native text undo when a text field is focused
  // (so editing a value string still undoes character-by-character there).
  const onDockKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const target = e.target as HTMLElement;
    const el = target as HTMLInputElement;
    const typing = target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && el.type === 'text');
    if (typing) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); }
  };

  const paletteKey = variant === 'light' ? 'light' : 'dark';
  const valueOf = (token: string): string =>
    (draft && draft[paletteKey][token] !== undefined ? draft[paletteKey][token] : defaults[token]) ?? '';

  const setToken = (token: string, value: string) =>
    editDraft((d) => ({ ...d, [paletteKey]: { ...d[paletteKey], [token]: value } }), `set:${paletteKey}:${token}`);

  /** Write one value into BOTH variants at once (the apply-to-both affordance). */
  const setTokenBoth = (token: string, value: string) =>
    editDraft((d) => ({ ...d, dark: { ...d.dark, [token]: value }, light: { ...d.light, [token]: value } }), `both:${token}`);

  /** Remove the override → the token falls back to its base value. */
  const resetToken = (token: string) =>
    editDraft((d) => { const next = { ...d[paletteKey] }; delete next[token]; return { ...d, [paletteKey]: next }; });

  /** Does the draft explicitly override this token in the edited variant? */
  const hasOverride = (token: string): boolean => !!draft && draft[paletteKey][token] !== undefined;

  // WCAG contrast of the key text-on-bg pairs, resolved from the draft. Cheap
  // (5 pairs) so it just recomputes on every edit; deps cover every input the
  // inner resolver reads.
  const contrastRows = useMemo(() => {
    const resolve = (token: string): string =>
      (draft && draft[paletteKey][token] !== undefined ? draft[paletteKey][token] : defaults[token]) ?? '';
    // Re-serialize the swatch colors through the parser so a raw draft value the
    // user is still typing (e.g. "url(...)") can never reach an inline style —
    // the swatch only ever renders a parsed, re-emitted color (or nothing).
    const safe = (v: string): string | undefined => { const p = parseColor(v); return p ? toRgbString(p) : undefined; };
    // Translucent surfaces are composited over the page's base surface, not white.
    const baseBg = resolve('--color-bg-primary');
    return CONTRAST_PAIRS.map(([fg, bg]) => {
      const fgVal = resolve(fg);
      const bgVal = resolve(bg);
      const ratio = contrastRatio(fgVal, bgVal, baseBg);
      return { fg, bg, fgCss: safe(fgVal), bgCss: safe(bgVal), ratio, level: ratio != null ? wcagLevel(ratio) : null };
    });
  }, [draft, paletteKey, defaults]);

  const setAccent = (hex: string) => {
    const derived = deriveAccent(hex);
    if (derived) editDraft((d) => ({ ...d, [paletteKey]: { ...d[paletteKey], ...derived } }), 'accent');
  };

  // A custom (uploaded) font means no bundled option is selected.
  const currentFontId = (): string => draft?.fontData ? '' : (FONT_OPTIONS.find((o) => o.stack === draft?.font)?.id ?? 'inter');
  const setFont = (id: string) => {
    const stack = FONT_OPTIONS.find((o) => o.id === id)?.stack;
    setCustomFontName('');
    editDraft((d) => { const next = { ...d, font: id === 'inter' ? undefined : stack }; delete next.fontData; return next; }, 'font');
  };

  /** Load a user font file → embed it as a data: URL on the draft (registered on
   *  the next preview via the FontFace API). Capped size, extension-derived mime. */
  const onFontFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be re-picked later
    if (!file) return;
    if (file.size > 1_400_000) { note('err', t('settings.theme.fontTooLarge')); return; }
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const mime = ext === 'woff2' ? 'font/woff2' : ext === 'woff' ? 'font/woff' : ext === 'otf' ? 'font/otf' : ext === 'ttf' ? 'font/ttf' : '';
    if (!mime) { note('err', t('settings.theme.fontInvalid')); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      const dataUrl = comma < 0 ? '' : `data:${mime};base64,${result.slice(comma + 1)}`;
      if (!dataUrl || sanitizeFontData(dataUrl) === null) { note('err', t('settings.theme.fontInvalid')); return; }
      const family = `tf-${genThemeId().slice(4)}`;
      const stack = `'${family}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
      setCustomFontName(file.name);
      editDraft((d) => ({ ...d, font: stack, fontData: dataUrl }));
      note('ok', t('settings.theme.fontLoaded'));
    };
    reader.onerror = () => note('err', t('settings.theme.fontInvalid'));
    reader.readAsDataURL(file);
  };

  const clearCustomFont = () => {
    setCustomFontName('');
    editDraft((d) => { const next = { ...d }; delete next.font; delete next.fontData; return next; }, 'font');
  };

  // ── "magic" (palette generation + variant adaptation) ──────────────────────
  /** Fan a coherent palette out of the current accent + background into this variant. */
  const generateFromBase = () => {
    const gen = generatePalette({ accent: valueOf('--color-accent-primary'), bg: valueOf('--color-bg-primary') });
    if (!Object.keys(gen).length) { note('err', t('settings.theme.generateFailed')); return; }
    editDraft((d) => ({ ...d, [paletteKey]: { ...d[paletteKey], ...gen } }));
    note('ok', t('settings.theme.generated'));
  };
  /** Build the opposite variant from this one's overrides (light↔dark). */
  const adaptToOther = () => {
    if (!draft) return;
    const other = variant === 'light' ? 'dark' : 'light';
    editDraft((d) => ({ ...d, [other]: adaptVariant(d[paletteKey]) }));
    note('ok', t('settings.theme.adapted'));
  };

  // ── dock chrome actions ────────────────────────────────────────────────────
  const flipSide = () => setSide((s) => {
    const next = s === 'right' ? 'left' : 'right';
    writePref(SIDE_KEY, next);
    return next;
  });

  // ── pop-out window ─────────────────────────────────────────────────────────
  /** Detach the editor into its own OS window. The main process allows exactly
   *  this named about:blank child; styles are cloned into it and the editor is
   *  portaled there while the preview keeps painting the MAIN window. */
  const openPopout = () => {
    const existing = popoutRef.current;
    if (existing && !existing.closed) { existing.focus(); return; }
    const w = window.open('about:blank', 'havvn-theme-editor');
    if (!w) { note('err', t('settings.theme.popoutFailed')); return; }
    w.document.title = t('settings.theme.editorTitle');
    // Clone every stylesheet (dev: style-loader <style> tags; prod: <link>s) so
    // the portal renders styled. Editor CSS is already loaded at this point.
    // Link hrefs must be made absolute: the child's base URL is about:blank,
    // where the production build's relative hrefs would not resolve.
    for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
      const clone = node.cloneNode(true) as HTMLElement;
      if (clone instanceof HTMLLinkElement) clone.href = (node as HTMLLinkElement).href;
      w.document.head.appendChild(clone);
    }
    const base = w.document.createElement('style');
    base.textContent = 'body { margin: 0; overflow: hidden; }';
    w.document.head.appendChild(base);
    setInspecting(false);
    setCollapsed(false);
    setPopout(w);
  };

  /** Bring the editor back into the app (also runs when the OS window closes). */
  const popIn = () => {
    const w = popoutRef.current;
    popoutRef.current = null;
    setPopout(null);
    if (w && !w.closed) w.close();
  };

  useEffect(() => { popoutRef.current = popout; }, [popout]);
  // Close the child window when the editor unmounts (editor closed / app nav),
  // and when the MAIN document unloads (reload / window close) — React cleanups
  // don't run on unload, and an orphaned child would outlive its JS context.
  useEffect(() => {
    const closeOnUnload = () => { popoutRef.current?.close(); };
    window.addEventListener('pagehide', closeOnUnload);
    return () => {
      window.removeEventListener('pagehide', closeOnUnload);
      popoutRef.current?.close();
    };
  }, []);

  // While popped out: mirror the root's theme attributes (inline token overrides,
  // data-theme, density, reduced motion) onto the child so the editor chrome is
  // painted by the same draft; return to docked mode when the window is closed.
  useEffect(() => {
    if (!popout) return;
    const src = document.documentElement;
    const ATTRS = ['style', 'data-theme', 'data-density', 'data-reduce-motion'];
    const sync = () => {
      if (popout.closed) return;
      const dst = popout.document.documentElement;
      for (const a of ATTRS) {
        const v = src.getAttribute(a);
        if (v === null) dst.removeAttribute(a); else dst.setAttribute(a, v);
      }
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(src, { attributes: true, attributeFilter: ATTRS });
    const onGone = () => {
      const w = popoutRef.current;
      popoutRef.current = null;
      setPopout(null);
      // beforeunload also fires when the child NAVIGATES (e.g. a reload): the
      // portal DOM dies with its document, so a navigated child is useless —
      // close it, or the next pop-out would reuse the blank window by name and
      // come up empty. Deferred so a real close isn't double-closed.
      setTimeout(() => { try { if (w && !w.closed) w.close(); } catch { /* gone */ } }, 0);
    };
    popout.addEventListener('beforeunload', onGone);
    return () => { mo.disconnect(); popout.removeEventListener('beforeunload', onGone); };
  }, [popout]);

  // The pop-out's own chrome must render an uploaded custom font too — FontFace
  // registrations don't cross documents, so mirror the draft's font into the
  // child (re-runs when the font changes; cheap no-op otherwise).
  useEffect(() => {
    if (popout && !popout.closed && draft?.fontData) registerThemeFontInto(popout.document, draft);
  }, [popout, draft]);

  /** Drag the inner edge to resize; clamped and persisted on release. */
  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let last = startW;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const raw = side === 'right' ? startW - dx : startW + dx;
      last = clampWidth(raw);
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('te-resizing');
      writePref(WIDTH_KEY, String(Math.round(last)));
    };
    document.body.classList.add('te-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    // pointercancel (touch/gesture takeover, window blur mid-drag) must tear down
    // too, else the listeners + the global te-resizing cursor stay stuck.
    window.addEventListener('pointercancel', up);
  };

  // ── theme lifecycle (loads reset the undo history) ─────────────────────────
  const createNew = () => { loadDraft(emptyTheme(t('settings.theme.newName'))); setTab('edit'); note('ok', t('settings.theme.newHint')); };
  const duplicate = (theme: Theme) => {
    loadDraft({ ...structuredClone(theme), id: genThemeId(), name: `${theme.name} ${t('settings.theme.copySuffix')}` });
    setTab('edit');
  };
  const edit = (theme: Theme) => { loadDraft(structuredClone(theme)); setTab('edit'); };

  /** Copy the variant you're editing onto the other one (bootstrap the pair). */
  const copyToOther = () => editDraft((d) => {
    const other = variant === 'light' ? 'dark' : 'light';
    return { ...d, [other]: { ...d[paletteKey] } };
  });

  const save = () => {
    if (!draft) return;
    const result = validateTheme({ ...draft, name: draft.name.trim() || t('settings.theme.newName') });
    if (!result.ok) { note('err', result.errors.join('; ')); return; }
    const clean: Theme = { ...result.theme, id: draft.id || genThemeId() };
    const lib = loadLibrary();
    const idx = lib.findIndex((x) => x.id === clean.id);
    if (idx >= 0) lib[idx] = clean; else lib.push(clean);
    saveLibrary(lib);
    setLibrary(lib);
    activateTheme(clean);
    loadDraft(structuredClone(clean));
    note('ok', t('settings.theme.saved'));
  };

  const remove = (theme: Theme) => {
    const lib = loadLibrary().filter((x) => x.id !== theme.id);
    saveLibrary(lib);
    setLibrary(lib);
    if (getActiveId() === theme.id) deactivateTheme();
    if (draft?.id === theme.id) loadDraft(null);
    note('ok', t('settings.theme.deleted'));
  };

  const apply = (theme: Theme) => { activateTheme(theme); loadDraft(structuredClone(theme)); note('ok', t('settings.theme.applied')); };

  /** Drop any active custom theme — back to the built-in Ember palette. */
  const useDefault = () => { deactivateTheme(); loadDraft(null); note('ok', t('settings.theme.defaultApplied')); };

  const exportTheme = async (theme: Theme) => {
    setBusy(true);
    try {
      const r = await window.api.themes.export(theme, theme.name);
      if (r.success) note('ok', t('settings.theme.exported'));
    } catch { note('err', t('settings.theme.exportFailed')); }
    finally { setBusy(false); }
  };

  /** Footer export: the CURRENT draft (validated/cleaned first), saved or not. */
  const exportDraft = () => {
    if (!draft) return;
    const result = validateTheme({ ...draft, name: draft.name.trim() || t('settings.theme.newName') });
    if (!result.ok) { note('err', result.errors.join('; ')); return; }
    void exportTheme({ ...result.theme, id: draft.id || genThemeId() }).then(() => {
      // Surface silently-dropped invalid values — the file may differ from the
      // editor's unsaved state.
      if (result.warnings.length) note('err', t('settings.theme.exportedWarn'));
    });
  };

  const importTheme = async () => {
    setBusy(true);
    try {
      const r = await window.api.themes.import();
      if (!r.success) { if (r.error) note('err', t('settings.theme.importFailed')); return; }
      const v = validateTheme(r.data);
      if (!v.ok) { note('err', t('settings.theme.importInvalid')); return; }
      const clean: Theme = { ...v.theme, id: genThemeId(), name: v.theme.name || t('settings.theme.importedName') };
      const lib = [...loadLibrary(), clean];
      saveLibrary(lib);
      setLibrary(lib);
      loadDraft(structuredClone(clean));
      setTab('edit');
      note('ok', v.warnings.length ? t('settings.theme.importedWarn') : t('settings.theme.imported'));
    } catch { note('err', t('settings.theme.importFailed')); }
    finally { setBusy(false); }
  };

  // Discard an unsaved preview on close by re-applying the actually-active theme
  // in the app's real mode.
  const handleClose = () => {
    const active = getActiveTheme();
    if (active) applyThemeObject(active); else revertToBase();
    onClose();
  };

  const swatchOf = (theme: Theme) =>
    theme.dark['--color-accent-primary'] || theme.light['--color-accent-primary'] || 'var(--color-accent-primary)';

  // Inspect mode: hover highlights any app element, click maps it to the token
  // coloring it and jumps there. Capture-phase listeners so the click never
  // reaches the app; clicks inside the dock pass through so the UI stays usable.
  useEffect(() => {
    if (!inspecting) { setInspectRect(null); return; }
    // The dock (expanded panel OR the collapsed reopen tab) must stay interactive.
    const inDock = (el: Element | null) => !!el && !!el.closest('.ted, .ted-reopen');
    const onMove = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (inDock(el) || !el) { setInspectRect(null); return; }
      const r = el.getBoundingClientRect();
      setInspectRect({ x: r.left, y: r.top, w: r.width, h: r.height });
    };
    // Swallow the whole press (down + up + click) on app elements so nothing —
    // focus, text-selection, a pointerdown-activated control — reacts while
    // inspecting; only the click actually maps + jumps.
    const swallow = (e: Event) => {
      const el = e.target as Element | null;
      if (inDock(el) || !el) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onClick = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (inDock(el) || !el) return; // dock clicks work normally
      e.preventDefault();
      e.stopPropagation();
      const token = tokenForElement(el);
      setInspecting(false);
      if (token) {
        setEditMode('advanced');
        setOnlyChanged(false); // else an un-overridden hit is filtered out of view
        setSearch(token);
        setTab('edit');
        note('ok', `${t('settings.theme.inspectFound')} ${token}`);
      } else {
        note('err', t('settings.theme.inspectNone'));
      }
      // The pick click focused the MAIN window — bring the popped-out editor
      // (where the jumped-to token now shows) back to front.
      const w = popoutRef.current;
      if (w && !w.closed) w.focus();
    };
    document.body.classList.add('te-inspecting');
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerdown', swallow, true);
    window.addEventListener('mousedown', swallow, true);
    window.addEventListener('click', onClick, true);
    return () => {
      document.body.classList.remove('te-inspecting');
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerdown', swallow, true);
      window.removeEventListener('mousedown', swallow, true);
      window.removeEventListener('click', onClick, true);
      setInspectRect(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspecting]);

  // Collapsed → a small edge tab that re-opens the panel (the draft stays applied
  // to :root, so the app remains recolored while the panel is tucked away).
  // Never while popped out — the editor lives in its own window then.
  if (collapsed && !popout) {
    return (
      <button
        type="button"
        className="ted-reopen"
        data-side={side}
        onClick={() => setCollapsed(false)}
        title={t('settings.theme.expand')}
        aria-label={t('settings.theme.expand')}
      >
        <Icon name="sun" size={16} />
      </button>
    );
  }

  const PREVIEW_PAGES: { id: PreviewPage; labelKey: string }[] = [
    { id: 'overview', labelKey: 'settings.theme.preview.overview' },
    { id: 'downloads', labelKey: 'settings.theme.preview.downloads' },
    { id: 'rooms', labelKey: 'settings.theme.preview.rooms' },
    { id: 'chat', labelKey: 'settings.theme.preview.chat' },
    { id: 'forms', labelKey: 'settings.theme.preview.forms' },
  ];

  // ── token control renderers (shared by Simple + Advanced) ──────────────────
  const applyBothTitle = t('settings.theme.applyBoth');
  const eyedropperTitle = t('settings.theme.eyedropper');
  const resetTitle = t('settings.theme.reset');
  const sliderTitles = { h: t('settings.theme.hsl.h'), s: t('settings.theme.hsl.s'), l: t('settings.theme.hsl.l'), a: t('settings.theme.hsl.a') };

  // A base value can legitimately be un-sanitizable (a var()-referencing gradient,
  // a multi-layer shadow) — only flag the red outline for a USER override that
  // fails, never for the untouched default.
  const tokenValid = (token: string, v: string): boolean => !hasOverride(token) || sanitizeTokenValue(token, v) !== null;

  const renderColorToken = (token: string, labelNode: React.ReactNode, format: 'auto' | 'triplet') => {
    const v = valueOf(token);
    return (
      <ColorField key={token} label={labelNode} value={v} valid={tokenValid(token, v)} format={format}
        onChange={(nv) => setToken(token, nv)} onApplyBoth={(nv) => setTokenBoth(token, nv)}
        onReset={hasOverride(token) ? () => resetToken(token) : undefined}
        applyBothTitle={applyBothTitle} eyedropperTitle={eyedropperTitle} resetTitle={resetTitle} sliderTitles={sliderTitles} />
    );
  };

  const renderTextToken = (token: string, labelNode: React.ReactNode) => {
    const v = valueOf(token);
    const valid = tokenValid(token, v);
    return (
      <label key={token} className="te-token te-token--len">
        <span className="te-token-label">{labelNode}</span>
        <input type="text" className={`te-token-text ${valid ? '' : 'te-invalid'}`} value={v} spellCheck={false}
          onChange={(e) => setToken(token, e.target.value)} />
        {hasOverride(token) && (
          <button type="button" className="cf-icon" title={resetTitle} aria-label={resetTitle} onClick={() => resetToken(token)}>
            <Icon name="rotate-ccw" size={13} />
          </button>
        )}
      </label>
    );
  };

  const renderToken = (token: string, labelNode: React.ReactNode) => {
    const cat = tokenCategory(token);
    if (cat === 'color') return renderColorToken(token, labelNode, 'auto');
    if (cat === 'colorTriplet') return renderColorToken(token, labelNode, 'triplet');
    return renderTextToken(token, labelNode);
  };

  const matchesFilter = (token: string): boolean => {
    const q = search.trim().toLowerCase();
    if (q && !token.toLowerCase().includes(q)) return false;
    if (onlyChanged && !hasOverride(token)) return false;
    return true;
  };
  const advancedGroups = ADVANCED_GROUPS
    .map((g) => ({ ...g, tokens: g.tokens.filter(matchesFilter) }))
    .filter((g) => g.tokens.length > 0);

  const adaptLabel = variant === 'light' ? t('settings.theme.adaptFromLight') : t('settings.theme.adaptFromDark');
  const toolbar = (
    <div className="te-toolbar">
      <button type="button" className="te-tool" onClick={undo} disabled={!undoStack.length} title={t('settings.theme.undo')} aria-label={t('settings.theme.undo')}>
        <Icon name="rotate-ccw" size={14} />
      </button>
      <button type="button" className="te-tool" onClick={redo} disabled={!redoStack.length} title={t('settings.theme.redo')} aria-label={t('settings.theme.redo')}>
        <Icon name="rotate-cw" size={14} />
      </button>
      <span className="te-tool-sep" />
      <button type="button" className={`te-tool te-tool--wide ${inspecting ? 'active' : ''}`} onClick={() => setInspecting((v) => !v)} title={t('settings.theme.inspectHint')}>
        <Icon name="crosshair" size={14} /> {t('settings.theme.inspect')}
      </button>
      <button type="button" className="te-tool te-tool--wide" onClick={generateFromBase} title={t('settings.theme.generateHint')}>
        <Icon name="zap" size={14} /> {t('settings.theme.generate')}
      </button>
      <button type="button" className="te-tool te-tool--wide" onClick={adaptToOther} title={adaptLabel}>
        <Icon name={variant === 'light' ? 'moon' : 'sun'} size={14} /> {adaptLabel}
      </button>
    </div>
  );

  const modeToggleAndContrast = (
    <>
      <div className="te-mode-row">
        <div className="iface-seg" role="group">
          {(['simple', 'advanced'] as EditMode[]).map((m) => (
            <button key={m} type="button" className={editMode === m ? 'active' : ''} onClick={() => setEditMode(m)}>
              {t(`settings.theme.mode.${m}`)}
            </button>
          ))}
        </div>
      </div>
      <details className="te-contrast">
        <summary>{t('settings.theme.contrast')}</summary>
        <div className="te-contrast-body">
          {contrastRows.map((r) => (
            <div key={`${r.fg}|${r.bg}`} className="te-contrast-row">
              <span className="te-contrast-swatch" style={{ background: r.bgCss, color: r.fgCss }}>Aa</span>
              <span className="te-contrast-pair">{shortToken(r.fg)} <span className="te-contrast-on">/</span> {shortToken(r.bg)}</span>
              <span className="te-contrast-ratio">{r.ratio != null ? r.ratio.toFixed(2) : '—'}</span>
              <span className={`te-contrast-badge lvl-${r.level ?? 'na'}`}>{r.level ?? '—'}</span>
            </div>
          ))}
        </div>
      </details>
    </>
  );

  // The editor panel itself — rendered in place when docked, or portaled into
  // the pop-out window's body when detached.
  const editorNode = (
    <aside className="ted" data-side={side} data-popout={popout ? 'true' : undefined} style={popout ? undefined : { width }} role="region" aria-label={t('settings.theme.editorTitle')} onKeyDown={onDockKeyDown}>
      {!popout && <div className="ted-resize" onPointerDown={onResizeDown} role="separator" aria-orientation="vertical" />}

      <header className="ted-head">
        <h3 className="ted-title"><Icon name="sun" size={16} /> {t('settings.theme.editorTitle')}</h3>
        <div className="ted-head-actions">
          {!popout && (
            <button type="button" title={t('settings.theme.dockSide')} aria-label={t('settings.theme.dockSide')} onClick={flipSide}>
              <Icon name={side === 'right' ? 'chevron-left' : 'chevron-right'} size={16} />
            </button>
          )}
          {popout ? (
            <button type="button" title={t('settings.theme.popin')} aria-label={t('settings.theme.popin')} onClick={popIn}>
              <Icon name="pip" size={16} />
            </button>
          ) : (
            <button type="button" title={t('settings.theme.popout')} aria-label={t('settings.theme.popout')} onClick={openPopout}>
              <Icon name="external-link" size={16} />
            </button>
          )}
          {!popout && (
            <button type="button" title={t('settings.theme.collapse')} aria-label={t('settings.theme.collapse')} onClick={() => { setInspecting(false); setCollapsed(true); }}>
              <Icon name="minimize" size={16} />
            </button>
          )}
          <button type="button" title={t('common.close')} aria-label={t('common.close')} onClick={handleClose} disabled={busy}>
            <Icon name="x" size={16} />
          </button>
        </div>
      </header>

      <div className="ted-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'edit'} className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>
          {t('settings.theme.tab.edit')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>
          {t('settings.theme.tab.preview')}
        </button>
      </div>

      {tab === 'edit' ? (
        <div className="ted-body ted-edit">
          {/* Library */}
          <section className="te-list">
            <button type="button" className="te-new" onClick={createNew}>
              <Icon name="plus" size={15} /> {t('settings.theme.new')}
            </button>
            <div className={`te-row te-row-default ${!activeId ? 'te-row--sel' : ''}`}>
              <button type="button" className="te-row-main" onClick={useDefault} title={t('settings.theme.useDefault')}>
                <span className="te-swatch-dot" style={{ background: 'var(--color-accent-primary)' }} />
                <span className="te-row-name">{t('settings.theme.useDefault')}</span>
                {!activeId && <span className="te-badge">{t('settings.theme.active')}</span>}
              </button>
            </div>
            {library.length === 0 && <p className="te-empty">{t('settings.theme.empty')}</p>}
            {library.map((theme) => (
              <div key={theme.id} className={`te-row ${draft?.id === theme.id ? 'te-row--sel' : ''}`}>
                <button type="button" className="te-row-main" onClick={() => edit(theme)} title={theme.name}>
                  <span className="te-swatch-dot" style={{ background: swatchOf(theme) }} />
                  <span className="te-row-name">{theme.name}</span>
                  {activeId === theme.id && <span className="te-badge">{t('settings.theme.active')}</span>}
                </button>
                <div className="te-row-actions">
                  <button type="button" title={t('settings.theme.applyAction')} onClick={() => apply(theme)}><Icon name="check-circle" size={14} /></button>
                  <button type="button" title={t('settings.theme.duplicate')} onClick={() => duplicate(theme)}><Icon name="copy" size={14} /></button>
                  <button type="button" title={t('settings.theme.export')} onClick={() => exportTheme(theme)}><Icon name="download" size={14} /></button>
                  <button type="button" title={t('settings.theme.delete')} onClick={() => remove(theme)}><Icon name="trash" size={14} /></button>
                </div>
              </div>
            ))}
          </section>

          {/* Fields */}
          {!draft ? (
            <div className="te-placeholder">
              <Icon name="sun" size={28} />
              <p>{t('settings.theme.pickOrNew')}</p>
            </div>
          ) : (
            <div className="ted-fields">
              <div className="te-fields te-fields--head">
                <label className="te-field te-field--name">
                  <span>{t('settings.theme.name')}</span>
                  <input type="text" value={draft.name} maxLength={60}
                    onChange={(e) => { const name = e.target.value; editDraft((d) => ({ ...d, name }), 'name'); }} />
                </label>
                <div className="te-field">
                  <span>{t('settings.theme.variant')}</span>
                  <div className="iface-seg" role="group">
                    {(['dark', 'light'] as ThemeMode[]).map((m) => (
                      <button key={m} type="button" className={variant === m ? 'active' : ''} onClick={() => setVariant(m)}>
                        {t(`settings.theme.base.${m}`)}
                      </button>
                    ))}
                  </div>
                </div>
                <button type="button" className="te-copy-variant" onClick={copyToOther} title={t('settings.theme.copyVariant')}>
                  <Icon name="copy" size={13} /> {t('settings.theme.copyVariant')}
                </button>
              </div>

              {toolbar}
              {modeToggleAndContrast}

              {editMode === 'simple' ? (
                EDITABLE_TOKENS.map((group) => (
                  <div key={group.id} className="te-group">
                    <h4 className="te-group-title">{label(group.labelKey)}</h4>
                    <div className="te-group-body">
                      {group.kind === 'accent' && (
                        <label className="te-token te-token--accent">
                          <input type="color" className="accent-swatch" value={hexOf(valueOf('--color-accent-primary'))}
                            onChange={(e) => setAccent(e.target.value)} aria-label={label(group.labelKey)} />
                          <span className="te-token-label">{t('settings.theme.accentHint')}</span>
                        </label>
                      )}
                      {group.kind === 'font' && (
                        // A segmented control (not a Select) so there is no popup to
                        // clip against the dock's overflow; only 3 bundled families,
                        // plus an upload for a custom font.
                        <div className="te-token te-token--font">
                          <div className="iface-seg" role="group">
                            {FONT_OPTIONS.map((o) => (
                              <button key={o.id} type="button" className={currentFontId() === o.id ? 'active' : ''} onClick={() => setFont(o.id)}>
                                {o.label}
                              </button>
                            ))}
                          </div>
                          <div className="te-font-upload">
                            <button type="button" className="te-tool" onClick={() => fontInputRef.current?.click()}>
                              <Icon name="upload" size={13} /> {t('settings.theme.uploadFont')}
                            </button>
                            {draft.fontData && (
                              <span className="te-font-custom">
                                <Icon name="type" size={12} />
                                <span className="te-font-custom-name">{customFontName || t('settings.theme.customFont')}</span>
                                <button type="button" className="te-font-remove" onClick={clearCustomFont} title={t('settings.theme.removeFont')} aria-label={t('settings.theme.removeFont')}>
                                  <Icon name="x" size={12} />
                                </button>
                              </span>
                            )}
                            <input ref={fontInputRef} type="file" accept=".woff2,.woff,.ttf,.otf" style={{ display: 'none' }} onChange={onFontFile} />
                          </div>
                        </div>
                      )}
                      {group.kind === 'color' && group.tokens.map((tk) => renderToken(tk.token, label(tk.labelKey)))}
                      {group.kind === 'length' && group.tokens.map((tk) => renderToken(tk.token, label(tk.labelKey)))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="te-adv">
                  <div className="te-adv-filters">
                    <input type="text" className="te-search" placeholder={t('settings.theme.search')}
                      value={search} spellCheck={false} onChange={(e) => setSearch(e.target.value)} />
                    <label className="te-onlychanged">
                      <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
                      {t('settings.theme.onlyChanged')}
                    </label>
                  </div>
                  {advancedGroups.length === 0 ? (
                    <p className="te-empty">{t('settings.theme.noMatches')}</p>
                  ) : advancedGroups.map((group) => (
                    <div key={group.id} className="te-group">
                      <h4 className="te-group-title">{label(group.labelKey)} <span className="te-group-count">{group.tokens.length}</span></h4>
                      <div className="te-group-body">
                        {group.tokens.map((tk) => renderToken(tk, <code className="te-token-name">{tk}</code>))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="ted-body ted-preview">
          <div className="ted-preview-tabs" role="tablist">
            {PREVIEW_PAGES.map((p) => (
              <button key={p.id} type="button" role="tab" aria-selected={previewPage === p.id}
                className={previewPage === p.id ? 'active' : ''} onClick={() => setPreviewPage(p.id)}>
                {label(p.labelKey)}
              </button>
            ))}
          </div>
          <p className="ted-preview-hint">{t('settings.theme.preview.hint')}</p>
          <div className="te-gallery">
            {previewPage === 'overview' && (
              <div className="te-overview" aria-hidden="true">
                <div className="te-pv-app">
                  <div className="te-pv-side">
                    <span className="te-pv-dot" />
                    <span className="te-pv-line" />
                    <span className="te-pv-line te-pv-line--on" />
                    <span className="te-pv-line" />
                  </div>
                  <div className="te-pv-main">
                    <div className="te-pv-card">
                      <strong className="te-pv-title">Aa · {draft?.name || t('settings.theme.newName')}</strong>
                      <p className="te-pv-sub">Secondary text · <span className="te-pv-muted">tertiary</span></p>
                      <div className="te-pv-row">
                        <button type="button" tabIndex={-1} className="te-pv-btn te-pv-btn--primary">Primary</button>
                        <button type="button" tabIndex={-1} className="te-pv-btn te-pv-btn--ghost">Ghost</button>
                        <span className="te-pv-badge">Accent</span>
                      </div>
                      <div className="te-pv-row te-pv-chips">
                        <span className="te-pv-chip te-pv-chip--success" />
                        <span className="te-pv-chip te-pv-chip--warning" />
                        <span className="te-pv-chip te-pv-chip--error" />
                        <span className="te-pv-chip te-pv-chip--info" />
                      </div>
                      <div className="te-pv-bar"><span className="te-pv-bar-fill" /></div>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {previewPage === 'downloads' && <DownloadsSample />}
            {previewPage === 'rooms' && <RoomsSample />}
            {previewPage === 'chat' && <ChatSample />}
            {previewPage === 'forms' && <FormsSample />}
          </div>
        </div>
      )}

      <footer className="ted-foot">
        {status && <span className={`te-status te-status--${status.kind}`}>{status.text}</span>}
        <Button variant="ghost" size="sm" icon={<Icon name="upload" size={15} />} onClick={importTheme} disabled={busy}>
          {t('settings.theme.import')}
        </Button>
        <Button variant="ghost" size="sm" icon={<Icon name="download" size={15} />} onClick={exportDraft} disabled={!draft || busy}>
          {t('settings.theme.export')}
        </Button>
        <Button variant="primary" size="sm" icon={<Icon name="check" size={15} />} onClick={save} disabled={!draft}>
          {t('settings.theme.save')}
        </Button>
      </footer>
    </aside>
  );

  // The inspect highlight always lives in the MAIN document — it outlines app
  // elements there, even while the editor itself sits in the pop-out window.
  return (
    <>
      {inspecting && inspectRect && (
        <div className="te-inspect-box" style={{ left: inspectRect.x, top: inspectRect.y, width: inspectRect.w, height: inspectRect.h }} />
      )}
      {popout && !popout.closed ? createPortal(editorNode, popout.document.body) : editorNode}
    </>
  );
};

export default ThemeEditor;
