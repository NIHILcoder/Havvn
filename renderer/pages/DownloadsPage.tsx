/**
 * Downloads Page
 * 
 * Main downloads management page with compact/detailed view modes.
 */

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useStore } from 'zustand';
import { CompletionAction, type DownloadDefaults } from '../../shared/types';
import { canPause, canResume } from '../../shared/state-machine';
import {
  Button,
  Icon,
  ToastContainer,
  EmptyState,
  FilePreview,
  ContextMenu,
  DropdownMenu,
  TorrentFileSelector,
  TorrentSearchModal,
  TorrentControlModal,
  StreamPlayerModal,
  ShareLinkModal,
  ShareToRoomModal,
  useConfirm,
} from '../components';
import './DownloadsPage.css';
import { AutomationDraftModal } from '../components/AutomationDraftModal';
import { automationDraft, type AutomationDraft } from '../../shared/automation-draft';

import {
  ViewMode, FilterMode, SortMode,
  formatBytes, formatDate,
} from './download-helpers';
import { ConnectedDownloadItem } from './DownloadItem';
import { downloadsModel, useDownloads } from '../state/downloads';
import { cleanError } from '../utils/format-helpers';
import { useTranslation } from '../utils/i18nContext';
import DownloadViewsBar from './DownloadViewsBar';
import { isModalOpen } from '../components/Modal';
import { compileDownloadView, type DownloadViewConditions, type DownloadViewConfig } from '../../shared/download-views';
import { useDownloadViews } from '../utils/download-views';
import { firstSteps } from '../utils/first-steps';
import { AddDownloadsModal } from '../components/AddDownloadsModal';
import { DownloadDeletionModal } from '../components/DownloadDeletionModal';
import { ADD_QUEUE_LIMIT, sourceIdentity, type DownloadSource } from '../../shared/download-source-queue';
import { runDownloadBatch, downloadBatchState, type BatchAction } from '../state/download-batch';
import { pageLeave } from '../state/page-leave';
import { Modal } from '../components/Modal';
import { EffectiveLimits } from './settings/EffectiveLimits';
import { activeDownloadConditions, clearDownloadCondition } from '../../shared/download-filter-chips';
import { DownloadHelpModal } from '../components/DownloadHelpModal';
import type { ErrorRecoveryContext } from '../components/RecoveryError';
import type { SettingSearchEntry } from './settings/settingsSearch';


interface DownloadsPageProps {
  onOpenEvents?(): void;
  onOpenSetting?(entry: SettingSearchEntry): void;
  filterMode?: FilterMode;
  onFilterChange?: (filter: FilterMode) => void;
  // A torrent file path / magnet URI opened from the OS; opens the add dialog
  openTorrentUri?: string | null;
  onOpenHandled?: () => void;
  focusRequest?: { id: string; requestId: number } | null;
  onFocusHandled?: () => void;
  addTorrentRequest?: number;
  onAddTorrentHandled?: () => void;
  streamRequest?: { id: string; requestId: number } | null;
  onStreamHandled?: () => void;
}

