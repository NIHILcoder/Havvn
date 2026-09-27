import React, { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import type { ExternalPlayerConfig, ExternalPlayerFailure } from '../../shared/external-player';
import './ExternalPlayer.css';

interface Props { onChange?: (config: ExternalPlayerConfig) => void; onBusy?: (busy: boolean) => void }
export function ExternalPlayerPreferences({ onChange, onBusy }: Props) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<ExternalPlayerConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ExternalPlayerFailure | null>(null);
  useEffect(() => {
    let disposed = false;
    window.api.externalPlayer.getConfig().then(value => { if (!disposed) { setConfig(value); onChange?.(value); } })
      .catch(() => { if (!disposed) setError('unavailable'); });
    return () => { disposed = true; };
  }, [onChange]);
  const change = async (choose: boolean) => {
    setBusy(true); onBusy?.(true); setError(null);
    try {
      const result = choose ? await window.api.externalPlayer.choose() : { ok: true as const, config: await window.api.externalPlayer.useDefault() };
      if (!result.ok) setError(result.reason);
      else if (result.config) { setConfig(result.config); onChange?.(result.config); }
    } catch { setError('unavailable'); }
    finally { setBusy(false); onBusy?.(false); }
  };
  return <div className="external-player-preferences">
    <div className="external-player-choice" role="group" aria-label={t('external.player')}>
      <button type="button" className={`btn ${config?.kind === 'default' ? 'btn-primary' : 'btn-secondary'}`} disabled={busy} aria-pressed={config?.kind === 'default'} onClick={() => void change(false)}>{t('external.default')}</button>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void change(true)}><Icon name="folder-open" size={14} />{t('external.choose')}</button>
    </div>
    <div className="external-player-selected">
      <Icon name="monitor" size={18} />
      <div><strong>{config ? config.kind === 'default' ? t('external.default') : config.kind === 'vlc' ? 'VLC' : 'mpv' : t('external.loading')}</strong>
        {config?.executable && <p title={config.executable}>{config.executable}</p>}</div>
    </div>
    <p className="external-player-hint">{t('external.saved')}</p>
    {config && !config.available && <p className="external-player-error" role="alert">{t('external.error.missing-player')}</p>}
    {error && <p className="external-player-error" role="alert">{t(`external.error.${error}`)}</p>}
  </div>;
}
