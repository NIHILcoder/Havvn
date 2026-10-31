import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Icon } from '../components/Icon';
import { Button } from '../components/Button';
import { StreamPlayerModal } from '../components/LazyStreamPlayer';
import { ExternalPlayerModal } from '../components/ExternalPlayerModal';
import { useConfirm } from '../components/ConfirmDialog';
import { fmtTime } from '../components/PlayerControls';
import { useTranslation } from '../utils/i18nContext';
import { watchEntries, pendingWatchPositions, subscribeWatchHistory, migrateWatchHistory, changeWatch, clearWatchHistory } from '../utils/watchHistory';
import { watchKey, resumablePosition, type WatchEntry } from '../../shared/watch-history';
import { groupMediaLibrary, inLibraryView, libraryAvailability, libraryKey, mergeMediaLibrary, type MediaLibraryItem, type MediaLibrarySource, type MediaLibraryView } from '../../shared/media-library';
import { readMediaLibrary, rememberMediaLibrary, classifyLibraryItem, scanMediaLibrary, subscribeMediaLibrary } from '../utils/mediaLibrary';
import { useDownloads } from '../state/downloads';
import { MediaLibraryEditor } from './MediaLibraryEditor';
import type { Download } from '../../shared/types';
import './WatchHistoryPage.css';
import { MediaRelocationModal } from '../components/MediaRelocationModal';
import type { MediaRelocationView } from '../../shared/media-relocation';

