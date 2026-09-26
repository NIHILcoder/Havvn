import React, { useEffect, useState } from 'react';
import { shouldPrefetchEpisode, type EpisodePrefetchState } from '../../shared/episode-prefetch';
import { bufferedSecondsAhead, readBufferedRanges } from '../../shared/playback-buffer';
import { useTranslation } from '../utils/i18nContext';
import './EpisodePrefetchControl.css';

const KEY = 'havvn.player.episodePrefetch.v1';
interface Settings { enabled: boolean; allowExcluded: boolean; budgetMiB: number }
function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    return { enabled: saved?.enabled === true, allowExcluded: saved?.allowExcluded === true,
      budgetMiB: [16, 32, 64].includes(saved?.budgetMiB) ? saved.budgetMiB : 64 };
  } catch { return { enabled: false, allowExcluded: false, budgetMiB: 64 }; }
}
interface Props { media: HTMLMediaElement | null; downloadId: string; currentFile: number; nextFile: number | null; nextName?: string }

export function EpisodePrefetchControl({ media, downloadId, currentFile, nextFile, nextName }: Props) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(loadSettings);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [state, setState] = useState<EpisodePrefetchState | 'waiting' | 'error'>('waiting');
  useEffect(() => {
    let disposed = false;
    void window.api.getEpisodePrefetchSupport().then(result => { if (!disposed) setSupported(result.supported); })
      .catch(() => { if (!disposed) setState('error'); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* optional storage */ } }, [settings]);
  useEffect(() => {
    if (!media || !supported || !settings.enabled || nextFile === null) { setState('waiting'); return; }
    let disposed = false;
    let pending = false;
    let stalled = media.readyState < 3;
    const lease = crypto.randomUUID();
    const stop = () => window.api.stopEpisodePrefetch(downloadId, lease).catch(() => {});
    const eligible = () => !stalled && !media.error && !media.ended && shouldPrefetchEpisode({ enabled: settings.enabled, paused: media.paused, seeking: media.seeking,
        readyState: media.readyState, time: media.currentTime, duration: media.duration,
        bufferSeconds: bufferedSecondsAhead(readBufferedRanges(media.buffered), media.currentTime) });
    const tick = async () => {
      if (!eligible()) { void stop(); if (!disposed) setState('waiting'); return; }
      if (pending || disposed) return;
      pending = true;
      try {
        const result = await window.api.prefetchEpisode(downloadId, { currentFile, nextFile,
          budgetBytes: settings.budgetMiB * 1024 * 1024, allowExcluded: settings.allowExcluded, lease });
        if (disposed || !eligible()) { await stop(); }
        else setState(result.state);
      } catch { if (!disposed) setState('error'); await stop(); }
      finally { pending = false; }
    };
    const update = () => { void tick(); };
    const onWaiting = () => { stalled = true; update(); };
    const onReady = () => { stalled = false; update(); };
    const events = ['pause', 'seeking', 'seeked', 'ended', 'error'];
    for (const event of events) media.addEventListener(event, update);
    media.addEventListener('waiting', onWaiting);
    media.addEventListener('playing', onReady);
    media.addEventListener('canplay', onReady);
    const timer = setInterval(update, 1000);
    update();
    return () => { disposed = true; clearInterval(timer); for (const event of events) media.removeEventListener(event, update);
      media.removeEventListener('waiting', onWaiting); media.removeEventListener('playing', onReady); media.removeEventListener('canplay', onReady); void stop(); };
  }, [media, supported, settings, downloadId, currentFile, nextFile]);
  const status = supported === false ? 'unsupported' : !settings.enabled ? 'off' : nextFile === null ? 'last' : state;
  return <details className="episode-prefetch" onToggle={event => {
    if (event.currentTarget.open) { const other = event.currentTarget.parentElement?.querySelector<HTMLDetailsElement>('.player-preferences'); if (other) other.open = false; }
  }}>
    <summary>{t('player.prefetch.title')}<span role="status">{t(`player.prefetch.${status}`)}</span></summary>
    <div className="episode-prefetch-fields">
      <label><input type="checkbox" disabled={supported !== true} checked={supported === true && settings.enabled}
        onChange={event => setSettings(previous => ({ ...previous, enabled: event.target.checked }))} />{t('player.prefetch.enable')}</label>
      <label>{t('player.prefetch.budget')}<select value={settings.budgetMiB} disabled={supported !== true} onChange={event => setSettings(previous => ({ ...previous, budgetMiB: Number(event.target.value) }))}>
        {[16, 32, 64].map(size => <option key={size} value={size}>{size} MiB</option>)}
      </select></label>
      <label><input type="checkbox" disabled={supported !== true || !settings.enabled} checked={settings.allowExcluded}
        onChange={event => setSettings(previous => ({ ...previous, allowExcluded: event.target.checked }))} />{t('player.prefetch.allowExcluded')}</label>
    </div>
    {nextName && <p className="episode-prefetch-next" title={nextName}>{t('player.prefetch.next')}: {nextName}</p>}
    <p>{t(supported === false ? 'player.prefetch.nativeHint' : 'player.prefetch.hint')}</p>
  </details>;
}
