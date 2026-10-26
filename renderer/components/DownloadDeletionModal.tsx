import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DownloadDeletionPreview, DownloadRemovalResult } from '../../shared/download-removal';
import { Modal } from './Modal';
import { Button } from './Button';
import { ErrorMessage } from './ErrorMessage';
import { VirtualFileList } from './VirtualFileList';
import { useTranslation } from '../utils/i18nContext';
import { formatBytes } from '../utils/format-helpers';
import './DownloadDeletionModal.css';

export function DownloadDeletionModal({ id, onClose, onRemoved }: { id: string; onClose(): void; onRemoved(result: DownloadRemovalResult, deleted: boolean): void }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<DownloadDeletionPreview | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null), [busy, setBusy] = useState(false), [stale, setStale] = useState(false), [acknowledged, setAcknowledged] = useState(false);
  const alive = useRef(true), request = useRef(0), lock = useRef(false);
  const load = useCallback(async () => {
    const revision = ++request.current; setLoading(true); setError(null); setAcknowledged(false); setStale(true);
    try { const next = await window.api.previewDownloadDeletion(id); if (alive.current && revision === request.current) { setPreview(next); setStale(false); } }
    catch (cause) { if (alive.current && revision === request.current) setError(cause); }
    finally { if (alive.current && revision === request.current) setLoading(false); }
  }, [id]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);
  const remove = async (files: boolean) => {
    if (lock.current || files && (!preview || !acknowledged || stale)) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const result = await window.api.removeDownload(id, files, files ? preview!.token : undefined);
      if (alive.current) onRemoved(result, files);
    } catch (cause) { if (alive.current) { setError(cause); if (files) setStale(true); } }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  return <Modal title={t('downloads.deletion.title')} icon="trash" size="lg" onClose={onClose} busy={busy} closeOnBackdrop={false} footer={<>
    <Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
    <Button variant="secondary" disabled={busy} onClick={() => { void remove(false); }}>{t('downloads.deletion.keep')}</Button>
    <Button variant="danger" loading={busy} disabled={busy || loading || stale || !preview || !acknowledged} onClick={() => { void remove(true); }}>{t(preview?.files.length ? 'downloads.deletion.confirm' : 'downloads.deletion.confirmEmpty')}</Button>
  </>}>
    <div className="download-deletion">
      <p>{t('downloads.deletion.hint')}</p>
      <Button variant="secondary" size="sm" disabled={loading || busy} onClick={() => { void load(); }}>{t('downloads.deletion.refresh')}</Button>
      {loading && <p role="status">{t('downloads.deletion.loading')}</p>}
      {!!error && <div role="alert"><ErrorMessage error={error} details /><p>{t('downloads.deletion.retryHint')}</p></div>}
      {preview && <>
        <h3>{preview.name}</h3>
        <p>{t('downloads.deletion.summary').replace('{count}', String(preview.files.length)).replace('{size}', formatBytes(preview.bytes))}</p>
        {preview.missing > 0 && <p>{t('downloads.deletion.missing').replace('{count}', String(preview.missing))}</p>}
        {!preview.metadataReady && <p>{t('downloads.deletion.noMetadata')}</p>}
        {preview.files.length > 0 && <VirtualFileList className="download-deletion-files" items={preview.files} getKey={file => file.path} estimateSize={56} label={t('downloads.deletion.files')} renderRow={file => <div className="download-deletion-file"><span>{file.path}</span><small>{formatBytes(file.size)}</small></div>} />}
        <p>{t('downloads.deletion.note')}</p>
        <label className="download-deletion-ack"><input type="checkbox" checked={acknowledged} disabled={busy || loading || stale} onChange={event => setAcknowledged(event.target.checked)} />{t('downloads.deletion.ack')}</label>
      </>}
    </div>
  </Modal>;
}
