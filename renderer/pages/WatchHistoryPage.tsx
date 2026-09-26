import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Icon } from '../components/Icon';
import { StreamPlayerModal } from '../components/StreamPlayerModal';
import { useConfirm } from '../components/ConfirmDialog';
import { fmtTime } from '../components/PlayerControls';
import { useTranslation } from '../utils/i18nContext';
import { watchEntries, pendingWatchPositions, subscribeWatchHistory, migrateWatchHistory, changeWatch, clearWatchHistory } from '../utils/watchHistory';
import { watchKey, resumablePosition, type WatchEntry } from '../../shared/watch-history';
import type { Download } from '../../shared/types';
import type { HistoryPlaybackFile } from '../../shared/history-playback';
import './WatchHistoryPage.css';

interface Availability { download: Download; files: HistoryPlaybackFile[] }
export default function WatchHistoryPage() {
  const { t, language } = useTranslation(), { confirm } = useConfirm();
  const [entries, setEntries] = useState(watchEntries);
  const [pending, setPending] = useState(pendingWatchPositions);
  const [availability, setAvailability] = useState<Record<string, Availability>>({});
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<'continue' | 'all'>('continue');
  const [player, setPlayer] = useState<{ id: string; title: string; path: string } | null>(null);
  useEffect(() => subscribeWatchHistory(() => { setEntries(watchEntries()); setPending(pendingWatchPositions()); }), []);
  useEffect(() => {
    let disposed = false, running = false;
    const refresh = async () => {
      if (running) return; running = true;
      try {
        const downloads = await window.api.getDownloads();
        await migrateWatchHistory(downloads, window.api.historyPlayback.files);
        const relevant = downloads.filter(d => d.status !== 'removed' && watchEntries().some(e => e.identity === (d.infoHash || d.id)));
        const results = await Promise.all(relevant.map(async download => ({ download, files: await window.api.historyPlayback.files(download.id).catch(() => []) })));
        if (!disposed) { setAvailability(Object.fromEntries(results.map(a => [a.download.infoHash || a.download.id, a]))); setFailed(false); }
      } catch { if (!disposed) setFailed(true); }
      finally { running = false; if (!disposed) setChecking(false); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 10000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  const resolve = (entry: WatchEntry, path = entry.path) => {
    const a = availability[entry.identity], file = a?.files.find(f => (f.path || f.name).replace(/\\/g, '/') === path.replace(/\\/g, '/'));
    return { a, file, playable: file?.availability === 'local' || file?.availability === 'stream' };
  };
  const open = (entry: WatchEntry, path = entry.path) => {
    const { a, playable } = resolve(entry, path);
    if (!a || !playable) { toast.error(t('history.unavailable')); return; }
    setPlayer({ id: a.download.id, title: a.download.name, path });
  };
  const closePlayer = useCallback(() => setPlayer(null), []);
  const visible = entries.filter(e => view === 'all' || !e.completed);
  return <div className="watch-history-page">
    <header className="watch-history-header">
      <div><h1><Icon name="film" size={22} />{t('history.title')}</h1><p>{t('history.description')}</p></div>
      <button className="btn btn-secondary" disabled={!entries.length && !pending} onClick={async () => {
        if (await confirm({ message: t('history.clearConfirm'), danger: true })) clearWatchHistory();
      }}><Icon name="trash" size={14} />{t('history.clear')}</button>
    </header>
    <div className="watch-history-tabs" role="tablist" aria-label={t('history.title')}>
      {(['continue', 'all'] as const).map(id => <button key={id} role="tab" aria-selected={view === id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>
        {t(id === 'all' ? 'history.all' : 'history.continue')} <span>{entries.filter(e => id === 'all' || !e.completed).length}</span>
      </button>)}
    </div>
    {failed && <p role="alert">{t('history.checkFailed')}</p>}
    {!!pending && <p className="watch-history-unavailable">{t('history.pending')} {pending}</p>}
    {!visible.length && <div className="watch-history-empty"><Icon name="film" size={40} /><h2>{t('history.empty')}</h2><p>{t('history.emptyHint')}</p></div>}
    <div className="watch-history-grid">
      {visible.map(entry => {
        const { a, file, playable } = resolve(entry);
        const next = entry.nextPath ? resolve(entry, entry.nextPath) : null;
        const percent = entry.completed ? 100 : entry.duration ? Math.round(100 * entry.position / entry.duration) : null;
        return <article className="watch-history-card" key={watchKey(entry)}>
          <div className="watch-history-card-top"><span className="watch-history-icon"><Icon name="film" size={25} /></span><div>
            <h2 title={a?.download.name || entry.title}>{a?.download.name || entry.title}</h2><p title={entry.path}>{entry.path.split('/').pop()}</p>
          </div><button className="btn btn-ghost" title={t('history.remove')} aria-label={t('history.remove')} onClick={() => changeWatch(entry, 'remove')}><Icon name="x" size={16} /></button></div>
          <p className="watch-history-path" title={entry.path}>{entry.path}</p>
          <div className="watch-history-progress" role="progressbar" aria-label={t('history.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}><span style={{ width: `${percent ?? 0}%` }} /></div>
          <div className="watch-history-meta"><span>{entry.completed ? t('history.watched') : `${fmtTime(entry.position)}${entry.duration ? ' / ' + fmtTime(entry.duration) : ''}`}</span>
            <time dateTime={new Date(entry.lastOpened).toISOString()}>{new Date(entry.lastOpened).toLocaleDateString(language)}</time></div>
          {!playable && <p className="watch-history-unavailable">{checking ? t('history.checking') : file?.availability === 'paused' ? t('history.paused') : t('history.unavailable')}</p>}
          <div className="watch-history-actions">
            <button className="btn btn-primary" disabled={!playable} onClick={() => open(entry)}><Icon name="play" size={14} />{t(entry.completed ? 'history.replay' : 'history.resume')}</button>
            {entry.nextPath && <button className="btn btn-secondary" disabled={!next?.playable} onClick={() => open(entry, entry.nextPath)}>{t('history.next')}</button>}
          </div>
          <div className="watch-history-secondary">
            <button onClick={() => { changeWatch(entry, 'start'); if (playable) open(entry); }}>{t('history.start')}</button>
            {!entry.completed && <button onClick={() => changeWatch(entry, 'watched')}>{t('history.markWatched')}</button>}
          </div>
        </article>;
      })}
    </div>
    {player && <StreamPlayerModal downloadId={player.id} downloadName={player.title} initialFilePath={player.path} historyPlayback onClose={closePlayer} />}
  </div>;
}
