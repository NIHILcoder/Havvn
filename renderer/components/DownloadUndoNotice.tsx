import React, { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { OperationStatus } from './OperationStatus';
import { useTranslation } from '../utils/i18nContext';
import { downloadUndo, useDownloadUndo } from '../state/download-undo';
import './DownloadUndoNotice.css';

export const DownloadUndoNotice: React.FC = () => {
  const { t } = useTranslation();
  const { state, pending, unavailable, error } = useDownloadUndo();
  const [now, setNow] = useState(Date.now);
  const hasItems = state.items.length > 0;
  const visible = hasItems || Boolean(error);
  const notice = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = notice.current;
    if (!visible || !element) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty('--download-undo-height', `${Math.ceil(element.getBoundingClientRect().height) + 12}px`);
    update();
    const observer = new ResizeObserver(update); observer.observe(element);
    return () => { observer.disconnect(); root.style.removeProperty('--download-undo-height'); };
  }, [visible]);
  useEffect(() => {
    if (!hasItems) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasItems]);
  if (!hasItems && !error) return null;
  return <aside ref={notice} className="download-undo-notice" aria-label={t('undo.title')}>
    <div className="download-undo-heading"><Icon name="rotate-ccw" size={16} /><strong>{t('undo.title')}</strong></div>
    <p className="download-undo-hint">{t('undo.session')}</p>
    {unavailable && <p role="status">{t('operation.observationUnavailable')}</p>}
    {error && <div className="download-undo-error" role="alert"><span>{t(`undo.error.${error}`)}</span>
      <Button variant="ghost" size="sm" iconOnly title={t('common.close')} onClick={downloadUndo.clearError} icon={<Icon name="x" size={14} />} /></div>}
    <ul>{state.items.map(item => {
      const busy = pending.has(item.token) || item.status === 'restoring';
      return <li key={item.token} data-undo-token={item.token} data-undo-status={item.status}>
        <div className="download-undo-row">
          <span className="download-undo-name" title={item.name}>{item.name}</span>
          {item.status !== 'restored' && <Button variant="secondary" size="sm" disabled={busy || now >= item.expiresAt}
            loading={busy} onClick={() => { void downloadUndo.undo(item.token); }}>{t('undo.action')}</Button>}
        </div>
        {item.operation && <OperationStatus operation={item.operation} showProgress={busy} />}
        {!busy && item.status !== 'restored' && <small aria-hidden="true">{t('undo.remaining').replace('{seconds}', String(Math.max(0, Math.min(30, Math.ceil((item.expiresAt - now) / 1000)))))}</small>}
        {item.error && <p className="download-undo-error">{t(`undo.error.${item.error}`)}</p>}
        {item.warnings?.map(warning => <p className="download-undo-warning" key={warning}>{t(`undo.warning.${warning}`)}</p>)}
      </li>;
    })}</ul>
  </aside>;
};
