import { createPortal } from 'react-dom';
import { useHostWindow } from '../../utils/hostWindow';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal, Select, Toggle, useConfirm } from '../../components';
import { ROOM_HISTORY_DAYS, type RoomDiskUsage, type RoomHistoryDays, type RoomHistoryPage } from '../../../shared/room-local-data';
import { useTranslation } from '../../utils/i18nContext';
import { formatBytes } from '../../utils/format-helpers';
import { RoomBackupModal } from './RoomBackupModal';
import './RoomDataModal.css';

export function RoomDataModal({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const host = useHostWindow();
  const { t } = useTranslation(), { confirm } = useConfirm();
  const [usage, setUsage] = useState<RoomDiskUsage | null>(null), [selection, setSelection] = useState<string[]>([]);
  const [kind, setKind] = useState<'chat' | 'event'>('chat'), [page, setPage] = useState<RoomHistoryPage | null>(null);
  const [days, setDays] = useState<RoomHistoryDays>(30), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [backup, setBackup] = useState(false);
  const operation = useRef(false), generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setBusy(true); setError('');
    try {
      const [disk, history] = await Promise.all([window.api.rooms.diskUsage(roomId), window.api.rooms.localHistory(roomId, kind)]);
      if (current !== generation.current) return;
      setUsage(disk); setSelection([]); setPage(history); setDays(history.retentionDays);
    } catch (cause) { if (current === generation.current) setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { if (current === generation.current) setBusy(false); }
  }, [roomId, kind]);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useEffect(() => { void load(); return invalidate; }, [load, invalidate]); // one mounted instance per room
  const work = async (action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { operation.current = false; setBusy(false); }
  };
  const selectedBytes = usage?.files.filter(file => selection.includes(file.fileId)).reduce((n,file)=>n+file.removable,0) ?? 0;
  const cleanup = () => work(async () => {
    if (!usage || !selection.length) return;
    if (!await confirm({ title: t('rooms.data.cleanup'), message: t('rooms.data.cleanupConfirm').replace('{size}', formatBytes(selectedBytes)), danger: true })) return;
    const result = await window.api.rooms.cleanupCopies(roomId, usage.previewId, selection);
    await load(); setNotice(t('rooms.data.cleaned').replace('{size}', formatBytes(result.bytes)));
  });
  const retention = () => work(async () => {
    if (!await confirm({ title: t('rooms.data.retention'), message: t('rooms.data.retentionConfirm'), danger: true })) return;
    await window.api.rooms.setHistoryRetention(roomId, days);
    setPage(await window.api.rooms.localHistory(roomId, kind)); setNotice(t('rooms.data.saved'));
  });
  const earlier = () => work(async () => {
    if (!page?.next) return;
    const older = await window.api.rooms.localHistory(roomId, kind, page.next);
    if (older.cursorExpired) { setPage(await window.api.rooms.localHistory(roomId, kind)); setNotice(t('rooms.data.cursorExpired')); }
    else setPage({ ...older, items: [...older.items, ...page.items] });
  });
  return createPortal(<>
    <Modal title={t('rooms.data.title')} icon="folder" size="xl" onClose={onClose} busy={busy}
      footer={<><Button variant="secondary" disabled={busy} onClick={() => setBackup(true)}>{t('rooms.data.backup')}</Button><Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.close')}</Button></>}>
      <div className="room-data-panel" aria-busy={busy}>
        {error && <div role="alert" className="room-data-error">{error}</div>}
        {notice && <p role="status">{notice}</p>}
        <div className="room-data-heading"><strong>{t('rooms.data.disk')}</strong><Button variant="secondary" loading={busy} disabled={operation.current} onClick={load}>{t('rooms.data.refresh')}</Button></div>
        {usage && <>
          <div className="room-data-stats">
            <span>{t('rooms.data.plaintext')}<b>{formatBytes(usage.plaintext)}</b></span>
            <span>{t('rooms.data.ciphertext')}<b>{formatBytes(usage.ciphertext)}</b></span>
            <span>{t('rooms.data.originals')}<b>{formatBytes(usage.originals)}</b></span>
            <span>{t('rooms.data.removable')}<b>{formatBytes(usage.removable)}</b></span>
          </div>
          <p>{t('rooms.data.cleanupHint')}</p>
          {!!usage.protectedCiphertext && <p>{t('rooms.data.protectedCipher').replace('{size}', formatBytes(usage.protectedCiphertext))}</p>}
          {!!usage.untrackedBytes && <p>{t('rooms.data.untracked').replace('{size}', formatBytes(usage.untrackedBytes))}</p>}
          {!!usage.skipped && <p>{t('rooms.data.skipped').replace('{n}', String(usage.skipped))}</p>}
          <label className="room-data-toggle"><Toggle disabled={busy || !usage.removable} checked={!!selection.length && selection.length === usage.files.filter(file=>file.removable).length} onChange={value=>setSelection(value ? usage.files.filter(file=>file.removable).map(file=>file.fileId) : [])} ariaLabel={t('rooms.data.selectAll')} /><span>{t('rooms.data.selectAll')}</span></label>
          <div className="room-data-list">
            {usage.files.map(file=><label className="room-data-toggle" key={file.fileId}><Toggle size="small" checked={selection.includes(file.fileId)} disabled={busy || !file.removable} onChange={value=>setSelection(prev=>value ? [...prev,file.fileId] : prev.filter(id=>id!==file.fileId))} ariaLabel={file.name} /><span>{file.name}{file.original && <small>{t('rooms.data.originalProtected')}</small>}</span><b>{formatBytes(file.removable)}</b></label>)}
          </div>
          <Button variant="primary" disabled={busy || !selectedBytes} onClick={cleanup}>{t('rooms.data.cleanup')} · {formatBytes(selectedBytes)}</Button>
        </>}
        <hr />
        <div className="room-data-heading"><strong>{t('rooms.data.retention')}</strong><Select value={String(days)} disabled={busy} ariaLabel={t('rooms.data.retention')} options={ROOM_HISTORY_DAYS.map(value=>({ value: String(value), label: value ? t('rooms.data.days').replace('{n}',String(value)) : t('rooms.data.forever') }))} onChange={value=>setDays(Number(value) as RoomHistoryDays)} /><Button variant="secondary" disabled={busy || !page || days === page.retentionDays} onClick={retention}>{t('common.save')}</Button></div>
        <p>{t('rooms.data.historyHint')}</p>
        <div className="room-data-heading"><strong>{t('rooms.data.history')}</strong><Select value={kind} disabled={busy} ariaLabel={t('rooms.data.history')} options={[{ value: 'chat', label: t('rooms.data.chat') },{ value: 'event', label: t('rooms.history') }]} onChange={value=>setKind(value as 'chat' | 'event')} /></div>
        <div className="room-data-list room-data-history">
          {page?.items.slice().reverse().map(item => item.kind === 'chat' ? <article key={'c'+item.message.id}><header><b>{item.message.name}</b><time>{new Date(item.message.at).toLocaleString()}</time></header><p>{item.message.text}</p></article>
            : <article key={'e'+item.event.id}><header><b>{item.event.actorName}</b><time>{new Date(item.event.at).toLocaleString()}</time></header><p>{t(({created:'rooms.ev.created',joined:'rooms.ev.joined',left:'rooms.ev.left','file-added':'rooms.ev.fileAdded','file-removed':'rooms.ev.fileRemoved',kicked:'rooms.ev.kicked',rekeyed:'rooms.ev.rekeyed','ownership-transferred':'rooms.ev.ownerTransferred'} as const)[item.event.type])} {item.event.fileName || item.event.targetName || ''}</p></article>)}
          {page?.items.length === 0 && <p>{t('rooms.historyEmpty')}</p>}
        </div>
        {page?.next && <Button variant="secondary" disabled={busy} onClick={earlier}>{t('rooms.chatShowEarlier')}</Button>}
      </div>
    </Modal>
    {backup && <RoomBackupModal roomId={roomId} mode="export" onClose={()=>setBackup(false)} onDone={()=>setNotice(t('settings.roomIdentity.exported'))} />}
  </>, host.document.body);
}
