import { ErrorMessage } from '../../components/ErrorMessage';
import React, { lazy, Suspense, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/Button';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow } from '../../utils/hostWindow';
import { useVisibleWork } from '../../utils/visible-work';
import type { DocumentsView } from '../../../shared/room-documents';
import './RoomDocuments.css';
const Editor = lazy(() => import('./RoomDocumentsEditor').then(m => ({ default: m.RoomDocumentsEditor })));
export function RoomDocuments({ roomId, disabled }: { roomId: string; disabled?: boolean }) {
  const { t } = useTranslation(), host = useHostWindow();
  const visible = useVisibleWork();
  const [view, setView] = useState<DocumentsView | null>(null), [open, setOpen] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!visible || disabled || !window.api.rooms.documents) return;
    let alive = true;
    const read = async () => { try { const next = await window.api.rooms.documents.view(roomId); if (alive) { setView(next); setError(''); } } catch (cause) { if (alive) setError(String(cause)); } };
    let timer: number;
    const poll = async () => { await read(); if (alive) timer = host.window.setTimeout(poll, 3000); };
    void poll(); return () => { alive = false; host.window.clearTimeout(timer); };
  }, [roomId, disabled, host, visible]);
  if (!view?.enabled) return error ? <p className="hd-error" role="alert"><ErrorMessage error={error} /></p> : null;
  return <section className="hd-entry" aria-label={t('rooms.docs.title')}>
    <span className="hd-entry-icon"><Icon name="book-open" size={18} /></span>
    <div><strong>{t('rooms.docs.title')}</strong><p>{t('rooms.docs.entryHint')}</p></div>
    <span className="hd-entry-count">{view.items.filter(d => !d.archived).length}</span>
    <Button data-docs-open variant="secondary" size="sm" disabled={disabled} onClick={() => setOpen(true)} icon={<Icon name="chevron-right" size={14} />}>{t('rooms.docs.open')}</Button>
    {open && <Suspense fallback={<span role="status">{t('common.loading')}</span>}><Editor roomId={roomId} onClose={() => setOpen(false)} /></Suspense>}
  </section>;
}
