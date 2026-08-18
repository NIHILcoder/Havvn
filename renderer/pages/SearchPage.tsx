/**
 * Search Page
 * Plugin-based torrent search using Jackett/Torznab/Custom providers.
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SearchProvider, PythonStatus, ProviderStat, SearchCategory, PluginManifest } from '../../shared/types';
import { MergedResult, mergeResults } from '../../shared/search-dedupe';
import {
  Button,
  Icon,
  EmptyState,
  CategorySelect,
  DropdownMenu,
  TorrentFileSelector,
  useConfirm,
} from '../components';
import { cleanError } from '../utils/format-helpers';
import { useTranslation } from '../utils/i18nContext';
import './SearchPage.css';

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return '—';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

/**
 * Relative age of a release in whole days, or null when the indexer didn't say.
 * Rendering is the caller's job — it holds the translated unit labels.
 */
const ageInDays = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86400000);
};

/**
 * Stable identity for a merged row. Rows are sorted and filtered, so the
 * position in the array can't be the key the way it was when the list was a
 * fixed dump of everything every provider returned.
 */
const rowKey = (r: MergedResult): string =>
  r.infoHash || r.magnetUri || r.torrentUrl || `${r.title}:${r.size}`;

/** Recent queries, kept per window like the other UI preferences. */
const HISTORY_KEY = 'searchHistory';
const HISTORY_MAX = 10;

const loadHistory = (): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((q): q is string => typeof q === 'string') : [];
  } catch {
    return [];
  }
};

const rememberQuery = (history: string[], query: string): string[] => {
  const next = [query, ...history.filter(q => q !== query)].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable — history is a convenience, not a feature.
  }
  return next;
};

type SortKey = 'seeds' | 'size' | 'date' | 'name';

/** Quality tags worth pulling out of a release title and showing as chips. */
const QUALITY_TAGS = /\b(2160p|1080p|720p|480p|4k|hdr|dolby\s?vision|dv|x265|h\.?265|hevc|x264|h\.?264|av1|remux|bluray|blu-ray|web-?dl|webrip|hdtv|dvdrip|cam)\b/gi;

