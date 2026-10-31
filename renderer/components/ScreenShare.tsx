/**
 * Screenshare UI: the source picker (which screen/window to share) and the
 * viewing overlay (a peer's stream — or our own self-preview).
 *
 * The media plane lives in the hidden room-engine window; a MediaStream cannot
 * cross Electron windows, so the overlay opens a LOCAL loopback RTCPeerConnection
 * (host candidates only — nothing leaves the machine) whose far end is the
 * engine's ScreenForwarder. Signaling rides IPC: the engine offers
 * (onRoomScreenSignal), we answer via rooms.screen.signal; 'end' means the
 * stream is gone and the overlay closes itself.
 *
 * The picker portals to the OWNING document's <body> (its opener lives inside the
 * room's container-query subtree, whose containment would trap a fixed backdrop) —
 * owning, not the main window's, because the panel that opens it can be detached
 * into its own window. ScreenView renders INLINE in the room Stage — no fixed
 * backdrop to trap, and it still goes fullscreen via requestFullscreen() (the top
 * layer escapes containment). Fullscreen state is read off the STAGE ELEMENT'S
 * document: `requestFullscreen()` sets `fullscreenElement` on that element's
 * document, so checking any other one reports "not fullscreen" and the toggle
 * stops toggling.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { Button } from './Button';
import { Select } from './Select';
import { useTranslation } from '../utils/i18nContext';
import { HostWindowRealm, useHostWindow, usePortalTarget } from '../utils/hostWindow';
import { useHostToast } from '../utils/hostToast';
import type { ScreenSourceInfo } from '../../shared/types';
import { SCREEN_SHARE_HEIGHTS, SCREEN_SHARE_FPS, effectiveScreenBitrate, type ScreenShareSettings } from '../../shared/screen-share';
import { DEFAULT_ROOM_RESOURCES } from '../../shared/room-resources';
import { loadScreenSharePrefs, saveScreenSharePrefs, useScreenShareSelection } from '../utils/screenSharePrefs';
import { ScreenQualityPresets } from './ScreenQualityPresets';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { ErrorMessage } from './ErrorMessage';
import { usePopout } from '../utils/popout';
import { SCREEN_VIEW_FRAME } from '../../shared/player-windows';
import { WindowControls } from '../layout/WindowControls';
import { minimizeDockWindow, toggleMaximizeDockWindow, useDockWindowMaximized } from '../pages/rooms/dock/dockWindowChrome';
import './ScreenShare.css';

export const ScreenSourcePicker: React.FC<{
  onClose: () => void;
  onPick: (sourceId: string, withAudio: boolean, settings: ScreenShareSettings) => void;
  bitrateLimitKbps?: number;
}> = ({ onClose, onPick, bitrateLimitKbps = DEFAULT_ROOM_RESOURCES.screenBitrateKbps }) => {
  const { t, language } = useTranslation();
  // No element of our own to read an ownerDocument from — the portal container
  // is needed before anything mounts — so this is the context case. With no
  // provider above (the whole main tree) it IS `document.body`, unchanged.
  const portalTarget = usePortalTarget();
  const [sources, setSources] = useState<ScreenSourceInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { settings, manual, setSettings, choosePreset } = useScreenShareSelection(loadScreenSharePrefs);
  const starting = useRef(false);
  const mounted = useRef(true), pending = useRef(false), request = useRef<object | null>(null);
  // Opt-in system audio (M20): off by default — sharing system audio shares
  // everything playing, and the call echo canceller is best-effort. Windows only.
  const [withAudio, setWithAudio] = useState(false);
  const audioSupported = sources?.some(source => source.systemAudioSupported === true) ?? false;
  const selectedSource = sources?.find(source => source.id === selected);
  const start = () => {
    if (!selectedSource || starting.current) return;
    starting.current = true;
    saveScreenSharePrefs(settings, manual);
    onPick(selectedSource.id, audioSupported && withAudio, settings);
  };
  const mbps = (kbps: number) => (kbps / 1000).toLocaleString(language, { maximumFractionDigits: 2 });

  const refresh = useCallback(() => {
    if (pending.current) return;
    const id = {}; request.current = id;
    const active = () => mounted.current && request.current === id;
    pending.current = true; setSources(null); setFailed(false);
    window.api.rooms.screen.sources()
      .then(value => { if (active()) { setSources(value); setSelected(current => value.some(source => source.id === current) ? current : null); } })
      .catch(() => { if (active()) { setFailed(true); setSources([]); } })
      .finally(() => { if (active()) pending.current = false; });
  }, []);
  // A late reply belongs to this picker session, including StrictMode remounts.
  useEffect(() => {
    mounted.current = true; refresh();
    return () => { mounted.current = false; request.current = null; pending.current = false; };
  }, [refresh]);

  const group = (display: boolean) => (sources || []).filter((s) => s.display === display);
  const tile = (s: ScreenSourceInfo) => (
    <button key={s.id} type="button" className={`ssp-tile${selected === s.id ? ' selected' : ''}`} onClick={() => setSelected(s.id)} title={s.name} aria-pressed={selected === s.id}>
      <span className="ssp-thumb">
        {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <Icon name="monitor" size={24} />}
      </span>
      <span className="ssp-name">{s.name}</span>
    </button>
  );

  return createPortal(
    <Modal
      onClose={onClose} title={t('rooms.screen.pickerTitle')} icon="screen-share" size="lg" bodyClassName="ssp-body"
      footer={
        <div className="ssp-footer">
          <button className="ssp-refresh" onClick={refresh} disabled={sources === null} aria-busy={sources === null}>
            <Icon name="refresh-cw" size={13} /> {t('rooms.screen.refresh')}
          </button>
          <Button variant="primary" onClick={start} disabled={!selectedSource}>{t('rooms.screen.start')}</Button>
        </div>
      }
    >
      <ScreenQualityPresets settings={settings} onChoose={choosePreset} />
      <div className="ssp-quality" role="group" aria-label={t('rooms.screen.quality')}>
        <div className="ssp-setting">
          <span>{t('rooms.screen.resolution')}</span>
          <Select ariaLabel={t('rooms.screen.resolution')} value={String(settings.height)}
            options={SCREEN_SHARE_HEIGHTS.map(height => ({ value: String(height), label: `${height}p` }))}
            onChange={value => setSettings(current => ({ ...current, height: Number(value) as ScreenShareSettings['height'] }))} />
        </div>
        <div className="ssp-setting">
          <span>{t('rooms.screen.frameRate')}</span>
          <Select ariaLabel={t('rooms.screen.frameRate')} value={String(settings.fps)}
            options={SCREEN_SHARE_FPS.map(fps => ({ value: String(fps), label: `${fps} FPS` }))}
            onChange={value => setSettings(current => ({ ...current, fps: Number(value) as ScreenShareSettings['fps'] }))} />
        </div>
        <div className="ssp-setting">
          <span>{t('rooms.screen.bitrate')}</span>
          <Select ariaLabel={t('rooms.screen.bitrate')} value={String(settings.bitrateKbps)}
            options={[{ value: '0', label: t('rooms.screen.bitrateAuto') }, ...[...new Set([500, 750, 1000, 2500, 4000, 5000, 8000, 12000, 20000, settings.bitrateKbps].filter(value => value > 0))].sort((a, b) => a - b).map(kbps => ({ value: String(kbps), label: `${mbps(kbps)} ${t('rooms.screen.mbps')}` }))]}
            onChange={value => setSettings(current => ({ ...current, bitrateKbps: Number(value) }))} />
        </div>
      </div>
      <p className="ssp-hint">{t('rooms.screen.bitrateHint').replace('{effective}', mbps(effectiveScreenBitrate(settings, bitrateLimitKbps))).replace('{limit}', mbps(bitrateLimitKbps))}</p>
      <div className="ssp-audio-setting">
        <label className={`ssp-audio${!audioSupported ? ' unavailable' : ''}`}>
          <input type="checkbox" checked={audioSupported && withAudio} disabled={!audioSupported} onChange={(e) => setWithAudio(e.target.checked)} />
          <Icon name="volume-2" size={13} /> {t('rooms.screen.shareAudio')}
        </label>
        <p className="ssp-hint">{t(audioSupported ? 'rooms.screen.shareAudioHint' : 'rooms.screen.shareAudioUnavailable')}</p>
      </div>
      <p className="ssp-hint">{t('rooms.screen.qualityHint')}</p>
      {failed ? (
        <div className="ssp-loading ssp-error" role="alert">{t('rooms.screen.sourcesFailed')}</div>
      ) : sources === null ? (
        <div className="ssp-loading">{t('common.loading')}</div>
      ) : sources.length === 0 ? (
        <div className="ssp-loading">{t('rooms.screen.noSources')}</div>
      ) : (
        <>
          {group(true).length > 0 && <div className="ssp-group">{t('rooms.screen.screens')}</div>}
          <div className="ssp-grid">{group(true).map(tile)}</div>
          {group(false).length > 0 && <div className="ssp-group">{t('rooms.screen.windows')}</div>}
          <div className="ssp-grid">{group(false).map(tile)}</div>
        </>
      )}
    </Modal>,
    portalTarget,
  );
};

export const ScreenView: React.FC<{
  roomId: string;
  memberId: string;
  title: string;
  onClose: () => void;
  isSelf?: boolean;
  settings?: ScreenShareSettings;
  bitrateLimitKbps?: number;
  onDetachedChange?: (detached: boolean) => void;
  theater?: boolean;
  onToggleTheater?: () => void;
}> = ({ roomId, memberId, title, onClose, isSelf = false, settings, bitrateLimitKbps,
  onDetachedChange, theater = false, onToggleTheater }) => {
  const { t } = useTranslation();
  const host = useHostWindow();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const homeSlot = useRef<HTMLDivElement>(null), windowSlot = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = host.document.createElement('div');
    setSurface(element);
    return () => element.remove();
  }, [host.document]);
  const { popout, root, portal, openPopout, closePopout } = usePopout(SCREEN_VIEW_FRAME, `${t('rooms.screen.watching')} · ${title}`);
  const detached = !!popout && !popout.closed;
  const maximized = useDockWindowMaximized(SCREEN_VIEW_FRAME, detached);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [fit, setFit] = useState<'contain' | 'cover'>('contain');
  const [muted, setMuted] = useState(false), [volume, setVolume] = useState(100);
  const [audioError, setAudioError] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [fullscreenOn, setFullscreenOn] = useState(false);
  const fullscreenExitAt = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Through a ref for the same reason `onClose` is: the signalling effect must NOT
  // re-run when the realm changes (it would tear down the loopback peer connection
  // mid-stream), and it must still toast into whichever window it is in NOW.
  const toast = useHostToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const tRef = useRef(t); tRef.current = t;

  // The portal target and video element stay the SAME. Moving their DOM between
  // documents must never recreate the loopback PC or send watchStop/watchStart.
  useLayoutEffect(() => {
    if (!surface) return;
    surface.className = 'ssv-mount';
    (detached ? windowSlot.current : homeSlot.current)?.appendChild(surface);
    const video = videoRef.current;
    if (video?.srcObject) void video.play().catch(() => {});
  }, [surface, detached, root]);
  useEffect(() => {
    if (!popout || !surface) return;
    // Rescue the live DOM synchronously, BEFORE the child document is destroyed.
    const rescue = () => { homeSlot.current?.appendChild(surface); };
    popout.addEventListener('beforeunload', rescue);
    return () => popout.removeEventListener('beforeunload', rescue);
  }, [popout, surface]);
  useEffect(() => { onDetachedChange?.(detached); }, [detached, onDetachedChange]);
  useEffect(() => {
    if (popout && !popout.closed) popout.document.title = `${t('rooms.screen.watching')} · ${title}`;
  }, [popout, title, t]);
  const attach = () => {
    setMenu(null); setQualityOpen(false);
    if (surface) homeSlot.current?.appendChild(surface);
    closePopout();
  };
  const detach = () => {
    setMenu(null);
    if (detached) attach();
    else if (!openPopout()) toastRef.current.error(t('rooms.screen.detachFailed'));
  };
  useEffect(() => {
    const video = videoRef.current;
    if (video) { video.muted = isSelf || muted; video.volume = volume / 100; }
  }, [isSelf, muted, volume, detached]);
  useEffect(() => {
    if (isSelf) return;
    let active = true;
    const timer = host.window.setTimeout(() => {
      Promise.resolve().then(() => window.api.rooms.screen.playback(roomId, memberId, volume / 100, muted))
        .then(result => { if (active) setAudioError(!result?.ok); })
        .catch(() => { if (active) setAudioError(true); });
    }, 80);
    return () => { active = false; host.window.clearTimeout(timer); };
  }, [roomId, memberId, volume, muted, isSelf, host]);

  useEffect(() => {
    let dead = false, ended = false;
    const pc = new RTCPeerConnection({ iceServers: [] }); // loopback — host candidates only
    const active = () => !dead && !ended;
    const finish = (error?: unknown) => {
      if (!active()) return;
      ended = true;
      if (error) toastRef.current.error(String(error instanceof Error ? error.message : error));
      try { pc.close(); } catch { /* already closed */ }
      closeRef.current();
    };
    pc.ontrack = ({ streams }) => {
      if (!active()) return;
      const v = videoRef.current;
      if (v && streams[0]) {
        v.srcObject = streams[0];
        v.play().catch(() => { /* video-only autoplay is permitted; ignore */ });
      }
    };
    // If the engine (forwarder) dies without sending 'end' — e.g. its renderer
    // crashed — the loopback drops; close the frozen overlay instead of hanging.
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') finish();
    };
    // IPC delivery may put an ICE candidate ahead of its offer. Serialize SDP
    // work and keep early candidates until setRemoteDescription has completed.
    let signals = Promise.resolve();
    const earlyIce: RTCIceCandidateInit[] = [];
    // Subscribe BEFORE asking the engine to start, so the offer can't beat us.
    const off = window.api.onRoomScreenSignal((msg) => {
      if (!active() || msg.roomId !== roomId || msg.memberId !== memberId) return;
      if (msg.kind === 'end') { finish(); return; }
      signals = signals.then(async () => {
          if (!active()) return;
          if (msg.kind === 'offer') {
            await pc.setRemoteDescription(msg.data as RTCSessionDescriptionInit);
            if (!active()) return;
            await pc.setLocalDescription();
            if (!active()) return;
            const d = pc.localDescription;
            if (d) {
              const result = await window.api.rooms.screen.signal(roomId, memberId, 'answer', { type: d.type, sdp: d.sdp });
              if (!result?.ok) throw new Error(tRef.current('rooms.screen.connectFailed'));
            }
            while (active() && earlyIce.length) await pc.addIceCandidate(earlyIce.shift()!);
          } else if (msg.kind === 'ice') {
            if (pc.remoteDescription) await pc.addIceCandidate(msg.data as RTCIceCandidateInit);
            else {
              if (earlyIce.length >= 256) throw new Error(tRef.current('rooms.screen.connectFailed'));
              earlyIce.push(msg.data as RTCIceCandidateInit);
            }
          }
      }).catch(error => { if (active()) finish(error); });
    });
    pc.onicecandidate = ({ candidate }) => {
      if (active() && candidate) void window.api.rooms.screen.signal(roomId, memberId, 'ice', candidate.toJSON())
        .then(result => { if (!result?.ok) throw new Error(tRef.current('rooms.screen.connectFailed')); })
        .catch(error => { if (active()) finish(error); });
    };
    window.api.rooms.screen.watchStart(roomId, memberId)
      .then(result => { if (!result?.ok) throw new Error(tRef.current('rooms.screen.connectFailed')); })
      .catch(error => { if (active()) finish(error); });
    return () => {
      dead = true;
      earlyIce.length = 0;
      off();
      try { pc.close(); } catch { /* ignore */ }
      // A new participant must not inherit the previous person's last frame.
      if (videoRef.current) videoRef.current.srcObject = null;
      window.api.rooms.screen.watchStop(roomId, memberId).catch(() => { /* ignore */ });
    };
  }, [roomId, memberId]);

  // Escape closes the overlay (unless we're in fullscreen — there the browser's
  // Escape exits fullscreen first, matching every other dialog's muscle memory).
  // Both halves come from the STAGE's own window: binding the key on the main
  // window while the stage is fullscreen in a child leaves a fullscreen window
  // with no content (main sees `fullscreenElement === null`, closes the overlay).
  useEffect(() => {
    const el = stageRef.current;
    const doc = el?.ownerDocument ?? host.document;
    const win = doc.defaultView ?? host.window;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !doc.fullscreenElement && Date.now() - fullscreenExitAt.current > 250 && !e.defaultPrevented && !menu && !qualityOpen) {
        e.stopPropagation(); closeRef.current();
      }
    };
    setFullscreenOn(!!doc.fullscreenElement);
    const onFullscreen = () => {
      if (!doc.fullscreenElement) fullscreenExitAt.current = Date.now();
      setFullscreenOn(!!doc.fullscreenElement); setMenu(null);
    };
    win.addEventListener('keydown', onKey);
    doc.addEventListener('fullscreenchange', onFullscreen);
    return () => { win.removeEventListener('keydown', onKey); doc.removeEventListener('fullscreenchange', onFullscreen); };
  }, [host, detached, menu, qualityOpen]);

  const fullscreen = () => {
    const el = cardRef.current;
    if (!el) return;
    // Element-derived, never context-derived: requestFullscreen() sets
    // fullscreenElement on THIS element's document, so reading it anywhere else
    // makes the second click request fullscreen again instead of exiting.
    const doc = el.ownerDocument;
    if (doc.fullscreenElement) void doc.exitFullscreen();
    else void el.requestFullscreen().catch(() => { /* ignore */ });
  };

  const togglePlaybackMute = () => {
    if (volume === 0) { setVolume(100); setMuted(false); }
    else setMuted(!muted);
  };
  const items: ContextMenuItem[] = [
    { label: t(detached ? 'player.attach' : 'player.detach'), icon: detached ? 'minimize' : 'external-link', onClick: detach, disabled: fullscreenOn },
    { label: t(fullscreenOn ? 'rooms.screen.exitFullscreen' : 'rooms.screen.fullscreen'), icon: 'maximize', onClick: fullscreen },
    ...(!detached && onToggleTheater ? [{ label: t(theater ? 'rooms.theater.off' : 'rooms.theater.on'), icon: 'maximize' as const, onClick: onToggleTheater }] : []),
    { label: t(fit === 'contain' ? 'rooms.screen.fill' : 'rooms.screen.fit'), icon: 'maximize', onClick: () => setFit(fit === 'contain' ? 'cover' : 'contain') },
    ...(!isSelf ? [{ label: t(muted || volume === 0 ? 'rooms.screen.unmutePlayback' : 'rooms.screen.mutePlayback'), icon: 'volume-2' as const,
      onClick: togglePlaybackMute }] : []),
    ...(isSelf ? [
      { label: t('rooms.screen.quality'), icon: 'settings' as const, onClick: () => setQualityOpen(true) },
      { label: t('rooms.screen.stop'), icon: 'screen-share' as const, danger: true, onClick: () => {
        void window.api.rooms.screen.shareStop(roomId).catch(() => toastRef.current.error(t('rooms.screen.stopFailed')));
      } },
    ] : []),
    { label: t('rooms.screen.closeView'), icon: 'x', onClick: onClose },
  ];
  const showMenu = (event: React.MouseEvent) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); };
  const node = (
    <div className={`ssv-card ssv-inline${detached ? ' ssv-detached' : ''}`} ref={cardRef} onContextMenu={showMenu}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
          event.preventDefault(); const box = stageRef.current?.getBoundingClientRect();
          setMenu({ x: (box?.left ?? 0) + 24, y: (box?.top ?? 0) + 24 });
        }
      }}>
      <div className="ssv-head" onDoubleClick={detached ? () => toggleMaximizeDockWindow(SCREEN_VIEW_FRAME) : undefined}>
        <span className="ssv-title">
          <Icon name="screen-share" size={14} /> {t('rooms.screen.watching')} · {title}
        </span>
        <span className="ssv-actions">
          <button className="ssv-btn" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { x: box.right, y: box.bottom }); }}
            title={t('rooms.screen.menu')} aria-label={t('rooms.screen.menu')} aria-haspopup="menu" aria-expanded={!!menu}>
            <Icon name="more-horizontal" size={16} />
          </button>
          <button className="ssv-btn" onClick={detach} disabled={fullscreenOn} title={t(detached ? 'player.attach' : 'player.detach')} aria-label={t(detached ? 'player.attach' : 'player.detach')}>
            <Icon name={detached ? 'minimize' : 'external-link'} size={14} />
          </button>
          <button className="ssv-btn" onClick={fullscreen} title={t(fullscreenOn ? 'rooms.screen.exitFullscreen' : 'rooms.screen.fullscreen')} aria-label={t(fullscreenOn ? 'rooms.screen.exitFullscreen' : 'rooms.screen.fullscreen')}>
            <Icon name={fullscreenOn ? 'minimize' : 'maximize'} size={14} />
          </button>
          {detached ? <WindowControls maximized={maximized} labels={{ minimize: t('window.minimize'), maximize: t('window.maximize'), restore: t('window.restore'), close: t('player.attach') }}
            onMinimize={() => minimizeDockWindow(SCREEN_VIEW_FRAME)} onToggleMaximize={() => toggleMaximizeDockWindow(SCREEN_VIEW_FRAME)} onClose={attach} /> : <button className="ssv-btn" onClick={onClose} title={t('rooms.screen.closeView')} aria-label={t('rooms.screen.closeView')}>
            <Icon name="x" size={14} />
          </button>}
        </span>
      </div>
      <div className="ssv-stage" ref={stageRef} onDoubleClick={fullscreen} tabIndex={0} aria-label={t('rooms.screen.menu')}>
        <video ref={videoRef} className="ssv-video" style={{ objectFit: fit }} autoPlay playsInline muted={isSelf || muted} />
      </div>
      {!isSelf && <div className="ssv-sound">
        <button className="ssv-btn" onClick={togglePlaybackMute} aria-label={t(muted || volume === 0 ? 'rooms.screen.unmutePlayback' : 'rooms.screen.mutePlayback')} aria-pressed={muted || volume === 0}><Icon name={muted || volume === 0 ? 'volume-x' : 'volume-2'} size={14} /></button>
        <input type="range" min={0} max={100} value={volume} onChange={event => setVolume(Number(event.target.value))} aria-label={t('rooms.screen.playbackVolume')} />
        <span>{volume}%</span>
        {audioError && <span role="status">{t('rooms.screen.audioSettingsFailed')}</span>}
      </div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} autoFocus portalTarget={fullscreenOn ? cardRef.current : undefined} />}
      {qualityOpen && <ScreenQualityDialog roomId={roomId} initial={settings ?? loadScreenSharePrefs()} bitrateLimitKbps={bitrateLimitKbps}
        onClose={() => setQualityOpen(false)} />}
    </div>
  );
  return <>
    <div className="ssv-slot" ref={homeSlot} hidden={detached} />
    {detached && <div className="ssv-away">
      <Icon name="external-link" size={28} />
      <p>{t('rooms.screen.detachedHint')}</p>
      <div><Button variant="secondary" onClick={() => openPopout()}>{t('rooms.screen.focusWindow')}</Button>
        <Button variant="ghost" onClick={attach}>{t('player.attach')}</Button></div>
    </div>}
    {portal(<div className="ssv-slot ssv-popout-slot" ref={windowSlot} />)}
    {surface ? createPortal(<HostWindowRealm window={popout}>{node}</HostWindowRealm>, surface) : node}
  </>;
};

