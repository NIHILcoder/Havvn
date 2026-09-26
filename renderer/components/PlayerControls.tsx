/**
 * PlayerControls — the Ember control bar shared by the in-app players.
 *
 * Sits UNDER the media element (the concept's `.scrub` row): flat panel, mono
 * timecodes, an ember progress track with a playhead dot and a buffered ghost,
 * volume, fullscreen. It only drives a plain <video>/<audio> element — playback
 * events keep firing from the element itself, so watch-together sync and the
 * codec-fallback logic see no difference from the native controls.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Icon } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import { readBufferedRanges, type BufferedRange } from '../../shared/playback-buffer';
import './PlayerControls.css';

// Exported for reuse (StreamPlayerModal's "resuming from …" toast).
export const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) return '–:––';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`;
};

interface PlayerControlsProps {
  /** The media element to drive (null while it hasn't mounted yet). */
  media: HTMLVideoElement | HTMLAudioElement | null;
  /** Wrapper to fullscreen; omit to hide the button (audio players). */
  fullscreenTarget?: React.RefObject<HTMLElement | null>;
  /** Live transcodes aren't Range-seekable — the scrubber turns display-only. */
  seekable?: boolean;
  /** Original timeline offset when a transcode restarts partway through a file. */
  timeOffset?: number;
  /** Extra buttons rendered between volume and fullscreen (subtitles, …). */
  children?: React.ReactNode;
}

// Playback-rate presets (session-only; the element remounts reset to 1×, and a
// small effect below re-applies the chosen rate so it survives episode
// auto-advance and audio-track switches).
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

