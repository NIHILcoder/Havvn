import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { formatBytes } from '../../utils/format-helpers';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow } from '../../utils/hostWindow';
import { STORAGE_OPEN_PAGE, type StorageAction, type StorageGroup, type StorageProgress, type StorageReport } from '../../../shared/storage-overview';
import './StorageOverview.css';

const RoomDataModal = lazy(() => import('../rooms/RoomDataModal').then(module => ({ default: module.RoomDataModal })));
const RoomSyncModal = lazy(() => import('../rooms/RoomSyncModal').then(module => ({ default: module.RoomSyncModal })));
const RoomDocumentsEditor = lazy(() => import('../rooms/RoomDocumentsEditor').then(module => ({ default: module.RoomDocumentsEditor })));

export function useStorageOverview() {
  const [report, setReport] = useState<StorageReport | null>(null), [progress, setProgress] = useState<StorageProgress | null>(null);
  const [busy, setBusy] = useState(false), [canceling, setCanceling] = useState(false), [error, setError] = useState(false);
  const active = useRef<string | null>(null), live = useRef(true), revision = useRef(0);
  useEffect(() => {
    live.current = true;
    const off = typeof window.api.storage?.onProgress === 'function' ? window.api.storage.onProgress(value => {
      if (live.current && active.current === value.id && value.revision > revision.current) { revision.current = value.revision; setProgress(value); }
    }) : undefined;
    return () => {
      live.current = false; if (typeof off === 'function') off();
      if (active.current && typeof window.api.storage?.cancel === 'function') void Promise.resolve(window.api.storage.cancel(active.current)).catch(() => {});
      active.current = null;
    };
  }, []);
  const start = async () => {
    if (active.current) return;
    if (typeof window.api.storage?.scan !== 'function') { setError(true); return; }
    const id = crypto.randomUUID(); active.current = id; revision.current = 0;
    setBusy(true); setCanceling(false); setError(false); setProgress(null);
    try { const next = await window.api.storage.scan(id); if (live.current && active.current === id) setReport(next); }
    catch { if (live.current && active.current === id) setError(true); }
    finally { if (live.current && active.current === id) { active.current = null; setBusy(false); setCanceling(false); } }
  };
  const cancel = async () => {
    const id = active.current; if (!id || canceling) return;
    setCanceling(true);
    try { await window.api.storage.cancel(id); }
    catch { if (live.current && active.current === id) { setError(true); setCanceling(false); } }
  };
  return { report, progress, busy, canceling, error, start, cancel };
}

export function StorageOverviewBody({ model, onCache }: { model: ReturnType<typeof useStorageOverview>; onCache(): void }) {
  const { t } = useTranslation(), host = useHostWindow(), { report, progress, busy, error } = model;
  const [picker, setPicker] = useState<StorageGroup | null>(null), [target, setTarget] = useState<StorageAction | null>(null);
  const open = (action: StorageAction) => {
    setPicker(null);
    if (action.kind === 'downloads') window.dispatchEvent(new CustomEvent(STORAGE_OPEN_PAGE, { detail: 'downloads' }));
    else if (action.kind === 'cache') onCache();
    else setTarget(action);
  };
  const manage = (group: StorageGroup) => { if (group.actions.length === 1) open(group.actions[0]); else setPicker(group); };
  const actionTitle = (action: StorageAction) => {
    const label = action.kind === 'sync' ? t(`storage.action.${action.section}`) : t(`storage.action.${action.kind}`);
    return 'label' in action ? `${action.label} · ${label}${action.kind === 'sync' && action.rootId ? ' · ' + action.rootId.slice(0, 8) : ''}` : label;
  };
  return <div className="storage-overview" data-storage-overview>
    {busy && <p role="status" className="storage-progress">{t(progress?.phase === 'counting' ? 'storage.counting' : 'storage.catalog')}
      {progress && ` · ${t('storage.visited').replace('{n}', String(progress.visited))}`}</p>}
    {error && <p role="alert">{t('storage.error')}</p>}
    {!report && !busy && <p className="storage-explanation">{t('storage.idle')}</p>}
    {report && <>
      <div className="storage-summary" data-storage-status={report.status}>
        <div><span>{t(report.uniqueReliable ? 'storage.unique' : 'storage.approximate')}</span><strong>{report.uniqueLogicalBytes === null ? t('storage.unknown') : `${report.status !== 'complete' || !report.uniqueReliable ? '≈ ' : ''}${formatBytes(report.uniqueLogicalBytes)}`}</strong></div>
        <div><span>{t('storage.files')}</span><strong>{report.files}</strong></div>
        <div><span>{t('storage.reclaimable')}</span><strong>{t('storage.previewRequired')}</strong></div>
      </div>
      <p role="status" className="storage-explanation">{t(`storage.status.${report.status}`)} · {new Date(report.scannedAt).toLocaleTimeString()}</p>
      <p className="storage-explanation">{t('storage.accounting')}</p>
      {!report.uniqueReliable && <p role="status" className="storage-explanation">{t('storage.identityUncertain')}</p>}
      <div className="storage-groups">
        {report.groups.map(group => <section className="storage-group" key={group.kind} data-storage-kind={group.kind}>
          <div className="storage-group-main"><h3>{t(`storage.kind.${group.kind}`)}</h3>
            <p>{t('storage.logical')}: <strong>{group.logicalBytes === null ? t('storage.unknown') : `${group.issues.length ? '≈ ' : ''}${formatBytes(group.logicalBytes)}`}</strong></p>
            {group.sharedBytes > 0 && <p>{t('storage.shared').replace('{size}', formatBytes(group.sharedBytes))}</p>}
            {group.mixedData && <p>{t('storage.mixed')}</p>}
            {group.issues.length > 0 && <p className="storage-issues">{[...new Set(group.issues)].map(reason => t(`storage.issue.${reason}`)).join(' · ')}</p>}
            <p>{t(group.actions.length ? 'storage.protectedUntilReview' : 'storage.protected')}</p>
          </div>
          {group.actions.length > 0 && <Button size="sm" variant="secondary" disabled={busy} data-storage-manage={group.kind} onClick={() => manage(group)}>{t('storage.manage')}</Button>}
        </section>)}
      </div>
      <p className="storage-explanation">{t('storage.scope')}</p>
    </>}
    {picker && createPortal(<Modal title={t('storage.targets')} onClose={() => setPicker(null)} size="md">
      <div className="storage-targets">{picker.actions.map((action, index) => <Button variant="secondary" key={index} data-storage-target={action.kind} onClick={() => open(action)}>{actionTitle(action)}</Button>)}</div>
      {picker.moreActions && <><p>{t('storage.moreActions')}</p><Button variant="secondary" onClick={() => { setPicker(null); window.dispatchEvent(new CustomEvent(STORAGE_OPEN_PAGE, { detail: 'rooms' })); }}>{t('storage.openRooms')}</Button></>}
    </Modal>, host.document.body)}
    <Suspense fallback={<p role="status">{t('common.loading')}</p>}>
      {target?.kind === 'room-data' && <RoomDataModal roomId={target.roomId} onClose={() => setTarget(null)} />}
      {target?.kind === 'sync' && <RoomSyncModal roomId={target.roomId} initialRootId={target.rootId} initialTrashStorage={target.section === 'trash'} initialStorage={target.section === 'trash' ? undefined : target.section} onClose={() => setTarget(null)} />}
      {target?.kind === 'documents' && <RoomDocumentsEditor roomId={target.roomId} onClose={() => setTarget(null)} />}
    </Suspense>
  </div>;
}
