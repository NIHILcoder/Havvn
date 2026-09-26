import React from 'react';
import { normalizePlayerPreferences, type PlayerPreferences } from '../../shared/player-preferences';
import { useTranslation } from '../utils/i18nContext';
import './PlayerPreferencesPanel.css';
interface Props { prefs: PlayerPreferences; onChange(prefs: PlayerPreferences): void; onResetFile(): void }
const LANGUAGES = ['ru', 'en', 'uk', 'ja', 'ko', 'zh', 'fr', 'de', 'es', 'it', 'pt', 'pl', 'tr'] as const;
export function PlayerPreferencesPanel({ prefs, onChange, onResetFile }: Props) {
  const { t } = useTranslation();
  const update = (partial: Partial<PlayerPreferences>) => onChange(normalizePlayerPreferences({ ...prefs, ...partial }));
  const languageOptions = (current: string) => <>
    <option value="">{t('player.preferences.noLanguage')}</option>
    {LANGUAGES.map(lang => <option key={lang} value={lang}>{t(`player.language.${lang}`)}</option>)}
    {current && !(LANGUAGES as readonly string[]).includes(current) && <option value={current}>{current.toUpperCase()}</option>}
  </>;
  return <details className="player-preferences" onToggle={event => {
    if (event.currentTarget.open) { const other = event.currentTarget.parentElement?.querySelector<HTMLDetailsElement>('.episode-prefetch'); if (other) other.open = false; }
  }}>
    <summary>{t('player.preferences.title')}</summary>
    <div className="player-preferences-grid">
      <label>{t('player.preferences.audio')}<select value={prefs.audioLanguage} onChange={e => update({ audioLanguage: e.target.value })}>{languageOptions(prefs.audioLanguage)}</select></label>
      <label>{t('player.preferences.subLanguage')}<select value={prefs.subtitleLanguage} onChange={e => update({ subtitleLanguage: e.target.value })}>{languageOptions(prefs.subtitleLanguage)}</select></label>
      <label>{t('player.preferences.subMode')}<select value={prefs.subtitleMode} onChange={e => update({ subtitleMode: e.target.value as PlayerPreferences['subtitleMode'] })}>{(['off', 'auto', 'on'] as const).map(mode => <option key={mode} value={mode}>{t(`player.preferences.${mode}`)}</option>)}</select></label>
      <label>{t('player.preferences.size')}<select value={prefs.subtitleSize} onChange={e => update({ subtitleSize: Number(e.target.value) })}>{[75, 100, 125, 150, 175, 200, ...(![75, 100, 125, 150, 175, 200].includes(prefs.subtitleSize) ? [prefs.subtitleSize] : [])].map(size => <option key={size} value={size}>{size}%</option>)}</select></label>
      <label>{t('player.preferences.color')}<input type="color" value={prefs.subtitleColor} onChange={e => update({ subtitleColor: e.target.value })} /></label>
      <label>{t('player.preferences.background')}<select value={prefs.subtitleBackground} onChange={e => update({ subtitleBackground: e.target.value as PlayerPreferences['subtitleBackground'] })}><option value="dark">{t('player.preferences.dark')}</option><option value="none">{t('player.preferences.none')}</option></select></label>
      <label>{t('player.preferences.delay')}<input type="number" min={-60} max={60} step={0.1} value={prefs.subtitleDelay} onChange={e => update({ subtitleDelay: Number(e.target.value) })} /></label>
    </div>
    <p>{t('player.preferences.hint')}</p>
    <div className="player-preferences-actions"><button type="button" onClick={onResetFile}>{t('player.preferences.resetFile')}</button><button type="button" onClick={() => onChange(normalizePlayerPreferences(null))}>{t('player.preferences.reset')}</button></div>
  </details>;
}
