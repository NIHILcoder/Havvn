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
import { PlayerControls } from './PlayerControls';
import { MediaBufferStatus } from './MediaBufferStatus';
import { EpisodePrefetchControl } from './EpisodePrefetchControl';
import { PlayerPreferencesPanel } from './PlayerPreferencesPanel';
import { preferredAudio, preferredSubtitle, effectiveAudioLanguage, playerFileKey, trackIdentity, type AudioTrack, type SubtitleTrack, type PlayerPreferences } from '../../shared/player-preferences';
import { PLAYER_PREFS_KEY, loadPlayerPreferences, savePlayerPreferences, loadFileTrackChoice, saveFileTrackChoice, clearFileTrackChoice } from '../utils/playerPreferences';
import { useSubtitlePresentation } from '../utils/useSubtitlePresentation';
import { useTranslation } from '../utils/i18nContext';
import { classifyMediaKind, MediaKind } from '../../shared/media';
import { playerFrameName } from '../../shared/player-windows';
import { usePopout } from '../utils/popout';
import { WindowControls } from '../layout/WindowControls';
import { useDockWindowMaximized, minimizeDockWindow, toggleMaximizeDockWindow } from '../pages/rooms/dock/dockWindowChrome';
import { beginWatch, beginPlaybackWatch, getWatchEntry, saveWatch, migrateWatchHistory } from '../utils/watchHistory';
import { resumablePosition, type WatchEntry } from '../../shared/watch-history';
import './StreamPlayerModal.css';

interface StreamFile {
  index: number;
  name: string;
  path: string; // torrent-relative — basenames repeat across season folders
  length: number;
  kind: MediaKind;
}

interface StreamPlayerModalProps {
  downloadId: string;
  downloadName: string;
  onClose: () => void;
  initialFilePath?: string;
  historyPlayback?: boolean;
}

const formatBytes = (bytes: number): string => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const PLAY_POS_FINISHED_FRAC = 0.95;
const PLAY_POS_SAVE_INTERVAL_MS = 5000;

