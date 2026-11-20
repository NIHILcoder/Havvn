import React, { useEffect, useId, useRef, useState } from 'react';
import { FIRST_STEP_ROUTES, type FirstStepRoute, type RouteProgress } from '../../shared/first-steps';
import type { RoomSummary } from '../../shared/types';
import type { NavigationTarget } from '../commands/appCommands';
import { downloadsModel, useDownloads } from '../state/downloads';
import { useTranslation } from '../utils/i18nContext';
import { firstSteps, useFirstSteps } from '../utils/first-steps';
import Button from './Button';
import Icon, { type IconName } from './Icon';
import { Select } from './Select';
import './FirstStepsGuide.css';

export type FirstStepsView = 'hidden' | 'collapsed' | 'routes' | 'guide';

const icons: Record<FirstStepRoute, IconName> = { download: 'download', watch: 'play', share: 'users', play: 'server' };
const pendingCapabilities = { checking: true, server: false, lan: false };

function useGameCapabilities(enabled: boolean, roomId?: string) {
  const [result, setResult] = useState<{ roomId?: string; server: boolean; lan: boolean }>();
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void Promise.allSettled([
      Promise.resolve().then(() => window.api.rooms.servers.state('')),
      Promise.resolve().then(() => roomId ? window.api.rooms.get(roomId) : null),
    ]).then(([server, room]) => {
      if (alive) setResult({
        roomId,
        server: server.status === 'fulfilled' && server.value?.available === true && server.value.modules.length > 0,
        lan: room.status === 'fulfilled' && room.value?.lan?.available === true,
      });
    });
    return () => { alive = false; };
  }, [enabled, roomId]);
  if (!enabled || !result || result.roomId !== roomId) return pendingCapabilities;
  return { ...result, checking: false };
}

export function Onboarding({ rooms, onClose, onSelect }: {
  rooms: readonly RoomSummary[]; onClose: () => void; onSelect: (route: FirstStepRoute) => void;
}) {
  const { t } = useTranslation();
  const { data } = useFirstSteps();
  const caps = useGameCapabilities(true, rooms[0]?.roomId);
  return <div className="first-chooser">
    <p className="first-description">{t('first.intro')}</p>
    <ul className="first-choices">
      {FIRST_STEP_ROUTES.map(route => {
        const unavailable = route === 'play' && !caps.server && !caps.lan;
        return <li key={route}>
          <Button className="first-choice" variant="ghost" disabled={unavailable} onClick={() => onSelect(route)}
            icon={<Icon name={icons[route]} size={19} className="first-choice-icon" />}>
            <span className="first-choice-copy">
              <strong>{t(`first.${route}`)}</strong>
              <span>{t(`first.${route}.hint`)}</span>
              {data.routes[route].done && <small>{t('first.finished')}</small>}
              {unavailable && <small>{t(caps.checking ? 'first.checking' : 'first.gameUnavailable')}</small>}
            </span>
            {!unavailable && <Icon name="chevron-right" size={15} />}
          </Button>
        </li>;
      })}
    </ul>
    <div className="first-panel-footer">
      <Button size="sm" variant="ghost" onClick={onClose}>{t('first.later')}</Button>
    </div>
  </div>;
}

function RouteActions({ route, progress, rooms, navigate }: {
  route: FirstStepRoute; progress: RouteProgress; rooms: readonly RoomSummary[];
  navigate: (target: NavigationTarget) => void;
}) {
  const { t } = useTranslation();
  const downloads = useDownloads(state => state.downloads);
  const [selectedId, setSelectedId] = useState<string>();
  const target = selectedId ?? progress.target;
  const room = rooms.find(row => row.roomId === target);
  const download = downloads.find(row => row.id === target);
  const caps = useGameCapabilities(route === 'play', room?.roomId);

  if (route === 'download') {
    const id = downloads.some(row => row.id === progress.target) ? progress.target : undefined;
    return <div className="first-actions">{id
      ? <Button variant="primary" onClick={() => navigate({ kind: 'download', id })}>{t('first.showDownload')}</Button>
      : <Button variant="primary" onClick={() => navigate({ kind: 'add-torrent' })}>{t('btn.addTorrent')}</Button>}
    </div>;
  }

  if (route === 'watch') {
    return <div className="first-actions">
      {downloads.length > 0 && <>
        <Select ariaLabel={t('first.selectDownload')} placeholder={t('first.selectDownload')} value={download?.id ?? ''}
          options={downloads.map(row => ({ value: row.id, label: row.name }))} onChange={setSelectedId} />
        <Button variant="primary" disabled={!download} onClick={() => download && navigate({ kind: 'watch-download', id: download.id })}>{t('first.openPlayer')}</Button>
      </>}
      <Button variant={downloads.length ? 'secondary' : 'primary'} onClick={() => navigate({ kind: 'add-torrent' })}>{t('btn.addTorrent')}</Button>
    </div>;
  }

  const openRoomTask = (action: 'files' | 'server' | 'lan') => {
    if (room) navigate({ kind: 'room-task', roomId: room.roomId, action });
  };
  return <div className="first-actions">
    {rooms.length > 0 && <Select ariaLabel={t('first.selectRoom')} placeholder={t('first.selectRoom')} value={room?.roomId ?? ''}
      options={rooms.map(row => ({ value: row.roomId, label: row.name }))} onChange={setSelectedId} />}
    {room && (route === 'share'
      ? <Button variant="primary" disabled={room.suspended} onClick={() => openRoomTask('files')}>{t('first.addFiles')}</Button>
      : <>
        {caps.server && <Button variant="primary" disabled={room.suspended} onClick={() => openRoomTask('server')}>{t('first.openServer')}</Button>}
        {caps.lan && <Button variant={caps.server ? 'secondary' : 'primary'} disabled={room.suspended} onClick={() => openRoomTask('lan')}>{t('first.openLan')}</Button>}
        {!caps.server && !caps.lan && <p className="first-description" role="status">{t(caps.checking ? 'first.checking' : 'first.gameUnavailable')}</p>}
      </>)}
    <Button variant={room ? 'ghost' : 'primary'} onClick={() => navigate({ kind: 'room-task', action: 'create' })}>{t('rooms.create')}</Button>
    <Button variant={room ? 'ghost' : 'secondary'} onClick={() => navigate({ kind: 'room-task', action: 'join' })}>{t('rooms.join')}</Button>
  </div>;
}

