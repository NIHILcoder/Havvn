/**
 * StreamPlayerModal
 *
 * In-app player that streams a media file straight from a torrent — playback
 * starts while the torrent is still downloading. Formats Chromium can't decode
 * (avi, mkv, HEVC, …) are transcoded on the fly via the bundled ffmpeg; direct
 * playback that fails on an unsupported codec falls back to transcoding too.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { Icon } from './Icon';
import { QRCode } from './QRCode';
import { PlayerControls, fmtTime } from './PlayerControls';
import { useTranslation } from '../utils/i18nContext';
import { classifyMediaKind, MediaKind } from '../../shared/media';
import './StreamPlayerModal.css';

interface StreamFile {
  index: number;
  name: string;
  length: number;
  kind: MediaKind;
}

interface StreamPlayerModalProps {
  downloadId: string;
  downloadName: string;
  onClose: () => void;
}

const formatBytes = (bytes: number): string => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

// --- Playback-position memory -----------------------------------------------
// A single localStorage JSON map remembers where the user stopped watching, so
// reopening a film resumes instead of starting over. Keyed by
// `${infoHash||downloadId}:${fileIndex}` — the infoHash survives remove+re-add.
// Purely cosmetic: every touch of the store is wrapped so a corrupt map or a
// full quota can never break playback.

const PLAY_POSITIONS_KEY = 'playPositions';
const PLAY_POSITIONS_MAX = 200;
/** Don't remember short clips, near-starts, or near-ends. */
const PLAY_POS_MIN_DURATION = 120;
const PLAY_POS_MIN_TIME = 30;
const PLAY_POS_FINISHED_FRAC = 0.95;
const PLAY_POS_RESTORE_MAX_FRAC = 0.92;
const PLAY_POS_SAVE_INTERVAL_MS = 5000;

interface PlayPosition { t: number; d: number; at: number }
type PlayPositionMap = Record<string, PlayPosition>;

const readPlayPositions = (): PlayPositionMap => {
  try {
    const raw = localStorage.getItem(PLAY_POSITIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as PlayPositionMap) : {};
  } catch { return {}; }
};

const writePlayPositions = (map: PlayPositionMap): void => {
  try {
    const keys = Object.keys(map);
    if (keys.length > PLAY_POSITIONS_MAX) {
      keys.sort((a, b) => (map[a]?.at ?? 0) - (map[b]?.at ?? 0));
      for (const k of keys.slice(0, keys.length - PLAY_POSITIONS_MAX)) delete map[k];
    }
    localStorage.setItem(PLAY_POSITIONS_KEY, JSON.stringify(map));
  } catch { /* cosmetic — quota/serialization failures are ignored */ }
};

const savePlayPosition = (key: string, t: number, d: number): void => {
  try {
    const map = readPlayPositions();
    map[key] = { t, d, at: Date.now() };
    writePlayPositions(map);
  } catch { /* cosmetic */ }
};

const clearPlayPosition = (key: string): void => {
  try {
    const map = readPlayPositions();
    if (key in map) {
      delete map[key];
      writePlayPositions(map);
    }
  } catch { /* cosmetic */ }
};

const getPlayPosition = (key: string): PlayPosition | null => {
  try {
    const entry = readPlayPositions()[key];
    return entry && typeof entry.t === 'number' && typeof entry.d === 'number' ? entry : null;
  } catch { return null; }
};

