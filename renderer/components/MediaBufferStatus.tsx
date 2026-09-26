import React, { useEffect, useState } from 'react';
import { bufferedSecondsAhead, playbackPhase, readBufferedRanges, type PlaybackSnapshot, type PlaybackSource } from '../../shared/playback-buffer';
import { useTranslation } from '../utils/i18nContext';
import './MediaBufferStatus.css';

const EMPTY_MEDIA: PlaybackSnapshot = { attached: false, readyState: 0, paused: true, ended: false, seeking: false, waiting: false };
interface Props {
  media: HTMLMediaElement | null;
  downloadId: string;
  resolving?: boolean;
  transcoded?: boolean;
}

export function MediaBufferStatus({ media, downloadId, resolving = false, transcoded = false }: Props) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState(EMPTY_MEDIA);
  const [ahead, setAhead] = useState(0);
  const [source, setSource] = useState<PlaybackSource | null>(null);
  useEffect(() => {
    let disposed = false;
    let receivedStats = false;
    setSource(null);
    const unsubscribe = window.api.onDownloadStats(stats => {
      const stat = stats.find(item => item.id === downloadId);
      if (stat) { receivedStats = true; setSource(previous => ({ ...stat, metadataPending: previous?.metadataPending && stat.progress === 0 })); }
    });
    void window.api.getDownloads().then(downloads => {
      const download = downloads.find(item => item.id === downloadId);
      if (!disposed && !receivedStats && download) setSource({ ...download, metadataPending: !download.totalSize });
    }).catch(() => { /* Missing stats must not interrupt local playback. */ });
    return () => { disposed = true; unsubscribe(); };
  }, [downloadId]);
  useEffect(() => {
    if (!media) { setSnapshot(EMPTY_MEDIA); setAhead(0); return; }
    let waiting = media.readyState < 3;
    const sync = () => {
      setSnapshot({ attached: true, readyState: media.readyState, paused: media.paused, ended: media.ended,
        seeking: media.seeking, waiting, errorCode: media.error?.code });
      setAhead(bufferedSecondsAhead(readBufferedRanges(media.buffered), media.currentTime));
    };
    const onWaiting = () => { waiting = true; sync(); };
    const onReady = () => { waiting = false; sync(); };
    const events = ['timeupdate', 'progress', 'pause', 'play', 'ended', 'loadedmetadata', 'seeking', 'seeked', 'error', 'emptied', 'durationchange'];
    for (const event of events) media.addEventListener(event, sync);
    media.addEventListener('waiting', onWaiting);
    media.addEventListener('canplay', onReady);
    media.addEventListener('playing', onReady);
    sync();
    const timer = setInterval(sync, 1000);
    return () => {
      clearInterval(timer);
      for (const event of events) media.removeEventListener(event, sync);
      media.removeEventListener('waiting', onWaiting);
      media.removeEventListener('canplay', onReady);
      media.removeEventListener('playing', onReady);
    };
  }, [media]);
  const phase = playbackPhase(snapshot, source, resolving, transcoded);
  const failed = ['decodeError', 'networkError', 'downloadError'].includes(phase);
  return <div className={`media-buffer-status${failed ? ' has-error' : ''}${resolving ? ' is-resolving' : ''}`}>
    {resolving && !failed && phase !== 'downloadPaused' && <span className="spinner spinner-lg" aria-hidden="true" />}
    {snapshot.attached && <span className="media-buffer-ahead" title={t('player.buffer.hint')}>{t('player.buffer.available')} {Math.floor(ahead)} {t('player.buffer.seconds')}</span>}
    <span className="media-buffer-phase" role="status" aria-live="polite">{t(`player.phase.${phase}`)}</span>
    {source && source.progress < 1 && <span className="media-buffer-source" title={t('player.buffer.sourceHint')}>
      {t('player.buffer.download')}: {Math.max(0, source.downSpeedBps / 1024).toFixed(0)} KB/s · {t('player.buffer.peers')}: {source.peers}
    </span>}
  </div>;
}
