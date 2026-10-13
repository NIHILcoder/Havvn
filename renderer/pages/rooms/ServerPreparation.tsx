import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Icon, Toggle } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import { useHostWindow } from '../../utils/hostWindow';
import type { RoomServerInstance, RoomState } from '../../../shared/types';
import { preparationAddress, preparationFiles, preparationNetwork } from '../../../shared/server-preparation';

export const ServerPreparation: React.FC<{ instance: RoomServerInstance; roomId: string; onConsole: () => void; onContent: () => void }> = ({ instance, roomId, onConsole, onContent }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const host = useHostWindow();
  const [room, setRoom] = useState<RoomState | null>(null);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const epoch = useRef(0);
  const roomRevision = useRef(0);
  const receivingRef = useRef(false);
  const contentSignature = JSON.stringify(instance.sharedContent);
  const fileSignature = preparationFiles(instance, room).map(file => `${file.fileId}:${file.infoHash}`).join('|');
  const invalidateReceive = useCallback(() => { epoch.current++; receivingRef.current = false; }, []);
  useEffect(() => {
    setConfirmed(false); setReceiving(false);
    invalidateReceive();
  }, [instance.instanceId, instance.version, contentSignature, fileSignature, invalidateReceive]);
  useEffect(() => {
    let alive = true, updated = false;
    setRoom(null); setError('');
    if (instance.local) return;
    const off = window.api.onRoomUpdate(state => { if (state.roomId === roomId) { updated = true; roomRevision.current++; setRoom(state); setError(''); } });
    void window.api.rooms.get(roomId).then(state => { if (alive && !updated) { setRoom(state); if (!state) setError(t('rooms.server.prepare.noRoom')); } })
      .catch(() => { if (alive && !updated) setError(t('rooms.server.prepare.noRoom')); });
    return () => { alive = false; invalidateReceive(); off(); };
  }, [roomId, instance.local, t, invalidateReceive]);
  const network = preparationNetwork(instance, room);
  const files = preparationFiles(instance, room);
  const missing = files.filter(f => !room?.transfers[f.fileId]?.haveLocally);
  const readyNetwork = network === 'local' || network === 'ready';
  const address = preparationAddress(instance);
  const ready = instance.status === 'running' && readyNetwork && confirmed && !!address;
  const receive = async () => {
    if (receivingRef.current || !room) return;
    const current = epoch.current;
    receivingRef.current = true;
    setReceiving(true);
    try {
      // Explicit reception only; downloaded jars are never installed/executed here.
      for (const f of missing) {
        if (current !== epoch.current) return;
        const revision = roomRevision.current;
        const state = await window.api.rooms.fetchFile(roomId, f.fileId);
        if (current === epoch.current && revision === roomRevision.current) setRoom(state);
      }
    } catch (e) { if (current === epoch.current) toast.error(String(e instanceof Error ? e.message : e)); }
    finally { if (current === epoch.current) { receivingRef.current = false; setReceiving(false); } }
  };
  return <section className="server-preparation" aria-label={t('rooms.server.prepare.title')}>
    <h4>{t('rooms.server.prepare.title')}</h4>
    <div className="server-preparation-check">
      <Icon name={instance.status === 'running' ? 'check-circle' : 'alert-circle'} size={15} />
      <div><strong>{t('rooms.server.prepare.server')}</strong><p>{t(`rooms.server.status.${instance.status}`)}</p></div>
      {instance.status === 'crashed' && <Button size="sm" variant="ghost" onClick={onConsole}>{t('rooms.server.console')}</Button>}
    </div>
    <div className="server-preparation-check">
      <Icon name={readyNetwork ? 'check-circle' : 'alert-circle'} size={15} />
      <div><strong>{t('rooms.server.prepare.network')}</strong><p>{error || t(`rooms.server.prepare.network.${network}`)}</p></div>
      {!readyNetwork && !instance.local && <Button size="sm" variant="ghost" onClick={() => window.dispatchEvent(new CustomEvent('room-reveal-panel', { detail: { roomId, panel: 'lan' } }))}>LAN</Button>}
    </div>
    <div className="server-preparation-check">
      <Icon name="package" size={15} /><div><strong>{t('rooms.server.prepare.version')}</strong><p>{instance.version}</p></div>
    </div>
    <div className="server-preparation-files">
      <strong>{t('rooms.server.prepare.files')}</strong>
      <p>{instance.sharedContent === undefined ? t('rooms.server.prepare.filesUnknown') : files.length ? t('rooms.server.prepare.fileCount').replace('{ready}', String(files.length - missing.length)).replace('{total}', String(files.length)) : t('rooms.server.prepare.noFiles')}</p>
      {!!files.length && <ul>{files.slice(0, 40).map(f => <li key={f.fileId}><Icon name={room?.transfers[f.fileId]?.haveLocally ? 'check-circle' : 'download'} size={12} /><span>{f.name}</span></li>)}</ul>}
      <p>{t('rooms.server.prepare.filesHint')}</p>
      {!!missing.length && <Button size="sm" onClick={() => void receive()} loading={receiving}>{t('rooms.server.prepare.receive')}</Button>}
      {instance.isHost && !instance.local && <Button size="sm" variant="ghost" onClick={onContent}>{t('rooms.server.prepare.manageContent')}</Button>}
    </div>
    <label className="server-preparation-confirm"><Toggle checked={confirmed} onChange={setConfirmed} ariaLabel={t('rooms.server.prepare.confirm')} /><span>{t('rooms.server.prepare.confirm')}</span></label>
    <p className="server-preparation-result" role="status">{t(ready ? 'rooms.server.prepare.ready' : 'rooms.server.prepare.pending')}</p>
    <Button size="sm" variant="primary" disabled={!ready} onClick={() => { if (address) void host.window.navigator.clipboard.writeText(address).then(() => toast.success(t('rooms.server.prepare.copied'))).catch(() => toast.error(t('rooms.server.prepare.copyFailed'))); }}>{t('rooms.server.prepare.copy')}</Button>
    {address && <code>{address}</code>}
  </section>;
};
