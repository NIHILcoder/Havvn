import React, { useEffect, useState } from 'react';
import { FIRST_STEP_ROUTES, type FirstStepRoute } from '../../shared/first-steps';
import type { RoomSummary } from '../../shared/types';
import type { NavigationTarget } from '../commands/appCommands';
import { useTranslation } from '../utils/i18nContext';
import { firstSteps, useFirstSteps } from '../utils/first-steps';
import { downloadsModel, useDownloads } from '../state/downloads';
import Button from './Button';
import Icon, { type IconName } from './Icon';
import Modal from './Modal';
import { Select } from './Select';
import './FirstStepsGuide.css';

const icons: Record<FirstStepRoute, IconName> = { download: 'download', watch: 'play', share: 'users', play: 'server' };
const routeKeys = { download: 'first.download', watch: 'first.watch', share: 'first.share', play: 'first.play' } as const;

/** Read-only capability checks. Opening this guide never installs or starts a runtime. */
function useGameCapabilities(roomId?: string) {
  const [caps, setCaps] = useState({ checking: true, server: false, lan: false });
  useEffect(() => {
    let alive = true;
    setCaps({ checking: true, server: false, lan: false });
    void Promise.allSettled([
      Promise.resolve().then(() => window.api.rooms.servers.state('')),
      Promise.resolve().then(() => roomId ? window.api.rooms.get(roomId) : null),
    ]).then(([server, room]) => {
      if (alive) setCaps({ checking: false,
        server: server.status === 'fulfilled' && server.value?.available === true && server.value.modules.length > 0,
        lan: room.status === 'fulfilled' && room.value?.lan?.available === true,
      });
    });
    return () => { alive = false; };
  }, [roomId]);
  return caps;
}

export function Onboarding({ rooms, onClose, onSelect }: {
  rooms: readonly RoomSummary[]; onClose: () => void; onSelect: (route: FirstStepRoute) => void;
}) {
  const { t } = useTranslation();
  const { data, storageError } = useFirstSteps();
  const caps = useGameCapabilities(rooms[0]?.roomId);
  return <Modal title={t('first.title')} icon="info" onClose={onClose} className="first-chooser"
    footer={<Button onClick={onClose}>{t('first.later')}</Button>}>
    <p className="first-description">{t('first.intro')}</p>
    <div className="first-choices">
      {FIRST_STEP_ROUTES.map(route => {
        const unavailable = route === 'play' && !caps.server && !caps.lan;
        return <Button key={route} className="first-choice" disabled={unavailable}
          onClick={() => onSelect(route)} icon={<Icon name={icons[route]} size={22} />}>
          <span><strong>{t(routeKeys[route])}</strong><span>{t(`first.${route}.hint`)}</span>
            {data.routes[route].done && <small>{t('first.finished')}</small>}
            {unavailable && <small>{t(caps.checking ? 'first.checking' : 'first.gameUnavailable')}</small>}
          </span>
        </Button>;
      })}
    </div>
    <p className="first-description">{t('first.reopen')}</p>
    {storageError && <p role="status">{t('first.storageError')}</p>}
  </Modal>;
}

export function FirstStepsGuide({ rooms, navigate, onChoose, onClose }: {
  rooms: readonly RoomSummary[]; navigate: (target: NavigationTarget) => void; onChoose: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data, storageError } = useFirstSteps();
  const downloads = useDownloads(state => state.downloads);
  const route = data.active ?? 'download';
  const progress = data.routes[route];
  const [roomId, setRoomId] = useState(progress.target ?? '');
  const [downloadId, setDownloadId] = useState(progress.target ?? '');
  const room = rooms.find(row => row.roomId === roomId);
  const download = downloads.find(row => row.id === downloadId);
  const caps = useGameCapabilities(room?.roomId);
  useEffect(() => {
    const observe = () => {
      const target = firstSteps.getSnapshot().data.routes.download.target;
      const row = downloadsModel.store.getState().byId.get(target ?? '');
      if (row) firstSteps.observeDownload(row);
    };
    observe(); return downloadsModel.store.subscribe(observe);
  }, []);
  const roomTask = (action: 'files' | 'server' | 'lan') => {
    if (room) navigate({ kind: 'room-task', roomId: room.roomId, action });
  };
  return <section className="first-guide" aria-label={t('first.title')} data-first-route={route}>
    <div className="first-guide-heading"><h2>{t(routeKeys[route])}</h2>
      <div className="first-guide-tools"><Button size="sm" variant="ghost" onClick={onChoose}>{t('first.choose')}</Button>
        <Button size="sm" variant="ghost" iconOnly aria-label={t('first.hide')} title={t('first.hide')} onClick={onClose}><Icon name="x" size={16} /></Button></div>
    </div>
    <ol className="first-progress">
      <li data-complete={progress.prepared}><span aria-hidden="true">1</span>{t(`first.${route}.step1`)}{progress.prepared && <small>{t('first.ready')}</small>}</li>
      <li data-complete={progress.done}><span aria-hidden="true">2</span>{t(`first.${route}.step2`)}{progress.done && <small>{t('first.ready')}</small>}</li>
    </ol>
    <p className="first-description" role="status">{t(progress.done ? 'first.result' : `first.${route}.help`)}</p>
    {!progress.done && <div className="first-guide-actions">
      {(route === 'download' || route === 'watch') && <>
        <Button onClick={() => navigate({ kind: 'add-torrent' })}>{t('btn.addTorrent')}</Button>
        {route === 'watch' && <>
          <Select ariaLabel={t('first.selectDownload')} placeholder={t('first.selectDownload')} value={download?.id ?? ''}
            options={downloads.map(row => ({ value: row.id, label: row.name }))} onChange={setDownloadId} />
          <Button variant="primary" disabled={!download} onClick={() => download && navigate({ kind: 'watch-download', id: download.id })}>{t('first.openPlayer')}</Button>
        </>}
        {route === 'download' && progress.target && <Button onClick={() => navigate({ kind: 'download', id: progress.target! })}>{t('first.showDownload')}</Button>}
      </>}
      {(route === 'share' || route === 'play') && <>
        <Button onClick={() => navigate({ kind: 'room-task', action: 'create' })}>{t('rooms.create')}</Button>
        <Button onClick={() => navigate({ kind: 'room-task', action: 'join' })}>{t('rooms.join')}</Button>
        <Select ariaLabel={t('first.selectRoom')} placeholder={t('first.selectRoom')} value={room?.roomId ?? ''}
          options={rooms.map(row => ({ value: row.roomId, label: row.name }))} onChange={setRoomId} />
        {route === 'share' ? <Button variant="primary" disabled={!room || room.suspended} onClick={() => roomTask('files')}>{t('first.addFiles')}</Button> : <>
          {caps.server && <Button variant="primary" disabled={!room || room.suspended} onClick={() => roomTask('server')}>{t('first.openServer')}</Button>}
          {caps.lan && <Button disabled={!room || room.suspended} onClick={() => roomTask('lan')}>{t('first.openLan')}</Button>}
          {!caps.server && !caps.lan && <span>{t(caps.checking ? 'first.checking' : 'first.gameUnavailable')}</span>}
        </>}
      </>}
    </div>}
    {storageError && <p className="first-description" role="status">{t('first.storageError')}</p>}
  </section>;
}
