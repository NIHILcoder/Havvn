/**
 * Search torrents from the moment of adding one.
 *
 * The search page is a page: to use it you leave whatever you were doing, search
 * there, and the result lands in Downloads. But the moment you actually want to
 * search is the moment you press "Add" — so this puts a compact search right
 * there.
 *
 * Deliberately not a copy of the search page. It reuses the same IPC flow and
 * the same deduplication, and shows the best-seeded results with one action;
 * sorting, filters, chips and per-row menus stay on the page that has room for
 * them.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AddDownloadRequest } from '../../shared/types';
import { MergedResult, mergeResults } from '../../shared/search-dedupe';
import { Button } from './Button';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { CategorySelect } from './CategorySelect';
import { useTranslation } from '../utils/i18nContext';
import './TorrentSearchModal.css';

/** Rows shown at once — this is a shortcut, not a browser. */
const MAX_ROWS = 40;

const formatBytes = (bytes: number): string => {
  if (!bytes) return '—';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const rowKey = (r: MergedResult): string =>
  r.infoHash || r.magnetUri || r.torrentUrl || `${r.title}:${r.size}`;

interface TorrentSearchModalProps {
  onClose: () => void;
  /** Add a torrent. Returns once the add has been accepted (or thrown). */
  onAdd: (request: AddDownloadRequest) => Promise<void>;
}

export const TorrentSearchModal: React.FC<TorrentSearchModalProps> = ({ onClose, onAdd }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<MergedResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [categoryId, setCategoryId] = useState('');

  const searchIdRef = useRef<string | null>(null);

  // One subscription; messages from a superseded search are dropped by id.
  useEffect(() => {
    return window.api.search.onProgress(progress => {
      if (progress.searchId !== searchIdRef.current) return;
      if (progress.results && progress.results.length > 0) {
        setRows(prev => mergeResults(prev, progress.results!));
      }
      if (progress.done) {
        searchIdRef.current = null;
        setLoading(false);
      }
    });
  }, []);

  // Abandon an in-flight search when the modal closes, so its providers stop
  // working on results nobody will see.
  useEffect(() => {
    return () => {
      if (searchIdRef.current) {
        window.api.search.cancel(searchIdRef.current).catch(() => { /* best effort */ });
      }
    };
  }, []);

  const runSearch = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    const term = query.trim();
    if (!term) return;

    if (searchIdRef.current) {
      window.api.search.cancel(searchIdRef.current).catch(() => { /* best effort */ });
    }

    setLoading(true);
    setSearched(true);
    setError(null);
    setRows([]);
    setAdded(new Set());

    try {
      const { searchId, providers } = await window.api.search.start(term);
      searchIdRef.current = searchId;
      if (providers.length === 0) {
        setLoading(false);
        setError(t('search.hint.desc'));
      }
    } catch (err: any) {
      setError(err?.message || t('search.failed'));
      setLoading(false);
    }
  }, [query, t]);

  const handleAdd = async (result: MergedResult) => {
    const key = rowKey(result);
    const uri = result.magnetUri || result.torrentUrl;
    if (!uri || pending) return;

    setPending(key);
    try {
      await onAdd({
        sourceType: result.magnetUri ? 'magnet' : 'torrent_file',
        sourceUri: uri,
        name: result.title,
        categoryId: categoryId || undefined,
      });
      setAdded(prev => new Set(prev).add(key));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  // Best-seeded first: with no sorting controls here, the order has to be the
  // one that puts the likely answer on top.
  const visible = [...rows].sort((a, b) => b.seeds - a.seeds).slice(0, MAX_ROWS);

  return (
    <Modal onClose={onClose} title={t('downloads.searchTorrents')} icon="search" size="lg">
      <form className="tsm-form" onSubmit={runSearch}>
        <div className="tsm-input-wrap">
          <Icon name="search" size={16} />
          <input
            type="text"
            className="tsm-input"
            placeholder={t('search.input')}
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <Button variant="primary" type="submit" loading={loading} disabled={!query.trim()}>
          {t('search.btn')}
        </Button>
      </form>

      <div className="tsm-options">
        <span className="tsm-options-label">{t('search.addTo')}</span>
        <CategorySelect value={categoryId} onChange={setCategoryId} className="tsm-category" />
      </div>

      {error && (
        <div className="tsm-error">
          <Icon name="alert-circle" size={14} />
          {error}
        </div>
      )}

      {searched && !loading && rows.length === 0 && !error && (
        <div className="tsm-empty">{t('search.noResults.title')}</div>
      )}

      {visible.length > 0 && (
        <div className="tsm-results">
          {visible.map(r => {
            const key = rowKey(r);
            return (
              <div key={key} className={`tsm-row ${added.has(key) ? 'added' : ''}`}>
                <div className="tsm-row-main">
                  <div className="tsm-title" title={r.title}>{r.title}</div>
                  <div className="tsm-meta">
                    <span>{formatBytes(r.size)}</span>
                    <span className="tsm-seeds">{r.seeds}</span>
                    <span className="tsm-provider">{r.indexers[0] || r.providers[0]}</span>
                  </div>
                </div>
                {added.has(key) ? (
                  <span className="tsm-added"><Icon name="check" size={14} /></span>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    loading={pending === key}
                    disabled={!!pending || (!r.magnetUri && !r.torrentUrl)}
                    onClick={() => handleAdd(r)}
                    icon={<Icon name="plus" size={13} />}
                  >
                    {t('downloads.addTorrent')}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
};
