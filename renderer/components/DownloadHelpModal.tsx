import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { RecoveryError, type RecoveryAction } from './RecoveryError';
import { useTranslation } from '../utils/i18nContext';
import { formatSpeed } from '../utils/format-helpers';
import type { DownloadHelpAction, DownloadHelpReport } from '../../shared/download-help';
import './DownloadHelpModal.css';

export function DownloadHelpModal({ id, onClose, onAction, onOpenEvents, canOpenSettings = false }: { id: string; onClose(): void; onAction(action: DownloadHelpAction): void | Promise<void>; onOpenEvents?(): void; canOpenSettings?: boolean }) {
  const { t, language } = useTranslation(), [report, setReport] = useState<DownloadHelpReport | null>(null), [error, setError] = useState<unknown>(null), [busy, setBusy] = useState(false);
  const request = useRef<symbol | null>(null), [attempt, setAttempt] = useState(0);
  const load = useCallback(async () => {
    if (request.current) return;
    const ticket = Symbol(id); request.current = ticket; setAttempt(value => value + 1); setBusy(true); setError(null);
    try { const result = await window.api.inspectDownloadHelp(id); if (request.current === ticket) setReport(result); }
    catch (cause) { if (request.current === ticket) setError(cause); }
    finally { if (request.current === ticket) { request.current = null; setBusy(false); } }
  }, [id]);
  useEffect(() => { setReport(null); void load(); return () => { request.current = null; }; }, [load]);
  const actions: RecoveryAction[] = report?.actions.filter(action => canOpenSettings || action !== 'storage' && action !== 'privacy').map(action => ({ id: action, label: t(`downloadHelp.action.${action}`), disabled: busy, kind: action === 'resume' || action === 'retry' ? 'retry' : 'open', run: async () => { await onAction(action); if (action === 'resume' || action === 'retry') await load(); } })) ?? [];
  return <Modal title={t('downloadHelp.title')} icon="info" size="lg" onClose={onClose} footer={<><Button variant="secondary" disabled={busy} onClick={() => { void load(); }}>{t('downloadHelp.refresh')}</Button><Button variant="secondary" onClick={onClose}>{t('common.close')}</Button></>}>
    <p>{t('downloadHelp.scope')}</p>
    {busy && <p role="status">{t('common.loading')}</p>}
    {error !== null ? <RecoveryError key={attempt} error={error} context={{ object: report?.name ?? id, actions: [{ id: 'refresh', label: t('downloadHelp.refresh'), kind: 'retry', run: load }], onOpenEvents }} /> : report && <>
      <strong className="download-help-name">{report.name}</strong>
      <p className="download-help-reason" role="status" data-download-help-reason={report.reason}>{t(`downloadHelp.reason.${report.reason}`)}</p>
      <dl className="download-help-facts"><div><dt>{t('downloadHelp.observed')}</dt><dd>{new Date(report.checkedAt).toLocaleTimeString(language)}</dd></div><div><dt>{t('downloadHelp.peers')}</dt><dd>{report.peers ?? t('downloadHelp.unknown')}</dd></div><div><dt>{t('downloadHelp.rate')}</dt><dd>{report.rate === null ? t('downloadHelp.unknown') : formatSpeed(report.rate)}</dd></div><div><dt>{t('downloadHelp.selected')}</dt><dd>{report.selected === null ? t('downloadHelp.unknown') : `${report.selected} / ${report.totalFiles}`}</dd></div></dl>
      {(!report.settingsKnown || !report.filesKnown) && <p className="download-help-note">{t('downloadHelp.partial')}</p>}
      <RecoveryError key={`${report.id}:${report.checkedAt}`} error={report.error || undefined} context={{ object: t('downloadHelp.next'), actions, onOpenEvents }} />
    </>}
  </Modal>;
}
