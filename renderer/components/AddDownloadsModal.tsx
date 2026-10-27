import React, { useMemo, useRef, useEffect, useState } from 'react';
import { ADD_QUEUE_LIMIT, parseSourceQueue, type DownloadSource } from '../../shared/download-source-queue';
import { Button } from './Button';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { ErrorMessage } from './ErrorMessage';
import { useTranslation } from '../utils/i18nContext';
import './AddDownloadsModal.css';

export function AddDownloadsModal({ initialFiles = [], onConfirm, onClose }: {
  initialFiles?: DownloadSource[]; onConfirm(sources: DownloadSource[]): void; onClose(): void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(''), [files, setFiles] = useState(initialFiles), [excluded, setExcluded] = useState(new Set<string>());
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const alive = useRef(true), submitted = useRef(false), choosing = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const parsed = useMemo(() => parseSourceQueue(text, files), [text, files]);
  const selected = parsed.rows.filter(row => row.source && !row.issue && !excluded.has(row.key));
  const browse = async () => {
    if (choosing.current) return; choosing.current = true; setBusy(true); setError(null);
    try {
      const paths = await window.api.selectTorrentFiles();
      if (alive.current) setFiles(old => [...old, ...paths.map(path => ({ sourceType: 'torrent_file' as const, sourceUri: path, label: path.split(/[\\/]/).at(-1) || path }))]);
    } catch (cause) { if (alive.current) setError(cause); }
    finally { choosing.current = false; if (alive.current) setBusy(false); }
  };
  return <Modal title={t('downloads.add')} icon="plus" size="lg" onClose={onClose} busy={busy} footer={<>
    <Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
    <Button variant="primary" disabled={busy || !selected.length || parsed.overflow} onClick={() => {
      if (submitted.current || !selected.length || parsed.overflow) return;
      submitted.current = true; onConfirm(selected.map(row => row.source!));
    }}>{t('downloads.queue.continue').replace('{count}', String(selected.length))}</Button>
  </>}>
    <div className="add-downloads">
      <p>{t('downloads.queue.hint')}</p>
      <label htmlFor="add-downloads-links">{t('downloads.queue.links')}</label>
      <textarea id="add-downloads-links" className="input" rows={4} value={text} maxLength={640_000} spellCheck={false} disabled={busy}
        placeholder="magnet:?xt=urn:btih:…" onChange={event => { setText(event.target.value); setExcluded(new Set()); }} />
      <Button variant="secondary" disabled={busy || files.length >= ADD_QUEUE_LIMIT} icon={<Icon name="folder-open" size={16} />} onClick={() => { void browse(); }}>{t('downloads.queue.files')}</Button>
      {parsed.overflow && <p role="alert">{t('downloads.queue.limit').replace('{count}', String(ADD_QUEUE_LIMIT))}</p>}
      {!!error && <p role="alert"><ErrorMessage error={error} details /></p>}
      {parsed.rows.length > 0 && <div className="add-downloads-list" role="group" aria-label={t('downloads.queue.list')}>
        {parsed.rows.map(row => <label key={row.key} className="add-downloads-row">
          <input type="checkbox" checked={!row.issue && !excluded.has(row.key)} disabled={busy || !!row.issue} onChange={event => setExcluded(old => { const next = new Set(old); if (event.target.checked) next.delete(row.key); else next.add(row.key); return next; })} />
          <span><strong>{row.source?.label ?? row.value}</strong><small>{row.issue ? t(`downloads.queue.${row.issue}`) : t(row.source?.sourceType === 'magnet' ? 'downloads.queue.magnet' : 'downloads.queue.torrent')}</small></span>
          {row.value === row.source?.sourceUri && files.some(file => file.sourceUri === row.value) && <Button variant="ghost" size="sm" iconOnly disabled={busy} aria-label={t('downloads.queue.removeFile')} icon={<Icon name="x" size={14} />} onClick={event => { event.preventDefault(); setFiles(old => old.filter(file => file.sourceUri !== row.value)); setExcluded(new Set()); }} />}
        </label>)}
      </div>}
      <p className="add-downloads-note">{t('downloads.queue.reviewHint')}</p>
    </div>
  </Modal>;
}