export const PlayerControls: React.FC<PlayerControlsProps> = ({
  media,
  fullscreenTarget,
  seekable = true,
  timeOffset = 0,
  children,
}) => {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(NaN);
  const [buffered, setBuffered] = useState<BufferedRange[]>([]);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fs, setFs] = useState(false);
  const [rate, setRate] = useState(1);
  const [rateOpen, setRateOpen] = useState(false);
  const [pip, setPip] = useState(false);
  // True once the element decoded an actual video stream. Gates PiP: rooms
  // plays MUSIC through a CSS-hidden <video>, where a PiP window would be a
  // black rectangle — instanceof alone can't tell the difference.
  const [hasVideo, setHasVideo] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // The rate the USER chose in this player instance — re-applied on element
  // remount (rooms' remote rate-sync still reflects into `rate` via ratechange).
  const rateRef = useRef(1);

  // Mirror the element's state — the element is the source of truth, so remote
  // watch-together commands and codec fallbacks reflect here automatically.
  useEffect(() => {
    if (!media) { setBuffered([]); return; }
    const sync = () => {
      setPlaying(!media.paused);
      setTime(media.currentTime);
      setDuration(media.duration);
      setBuffered(readBufferedRanges(media.buffered));
      setVolume(media.volume);
      setMuted(media.muted);
      setRate(media.playbackRate);
      setHasVideo(media instanceof HTMLVideoElement && media.videoWidth > 0);
    };
    sync();
    const evs = ['play', 'pause', 'timeupdate', 'durationchange', 'progress', 'volumechange', 'loadedmetadata', 'ended', 'ratechange', 'seeking', 'seeked', 'emptied'];
    for (const ev of evs) media.addEventListener(ev, sync);
    return () => { for (const ev of evs) media.removeEventListener(ev, sync); };
  }, [media]);

  // A fresh element starts at 1× (remount per stream URL) — re-apply the chosen
  // rate so speed survives auto-advance / track switches within the session.
  useEffect(() => {
    if (!media) return;
    setRateOpen(false);
    if (rateRef.current !== 1 && media.playbackRate !== rateRef.current) {
      media.playbackRate = rateRef.current;
    }
  }, [media]);

  // PiP state mirrors the element (video only; <audio> has no PiP API).
  useEffect(() => {
    if (!(media instanceof HTMLVideoElement)) { setPip(false); return; }
    const on = () => setPip(true);
    const off = () => setPip(false);
    setPip(document.pictureInPictureElement === media);
    media.addEventListener('enterpictureinpicture', on);
    media.addEventListener('leavepictureinpicture', off);
    return () => {
      media.removeEventListener('enterpictureinpicture', on);
      media.removeEventListener('leavepictureinpicture', off);
    };
  }, [media]);

  useEffect(() => {
    const onFs = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggle = useCallback(() => {
    if (!media) return;
    if (media.paused) void media.play().catch(() => {});
    else media.pause();
  }, [media]);

  // HLS/direct expose a finite duration; a live ffmpeg pipe doesn't.
  const canSeek = seekable && Number.isFinite(duration) && duration > 0;

  const seekTo = useCallback((clientX: number) => {
    const bar = barRef.current;
    if (!bar || !media || !canSeek) return;
    const r = bar.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    media.currentTime = frac * duration;
    setTime(media.currentTime);
  }, [media, canSeek, duration]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!canSeek) return;
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    seekTo(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => { if (dragging.current) seekTo(e.clientX); };
  const onPointerUp = () => { dragging.current = false; };

  const toggleMute = useCallback(() => { if (media) media.muted = !media.muted; }, [media]);
  const setVol = (v: number) => {
    if (!media) return;
    media.volume = v;
    if (v > 0) media.muted = false;
  };

  const toggleFullscreen = useCallback(() => {
    const el = fullscreenTarget?.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen().catch(() => {});
  }, [fullscreenTarget]);

  const applyRate = useCallback((r: number) => {
    rateRef.current = r;
    if (media) media.playbackRate = r; // `rate` state follows via 'ratechange'
    setRateOpen(false);
  }, [media]);

  // PiP: HTMLVideoElement with a real video stream only (hasVideo hides it for
  // <audio> AND for audio played through a hidden <video>, e.g. rooms music);
  // works on the live fmp4 transcode too.
  const canPip = media instanceof HTMLVideoElement && hasVideo && document.pictureInPictureEnabled && !media.disablePictureInPicture;
  const togglePip = useCallback(() => {
    if (!(media instanceof HTMLVideoElement)) return;
    if (document.pictureInPictureElement === media) void document.exitPictureInPicture().catch(() => {});
    else void media.requestPictureInPicture().catch(() => {});
  }, [media]);

  // Keyboard: Space / ←→ / M / F / P — never while typing (chat, inputs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement || tgt.isContentEditable) return;
      if (!media) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.code === 'ArrowLeft' && canSeek) { e.preventDefault(); media.currentTime = Math.max(0, media.currentTime - 5); }
      else if (e.code === 'ArrowRight' && canSeek) { e.preventDefault(); media.currentTime = Math.min(duration, media.currentTime + 5); }
      else if (e.code === 'KeyM') { toggleMute(); }
      else if (e.code === 'KeyF' && fullscreenTarget) { toggleFullscreen(); }
      // Plain P only: Ctrl+P toggles the downloads view mode and Ctrl+Shift+P
      // is the global pause-all hotkey — both keep listening under the player.
      else if (e.code === 'KeyP' && canPip && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { togglePip(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [media, toggle, toggleMute, toggleFullscreen, canSeek, duration, fullscreenTarget, canPip, togglePip]);

  const pct = canSeek ? Math.min(100, (time / duration) * 100) : 100;

  return (
    <div className="pc">
      <button className="pc-btn pc-play" onClick={toggle} title={playing ? t('player.pause') : t('player.play')}>
        <Icon name={playing ? 'pause' : 'play'} size={15} />
      </button>
      <span className="pc-time">{fmtTime(time + timeOffset)}</span>
      <div
        ref={barRef}
        className={`pc-bar ${canSeek ? '' : 'pc-bar-static'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role={canSeek ? 'slider' : undefined}
        aria-label={canSeek ? t('player.seek') : undefined}
        aria-valuemin={0}
        aria-valuemax={Number.isFinite(duration) ? Math.floor(duration) : 0}
        aria-valuenow={Math.floor(time)}
      >
        {canSeek && buffered.map((range, index) => {
          const start = Math.min(100, Math.max(0, range.start / duration * 100));
          const end = Math.min(100, range.end / duration * 100);
          return <span key={index} className="pc-buffer" style={{ left: `${start}%`, width: `${Math.max(0, end - start)}%` }} />;
        })}
        <span className="pc-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="pc-time pc-duration">{canSeek ? fmtTime(duration) : '· · ·'}</span>
      <button className="pc-btn" onClick={toggleMute} title={muted || volume === 0 ? t('player.unmute') : t('player.mute')}>
        <Icon name={muted || volume === 0 ? 'volume-x' : 'volume-2'} size={15} />
      </button>
      <input
        className="pc-vol"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        onChange={(e) => setVol(Number(e.target.value))}
        aria-label={t('player.volume')}
      />
      <div className="pc-rate-wrap">
        <button
          className={`pc-btn pc-rate ${rate !== 1 ? 'active' : ''}`}
          onClick={() => setRateOpen((o) => !o)}
          title={t('player.speed')}
        >
          {rate}×
        </button>
        {rateOpen && (
          <div className="pc-menu">
            {RATES.map((r) => (
              <button key={r} className={`pc-menu-item ${rate === r ? 'active' : ''}`} onClick={() => applyRate(r)}>
                {r}×
              </button>
            ))}
          </div>
        )}
      </div>
      {children}
      {canPip && (
        <button className="pc-btn" onClick={togglePip} title={pip ? t('player.pipExit') : t('player.pip')}>
          <Icon name="pip" size={15} />
        </button>
      )}
      {fullscreenTarget && (
        <button className="pc-btn" onClick={toggleFullscreen} title={fs ? t('player.exitFullscreen') : t('player.fullscreen')}>
          <Icon name={fs ? 'minimize' : 'maximize'} size={15} />
        </button>
      )}
    </div>
  );
};

export default PlayerControls;
