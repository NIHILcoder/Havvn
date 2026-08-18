/**
 * RSS Page
 * Manage RSS feed subscriptions with auto-download support.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { RSSFeed, RSSItem, RSSRule } from '../../shared/types';
import { Button, Icon, EmptyState, CategorySelect, DropdownMenu, useConfirm } from '../components';
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

/** Dot colour for a feed row: disabled, failing, or healthy. */
const feedStatusColor = (feed: RSSFeed): string => {
  if (!feed.enabled) return '#6b7280';
  if (feed.lastError) return '#ef4444';
  return '#22c55e';
};

type Tab = 'feeds' | 'items' | 'add' | 'rules' | 'ruleEdit';

/** A fresh rule: wildcard mode and the smart episode filter on, which is what
 *  most people want and what regex-first defaults made hard to discover. */
const newRule = (): Partial<RSSRule> => ({
  name: '',
  enabled: true,
  feedIds: [],
  mode: 'wildcard',
  include: '',
  smartEpisode: true,
});

const RSSPage: React.FC = () => {
  const { t } = useTranslation();
  const { confirm, alert } = useConfirm();
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
  const itemsScrollRef = useRef<HTMLDivElement>(null);

  const handleIgnoreItem = async (item: RSSItem) => {
    try {
      await window.api.rss.ignoreItems([item.guid]);
      await loadItems(selectedFeed || undefined);
    } catch (err) {
      console.error('Failed to dismiss RSS item:', err);
    }
  };

  // Edit/Add feed modal state
  const [editingFeed, setEditingFeed] = useState<Partial<RSSFeed> | null>(null);
  const [savingFeed, setSavingFeed] = useState(false);

  // Rules
  const [rules, setRules] = useState<RSSRule[]>([]);
  const [editingRule, setEditingRule] = useState<Partial<RSSRule> | null>(null);
  const [savingRule, setSavingRule] = useState(false);
  const [runningRuleId, setRunningRuleId] = useState<string | null>(null);
  // What the rule being edited would match right now, so it can be tuned
  // against real items instead of guessed at.
  const [rulePreview, setRulePreview] = useState<RSSItem[] | null>(null);

  const loadRules = useCallback(async () => {
    try {
      setRules(await window.api.rss.getRules());
    } catch (err) {
      console.error('Failed to load RSS rules:', err);
    }
  }, []);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  // Preview the rule as it is typed. Debounced — every keystroke otherwise runs
  // the matcher over every stored item.
  useEffect(() => {
    if (!editingRule) {
      setRulePreview(null);
      return;
    }
    const rule = editingRule;
    const timer = setTimeout(() => {
      window.api.rss
        .previewRule({
          id: rule.id || 'preview',
          name: rule.name || '',
          enabled: true,
          feedIds: rule.feedIds || [],
          mode: rule.mode || 'wildcard',
          include: rule.include || '',
          exclude: rule.exclude,
          minSize: rule.minSize,
          maxSize: rule.maxSize,
          minSeeds: rule.minSeeds,
          maxAgeDays: rule.maxAgeDays,
          smartEpisode: rule.smartEpisode,
          startFrom: rule.startFrom,
          // Deliberately not passing grabbedKeys: the preview should show what
          // the rule matches, not what is left after past grabs.
        })
        .then(setRulePreview)
        .catch(() => setRulePreview([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [editingRule]);

  const handleSaveRule = async () => {
    if (!editingRule?.name) return;
    setSavingRule(true);
    try {
      const payload = {
        name: editingRule.name || '',
        enabled: editingRule.enabled ?? true,
        feedIds: editingRule.feedIds || [],
        mode: editingRule.mode || 'wildcard',
        include: editingRule.include || '',
        exclude: editingRule.exclude,
        minSize: editingRule.minSize,
        maxSize: editingRule.maxSize,
        minSeeds: editingRule.minSeeds,
        maxAgeDays: editingRule.maxAgeDays,
        savePath: editingRule.savePath,
        categoryId: editingRule.categoryId,
        addPaused: editingRule.addPaused,
        smartEpisode: editingRule.smartEpisode,
        startFrom: editingRule.startFrom,
        grabbedKeys: editingRule.grabbedKeys,
      };
      if (editingRule.id) {
        await window.api.rss.updateRule(editingRule.id, payload);
      } else {
        await window.api.rss.addRule(payload);
      }
      setEditingRule(null);
      await loadRules();
      setTab('rules');
    } catch (err: any) {
      await alert({ title: t('rss.error.title'), message: `${t('rss.error.title')}: ${err?.message}` });
    } finally {
      setSavingRule(false);
    }
  };

  const handleDeleteRule = async (id: string) => {
    if (!(await confirm({ message: t('rss.rule.deleteConfirm'), danger: true }))) return;
    try {
      await window.api.rss.removeRule(id);
      await loadRules();
    } catch (err: any) {
      await alert({ title: t('rss.error.title'), message: `${t('rss.error.title')}: ${err?.message}` });
    }
  };

  const handleToggleRule = async (rule: RSSRule) => {
    try {
      await window.api.rss.updateRule(rule.id, { enabled: !rule.enabled });
      await loadRules();
    } catch (err: any) {
      await alert({ title: t('rss.error.title'), message: `${t('rss.error.title')}: ${err?.message}` });
    }
  };

  /** Apply a rule to the backlog already stored, not just to future posts. */
  const handleRunRule = async (rule: RSSRule) => {
    if (!(await confirm({ message: t('rss.rule.runConfirm') }))) return;
    setRunningRuleId(rule.id);
    try {
      const { grabbed, skipped } = await window.api.rss.runRule(rule.id);
      await loadRules();
      await alert({
        title: t('rss.rule.runDoneTitle'),
        message: `${t('rss.rule.runDoneAdded')} ${grabbed}. ${t('rss.rule.runDoneSkipped')} ${skipped}.`,
      });
    } catch (err: any) {
      await alert({ title: t('rss.error.title'), message: `${t('rss.error.title')}: ${err?.message}` });
    } finally {
      setRunningRuleId(null);
    }
  };

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
      await alert({ title: t('rss.error.title'), message: `${t('rss.error.checkFeed')}: ${err?.message}` });
    } finally {
      setCheckingId(null);
    }
  };

  const handleImportOPML = async () => {
    try {
      const res = await window.api.rss.importOPML();
      if (!res.success) return;
      await loadFeeds();
      await alert({
        title: t('rss.opml.importDoneTitle'),
        message: `${t('rss.opml.importAdded')} ${res.added}. ${t('rss.opml.importSkipped')} ${res.skipped}.`,
      });
    } catch (err: any) {
      await alert({ title: t('rss.error.title'), message: `${t('rss.error.title')}: ${err?.message}` });
    }
  };

  const handleExportOPML = async () => {
    try {
      const res = await window.api.rss.exportOPML();
      if (!res.success) return;
      await alert({
        title: t('rss.opml.exportDoneTitle'),
        message: `${t('rss.opml.exportDone')} ${res.count}`,
      });
    } catch (err: any) {
      await alert({ title: t('rss.error.title'), message: `${t('rss.error.title')}: ${err?.message}` });
    }
  };

  const handleCheckAll = async () => {
    setCheckingAll(true);
    try {
      await window.api.rss.checkAll();
      await loadFeeds();
    } catch (err: any) {
      await alert({ title: t('rss.error.title'), message: `${t('rss.error.title')}: ${err?.message}` });
    } finally {
      setCheckingAll(false);
    }
  };

  const handleToggleFeed = async (feed: RSSFeed) => {
    try {
      await window.api.rss.updateFeed(feed.id, { enabled: !feed.enabled });
      await loadFeeds();
    } catch (err: any) {
      await alert({ title: t('rss.error.title'), message: `${t('rss.error.title')}: ${err?.message}` });
    }
  };

  const handleDeleteFeed = async (id: string) => {
    if (!(await confirm({ message: t('rss.deleteConfirm'), danger: true }))) return;
    try {
      await window.api.rss.removeFeed(id);
      await loadFeeds();
      if (selectedFeed === id) setSelectedFeed(null);
    } catch (err: any) {
      await alert({ title: t('rss.error.title'), message: `${t('rss.error.title')}: ${err?.message}` });
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
          categoryId: editingFeed.categoryId,
          addPaused: editingFeed.addPaused,
        });
      }
      setEditingFeed(null);
      await loadFeeds();
      setTab('feeds');
    } catch (err: any) {
      await alert({ title: t('rss.error.title'), message: `${t('rss.error.title')}: ${err?.message}` });
    } finally {
      setSavingFeed(false);
    }
  };

  const handleDownloadItem = async (item: RSSItem) => {
    if (downloadingGuids.has(item.guid)) return;
    setDownloadingGuids(prev => new Set(prev).add(item.guid));
    try {
      const isMagnet = item.link.startsWith('magnet:');
      // A hand-picked item still belongs to its feed, so it inherits the same
      // save path, category and paused choice the feed's auto-download uses.
      const feed = feeds.find(f => f.id === item.feedId);
      await window.api.addDownload({
        sourceType: isMagnet ? 'magnet' : 'torrent_file',
        sourceUri: item.link,
        name: item.title,
        savePath: feed?.savePath,
        categoryId: feed?.categoryId,
        paused: feed?.addPaused,
      });
      await window.api.rss.markDownloaded(item.guid);
      await loadItems(selectedFeed || undefined);
    } catch (err: any) {
      await alert({ title: t('rss.error.title'), message: `${t('rss.error.title')}: ${err?.message}` });
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
    if (!(await confirm({ message: t('rss.clearConfirm'), danger: true }))) return;
    setClearing(true);
    try {
      // Clears the current scope: the selected feed, or all feeds when none is selected
      await window.api.rss.clearItems(selectedFeed || undefined, false);
      await loadItems(selectedFeed || undefined);
    } catch (err: any) {
      await alert({ title: t('rss.error.title'), message: `${t('rss.error.title')}: ${err?.message}` });
    } finally {
      setClearing(false);
    }
  };

  // Dismissed items stay in the store (so a rule can't re-grab them) but leave
  // the list.
  const scopedItems = (selectedFeed ? items.filter(i => i.feedId === selectedFeed) : items)
    .filter(i => !i.ignored);
  const searchQuery = itemSearch.trim().toLowerCase();
  const displayedItems = searchQuery
    ? scopedItems.filter(i => i.title.toLowerCase().includes(searchQuery))
    : scopedItems;

  // Only the rows in view are mounted.
  const itemVirtualizer = useVirtualizer({
    count: displayedItems.length,
    getScrollElement: () => itemsScrollRef.current,
    estimateSize: () => 64,
    getItemKey: index => displayedItems[index].guid,
    overscan: 8,
  });

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
            {/* OPML: the format every other reader speaks. */}
            <DropdownMenu
              portal
              items={[
                {
                  key: 'import',
                  label: t('rss.opml.import'),
                  icon: <Icon name="download" size={14} />,
                  onSelect: () => { handleImportOPML(); },
                },
                {
                  key: 'export',
                  label: t('rss.opml.export'),
                  icon: <Icon name="upload" size={14} />,
                  onSelect: () => { handleExportOPML(); },
                },
              ]}
              renderTrigger={({ toggle }) => (
                <Button variant="ghost" size="sm" onClick={toggle} icon={<Icon name="more-horizontal" size={14} />} />
              )}
            />
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
          <button className={`rss-tab ${tab === 'rules' ? 'active' : ''}`} onClick={() => { setTab('rules'); loadRules(); }}>
            {t('rss.tab.rules')} {rules.length > 0 && `(${rules.length})`}
          </button>
          {editingFeed !== null && (
            <button className={`rss-tab ${tab === 'add' ? 'active' : ''}`} onClick={() => setTab('add')}>
              {editingFeed.id ? t('rss.tab.edit') : t('rss.tab.add')}
            </button>
          )}
          {editingRule !== null && (
            <button className={`rss-tab ${tab === 'ruleEdit' ? 'active' : ''}`} onClick={() => setTab('ruleEdit')}>
              {editingRule.id ? t('rss.rule.editTitle') : t('rss.rule.addTitle')}
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
                    {/* A failing feed used to look exactly like a healthy one. */}
                    <div
                      className="feed-status-dot"
                      title={feed.lastError || undefined}
                      style={{ background: feedStatusColor(feed) }}
                    />
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
                        {/* How many rules act on this feed — auto-download is a
                            property of rules now, not of the feed. */}
                        {rules.filter(r => r.enabled && (r.feedIds.length === 0 || r.feedIds.includes(feed.id))).length > 0 && (
                          <span className="feed-meta-item auto-dl">
                            <Icon name="filter" size={11} />
                            {rules.filter(r => r.enabled && (r.feedIds.length === 0 || r.feedIds.includes(feed.id))).length}
                            {' '}
                            {t('rss.tab.rules').toLowerCase()}
                          </span>
                        )}
                        {feed.lastItemCount !== undefined && !feed.lastError && (
                          <span className="feed-meta-item">
                            <Icon name="list" size={11} />
                            {feed.lastItemCount}
                          </span>
                        )}
                        {feed.lastError && (
                          <span className="feed-meta-item feed-error" title={feed.lastError}>
                            <Icon name="alert-circle" size={11} />
                            {feed.lastError}
                            {(feed.consecutiveFailures || 0) > 1 && ` (×${feed.consecutiveFailures})`}
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
              /* Virtualized: a feed's history runs to a thousand rows, and
                 across feeds several thousand. */
              <div className="items-list" ref={itemsScrollRef}>
                <div className="items-virtual" style={{ height: `${itemVirtualizer.getTotalSize()}px` }}>
                  {itemVirtualizer.getVirtualItems().map(virtualRow => {
                    const item = displayedItems[virtualRow.index];
                    return (
                      <div
                        key={virtualRow.key}
                        className={`item-row ${item.downloaded ? 'downloaded' : ''}`}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
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
                            {item.seeds !== undefined && (
                              <span className="item-meta-item">
                                <Icon name="upload" size={11} />
                                {item.seeds}
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
                            <>
                              <Button
                                variant="primary"
                                size="sm"
                                loading={downloadingGuids.has(item.guid)}
                                onClick={() => handleDownloadItem(item)}
                                icon={<Icon name="download" size={13} />}
                              >
                                {t('rss.download')}
                              </Button>
                              {/* Dismiss: kept in the store so it can't come
                                  back, gone from the list. */}
                              <button
                                className="feed-delete-btn"
                                title={t('rss.item.ignore')}
                                onClick={() => handleIgnoreItem(item)}
                              >
                                <Icon name="x" size={14} />
                              </button>
                            </>
                          ) : (
                            <span className="check-done"><Icon name="check-circle" size={16} /></span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {/* RULES TAB */}
        {tab === 'rules' && (
          <>
            <div className="rules-toolbar">
              <p className="rules-desc">{t('rss.rule.desc')}</p>
              <Button
                variant="primary"
                size="sm"
                onClick={() => { setEditingRule(newRule()); setTab('ruleEdit'); }}
                icon={<Icon name="plus" size={14} />}
              >
                {t('rss.rule.add')}
              </Button>
            </div>

            {rules.length === 0 ? (
              <EmptyState
                icon="filter"
                title={t('rss.rule.empty.title')}
                description={t('rss.rule.empty.desc')}
              />
            ) : (
              <div className="rules-list">
                {rules.map(rule => (
                  <div key={rule.id} className={`rule-card ${!rule.enabled ? 'disabled' : ''}`}>
                    <div className="feed-status-dot" style={{ background: rule.enabled ? '#22c55e' : '#6b7280' }} />
                    <div className="rule-main">
                      <div className="feed-name">{rule.name}</div>
                      <div className="rule-pattern">
                        <code>{rule.include || t('rss.rule.matchesEverything')}</code>
                        {rule.exclude && <span className="rule-exclude"> − <code>{rule.exclude}</code></span>}
                      </div>
                      <div className="feed-meta">
                        <span className="feed-meta-item">
                          <Icon name="rss" size={11} />
                          {rule.feedIds.length === 0
                            ? t('rss.rule.allFeeds')
                            : rule.feedIds
                                .map(id => feeds.find(f => f.id === id)?.name)
                                .filter(Boolean)
                                .join(', ') || t('rss.rule.allFeeds')}
                        </span>
                        {rule.smartEpisode && (
                          <span className="feed-meta-item auto-dl">
                            <Icon name="check" size={11} />
                            {t('rss.rule.smart')}
                          </span>
                        )}
                        {rule.startFrom && (
                          <span className="feed-meta-item">
                            <Icon name="clock" size={11} />
                            {t('rss.rule.from')} {rule.startFrom}
                          </span>
                        )}
                        {rule.lastMatch && (
                          <span className="feed-meta-item">
                            <Icon name="download" size={11} />
                            {formatDate(rule.lastMatch)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="feed-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={runningRuleId === rule.id}
                        onClick={() => handleRunRule(rule)}
                        title={t('rss.rule.runHint')}
                        icon={<Icon name="play" size={14} />}
                      >
                        {t('rss.rule.run')}
                      </Button>
                      <button
                        className="feed-edit-btn"
                        onClick={() => { setEditingRule({ ...rule }); setTab('ruleEdit'); }}
                        title={t('rss.edit')}
                      >
                        <Icon name="edit-2" size={14} />
                      </button>
                      <button
                        className={`feed-toggle-btn ${rule.enabled ? 'on' : 'off'}`}
                        onClick={() => handleToggleRule(rule)}
                        title={rule.enabled ? t('rss.disable') : t('rss.enable')}
                      >
                        <Icon name={rule.enabled ? 'eye' : 'eye-off'} size={14} />
                      </button>
                      <button
                        className="feed-delete-btn"
                        onClick={() => handleDeleteRule(rule.id)}
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

        {/* RULE EDITOR */}
        {tab === 'ruleEdit' && editingRule !== null && (
          <div className="feed-form">
            <h2>{editingRule.id ? t('rss.rule.editTitle') : t('rss.rule.addTitle')}</h2>

            <div className="form-field">
              <label>{t('rss.rule.name')}</label>
              <input
                type="text"
                className="field-input"
                placeholder={t('rss.rule.namePlaceholder')}
                value={editingRule.name || ''}
                onChange={e => setEditingRule(r => ({ ...r, name: e.target.value }))}
              />
            </div>

            <div className="form-row-2">
              <div className="form-field">
                <label>
                  {t('rss.rule.include')}
                  <span className="field-hint">
                    {editingRule.mode === 'regex' ? t('rss.rule.includeHintRegex') : t('rss.rule.includeHint')}
                  </span>
                </label>
                <input
                  type="text"
                  className="field-input"
                  placeholder={editingRule.mode === 'regex' ? 'S\\d+E\\d+' : 'show name 1080p'}
                  value={editingRule.include || ''}
                  onChange={e => setEditingRule(r => ({ ...r, include: e.target.value }))}
                />
              </div>
              <div className="form-field">
                <label>
                  {t('rss.rule.exclude')}
                  <span className="field-hint">{t('rss.rule.excludeHint')}</span>
                </label>
                <input
                  type="text"
                  className="field-input"
                  placeholder="hdtv cam"
                  value={editingRule.exclude || ''}
                  onChange={e => setEditingRule(r => ({ ...r, exclude: e.target.value || undefined }))}
                />
              </div>
            </div>

            <div className="form-field">
              <label>{t('rss.rule.mode')}</label>
              <div className="mode-switch">
                {(['wildcard', 'regex'] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    className={`mode-option ${(editingRule.mode || 'wildcard') === m ? 'active' : ''}`}
                    onClick={() => setEditingRule(r => ({ ...r, mode: m }))}
                  >
                    {m === 'wildcard' ? t('rss.rule.modeWildcard') : t('rss.rule.modeRegex')}
                  </button>
                ))}
              </div>
            </div>

            <div className="form-field">
              <label>
                {t('rss.rule.feeds')}
                <span className="field-hint">{t('rss.rule.feedsHint')}</span>
              </label>
              <div className="items-filter-row">
                <button
                  className={`filter-chip ${(editingRule.feedIds || []).length === 0 ? 'active' : ''}`}
                  onClick={() => setEditingRule(r => ({ ...r, feedIds: [] }))}
                >
                  {t('rss.rule.allFeeds')}
                </button>
                {feeds.map(f => {
                  const on = (editingRule.feedIds || []).includes(f.id);
                  return (
                    <button
                      key={f.id}
                      className={`filter-chip ${on ? 'active' : ''}`}
                      onClick={() => setEditingRule(r => {
                        const current = r?.feedIds || [];
                        return {
                          ...r,
                          feedIds: on ? current.filter(id => id !== f.id) : [...current, f.id],
                        };
                      })}
                    >
                      {f.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="form-row-2">
              <div className="form-field">
                <label>
                  {t('rss.rule.minSeeds')}
                  <span className="field-hint">{t('rss.rule.boundHint')}</span>
                </label>
                <input
                  type="number"
                  min="0"
                  className="field-input"
                  value={editingRule.minSeeds ?? ''}
                  onChange={e => setEditingRule(r => ({ ...r, minSeeds: e.target.value ? parseInt(e.target.value) : undefined }))}
                />
              </div>
              <div className="form-field">
                <label>
                  {t('rss.rule.maxAge')}
                  <span className="field-hint">{t('rss.rule.boundHint')}</span>
                </label>
                <input
                  type="number"
                  min="0"
                  className="field-input"
                  value={editingRule.maxAgeDays ?? ''}
                  onChange={e => setEditingRule(r => ({ ...r, maxAgeDays: e.target.value ? parseInt(e.target.value) : undefined }))}
                />
              </div>
            </div>

            <div className="form-row-2">
              <div className="form-field">
                <label>{t('rss.rule.minSize')}</label>
                <input
                  type="number"
                  min="0"
                  className="field-input"
                  placeholder="GB"
                  value={editingRule.minSize ? editingRule.minSize / (1024 ** 3) : ''}
                  onChange={e => setEditingRule(r => ({
                    ...r,
                    minSize: e.target.value ? Math.round(parseFloat(e.target.value) * 1024 ** 3) : undefined,
                  }))}
                />
              </div>
              <div className="form-field">
                <label>{t('rss.rule.maxSize')}</label>
                <input
                  type="number"
                  min="0"
                  className="field-input"
                  placeholder="GB"
                  value={editingRule.maxSize ? editingRule.maxSize / (1024 ** 3) : ''}
                  onChange={e => setEditingRule(r => ({
                    ...r,
                    maxSize: e.target.value ? Math.round(parseFloat(e.target.value) * 1024 ** 3) : undefined,
                  }))}
                />
              </div>
            </div>

            <div className="form-row-2">
              <div className="form-field">
                <label>{t('rss.form.savePath')}</label>
                <input
                  type="text"
                  className="field-input"
                  placeholder={t('rss.form.savePathPlaceholder')}
                  value={editingRule.savePath || ''}
                  onChange={e => setEditingRule(r => ({ ...r, savePath: e.target.value || undefined }))}
                />
              </div>
              <div className="form-field">
                <label>{t('rss.form.category')}</label>
                <CategorySelect
                  value={editingRule.categoryId || ''}
                  onChange={id => setEditingRule(r => ({ ...r, categoryId: id || undefined }))}
                />
              </div>
            </div>

            <div className="form-field">
              <label>
                {t('rss.rule.startFrom')}
                <span className="field-hint">{t('rss.rule.startFromHint')}</span>
              </label>
              <input
                type="text"
                className="field-input"
                placeholder="S02E03"
                value={editingRule.startFrom || ''}
                onChange={e => setEditingRule(r => ({ ...r, startFrom: e.target.value || undefined }))}
              />
            </div>

            <div className="form-toggles">
              <label className="toggle-field">
                <div>
                  <span>{t('rss.rule.smart')}</span>
                  <span className="field-hint">{t('rss.rule.smartHint')}</span>
                </div>
                <button
                  type="button"
                  className={`toggle-switch ${editingRule.smartEpisode ? 'active' : ''}`}
                  role="switch"
                  aria-checked={!!editingRule.smartEpisode}
                  onClick={() => setEditingRule(r => ({ ...r, smartEpisode: !r?.smartEpisode }))}
                >
                  <span className="toggle-slider" />
                </button>
              </label>
              <label className="toggle-field">
                <div>
                  <span>{t('rss.form.addPaused')}</span>
                  <span className="field-hint">{t('rss.form.addPausedHint')}</span>
                </div>
                <button
                  type="button"
                  className={`toggle-switch ${editingRule.addPaused ? 'active' : ''}`}
                  role="switch"
                  aria-checked={!!editingRule.addPaused}
                  onClick={() => setEditingRule(r => ({ ...r, addPaused: !r?.addPaused }))}
                >
                  <span className="toggle-slider" />
                </button>
              </label>
            </div>

            {/* What the rule matches right now — a rule tuned blind is a rule
                that grabs the wrong thing at 3am. */}
            <div className="rule-preview">
              <div className="rule-preview-head">
                <Icon name="eye" size={14} />
                {rulePreview === null
                  ? t('rss.rule.previewLoading')
                  : `${t('rss.rule.previewCount')} ${rulePreview.length}`}
              </div>
              {rulePreview && rulePreview.length > 0 && (
                <ul className="rule-preview-list">
                  {rulePreview.slice(0, 20).map(item => (
                    <li key={item.guid} title={item.title}>
                      {item.downloaded && <Icon name="check" size={11} />}
                      {item.title}
                    </li>
                  ))}
                  {rulePreview.length > 20 && (
                    <li className="rule-preview-more">
                      + {rulePreview.length - 20}
                    </li>
                  )}
                </ul>
              )}
            </div>

            <div className="form-actions">
              <Button variant="ghost" onClick={() => { setEditingRule(null); setTab('rules'); }}>
                {t('rss.form.cancel')}
              </Button>
              <Button
                variant="primary"
                loading={savingRule}
                disabled={!editingRule.name}
                onClick={handleSaveRule}
                icon={<Icon name="check" size={16} />}
              >
                {editingRule.id ? t('rss.form.save') : t('rss.rule.add')}
              </Button>
            </div>
          </div>
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
                {t('rss.form.category')}
                <span className="field-hint">{t('rss.form.categoryHint')}</span>
              </label>
              <CategorySelect
                value={editingFeed.categoryId || ''}
                onChange={id => setEditingFeed(f => ({ ...f, categoryId: id || undefined }))}
              />
            </div>

            {/* Filtering and auto-download moved to rules, which can span feeds
                and carry their own destination. A feed just fetches now. */}
            <div className="form-note">
              <Icon name="info" size={14} />
              <span>{t('rss.form.rulesMoved')}</span>
              <button
                type="button"
                className="form-note-link"
                onClick={() => { setEditingFeed(null); setTab('rules'); loadRules(); }}
              >
                {t('rss.tab.rules')}
              </button>
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
                  <span>{t('rss.form.addPaused')}</span>
                  <span className="field-hint">{t('rss.form.addPausedFeedHint')}</span>
                </div>
                <button
                  type="button"
                  className={`toggle-switch ${editingFeed.addPaused ? 'active' : ''}`}
                  role="switch"
                  aria-checked={!!editingFeed.addPaused}
                  onClick={() => setEditingFeed(f => ({ ...f, addPaused: !f?.addPaused }))}
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