export const StreamPlayerModal: React.FC<StreamPlayerModalProps> = ({ downloadId, downloadName, onClose, initialFilePath, historyPlayback = false }) => {
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
  const [subTracks, setSubTracks] = useState<SubtitleTrack[]>([]);
  const [subOpen, setSubOpen] = useState(false);
  const [subActiveKey, setSubActiveKey] = useState<string | null>(null);
  const [subUrl, setSubUrl] = useState<string | null>(null);
  // Audio tracks (multi-audio MKV): null = ffmpeg's default; picking a track
  // forces transcode (browsers can't switch embedded tracks on a plain <video>).
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [catalogFile, setCatalogFile] = useState<number | null>(null);
  const [audioOpen, setAudioOpen] = useState(false);
  const [audioTrackIndex, setAudioTrackIndex] = useState<number | null>(null);
  // Serial mode: playlist panel + auto-advance to the next episode on 'ended'.
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [autoNext, setAutoNext] = useState<boolean>(() => {
    try { return localStorage.getItem('playerAutoNext') !== '0'; } catch { return true; }
  });
  const advancedRef = useRef(false); // once-per-mounted-element auto-advance guard
  // Custom Ember controls: the media element remounts per stream URL, so it is
  // captured via a callback ref; the stage wrapper is the fullscreen target.
  const [mediaEl, setMediaEl] = useState<HTMLVideoElement | HTMLAudioElement | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [preferences, setPreferences] = useState(loadPlayerPreferences);
  const [choiceRevision, setChoiceRevision] = useState(0);
  const [streamStart, setStreamStart] = useState(0);
  const [streamOffset, setStreamOffset] = useState(0);
  const timelineOffsetRef = useRef(0);
  const resumeRef = useRef<{ time: number; paused: boolean; muted: boolean; volume: number; rate: number; file: number | null } | null>(null);
  const mediaResumeTargets = useRef(new WeakMap<HTMLMediaElement, NonNullable<typeof resumeRef.current>>());
  useSubtitlePresentation(mediaEl, preferences, streamOffset, subUrl);
  const updatePreferences = useCallback((next: PlayerPreferences) => { savePlayerPreferences(next); setPreferences(next); }, []);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => { if (event.key === PLAYER_PREFS_KEY) setPreferences(loadPlayerPreferences()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Stable torrent identity is resolved before choosing and restoring a file.
  const [posKeyBase, setPosKeyBase] = useState<{ base: string; ready: boolean }>({ base: downloadId, ready: false });
  // File index the currently mounted media element actually plays (activeIndex
  // may already point at the next file while the old element is flushing).
  const streamIndexRef = useRef<number | null>(null);
  const posLastSaveRef = useRef(0);       // throttle timestamp for timeupdate saves

  const watchSessions = useRef(new Map<string, ReturnType<typeof beginWatch>>());
  const mediaPositions = useRef(new WeakMap<HTMLMediaElement, { index: number; offset: number }>());
  const durations = useRef(new Map<number, number>());
  const openPosition = (base: string, file: StreamFile, knownFiles = files) => {
    const key = playerFileKey(base, file.path), existing = getWatchEntry(base, file.path), time = resumablePosition(existing);
    if (existing?.tracks && !loadFileTrackChoice(key)) {
      if (existing.tracks.audio !== undefined) saveFileTrackChoice(key, { audio: existing.tracks.audio });
      if (existing.tracks.subtitle !== undefined) saveFileTrackChoice(key, { subtitle: existing.tracks.subtitle });
    }
    const session = beginPlaybackWatch(base, file.path) || beginWatch(base, file.path); watchSessions.current.set(key, session);
    const ordered = knownFiles.filter(f => f.kind === 'video').sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
    saveWatch({ identity: base, downloadId, title: downloadName, path: file.path, fileIndex: file.index, position: time,
      duration: existing?.duration || null, completed: false, lastOpened: Date.now(), updatedAt: Date.now(), tracks: loadFileTrackChoice(key),
      nextPath: ordered[ordered.findIndex(f => f.index === file.index) + 1]?.path }, session);
    resumeRef.current = { time, paused: false, muted: false, volume: 1, rate: 1, file: file.index };
    setStreamStart(time);
  };
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [downloads, all] = await Promise.all([window.api.getDownloads(), historyPlayback ? window.api.historyPlayback.files(downloadId) : window.api.getTorrentFiles(downloadId)]);
        const base = downloads.find(d => d.id === downloadId)?.infoHash || downloadId;
        await migrateWatchHistory(downloads.filter(d => d.id === downloadId), id => window.api.historyPlayback?.files(id) || Promise.resolve(all));
        const streamable: StreamFile[] = all.map((f, index) => ({ index: f.index ?? index, name: f.name, path: f.path || f.name, length: f.length, kind: classifyMediaKind(f.name) }))
          .filter(f => f.kind !== 'other').sort((a, b) => b.length - a.length);
        if (cancelled) return;
        setFiles(streamable); setPosKeyBase({ base, ready: true });
        const chosen = initialFilePath ? streamable.find(f => f.path.replace(/\\/g, '/') === initialFilePath.replace(/\\/g, '/')) : streamable[0];
        if (!chosen) { setError(t('player.noMedia')); setLoading(false); return; }
        openPosition(base, chosen, streamable); setActiveIndex(chosen.index);
      } catch (err: unknown) {
        if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
    // Initialization owns the requested file; subsequent playlist selections stay local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadId, initialFilePath, historyPlayback]);

  // Resolve a stream URL whenever the active file (or transcode mode, or the
  // chosen audio track) changes. A non-default audio track forces transcode —
  // the new URL remounts <video key={url}>, restarting ffmpeg with the -map.
  useEffect(() => {
    if (activeIndex === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStreamUrl(null);
    (async () => {
      try {
        const info = await (historyPlayback ? window.api.historyPlayback.stream : window.api.getStreamUrl)(downloadId, activeIndex, {
          transcode: forceTranscode || audioTrackIndex !== null,
          audioTrack: audioTrackIndex ?? undefined,
          startTime: streamStart,
        });
        if (cancelled) return;
        streamIndexRef.current = activeIndex;
        const offset = info.startTime || 0;
        timelineOffsetRef.current = offset;
        setStreamOffset(offset);
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
  }, [downloadId, activeIndex, forceTranscode, audioTrackIndex, streamStart, historyPlayback]);

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
      // The modal removes the element without pausing — exit PiP explicitly so
      // closing never strands a floating frame on Chromium's auto-close timing.
      if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
      const idx = activeIndexRef.current;
      if (historyPlayback) void window.api.historyPlayback.stop(downloadId);
      void window.api.stopStream(downloadId, idx === null ? undefined : idx);
    };
  }, [downloadId, historyPlayback]);

  // Reset the position-memory guards whenever a new media element mounts (the
  // element remounts per stream URL, so this is exactly "per file-open").
  useEffect(() => {
    posLastSaveRef.current = 0;
    advancedRef.current = false;
  }, [mediaEl]);

  // PiP continuity: the per-URL remount destroys the element Chromium has in
  // picture-in-picture, closing the floating window on every auto-advance or
  // track switch. Remember that PiP was on (unless the user closed it while
  // the element was still mounted) and best-effort re-enter on the fresh
  // element — if Chromium demands a user gesture, the next manual toggle
  // resumes the flow instead.
  const pipWantedRef = useRef(false);
  useEffect(() => {
    if (!(mediaEl instanceof HTMLVideoElement)) return;
    const onEnter = () => { pipWantedRef.current = true; };
    const onLeave = () => { if (mediaEl.isConnected) pipWantedRef.current = false; };
    mediaEl.addEventListener('enterpictureinpicture', onEnter);
    mediaEl.addEventListener('leavepictureinpicture', onLeave);
    return () => {
      mediaEl.removeEventListener('enterpictureinpicture', onEnter);
      mediaEl.removeEventListener('leavepictureinpicture', onLeave);
    };
  }, [mediaEl]);
  useEffect(() => {
    if (!pipWantedRef.current || !(mediaEl instanceof HTMLVideoElement)) return;
    const tryEnter = () => { void mediaEl.requestPictureInPicture().catch(() => { /* gesture required */ }); };
    if (mediaEl.readyState >= 1) { tryEnter(); return; }
    mediaEl.addEventListener('loadedmetadata', tryEnter, { once: true });
    return () => mediaEl.removeEventListener('loadedmetadata', tryEnter);
  }, [mediaEl]);

  // Bind every flush to the file and offset of THIS element, including old elements
  // during source switches and portal moves. Never save a new file with the old clock.
  useEffect(() => {
    const mounted = mediaEl && mediaPositions.current.get(mediaEl);
    if (!mediaEl || !mounted || !posKeyBase.ready) return;
    const file = files.find(f => f.index === mounted.index); if (!file) return;
    const key = playerFileKey(posKeyBase.base, file.path), session = watchSessions.current.get(key);
    if (!session) return;
    let duration = getWatchEntry(posKeyBase.base, file.path)?.duration || durations.current.get(file.index) || null;
    let disposed = false;
    if (!duration && window.api.historyPlayback) void window.api.historyPlayback.duration(downloadId, file.index).then(d => {
      if (d && Number.isFinite(d)) { durations.current.set(file.index, d); if (!disposed) duration = d; }
    }).catch(() => {});
    const ordered = files.filter(f => f.kind === 'video').sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
    const nextPath = ordered[ordered.findIndex(f => f.index === file.index) + 1]?.path;
    const save = (final: boolean) => {
      if (!Number.isFinite(mediaEl.currentTime) || mediaEl.readyState < 1) return;
      if (!final && Date.now() - posLastSaveRef.current < PLAY_POS_SAVE_INTERVAL_MS) return;
      posLastSaveRef.current = Date.now();
      const d = mounted.offset === 0 && Number.isFinite(mediaEl.duration) && mediaEl.duration > 0 && !transcoded ? mediaEl.duration :
        duration || (Number.isFinite(mediaEl.duration) && mediaEl.duration > 0 ? mediaEl.duration + mounted.offset : null);
      const position = mediaResumeTargets.current.get(mediaEl)?.time ?? Math.max(0, mediaEl.currentTime + mounted.offset);
      // For unknown-duration live transcodes, a broken stream cannot mark an episode watched.
      const completed = !!d && position >= d * PLAY_POS_FINISHED_FRAC;
      const previous = getWatchEntry(posKeyBase.base, file.path);
      const entry: WatchEntry = { identity: posKeyBase.base, downloadId, title: downloadName, path: file.path, fileIndex: file.index,
        position, duration: d, lastOpened: previous?.lastOpened || Date.now(), updatedAt: Date.now(), completed,
        tracks: loadFileTrackChoice(key), nextPath };
      saveWatch(entry, session);
    };
    const update = () => save(false), flush = () => save(true);
    mediaEl.addEventListener('timeupdate', update); mediaEl.addEventListener('pause', flush); mediaEl.addEventListener('ended', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      disposed = true; mediaEl.removeEventListener('timeupdate', update); mediaEl.removeEventListener('pause', flush); mediaEl.removeEventListener('ended', flush);
      window.removeEventListener('pagehide', flush); save(true);
    };
  }, [mediaEl, posKeyBase, files, downloadId, downloadName, transcoded]);

  const selectFile = useCallback((index: number) => {
    if (index === activeIndex) return;
    resumeRef.current = null;
    setActiveIndex(index);
    setForceTranscode(false);
    setAudioTrackIndex(null);
    setSubActiveKey(null);
    const file = files.find(f => f.index === index);
    if (file && posKeyBase.ready) openPosition(posKeyBase.base, file); else setStreamStart(0);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, files, posKeyBase]);

  const snapshotMedia = useCallback((el: HTMLMediaElement) => {
    const pending = mediaResumeTargets.current.get(el);
    if (pending) return pending;
    const time = Number.isFinite(el.currentTime) ? Math.max(0, el.currentTime + timelineOffsetRef.current) : 0;
    return { time, paused: el.paused, muted: el.muted, volume: el.volume, rate: el.playbackRate, file: activeIndex };
  }, [activeIndex]);
  const captureForSourceChange = useCallback((el: HTMLMediaElement | null = mediaEl) => {
    if (!el) return;
    const snapshot = snapshotMedia(el);
    resumeRef.current = snapshot; setStreamStart(snapshot.time);
  }, [mediaEl, snapshotMedia]);

  // Direct playback failed — retry through the transcoder once.
  const handleMediaError = useCallback((event: React.SyntheticEvent<HTMLMediaElement>) => {
    const code = event.currentTarget.error?.code;
    if (code === 1 || code === 2) setError(t('player.phase.networkError'));
    else if (!transcoded && !forceTranscode) { captureForSourceChange(event.currentTarget); setForceTranscode(true); }
    else setError(t('player.phase.decodeError'));
  }, [transcoded, forceTranscode, t, captureForSourceChange]);

  const activeFile = files.find((f) => f.index === activeIndex) || null;
  const fileChoiceKey = posKeyBase.ready && activeFile ? playerFileKey(posKeyBase.base, activeFile.path) : null;

  // ── detached window ────────────────────────────────────────────────────────
  // Its own window rather than a dock panel: this is about a FILE, not about a
  // place in the room's layout. Two frame names, one per shape — bounds are saved
  // per frame, so a shared one would reopen the compact audio bar at the size of
  // the last film (shared/player-windows.ts).
  const frameName = playerFrameName(kind);
  const { popout, portal, openPopout, closePopout } = usePopout(
    frameName,
    activeFile?.name || downloadName,
  );
  // Drives the maximise/restore glyph in the header, queried per window.
  const winMaximized = useDockWindowMaximized(frameName, popout !== null);
  const detached = popout !== null;
  /**
   * Where playback was when the media element was last torn down, so the copy
   * that mounts in the other window can pick it up.
   *
   * Moving the subtree between documents does NOT move the element: React builds
   * a new one for the new container, and a fresh media element starts at zero with
   * its resource selection re-run. Without this, detaching a film restarts it.
   */

  // ── Serial mode ─────────────────────────────────────────────────────────────
  // Episode order = natural sort over the torrent-relative PATH ("E2" before
  // "E10", and Season 1 before Season 2 — basenames alone repeat across season
  // folders). The chip strip below keeps its size-desc order (best for "play
  // the main file"); this second view powers series. Entries whose basename
  // repeats get the parent folder prefixed so they stay distinguishable.
  const playlist = React.useMemo(() => {
    const vids = files
      .filter((f) => f.kind === 'video')
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
    const nameCounts = new Map<string, number>();
    for (const f of vids) nameCounts.set(f.name, (nameCounts.get(f.name) ?? 0) + 1);
    return vids.map((f) => {
      if ((nameCounts.get(f.name) ?? 0) <= 1) return { ...f, label: f.name };
      const parts = f.path.split(/[\\/]/);
      const parent = parts.length > 1 ? parts[parts.length - 2] : '';
      return { ...f, label: parent ? `${parent} / ${f.name}` : f.name };
    });
  }, [files]);
  const playlistPos = activeIndex === null ? -1 : playlist.findIndex((f) => f.index === activeIndex);
  // Deliberately no wrap-around from the last episode — prevents infinite loops.
  const nextFile = playlistPos >= 0 && playlistPos < playlist.length - 1 ? playlist[playlistPos + 1] : null;

  const playNext = useCallback(() => {
    if (nextFile) selectFile(nextFile.index);
  }, [nextFile, selectFile]);

  const toggleAutoNext = useCallback(() => {
    setAutoNext((v) => {
      const next = !v;
      try { localStorage.setItem('playerAutoNext', next ? '1' : '0'); } catch { /* cosmetic */ }
      return next;
    });
  }, []);

  // Auto-advance only after a known full duration, never on an interrupted live transcode.
  useEffect(() => {
    if (!mediaEl || kind !== 'video') return;
    const onEnded = () => {
      if (!autoNext || advancedRef.current || !nextFile) return;
      // A stale 'ended' from the OLD element after the user already picked
      // another file must not override that choice.
      if (activeIndexRef.current !== streamIndexRef.current) return;
      // A stream that produced nothing can't chain-skip episodes…
      if (!(mediaEl.currentTime > 0)) return;
      const mounted = mediaPositions.current.get(mediaEl);
      if (!mounted) return;
      const historyDuration = activeFile ? getWatchEntry(posKeyBase.base, activeFile.path)?.duration : null;
      const d = durations.current.get(mounted.index) || historyDuration || (Number.isFinite(mediaEl.duration) ? mediaEl.duration + mounted.offset : 0);
      if (!d || (mediaEl.currentTime + mounted.offset) / d < PLAY_POS_FINISHED_FRAC) return;
      advancedRef.current = true;
      playNext();
    };
    mediaEl.addEventListener('ended', onEnded);
    return () => mediaEl.removeEventListener('ended', onEnded);
  }, [mediaEl, kind, autoNext, nextFile, playNext, activeFile, posKeyBase.base]);

  // ── Audio tracks ────────────────────────────────────────────────────────────
  // A fresh file gets its own catalog. Reordered audio ordinals never carry over.
  useEffect(() => {
    setAudioOpen(false);
    setAudioTracks([]);
    setCatalogFile(null);
    setSubOpen(false);
    setSubTracks([]);
    if (activeIndex === null || activeFile?.kind !== 'video') return;
    let cancelled = false;
    void (historyPlayback ? window.api.historyPlayback.audio : window.api.audioTracks.list)(downloadId, activeIndex).then(list => { if (!cancelled) { setAudioTracks(list); setCatalogFile(activeIndex); } }).catch(() => {});
    void (historyPlayback ? window.api.historyPlayback.subtitles : window.api.subtitles.list)(downloadId, activeIndex).then(list => { if (!cancelled) { setSubTracks(list); setCatalogFile(activeIndex); } }).catch(() => {});
    return () => { cancelled = true; };
  }, [downloadId, activeIndex, activeFile?.kind, historyPlayback]);
  useEffect(() => {
    if (!mediaEl || activeIndex === null || activeFile?.kind !== 'video') return;
    let cancelled = false;
    const retry = () => {
      if (!audioTracks.length) void (historyPlayback ? window.api.historyPlayback.audio : window.api.audioTracks.list)(downloadId, activeIndex).then(list => { if (!cancelled && list.length) { setAudioTracks(list); setCatalogFile(activeIndex); } }).catch(() => {});
      if (!subTracks.length) void (historyPlayback ? window.api.historyPlayback.subtitles : window.api.subtitles.list)(downloadId, activeIndex).then(list => { if (!cancelled && list.length) { setSubTracks(list); setCatalogFile(activeIndex); } }).catch(() => {});
    };
    if (mediaEl.readyState >= 1) retry();
    else mediaEl.addEventListener('loadedmetadata', retry, { once: true });
    return () => { cancelled = true; mediaEl.removeEventListener('loadedmetadata', retry); };
  }, [mediaEl, downloadId, activeIndex, activeFile?.kind, audioTracks.length, subTracks.length, historyPlayback]);
  const switchAudio = useCallback((next: number | null) => {
    if (audioTrackIndex === next) return;
    captureForSourceChange(); setAudioTrackIndex(next);
  }, [audioTrackIndex, captureForSourceChange]);
  useEffect(() => {
    if (!fileChoiceKey || !audioTracks.length || catalogFile !== activeIndex) return;
    const chosen = preferredAudio(audioTracks, preferences, loadFileTrackChoice(fileChoiceKey));
    switchAudio(chosen?.index ?? null);
  }, [fileChoiceKey, audioTracks, preferences, choiceRevision, switchAudio, catalogFile, activeIndex]);
  const selectAudio = (track: AudioTrack | null) => {
    setAudioOpen(false);
    if (fileChoiceKey) saveFileTrackChoice(fileChoiceKey, { audio: track ? trackIdentity(track) : 'default' });
    setChoiceRevision(value => value + 1); switchAudio(track?.index ?? null);
  };

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

  // Automatic selection respects per-file choices and leaves unknown languages manual.
  useEffect(() => {
    if (!fileChoiceKey || catalogFile !== activeIndex) return;
    const chosen = preferredSubtitle(subTracks, preferences, effectiveAudioLanguage(audioTracks, audioTrackIndex), loadFileTrackChoice(fileChoiceKey));
    setSubActiveKey(chosen?.key ?? null);
  }, [fileChoiceKey, subTracks, audioTracks, audioTrackIndex, preferences, choiceRevision, catalogFile, activeIndex]);
  const selectSubtitle = (key: string | null) => {
    setSubOpen(false);
    const track = subTracks.find(item => item.key === key);
    if (fileChoiceKey) saveFileTrackChoice(fileChoiceKey, { subtitle: track ? trackIdentity(track) : 'off' });
    setChoiceRevision(value => value + 1);
    setSubActiveKey(key);
  };
  useEffect(() => {
    setSubUrl(null);
    if (!subActiveKey || activeIndex === null) return;
    let disposed = false;
    let url: string | null = null;
    void (historyPlayback ? window.api.historyPlayback.vtt : window.api.subtitles.get)(downloadId, activeIndex, subActiveKey).then(vtt => {
      if (disposed) return;
      if (!vtt.trim()) throw new Error('Empty subtitles');
      url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })); setSubUrl(url);
    }).catch(() => { if (!disposed) toast.error(t('player.preferences.subError')); });
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [downloadId, activeIndex, subActiveKey, t, historyPlayback]);

  const activeCastUrl = castMode === 'remote' ? remoteInfo?.url : castInfo?.url;
  const copyCastUrl = useCallback(() => {
    if (!activeCastUrl) return;
    navigator.clipboard.writeText(activeCastUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [activeCastUrl]);

  /**
   * Take the media element as it mounts, and put playback back where it was if a
   * move is in flight. Restoring is gated on a PENDING request rather than done on
   * every mount, because `key={streamUrl}` also remounts for a new file (next
   * episode) and for the transcode switch — carrying 14:02 into the next episode
   * would be a bug wearing the same clothes as the fix.
   */
  const attachMedia = useCallback((el: HTMLMediaElement | null) => {
    setMediaEl(el);
    const offset = timelineOffsetRef.current;
    if (el && streamIndexRef.current !== null) mediaPositions.current.set(el, { index: streamIndexRef.current, offset });
    const want = resumeRef.current;
    if (!el || !want) return;
    resumeRef.current = null;
    if (want.file !== streamIndexRef.current) return;
    mediaResumeTargets.current.set(el, want);
    el.autoplay = !want.paused;
    const apply = () => {
      // Seeking before metadata is ignored by the element, so wait for it when the
      // fresh copy has not read the stream yet.
      const relativeTime = Math.max(0, want.time - offset);
      if (relativeTime > 0) { try { el.currentTime = relativeTime; } catch { /* not seekable */ } }
      // The sound state is part of the move: a new element in another document is
      // born at the defaults, and Chromium may mute it to permit autoplay.
      el.muted = want.muted;
      el.volume = want.volume;
      el.playbackRate = want.rate;
      mediaResumeTargets.current.delete(el);
      if (want.paused) el.pause();
      else void el.play().catch(() => { /* autoplay refused — the controls still work */ });
    };
    if (el.readyState >= 1) apply();
    else el.addEventListener('loadedmetadata', apply, { once: true });
  }, []);

  /** Detach / bring home. Playback is captured HERE, before React tears the old
   *  element down, so both directions of the move keep their place. */
  const toggleDetach = useCallback(() => {
    if (mediaEl) resumeRef.current = snapshotMedia(mediaEl);
    if (detached) closePopout();
    else if (!openPopout()) resumeRef.current = null; // denied — nothing moved
  }, [mediaEl, detached, closePopout, openPopout, snapshotMedia]);

  /** The window's own X bypasses the button, and the element then remounts
   *  inline — capture the position there too, or the film restarts from zero. */
  useEffect(() => {
    if (!popout) return;
    const capture = () => {
      if (mediaEl) resumeRef.current = snapshotMedia(mediaEl);
    };
    popout.addEventListener('beforeunload', capture);
    return () => popout.removeEventListener('beforeunload', capture);
  }, [popout, mediaEl, snapshotMedia]);

  /** The window is named after what is playing, and playlists move on. */
  useEffect(() => {
    if (!popout || popout.closed) return;
    popout.document.title = activeFile?.name || downloadName;
  }, [popout, activeFile, downloadName]);

  const detachButton = (
    <button
      className={`pc-btn${detached ? ' active' : ''}`}
      onClick={toggleDetach}
      title={t(detached ? 'player.attach' : 'player.detach')}
      aria-label={t(detached ? 'player.attach' : 'player.detach')}
      type="button"
    >
      <Icon name={detached ? 'minimize' : 'external-link'} size={15} />
    </button>
  );

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
          <MediaBufferStatus media={null} downloadId={downloadId} resolving />
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
            ref={attachMedia}
            src={streamUrl}
            autoPlay
            onError={handleMediaError}
          />
          <PlayerControls media={mediaEl} seekable={!transcoded} timeOffset={streamOffset}>{detachButton}</PlayerControls>
          <MediaBufferStatus media={mediaEl} downloadId={downloadId} transcoded={transcoded} />
        </div>
      );
    }
    return (
      <div className="player-stage" ref={stageRef}>
        <video
          key={streamUrl}
          ref={attachMedia}
          src={streamUrl}
          autoPlay
          className="player-video"
          onClick={() => { if (mediaEl) { if (mediaEl.paused) void mediaEl.play().catch(() => {}); else mediaEl.pause(); } }}
          onError={handleMediaError}
        >
          {subUrl && <track key={subUrl} kind="subtitles" src={subUrl} srcLang="und" label={t('player.subtitles')} default />}
        </video>
        <PlayerControls media={mediaEl} fullscreenTarget={stageRef} seekable={!transcoded} timeOffset={streamOffset}>
          {detachButton}
          {nextFile && (
            <button className="pc-btn" onClick={playNext} title={t('player.nextEpisode')}>
              <Icon name="skip-forward" size={15} />
            </button>
          )}
        </PlayerControls>
        <MediaBufferStatus media={mediaEl} downloadId={downloadId} transcoded={transcoded} />
      </div>
    );
  }, [error, loading, streamUrl, kind, activeFile, transcoded, handleMediaError, t, subUrl, mediaEl, nextFile, playNext, detachButton, downloadId, attachMedia, streamOffset]);

  const shell = (
    <div
      className={`player-modal${detached ? ` detached detached-${kind === 'audio' ? 'audio' : 'video'}` : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
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
          {playlist.length > 1 && (
            <div className="player-sub-wrap">
              <button
                className={`player-cast-btn ${playlistOpen ? 'active' : ''}`}
                onClick={() => { setPlaylistOpen((o) => !o); setAudioOpen(false); setSubOpen(false); }}
                title={t('player.playlist')}
              >
                <Icon name="list" size={15} />
                <span className="player-cast-label">
                  {playlistPos >= 0 ? `${playlistPos + 1}/${playlist.length}` : t('player.playlist')}
                </span>
              </button>
              {playlistOpen && (
                <div className="player-sub-panel player-playlist">
                  <button className={`player-sub-item ${autoNext ? 'active' : ''}`} onClick={toggleAutoNext}>
                    <Icon name="skip-forward" size={13} />
                    <span>{t('player.autoNext')}</span>
                    <span className="player-playlist-check">{autoNext ? '✓' : ''}</span>
                  </button>
                  {playlist.map((f, i) => (
                    <button
                      key={f.index}
                      className={`player-sub-item ${f.index === activeIndex ? 'active' : ''}`}
                      onClick={() => { setPlaylistOpen(false); selectFile(f.index); }}
                      title={f.path}
                    >
                      <span className="player-playlist-num">{i + 1}</span>
                      <span>{f.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {activeFile?.kind === 'video' && catalogFile === activeIndex && audioTracks.length > 1 && (
            <div className="player-sub-wrap">
              <button
                className={`player-cast-btn ${audioOpen ? 'active' : ''}`}
                onClick={() => { setAudioOpen((o) => !o); setPlaylistOpen(false); setSubOpen(false); }}
                title={t('player.audioTracks')}
              >
                <Icon name="music" size={15} />
                <span className="player-cast-label">{audioTrackIndex !== null ? `A${audioTrackIndex + 1}` : 'A'}</span>
              </button>
              {audioOpen && (
                <div className="player-sub-panel">
                  <button
                    className={`player-sub-item ${audioTrackIndex === null ? 'active' : ''}`}
                    onClick={() => selectAudio(null)}
                  >
                    {t('player.audioDefault')}
                  </button>
                  {audioTracks.map((tr) => (
                    <button
                      key={tr.index}
                      className={`player-sub-item ${audioTrackIndex === tr.index ? 'active' : ''}`}
                      onClick={() => selectAudio(tr)}
                    >
                      <Icon name="music" size={13} />
                      <span>{tr.label}{tr.isDefault ? ' ●' : ''}</span>
                    </button>
                  ))}
                  <div className="player-sub-empty">{t('player.audioSwitchNote')}</div>
                </div>
              )}
            </div>
          )}
          {activeFile?.kind === 'video' && (
            <div className="player-sub-wrap">
              <button
                className={`player-cast-btn ${subOpen ? 'active' : ''}`}
                onClick={() => { setSubOpen((o) => !o); setPlaylistOpen(false); setAudioOpen(false); }}
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
          {/* Detached, this row IS the window's title bar — the window is frameless,
              so the app's own controls replace the caption buttons. Close still means
              close the PLAYER; the button beside it is what brings it back inline. */}
          {detached ? (
            <WindowControls
              maximized={winMaximized}
              labels={{
                minimize: t('window.minimize'),
                maximize: t('window.maximize'),
                restore: t('window.restore'),
                close: t('player.close'),
              }}
              onMinimize={() => minimizeDockWindow(frameName)}
              onToggleMaximize={() => toggleMaximizeDockWindow(frameName)}
              onClose={onClose}
            />
          ) : (
            <button className="player-close" onClick={onClose} title={t('player.close')}>
              <Icon name="x" size={18} />
            </button>
          )}
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
        {activeFile?.kind === 'video' && <PlayerPreferencesPanel prefs={preferences} onChange={updatePreferences} onResetFile={() => {
          if (fileChoiceKey) clearFileTrackChoice(fileChoiceKey); setChoiceRevision(value => value + 1);
        }} />}
        {!historyPlayback && playlist.length > 1 && activeIndex !== null && <EpisodePrefetchControl media={loading || error ? null : mediaEl}
          downloadId={downloadId} currentFile={activeIndex} nextFile={nextFile?.index ?? null} nextName={nextFile?.label} />}

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
  );

  // Detached: the WINDOW is the frame, so no backdrop and no click-to-close — the
  // whole point of moving out is that what is behind stays usable. Closing the
  // window (its X, or the button) brings this straight back inline, playing.
  return portal(shell) ?? (
    <div className="player-overlay" onClick={onClose}>{shell}</div>
  );
};

export default StreamPlayerModal;
