import React, { useEffect, useState } from 'react';
import type { ExternalPlayerSession } from '../../shared/external-player';
import { useTranslation } from '../utils/i18nContext';
import './ExternalPlayer.css';

export function ExternalPlayerSessions() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<ExternalPlayerSession[]>([]);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false, running = false;
    const refresh = async () => {
      if (running) return; running = true;
      try { const list = await window.api.externalPlayer.sessions(); if (!disposed) { setSessions(list); setError(false); } }
      catch { if (!disposed) setError(true); } finally { running = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  if (!sessions.length && !error) return null;
  return <section className="external-player-sessions" aria-label={t('external.sessions')}>
    {!!sessions.length && <><strong>{t('external.sessions')}</strong><p className="external-player-hint">{t('external.stopHint')}</p></>}
    {sessions.map(s => <div className="external-player-session" key={s.id}><div><strong>{s.path.split('/').pop()}</strong><p>{s.kind === 'vlc' ? 'VLC' : 'mpv'}</p></div>
      <button className="btn btn-secondary" disabled={busy !== null} onClick={async () => {
        setBusy(s.id); setError(false);
        try { await window.api.externalPlayer.stop(s.id); setSessions(list => list.filter(item => item.id !== s.id)); }
        catch { setError(true); } finally { setBusy(null); }
      }}>{t('external.stop')}</button></div>)}
    {error && <p className="external-player-error" role="alert">{t('external.sessionsError')}</p>}
  </section>;
}
