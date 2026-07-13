/**
 * Theme editor — create, tune, save, share and apply custom themes.
 *
 * Live preview is the whole trick: editing mutates a draft Theme and applies it
 * to :root immediately (via the theme-library apply path), so the app behind the
 * modal recolors as you drag a picker. Saving persists the draft into the
 * localStorage library and makes it active; closing without saving re-applies
 * whatever was actually active, discarding the preview.
 *
 * Every value the user types is bounced through sanitizeTokenValue for the
 * red-outline validity hint, and the whole draft goes through validateTheme on
 * save and on import — the same trust boundary an imported file crosses.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Select } from './Select';
import Icon from './Icon';
import { useTranslation } from '../utils/i18nContext';
import {
  Theme, ThemeBase, EDITABLE_TOKENS, FONT_OPTIONS, deriveAccent, validateTheme,
  sanitizeTokenValue, clearAppliedTheme,
} from '../../shared/theme';
import {
  loadLibrary, saveLibrary, getActiveId, getActiveTheme, genThemeId,
  applyThemeObject, activateTheme, deactivateTheme, revertToBase,
} from '../utils/theme-library';
import './ThemeEditor.css';

const EDITABLE_TOKEN_NAMES = EDITABLE_TOKENS.flatMap((g) => g.tokens.map((tk) => tk.token));

/**
 * Read the stylesheet default of every editable token under `base`, without a
 * visible flash: snapshot inline overrides, clear them, flip data-theme, read
 * (getComputedStyle is synchronous), then restore — all in one JS tick.
 */
function readBaseDefaults(base: ThemeBase): Record<string, string> {
  const el = document.documentElement;
  const prevAttr = el.getAttribute('data-theme');
  const saved: Record<string, string> = {};
  for (const token of EDITABLE_TOKEN_NAMES) saved[token] = el.style.getPropertyValue(token);
  clearAppliedTheme(el);
  el.setAttribute('data-theme', base);
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
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Defaults for the draft's base — seeds every editable field's shown value.
  // Keyed on the base alone so token edits don't re-read (which would briefly
  // clear the very overrides being previewed).
  const base = draft?.base;
  const defaults = useMemo(() => (base ? readBaseDefaults(base) : {}), [base]);

  // Live preview: apply the draft to the running app on every edit.
  useEffect(() => { if (draft) applyThemeObject(draft); }, [draft]);

  const activeId = getActiveId();

  const note = (kind: 'ok' | 'err', text: string) => setStatus({ kind, text });

  const valueOf = (token: string): string =>
    (draft && draft.tokens[token] !== undefined ? draft.tokens[token] : defaults[token]) ?? '';

  const setToken = (token: string, value: string) =>
    setDraft((d) => (d ? { ...d, tokens: { ...d.tokens, [token]: value } } : d));

  const setAccent = (hex: string) => {
    const derived = deriveAccent(hex);
    if (derived) setDraft((d) => (d ? { ...d, tokens: { ...d.tokens, ...derived } } : d));
  };

  const setFont = (id: string) => {
    const stack = FONT_OPTIONS.find((o) => o.id === id)?.stack;
    if (stack) setToken('--font-family', stack);
  };

  const currentFontId = (): string => {
    const cur = valueOf('--font-family');
    return FONT_OPTIONS.find((o) => o.stack === cur)?.id ?? 'inter';
  };

  // ── theme lifecycle ──────────────────────────────────────────────────────
  const createNew = () => {
    setDraft({ id: genThemeId(), name: t('settings.theme.newName'), base: 'dark', tokens: {} });
    note('ok', t('settings.theme.newHint'));
  };

  const duplicate = (theme: Theme) =>
    setDraft({ ...structuredClone(theme), id: genThemeId(), name: `${theme.name} ${t('settings.theme.copySuffix')}` });

  const edit = (theme: Theme) => setDraft(structuredClone(theme));

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
      note('ok', v.warnings.length ? t('settings.theme.importedWarn') : t('settings.theme.imported'));
    } catch { note('err', t('settings.theme.importFailed')); }
    finally { setBusy(false); }
  };

  // Discard an unsaved preview on close by re-applying the actually-active theme.
  const handleClose = () => {
    const active = getActiveTheme();
    if (active) applyThemeObject(active); else revertToBase();
    onClose();
  };

  const footer = (
    <div className="te-foot">
      {status && <span className={`te-status te-status--${status.kind}`}>{status.text}</span>}
      <Button variant="ghost" size="sm" icon={<Icon name="upload" size={15} />} onClick={importTheme} disabled={busy}>
        {t('settings.theme.import')}
      </Button>
      <Button variant="primary" size="sm" icon={<Icon name="check" size={15} />} onClick={save} disabled={!draft}>
        {t('settings.theme.save')}
      </Button>
    </div>
  );

  return (
    <Modal onClose={handleClose} title={t('settings.theme.editorTitle')} icon="sun" size="xl" footer={footer} busy={busy} bodyClassName="te-body">
      <div className="te-grid">
        {/* Library list */}
        <aside className="te-list">
          <button type="button" className="te-new" onClick={createNew}>
            <Icon name="plus" size={15} /> {t('settings.theme.new')}
          </button>
          {library.length === 0 && <p className="te-empty">{t('settings.theme.empty')}</p>}
          {library.map((theme) => (
            <div key={theme.id} className={`te-row ${draft?.id === theme.id ? 'te-row--sel' : ''}`}>
              <button type="button" className="te-row-main" onClick={() => edit(theme)} title={theme.name}>
                <span className="te-swatch-dot" style={{ background: theme.tokens['--color-accent-primary'] || 'var(--color-accent-primary)' }} />
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
        </aside>

        {/* Editing panel */}
        <section className="te-edit">
          {!draft ? (
            <div className="te-placeholder">
              <Icon name="sun" size={28} />
              <p>{t('settings.theme.pickOrNew')}</p>
            </div>
          ) : (
            <>
              <div className="te-fields te-fields--head">
                <label className="te-field te-field--name">
                  <span>{t('settings.theme.name')}</span>
                  <input type="text" value={draft.name} maxLength={60}
                    onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))} />
                </label>
                <div className="te-field">
                  <span>{t('settings.theme.base')}</span>
                  <div className="iface-seg" role="group">
                    {(['dark', 'light'] as ThemeBase[]).map((b) => (
                      <button key={b} type="button" className={draft.base === b ? 'active' : ''}
                        onClick={() => setDraft((d) => (d ? { ...d, base: b } : d))}>
                        {t(`settings.theme.base.${b}`)}
                      </button>
                    ))}
                  </div>
                </div>
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
                      <div className="te-token te-token--font">
                        <div style={{ width: 200 }}>
                          <Select
                            options={FONT_OPTIONS.map((o) => ({ value: o.id, label: o.label, icon: 'type' }))}
                            value={currentFontId()} onChange={setFont}
                          />
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
            </>
          )}
        </section>
      </div>
    </Modal>
  );
};

export default ThemeEditor;
