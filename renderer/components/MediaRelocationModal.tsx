import React, { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { useTranslation } from '../utils/i18nContext';
import { formatBytes } from '../utils/format-helpers';
import type { MediaRelocationPreview, MediaRelocationTarget, MediaRelocationView } from '../../shared/media-relocation';
export function MediaRelocationModal({ target, onClose, onLinked }: { target: MediaRelocationTarget; onClose(): void; onLinked(value: MediaRelocationView): void }) {
  const { t } = useTranslation(), live = useRef(true);
  const [preview, setPreview] = useState<MediaRelocationPreview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [ack, setAck] = useState(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => () => { if (preview) void window.api.historyPlayback.cancelRelocation(preview.token).catch(() => {}); }, [preview]);
  const choose = async (folder = false) => {
    if (busy) return; setBusy(true); setError(''); setAck(false);
    try { const result = await window.api.historyPlayback.chooseRelocation(target, folder); if (live.current) setPreview(result); else if (result) void window.api.historyPlayback.cancelRelocation(result.token).catch(() => {}); }
    catch { if (live.current) setError(t('library.relocate.chooseError')); }
    finally { if (live.current) setBusy(false); }
  };
  const confirm = async () => {
    if (!preview || !ack || busy) return; setBusy(true); setError('');
    try { const result = await window.api.historyPlayback.confirmRelocation(preview.token); if (live.current) onLinked(result); }
    catch { if (live.current) { setPreview(null); setAck(false); setError(t('library.relocate.changed')); } }
    finally { if (live.current) setBusy(false); }
  };
  return <Modal title={t('library.relocate.title')} icon="folder-open" size="md" onClose={onClose} busy={busy} footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!ack || !preview?.sizeMatches || !preview.formatMatches || busy} loading={busy} onClick={() => { void confirm(); }}>{t('library.relocate.linkResume')}</Button></>}>
    <p>{target.path}</p><p>{t('library.relocate.hint')}</p>
    <div className="media-relocation-actions"><Button variant="secondary" disabled={busy} onClick={() => { void choose(); }}>{t('library.relocate.chooseFile')}</Button><Button variant="secondary" disabled={busy} onClick={() => { void choose(true); }}>{t('library.relocate.chooseFolder')}</Button></div>
    {error && <p role="alert">{error}</p>}
    {preview && <div className="media-relocation-review"><code>{preview.candidatePath}</code><p>{t('library.relocate.expected')}: {target.length ? formatBytes(target.length) : t('library.relocate.unknownSize')}</p><p>{t('library.relocate.actual')}: {formatBytes(preview.candidateBytes)}</p><p role="status">{t(!preview.formatMatches ? 'library.relocate.formatMismatch' : !preview.sizeMatches ? 'library.relocate.sizeMismatch' : 'library.relocate.review')}</p><label><input type="checkbox" checked={ack} disabled={!preview.sizeMatches || !preview.formatMatches} onChange={event => setAck(event.target.checked)} />{t('library.relocate.confirmFile')}</label></div>}
  </Modal>;
}
