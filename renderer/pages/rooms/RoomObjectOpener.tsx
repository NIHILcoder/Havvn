import React, { lazy, Suspense, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow } from '../../utils/hostWindow';
import { requestRoomObject } from '../../utils/room-object-links';
import type { RoomObjectLink } from '../../../shared/room-object-links';
import type { RoomFile, RoomState } from '../../../shared/types';
import { classifyMediaKind } from '../../../shared/media';
import { formatBytes } from '../../utils/format-helpers';
const WorkArea = lazy(() => import('./RoomWorkArea').then(m => ({ default: m.RoomWorkArea })));
export function openRoomObject(room: RoomState, target: RoomObjectLink, fallback: (target: RoomObjectLink) => void) {
  if (!room.kicked && target.kind !== 'file' && requestRoomObject(room.roomId, target)) return;
  fallback(target);
}
export function RoomObjectOpener({ room, target, onClose, onWatch }: { room: RoomState; target: RoomObjectLink; onClose(): void; onWatch?(file: RoomFile): void }) {
  const { t } = useTranslation(), host = useHostWindow(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (target.kind !== 'file' && !room.kicked) return <Suspense fallback={null}><WorkArea roomId={room.roomId} initial={target.kind === 'document' ? 'documents' : 'files'} requestedObject={target} requestRevision={1} onRootsChange={() => {}} onClose={onClose} /></Suspense>;
  const file = target.kind === 'file' && !room.kicked ? room.files.find(file => file.fileId === target.id) : undefined;
  const have = file && room.transfers[file.fileId]?.haveLocally;
  return createPortal(<Modal title={target.name} icon="link" size="md" busy={busy} onClose={onClose} footer={<Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.close')}</Button>}>
    {!file ? <p role="status">{t('rooms.objects.unavailable')}</p> : <>
      <p><strong>{file.name}</strong> · {formatBytes(file.size)}</p><p>{t('rooms.objects.accessHint')}</p>
      {error && <p role="alert">{error}</p>}
      <div className="room-object-actions"><Button variant="primary" disabled={busy} onClick={() => { setBusy(true); setError(''); void (have ? window.api.rooms.openFile(room.roomId, file.fileId) : window.api.rooms.fetchFile(room.roomId, file.fileId)).catch(() => setError(t('rooms.objects.unavailable'))).finally(() => setBusy(false)); }}>{t(have ? 'rooms.objects.openFile' : 'rooms.objects.fetchFile')}</Button>
        {onWatch && classifyMediaKind(file.name) !== 'other' && <Button variant="secondary" disabled={busy} onClick={() => { onClose(); onWatch(file); }}>{t('rooms.objects.watch')}</Button>}
      </div>
    </>}
  </Modal>, host.document.body);
}
