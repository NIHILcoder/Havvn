import React, { useState } from 'react';
import { NumberField } from './controls';
import { Button } from '../../components/Button';
import { useTranslation } from '../../utils/i18nContext';
import './SpeedLimitField.css';

/** Zero remains the stored value for unlimited; this edits the normal settings draft. */
export function SpeedLimitField({ value, onChange, label }: { value: number; onChange(value: number): void; label: string }) {
  const { t, language } = useTranslation();
  const [reset, setReset] = useState(0);
  const valid = Number.isFinite(value) && value >= 0;
  return <div className="speed-limit-field">
    <div className="speed-limit-field-controls">
      <NumberField key={reset} value={value} onChange={next => onChange(Math.round(next))} unit={t('effective.unit')} min={0} ariaLabel={label} />
      <Button variant={value === 0 ? 'secondary' : 'ghost'} size="sm" aria-pressed={value === 0}
        aria-label={`${label}: ${t('settings.limit.unlimited')}`} onClick={() => { onChange(0); setReset(revision => revision + 1); }}>{t('settings.limit.unlimited')}</Button>
    </div>
    <span className="speed-limit-field-hint">{!valid ? t('settings.limit.invalid') : value === 0 ? t('settings.limit.zero')
      : `${new Intl.NumberFormat(language).format(value)} ${t('effective.unit')}`}</span>
  </div>;
}