function ScreenQualityDialog({ roomId, initial, bitrateLimitKbps = DEFAULT_ROOM_RESOURCES.screenBitrateKbps, onClose }: {
  roomId: string; initial: ScreenShareSettings; bitrateLimitKbps?: number; onClose: () => void;
}) {
  const { t, language } = useTranslation(), target = usePortalTarget();
  const { settings, manual, setSettings, choosePreset } = useScreenShareSelection(() => initial);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const pending = useRef(false);
  const mbps = (value: number) => (value / 1000).toLocaleString(language, { maximumFractionDigits: 2 });
  const apply = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await window.api.rooms.screen.configure(roomId, settings);
      if (!result?.ok) throw new Error(t('rooms.screen.settingsFailed'));
      saveScreenSharePrefs(settings, manual); onClose();
    } catch (reason) { setError(reason); }
    finally { pending.current = false; setBusy(false); }
  };
  return createPortal(<Modal title={t('rooms.screen.quality')} icon="settings" onClose={onClose} busy={busy}
    footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={() => void apply()}>{t('common.save')}</Button></>}>
    <ScreenQualityPresets settings={settings} onChoose={choosePreset} disabled={busy} />
    <div className="ssp-quality">
      <div className="ssp-setting"><span>{t('rooms.screen.resolution')}</span><Select disabled={busy} ariaLabel={t('rooms.screen.resolution')} value={String(settings.height)} options={SCREEN_SHARE_HEIGHTS.map(height => ({ value: String(height), label: `${height}p` }))} onChange={value => setSettings(s => ({ ...s, height: Number(value) as ScreenShareSettings['height'] }))} /></div>
      <div className="ssp-setting"><span>{t('rooms.screen.frameRate')}</span><Select disabled={busy} ariaLabel={t('rooms.screen.frameRate')} value={String(settings.fps)} options={SCREEN_SHARE_FPS.map(fps => ({ value: String(fps), label: `${fps} FPS` }))} onChange={value => setSettings(s => ({ ...s, fps: Number(value) as ScreenShareSettings['fps'] }))} /></div>
      <div className="ssp-setting"><span>{t('rooms.screen.bitrate')}</span><Select disabled={busy} ariaLabel={t('rooms.screen.bitrate')} value={String(settings.bitrateKbps)} options={[{ value: '0', label: t('rooms.screen.bitrateAuto') }, ...[500, 1000, 2500, 5000, 8000, 12000, 20000].map(value => ({ value: String(value), label: `${mbps(value)} ${t('rooms.screen.mbps')}` }))]} onChange={value => setSettings(s => ({ ...s, bitrateKbps: Number(value) }))} /></div>
    </div>
    <p className="ssp-hint">{t('rooms.screen.bitrateHint').replace('{effective}', mbps(effectiveScreenBitrate(settings, bitrateLimitKbps))).replace('{limit}', mbps(bitrateLimitKbps))}</p>
    <p className="ssp-hint">{t('rooms.screen.liveSettingsHint')}</p>
    {!!error && <div role="alert"><p>{t('rooms.screen.settingsFailed')}</p><ErrorMessage error={error} details /></div>}
  </Modal>, target.ownerDocument.fullscreenElement ?? target);
}
