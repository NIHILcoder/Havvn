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
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import { useHostWindow, usePortalTarget } from '../utils/hostWindow';
import type { ScreenSourceInfo } from '../../shared/types';
import './ScreenShare.css';

export const ScreenSourcePicker: React.FC<{
  onClose: () => void;
  onPick: (sourceId: string, withAudio: boolean) => void;
}> = ({ onClose, onPick }) => {
  const { t } = useTranslation();
  // No element of our own to read an ownerDocument from — the portal container
  // is needed before anything mounts — so this is the context case. With no
  // provider above (the whole main tree) it IS `document.body`, unchanged.
  const portalTarget = usePortalTarget();
  const [sources, setSources] = useState<ScreenSourceInfo[] | null>(null);
  // Opt-in system audio (M20): off by default — sharing system audio shares
  // everything playing, and the call echo canceller is best-effort. Windows only.
  const [withAudio, setWithAudio] = useState(false);

  const refresh = () => {
    window.api.rooms.screen.sources()
      .then(setSources)
      .catch((e) => { toast.error(String(e instanceof Error ? e.message : e)); setSources([]); });
  };
  useEffect(refresh, []);

  const group = (display: boolean) => (sources || []).filter((s) => s.display === display);
  const tile = (s: ScreenSourceInfo) => (
    <button key={s.id} className="ssp-tile" onClick={() => onPick(s.id, withAudio)} title={s.name}>
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
          <label className="ssp-audio" title={t('rooms.screen.shareAudioHint')}>
            <input type="checkbox" checked={withAudio} onChange={(e) => setWithAudio(e.target.checked)} />
            <Icon name="volume-2" size={13} /> {t('rooms.screen.shareAudio')}
          </label>
          <button className="ssp-refresh" onClick={refresh}>
            <Icon name="refresh-cw" size={13} /> {t('rooms.screen.refresh')}
          </button>
        </div>
      }
    >
      {sources === null ? (
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
}> = ({ roomId, memberId, title, onClose }) => {
  const { t } = useTranslation();
  const host = useHostWindow();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let dead = false;
    const pc = new RTCPeerConnection({ iceServers: [] }); // loopback — host candidates only
    pc.ontrack = ({ streams }) => {
      const v = videoRef.current;
      if (v && streams[0]) {
        v.srcObject = streams[0];
        v.play().catch(() => { /* video-only autoplay is permitted; ignore */ });
      }
    };
    // If the engine (forwarder) dies without sending 'end' — e.g. its renderer
    // crashed — the loopback drops; close the frozen overlay instead of hanging.
    pc.onconnectionstatechange = () => {
      if (!dead && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) closeRef.current();
    };
    // Subscribe BEFORE asking the engine to start, so the offer can't beat us.
    const off = window.api.onRoomScreenSignal((msg) => {
      if (dead || msg.roomId !== roomId || msg.memberId !== memberId) return;
      if (msg.kind === 'end') { closeRef.current(); return; }
      void (async () => {
        try {
          if (msg.kind === 'offer') {
            await pc.setRemoteDescription(msg.data as RTCSessionDescriptionInit);
            await pc.setLocalDescription();
            const d = pc.localDescription;
            if (d) await window.api.rooms.screen.signal(roomId, memberId, 'answer', { type: d.type, sdp: d.sdp });
          } else if (msg.kind === 'ice') {
            await pc.addIceCandidate(msg.data as RTCIceCandidateInit);
          }
        } catch { /* a torn-down pc mid-signal — the 'end' path cleans up */ }
      })();
    });
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) void window.api.rooms.screen.signal(roomId, memberId, 'ice', candidate.toJSON()).catch(() => { /* ignore */ });
    };
    window.api.rooms.screen.watchStart(roomId, memberId).catch((e) => {
      toast.error(String(e instanceof Error ? e.message : e));
      closeRef.current();
    });
    return () => {
      dead = true;
      off();
      try { pc.close(); } catch { /* ignore */ }
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
      if (e.key === 'Escape' && !doc.fullscreenElement) { e.stopPropagation(); closeRef.current(); }
    };
    win.addEventListener('keydown', onKey);
    return () => win.removeEventListener('keydown', onKey);
  }, [host]);

  const fullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    // Element-derived, never context-derived: requestFullscreen() sets
    // fullscreenElement on THIS element's document, so reading it anywhere else
    // makes the second click request fullscreen again instead of exiting.
    const doc = el.ownerDocument;
    if (doc.fullscreenElement) void doc.exitFullscreen();
    else void el.requestFullscreen().catch(() => { /* ignore */ });
  };

  return (
    <div className="ssv-card ssv-inline">
      <div className="ssv-head">
        <span className="ssv-title">
          <Icon name="screen-share" size={14} /> {t('rooms.screen.watching')} · {title}
        </span>
        <span className="ssv-actions">
          <button className="ssv-btn" onClick={fullscreen} title={t('rooms.screen.fullscreen')}>
            <Icon name="maximize" size={14} />
          </button>
          <button className="ssv-btn" onClick={onClose} title={t('common.close')}>
            <Icon name="x" size={14} />
          </button>
        </span>
      </div>
      <div className="ssv-stage" ref={stageRef} onDoubleClick={fullscreen}>
        <video ref={videoRef} className="ssv-video" autoPlay playsInline />
      </div>
    </div>
  );
};
