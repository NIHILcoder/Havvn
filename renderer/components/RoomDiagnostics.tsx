import React, { useEffect, useRef, useState } from 'react';
import { Button, Icon, Modal } from './index';
import { useTranslation } from '../utils/i18nContext';
import { useHostWindow } from '../utils/hostWindow';
import { cleanError } from '../utils/format-helpers';
import type { RoomDiagnosticReport } from '../../shared/room-diagnostics';
import './RoomDiagnostics.css';

export const RoomDiagnostics: React.FC<{ roomId: string; onClose: () => void }> = ({ roomId, onClose }) => {
  const { t } = useTranslation(), host = useHostWindow();
  const [report, setReport] = useState<RoomDiagnosticReport | null>(null);
  const [action, setAction] = useState<'retry' | 'copy' | 'export' | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const session = useRef(0), dataRevision = useRef(0), busy = useRef(false);
  useEffect(() => {
    const epoch = ++session.current;
    let loading = false;
    ++dataRevision.current; busy.current = false; setAction(null);
    setReport(null); setError(''); setNotice('');
    const refresh = async () => {
      if (loading || busy.current) return;
      loading = true; const revision = ++dataRevision.current;
      try { const data = await window.api.rooms.diagnose(roomId); if (session.current === epoch && dataRevision.current === revision) setReport(data); }
      catch (e) { if (session.current === epoch && dataRevision.current === revision) setError(cleanError(e)); }
      finally { loading = false; }
    };
    void refresh();
    const timer = host.window.setInterval(() => { void refresh(); }, 3000);
    return () => { session.current = epoch + 1; host.window.clearInterval(timer); };
  }, [roomId, host]);

  const run = async (kind: 'retry' | 'copy' | 'export') => {
    if (busy.current) return;
    const epoch = session.current; ++dataRevision.current;
    busy.current = true; setAction(kind); setError(''); setNotice('');
    try {
      if (kind === 'retry') {
        const data = await window.api.rooms.retryConnection(roomId);
        if (session.current === epoch) { setReport(data); setNotice(t('rooms.diag.retryStarted')); }
      } else if (kind === 'copy') {
        const data = await window.api.rooms.diagnose(roomId);
        if (session.current !== epoch) return;
        await host.window.navigator.clipboard.writeText(JSON.stringify(data, null, 2));
        if (session.current === epoch) { setReport(data); setNotice(t('rooms.diag.copied')); }
      } else {
        const result = await window.api.rooms.exportDiagnostics(roomId);
        if (session.current === epoch && result.success) setNotice(t('rooms.diag.exported'));
      }
    } catch (e) { if (session.current === epoch) setError(cleanError(e)); }
    finally { if (session.current === epoch) { busy.current = false; setAction(null); } }
  };
  const phase = report?.connection.phase;
  const time = (value?: number) => value ? new Date(value).toLocaleString() : t('rooms.diag.never');
  return (
    <Modal title={t('rooms.diag.title')} icon="activity" onClose={onClose} busy={!!action} className="room-diag-modal"
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={!!action}>{t('common.close')}</Button>
        <Button variant="secondary" icon={<Icon name="copy" size={14} />} onClick={() => { void run('copy'); }} loading={action === 'copy'} disabled={!report || !!action}>{t('rooms.diag.copy')}</Button>
        <Button variant="secondary" icon={<Icon name="download" size={14} />} onClick={() => { void run('export'); }} loading={action === 'export'} disabled={!report || !!action}>{t('rooms.diag.export')}</Button>
        <Button variant="primary" icon={<Icon name="refresh" size={14} />} onClick={() => { void run('retry'); }} loading={action === 'retry'}
          disabled={!report || !!action || phase === 'removed' || phase === 'suspended'}>{t('rooms.diag.retry')}</Button>
      </>}>
      {error && <div className="room-diag-error" role="alert">{error}</div>}
      {notice && <p role="status">{notice}</p>}
      {!report ? <p role="status">{t('common.loading')}</p> : <>
        <div className={`room-diag-phase ${phase === 'ready' ? 'ready' : ''}`} role="status">
          <Icon name="network" size={20} />
          <div><strong>{t(`rooms.diag.phase.${report.connection.phase}`)}</strong><p>{t(`rooms.diag.hint.${report.connection.phase}`)}</p></div>
        </div>
        <dl className="room-diag-facts">
          <div><dt>{t('rooms.diag.trackers')}</dt><dd>{report.connection.trackers.acknowledged}/{report.connection.trackers.configured}</dd></div>
          <div><dt>{t('rooms.diag.channels')}</dt><dd>{report.connection.channels.open} · {t('rooms.diag.pending')}: {report.connection.channels.pending}</dd></div>
          <div><dt>{t('rooms.diag.people')}</dt><dd>{report.people.online}</dd></div>
          <div><dt>{t('rooms.diag.lastConnection')}</dt><dd>{time(report.connection.lastConnectedAt)}</dd></div>
          <div><dt>{t('rooms.diag.lastSync')}</dt><dd>{time(report.connection.lastSyncAt)}</dd></div>
        </dl>
        <div className="room-diag-paths">
          <span>{t('rooms.diag.direct')}: {report.connection.channels.direct} · TURN: {report.connection.channels.turn} · {t('rooms.diag.unknown')}: {report.connection.channels.unknown}</span>
          <span>{t('rooms.diag.peerRelay')}: {report.people.viaPeerRelay}</span>
          <p>{t('rooms.diag.pathHint')}</p>
        </div>
        <div className="room-diag-features">
          <section><h3>{t('rooms.diag.files')}</h3>
            <p>{t('rooms.diag.receiving')}: {report.files.receiving} · {t('rooms.diag.queued')}: {report.files.queued}</p>
            <p>{t('rooms.diag.paused')}: {report.files.paused} · {t('rooms.diag.checking')}: {report.files.checking}</p>
            <p>{t('rooms.diag.waitingKey')}: {report.files.waitingKey} · {t('rooms.diag.readyFiles')}: {report.files.ready}/{report.files.total}</p>
            {Object.entries(report.files.failures).filter(([, n]) => n > 0).map(([code, n]) =>
              <p key={code} className="room-diag-warning">{t(`rooms.diag.fileError.${code as keyof typeof report.files.failures}`)}: {n}</p>)}
          </section>
          <section><h3>{t('rooms.diag.voice')}</h3><p>{t(report.voice.joined ? 'rooms.diag.joined' : 'rooms.diag.notJoined')}</p>
            <p>{t('rooms.diag.connected')}: {report.voice.connected} · {t('rooms.diag.pending')}: {report.voice.connecting}</p>
            <p>{t('rooms.diag.failed')}: {report.voice.failed} · {t('rooms.diag.poor')}: {report.voice.poor}</p>
            <p>{t('rooms.diag.unmeasured')}: {report.voice.unknown}</p>
          </section>
          <section><h3>LAN</h3><p>{t(report.lan.active ? 'rooms.diag.active' : report.lan.available ? 'rooms.diag.inactive' : 'rooms.diag.unavailable')}</p>
            <p>{t('rooms.diag.connected')}: {report.lan.connected} · {t('rooms.diag.peerRelay')}: {report.lan.viaPeerRelay}</p>
            <p>{t('rooms.diag.failed')}: {report.lan.failed} · {t('rooms.diag.poor')}: {report.lan.poor}</p>
            <p>{t('rooms.diag.unmeasured')}: {report.lan.unknown}</p>
          </section>
        </div>
        <details className="room-diag-events"><summary>{t('rooms.diag.observations')}</summary>
          <p>{t('rooms.diag.observationsHint')}</p>
          {Object.entries(report.connection.observations).filter(([, n]) => n > 0).map(([event, n]) =>
            <p key={event}>{t(`rooms.diag.event.${event as keyof typeof report.connection.observations}`)}: {n}</p>)}
          <ol>{report.connection.events.map((event, i) => <li key={i}><time>{time(event.at)}</time> {t(`rooms.diag.event.${event.event}`)}</li>)}</ol>
        </details>
        <p className="room-diag-privacy"><Icon name="shield" size={14} />{t('rooms.diag.privacy')}</p>
      </>}
    </Modal>
  );
};
