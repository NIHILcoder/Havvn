import React from 'react';
import { RESOLUTIONS, VOICES } from '../../shared/release-metadata';
import { DEFAULT_SEARCH_PREFERENCES, SEARCH_PREFERENCE_PRESETS, type SearchPreferences } from '../../shared/search-preferences';
import { useTranslation } from '../utils/i18nContext';
import { NumberInput } from './NumberInput';
import { Select } from './Select';

interface Props {
  value: SearchPreferences;
  ranked: boolean;
  onChange: (value: SearchPreferences) => void;
  onRankedChange: (ranked: boolean) => void;
}

export function SearchPreferencesPanel({ value, ranked, onChange, onRankedChange }: Props) {
  const { t } = useTranslation();
  const active = Object.values(value).some(Boolean);
  const preset = Object.entries(SEARCH_PREFERENCE_PRESETS).find(([, fields]) => JSON.stringify(fields) === JSON.stringify(value))?.[0] ?? (active ? 'custom' : 'none');
  const update = (key: keyof SearchPreferences, selected: string) => onChange({ ...value, [key]: selected });
  return <details className="search-preferences">
    <summary>{t('search.preferences.title')}{active && <span className="release-filter-status">{t(ranked ? 'search.preferences.ranked' : 'search.preferences.saved')}</span>}</summary>
    <p className="search-preference-hint">{t('search.preferences.hint')}</p>
    <div className="search-preference-fields">
      <label>{t('search.preferences.profile')}
        <Select className="preference-preset" value={preset} ariaLabel={t('search.preferences.profile')} onChange={selected => {
          if (selected === 'custom') return;
          onChange({ ...(SEARCH_PREFERENCE_PRESETS[selected] ?? DEFAULT_SEARCH_PREFERENCES) });
          onRankedChange(selected !== 'none');
        }} options={[
          { value: 'none', label: t('search.preferences.none') },
          { value: 'hd', label: '1080p · ≤ 15 GiB' },
          { value: 'uhd', label: '2160p · ≤ 40 GiB' },
          { value: 'compact', label: '720p · ≤ 5 GiB' },
          ...(preset === 'custom' ? [{ value: 'custom', label: t('search.preferences.custom') }] : []),
        ]} />
      </label>
      <label>{t('search.media.resolution')}<Select value={value.resolution} onChange={selected => update('resolution', selected)}
        ariaLabel={t('search.media.resolution')} options={[{ value: '', label: t('search.media.any') }, ...RESOLUTIONS.map(value => ({ value, label: value }))]} /></label>
      <label>{t('search.media.voice')}<Select value={value.voice} onChange={selected => update('voice', selected)}
        ariaLabel={t('search.media.voice')} options={[{ value: '', label: t('search.media.any') }, ...VOICES.map(value => ({ value, label: t(`search.media.voice${value}`) }))]} /></label>
      <label>{t('search.preferences.language')}<Select value={value.language} onChange={selected => update('language', selected)}
        ariaLabel={t('search.preferences.language')} options={[{ value: '', label: t('search.media.any') }, ...(['ru', 'en'] as const).map(value => ({ value, label: t(`search.preferences.${value}`) }))]} /></label>
      <label>{t('search.media.maxSize')}<NumberInput className="form-input" min="0" step="0.5" value={value.maxGiB} onValueChange={value => update('maxGiB', value)} placeholder={t('search.preferences.unlimited')} /></label>
      <label>{t('search.minSeeds')}<NumberInput className="form-input" min="0" step="1" value={value.minSeeds} onValueChange={value => update('minSeeds', value)} placeholder={t('search.preferences.unlimited')} /></label>
    </div>
    <div className="search-preference-footer">
      <label><input type="checkbox" checked={ranked} disabled={!active} onChange={e => onRankedChange(e.target.checked)} />{t('search.preferences.rank')}</label>
      <button type="button" className="filter-toggle" onClick={() => { onChange({ ...DEFAULT_SEARCH_PREFERENCES }); onRankedChange(false); }}>{t('search.preferences.reset')}</button>
    </div>
    <p className="search-preference-hint">{t('search.preferences.metadataHint')}</p>
  </details>;
}