function RouteGuide({ route, progress, rooms, navigate }: {
  route: FirstStepRoute; progress: RouteProgress; rooms: readonly RoomSummary[];
  navigate: (target: NavigationTarget) => void;
}) {
  const { t } = useTranslation();
  return <>
    <ol className="first-progress" aria-label={t('first.steps')}>
      {([1, 2] as const).map(step => {
        const done = step === 1 ? progress.prepared : progress.done;
        const current = !progress.done && step === (progress.prepared ? 2 : 1);
        return <li key={step} data-complete={done} aria-current={current ? 'step' : undefined}>
          <span className="first-step-number" aria-hidden="true">{step}</span>
          <span>{t(`first.${route}.step${step}`)}</span>
          {done && <small>{t('first.ready')}</small>}
        </li>;
      })}
    </ol>
    <p role="status" className="first-description first-instruction">
      {t(progress.done ? 'first.result' : `first.${route}.help${progress.prepared ? 2 : 1}`)}
    </p>
    {!progress.done && <RouteActions key={route} route={route} progress={progress} rooms={rooms} navigate={navigate} />}
  </>;
}

export function FirstStepsGuide({ view, floating, rooms, navigate, onView }: {
  view: Exclude<FirstStepsView, 'hidden'>; floating: boolean; rooms: readonly RoomSummary[];
  navigate: (target: NavigationTarget) => void; onView: (view: FirstStepsView) => void;
}) {
  const { t } = useTranslation();
  const { data, storageError } = useFirstSteps();
  const panelId = useId();
  const dock = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const expanded = view !== 'collapsed';
  const route = view !== 'routes' ? data.active : null;

  useEffect(() => {
    if (!expanded || !title.current) return;
    const active = title.current.ownerDocument.activeElement;
    if (active instanceof HTMLElement && !dock.current?.contains(active)) previousFocus.current = active;
    title.current.focus({ preventScroll: true });
  }, [expanded, route]);

  useEffect(() => {
    const root = dock.current;
    if (!expanded || !root) return;
    const outside = (event: PointerEvent) => {
      if (!root.contains(event.target as Node)) onView('collapsed');
    };
    root.ownerDocument.addEventListener('pointerdown', outside);
    return () => root.ownerDocument.removeEventListener('pointerdown', outside);
  }, [expanded, onView]);

  useEffect(() => {
    if (data.active !== 'download' || data.routes.download.done) return;
    const observe = () => {
      const target = firstSteps.getSnapshot().data.routes.download.target;
      const row = downloadsModel.store.getState().byId.get(target ?? '');
      if (row) firstSteps.observeDownload(row);
    };
    observe();
    return downloadsModel.store.subscribe(observe);
  }, [data.active, data.routes.download.done]);

  const collapse = () => {
    onView('collapsed');
    launcher.current?.focus({ preventScroll: true });
  };
  const dismiss = () => {
    onView('hidden');
    previousFocus.current?.focus({ preventScroll: true });
  };

  return <div ref={dock} className={`first-dock${floating ? ' first-dock-floating' : ''}`} onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !expanded) return;
    event.stopPropagation();
    collapse();
  }}>
    <button type="button" ref={launcher} className="btn btn-ghost btn-sm first-launcher" aria-expanded={expanded} aria-controls={panelId}
      onClick={() => expanded ? collapse() : onView(data.active ? 'guide' : 'routes')}>
      <Icon name="book-open" size={15} />
      <span>{t('first.title')}</span>
      <Icon name={expanded ? 'chevron-down' : 'chevron-up'} size={13} />
    </button>
    <section id={panelId} className="first-panel" aria-labelledby={`${panelId}-title`} hidden={!expanded}>
      <header className="first-panel-header">
        {route ? <Button size="sm" variant="ghost" iconOnly aria-label={t('first.choose')} title={t('first.choose')} onClick={() => onView('routes')}>
          <Icon name="chevron-left" size={17} />
        </Button> : <Icon className="first-panel-icon" name="book-open" size={20} />}
        <h2 id={`${panelId}-title`} ref={title} tabIndex={-1}>{t(route ? `first.${route}` : 'first.title')}</h2>
        <Button size="sm" variant="ghost" iconOnly aria-label={t('first.minimize')} title={t('first.minimize')} onClick={collapse}><Icon name="chevron-down" size={16} /></Button>
        <Button size="sm" variant="ghost" iconOnly aria-label={t('first.hide')} title={t('first.hide')} onClick={dismiss}><Icon name="x" size={16} /></Button>
      </header>
      <div className="first-panel-body">
        {route ? <RouteGuide key={route} route={route} progress={data.routes[route]} rooms={rooms}
          navigate={target => { collapse(); navigate(target); }} />
          : expanded && <Onboarding rooms={rooms} onClose={dismiss} onSelect={next => { firstSteps.begin(next); onView('guide'); }} />}
        {storageError && <p className="first-description" role="status">{t('first.storageError')}</p>}
      </div>
    </section>
  </div>;
}
