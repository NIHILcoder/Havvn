import React from 'react';
import { RESOLUTIONS, VOICES } from '../../shared/release-metadata';
import { DEFAULT_SEARCH_PREFERENCES, SEARCH_PREFERENCE_PRESETS, type SearchPreferences } from '../../shared/search-preferences';
import { useTranslation } from '../utils/i18nContext';

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
        <select className="form-select preference-preset" value={preset} onChange={e => {
          if (e.target.value === 'custom') return;
          onChange({ ...(SEARCH_PREFERENCE_PRESETS[e.target.value] ?? DEFAULT_SEARCH_PREFERENCES) });
          onRankedChange(e.target.value !== 'none');
        }}>
          <option value="none">{t('search.preferences.none')}</option>
          <option value="hd">1080p · ≤ 15 GiB</option>
          <option value="uhd">2160p · ≤ 40 GiB</option>
          <option value="compact">720p · ≤ 5 GiB</option>
          {preset === 'custom' && <option value="custom">{t('search.preferences.custom')}</option>}
        </select>
      </label>
      <label>{t('search.media.resolution')}<select className="form-select" value={value.resolution} onChange={e => update('resolution', e.target.value)}>
        <option value="">{t('search.media.any')}</option>{RESOLUTIONS.map(r => <option key={r}>{r}</option>)}
      </select></label>
      <label>{t('search.media.voice')}<select className="form-select" value={value.voice} onChange={e => update('voice', e.target.value)}>
        <option value="">{t('search.media.any')}</option>{VOICES.map(v => <option key={v} value={v}>{t(`search.media.voice${v}`)}</option>)}
      </select></label>
      <label>{t('search.preferences.language')}<select className="form-select" value={value.language} onChange={e => update('language', e.target.value)}>
        <option value="">{t('search.media.any')}</option><option value="ru">{t('search.preferences.ru')}</option><option value="en">{t('search.preferences.en')}</option>
      </select></label>
      <label>{t('search.media.maxSize')}<input className="form-input" type="number" min="0" step="0.5" value={value.maxGiB} onChange={e => update('maxGiB', e.target.value)} placeholder={t('search.preferences.unlimited')} /></label>
      <label>{t('search.minSeeds')}<input className="form-input" type="number" min="0" step="1" value={value.minSeeds} onChange={e => update('minSeeds', e.target.value)} placeholder={t('search.preferences.unlimited')} /></label>
    </div>
    <div className="search-preference-footer">
      <label><input type="checkbox" checked={ranked} disabled={!active} onChange={e => onRankedChange(e.target.checked)} />{t('search.preferences.rank')}</label>
      <button type="button" className="filter-toggle" onClick={() => { onChange({ ...DEFAULT_SEARCH_PREFERENCES }); onRankedChange(false); }}>{t('search.preferences.reset')}</button>
    </div>
    <p className="search-preference-hint">{t('search.preferences.metadataHint')}</p>
  </details>;
}
