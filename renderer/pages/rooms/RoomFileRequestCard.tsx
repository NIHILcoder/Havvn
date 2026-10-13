import React, { useRef, useState } from 'react';
import type { RoomFile, RoomChatMessage } from '../../../shared/types';
import { fileRequestText, type RoomFileRequest } from '../../../shared/room-chat-tools';
import { Button, Icon, Select } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';

export function RoomFileRequestCard({ request, message, roomId, files, canEdit, onAttach }: {
  request: RoomFileRequest; message: RoomChatMessage; roomId: string; files: RoomFile[]; canEdit: boolean; onAttach?: () => void;
}) {
  const { t } = useTranslation(), toast = useHostToast();
  const [fileId, setFileId] = useState(''), [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const update = async (status: RoomFileRequest['status']) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { await window.api.rooms.editChat(roomId, message.id, fileRequestText({ ...request, status, fileIds: status === 'fulfilled' && fileId ? [fileId] : [] })); }
    catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <span className="room-chat-request">
    <span className="room-chat-request-head"><Icon name="file-question" size={12} /> {t('rooms.request.title')}
      <span className={`room-request-status ${request.status}`}>{t(`rooms.request.status.${request.status}`)}</span></span>
    <span className="room-chat-request-text">{request.title}</span>
    {request.fileIds.map(id => {
      const file = files.find(f => f.fileId === id);
      return file ? <Button key={id} variant="ghost" size="sm" className="room-request-file" title={file.name} disabled={busy} onClick={async () => {
        if (pending.current) return;
        pending.current = true; setBusy(true);
        try { await window.api.rooms.fetchFile(roomId, id); }
        catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
        finally { pending.current = false; setBusy(false); }
      }}><Icon name="download" size={12} /><span>{file.name}</span></Button>
        : <span key={id} className="room-request-missing">{t('rooms.request.fileGone')}</span>;
    })}
    {request.status === 'open' && onAttach && <button type="button" className="room-chat-request-attach" onClick={onAttach}>
      <Icon name="file-plus" size={12} /> {t('rooms.request.attach')}</button>}
    {canEdit && <span className="room-request-controls">
      {request.status === 'open' ? <>
        <Select ariaLabel={t('rooms.request.linkFile')} value={fileId} disabled={busy} onChange={setFileId}
          options={[{ value: '', label: t('rooms.request.noFile') }, ...files.map(f => ({ value: f.fileId, label: f.name }))]} />
        <span className="room-request-buttons"><Button variant="ghost" size="sm" disabled={busy} onClick={() => void update('fulfilled')}>{t('rooms.request.fulfill')}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void update('cancelled')}>{t('rooms.request.cancel')}</Button></span>
      </> : <Button variant="ghost" size="sm" disabled={busy} onClick={() => void update('open')}>{t('rooms.request.reopen')}</Button>}
    </span>}
  </span>;
}
