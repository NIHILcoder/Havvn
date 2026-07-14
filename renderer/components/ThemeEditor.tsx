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
import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Button } from './Button';
import Icon from './Icon';
import { useTranslation } from '../utils/i18nContext';
import {
  Theme, ThemeMode, EDITABLE_TOKENS, FONT_OPTIONS, deriveAccent, validateTheme,
  sanitizeTokenValue, clearAppliedTheme, TOKEN_WHITELIST,
} from '../../shared/theme';
import {
  loadLibrary, saveLibrary, getActiveId, getActiveTheme, genThemeId,
  applyThemeObject, previewTheme, activateTheme, deactivateTheme, revertToBase, resolvedMode,
} from '../utils/theme-library';
import { DownloadsSample, RoomsSample, ChatSample, FormsSample } from './theme-preview/GallerySamples';
import './ThemeEditor.css';

const EDITABLE_TOKEN_NAMES = EDITABLE_TOKENS.flatMap((g) => g.tokens.map((tk) => tk.token));

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
/** Clamp a width to [MIN, MAX] and to the viewport, so the dock can never eat
 *  the whole app on a narrow window (leave ~160px of app visible). */
const clampWidth = (w: number): number => {
  const viewportCap = (typeof window !== 'undefined' ? window.innerWidth : DOCK_MAX) - 160;
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
  // Snapshot EVERY whitelisted inline override — not just the editable ones —
  // so clearing to read the base palette and then restoring doesn't drop the
  // non-editable overrides (e.g. an imported theme's gradients/shadows). With
  // the dock, the real app is visible behind us, so a dropped override would
  // flash to base until the preview effect repaints it.
  const saved: Record<string, string> = {};
  for (const token of TOKEN_WHITELIST) saved[token] = el.style.getPropertyValue(token);
  clearAppliedTheme(el);
  el.setAttribute('data-theme', mode);
  const out: Record<string, string> = {};
  const cs = getComputedStyle(el);
  for (const token of EDITABLE_TOKEN_NAMES) out[token] = cs.getPropertyValue(token).trim();
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
    if (collapsed) { delete el.dataset.teDock; el.style.removeProperty('--te-dock-w'); }
    else { el.dataset.teDock = side; el.style.setProperty('--te-dock-w', `${width}px`); }
  }, [side, width, collapsed]);
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

  const paletteKey = variant === 'light' ? 'light' : 'dark';
  const valueOf = (token: string): string =>
    (draft && draft[paletteKey][token] !== undefined ? draft[paletteKey][token] : defaults[token]) ?? '';

  const setToken = (token: string, value: string) =>
    setDraft((d) => (d ? { ...d, [paletteKey]: { ...d[paletteKey], [token]: value } } : d));

  const setAccent = (hex: string) => {
    const derived = deriveAccent(hex);
    if (derived) setDraft((d) => (d ? { ...d, [paletteKey]: { ...d[paletteKey], ...derived } } : d));
  };

  const currentFontId = (): string => FONT_OPTIONS.find((o) => o.stack === draft?.font)?.id ?? 'inter';
  const setFont = (id: string) => {
    const stack = FONT_OPTIONS.find((o) => o.id === id)?.stack;
    setDraft((d) => (d ? { ...d, font: id === 'inter' ? undefined : stack } : d));
  };

  // ── dock chrome actions ────────────────────────────────────────────────────
  const flipSide = () => setSide((s) => {
    const next = s === 'right' ? 'left' : 'right';
    writePref(SIDE_KEY, next);
    return next;
  });

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

  // ── theme lifecycle ──────────────────────────────────────────────────────
  const createNew = () => { setDraft(emptyTheme(t('settings.theme.newName'))); setTab('edit'); note('ok', t('settings.theme.newHint')); };
  const duplicate = (theme: Theme) => {
    setDraft({ ...structuredClone(theme), id: genThemeId(), name: `${theme.name} ${t('settings.theme.copySuffix')}` });
    setTab('edit');
  };
  const edit = (theme: Theme) => { setDraft(structuredClone(theme)); setTab('edit'); };

  /** Copy the variant you're editing onto the other one (bootstrap the pair). */
  const copyToOther = () => setDraft((d) => {
    if (!d) return d;
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
    setDraft(structuredClone(clean));
    note('ok', t('settings.theme.saved'));
  };

  const remove = (theme: Theme) => {
    const lib = loadLibrary().filter((x) => x.id !== theme.id);
    saveLibrary(lib);
    setLibrary(lib);
    if (getActiveId() === theme.id) deactivateTheme();
    if (draft?.id === theme.id) setDraft(null);
    note('ok', t('settings.theme.deleted'));
  };

  const apply = (theme: Theme) => { activateTheme(theme); setDraft(structuredClone(theme)); note('ok', t('settings.theme.applied')); };

  /** Drop any active custom theme — back to the built-in Ember palette. */
  const useDefault = () => { deactivateTheme(); setDraft(null); note('ok', t('settings.theme.defaultApplied')); };

  const exportTheme = async (theme: Theme) => {
    setBusy(true);
    try {
      const r = await window.api.themes.export(theme, theme.name);
      if (r.success) note('ok', t('settings.theme.exported'));
    } catch { note('err', t('settings.theme.exportFailed')); }
    finally { setBusy(false); }
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
      setDraft(structuredClone(clean));
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

  // Collapsed → a small edge tab that re-opens the panel (the draft stays applied
  // to :root, so the app remains recolored while the panel is tucked away).
  if (collapsed) {
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

  return (
    <aside className="ted" data-side={side} style={{ width }} role="region" aria-label={t('settings.theme.editorTitle')}>
      <div className="ted-resize" onPointerDown={onResizeDown} role="separator" aria-orientation="vertical" />

      <header className="ted-head">
        <h3 className="ted-title"><Icon name="sun" size={16} /> {t('settings.theme.editorTitle')}</h3>
        <div className="ted-head-actions">
          <button type="button" title={t('settings.theme.dockSide')} aria-label={t('settings.theme.dockSide')} onClick={flipSide}>
            <Icon name={side === 'right' ? 'chevron-left' : 'chevron-right'} size={16} />
          </button>
          <button type="button" title={t('settings.theme.collapse')} aria-label={t('settings.theme.collapse')} onClick={() => setCollapsed(true)}>
            <Icon name="minimize" size={16} />
          </button>
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
                    onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))} />
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

              {EDITABLE_TOKENS.map((group) => (
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
                      // clip against the dock's overflow; only 3 bundled families.
                      <div className="te-token te-token--font">
                        <div className="iface-seg" role="group">
                          {FONT_OPTIONS.map((o) => (
                            <button key={o.id} type="button" className={currentFontId() === o.id ? 'active' : ''} onClick={() => setFont(o.id)}>
                              {o.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {group.kind === 'color' && group.tokens.map((tk) => {
                      const v = valueOf(tk.token);
                      const valid = sanitizeTokenValue(tk.token, v) !== null;
                      return (
                        <label key={tk.token} className="te-token">
                          <input type="color" className="accent-swatch" value={hexOf(v)}
                            onChange={(e) => setToken(tk.token, e.target.value)} aria-label={label(tk.labelKey)} />
                          <span className="te-token-label">{label(tk.labelKey)}</span>
                          <input type="text" className={`te-token-text ${valid ? '' : 'te-invalid'}`}
                            value={v} spellCheck={false}
                            onChange={(e) => setToken(tk.token, e.target.value)} />
                        </label>
                      );
                    })}
                    {group.kind === 'length' && group.tokens.map((tk) => {
                      const v = valueOf(tk.token);
                      const valid = sanitizeTokenValue(tk.token, v) !== null;
                      return (
                        <label key={tk.token} className="te-token te-token--len">
                          <span className="te-token-label">{label(tk.labelKey)}</span>
                          <input type="text" className={`te-token-text ${valid ? '' : 'te-invalid'}`}
                            value={v} spellCheck={false} placeholder="10px"
                            onChange={(e) => setToken(tk.token, e.target.value)} />
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
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
        <Button variant="primary" size="sm" icon={<Icon name="check" size={15} />} onClick={save} disabled={!draft}>
          {t('settings.theme.save')}
        </Button>
      </footer>
    </aside>
  );
};

export default ThemeEditor;
