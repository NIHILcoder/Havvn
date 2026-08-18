/**
 * Search Page
 * Plugin-based torrent search using Jackett/Torznab/Custom providers.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { SearchResult, SearchProvider, PythonStatus } from '../../shared/types';
import { Button, Icon, EmptyState, CategorySelect, useConfirm } from '../components';
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

const SearchPage: React.FC = () => {
  const { t } = useTranslation();
  const { confirm, alert } = useConfirm();
  const CATEGORIES = [
    { value: '', label: t('search.category.all') },
    { value: '2000', label: t('search.category.movies') },
    { value: '5000', label: t('search.category.tv') },
    { value: '3000', label: t('search.category.music') },
    { value: '4000', label: t('search.category.software') },
    { value: '6000', label: t('search.category.xxx') },
    { value: '8000', label: t('search.category.other') },
  ];
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [downloading, setDownloading] = useState<Set<number>>(new Set());
  const [addedIndices, setAddedIndices] = useState<Set<number>>(new Set());
  // Where the Download button on a result row files the torrent, and whether it
  // starts. Kept for the whole result list rather than per row — the choice is
  // almost always the same for everything a single search turned up.
  const [addCategoryId, setAddCategoryId] = useState('');
  const [addPaused, setAddPaused] = useState(false);

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

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError(null);
    setHasSearched(true);
    setResults([]);

    try {
      const res = await window.api.search.query(query.trim(), category || undefined);
      setResults(res);
    } catch (err: any) {
      setError(err?.message || t('search.failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (result: SearchResult, idx: number) => {
    if (downloading.has(idx)) return;
    setDownloading(prev => new Set(prev).add(idx));

    try {
      const uri = result.magnetUri || result.torrentUrl;
      if (!uri) throw new Error(t('search.noLink'));

      await window.api.addDownload({
        sourceType: result.magnetUri ? 'magnet' : 'torrent_file',
        sourceUri: uri,
        name: result.title,
        categoryId: addCategoryId || undefined,
        paused: addPaused || undefined,
      });

      setAddedIndices(prev => new Set(prev).add(idx));
    } catch (err) {
      await alert({ title: t('search.failedTitle'), message: `${t('search.failedToAdd')} ${cleanError(err)}` });
    } finally {
      setDownloading(prev => {
        const next = new Set(prev);
        next.delete(idx);
        return next;
      });
    }
  };

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
        setNewProvider(p => ({ ...p, url: res.filePaths[0] }));
        if (!pythonStatus) checkPython();
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
                  autoFocus
                />
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
              <Button
                variant="primary"
                type="submit"
                loading={loading}
                disabled={loading || !query.trim()}
                icon={<Icon name="search" size={16} />}
              >
                {t('search.btn')}
              </Button>
            </div>
          </form>

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
          {hasSearched && !loading && results.length === 0 && !error && (
            <EmptyState icon="search" title={t('search.noResults.title')} description={t('search.noResults.desc')} />
          )}

          {results.length > 0 && (
            <div className="search-results">
              <div className="search-results-header">
                <span className="results-count">{results.length} {t('search.results')}</span>
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
              <div className="results-table">
                <div className="results-thead">
                  <div className="results-th name-col">{t('table.name')}</div>
                  <div className="results-th size-col">{t('table.size')}</div>
                  <div className="results-th seeds-col">S/L</div>
                  <div className="results-th provider-col">{t('search.col.provider')}</div>
                  <div className="results-th action-col"></div>
                </div>
                {results.map((r, idx) => (
                  <div
                    key={`${r.infoHash || r.title}-${idx}`}
                    className={`results-row ${addedIndices.has(idx) ? 'added' : ''}`}
                  >
                    <div className="results-td name-col">
                      <span className="result-title" title={r.title}>{r.title}</span>
                      {r.category && <span className="result-category">{r.category}</span>}
                    </div>
                    <div className="results-td size-col">{formatBytes(r.size)}</div>
                    <div className="results-td seeds-col">
                      <span className="seeds">{r.seeds}</span>
                      <span className="sep">/</span>
                      <span className="leechers">{r.leechers}</span>
                    </div>
                    <div className="results-td provider-col">
                      <span className="provider-badge">{r.provider}</span>
                    </div>
                    <div className="results-td action-col">
                      {addedIndices.has(idx) ? (
                        <span className="added-badge">
                          <Icon name="check" size={14} /> {t('search.added')}
                        </span>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          loading={downloading.has(idx)}
                          disabled={downloading.has(idx) || (!r.magnetUri && !r.torrentUrl)}
                          onClick={() => handleDownload(r, idx)}
                          icon={<Icon name="download" size={14} />}
                        >
                          {t('search.download')}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
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