const DownloadsPage: React.FC<DownloadsPageProps> = ({
  filterMode: externalFilterMode = 'all',
  onFilterChange,
  openTorrentUri,
  onOpenHandled,
  focusRequest,
  onFocusHandled,
  addTorrentRequest,
  onAddTorrentHandled,
  streamRequest,
  onStreamHandled,
  onOpenEvents,
  onOpenSetting,
}) => {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const downloads = useDownloads(s => s.downloads);
  const downloadsById = useDownloads(s => s.byId);
  const downloadsLoaded = useDownloads(s => s.loaded);
  const setDownloads = downloadsModel.updateDownloads;
  const [loading, setLoading] = useState(true);

  // Toast notifications
  const [toasts, setToasts] = useState<Array<{
    id: string;
    message: string;
    variant?: 'success' | 'error' | 'warning' | 'info';
    duration?: number;
    recovery?: ErrorRecoveryContext;
  }>>([]);

  // UI State
  const [viewMode, setViewMode] = useState<ViewMode>('compact');
  // Per-row accordion: which compact rows are expanded to full detail.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const handleChangeViewMode = useCallback((mode: React.SetStateAction<ViewMode>) => {
    // Choosing a global view resets the compact accordion, including when the
    // user clicks the already-active compact button to collapse all rows.
    setExpandedIds(prev => prev.size ? new Set() : prev);
    setViewMode(mode);
  }, []);
  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  // Use external filter mode from props
  const [localFilterMode, setLocalFilterMode] = useState<FilterMode>(externalFilterMode);
  const filterMode = onFilterChange ? externalFilterMode : localFilterMode;
  const setFilterMode = onFilterChange ?? setLocalFilterMode;
  const [sortMode, setSortMode] = useState<SortMode>('added');
  const [searchQuery, setSearchQuery] = useState('');

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Context menu state
  const [automation, setAutomation] = useState<AutomationDraft | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    downloadId: string;
  } | null>(null);

  // Other state
  const [isDragging, setIsDragging] = useState(false);
  // Drag depth as a ref, not state: dragenter/dragleave fire for every nested
  // child the cursor crosses, so reading a stale state snapshot in dragleave used
  // to desync the count and leave the overlay stuck visible (it would cover the
  // whole UI). A ref mutates synchronously, so the count stays correct.
  const dragCounter = useRef(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const savedViews = useDownloadViews();
  const [advancedFilters, setAdvancedFilters] = useState<Omit<DownloadViewConditions, 'status' | 'name'>>({ path: '' });
  const visibleIds = useRef<string[]>([]);
  const conditions = useMemo(() => ({ ...advancedFilters, status: filterMode, name: searchQuery }), [advancedFilters, filterMode, searchQuery]);
  const viewConfig: DownloadViewConfig = { conditions, sort: { by: sortMode, direction: sortDirection }, mode: viewMode };
  const applyViewConfig = (config: DownloadViewConfig) => {
    const { status, name, ...advanced } = config.conditions;
    setAdvancedFilters(advanced); setSearchQuery(name); setFilterMode(status);
    setSortMode(config.sort.by); setSortDirection(config.sort.direction); if (config.mode !== viewMode) handleChangeViewMode(config.mode);
    setSelectedIds(new Set());
    scrollParentRef.current?.scrollTo({ top: 0 });
  };
  useEffect(() => {
    const view = savedViews.catalog.views.find(item => item.id === savedViews.catalog.activeId);
    if (view) applyViewConfig(view);
    else { setAdvancedFilters({ path: '' }); setSearchQuery(''); setSelectedIds(new Set()); }
    scrollParentRef.current?.scrollTo({ top: 0 });
  }, [savedViews.selection]);
  const [altSpeed, setAltSpeed] = useState(false);
  const [showSpeedLimits, setShowSpeedLimits] = useState(false);
  const [helpId, setHelpId] = useState<string | null>(null), [showCompletionActions, setShowCompletionActions] = useState(false);
  const pendingRowCommands = useRef(new Set<string>());

  // Torrent control modal
  const [controlModalId, setControlModalId] = useState<string | null>(null);
  const controlModalDownload = controlModalId ? downloadsById.get(controlModalId) : null;
  const [streamModalId, setStreamModalId] = useState<string | null>(null);
  const streamModalDownload = streamModalId ? downloadsById.get(streamModalId) : null;
  const handledStream = useRef(0);
  const [shareModalId, setShareModalId] = useState<string | null>(null);
  const shareModalDownload = shareModalId ? downloadsById.get(shareModalId) : null;
  // "Share to room" — the row's Share button + context menu
  const [shareRoomId, setShareRoomId] = useState<string | null>(null);
  const shareRoomDownload = shareRoomId ? downloadsById.get(shareRoomId) : null;

  const shareRoomProgress = useDownloads(s => shareRoomId ? s.statsById.get(shareRoomId)?.progress : undefined);
  // Refs
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollParentRef = useRef<HTMLDivElement>(null);

  // File selector state
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [showAddLink, setShowAddLink] = useState(false);
  const [initialSources, setInitialSources] = useState<DownloadSource[]>([]);
  const queuedSources = useRef<DownloadSource[]>([]), queueGeneration = useRef(0);
  const [queueProgress, setQueueProgress] = useState({ position: 0, total: 0 });
  const [showSearch, setShowSearch] = useState(false);
  const [pendingTorrent, setPendingTorrent] = useState<{
    path?: string;
    magnetUri?: string;
  } | null>(null);
  const [isAddingTorrent, setIsAddingTorrent] = useState(false);
  const showSource = (source: DownloadSource | undefined) => {
    setPendingTorrent(source ? source.sourceType === 'magnet' ? { magnetUri: source.sourceUri } : { path: source.sourceUri } : null);
    setShowFileSelector(!!source);
  };
  const startSources = (sources: DownloadSource[]) => {
    if (!sources.length) return;
    queueGeneration.current++; queuedSources.current = sources.slice(1);
    setQueueProgress({ position: 1, total: sources.length }); setShowAddLink(false); setSelectedFile(null); showSource(sources[0]);
  };
  const advanceSource = () => { const next = queuedSources.current.shift(); showSource(next); setQueueProgress(old => ({ ...old, position: old.position + 1 })); };

  // On-completion action (one-shot; main owns the state, this mirrors it)
  const [onDoneAction, setOnDoneAction] = useState<CompletionAction>('none');
  const [onDoneAvailable, setOnDoneAvailable] = useState<CompletionAction[]>(['none', 'quit']);

  // Toast helper
  const addToast = useCallback((message: string, variant: 'success' | 'error' | 'warning' | 'info' = 'info', duration = 5000, recovery?: ErrorRecoveryContext) => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, message, variant, duration, recovery }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);
  useEffect(() => pageLeave.register(async () => {
    if (isAddingTorrent) { addToast(t('navigation.waitWork'), 'info'); return false; }
    return !showFileSelector || await confirm({ title: t('downloads.queue.leaveTitle'), message: t('downloads.queue.leaveHint'), confirmLabel: t('downloads.queue.leave'), cancelLabel: t('common.cancel') });
  }), [isAddingTorrent, showFileSelector, confirm, addToast, t]);
  const batchResult = useStore(downloadBatchState, state => state.result), batchBusy = useStore(downloadBatchState, state => state.busy);
  const runBatch = useCallback(async (action: BatchAction, ids: Iterable<string>) => {
    if (downloadBatchState.getState().busy) return;
    downloadBatchState.setState({ busy: true });
    try {
      const result = await runDownloadBatch(ids, action, () => downloadsModel.store.getState().byId, window.api);
      downloadBatchState.setState({ result }); setSelectedIds(new Set(result.failed.map(item => item.id)));
      await downloadsModel.refresh().catch(() => {});
    } finally { downloadBatchState.setState({ busy: false }); }
  }, []);

  useEffect(() => {
    if (!streamRequest || handledStream.current === streamRequest.requestId || !downloadsLoaded) return;
    handledStream.current = streamRequest.requestId;
    if (downloadsById.has(streamRequest.id)) setStreamModalId(streamRequest.id);
    else addToast(t('commands.missing'), 'error');
    onStreamHandled?.();
  }, [streamRequest, downloadsLoaded, downloadsById, onStreamHandled, addToast, t]);

  const removingIds = useRef(new Set<string>());
  const [deletionId, setDeletionId] = useState<string | null>(null);
  const handleRemoveMany = useCallback(async (ids: string[]) => {
    if (downloadBatchState.getState().busy) return;
    const targets = ids.filter(id => !removingIds.current.has(id));
    targets.forEach(id => removingIds.current.add(id));
    const results = await Promise.allSettled(targets.map(id => window.api.removeDownload(id, false)
      .finally(() => removingIds.current.delete(id))));
    const removed = new Set(targets.filter((_, index) => results[index].status === 'fulfilled'));
    setDownloads(current => current.filter(download => !removed.has(download.id)));
    setSelectedIds(current => new Set([...current].filter(id => !removed.has(id))));
    const failures = results.filter(result => result.status === 'rejected').length;
    const unavailable = results.filter(result => result.status === 'fulfilled' && result.value?.unavailable).length;
    if (failures) addToast(t('undo.batchFailed').replace('{count}', String(failures)), 'error');
    if (unavailable) addToast(t('undo.batchUnavailable').replace('{count}', String(unavailable)), 'warning');
    await downloadsModel.refresh().catch(() => {});
  }, [addToast, setDownloads, t]);

  // Drag and drop handlers
  const isFileDrag = (e: React.DragEvent): boolean =>
    !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isFileDrag(e)) return; // ignore internal element drags (rows, etc.)
    dragCounter.current += 1;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isFileDrag(e)) return;
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;

    if (showFileSelector || showAddLink || isAddingTorrent) return;
    const files = Array.from(e.dataTransfer.files ?? []), sources: DownloadSource[] = [];
    for (const file of files) {
      const path = /\.torrent$/i.test(file.name) ? window.api.getPathForFile(file) : '';
      if (path) sources.push({ sourceType: 'torrent_file', sourceUri: path, label: file.name });
      else addToast(`${file.name}: ${t('downloads.dropTorrentOnly')}`, 'error');
    }
    if (sources.length) { setInitialSources(sources); setShowAddLink(true); }
  };

  // Safety net for the drop overlay: if a drag is interrupted — the file dialog
  // opens mid-drag, the pointer leaves the window, or the window loses focus —
  // the dragleave/drop event may never fire and the overlay would stay stuck
  // covering the UI. Force-clear it on these window-level events.
  useEffect(() => {
    const clear = () => { dragCounter.current = 0; setIsDragging(false); };
    const onWindowDragLeave = (e: DragEvent) => { if (e.relatedTarget === null) clear(); };
    window.addEventListener('drop', clear);
    window.addEventListener('dragend', clear);
    window.addEventListener('blur', clear);
    window.addEventListener('dragleave', onWindowDragLeave);
    return () => {
      window.removeEventListener('drop', clear);
      window.removeEventListener('dragend', clear);
      window.removeEventListener('blur', clear);
      window.removeEventListener('dragleave', onWindowDragLeave);
    };
  }, []);

  // Standalone mounts share the same connection as the app shell.
  useEffect(() => {
    const release = downloadsModel.retain();
    void loadDownloads();
    return release;
  }, []);

  // Mirror the one-shot completion action (tray can change it too)
  useEffect(() => {
    void window.api.getCompletionAction().then((s) => {
      setOnDoneAction(s.action);
      setOnDoneAvailable(s.available);
    }).catch(() => { /* older main without the handler */ });
    const off = window.api.onCompletionActionChanged((a) => setOnDoneAction(a));
    return () => off();
  }, []);

  const onDoneLabel = useCallback((a: CompletionAction): string => {
    switch (a) {
      case 'sleep': return t('downloads.onDone.sleep');
      case 'shutdown': return t('downloads.onDone.shutdown');
      case 'quit': return t('downloads.onDone.quit');
      default: return t('downloads.onDone.none');
    }
  }, [t]);

  const handleSelectOnDone = useCallback(async (a: CompletionAction) => {
    try {
      // No optimistic set: main broadcasts app:completionActionChanged, which
      // the mount subscription above applies — one source of truth.
      await window.api.setCompletionAction(a);
      if (a !== 'none') addToast(t('downloads.onDoneSet'), 'info');
    } catch {
      addToast(t('downloads.onDoneFailed'), 'error');
    }
  }, [addToast, t]);

  // A torrent opened from the OS (double-click / magnet link): open the same
  // file-picker dialog as a manual add instead of adding silently.
  useEffect(() => {
    if (!openTorrentUri) return;
    const source: DownloadSource = { sourceType: openTorrentUri.startsWith('magnet:') ? 'magnet' : 'torrent_file', sourceUri: openTorrentUri, label: openTorrentUri };
    if (showFileSelector && pendingTorrent) {
      const current: DownloadSource = { sourceType: pendingTorrent.path ? 'torrent_file' : 'magnet', sourceUri: pendingTorrent.path ?? pendingTorrent.magnetUri!, label: '' };
      if (![current, ...queuedSources.current].some(item => sourceIdentity(item) === sourceIdentity(source))) {
        if (queueProgress.total >= ADD_QUEUE_LIMIT) addToast(t('downloads.queue.limit').replace('{count}', String(ADD_QUEUE_LIMIT)), 'warning');
        else { queuedSources.current.push(source); setQueueProgress(old => ({ ...old, total: old.total + 1 })); }
      }
    } else startSources([source]);
    onOpenHandled?.();
  }, [openTorrentUri]);

  // Load the alternative-speed toggle state on mount (reflects the toolbar button)
  useEffect(() => {
    window.api.getAltSpeed().then(({ altSpeedEnabled }) => setAltSpeed(altSpeedEnabled)).catch(() => {});
  }, []);

  // (Filter/sort dropdown state was removed — sorting lives in the list header)

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.defaultPrevented || isModalOpen()) return;
      // A modal owns the keyboard while open — page-level shortcuts (Delete,
      // Space, Ctrl+A) acting on the list underneath would be destructive.
      if (shareRoomId || shareModalId || streamModalId || controlModalId || previewId || showFileSelector) return;
      const target = e.target as HTMLElement;
      const isInInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      // Ctrl+A selects the current result set, including virtualized rows.
      if (e.ctrlKey && e.key === 'a' && !isInInput) {
        e.preventDefault();
        setSelectedIds(new Set(visibleIds.current));
      }

      // Delete - Remove selected downloads
      if (e.key === 'Delete' && selectedIds.size > 0 && !isInInput) {
        e.preventDefault();
        if (await confirm({ message: `${t('downloads.confirmRemoveMany')} (${selectedIds.size})`, danger: true })) {
          await handleRemoveMany(Array.from(selectedIds));
        }
      }

      // Space - Toggle pause/resume for selected
      if (e.key === ' ' && selectedIds.size > 0 && !isInInput) {
        e.preventDefault();
        const action = [...selectedIds].some(id => canPause(downloadsModel.store.getState().byId.get(id)?.status ?? 'removed')) ? 'pause' : 'resume';
        void runBatch(action, selectedIds);
      }


      // Ctrl+F - Focus search box
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }

      // Ctrl+P - Toggle view mode
      if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        handleChangeViewMode(prev => prev === 'compact' ? 'detailed' : 'compact');
      }

      // Escape - Clear selection
      if (e.key === 'Escape') {
        setSelectedIds(new Set());
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, downloads, addToast, shareRoomId, shareModalId, streamModalId, controlModalId, previewId, showFileSelector, handleChangeViewMode, handleRemoveMany, runBatch]);

  // Clipboard magnet detection — on window focus, check for magnet: URIs.
  // Legacy hint for users WITHOUT the main-process clipboard watcher: when the
  // watcher is on, it already opens the add dialog itself, and this toast on
  // top of that dialog would be pure noise.
  useEffect(() => {
    let lastDetectedMagnet = '';

    const handleFocus = async () => {
      try {
        const s = await window.api.getSettings();
        if (s?.clipboardWatchEnabled) return;
        const text = await navigator.clipboard.readText();
        if (text && text.startsWith('magnet:?') && text !== lastDetectedMagnet) {
          lastDetectedMagnet = text;
          addToast(
            t('downloads.magnetDetected'),
            'info',
            10000
          );
        }
      } catch {
        // Clipboard access denied — silently ignore
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [addToast]);

  // Export downloads list
  const handleExport = useCallback((format: 'json' | 'csv') => {
    const data = downloads.map(d => ({
      name: d.name,
      status: d.status,
      progress: Math.round(d.progress * 100) + '%',
      size: formatBytes(d.totalSize),
      downloadedBytes: formatBytes(d.downloadedBytes),
      uploadedBytes: formatBytes(d.uploadedBytes),
      addedAt: formatDate(d.createdAt),
      savePath: d.savePath,
    }));

    let content: string;
    let filename: string;
    let mimeType: string;

    if (format === 'json') {
      content = JSON.stringify({
        exported_at: new Date().toISOString(),
        total: data.length,
        downloads: data
      }, null, 2);
      filename = `downloads_${new Date().toISOString().split('T')[0]}.json`;
      mimeType = 'application/json';
    } else {
      const headers = ['Name', 'Status', 'Progress', 'Size', 'Downloaded', 'Uploaded', 'Added At', 'Save Path'];
      const rows = data.map(d => [d.name, d.status, d.progress, d.size, d.downloadedBytes, d.uploadedBytes, d.addedAt, d.savePath]);
      content = [headers.join(','), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
      filename = `downloads_${new Date().toISOString().split('T')[0]}.csv`;
      mimeType = 'text/csv';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addToast(`${t('downloads.exportedPrefix')} ${data.length} ${t('downloads.downloadsAs')} ${format.toUpperCase()}`, 'success');
  }, [downloads, addToast]);

  // Header sort handler
  const handleHeaderSort = useCallback((mode: SortMode) => {
    if (sortMode === mode) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortMode(mode);
      setSortDirection('desc');
    }
  }, [sortMode]);

  const loadDownloads = useCallback(async () => {
    try {
      await downloadsModel.refresh();
    } catch (error) {
      console.error('Failed to load downloads:', error);
      addToast(
        `${t('downloads.failLoad')}: ${error instanceof Error ? error.message : t('downloads.unknownError')}`,
        'error', 0, { object: t('downloads.title'), actions: [{ id: 'reload', label: t('downloadHelp.refresh'), kind: 'retry', run: () => downloadsModel.refresh() }], onOpenEvents }
      );
    } finally {
      setLoading(false);
    }
  }, [addToast, t, onOpenEvents]);

  const handleAddTorrentFile = async () => {
    // Prevent duplicate calls while file dialog is open
    if (isAddingTorrent || showFileSelector || showAddLink) return;

    try {
      setIsAddingTorrent(true);
      const paths = await window.api.selectTorrentFiles();
      if (paths.length) { setInitialSources(paths.map(path => ({ sourceType: 'torrent_file', sourceUri: path, label: path.split(/[\\/]/).at(-1) || path }))); setShowAddLink(true); }
    } catch (error) {
      addToast(
        `${t('downloads.failAdd')}: ${error instanceof Error ? error.message : t('downloads.unknownError')}`,
        'error'
      );
    } finally {
      setIsAddingTorrent(false);
    }
  };


  // Pause / resume everything at once (toolbar buttons; tray has the same)
  const handledAddRequest = useRef(0);
  useEffect(() => {
    if (!addTorrentRequest || handledAddRequest.current === addTorrentRequest) return;
    handledAddRequest.current = addTorrentRequest;
    onAddTorrentHandled?.();
    void handleAddTorrentFile();
  }, [addTorrentRequest]);

  const handlePauseAll = async () => {
    try {
      const { paused } = await window.api.pauseAll();
      addToast(paused > 0 ? `${t('downloads.pausedPrefix')} ${paused} ${t('downloads.torrentsWord')}` : t('downloads.nothingToPause'), paused > 0 ? 'success' : 'info');
      loadDownloads();
    } catch (error) {
      addToast(`${t('downloads.failPauseAll')}: ${error instanceof Error ? error.message : t('downloads.unknownError')}`, 'error');
    }
  };

  const handleResumeAll = async () => {
    try {
      const { resumed } = await window.api.resumeAll();
      addToast(resumed > 0 ? `${t('downloads.resumedPrefix')} ${resumed} ${t('downloads.torrentsWord')}` : t('downloads.nothingToResume'), resumed > 0 ? 'success' : 'info');
      loadDownloads();
    } catch (error) {
      addToast(`${t('downloads.failResumeAll')}: ${error instanceof Error ? error.message : t('downloads.unknownError')}`, 'error');
    }
  };

  const handleToggleAltSpeed = async () => {
    try {
      const { altSpeedEnabled } = await window.api.setAltSpeed(!altSpeed);
      setAltSpeed(altSpeedEnabled);
      addToast(altSpeedEnabled ? t('downloads.altSpeedOn') : t('downloads.altSpeedOff'), 'info');
    } catch (error) {
      addToast(`${t('downloads.failToggleSpeed')}: ${error instanceof Error ? error.message : t('downloads.unknownError')}`, 'error');
    }
  };

  const handleFileSelectionConfirm = async (selectedIndices: number[], savePath?: string, options?: DownloadDefaults & { categoryId?: string; name?: string }) => {
    // Re-entry guard: a second click while the add is in flight used to fire a
    // second addDownload and surface a confusing "already being added" error.
    if (!pendingTorrent || isAddingTorrent) return;
    const generation = queueGeneration.current;

    const request = {
      sourceType: (pendingTorrent.path ? 'torrent_file' : 'magnet') as 'torrent_file' | 'magnet',
      sourceUri: pendingTorrent.path || pendingTorrent.magnetUri!,
      selectedFiles: selectedIndices,
      ...options,
      savePath,
    };

    // Keep the chosen category/path available if main rejects the destination.
    setIsAddingTorrent(true);

    try {
      const download = await window.api.addDownload(request);
      firstSteps.downloadAdded(download.id);
      if (generation === queueGeneration.current) advanceSource();
      setSelectedFile(null);

      // De-dupe by id: a re-add of a previously failed download returns the
      // EXISTING record, which may already be in the list.
      setDownloads((prev) => [download, ...prev.filter((d) => d.id !== download.id)]);

      addToast(
        selectedIndices.length ? `${t('downloads.downloadAddedWith')} ${selectedIndices.length} ${selectedIndices.length > 1 ? t('downloads.filesWord') : t('downloads.fileWord')}`
          : t('downloads.downloadAddedAllFiles'),
        'success'
      );
    } catch (error) {
      addToast(`${t('downloads.failAddTorrent')}: ${cleanError(error)}`, 'error');
      throw error;
    } finally {
      setIsAddingTorrent(false);
    }
  };

  const handleFileSelectorCancel = () => {
    queueGeneration.current++; queuedSources.current = []; setQueueProgress({ position: 0, total: 0 });
    setShowFileSelector(false);
    setPendingTorrent(null);
    setSelectedFile(null);
  };

  const handleClearSelection = () => {
    setSelectedFile(null);
  };

  type RowCommand = 'pause' | 'resume' | 'stop' | 'retry';
  const runRowCommand = useCallback(async (id: string, command: RowCommand) => {
    if (pendingRowCommands.current.has(id)) throw new Error(t('navigation.waitWork'));
    pendingRowCommands.current.add(id);
    try {
      const current = (await window.api.getDownloads()).find(download => download.id === id && download.status !== 'removed');
      if (!current) throw new Error('Download not found');
      const needed = command === 'pause' ? canPause(current.status) : command === 'resume' ? canResume(current.status) : command === 'stop' ? current.status === 'seeding' : current.status === 'error';
      if (needed) {
        if (command === 'pause') await window.api.pauseDownload(id);
        else if (command === 'resume') await window.api.resumeDownload(id);
        else if (command === 'stop') await window.api.stopSeeding(id);
        else await window.api.retryDownload(id);
      }
      await loadDownloads();
    } finally { pendingRowCommands.current.delete(id); }
  }, [loadDownloads, t]);
  const attemptRowCommand = useCallback(async (id: string, command: RowCommand) => {
    try { await runRowCommand(id, command); }
    catch (error) {
      const failure = { pause: 'downloads.failPause', resume: 'downloads.failResume', stop: 'downloads.failStopSeeding', retry: 'downloads.failRetry' } as const;
      const label = { pause: 'downloads.pause', resume: 'downloads.resume', stop: 'downloads.stopSeeding', retry: 'downloads.retry' } as const;
      addToast(t(failure[command]) + ': ' + (error instanceof Error ? error.message : String(error)), 'error', 0, {
        object: downloadsModel.store.getState().byId.get(id)?.name ?? id,
        actions: [{ id: command, label: t(label[command]), kind: 'retry', run: () => runRowCommand(id, command) }, { id: 'inspect', label: t('downloads.help'), run: () => setHelpId(id) }, { id: 'folder', label: t('downloads.recovery.folder'), run: async () => {
          const current = await window.api.getDownloads();
          if (!current.some(row => row.id === id && row.status !== 'removed')) throw new Error('Download not found');
          downloadsModel.updateDownloads(() => current); setControlModalId(id);
        } }], onOpenEvents,
      });
    }
  }, [runRowCommand, addToast, onOpenEvents, t]);
  const handlePause = useCallback((id: string) => attemptRowCommand(id, 'pause'), [attemptRowCommand]);
  const handleResume = useCallback((id: string) => attemptRowCommand(id, 'resume'), [attemptRowCommand]);
  const handleStopSeeding = useCallback((id: string) => attemptRowCommand(id, 'stop'), [attemptRowCommand]);
  const handleRetry = useCallback((id: string) => attemptRowCommand(id, 'retry'), [attemptRowCommand]);

  const handleRemove = useCallback(async (id: string, deleteFiles: boolean) => {
    if (deleteFiles) { setDeletionId(id); return; }
    if (removingIds.current.has(id)) return;
    removingIds.current.add(id);
    try {
      const result = await window.api.removeDownload(id, deleteFiles);
      setDownloads((prev) => prev.filter((d) => d.id !== id));
      addToast(
        deleteFiles ? t('downloads.removedWithFiles') : t('downloads.removedKeepFiles'),
        'success'
      );
      if (result?.unavailable) addToast(t(`undo.error.${result.unavailable}`), 'warning');
    } catch (error) {
      addToast(
        `${t('downloads.failRemove')}: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    } finally { removingIds.current.delete(id); }
  }, [addToast]);

  const handleRecheck = useCallback(async (id: string) => {
    try {
      await window.api.recheckDownload(id);
      addToast(t('downloads.rechecking'), 'success');
      loadDownloads();
    } catch (error) {
      addToast(
        `${t('downloads.failRecheck')}: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }, [addToast, loadDownloads]);

  const handleReannounce = useCallback(async (id: string) => {
    try {
      await window.api.reannounceDownload(id);
      addToast(t('downloads.reannouncing'), 'success');
    } catch (error) {
      addToast(
        `${t('tcm.failed')}: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }, [addToast]);

  const handleMoveData = useCallback(async (id: string) => {
    try {
      const dest = await window.api.selectDirectory();
      if (!dest) return;
      await window.api.setDownloadLocation(id, dest, true);
      await loadDownloads();
    } catch (error) {
      addToast(
        `${t('tcm.failed')}: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }, [addToast, loadDownloads]);

  const handleOpenFolder = useCallback(async (path: string) => {
    try {
      await window.api.openPath(path);
    } catch (error) {
      console.error('Failed to open folder:', error);
      addToast(t('downloads.failOpenFolder'), 'error');
    }
  }, [addToast]);

  // Selection handler
  const handleSelectItem = useCallback((id: string) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }, []);

  // Context menu handler
  const handleContextMenu = useCallback((e: React.MouseEvent, downloadId: string) => {
    e.preventDefault();
    const rect = e.type === 'click' ? e.currentTarget.getBoundingClientRect() : null;
    setContextMenu({
      x: rect?.left ?? e.clientX,
      y: rect?.bottom ?? e.clientY,
      downloadId
    });
  }, []);

  // Filter downloads based on filter mode
  const filteredDownloads = useMemo(() => downloads.filter(compileDownloadView(conditions)), [downloads, conditions]);
  visibleIds.current = filteredDownloads.map(download => download.id);
  useEffect(() => {
    if (focusRequest) return;
    const visible = new Set(visibleIds.current);
    setSelectedIds(previous => [...previous].some(id => !visible.has(id)) ? new Set([...previous].filter(id => visible.has(id))) : previous);
  }, [filteredDownloads, focusRequest]);

  // Sort downloads based on sort mode and direction.
  // Convention: every comparator returns ascending order for direction=1, so
  // 'asc'/'desc' mean the same thing in every column.
  //
  // Only the 'progress'/'speed' modes read live stats, so only those depend on
  // the per-tick stats Map. For 'name'/'added' the memo stays stable across stats
  // ticks (statsForSort is null), so we don't re-sort the whole list ~1.3x/second.
  const statsForSort = useDownloads(s => (sortMode === 'progress' || sortMode === 'speed') ? s.statsById : null);
  const sortedDownloads = useMemo(() => [...filteredDownloads].sort((a, b) => {
    const direction = sortDirection === 'asc' ? 1 : -1;

    switch (sortMode) {
      case 'name':
        return a.name.localeCompare(b.name) * direction;
      case 'progress': {
        const progressA = statsForSort?.get(a.id)?.progress ?? a.progress;
        const progressB = statsForSort?.get(b.id)?.progress ?? b.progress;
        return (progressA - progressB) * direction;
      }
      case 'speed': {
        const speedA = statsForSort?.get(a.id)?.downSpeedBps ?? 0;
        const speedB = statsForSort?.get(b.id)?.downSpeedBps ?? 0;
        return (speedA - speedB) * direction;
      }
      case 'added':
      default:
        return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * direction;
    }
  }), [filteredDownloads, sortMode, sortDirection, statsForSort]);

  // Virtualize the downloads list so only the rows in view are mounted. The list
  // is its own scroll container (scrollMargin stays 0); rows are absolutely
  // positioned and measured dynamically, so compact/detailed/expanded heights
  // are all handled. estimateSize only seeds the first paint.
  const rowVirtualizer = useVirtualizer({
    count: sortedDownloads.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => (viewMode === 'detailed' ? 168 : 76),
    // Layout changes can resize the viewport and rows in one observer cycle.
    useAnimationFrameWithResizeObserver: true,
    getItemKey: (index) => sortedDownloads[index].id,
    overscan: 8,
  });

  // Address a download by ID, independently of names, filters and sort order.
  useEffect(() => {
    if (!focusRequest || loading) return;
    if (!downloadsById.has(focusRequest.id)) {
      addToast(t('commands.missing'), 'warning'); onFocusHandled?.(); return;
    }
    setSearchQuery(''); setAdvancedFilters({ path: '' }); setFilterMode('all');
    setSelectedIds(new Set([focusRequest.id]));
  }, [focusRequest, loading]);
  useLayoutEffect(() => {
    if (!focusRequest || loading || searchQuery || filterMode !== 'all') return;
    const index = sortedDownloads.findIndex(d => d.id === focusRequest.id);
    if (index < 0) return;
    rowVirtualizer.scrollToIndex(index, { align: 'center' });
    const win = scrollParentRef.current?.ownerDocument.defaultView ?? window;
    let frame = 0;
    let attempts = 0;
    const focus = () => {
      const row = [...(scrollParentRef.current?.querySelectorAll<HTMLElement>('[data-download-id]') ?? [])]
        .find(el => el.dataset.downloadId === focusRequest.id);
      if (row) { row.focus({ preventScroll: true }); onFocusHandled?.(); }
      else if (++attempts < 120) frame = win.requestAnimationFrame(focus);
      else { addToast(t('commands.failed'), 'warning'); onFocusHandled?.(); }
    };
    frame = win.requestAnimationFrame(focus);
    return () => win.cancelAnimationFrame(frame);
  }, [focusRequest, loading, searchQuery, filterMode, sortedDownloads, rowVirtualizer]);

  // Invalidate offscreen heights, then measure mounted rows before paint. Some
  // rows were already expanded and keep the same height, so ResizeObserver
  // won't report them again after measure() clears the cache.
  useLayoutEffect(() => {
    rowVirtualizer.measure();
    // Rebuild the estimated positions before measuring: resizeItem compares
    // with those positions and skips an unchanged size, even after cache reset.
    rowVirtualizer.getTotalSize();
    scrollParentRef.current?.querySelectorAll<HTMLElement>('.downloads-vrow')
      .forEach(rowVirtualizer.measureElement);
  }, [viewMode, rowVirtualizer]);

  if (loading) {
    return (
      <div className="page-loading">
        <span className="spinner spinner-lg" />
        <p>{t('downloads.loadingDownloads')}</p>
      </div>
    );
  }

  return (
    <div
      className="page-container downloads-page"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="page-header">
        <div className="page-title-block">
          <h1 className="page-title">{t('downloads.title')}</h1>
          {downloads.length > 0 && (
            <DownloadSubtitle />
          )}
        </div>
        <div className="page-actions">
          <Button variant="primary" size="sm" icon={<Icon name="plus" size={16} />} disabled={isAddingTorrent || showFileSelector || showAddLink} onClick={() => { setInitialSources([]); setShowAddLink(true); }} className="add-download-link-btn">{t('downloads.add')}</Button>
          <Button variant="secondary" size="sm" icon={<Icon name="search" size={16} />} onClick={() => setShowSearch(true)}>{t('downloads.searchTorrents')}</Button>
          <DropdownMenu portal renderTrigger={({ open, toggle }) => <Button variant="secondary" size="sm" icon={<Icon name="more-horizontal" size={16} />} onClick={toggle} aria-haspopup="menu" aria-expanded={open}>{t('downloads.tools')}</Button>} items={[
            { key: 'file', label: t('downloads.addTorrent'), onSelect: handleAddTorrentFile, disabled: isAddingTorrent || showFileSelector || showAddLink },
            { key: 'compact', label: t('downloads.compactView'), onSelect: () => handleChangeViewMode('compact') },
            { key: 'detailed', label: t('downloads.detailedView'), onSelect: () => handleChangeViewMode('detailed') },
            { key: 'pause', label: t('downloads.pauseAll'), onSelect: () => { void handlePauseAll(); } },
            { key: 'resume', label: t('downloads.resumeAll'), onSelect: () => { void handleResumeAll(); } },
            { key: 'alternative', label: altSpeed ? t('downloads.altSpeedOn') : t('downloads.altSpeedOff'), onSelect: () => { void handleToggleAltSpeed(); } },
            { key: 'limits', label: t('downloads.speedLimits'), onSelect: () => setShowSpeedLimits(true) },
            { key: 'done', label: t('downloads.onDone') + ': ' + onDoneLabel(onDoneAction), onSelect: () => setShowCompletionActions(true) },
            { key: 'json', label: t('downloads.exportJson'), onSelect: () => { void handleExport('json'); } },
            { key: 'csv', label: t('downloads.exportCsv'), onSelect: () => { void handleExport('csv'); } },
          ]} />
        </div>
      </div>
      {showCompletionActions && <Modal title={t('downloads.onDone')} icon="power" onClose={() => setShowCompletionActions(false)}><div className="downloads-completion-actions">{onDoneAvailable.map(action => <Button key={action} variant={action === onDoneAction ? 'primary' : 'secondary'} onClick={() => { setShowCompletionActions(false); void handleSelectOnDone(action); }}>{onDoneLabel(action)}</Button>)}</div></Modal>}
      {helpId && <DownloadHelpModal key={helpId} id={helpId} onClose={() => setHelpId(null)} onOpenEvents={onOpenEvents} canOpenSettings={!!onOpenSetting} onAction={async action => {
        if (action === 'resume' || action === 'retry') { await runRowCommand(helpId, action); return; }
        if (action === 'files' || action === 'controls') {
          const current = await window.api.getDownloads();
          if (!current.some(row => row.id === helpId && row.status !== 'removed')) throw new Error('Download not found');
          downloadsModel.updateDownloads(() => current);
        }
        const id = helpId; setHelpId(null);
        if (action === 'files') setPreviewId(id);
        else if (action === 'controls') setControlModalId(id);
        else if (action === 'storage') onOpenSetting?.({ section: 'system', labelKey: 'storage.title', kind: 'card' });
        else if (action === 'privacy') onOpenSetting?.({ section: 'privacy', labelKey: 'privacy.vpnBind', kind: 'row' });
        else setShowSpeedLimits(true);
      }} />}
      {showSpeedLimits && <Modal title={t('effective.title')} icon="gauge" size="lg" onClose={() => setShowSpeedLimits(false)}><EffectiveLimits compact /></Modal>}
      <div className="page-content">
        <DownloadViewsBar config={viewConfig} onApply={applyViewConfig} />
        {/* Modern Search, Filter & Sort Controls */}
        {downloads.length > 0 && (
          <div className="modern-controls">
            {/* Search Bar with Results Count */}
            <div className="modern-search-wrapper">
              <div className="modern-search-box">
                <Icon name="search" size={18} />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder={t('downloads.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="modern-search-input"
                />
                {searchQuery && (
                  <button
                    className="modern-search-clear"
                    onClick={() => setSearchQuery('')}
                    title={t('downloads.clearSearch')}
                  >
                    <Icon name="x" size={16} />
                  </button>
                )}
              </div>

              {/* Results Count */}
              {(searchQuery || filterMode !== 'all' || conditions.category !== undefined || conditions.path || conditions.minBytes !== undefined || conditions.maxBytes !== undefined) && (
                <div className="results-count">
                  <Icon name="info" size={14} />
                  <span>{sortedDownloads.length} {t('downloads.resultsLabel')}</span>
                </div>
              )}
            </div>

            {/* Sort Options */}
            <div className="sort-options-section">
              <span className="section-label">
                <Icon name="arrow-down" size={14} />
                {t('downloads.sortBy')}
              </span>
              <div className="sort-chips">
                <button
                  className={`sort-chip ${sortMode === 'added' ? 'active' : ''}`}
                  onClick={() => handleHeaderSort('added')}
                >
                  <span>{t('downloads.sortAdded')}</span>
                  {sortMode === 'added' && (
                    <Icon name={sortDirection === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} />
                  )}
                </button>
                <button
                  className={`sort-chip ${sortMode === 'name' ? 'active' : ''}`}
                  onClick={() => handleHeaderSort('name')}
                >
                  <span>{t('downloads.sortName')}</span>
                  {sortMode === 'name' && (
                    <Icon name={sortDirection === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} />
                  )}
                </button>
                <button
                  className={`sort-chip ${sortMode === 'progress' ? 'active' : ''}`}
                  onClick={() => handleHeaderSort('progress')}
                >
                  <span>{t('downloads.sortProgress')}</span>
                  {sortMode === 'progress' && (
                    <Icon name={sortDirection === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} />
                  )}
                </button>
                <button
                  className={`sort-chip ${sortMode === 'speed' ? 'active' : ''}`}
                  onClick={() => handleHeaderSort('speed')}
                >
                  <span>{t('downloads.sortSpeed')}</span>
                  {sortMode === 'speed' && (
                    <Icon name={sortDirection === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} />
                  )}
                </button>
              </div>

              {/* Filter chips own conditions; this action resets only sorting. */}
              {(sortMode !== 'added' || sortDirection !== 'desc') && (
                <button
                  className="clear-filters-btn"
                  onClick={() => {
                    setSortMode('added');
                    setSortDirection('desc');
                    scrollParentRef.current?.scrollTo({ top: 0 });
                  }}
                  title={t('downloads.resetSort')}
                >
                  <Icon name="x" size={14} />
                  <span>{t('downloads.resetSort')}</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Bulk Actions Bar */}
        {batchResult && <div className="download-batch-result" role="status">
          <span>{t('downloads.batch.summary').replace('{done}', String(batchResult.succeeded.length)).replace('{skipped}', String(batchResult.skipped.length)).replace('{failed}', String(batchResult.failed.length))}</span>
          {batchResult.failed.length > 0 && <><details><summary>{t('downloads.batch.details')}</summary>{batchResult.failed.slice(0, 50).map(item => <p key={item.id}><strong>{downloadsById.get(item.id)?.name ?? item.id}</strong>: {cleanError(item.error)}</p>)}{batchResult.failed.length > 50 && <p>{t('downloads.batch.more').replace('{count}', String(batchResult.failed.length - 50))}</p>}</details><Button size="sm" variant="secondary" disabled={batchBusy} onClick={() => { void runBatch(batchResult.action, batchResult.failed.map(item => item.id)); }}>{t('downloads.batch.retry')}</Button></>}
          <Button size="sm" variant="ghost" onClick={() => downloadBatchState.setState({ result: null })} aria-label={t('common.close')}><Icon name="x" size={14} /></Button>
        </div>}
        {selectedIds.size > 0 && (
          <div className="bulk-actions-bar">
            <div className="bulk-actions-info">
              <span className="bulk-actions-count">{selectedIds.size} {t('downloads.selected')}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedIds(new Set())}
              >
                {t('downloads.clearSelection')}
              </Button>
            </div>
            <div className="bulk-actions-buttons">
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="pause" size={14} />}
                disabled={batchBusy} onClick={() => { void runBatch('pause', selectedIds); }}
              >
                {t('downloads.pause')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="play" size={14} />}
                disabled={batchBusy} onClick={() => { void runBatch('resume', selectedIds); }}
              >
                {t('downloads.resume')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                icon={<Icon name="trash" size={14} />}
                onClick={async () => {
                  if (await confirm({ message: `${t('downloads.confirmRemoveMany')} (${selectedIds.size})`, danger: true })) {
                    await handleRemoveMany(Array.from(selectedIds));
                  }
                }}
              >
                {t('downloads.remove')}
              </Button>
            </div>
          </div>
        )}

        {/* Drag & Drop zone overlay */}
        <div className={`drop-zone ${isDragging ? 'drop-zone-active' : ''}`}>
          <Icon name="upload" size={48} />
          <div className="drop-zone-text">
            <p className="drop-zone-title">{t('downloads.dropTitle')}</p>
            <p className="drop-zone-subtitle">{t('downloads.dropSubtitle')}</p>
          </div>
        </div>

        {/* File preview */}
        {selectedFile && (
          <div className="file-preview">
            <div className="file-preview-icon">
              <Icon name="file" size={24} />
            </div>
            <div className="file-preview-info">
              <p className="file-preview-name">{selectedFile.name}</p>
              <p className="file-preview-size">
                {formatBytes(selectedFile.size)}
              </p>
            </div>
            <div className="file-preview-actions">
              <Button
                variant="primary"
                icon={<Icon name="plus" size={16} />}
                onClick={handleAddTorrentFile}
              >
                {t('downloads.addSelected')}
              </Button>
              <Button
                variant="ghost"
                iconOnly
                icon={<Icon name="x" size={16} />}
                onClick={handleClearSelection}
                title={t('downloads.clearSelection')}
              />
            </div>
          </div>
        )}

        {/* Downloads list */}
        {sortedDownloads.length === 0 && downloads.length === 0 ? (
          <EmptyState
            icon="download"
            title={t('downloads.emptyTitle')}
            description={t('downloads.emptyDesc')}
          />
        ) : sortedDownloads.length === 0 ? (
          <EmptyState
            icon="search"
            title={t('downloads.noMatchTitle')}
            description={t('downloads.noMatchDesc')}
            action={activeDownloadConditions(conditions).length ? { label: t('views.clearFilters'), onClick: () => applyViewConfig({ ...viewConfig, conditions: clearDownloadCondition(conditions) }) } : undefined}
          />
        ) : (
          <div ref={scrollParentRef} className="downloads-scroll">
            <div
              className={`downloads-list downloads-list-${viewMode} downloads-list-virtual`}
              style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}
            >
              {rowVirtualizer.getVirtualItems().map((vItem) => {
                const download = sortedDownloads[vItem.index];
                return (
                  <div
                    key={vItem.key}
                    data-index={vItem.index}
                    data-download-id={download.id}
                    tabIndex={-1}
                    ref={rowVirtualizer.measureElement}
                    className="downloads-vrow"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vItem.start}px)`,
                    }}
                  >
                    <ConnectedDownloadItem
                      downloadId={download.id}
                      viewMode={viewMode}
                      expanded={expandedIds.has(download.id)}
                      onToggleExpand={handleToggleExpand}
                      isSelected={selectedIds.has(download.id)}
                      onSelect={handleSelectItem}
                      onContextMenu={handleContextMenu}
                      onPause={handlePause}
                      onResume={handleResume}
                      onRemove={handleRemove}
                      onStopSeeding={handleStopSeeding}
                      onRetry={handleRetry}
                      onOpenFolder={handleOpenFolder}
                      onShowFiles={setPreviewId}
                      onInspect={setHelpId}
                      onStream={setStreamModalId}
                      onShare={setShareRoomId}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {previewId && (
          <FilePreview
            downloadId={previewId}
            onClose={() => setPreviewId(null)}
          />
        )}

        {/* Search torrents without leaving the add flow */}
        {showSearch && (
          <TorrentSearchModal
            onClose={() => setShowSearch(false)}
            onAdd={async (request) => {
              const download = await window.api.addDownload(request);
              firstSteps.downloadAdded(download.id);
              // De-dupe by id, as the file-selector path does: a re-add of a
              // previously failed download returns the EXISTING record.
              setDownloads((prev) => [download, ...prev.filter((d) => d.id !== download.id)]);
              addToast(`${t('downloads.downloadAddedWith')} ${request.name || ''}`.trim(), 'success');
            }}
          />
        )}

        {/* Torrent File Selector */}
        {deletionId && <DownloadDeletionModal id={deletionId} onClose={() => setDeletionId(null)} onRemoved={(result, deleted) => {
          setDownloads(prev => prev.filter(download => download.id !== deletionId)); setDeletionId(null);
          addToast(t(deleted ? 'downloads.removedWithFiles' : 'downloads.removedKeepFiles'), 'success');
          if (result.unavailable) addToast(t(`undo.error.${result.unavailable}`), 'warning');
        }} />}
        {showAddLink && <AddDownloadsModal initialFiles={initialSources} onClose={() => setShowAddLink(false)} onConfirm={startSources} />}
        {showFileSelector && pendingTorrent && (
          <TorrentFileSelector
            key={pendingTorrent.path || pendingTorrent.magnetUri}
            queueNote={queueProgress.total > 1 ? t('downloads.queue.position').replace('{current}', String(queueProgress.position)).replace('{total}', String(queueProgress.total)) : undefined}
            onSkip={queueProgress.total > 1 ? advanceSource : undefined}
            torrentPath={pendingTorrent.path}
            magnetUri={pendingTorrent.magnetUri}
            onConfirm={handleFileSelectionConfirm}
            allowCategory
            onCancel={handleFileSelectorCancel}
          />
        )}
      </div>

      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} onClose={removeToast} />

      {/* Context Menu */}
      {automation && <AutomationDraftModal draft={automation} onClose={() => setAutomation(null)} />}
      {contextMenu && (
        <ContextMenu
          autoFocus
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            { label: t('downloads.help'), icon: 'info', onClick: () => { setHelpId(contextMenu.downloadId); setContextMenu(null); } },
            { label: t('automation.from.download'), icon: 'sliders', onClick: () => { const download = downloadsById.get(contextMenu.downloadId); if (download) setAutomation(automationDraft({ download }, crypto.randomUUID())); setContextMenu(null); } },
            {
              label: t('downloads.watchListen'),
              icon: 'play',
              onClick: () => {
                setStreamModalId(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: t('share.toRoom.title'),
              icon: 'users',
              onClick: () => {
                setShareRoomId(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: t('downloads.shareLink'),
              icon: 'share-2',
              onClick: () => {
                setShareModalId(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: t('downloads.advancedControls'),
              icon: 'settings',
              onClick: () => {
                setControlModalId(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: '',
              onClick: () => {},
              divider: true,
            },
            {
              label: t('downloads.pause'),
              icon: 'pause',
              // Only enabled when the current state can actually pause — otherwise
              // clicking threw a red "Cannot pause in <state> state" error toast.
              disabled: !canPause(downloadsById.get(contextMenu.downloadId)?.status ?? 'removed'),
              onClick: () => {
                handlePause(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: t(downloadsById.get(contextMenu.downloadId)?.progress === 1
                ? 'downloads.resumeSeeding' : 'downloads.resume'),
              icon: 'play',
              disabled: !canResume(downloadsById.get(contextMenu.downloadId)?.status ?? 'removed'),
              onClick: () => {
                handleResume(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: t('downloads.files'),
              icon: 'list',
              onClick: () => {
                setPreviewId(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: t('downloads.openFolder'),
              icon: 'folder',
              onClick: () => {
                const download = downloadsById.get(contextMenu.downloadId);
                if (download) {
                  handleOpenFolder(download.savePath);
                }
                setContextMenu(null);
              }
            },
            {
              label: t('downloads.forceRecheck'),
              icon: 'refresh-cw',
              disabled: downloadsModel.store.getState().statsById.get(contextMenu.downloadId)?.operation?.stage === 'checking',
              onClick: () => {
                handleRecheck(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: t('downloads.reannounce'),
              icon: 'refresh',
              onClick: () => {
                void handleReannounce(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: t('downloads.moveData'),
              icon: 'folder',
              onClick: () => {
                void handleMoveData(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: '',
              onClick: () => {},
              divider: true,
            },
            {
              label: t('downloads.remove'),
              icon: 'trash',
              danger: true,
              onClick: async () => {
                if (await confirm({ message: t('downloads.confirmRemove'), danger: true })) {
                  handleRemove(contextMenu.downloadId, false);
                }
                setContextMenu(null);
              }
            },
            {
              label: t('downloads.deleteWithFiles'),
              icon: 'trash',
              danger: true,
              onClick: async () => {
                handleRemove(contextMenu.downloadId, true);
                setContextMenu(null);
              }
            }
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Torrent Control Modal */}
      {controlModalDownload && (
        <TorrentControlModal
          key={controlModalDownload.id}
          download={controlModalDownload}
          onClose={() => setControlModalId(null)}
          onUpdate={loadDownloads}
        />
      )}

      {/* In-app stream player */}
      {streamModalDownload && (
        <StreamPlayerModal
          downloadId={streamModalDownload.id}
          downloadName={streamModalDownload.name}
          onClose={() => setStreamModalId(null)}
        />
      )}

      {/* Share link */}
      {shareModalDownload && (
        <ShareLinkModal
          downloadId={shareModalDownload.id}
          downloadName={shareModalDownload.name}
          onClose={() => setShareModalId(null)}
        />
      )}

      {/* Share to room (Phase-5 cross-link) */}
      {shareRoomDownload && (
        <ShareToRoomModal
          downloadId={shareRoomDownload.id}
          downloadName={shareRoomDownload.name}
          canShare={
            (shareRoomProgress ?? shareRoomDownload.progress) >= 1 ||
            ['completed', 'seeding'].includes(shareRoomDownload.status)
          }
          onClose={() => setShareRoomId(null)}
          onShareLink={() => {
            setShareModalId(shareRoomDownload.id);
            setShareRoomId(null);
          }}
        />
      )}
    </div>
  );
};

const DownloadSubtitle: React.FC = () => {
  const downloading = useDownloads(s => s.counts.downloading), seeding = useDownloads(s => s.counts.seeding);
  // Subscribe to the displayed ratio rather than the complete stats map.
  const ratio = useDownloads(s => s.totals.downloaded > 0 ? (s.totals.uploaded / s.totals.downloaded).toFixed(1) : null);
  return <div className="page-subtitle">↓ {downloading} · ↑ {seeding}{ratio !== null && (' · ' + ratio + '×')}</div>;
};

export default DownloadsPage;