export default function WatchHistoryPage() {
  const { t, language } = useTranslation(), { confirm } = useConfirm();
  const [entries, setEntries] = useState(watchEntries), [pending, setPending] = useState(pendingWatchPositions);
  const [library, setLibrary] = useState(readMediaLibrary), [storageFailed, setStorageFailed] = useState(false);
  const [downloads, setDownloads] = useState<Download[]>([]), [sources, setSources] = useState<MediaLibrarySource[]>([]);
  const [checking, setChecking] = useState(true), [failed, setFailed] = useState(false), [limited, setLimited] = useState(false);
  const [nextOffset, setNextOffset] = useState(0), [totalSources, setTotalSources] = useState(0), [pageOffset, setPageOffset] = useState(0);
  const [view, setView] = useState<MediaLibraryView>('continue'), [query, setQuery] = useState('');
  const [editing, setEditing] = useState<MediaLibraryItem | null>(null), [opening, setOpening] = useState('');
  const [player, setPlayer] = useState<{ id: string; title: string; path: string; identity: string } | null>(null);
  const [relocating, setRelocating] = useState<MediaLibraryItem | null>(null), [relocations, setRelocations] = useState<MediaRelocationView[]>([]);
  const [external, setExternal] = useState<{ id: string; path: string; position: number } | null>(null);
  const liveDownloads = useDownloads(state => state.downloads), openIntent = useRef(0);
  useEffect(() => () => { openIntent.current++; }, []);
  useEffect(() => subscribeWatchHistory(() => { setEntries(watchEntries()); setPending(pendingWatchPositions()); }), []);
  useEffect(() => subscribeMediaLibrary(() => setLibrary(readMediaLibrary())), []);
  useEffect(() => {
    let disposed = false, running = false;
    const refresh = async () => {
      if (running || document.hidden) return; running = true;
      try {
        const [current, bindings] = await Promise.all([window.api.getDownloads(), (window.api.historyPlayback.relocations?.() ?? Promise.resolve([])).catch(() => [])]);
        if (disposed) return;
        setRelocations(bindings);
        await migrateWatchHistory(current, window.api.historyPlayback.files);
        const scan = await scanMediaLibrary(current, watchEntries(), window.api.historyPlayback.libraryFiles, pageOffset, () => disposed);
        const fresh = await window.api.getDownloads();
        if (disposed) return;
        const valid = scan.sources.filter(source => fresh.some(d => d.id === source.download.id && d.status !== 'removed' && d.status === source.download.status && d.savePath === source.download.savePath && (d.infoHash || d.id) === (source.download.infoHash || source.download.id)));
        setStorageFailed(!rememberMediaLibrary(valid, watchEntries())); setLibrary(readMediaLibrary());
        setDownloads(fresh); setSources(valid); setFailed(scan.failures > 0);
        setLimited(scan.limited); setNextOffset(scan.nextOffset); setTotalSources(scan.totalSources);
      } catch { if (!disposed) { setFailed(true); setSources([]); } }
      finally { running = false; if (!disposed) setChecking(false); }
    };
    setChecking(true); setSources([]); void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [liveDownloads, pageOffset]);
  const items = useMemo(() => mergeMediaLibrary(library.items, sources, entries), [library.items, sources, entries]);
  const history = useMemo(() => new Map(entries.map(entry => [watchKey(entry), entry])), [entries]);
  const visible = items.filter(item => inLibraryView(history.get(libraryKey(item)), view) &&
    `${(item.manual ?? item.inferred).title} ${item.path} ${item.title}`.toLowerCase().includes(query.trim().toLowerCase()));
  const virtualWatch = (item: MediaLibraryItem): WatchEntry => history.get(libraryKey(item)) ?? { identity: item.identity, downloadId: item.downloadId, title: item.title, path: item.path, fileIndex: item.fileIndex,
    position: 0, duration: null, lastOpened: Date.now(), updatedAt: Date.now(), completed: false };
  const open = async (item: MediaLibraryItem, path = item.path, outside = false) => {
    const intent = ++openIntent.current; setOpening(libraryKey(item));
    try {
      const bindings = await (window.api.historyPlayback.relocations?.() ?? Promise.resolve([]));
      if (intent !== openIntent.current) return;
      setRelocations(bindings);
      const rebound = bindings.find(row => row.available && row.target.identity === item.identity && row.target.path === path);
      if (rebound) {
        if (intent !== openIntent.current) return;
        if (outside) setExternal({ id: rebound.target.downloadId, path, position: resumablePosition(history.get(libraryKey(item))) });
        else setPlayer({ id: rebound.target.downloadId, title: item.title, path, identity: item.identity });
        return;
      }
      const current = await window.api.getDownloads(), download = current.find(d => d.status !== 'removed' && (d.infoHash || d.id) === item.identity);
      const files = download ? await window.api.historyPlayback.files(download.id) : [];
      const file = files.find(file => (file.path || file.name).replace(/\\/g, '/') === path);
      if (intent !== openIntent.current) return;
      if (!download || !file || outside && file.availability !== 'local' || !outside && file.availability !== 'local' && file.availability !== 'stream') {
        setDownloads(current); setSources([]); toast.error(t('history.unavailable')); return;
      }
      if (outside) setExternal({ id: download.id, path, position: resumablePosition(history.get(libraryKey(item))) });
      else setPlayer({ id: download.id, title: download.name, path, identity: item.identity });
    } catch { if (intent === openIntent.current) toast.error(t('history.unavailable')); }
    finally { if (intent === openIntent.current) setOpening(''); }
  };
  const closePlayer = useCallback(() => setPlayer(null), []);
  return <div className="watch-history-page">
    <header className="watch-history-header">
      <div><h1><Icon name="film" size={22} />{t('library.title')}</h1><p>{t('library.description')}</p></div>
      <Button variant="secondary" disabled={!entries.length && !pending} onClick={async () => {
        if (await confirm({ message: t('history.clearConfirm'), danger: true })) clearWatchHistory();
      }}><Icon name="trash" size={14} />{t('history.clear')}</Button>
    </header>
    <div className="watch-history-tabs" role="tablist" aria-label={t('library.title')}>
      {(['continue', 'all', 'watching', 'completed'] as const).map(id => <button key={id} type="button" data-library-view={id} role="tab" aria-selected={view === id} className={view === id ? 'active' : ''} onClick={() => { setView(id); setPageOffset(0); }}>
        {t(`library.view.${id}`)} <span>{items.filter(item => inLibraryView(history.get(libraryKey(item)), id)).length}</span>
      </button>)}
    </div>
    <div className="media-library-search"><input type="search" aria-label={t('library.search')} placeholder={t('library.search')} value={query} onChange={event => setQuery(event.target.value)} />
      {nextOffset > 0 && nextOffset < totalSources && <Button variant="secondary" disabled={checking} onClick={() => setPageOffset(nextOffset)}>{t('library.moreSources')}</Button>}
    </div>
    {(library.failed || storageFailed) && <p className="watch-history-unavailable" role="alert">{t('library.storageFailed')}</p>}
    {failed && <p role="alert">{t('history.checkFailed')}</p>}
    {limited && <p className="watch-history-unavailable">{t('library.limit')}</p>}
    {!!pending && <p className="watch-history-unavailable">{t('history.pending')} {pending}</p>}
    {!visible.length && <div className="watch-history-empty"><Icon name="film" size={40} /><h2>{t('history.empty')}</h2><p>{t(view === 'all' ? 'library.empty' : 'library.emptyView')}</p></div>}
    {groupMediaLibrary(visible).map(group => <section key={group.key} className="media-library-group">
      {group.classification && <h2>{group.classification.title}{group.classification.season !== undefined ? ` · ${t('library.season')} ${group.classification.season}` : ''}</h2>}
      <div className="watch-history-grid">{group.items.map(item => {
        const key = libraryKey(item), entry = history.get(key), classification = item.manual ?? item.inferred;
        const original = libraryAvailability(item, downloads, sources), rebound = relocations.find(row => row.available && row.target.identity === item.identity && row.target.path === item.path);
        const state = rebound ? { ...original, state: 'ready' as const, playable: true, file: { name: item.path.split('/').at(-1)!, path: item.path, index: item.fileIndex, length: rebound.target.length, downloaded: rebound.target.length, progress: 1, availability: 'local' as const } } : original;
        const percent = entry?.completed ? 100 : entry?.duration ? Math.round(100 * entry.position / entry.duration) : null;
        return <article className="watch-history-card" key={key} data-media-key={key}>
          <div className="watch-history-card-top"><span className="watch-history-icon"><Icon name="film" size={25} /></span><div>
            <h2 title={classification.title}>{classification.title}</h2><p title={item.path}>{item.path.split('/').pop()}</p>
          </div>{entry && <button type="button" className="btn btn-ghost" title={t('history.remove')} aria-label={t('history.remove')} onClick={() => changeWatch(entry, 'remove')}><Icon name="x" size={16} /></button>}</div>
          <p className="watch-history-path" title={item.path}>{item.path}</p>
          <p className="media-library-classification">{t(`library.kind.${classification.kind}`)}{classification.episode !== undefined ? ` · ${t('library.episode')} ${classification.episode}` : ''}{item.manual ? ` · ${t('library.manual')}` : ''}</p>
          <div className="watch-history-progress" role="progressbar" aria-label={t('history.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}><span style={{ width: `${percent ?? 0}%` }} /></div>
          <div className="watch-history-meta"><span>{entry?.completed ? t('history.watched') : entry ? `${fmtTime(entry.position)}${entry.duration ? ' / ' + fmtTime(entry.duration) : ''}` : t('library.notStarted')}</span>
            {entry && <time dateTime={new Date(entry.lastOpened).toISOString()}>{new Date(entry.lastOpened).toLocaleDateString(language)}</time>}</div>
          <p className="watch-history-unavailable" data-media-availability={state.state}>{checking ? t('history.checking') : t(`library.availability.${state.state}`)}</p>
          <div className="watch-history-actions">
            <Button variant="secondary" disabled={state.file?.availability !== 'local' || !!opening} title={t('external.title')} onClick={() => { void open(item, item.path, true); }}><Icon name="external-link" size={14} />{t('external.short')}</Button>
            <Button variant="primary" disabled={!state.playable && (state.state !== 'unverified' || !state.download) || !!opening} onClick={() => { void open(item); }}><Icon name="play" size={14} />{t(state.state === 'unverified' ? 'library.checkOpen' : entry?.completed ? 'history.replay' : 'history.resume')}</Button>
            {entry?.nextPath && <Button variant="secondary" disabled={!!opening} onClick={() => { void open(item, entry.nextPath); }}>{t('history.next')}</Button>}
          </div>
          <div className="watch-history-secondary">
            <button type="button" onClick={() => { changeWatch(virtualWatch(item), 'start'); if (state.playable) void open(item); }}>{t('history.start')}</button>
            {!entry?.completed && <button type="button" onClick={() => changeWatch(virtualWatch(item), 'watched')}>{t('history.markWatched')}</button>}
            <button type="button" onClick={() => setEditing(item)}>{t('library.edit')}</button>
            {(state.state === 'missing' || state.state === 'stopped' || state.state === 'unverified' || rebound) && <button type="button" data-relocate-media onClick={() => setRelocating(item)}>{t('library.relocate.title')}</button>}
          </div>
        </article>;
      })}</div>
    </section>)}
    {editing && <MediaLibraryEditor key={libraryKey(editing)} item={editing} onClose={() => setEditing(null)} onSave={value => classifyLibraryItem(editing, value)} />}
    {relocating && <MediaRelocationModal key={libraryKey(relocating)} target={relocating} onClose={() => setRelocating(null)} onLinked={value => { setRelocations(old => [...old.filter(row => row.target.identity !== value.target.identity || row.target.path !== value.target.path), value]); setPlayer({ id: value.target.downloadId, title: value.target.title, path: value.target.path, identity: value.target.identity }); setRelocating(null); }} />}
    {player && <StreamPlayerModal downloadId={player.id} downloadName={player.title} initialFilePath={player.path} historyIdentity={player.identity} historyPlayback onClose={closePlayer} />}
    {external && <ExternalPlayerModal downloadId={external.id} relativePath={external.path} position={external.position} onClose={() => setExternal(null)} />}
  </div>;
}
