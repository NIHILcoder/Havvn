import React, { useEffect, useState } from 'react';
import { shouldPrefetchEpisode, type EpisodePrefetchState } from '../../shared/episode-prefetch';
import { bufferedSecondsAhead, readBufferedRanges } from '../../shared/playback-buffer';
import { useTranslation } from '../utils/i18nContext';
import { Select } from './Select';
import { Toggle } from './Toggle';
import { useResourceEconomy } from '../utils/resource-mode';
import { useEngineCapabilities } from '../utils/useEngineCapabilities';
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
  const economy = useResourceEconomy();
  const [settings, setSettings] = useState(loadSettings);
  const { capabilities, failed } = useEngineCapabilities();
  const supported = capabilities?.features.boundedEpisodePrefetch.supported;
  const [state, setState] = useState<EpisodePrefetchState | 'waiting' | 'error'>('waiting');
  useEffect(() => { if (supported === true) { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* optional storage */ } } }, [settings, supported]);
  useEffect(() => {
    if (economy || !media || !supported || !settings.enabled || nextFile === null) { setState('waiting'); return; }
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
  }, [media, supported, settings, downloadId, currentFile, nextFile, economy]);
  const status = supported === undefined ? failed ? 'unknown' : 'checking' : supported === false ? 'unsupported' : !settings.enabled ? 'off' : nextFile === null ? 'last' : state;
  return <details className="episode-prefetch" onToggle={event => {
    if (event.currentTarget.open) { const other = event.currentTarget.parentElement?.querySelector<HTMLDetailsElement>('.player-preferences'); if (other) other.open = false; }
  }}>
    <summary>{t('player.prefetch.title')}<span role="status">{economy && settings.enabled && nextFile !== null && supported === true ? t('resources.prefetchPaused') : t(`player.prefetch.${status}`)}</span></summary>
    {supported === true && <div className="episode-prefetch-fields">
      <Toggle disabled={supported !== true} checked={settings.enabled} label={t('player.prefetch.enable')}
        onChange={enabled => setSettings(previous => ({ ...previous, enabled }))} />
      <label>{t('player.prefetch.budget')}<Select value={String(settings.budgetMiB)} disabled={supported !== true}
        ariaLabel={t('player.prefetch.budget')} onChange={value => setSettings(previous => ({ ...previous, budgetMiB: Number(value) }))}
        options={[16, 32, 64].map(size => ({ value: String(size), label: `${size} MiB` }))} /></label>
      <Toggle disabled={supported !== true || !settings.enabled} checked={settings.allowExcluded} label={t('player.prefetch.allowExcluded')}
        onChange={allowExcluded => setSettings(previous => ({ ...previous, allowExcluded }))} />
    </div>}
    {nextName && <p className="episode-prefetch-next" title={nextName}>{t('player.prefetch.next')}: {nextName}</p>}
    <p>{t(supported === false ? 'player.prefetch.nativeHint' : supported === undefined ? 'engineFeatures.unknown' : 'player.prefetch.hint')}</p>
  </details>;
}
