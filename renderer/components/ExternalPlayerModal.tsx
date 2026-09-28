import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { ExternalPlayerPreferences } from './ExternalPlayerPreferences';
import { ExternalPlayerSessions } from './ExternalPlayerSessions';
import { useTranslation } from '../utils/i18nContext';
import { externalStartTime, type ExternalPlayerConfig, type ExternalPlayerFailure } from '../../shared/external-player';
import { fmtTime } from './PlayerControls';
import { useHostWindow } from '../utils/hostWindow';

interface Props { downloadId: string; relativePath: string; position?: number; onClose: () => void; onOpened?: () => void }
export function ExternalPlayerModal({ downloadId, relativePath, position = 0, onClose, onOpened }: Props) {
  const { t } = useTranslation();
  const host = useHostWindow();
  const [config, setConfig] = useState<ExternalPlayerConfig | null>(null);
  const [availability, setAvailability] = useState<'checking' | 'local' | 'stream' | ExternalPlayerFailure>('checking');
  const [busy, setBusy] = useState(false), [choosing, setChoosing] = useState(false);
  const [resume, setResume] = useState(true);
  const [error, setError] = useState<ExternalPlayerFailure | null>(null);
  const time = externalStartTime(position);
  useEffect(() => {
    let disposed = false, running = false;
    const refresh = async () => {
      if (running) return; running = true;
      try {
        const value = await window.api.externalPlayer.inspect(downloadId, relativePath);
        if (!disposed) setAvailability(value);
      } catch { if (!disposed) { setAvailability('unavailable'); setError('unavailable'); } }
      finally { running = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [downloadId, relativePath]);
  const open = async () => {
    setBusy(true); setError(null);
    try {
      const result = await window.api.externalPlayer.open(downloadId, relativePath, resume ? time : 0);
      if (result.ok) { onOpened?.(); onClose(); }
      else setError(result.reason);
    } catch { setError('unavailable'); }
    finally { setBusy(false); }
  };
  const dialog = <Modal size="lg" title={t('external.title')} icon="external-link" onClose={onClose} busy={busy || choosing} backdropClassName="external-player-backdrop"
    footer={<><button className="btn btn-secondary" disabled={busy || choosing} onClick={onClose}>{t('common.cancel')}</button>
      <button className="btn btn-primary" disabled={busy || choosing || !(availability === 'local' || (availability === 'stream' && config?.kind !== 'default')) || !config?.available} onClick={() => void open()}><Icon name="external-link" size={14} />{t(busy ? 'external.opening' : 'external.open')}</button></>}>
    <div className="external-player-file"><Icon name="film" size={22} /><div><strong>{relativePath.replace(/\\/g, '/').split('/').pop()}</strong><p>{relativePath}</p></div></div>
    <p className="external-player-hint">{t(availability === 'local' ? 'external.ready' : availability === 'checking' ? 'external.loading' : availability === 'stream' ? 'external.streaming' : `external.error.${availability}`)}</p>
    <ExternalPlayerPreferences onChange={setConfig} onBusy={setChoosing} />
    {availability === 'stream' && config?.kind === 'default' && <p className="external-player-hint">{t('external.error.stream-player')}</p>}
    {time >= 5 && config && config.kind !== 'default' && <label className="external-player-resume"><input type="checkbox" checked={resume} onChange={e => setResume(e.target.checked)} />{t('external.resume')} {fmtTime(time)}</label>}
    {time >= 5 && config?.kind === 'default' && <p className="external-player-hint">{t('external.defaultPosition')}</p>}
    <p className="external-player-hint">{t('external.historyHint')}</p>
    <ExternalPlayerSessions />
    {error && <p className="external-player-error" role="alert">{t(`external.error.${error}`)}</p>}
  </Modal>;
  return host.document?.body ? createPortal(dialog, host.document.body) : dialog;
}
