import React from 'react';
import { normalizePlayerPreferences, type PlayerPreferences } from '../../shared/player-preferences';
import { useTranslation } from '../utils/i18nContext';
import { Select } from './Select';
import { NumberInput } from './NumberInput';
import { Button } from './Button';
import { Icon } from './Icon';
import './PlayerPreferencesPanel.css';
interface Props { prefs: PlayerPreferences; onChange(prefs: PlayerPreferences): void; onResetFile(): void }
const LANGUAGES = ['ru', 'en', 'uk', 'ja', 'ko', 'zh', 'fr', 'de', 'es', 'it', 'pt', 'pl', 'tr'] as const;
export function PlayerPreferencesPanel({ prefs, onChange, onResetFile }: Props) {
  const { t } = useTranslation();
  const update = (partial: Partial<PlayerPreferences>) => onChange(normalizePlayerPreferences({ ...prefs, ...partial }));
  const languageOptions = (current: string) => [
    { value: '', label: t('player.preferences.noLanguage') },
    ...LANGUAGES.map(value => ({ value, label: t(`player.language.${value}`) })),
    ...(current && !(LANGUAGES as readonly string[]).includes(current) ? [{ value: current, label: current.toUpperCase() }] : []),
  ];
  return <details className="player-preferences" onToggle={event => {
    if (event.currentTarget.open) { const other = event.currentTarget.parentElement?.querySelector<HTMLDetailsElement>('.episode-prefetch'); if (other) other.open = false; }
  }}>
    <summary><Icon name="chevron-right" size={14} />{t('player.preferences.title')}</summary>
    <div className="player-preferences-grid">
      <label>{t('player.preferences.audio')}<Select value={prefs.audioLanguage} onChange={value => update({ audioLanguage: value })}
        ariaLabel={t('player.preferences.audio')} options={languageOptions(prefs.audioLanguage)} /></label>
      <label>{t('player.preferences.subLanguage')}<Select value={prefs.subtitleLanguage} onChange={value => update({ subtitleLanguage: value })}
        ariaLabel={t('player.preferences.subLanguage')} options={languageOptions(prefs.subtitleLanguage)} /></label>
      <label>{t('player.preferences.subMode')}<Select value={prefs.subtitleMode} onChange={value => update({ subtitleMode: value as PlayerPreferences['subtitleMode'] })}
        ariaLabel={t('player.preferences.subMode')} options={(['off', 'auto', 'on'] as const).map(value => ({ value, label: t(`player.preferences.${value}`) }))} /></label>
      <label>{t('player.preferences.size')}<Select value={String(prefs.subtitleSize)} onChange={value => update({ subtitleSize: Number(value) })}
        ariaLabel={t('player.preferences.size')} options={[75, 100, 125, 150, 175, 200, ...(![75, 100, 125, 150, 175, 200].includes(prefs.subtitleSize) ? [prefs.subtitleSize] : [])].map(size => ({ value: String(size), label: `${size}%` }))} /></label>
      <label>{t('player.preferences.color')}<span className="player-subtitle-color"><input className="accent-swatch" type="color" value={prefs.subtitleColor} onChange={e => update({ subtitleColor: e.target.value })} /><span>{prefs.subtitleColor.toUpperCase()}</span></span></label>
      <label>{t('player.preferences.background')}<Select value={prefs.subtitleBackground} onChange={value => update({ subtitleBackground: value as PlayerPreferences['subtitleBackground'] })}
        ariaLabel={t('player.preferences.background')} options={(['dark', 'none'] as const).map(value => ({ value, label: t(`player.preferences.${value}`) }))} /></label>
      <label>{t('player.preferences.delay')}<NumberInput className="form-input" min={-60} max={60} step={0.1} value={prefs.subtitleDelay} onValueChange={value => update({ subtitleDelay: Number(value) })} /></label>
    </div>
    <p>{t('player.preferences.hint')}</p>
    <div className="player-preferences-actions"><Button type="button" variant="secondary" size="sm" onClick={onResetFile}>{t('player.preferences.resetFile')}</Button><Button type="button" variant="ghost" size="sm" onClick={() => onChange(normalizePlayerPreferences(null))}>{t('player.preferences.reset')}</Button></div>
  </details>;
}
