import React, { useState } from 'react';
import { Button } from './Button';
import { Select } from './Select';
import { Toggle } from './Toggle';
import { useTranslation } from '../utils/i18nContext';
import { APPEARANCE_PRESETS, APPEARANCE_SCOPES, getThemeGlass, type ThemeGlass, type AppearanceScope } from '../../shared/appearance';
import './GlassControls.css';
function GlassRow({ label, description, control, stack }: { label: string; description?: string; control: React.ReactNode; stack?: boolean }) {
  return <div className={stack ? 'glass-row glass-row--stack' : 'glass-row'}><div className="glass-label"><span>{label}</span>
    {description && <p className="ap-hint">{description}</p>}</div><div className="glass-control">{control}</div></div>;
}
/** Controlled draft fields: all changes flow through the theme editor's history. */
export function GlassControls({ value: prefs, onChange }: { value: ThemeGlass; onChange: (value: ThemeGlass, key?: string) => void }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState('aero');
  const update = (patch: Partial<ThemeGlass>) => onChange({ ...prefs, ...patch }, Object.keys(patch).length === 1 ? Object.keys(patch)[0] : undefined);
  const slider = (key: 'intensity' | 'opacity' | 'blur' | 'tint' | 'highlight' | 'depth', min: number, max: number) => (
    <label className="ap-slider"><input type="range" min={min} max={max} value={prefs[key]} aria-label={t(`appearance.${key}`)}
      onChange={event => update({ [key]: Number(event.target.value) })} />
      <output>{Math.round(prefs[key])}{key === 'blur' ? ' px' : '%'}</output></label>
  );
  return <div className="glass-controls">
    <GlassRow label={t('appearance.presets')} stack control={<div className="ap-presets">
      {(['minimal', 'frosted', 'liquid', 'aero'] as const).map(key => <Button key={key} variant="secondary" size="sm"
        onClick={() => update(getThemeGlass(APPEARANCE_PRESETS[key]))}>
        {t(`appearance.preset.${key}`)}</Button>)}
    </div>} />
    <GlassRow label={t('appearance.material')} control={<Select value={prefs.material} ariaLabel={t('appearance.material')}
      options={(['solid', 'frosted', 'liquid'] as const).map(value => ({ value, label: t(`appearance.material.${value}`) }))}
      onChange={value => update({ material: value as ThemeGlass['material'] })} />} />
    <GlassRow label={t('appearance.intensity')} control={slider('intensity', 0, 100)} />
    <div className={`ap-preview ap-preview--${preview}`}>
      <div className="ap-preview-surface">
        <strong>{t('appearance.preview')}</strong><p>{t('appearance.previewText')}</p>
        <div className="ap-preview-progress"><span /></div>
        <Button size="sm" variant="primary">{t('appearance.previewButton')}</Button>
      </div>
      <div className="ap-preview-backgrounds" role="group" aria-label={t('appearance.previewBackground')}>
        {(['dark', 'light', 'aero'] as const).map(value => <Button key={value} size="sm" variant={preview === value ? 'primary' : 'secondary'}
          aria-pressed={preview === value} onClick={() => setPreview(value)}>{t(`appearance.preview.${value}`)}</Button>)}
      </div>
    </div>
    <details className="ap-advanced">
      <summary>{t('appearance.advanced')}</summary>
      <GlassRow label={t('appearance.opacity')} control={slider('opacity', 45, 98)} />
      <GlassRow label={t('appearance.blur')} control={slider('blur', 0, 40)} />
      <GlassRow label={t('appearance.tint')} control={slider('tint', 0, 25)} />
      <GlassRow label={t('appearance.highlight')} control={slider('highlight', 0, 100)} />
      <GlassRow label={t('appearance.depth')} control={slider('depth', 0, 100)} />
      <GlassRow label={t('appearance.quality')} control={<Select value={prefs.quality} ariaLabel={t('appearance.quality')}
        options={(['full', 'light'] as const).map(value => ({ value, label: t(`appearance.quality.${value}`) }))}
        onChange={value => update({ quality: value as ThemeGlass['quality'] })} />} />
      <GlassRow label={t('appearance.motion')} description={t('appearance.motionHint')}
        control={<Toggle checked={prefs.motion} ariaLabel={t('appearance.motion')} onChange={motion => update({ motion })} />} />
      <div className="ap-scopes">{APPEARANCE_SCOPES.map(scope => <div key={scope} className="ap-scope">
        <span>{t(`appearance.scope.${scope}`)}</span><Toggle size="small"
        ariaLabel={t(`appearance.scope.${scope}`)} checked={prefs.scopes.includes(scope)} onChange={on => update({
          scopes: on ? [...prefs.scopes, scope] : prefs.scopes.filter(s => s !== scope) as AppearanceScope[],
        })} /></div>)}</div>
      {(['panels', 'cards', 'buttons', 'inputs'] as const).map(area => <GlassRow key={area}
        label={t(`appearance.radius.${area}`)} control={<div className="ap-radius">
          <Select value={prefs.radii[area] === null ? 'theme' : 'custom'} ariaLabel={t(`appearance.radius.${area}`)}
            options={[{ value: 'theme', label: t('appearance.inherit') }, { value: 'custom', label: t('appearance.custom') }]}
            onChange={value => update({ radii: { ...prefs.radii, [area]: value === 'theme' ? null : 12 } })} />
          {prefs.radii[area] !== null && <label className="ap-slider"><input type="range" min={0} max={32}
            value={prefs.radii[area]!} aria-label={t(`appearance.radius.${area}`)} onChange={event =>
              update({ radii: { ...prefs.radii, [area]: Number(event.target.value) } })} /><output>{prefs.radii[area]} px</output></label>}
        </div>} />)}
    </details>

  </div>;
}
