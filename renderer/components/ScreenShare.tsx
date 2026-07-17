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
 * Both components portal to <body>: their openers live inside the room's
 * container-query subtree, whose containment would trap a fixed backdrop.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import type { ScreenSourceInfo } from '../../shared/types';
import './ScreenShare.css';

export const ScreenSourcePicker: React.FC<{
  onClose: () => void;
  onPick: (sourceId: string) => void;
}> = ({ onClose, onPick }) => {
  const { t } = useTranslation();
  const [sources, setSources] = useState<ScreenSourceInfo[] | null>(null);

  const refresh = () => {
    window.api.rooms.screen.sources()
      .then(setSources)
      .catch((e) => { toast.error(String(e instanceof Error ? e.message : e)); setSources([]); });
  };
  useEffect(refresh, []);

  const group = (display: boolean) => (sources || []).filter((s) => s.display === display);
  const tile = (s: ScreenSourceInfo) => (
    <button key={s.id} className="ssp-tile" onClick={() => onPick(s.id)} title={s.name}>
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
        <button className="ssp-refresh" onClick={refresh}>
          <Icon name="refresh-cw" size={13} /> {t('rooms.screen.refresh')}
        </button>
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
    document.body,
  );
};

export const ScreenViewOverlay: React.FC<{
  roomId: string;
  memberId: string;
  title: string;
  onClose: () => void;
}> = ({ roomId, memberId, title, onClose }) => {
  const { t } = useTranslation();
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) { e.stopPropagation(); closeRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const fullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => { /* ignore */ });
  };

  return createPortal(
    <div className="ssv-backdrop" onClick={onClose}>
      <div className="ssv-card" onClick={(e) => e.stopPropagation()}>
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
    </div>,
    document.body,
  );
};