const qualityChips = (title: string): string[] => {
  const found = title.match(QUALITY_TAGS);
  if (!found) return [];
  const seen = new Set<string>();
  const chips: string[] = [];
  for (const tag of found) {
    const key = tag.toLowerCase().replace(/[\s.]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    chips.push(tag.toUpperCase());
  }
  return chips.slice(0, 4);
};

const SearchPage: React.FC = () => {
  const { t } = useTranslation();
  const { confirm, alert } = useConfirm();
  /** Release age as a short label — needs `t`, so it lives with it. */
  const formatAge = useCallback((iso: string | undefined): string => {
    const days = ageInDays(iso);
    if (days === null) return '—';
    if (days === 0) return t('search.age.today');
    if (days < 30) return `${days}${t('search.age.days')}`;
    if (days < 365) return `${Math.floor(days / 30)}${t('search.age.months')}`;
    return `${Math.floor(days / 365)}${t('search.age.years')}`;
  }, [t]);

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [rows, setRows] = useState<MergedResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  // Where the Download button on a result row files the torrent, and whether it
  // starts. Kept for the whole result list rather than per row — the choice is
  // almost always the same for everything a single search turned up.
  const [addCategoryId, setAddCategoryId] = useState('');
  const [addPaused, setAddPaused] = useState(false);

  // In-flight search: providers report one at a time, so the id identifies which
  // run a progress message belongs to and lets a stale run be ignored.
  const searchIdRef = useRef<string | null>(null);
  const [providerStats, setProviderStats] = useState<ProviderStat[]>([]);

  // Result filtering and ordering — all client-side over what has arrived so far.
  const [sortKey, setSortKey] = useState<SortKey>('seeds');
  const [sortDesc, setSortDesc] = useState(true);
  const [refine, setRefine] = useState('');
  const [minSeeds, setMinSeeds] = useState(0);
  const [hideDead, setHideDead] = useState(false);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);

  // Files-before-adding preview, opened from a row's menu.
  const [previewTarget, setPreviewTarget] = useState<MergedResult | null>(null);

  const [history, setHistory] = useState<string[]>(loadHistory);

  // Categories the indexers actually support (t=caps), rather than a hardcoded
  // newznab list that means nothing to a custom or script provider.
  const [capsCategories, setCapsCategories] = useState<SearchCategory[]>([]);
  const scrollParentRef = useRef<HTMLDivElement>(null);

  const CATEGORIES = useMemo(() => {
    const all = { value: '', label: t('search.category.all') };
    if (capsCategories.length > 0) {
      return [all, ...capsCategories.map(c => ({ value: c.id, label: c.name }))];
    }
    // Nothing could answer caps — fall back to the standard newznab groups.
    return [
      all,
      { value: '2000', label: t('search.category.movies') },
      { value: '5000', label: t('search.category.tv') },
      { value: '3000', label: t('search.category.music') },
      { value: '4000', label: t('search.category.software') },
      { value: '6000', label: t('search.category.xxx') },
      { value: '8000', label: t('search.category.other') },
    ];
  }, [capsCategories, t]);

  // Providers tab state
  const [showProviders, setShowProviders] = useState(false);
  const [providers, setProviders] = useState<SearchProvider[]>([]);
  const [newProvider, setNewProvider] = useState({
    name: '', url: '', apiKey: '', username: '', password: '',
    type: 'jackett' as 'jackett' | 'torznab' | 'custom' | 'script', enabled: true
  });
  const [savingProvider, setSavingProvider] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);
  const [pythonStatus, setPythonStatus] = useState<PythonStatus | null>(null);
  const [checkingPython, setCheckingPython] = useState(false);
  // What the chosen script says about itself, when it says anything.
  const [manifest, setManifest] = useState<PluginManifest | null>(null);

  const checkPython = useCallback(async (force = false) => {
    setCheckingPython(true);
    try {
      setPythonStatus(await window.api.search.checkPython(force));
    } catch {
      setPythonStatus({ found: false });
    } finally {
      setCheckingPython(false);
    }
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const list = await window.api.search.getProviders();
      setProviders(list);
    } catch (err) {
      console.error('Failed to load providers:', err);
    }
  }, []);

  // Load providers on mount so the empty-state hint reflects whether any
  // provider is configured yet (no network — just reads the local store).
  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const hasEnabledProvider = providers.some(p => p.enabled);

  // Ask the indexers what they carry. Cached in main for an hour, so this costs
  // nothing on later mounts; failures just leave the fallback list in place.
  useEffect(() => {
    if (!hasEnabledProvider) return;
    let cancelled = false;
    window.api.search
      .getCategories()
      .then(list => { if (!cancelled) setCapsCategories(list); })
      .catch(() => { /* fallback categories stay */ });
    return () => { cancelled = true; };
  }, [hasEnabledProvider]);

  // One subscription for the page's lifetime; messages for a superseded search
  // are dropped by id. Providers push as they finish rather than the whole
  // search waiting on its slowest member.
  useEffect(() => {
    return window.api.search.onProgress(progress => {
      if (progress.searchId !== searchIdRef.current) return;

      if (progress.stat) {
        const stat = progress.stat;
        setProviderStats(prev => prev.map(s => (s.name === stat.name ? stat : s)));
      }
      if (progress.results && progress.results.length > 0) {
        // Merge into what has already arrived — the same torrent from three
        // indexers is one row, not three.
        setRows(prev => mergeResults(prev, progress.results!));
      }
      if (progress.done) {
        searchIdRef.current = null;
        setLoading(false);
      }
    });
  }, []);

  const runSearch = async (refresh: boolean) => {
    const term = query.trim();
    if (!term) return;

    // Supersede anything still running, so its results can't land in this list.
    if (searchIdRef.current) {
      window.api.search.cancel(searchIdRef.current).catch(() => { /* best effort */ });
    }

    setLoading(true);
    setError(null);
    setHasSearched(true);
    setRows([]);
    setAddedKeys(new Set());
    setProviderFilter(null);
    setProviderStats([]);
    setHistory(h => rememberQuery(h, term));

    try {
      const { searchId, providers: names } = await window.api.search.start(
        term,
        category || undefined,
        refresh
      );
      searchIdRef.current = searchId;
      // Seed a pending row per provider so the strip shows who is still out.
      setProviderStats(names.map(name => ({ name, count: 0, ms: 0, state: 'pending' as const })));
      if (names.length === 0) setLoading(false);
    } catch (err: any) {
      setError(err?.message || t('search.failed'));
      setLoading(false);
    }
  };

  const handleSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    runSearch(false);
  };

  const handleCancelSearch = () => {
    const id = searchIdRef.current;
    if (!id) return;
    window.api.search.cancel(id).catch(() => { /* best effort */ });
    searchIdRef.current = null;
    setLoading(false);
    setProviderStats(prev => prev.map(s => (s.state === 'pending' ? { ...s, state: 'failed', error: t('search.cancelled') } : s)));
  };

  // Abandon an in-flight search when the page goes away, so its providers (and
  // any python plugin among them) stop working on results nobody will see.
  useEffect(() => {
    return () => {
      if (searchIdRef.current) {
        window.api.search.cancel(searchIdRef.current).catch(() => { /* best effort */ });
      }
    };
  }, []);

  const handleDownload = async (result: MergedResult, selectedFiles?: number[]) => {
    const key = rowKey(result);
    if (downloading.has(key)) return;
    setDownloading(prev => new Set(prev).add(key));

    try {
      const uri = result.magnetUri || result.torrentUrl;
      if (!uri) throw new Error(t('search.noLink'));

      await window.api.addDownload({
        sourceType: result.magnetUri ? 'magnet' : 'torrent_file',
        sourceUri: uri,
        name: result.title,
        categoryId: addCategoryId || undefined,
        paused: addPaused || undefined,
        selectedFiles,
      });

      setAddedKeys(prev => new Set(prev).add(key));
    } catch (err) {
      await alert({ title: t('search.failedTitle'), message: `${t('search.failedToAdd')} ${cleanError(err)}` });
    } finally {
      setDownloading(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const handleCopyMagnet = async (result: MergedResult) => {
    const uri = result.magnetUri
      || (result.infoHash ? `magnet:?xt=urn:btih:${result.infoHash}&dn=${encodeURIComponent(result.title)}` : '');
    if (!uri) {
      await alert({ title: t('search.failedTitle'), message: t('search.noMagnet') });
      return;
    }
    await navigator.clipboard.writeText(uri);
  };

  /** Confirm out of the file picker: add with just the files that stayed ticked. */
  const handlePreviewConfirm = async (selectedIndices: number[]) => {
    const target = previewTarget;
    setPreviewTarget(null);
    if (target) await handleDownload(target, selectedIndices);
  };

  const rowMenuItems = (r: MergedResult) => {
    const items = [
      {
        key: 'files',
        label: t('search.row.selectFiles'),
        icon: <Icon name="list" size={14} />,
        onSelect: () => setPreviewTarget(r),
      },
      {
        key: 'magnet',
        label: t('search.row.copyMagnet'),
        icon: <Icon name="copy" size={14} />,
        onSelect: () => { handleCopyMagnet(r); },
      },
    ];
    // The details URL comes from the indexer, so check the scheme here rather
    // than trusting it: main's window-open handler only shells out http(s), but
    // nothing untrusted should reach window.open in the first place.
    if (r.detailsUrl && /^https?:\/\//i.test(r.detailsUrl)) {
      items.push({
        key: 'details',
        label: t('search.row.openPage'),
        icon: <Icon name="external-link" size={14} />,
        // Opening a new window is intercepted in main and handed to the OS
        // browser — the same path the About page's GitHub link takes.
        onSelect: () => { window.open(r.detailsUrl, '_blank', 'noopener,noreferrer'); },
      });
    }
    return items;
  };

  /** Everything the toolbar controls, applied to the rows collected so far. */
  const visibleRows = useMemo(() => {
    const needle = refine.trim().toLowerCase();
    const filtered = rows.filter(r => {
      if (needle && !r.title.toLowerCase().includes(needle)) return false;
      if (hideDead && r.seeds === 0) return false;
      if (minSeeds > 0 && r.seeds < minSeeds) return false;
      if (providerFilter && !r.providers.includes(providerFilter)) return false;
      return true;
    });

    const dir = sortDesc ? -1 : 1;
    return filtered.sort((a, b) => {
      switch (sortKey) {
        case 'size': return (a.size - b.size) * dir;
        case 'name': return a.title.localeCompare(b.title) * dir;
        case 'date': {
          const at = a.publishDate ? Date.parse(a.publishDate) : 0;
          const bt = b.publishDate ? Date.parse(b.publishDate) : 0;
          return ((at || 0) - (bt || 0)) * dir;
        }
        default: return (a.seeds - b.seeds) * dir;
      }
    });
  }, [rows, refine, hideDead, minSeeds, providerFilter, sortKey, sortDesc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDesc(d => !d);
    } else {
      setSortKey(key);
      // Seeds, size and date read best largest-first; names read A→Z.
      setSortDesc(key !== 'name');
    }
  };

  // Only the rows in view are mounted — a broad query across several indexers
  // easily runs to a few thousand.
  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 52,
    getItemKey: index => rowKey(visibleRows[index]),
    overscan: 10,
  });

  const handleAddProvider = async () => {
    if (!newProvider.name || !newProvider.url) return;
    setSavingProvider(true);
    try {
      await window.api.search.addProvider(newProvider);
      setNewProvider({ name: '', url: '', apiKey: '', username: '', password: '', type: 'jackett', enabled: true });
      await loadProviders();
    } catch (err: any) {
      await alert({ title: t('search.failedTitle'), message: `${t('search.failedToAddProvider')} ${err?.message}` });
    } finally {
      setSavingProvider(false);
    }
  };

  const handleDeleteProvider = async (id: string) => {
    if (!(await confirm({ message: t('search.provider.removeConfirm'), danger: true }))) return;
    try {
      await window.api.search.removeProvider(id);
      await loadProviders();
    } catch (err: any) {
      await alert({ title: t('search.failedTitle'), message: `${t('search.failedPrefix')} ${err?.message}` });
    }
  };

  const handleToggleProvider = async (id: string, enabled: boolean) => {
    try {
      await window.api.search.updateProvider(id, { enabled });
      await loadProviders();
    } catch (err: any) {
      await alert({ title: t('search.failedTitle'), message: `${t('search.failedPrefix')} ${err?.message}` });
    }
  };

  const handleBrowseScript = async () => {
    try {
      const res = await window.api.dialog.showOpenDialog({
        title: t('search.browse'),
        properties: ['openFile'],
        filters: [{ name: 'Python', extensions: ['py'] }],
      });
      if (!res.canceled && res.filePaths[0]) {
        const scriptPath = res.filePaths[0];
        setNewProvider(p => ({ ...p, url: scriptPath }));
        if (!pythonStatus) checkPython();

        // A plugin can describe itself; use it to fill the name and to say up
        // front which credentials it needs, instead of finding out when a
        // search fails.
        const found = await window.api.search.readManifest(scriptPath);
        setManifest(found);
        if (found?.name) setNewProvider(p => ({ ...p, name: p.name || found.name! }));
      }
    } catch (err) {
      console.error('Browse failed:', err);
    }
  };

  const handleTestProvider = async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const result = await window.api.search.testProvider(id);
      setTestResult({ id, ...result });
    } catch (err: any) {
      setTestResult({ id, success: false, message: err?.message || t('search.testFailed') });
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="search-page">
      <div className="page-header">
        <h1 className="page-title">
          <Icon name="search" size={22} />
          {t('search.title')}
        </h1>
        <button
          className={`tab-btn ${showProviders ? 'active' : ''}`}
          onClick={() => { setShowProviders(!showProviders); if (!showProviders) loadProviders(); }}
        >
          <Icon name="settings" size={16} />
          {t('search.providers')}
        </button>
      </div>

      {!showProviders ? (
        <div className="page-content">
          {/* Search form */}
          <form className="search-form" onSubmit={handleSearch}>
            <div className="search-input-row">
              <div className="search-input-wrap">
                <Icon name="search" size={18} className="search-icon-inside" />
                <input
                  type="text"
                  className="search-input"
                  placeholder={t('search.input')}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  list="search-history"
                  autoFocus
                />
                {/* Recent queries, offered by the input itself rather than a
                    dropdown of our own. */}
                <datalist id="search-history">
                  {history.map(q => <option key={q} value={q} />)}
                </datalist>
              </div>
              <select
                className="search-category"
                value={category}
                onChange={e => setCategory(e.target.value)}
              >
                {CATEGORIES.map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              {loading ? (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={handleCancelSearch}
                  icon={<Icon name="x" size={16} />}
                >
                  {t('search.cancel')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  type="submit"
                  disabled={!query.trim()}
                  icon={<Icon name="search" size={16} />}
                >
                  {t('search.btn')}
                </Button>
              )}
            </div>
          </form>

          {/* Who answered, who is still out, and who failed — a dead indexer
              used to be indistinguishable from "nothing found". */}
          {providerStats.length > 0 && (
            <div className="provider-strip">
              {providerStats.map(s => (
                <button
                  key={s.name}
                  type="button"
                  className={`provider-stat ${s.state} ${providerFilter === s.name ? 'filtered' : ''}`}
                  title={s.error || (s.state === 'ok' ? `${s.count} · ${s.ms}ms` : undefined)}
                  disabled={s.state !== 'ok' || s.count === 0}
                  onClick={() => setProviderFilter(f => (f === s.name ? null : s.name))}
                >
                  {s.state === 'pending' && <span className="spinner spinner-xs" />}
                  {s.state === 'ok' && <Icon name="check" size={12} />}
                  {s.state === 'failed' && <Icon name="alert-circle" size={12} />}
                  <span className="provider-stat-name">{s.name}</span>
                  {s.state === 'ok' && <span className="provider-stat-count">{s.count}</span>}
                </button>
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="search-error">
              <Icon name="alert-circle" size={16} />
              {error}
            </div>
          )}

          {/* Empty-state hint: differs depending on whether a provider is ready */}
          {!loading && !hasSearched && (
            <div className="search-hint">
              <Icon name={hasEnabledProvider ? 'search' : 'info'} size={40} />
              <h3>{hasEnabledProvider ? t('search.hint.ready.title') : t('search.hint.title')}</h3>
              <p>{hasEnabledProvider ? t('search.hint.ready.desc') : t('search.hint.desc')}</p>
              <Button
                variant={hasEnabledProvider ? 'ghost' : 'primary'}
                onClick={() => { setShowProviders(true); loadProviders(); }}
                icon={<Icon name="settings" size={16} />}
              >
                {hasEnabledProvider ? t('search.hint.ready.open') : t('search.hint.open')}
              </Button>
            </div>
          )}

          {/* Results */}
          {hasSearched && !loading && rows.length === 0 && !error && (
            <EmptyState icon="search" title={t('search.noResults.title')} description={t('search.noResults.desc')} />
          )}

          {rows.length > 0 && (
            <div className="search-results">
              <div className="search-results-header">
                <span className="results-count">
                  {visibleRows.length === rows.length
                    ? `${rows.length} ${t('search.results')}`
                    : `${visibleRows.length} / ${rows.length} ${t('search.results')}`}
                  {/* Repeating a query inside the cache window replays the last
                      answer; this asks the indexers again. */}
                  <button
                    type="button"
                    className="results-refresh"
                    title={t('search.refresh')}
                    disabled={loading}
                    onClick={() => runSearch(true)}
                  >
                    <Icon name="refresh-cw" size={13} />
                  </button>
                </span>
                {/* Governs what the Download button on every row below does. */}
                <div className="results-add-options">
                  <span className="add-options-label">{t('search.addTo')}</span>
                  <CategorySelect
                    value={addCategoryId}
                    onChange={setAddCategoryId}
                    className="add-category-select"
                  />
                  <button
                    type="button"
                    className={`add-paused-btn ${addPaused ? 'active' : ''}`}
                    role="switch"
                    aria-checked={addPaused}
                    title={t('search.addPausedHint')}
                    onClick={() => setAddPaused(p => !p)}
                  >
                    <Icon name="pause" size={13} />
                    {t('search.addPaused')}
                  </button>
                </div>
              </div>

              {/* Narrowing the list that arrived, without asking the indexers again. */}
              <div className="results-filters">
                <div className="refine-wrap">
                  <Icon name="filter" size={14} />
                  <input
                    type="text"
                    className="refine-input"
                    placeholder={t('search.refine')}
                    value={refine}
                    onChange={e => setRefine(e.target.value)}
                  />
                  {refine && (
                    <button type="button" className="refine-clear" onClick={() => setRefine('')}>
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </div>
                <label className="min-seeds">
                  {t('search.minSeeds')}
                  <input
                    type="number"
                    min="0"
                    className="min-seeds-input"
                    value={minSeeds || ''}
                    onChange={e => setMinSeeds(Math.max(0, parseInt(e.target.value) || 0))}
                  />
                </label>
                <button
                  type="button"
                  className={`filter-toggle ${hideDead ? 'active' : ''}`}
                  role="switch"
                  aria-checked={hideDead}
                  onClick={() => setHideDead(v => !v)}
                >
                  {t('search.hideDead')}
                </button>
                {providerFilter && (
                  <button type="button" className="filter-chip-clear" onClick={() => setProviderFilter(null)}>
                    <Icon name="x" size={12} /> {providerFilter}
                  </button>
                )}
              </div>

              <div className="results-table">
                <div className="results-thead">
                  <button type="button" className="results-th name-col sortable" onClick={() => toggleSort('name')}>
                    {t('table.name')}
                    {sortKey === 'name' && <Icon name={sortDesc ? 'chevron-down' : 'chevron-up'} size={12} />}
                  </button>
                  <button type="button" className="results-th size-col sortable" onClick={() => toggleSort('size')}>
                    {t('table.size')}
                    {sortKey === 'size' && <Icon name={sortDesc ? 'chevron-down' : 'chevron-up'} size={12} />}
                  </button>
                  <button type="button" className="results-th seeds-col sortable" onClick={() => toggleSort('seeds')}>
                    S/L
                    {sortKey === 'seeds' && <Icon name={sortDesc ? 'chevron-down' : 'chevron-up'} size={12} />}
                  </button>
                  <button type="button" className="results-th age-col sortable" onClick={() => toggleSort('date')}>
                    {t('search.col.age')}
                    {sortKey === 'date' && <Icon name={sortDesc ? 'chevron-down' : 'chevron-up'} size={12} />}
                  </button>
                  <div className="results-th provider-col">{t('search.col.provider')}</div>
                  <div className="results-th action-col"></div>
                </div>

                {/* Only the rows in view are mounted. */}
                <div className="results-scroll" ref={scrollParentRef}>
                  <div className="results-virtual" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                    {rowVirtualizer.getVirtualItems().map(virtualRow => {
                      const r = visibleRows[virtualRow.index];
                      const key = rowKey(r);
                      const chips = qualityChips(r.title);
                      return (
                        <div
                          key={virtualRow.key}
                          className={`results-row ${addedKeys.has(key) ? 'added' : ''}`}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          <div className="results-td name-col">
                            <span className="result-title" title={r.title}>{r.title}</span>
                            <span className="result-tags">
                              {r.freeleech && <span className="result-chip freeleech">FL</span>}
                              {chips.map(chip => (
                                <span key={chip} className="result-chip">{chip}</span>
                              ))}
                              {r.category && <span className="result-category">{r.category}</span>}
                            </span>
                          </div>
                          <div className="results-td size-col">{formatBytes(r.size)}</div>
                          <div className="results-td seeds-col">
                            <span className={`seeds ${r.seeds === 0 ? 'dead' : ''}`}>{r.seeds}</span>
                            <span className="sep">/</span>
                            <span className="leechers">{r.leechers}</span>
                          </div>
                          <div className="results-td age-col">{formatAge(r.publishDate)}</div>
                          <div className="results-td provider-col">
                            {/* The indexer behind an aggregator is what actually
                                identifies the row; the provider is the fallback. */}
                            <span className="provider-badge" title={r.providers.join(', ')}>
                              {r.indexers[0] || r.providers[0]}
                            </span>
                            {r.sourceCount > 1 && (
                              <span className="dupe-badge" title={[...r.providers, ...r.indexers].join(', ')}>
                                +{r.sourceCount - 1}
                              </span>
                            )}
                          </div>
                          <div className="results-td action-col">
                            {addedKeys.has(key) ? (
                              <span className="added-badge">
                                <Icon name="check" size={14} /> {t('search.added')}
                              </span>
                            ) : (
                              <>
                                <Button
                                  variant="primary"
                                  size="sm"
                                  loading={downloading.has(key)}
                                  disabled={downloading.has(key) || (!r.magnetUri && !r.torrentUrl)}
                                  onClick={() => handleDownload(r)}
                                  icon={<Icon name="download" size={14} />}
                                >
                                  {t('search.download')}
                                </Button>
                                <DropdownMenu
                                  items={rowMenuItems(r)}
                                  portal
                                  renderTrigger={({ toggle }) => (
                                    <button type="button" className="row-menu-btn" onClick={toggle} title={t('search.row.more')}>
                                      <Icon name="more-horizontal" size={14} />
                                    </button>
                                  )}
                                />
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Pick files before adding — the same selector the add dialog uses. */}
          {previewTarget && (
            <TorrentFileSelector
              magnetUri={previewTarget.magnetUri}
              torrentPath={previewTarget.magnetUri ? undefined : previewTarget.torrentUrl}
              onConfirm={handlePreviewConfirm}
              onCancel={() => setPreviewTarget(null)}
            />
          )}
        </div>
      ) : (
        /* Providers settings panel */
        <div className="page-content providers-panel">
          <div className="providers-section">
            <h2>{t('search.providers.title')}</h2>
            <p className="providers-desc">{t('search.providers.desc')}</p>

            {/* Provider list */}
            {providers.length === 0 ? (
              <div className="providers-empty">{t('search.providers.empty')}</div>
            ) : (
              <div className="providers-list">
                {providers.map(p => (
                  <div key={p.id} className={`provider-card ${!p.enabled ? 'disabled' : ''}`}>
                    <div className="provider-info">
                      <div className="provider-name">{p.name}</div>
                      <div className="provider-url">{p.url}</div>
                      <span className={`provider-type-badge ${p.type}`}>{p.type}</span>
                    </div>
                    {testResult?.id === p.id && (
                      <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
                        <Icon name={testResult.success ? 'check-circle' : 'x-circle'} size={14} />
                        {testResult.message}
                      </div>
                    )}
                    <div className="provider-actions">
                      <button
                        className={`toggle-btn ${p.enabled ? 'on' : 'off'}`}
                        onClick={() => handleToggleProvider(p.id, !p.enabled)}
                        title={p.enabled ? t('search.disable') : t('search.enable')}
                      >
                        <Icon name={p.enabled ? 'eye' : 'eye-off'} size={14} />
                      </button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={testingId === p.id}
                        onClick={() => handleTestProvider(p.id)}
                        icon={<Icon name="zap" size={14} />}
                      >
                        {t('search.test')}
                      </Button>
                      {!p.builtIn && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteProvider(p.id)}
                          icon={<Icon name="trash" size={14} />}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Add new provider */}
            <div className="add-provider-form">
              <h3>{t('search.addProvider')}</h3>
              <div className="form-row">
                <input
                  type="text"
                  className="form-input"
                  placeholder={t('search.provider.name')}
                  value={newProvider.name}
                  onChange={e => setNewProvider(p => ({ ...p, name: e.target.value }))}
                />
                <select
                  className="form-select"
                  value={newProvider.type}
                  onChange={e => {
                    const type = e.target.value as typeof newProvider.type;
                    setNewProvider(p => ({ ...p, type }));
                    if (type === 'script' && !pythonStatus) checkPython();
                  }}
                >
                  <option value="jackett">Jackett</option>
                  <option value="torznab">Torznab (Prowlarr)</option>
                  <option value="custom">{t('search.type.custom')}</option>
                  <option value="script">{t('search.type.script')}</option>
                </select>
              </div>
              <div className="form-row">
                <input
                  type={newProvider.type === 'script' ? 'text' : 'url'}
                  className="form-input"
                  placeholder={
                    newProvider.type === 'jackett'
                      ? 'http://localhost:9117'
                      : newProvider.type === 'torznab'
                      ? 'http://localhost:9696'
                      : newProvider.type === 'script'
                      ? 'C:\\plugins\\my-indexer.py'
                      : 'https://api.example.com/search?q={query}'
                  }
                  value={newProvider.url}
                  onChange={e => setNewProvider(p => ({ ...p, url: e.target.value }))}
                />
                {newProvider.type === 'script' ? (
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={handleBrowseScript}
                    icon={<Icon name="folder" size={16} />}
                  >
                    {t('search.browse')}
                  </Button>
                ) : (
                  <input
                    type="text"
                    className="form-input api-key-input"
                    placeholder={t('search.provider.apiKey')}
                    value={newProvider.apiKey}
                    onChange={e => setNewProvider(p => ({ ...p, apiKey: e.target.value }))}
                  />
                )}
              </div>

              {/* Optional login for auth'd indexers (e.g. a RuTracker plugin).
                  Passed to script plugins as TH_USERNAME / TH_PASSWORD. */}
              {newProvider.type === 'script' && (
                <div className="form-row">
                  <input
                    type="text"
                    className="form-input"
                    placeholder={t('search.provider.login')}
                    autoComplete="off"
                    value={newProvider.username}
                    onChange={e => setNewProvider(p => ({ ...p, username: e.target.value }))}
                  />
                  <input
                    type="password"
                    className="form-input"
                    placeholder={t('search.provider.password')}
                    autoComplete="off"
                    value={newProvider.password}
                    onChange={e => setNewProvider(p => ({ ...p, password: e.target.value }))}
                  />
                </div>
              )}

              {/* What the plugin says about itself, when it says anything. */}
              {newProvider.type === 'script' && manifest && (
                <div className="plugin-manifest">
                  <Icon name="info" size={14} />
                  <span className="plugin-manifest-name">
                    {manifest.name || t('search.plugin.unnamed')}
                    {manifest.version && <span className="plugin-manifest-version"> v{manifest.version}</span>}
                  </span>
                  {manifest.description && <span className="plugin-manifest-desc">{manifest.description}</span>}
                  {manifest.requires.length > 0 && (
                    <span className="plugin-manifest-requires">
                      {t('search.plugin.requires')} {manifest.requires.join(', ')}
                    </span>
                  )}
                </div>
              )}

              {/* Python status — only relevant for script plugins */}
              {newProvider.type === 'script' && (
                <div className={`python-status ${pythonStatus?.found ? 'ok' : 'missing'}`}>
                  <Icon name={pythonStatus?.found ? 'check-circle' : 'alert-circle'} size={14} />
                  <span>
                    {checkingPython
                      ? t('search.python.checking')
                      : pythonStatus?.found
                      ? `${t('search.python.found')} ${pythonStatus.version || pythonStatus.path || ''}`
                      : t('search.python.missing')}
                  </span>
                  <button
                    type="button"
                    className="python-recheck"
                    disabled={checkingPython}
                    onClick={() => checkPython(true)}
                  >
                    {t('search.python.recheck')}
                  </button>
                </div>
              )}
              <Button
                variant="primary"
                loading={savingProvider}
                disabled={!newProvider.name || !newProvider.url}
                onClick={handleAddProvider}
                icon={<Icon name="plus" size={16} />}
              >
                {t('search.addProvider')}
              </Button>
            </div>

            {/* Help box */}
            <div className="provider-help">
              <h4><Icon name="help-circle" size={16} /> {t('search.guide.title')}</h4>
              <ul>
                <li><strong>Jackett:</strong> {t('search.guide.jackett')}</li>
                <li><strong>Prowlarr:</strong> {t('search.guide.prowlarr')}</li>
                <li><strong>{t('search.guide.customLabel')}:</strong> {t('search.guide.custom')}</li>
                <li><strong>{t('search.type.script')}:</strong> {t('search.guide.script')}</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SearchPage;