export const StreamPlayerModal: React.FC<StreamPlayerModalProps> = ({ downloadId, downloadName, onClose }) => {
  const { t } = useTranslation();
  const [files, setFiles] = useState<StreamFile[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [forceTranscode, setForceTranscode] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [kind, setKind] = useState<MediaKind>('video');
  const [transcoded, setTranscoded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // "Watch on another device" (LAN cast)
  const [castInfo, setCastInfo] = useState<{ url: string; lan: string; port: number } | null>(null);
  const [castOpen, setCastOpen] = useState(false);
  const [castBusy, setCastBusy] = useState(false);
  const [castError, setCastError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [castMode, setCastMode] = useState<'lan' | 'tv' | 'remote'>('lan');
  const [remoteInfo, setRemoteInfo] = useState<{ url: string; sessionId: string } | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  // Cast to TV (Chromecast)
  const [tvDevices, setTvDevices] = useState<Array<{ name: string; host: string }>>([]);
  const [tvError, setTvError] = useState<string | null>(null);
  const [tvPlaying, setTvPlaying] = useState<{ host: string; name: string } | null>(null);
  const [tvPaused, setTvPaused] = useState(false);
  // Subtitles
  const [subTracks, setSubTracks] = useState<Array<{ key: string; label: string; lang?: string; source: 'embedded' | 'external' }>>([]);
  const [subOpen, setSubOpen] = useState(false);
  const [subActiveKey, setSubActiveKey] = useState<string | null>(null);
  const [subUrl, setSubUrl] = useState<string | null>(null);
  // Custom Ember controls: the media element remounts per stream URL, so it is
  // captured via a callback ref; the stage wrapper is the fullscreen target.
  const [mediaEl, setMediaEl] = useState<HTMLVideoElement | HTMLAudioElement | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Playback-position memory. The store key prefers the download's infoHash
  // (survives remove+re-add); `ready` gates restore so an early loadedmetadata
  // can't look the position up under the wrong (downloadId) key.
  const [posKeyBase, setPosKeyBase] = useState<{ base: string; ready: boolean }>({ base: downloadId, ready: false });
  // File index the currently mounted media element actually plays (activeIndex
  // may already point at the next file while the old element is flushing).
  const streamIndexRef = useRef<number | null>(null);
  const posRestoredRef = useRef(false);   // restore attempted for this file-open
  const posUserSeekedRef = useRef(false); // manual seek began — never restore after
  const posLastSaveRef = useRef(0);       // throttle timestamp for timeupdate saves

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let base = downloadId;
      try {
        const dl = (await window.api.getDownloads()).find((d) => d.id === downloadId);
        if (dl?.infoHash) base = dl.infoHash;
      } catch { /* cosmetic — fall back to downloadId */ }
      if (!cancelled) setPosKeyBase({ base, ready: true });
    })();
    return () => { cancelled = true; };
  }, [downloadId]);

  // Load the streamable files in this torrent once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await window.api.getTorrentFiles(downloadId);
        const streamable: StreamFile[] = all
          .map((f, index) => ({ index, name: f.name, length: f.length, kind: classifyMediaKind(f.name) }))
          .filter((f) => f.kind !== 'other')
          .sort((a, b) => b.length - a.length);
        if (cancelled) return;
        setFiles(streamable);
        if (streamable.length === 0) {
          setError(t('player.noMedia'));
          setLoading(false);
        } else {
          setActiveIndex(streamable[0].index);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || String(err));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [downloadId, t]);

  // Resolve a stream URL whenever the active file (or transcode mode) changes.
  useEffect(() => {
    if (activeIndex === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStreamUrl(null);
    (async () => {
      try {
        const info = await window.api.getStreamUrl(downloadId, activeIndex, { transcode: forceTranscode });
        if (cancelled) return;
        streamIndexRef.current = activeIndex;
        setStreamUrl(info.url);
        setKind(info.kind === 'other' ? 'video' : info.kind);
        setTranscoded(info.transcoded);
        setLoading(false);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || String(err));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [downloadId, activeIndex, forceTranscode]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // When the player closes, tell the engine to undo instant-play prioritization
  // (forced-sequential strategy + priority-10 head selection) and re-deselect the
  // streamed file if it was skip-marked — none of which reverts on its own.
  const activeIndexRef = React.useRef<number | null>(null);
  useEffect(() => { activeIndexRef.current = activeIndex; }, [activeIndex]);
  useEffect(() => {
    return () => {
      const idx = activeIndexRef.current;
      void window.api.stopStream(downloadId, idx === null ? undefined : idx);
    };
  }, [downloadId]);

  // Reset the position-memory guards whenever a new media element mounts (the
  // element remounts per stream URL, so this is exactly "per file-open").
  useEffect(() => {
    posRestoredRef.current = false;
    posUserSeekedRef.current = false;
    posLastSaveRef.current = 0;
  }, [mediaEl]);

  // Playback-position memory: throttled saves on timeupdate, clear on finish,
  // one-shot restore on open, and a final flush in the effect cleanup — which
  // runs on file switch (element remount), modal close and unmount alike.
  useEffect(() => {
    const fileIdx = streamIndexRef.current;
    if (!mediaEl || fileIdx === null || !posKeyBase.ready) return;
    const key = `${posKeyBase.base}:${fileIdx}`;

    // Save the position, or clear it once the film is (nearly) finished.
    const saveOrClear = (final: boolean) => {
      try {
        const d = mediaEl.duration;
        if (!Number.isFinite(d) || d <= PLAY_POS_MIN_DURATION) return;
        const cur = mediaEl.currentTime;
        if (mediaEl.ended || cur / d >= PLAY_POS_FINISHED_FRAC) { clearPlayPosition(key); return; }
        if (cur <= PLAY_POS_MIN_TIME) return;
        if (!final && Date.now() - posLastSaveRef.current < PLAY_POS_SAVE_INTERVAL_MS) return;
        posLastSaveRef.current = Date.now();
        savePlayPosition(key, cur, d);
      } catch { /* cosmetic — never break playback */ }
    };

    // A 'seeking' before our own restore ran can only be a manual seek — from
    // then on the user owns the playhead and restore must stay out of the way.
    const onSeeking = () => { if (!posRestoredRef.current) posUserSeekedRef.current = true; };
    const onTimeUpdate = () => saveOrClear(false);
    const onEnded = () => { try { clearPlayPosition(key); } catch { /* cosmetic */ } };

    // One restore attempt per file-open. Fired on loadedmetadata and retried on
    // canplay only while the seekable ranges haven't been reported yet.
    const tryRestore = () => {
      if (posRestoredRef.current || posUserSeekedRef.current) return;
      try {
        const d = mediaEl.duration;
        if (!Number.isFinite(d)) return;
        const entry = getPlayPosition(key);
        if (!entry || entry.t <= PLAY_POS_MIN_TIME || entry.t >= PLAY_POS_RESTORE_MAX_FRAC * d) {
          posRestoredRef.current = true;
          return;
        }
        // Live transcodes aren't seekable — keep the entry for a future direct play.
        if (transcoded) { posRestoredRef.current = true; return; }
        let seekableNow = false;
        try {
          seekableNow = mediaEl.seekable.length > 0 && entry.t <= mediaEl.seekable.end(mediaEl.seekable.length - 1);
        } catch { seekableNow = false; }
        if (!seekableNow) return; // ranges not reported yet — retry on canplay
        posRestoredRef.current = true;
        mediaEl.currentTime = entry.t;
        toast(`${t('player.resumedFrom')} ${fmtTime(entry.t)}`, { id: 'player-resume' });
      } catch { posRestoredRef.current = true; }
    };

    const events: Array<[string, () => void]> = [
      ['timeupdate', onTimeUpdate],
      ['ended', onEnded],
      ['seeking', onSeeking],
      ['loadedmetadata', tryRestore],
      ['canplay', tryRestore],
    ];
    for (const [ev, fn] of events) mediaEl.addEventListener(ev, fn);
    if (mediaEl.readyState >= 1) tryRestore(); // metadata beat this effect

    return () => {
      for (const [ev, fn] of events) mediaEl.removeEventListener(ev, fn);
      saveOrClear(true); // final flush — file switch, close and unmount all land here
    };
    // activeIndex is deliberately NOT a dep: the key is bound to the file the
    // mounted element plays (streamIndexRef), so the flush-on-switch uses the
    // OLD file's key even though activeIndex already points at the new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaEl, transcoded, posKeyBase, t]);

  const selectFile = useCallback((index: number) => {
    setActiveIndex(index);
    setForceTranscode(false);
    setError(null);
  }, []);

  // Direct playback failed — retry through the transcoder once.
  const handleMediaError = useCallback(() => {
    if (!transcoded) setForceTranscode(true);
    else setError(t('player.unsupported'));
  }, [transcoded, t]);

  const activeFile = files.find((f) => f.index === activeIndex) || null;

  // Publish the current file on the LAN and show a QR + URL to open elsewhere.
  const handleCast = useCallback(async () => {
    if (activeIndex === null) return;
    setCastBusy(true);
    setCastError(null);
    setCastOpen(true);
    try {
      const info = await window.api.cast.start(downloadId, activeIndex);
      if (!info) setCastError(t('player.castNoLan'));
      else setCastInfo(info);
    } catch (err: unknown) {
      setCastError(err instanceof Error ? err.message : String(err));
    } finally {
      setCastBusy(false);
    }
  }, [downloadId, activeIndex, t]);

  // Re-publish when switching files while the cast panel is open.
  useEffect(() => {
    if (castOpen && activeIndex !== null) { setCastInfo(null); handleCast(); }
  }, [activeIndex]);

  // Publish for remote viewing (over WebRTC, works outside the local network).
  const handleRemote = useCallback(async () => {
    if (activeIndex === null) return;
    setRemoteBusy(true);
    setRemoteError(null);
    try {
      const info = await window.api.cast.remoteStart(downloadId, activeIndex);
      setRemoteInfo(info);
    } catch (err: unknown) {
      setRemoteError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteBusy(false);
    }
  }, [downloadId, activeIndex]);

  // Switching to the "anywhere" tab lazily starts the remote session.
  useEffect(() => {
    if (castOpen && castMode === 'remote' && !remoteInfo && !remoteBusy) handleRemote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [castMode, castOpen]);

  // Reset remote session when switching files.
  useEffect(() => { setRemoteInfo(null); setRemoteError(null); }, [activeIndex]);

  // Cast to TV (Chromecast)
  const playOnTv = useCallback(async (host: string, name: string) => {
    if (activeIndex === null) return;
    setTvError(null);
    try {
      await window.api.cast.tvPlay(downloadId, activeIndex, host);
      setTvPlaying({ host, name });
      setTvPaused(false);
    } catch (err: unknown) {
      setTvError(err instanceof Error ? err.message : String(err));
    }
  }, [downloadId, activeIndex]);

  const tvControl = useCallback(async (action: 'pause' | 'resume' | 'stop') => {
    if (!tvPlaying) return;
    try {
      await window.api.cast.tvControl(tvPlaying.host, action);
      if (action === 'stop') setTvPlaying(null);
      else setTvPaused(action === 'pause');
    } catch (err: unknown) {
      setTvError(err instanceof Error ? err.message : String(err));
    }
  }, [tvPlaying]);

  // Discover TVs while the TV tab is open (mDNS results trickle in).
  useEffect(() => {
    if (!(castOpen && castMode === 'tv')) return;
    let alive = true;
    let n = 0;
    const scan = async (refresh: boolean) => {
      try {
        const list = refresh ? await window.api.cast.tvRefresh() : await window.api.cast.tvList();
        if (alive) setTvDevices(list);
      } catch (err) { if (alive) setTvError(err instanceof Error ? err.message : String(err)); }
    };
    scan(false);
    const iv = setInterval(() => { n++; scan(true); if (n >= 6) clearInterval(iv); }, 2500);
    return () => { alive = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [castOpen, castMode]);

  // Reset TV state when switching files.
  useEffect(() => { setTvPlaying(null); setTvDevices([]); setTvError(null); }, [activeIndex]);

  // Load available subtitle tracks for the active file.
  useEffect(() => {
    setSubOpen(false);
    setSubActiveKey(null);
    setSubUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setSubTracks([]);
    if (activeIndex === null) return;
    let alive = true;
    window.api.subtitles.list(downloadId, activeIndex)
      .then((list) => { if (alive) setSubTracks(list); })
      .catch(() => {});
    return () => { alive = false; };
  }, [downloadId, activeIndex]);

  const selectSubtitle = useCallback(async (key: string | null) => {
    setSubOpen(false);
    setSubUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    if (!key || activeIndex === null) { setSubActiveKey(null); return; }
    setSubActiveKey(key);
    try {
      const vtt = await window.api.subtitles.get(downloadId, activeIndex, key);
      if (!vtt || !vtt.trim()) return;
      const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      setSubUrl(url);
    } catch { /* ignore */ }
  }, [downloadId, activeIndex]);

  const activeCastUrl = castMode === 'remote' ? remoteInfo?.url : castInfo?.url;
  const copyCastUrl = useCallback(() => {
    if (!activeCastUrl) return;
    navigator.clipboard.writeText(activeCastUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [activeCastUrl]);

  const renderBody = useCallback(() => {
    if (error) {
      return (
        <div className="player-message">
          <Icon name="alert-triangle" size={30} />
          <p>{error}</p>
        </div>
      );
    }
    if (loading || !streamUrl) {
      return (
        <div className="player-message">
          <span className="spinner spinner-lg" />
          <p>{transcoded ? t('player.converting') : t('player.buffering')}</p>
        </div>
      );
    }
    if (kind === 'audio') {
      return (
        <div className="player-audio">
          <div className="player-audio-art"><Icon name="music" size={48} /></div>
          <div className="player-audio-name">{activeFile?.name}</div>
          <audio
            key={streamUrl}
            ref={(el) => setMediaEl(el)}
            src={streamUrl}
            autoPlay
            onError={handleMediaError}
          />
          <PlayerControls media={mediaEl} seekable={!transcoded} />
        </div>
      );
    }
    return (
      <div className="player-stage" ref={stageRef}>
        <video
          key={streamUrl}
          ref={(el) => setMediaEl(el)}
          src={streamUrl}
          autoPlay
          className="player-video"
          onClick={() => { if (mediaEl) { if (mediaEl.paused) void mediaEl.play().catch(() => {}); else mediaEl.pause(); } }}
          onError={handleMediaError}
        >
          {subUrl && <track kind="subtitles" src={subUrl} srcLang="und" label={t('player.subtitles')} default />}
        </video>
        <PlayerControls media={mediaEl} fullscreenTarget={stageRef} seekable={!transcoded} />
      </div>
    );
  }, [error, loading, streamUrl, kind, activeFile, transcoded, handleMediaError, t, subUrl, mediaEl]);

  return (
    <div className="player-overlay" onClick={onClose}>
      <div className="player-modal" onClick={(e) => e.stopPropagation()}>
        <div className="player-header">
          <div className="player-title">
            <span className="player-title-icon">
              <Icon name={kind === 'audio' ? 'music' : 'play'} size={15} />
            </span>
            <span className="player-title-text" title={activeFile?.name || downloadName}>
              {activeFile?.name || downloadName}
            </span>
            {transcoded && (
              <span className="player-badge" title={t('player.transcodingNote')}>
                <Icon name="zap" size={11} /> {t('player.transcoding')}
              </span>
            )}
          </div>
          {activeFile?.kind === 'video' && (
            <div className="player-sub-wrap">
              <button
                className={`player-cast-btn ${subOpen ? 'active' : ''}`}
                onClick={() => setSubOpen((o) => !o)}
                title={t('player.subtitles')}
              >
                <Icon name="file-text" size={15} />
                <span className="player-cast-label">{subActiveKey ? 'CC ●' : 'CC'}</span>
              </button>
              {subOpen && (
                <div className="player-sub-panel">
                  <button className={`player-sub-item ${!subActiveKey ? 'active' : ''}`} onClick={() => selectSubtitle(null)}>
                    {t('player.subOff')}
                  </button>
                  {subTracks.length === 0 ? (
                    <div className="player-sub-empty">{t('player.subNone')}</div>
                  ) : (
                    subTracks.map((tr) => (
                      <button key={tr.key} className={`player-sub-item ${subActiveKey === tr.key ? 'active' : ''}`} onClick={() => selectSubtitle(tr.key)}>
                        <Icon name={tr.source === 'embedded' ? 'film' : 'file-text'} size={13} />
                        <span>{tr.label}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          <button
            className={`player-cast-btn ${castOpen ? 'active' : ''}`}
            onClick={() => (castOpen ? setCastOpen(false) : handleCast())}
            title={t('player.cast')}
          >
            <Icon name="tv" size={16} />
            <span className="player-cast-label">{t('player.cast')}</span>
          </button>
          <button className="player-close" onClick={onClose} title={t('player.close')}>
            <Icon name="x" size={18} />
          </button>
        </div>

        {castOpen && (
          <div className="player-cast-panel">
            <button className="player-cast-close" onClick={() => setCastOpen(false)} title={t('player.close')}>
              <Icon name="x" size={14} />
            </button>
            <div className="player-cast-title">{t('player.castTitle')}</div>

            <div className="player-cast-tabs">
              <button className={`player-cast-tab ${castMode === 'lan' ? 'active' : ''}`} onClick={() => setCastMode('lan')}>
                <Icon name="monitor" size={13} /> {t('player.castLan')}
              </button>
              <button className={`player-cast-tab ${castMode === 'tv' ? 'active' : ''}`} onClick={() => setCastMode('tv')}>
                <Icon name="tv" size={13} /> {t('player.castTv')}
              </button>
              <button className={`player-cast-tab ${castMode === 'remote' ? 'active' : ''}`} onClick={() => setCastMode('remote')}>
                <Icon name="globe" size={13} /> {t('player.castRemote')}
              </button>
            </div>

            {castMode === 'tv' ? (
              <div className="player-cast-tv">
                {tvError && <div className="player-cast-error"><Icon name="alert-triangle" size={14} /> {tvError}</div>}
                {tvPlaying ? (
                  <>
                    <div className="player-cast-tv-now"><Icon name="tv" size={16} /> {t('player.castTvOn')} <strong>{tvPlaying.name}</strong></div>
                    <div className="player-cast-tv-controls">
                      {tvPaused ? (
                        <button className="player-cast-tv-btn" onClick={() => tvControl('resume')}><Icon name="play" size={14} /> {t('player.resume')}</button>
                      ) : (
                        <button className="player-cast-tv-btn" onClick={() => tvControl('pause')}><Icon name="pause" size={14} /> {t('player.pause')}</button>
                      )}
                      <button className="player-cast-tv-btn stop" onClick={() => tvControl('stop')}><Icon name="x" size={14} /> {t('player.stop')}</button>
                    </div>
                  </>
                ) : tvDevices.length === 0 ? (
                  <div className="player-cast-loading"><span className="spinner" /> {t('player.castTvSearching')}</div>
                ) : (
                  <div className="player-cast-tv-list">
                    {tvDevices.map((d) => (
                      <button key={d.host} className="player-cast-tv-device" onClick={() => playOnTv(d.host, d.name)}>
                        <Icon name="tv" size={16} /> <span>{d.name}</span> <Icon name="play" size={14} />
                      </button>
                    ))}
                  </div>
                )}
                <div className="player-cast-hint"><Icon name="info" size={12} /> {t('player.castTvHint')}</div>
              </div>
            ) : castMode === 'lan' ? (
              castBusy ? (
                <div className="player-cast-loading"><span className="spinner" /> {t('player.castStarting')}</div>
              ) : castError ? (
                <div className="player-cast-error"><Icon name="alert-triangle" size={14} /> {castError}</div>
              ) : castInfo ? (
                <>
                  <div className="player-cast-qr"><QRCode data={castInfo.url} size={180} /></div>
                  <div className="player-cast-desc">{t('player.castDesc')}</div>
                  <button className="player-cast-url" onClick={copyCastUrl} title={t('player.castCopy')}>
                    <span>{castInfo.url}</span>
                    <Icon name={copied ? 'check-circle' : 'copy'} size={14} />
                  </button>
                  <div className="player-cast-hint"><Icon name="info" size={12} /> {t('player.castHint')}</div>
                </>
              ) : null
            ) : (
              remoteBusy ? (
                <div className="player-cast-loading"><span className="spinner" /> {t('player.castStarting')}</div>
              ) : remoteError ? (
                <div className="player-cast-error"><Icon name="alert-triangle" size={14} /> {remoteError}</div>
              ) : remoteInfo ? (
                <>
                  <div className="player-cast-qr"><QRCode data={remoteInfo.url} size={180} /></div>
                  <div className="player-cast-desc">{t('player.castRemoteDesc')}</div>
                  <button className="player-cast-url" onClick={copyCastUrl} title={t('player.castCopy')}>
                    <span>{remoteInfo.url}</span>
                    <Icon name={copied ? 'check-circle' : 'copy'} size={14} />
                  </button>
                  <div className="player-cast-hint"><Icon name="info" size={12} /> {t('player.castRemoteHint')}</div>
                </>
              ) : null
            )}
          </div>
        )}

        <div className="player-body">{renderBody()}</div>

        {files.length > 1 && (
          <div className="player-files">
            {files.map((f) => (
              <button
                key={f.index}
                className={`player-file-chip ${f.index === activeIndex ? 'active' : ''}`}
                onClick={() => selectFile(f.index)}
                title={f.name}
              >
                <Icon name={f.kind === 'audio' ? 'music' : 'film'} size={12} />
                <span className="player-file-name">{f.name}</span>
                <span className="player-file-size">{formatBytes(f.length)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="player-note">
          <Icon name="info" size={12} />
          <span>{transcoded ? t('player.transcodingNote') : t('player.note')}</span>
        </div>
      </div>
    </div>
  );
};

export default StreamPlayerModal;
