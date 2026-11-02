import React, { useEffect, useState } from 'react';
import type { EffectiveLimit, EffectiveSettingsSnapshot, SettingSource } from '../../../shared/effective-settings';
import { useTranslation } from '../../utils/i18nContext';
import { SettingsCard } from './controls';
import './EffectiveLimits.css';

export const EffectiveLimits: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { t, language } = useTranslation();
  const [snapshot, setSnapshot] = useState<EffectiveSettingsSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true, pending = false;
    const refresh = async () => {
      if (pending || document.hidden || !window.api.getEffectiveSettings) return;
      pending = true;
      try { const next = await window.api.getEffectiveSettings(); if (alive) { setSnapshot(next); setFailed(false); } }
      catch { if (alive) setFailed(true); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    const visible = () => { void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, []);
  const source = (value: SettingSource): string => {
    const labels = { manual: t('effective.manual'), alternative: t('effective.alternative'), schedule: t('effective.schedule'), network: t('effective.network'), economy: t('effective.economy') };
    return value.name ? `${labels[value.kind]}: ${value.name}` : labels[value.kind];
  };
  const limit = (value: number) => value === 0 ? t('effective.unlimited') : `${new Intl.NumberFormat(language).format(value)} ${t('effective.unit')}`;
  const row = (label: string, value: EffectiveLimit) => <div className="effective-limits-item">
    <div className="effective-limits-label">{label}</div><strong>{limit(value.value)}</strong>
    <p>{t('effective.base')}: {limit(value.base)} · {snapshot?.engine.altSpeedEnabled ? t('effective.alternative') : t('effective.manual')}</p>
    <p>{t('effective.source')}: {value.sources.map(source).join(', ')}</p>
    {value.constraints.length > 0 && <p>{t('effective.constraints')}: {value.constraints.map(c => `${source(c.source)} — ${limit(c.value)}`).join('; ')}</p>}
  </div>;
  const content = failed ? <p role="status">{t('effective.unavailable')}</p> : !snapshot ? <p>{t('effective.loading')}</p> : <>
      {!snapshot.applied && <p role="status">{t('effective.pending')}</p>}
      {snapshot.blocks.length > 0 && <p className="effective-limits-block" role="status">{t('effective.blocked')}: {snapshot.blocks.map(b => b === 'vpn' ? t('effective.vpn') : t('effective.disk')).join(', ')}</p>}
      <div className="effective-limits-grid">{row(t('settings.downSpeed'), snapshot.download)}{row(t('settings.upSpeed'), snapshot.upload)}</div>
      <p className="effective-limits-note">{t('effective.adaptiveNote')}</p>
    </>;
  return compact ? <div className="effective-limits-summary"><p className="effective-limits-note">{t('effective.description')}</p>{content}</div>
    : <SettingsCard title={t('effective.title')} description={t('effective.description')}>{content}</SettingsCard>;
};
