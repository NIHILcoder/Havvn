/**
 * RSS Page
 * Manage RSS feed subscriptions with auto-download support.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { RSSFeed, RSSItem } from '../../shared/types';
import { Button, Icon, EmptyState } from '../components';
import { useTranslation } from '../utils/i18nContext';
import './RSSPage.css';

const formatDate = (dateStr?: string): string => {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
};

const formatBytes = (bytes?: number): string => {
  if (!bytes) return '—';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

type Tab = 'feeds' | 'items' | 'add';

const RSSPage: React.FC = () => {
  const { t } = useTranslation();
  const [feeds, setFeeds] = useState<RSSFeed[]>([]);
  const [items, setItems] = useState<RSSItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('feeds');
  const currentTab: string = tab; // avoids TS narrowing in nested JSX

  const [selectedFeed, setSelectedFeed] = useState<string | null>(null);
  const [itemSearch, setItemSearch] = useState('');
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const [downloadingGuids, setDownloadingGuids] = useState<Set<string>>(new Set());

  // Edit/Add feed modal state
  const [editingFeed, setEditingFeed] = useState<Partial<RSSFeed> | null>(null);
  const [savingFeed, setSavingFeed] = useState(false);

  const loadFeeds = useCallback(async () => {
    try {
      const list = await window.api.rss.getFeeds();
      setFeeds(list);
    } catch (err) {
      console.error('Failed to load RSS feeds:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadItems = useCallback(async (feedId?: string) => {
    try {
      const list = await window.api.rss.getItems(feedId || '');
      setItems(list);
    } catch (err) {
      console.error('Failed to load RSS items:', err);
    }
  }, []);

  useEffect(() => {
    loadFeeds();
  }, [loadFeeds]);

  useEffect(() => {
    if (tab === 'items') {
      loadItems(selectedFeed || undefined);
    }
  }, [tab, selectedFeed, loadItems]);

  const handleCheckFeed = async (id: string) => {
    setCheckingId(id);
    try {
      await window.api.rss.checkFeed(id);
      await loadFeeds();
      if (tab === 'items') await loadItems(selectedFeed || undefined);
    } catch (err: any) {
      alert(`Failed to check feed: ${err?.message}`);
    } finally {
      setCheckingId(null);
    }
  };

  const handleCheckAll = async () => {
    setCheckingAll(true);
    try {
      await window.api.rss.checkAll();
      await loadFeeds();
    } catch (err: any) {
      alert(`Failed: ${err?.message}`);
    } finally {
      setCheckingAll(false);
    }
  };

  const handleToggleFeed = async (feed: RSSFeed) => {
    try {
      await window.api.rss.updateFeed(feed.id, { enabled: !feed.enabled });
      await loadFeeds();
    } catch (err: any) {
      alert(`Failed: ${err?.message}`);
    }
  };

  const handleDeleteFeed = async (id: string) => {
    if (!confirm(t('rss.deleteConfirm'))) return;
    try {
      await window.api.rss.removeFeed(id);
      await loadFeeds();
      if (selectedFeed === id) setSelectedFeed(null);
    } catch (err: any) {
      alert(`Failed: ${err?.message}`);
    }
  };

  const handleSaveFeed = async () => {
    if (!editingFeed?.name || !editingFeed?.url) return;
    setSavingFeed(true);
    try {
      if (editingFeed.id) {
        await window.api.rss.updateFeed(editingFeed.id, editingFeed);
      } else {
        await window.api.rss.addFeed({
          name: editingFeed.name || '',
          url: editingFeed.url || '',
          enabled: editingFeed.enabled ?? true,
          autoDownload: editingFeed.autoDownload ?? false,
          filter: editingFeed.filter,
          intervalMinutes: editingFeed.intervalMinutes ?? 30,
          savePath: editingFeed.savePath,
        });
      }
      setEditingFeed(null);
      await loadFeeds();
      setTab('feeds');
    } catch (err: any) {
      alert(`Failed: ${err?.message}`);
    } finally {
      setSavingFeed(false);
    }
  };

  const handleDownloadItem = async (item: RSSItem) => {
    if (downloadingGuids.has(item.guid)) return;
    setDownloadingGuids(prev => new Set(prev).add(item.guid));
    try {
      const isMagnet = item.link.startsWith('magnet:');
      await window.api.addDownload({
        sourceType: isMagnet ? 'magnet' : 'torrent_file',
        sourceUri: item.link,
        name: item.title,
      });
      await window.api.rss.markDownloaded(item.guid);
      await loadItems(selectedFeed || undefined);
    } catch (err: any) {
      alert(`Failed: ${err?.message}`);
    } finally {
      setDownloadingGuids(prev => {
        const next = new Set(prev);
        next.delete(item.guid);
        return next;
      });
    }
  };

  const [clearing, setClearing] = useState(false);

  const handleClearItems = async () => {
    if (!confirm(t('rss.clearConfirm'))) return;
    setClearing(true);
    try {
      // Clears the current scope: the selected feed, or all feeds when none is selected
      await window.api.rss.clearItems(selectedFeed || undefined, false);
      await loadItems(selectedFeed || undefined);
    } catch (err: any) {
      alert(`Failed: ${err?.message}`);
    } finally {
      setClearing(false);
    }
  };

  const scopedItems = selectedFeed
    ? items.filter(i => i.feedId === selectedFeed)
    : items;
  const searchQuery = itemSearch.trim().toLowerCase();
  const displayedItems = searchQuery
    ? scopedItems.filter(i => i.title.toLowerCase().includes(searchQuery))
    : scopedItems;

  if (loading) {
    return (
      <div className="page-loading">
        <span className="spinner spinner-lg" />
        <p>{t('rss.loading')}</p>
      </div>
    );
  }

  return (
    <div className="rss-page">
      <div className="rss-header">
        <div className="rss-title-row">
          <h1 className="page-title">
            <Icon name="rss" size={20} />
            {t('rss.title')}
          </h1>
          <div className="rss-header-actions">
            <Button
              variant="ghost"
              size="sm"
              loading={checkingAll}
              onClick={handleCheckAll}
              icon={<Icon name="refresh" size={14} />}
            >
              {t('rss.checkAll')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => { setEditingFeed({ enabled: true, autoDownload: false, intervalMinutes: 30 }); setTab('add'); }}
              icon={<Icon name="plus" size={14} />}
            >
              {t('rss.addFeed')}
            </Button>
          </div>
        </div>
        <div className="rss-tabs">
          <button className={`rss-tab ${tab === 'feeds' ? 'active' : ''}`} onClick={() => setTab('feeds')}>
            {t('rss.tab.feeds')} ({feeds.length})
          </button>
          <button className={`rss-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => { setTab('items'); loadItems(selectedFeed || undefined); }}>
            {t('rss.tab.items')} {scopedItems.length > 0 && `(${scopedItems.length})`}
          </button>
          {editingFeed !== null && (
            <button className={`rss-tab ${tab === 'add' ? 'active' : ''}`} onClick={() => setTab('add')}>
              {editingFeed.id ? t('rss.tab.edit') : t('rss.tab.add')}
            </button>
          )}
        </div>
      </div>

      <div className="rss-content">
        {/* FEEDS TAB */}
        {tab === 'feeds' && (
          <>
            {feeds.length === 0 ? (
              <EmptyState
                icon="rss"
                title={t('rss.empty.title')}
                description={t('rss.empty.desc')}
              />
            ) : (
              <div className="feeds-list">
                {feeds.map(feed => (
                  <div key={feed.id} className={`feed-card ${!feed.enabled ? 'disabled' : ''}`}>
                    <div className="feed-status-dot" style={{
                      background: feed.enabled ? '#22c55e' : '#6b7280'
                    }} />
                    <div className="feed-main">
                      <div className="feed-name">{feed.name}</div>
                      <div className="feed-url">{feed.url}</div>
                      <div className="feed-meta">
                        {feed.lastChecked && (
                          <span className="feed-meta-item">
                            <Icon name="clock" size={11} />
                            {formatDate(feed.lastChecked)}
                          </span>
                        )}
                        <span className="feed-meta-item">
                          <Icon name="refresh" size={11} />
                          {t('rss.every')} {feed.intervalMinutes}{t('rss.minutesShort')}
                        </span>
                        {feed.autoDownload && (
                          <span className="feed-meta-item auto-dl">
                            <Icon name="download" size={11} />
                            {t('rss.autoDownload')}
                          </span>
                        )}
                        {feed.filter && (
                          <span className="feed-meta-item filter">
                            <Icon name="filter" size={11} />
                            {t('rss.filter')} <code>{feed.filter}</code>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="feed-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={checkingId === feed.id}
                        onClick={() => handleCheckFeed(feed.id)}
                        title={t('rss.checkNow')}
                        icon={<Icon name="refresh-cw" size={14} />}
                      >
                        {t('rss.check')}
                      </Button>
                      <button
                        className={`feed-view-btn ${selectedFeed === feed.id && currentTab === 'items' ? 'active' : ''}`}
                        onClick={() => { setSelectedFeed(feed.id); setTab('items'); }}
                        title={t('rss.viewItems')}
                      >
                        <Icon name="list" size={14} />
                      </button>
                      <button
                        className="feed-edit-btn"
                        onClick={() => { setEditingFeed({ ...feed }); setTab('add'); }}
                        title={t('rss.edit')}
                      >
                        <Icon name="edit-2" size={14} />
                      </button>
                      <button
                        className={`feed-toggle-btn ${feed.enabled ? 'on' : 'off'}`}
                        onClick={() => handleToggleFeed(feed)}
                        title={feed.enabled ? t('rss.disable') : t('rss.enable')}
                      >
                        <Icon name={feed.enabled ? 'eye' : 'eye-off'} size={14} />
                      </button>
                      <button
                        className="feed-delete-btn"
                        onClick={() => handleDeleteFeed(feed.id)}
                        title={t('rss.delete')}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ITEMS TAB */}
        {tab === 'items' && (
          <>
            {feeds.length > 0 && (
              <div className="items-filter-row">
                <button
                  className={`filter-chip ${selectedFeed === null ? 'active' : ''}`}
                  onClick={() => { setSelectedFeed(null); loadItems(); }}
                >
                  {t('rss.allFeeds')}
                </button>
                {feeds.map(f => (
                  <button
                    key={f.id}
                    className={`filter-chip ${selectedFeed === f.id ? 'active' : ''}`}
                    onClick={() => { setSelectedFeed(f.id); loadItems(f.id); }}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            )}

            {scopedItems.length > 0 && (
              <div className="items-toolbar">
                <div className="items-search">
                  <Icon name="search" size={14} />
                  <input
                    type="text"
                    className="items-search-input"
                    placeholder={t('rss.searchItems')}
                    value={itemSearch}
                    onChange={e => setItemSearch(e.target.value)}
                  />
                  {itemSearch && (
                    <button
                      className="items-search-clear"
                      onClick={() => setItemSearch('')}
                      title={t('rss.searchClear')}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  )}
                </div>
                <div className="items-toolbar-right">
                  <span className="items-count">
                    {searchQuery
                      ? `${displayedItems.length} / ${scopedItems.length}`
                      : displayedItems.length}
                  </span>
                  {displayedItems.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={clearing}
                      onClick={handleClearItems}
                      icon={<Icon name="trash" size={14} />}
                    >
                      {selectedFeed ? t('rss.clearItems') : t('rss.clearAll')}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {displayedItems.length === 0 ? (
              searchQuery && scopedItems.length > 0 ? (
                <EmptyState icon="search" title={t('rss.searchEmpty.title')} description={t('rss.searchEmpty.desc')} />
              ) : (
                <EmptyState icon="inbox" title={t('rss.items.empty.title')} description={t('rss.items.empty.desc')} />
              )
            ) : (
              <div className="items-list">
                {displayedItems.map(item => (
                  <div key={item.guid} className={`item-row ${item.downloaded ? 'downloaded' : ''}`}>
                    <div className="item-main">
                      <div className="item-title" title={item.title}>{item.title}</div>
                      <div className="item-meta">
                        {item.pubDate && (
                          <span className="item-meta-item">
                            <Icon name="calendar" size={11} />
                            {formatDate(item.pubDate)}
                          </span>
                        )}
                        {item.size && (
                          <span className="item-meta-item">
                            <Icon name="hard-drive" size={11} />
                            {formatBytes(item.size)}
                          </span>
                        )}
                        {item.downloaded && (
                          <span className="item-downloaded-badge">
                            <Icon name="check" size={11} /> {t('rss.downloaded')}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="item-actions">
                      {!item.downloaded ? (
                        <Button
                          variant="primary"
                          size="sm"
                          loading={downloadingGuids.has(item.guid)}
                          onClick={() => handleDownloadItem(item)}
                          icon={<Icon name="download" size={13} />}
                        >
                          {t('rss.download')}
                        </Button>
                      ) : (
                        <span className="check-done"><Icon name="check-circle" size={16} /></span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ADD/EDIT TAB */}
        {tab === 'add' && editingFeed !== null && (
          <div className="feed-form">
            <h2>{editingFeed.id ? t('rss.form.editTitle') : t('rss.form.addTitle')}</h2>

            <div className="form-field">
              <label>{t('rss.form.name')}</label>
              <input
                type="text"
                className="field-input"
                placeholder={t('rss.form.namePlaceholder')}
                value={editingFeed.name || ''}
                onChange={e => setEditingFeed(f => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="form-field">
              <label>{t('rss.form.url')}</label>
              <input
                type="url"
                className="field-input"
                placeholder="https://releases.ubuntu.com/releases/feed"
                value={editingFeed.url || ''}
                onChange={e => setEditingFeed(f => ({ ...f, url: e.target.value }))}
              />
            </div>

            <div className="form-row-2">
              <div className="form-field">
                <label>{t('rss.form.interval')}</label>
                <input
                  type="number"
                  className="field-input"
                  min="5"
                  max="1440"
                  value={editingFeed.intervalMinutes ?? 30}
                  onChange={e => setEditingFeed(f => ({ ...f, intervalMinutes: parseInt(e.target.value) || 30 }))}
                />
              </div>
              <div className="form-field">
                <label>{t('rss.form.savePath')}</label>
                <input
                  type="text"
                  className="field-input"
                  placeholder={t('rss.form.savePathPlaceholder')}
                  value={editingFeed.savePath || ''}
                  onChange={e => setEditingFeed(f => ({ ...f, savePath: e.target.value || undefined }))}
                />
              </div>
            </div>

            <div className="form-field">
              <label>
                {t('rss.form.filter')}
                <span className="field-hint">{t('rss.form.filterHint')}</span>
              </label>
              <input
                type="text"
                className="field-input"
                placeholder={t('rss.form.filterPlaceholder')}
                value={editingFeed.filter || ''}
                onChange={e => setEditingFeed(f => ({ ...f, filter: e.target.value || undefined }))}
              />
            </div>

            <div className="form-toggles">
              <label className="toggle-field">
                <span>{t('rss.form.enabled')}</span>
                <button
                  type="button"
                  className={`toggle-switch ${editingFeed.enabled ? 'active' : ''}`}
                  role="switch"
                  aria-checked={!!editingFeed.enabled}
                  onClick={() => setEditingFeed(f => ({ ...f, enabled: !f?.enabled }))}
                >
                  <span className="toggle-slider" />
                </button>
              </label>
              <label className="toggle-field">
                <div>
                  <span>{t('rss.form.autoDl')}</span>
                  <span className="field-hint">{t('rss.form.autoDlHint')}</span>
                </div>
                <button
                  type="button"
                  className={`toggle-switch ${editingFeed.autoDownload ? 'active' : ''}`}
                  role="switch"
                  aria-checked={!!editingFeed.autoDownload}
                  onClick={() => setEditingFeed(f => ({ ...f, autoDownload: !f?.autoDownload }))}
                >
                  <span className="toggle-slider" />
                </button>
              </label>
            </div>

            <div className="form-actions">
              <Button
                variant="ghost"
                onClick={() => { setEditingFeed(null); setTab('feeds'); }}
              >
                {t('rss.form.cancel')}
              </Button>
              <Button
                variant="primary"
                loading={savingFeed}
                disabled={!editingFeed.name || !editingFeed.url}
                onClick={handleSaveFeed}
                icon={<Icon name="check" size={16} />}
              >
                {editingFeed.id ? t('rss.form.save') : t('rss.form.add')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RSSPage;
