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
import './PlayerControls.css';

const fmtTime = (s: number): string => {
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
  /** Extra buttons rendered between volume and fullscreen (subtitles, …). */
  children?: React.ReactNode;
}

export const PlayerControls: React.FC<PlayerControlsProps> = ({
  media,
  fullscreenTarget,
  seekable = true,
  children,
}) => {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(NaN);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fs, setFs] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // Mirror the element's state — the element is the source of truth, so remote
  // watch-together commands and codec fallbacks reflect here automatically.
  useEffect(() => {
    if (!media) return;
    const sync = () => {
      setPlaying(!media.paused);
      setTime(media.currentTime);
      setDuration(media.duration);
      try {
        setBuffered(media.buffered.length ? media.buffered.end(media.buffered.length - 1) : 0);
      } catch { /* transient buffered ranges */ }
      setVolume(media.volume);
      setMuted(media.muted);
    };
    sync();
    const evs = ['play', 'pause', 'timeupdate', 'durationchange', 'progress', 'volumechange', 'loadedmetadata', 'ended'];
    for (const ev of evs) media.addEventListener(ev, sync);
    return () => { for (const ev of evs) media.removeEventListener(ev, sync); };
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

  // Keyboard: Space / ←→ / M / F — never while typing (chat, inputs).
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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [media, toggle, toggleMute, toggleFullscreen, canSeek, duration, fullscreenTarget]);

  const pct = canSeek ? Math.min(100, (time / duration) * 100) : 100;
  const bufPct = canSeek ? Math.min(100, (buffered / duration) * 100) : 0;

  return (
    <div className="pc">
      <button className="pc-btn pc-play" onClick={toggle} title={playing ? t('player.pause') : t('player.play')}>
        <Icon name={playing ? 'pause' : 'play'} size={15} />
      </button>
      <span className="pc-time">{fmtTime(time)}</span>
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
        <span className="pc-buffer" style={{ width: `${bufPct}%` }} />
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
      {children}
      {fullscreenTarget && (
        <button className="pc-btn" onClick={toggleFullscreen} title={fs ? t('player.exitFullscreen') : t('player.fullscreen')}>
          <Icon name={fs ? 'minimize' : 'maximize'} size={15} />
        </button>
      )}
    </div>
  );
};

export default PlayerControls;
