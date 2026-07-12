/**
 * Downloads Page
 * 
 * Main downloads management page with compact/detailed view modes.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CompletionAction, Download, DownloadStats } from '../../shared/types';
import { canPause, canResume } from '../../shared/state-machine';
import {
  Button,
  Icon,
  ToastContainer,
  EmptyState,
  FilePreview,
  ContextMenu,
  TorrentFileSelector,
  TorrentControlModal,
  StreamPlayerModal,
  ShareLinkModal,
  ShareToRoomModal,
  useConfirm,
} from '../components';
import './DownloadsPage.css';

import {
  ViewMode, FilterMode, SortMode,
  formatBytes, formatDate,
} from './download-helpers';
import { DownloadItem } from './DownloadItem';
import { cleanError } from '../utils/format-helpers';
import { useTranslation } from '../utils/i18nContext';


interface DownloadsPageProps {
  filterMode?: FilterMode;
  onFilterChange?: (filter: FilterMode) => void;
  // A torrent file path / magnet URI opened from the OS; opens the add dialog
  openTorrentUri?: string | null;
  onOpenHandled?: () => void;
}

// Last stats snapshot, kept at module scope so it survives the page unmounting.
// Pages unmount on tab switch; a fresh mount used to start with an empty stats
// map, so every return to Downloads flashed "no peers" on active rows until the
// next stats tick arrived (~1s later).
let lastStatsSnapshot: Map<string, DownloadStats> | null = null;

const DownloadsPage: React.FC<DownloadsPageProps> = ({
  filterMode: externalFilterMode = 'all',
  onFilterChange,
  openTorrentUri,
  onOpenHandled
}) => {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [stats, setStats] = useState<Map<string, DownloadStats>>(() => lastStatsSnapshot ?? new Map());
  const [loading, setLoading] = useState(true);

  // Toast notifications
  const [toasts, setToasts] = useState<Array<{
    id: string;
    message: string;
    variant?: 'success' | 'error' | 'warning' | 'info';
    duration?: number;
  }>>([]);

  // UI State
  const [viewMode, setViewMode] = useState<ViewMode>('compact');
  // Per-row accordion: which compact rows are expanded to full detail.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  // Use external filter mode from props
  const filterMode = externalFilterMode;
  const [sortMode, setSortMode] = useState<SortMode>('added');
  const [searchQuery, setSearchQuery] = useState('');

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Context menu state
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
  const [altSpeed, setAltSpeed] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Torrent control modal
  const [controlModalId, setControlModalId] = useState<string | null>(null);
  const controlModalDownload = controlModalId ? downloads.find(d => d.id === controlModalId) : null;
  const [streamModalId, setStreamModalId] = useState<string | null>(null);
  const streamModalDownload = streamModalId ? downloads.find(d => d.id === streamModalId) : null;
  const [shareModalId, setShareModalId] = useState<string | null>(null);
  const shareModalDownload = shareModalId ? downloads.find(d => d.id === shareModalId) : null;
  // "Share to room" — the row's Share button + context menu
  const [shareRoomId, setShareRoomId] = useState<string | null>(null);
  const shareRoomDownload = shareRoomId ? downloads.find(d => d.id === shareRoomId) : null;

  // Refs
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollParentRef = useRef<HTMLDivElement>(null);

  // File selector state
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [pendingTorrent, setPendingTorrent] = useState<{
    path?: string;
    magnetUri?: string;
  } | null>(null);
  const [isAddingTorrent, setIsAddingTorrent] = useState(false);

  // On-completion action (one-shot; main owns the state, this mirrors it)
  const [onDoneAction, setOnDoneAction] = useState<CompletionAction>('none');
  const [onDoneAvailable, setOnDoneAvailable] = useState<CompletionAction[]>(['none', 'quit']);
  const [showOnDoneMenu, setShowOnDoneMenu] = useState(false);

  // Toast helper
  const addToast = useCallback((message: string, variant: 'success' | 'error' | 'warning' | 'info' = 'info', duration = 5000) => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, message, variant, duration }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

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

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.name.endsWith('.torrent')) {
        // Clear any leftover state from a previous drop
        setSelectedFile(null);

        // Resolve the dropped file's path (webUtils / legacy File.path) and open
        // the file selector dialog.
        const filePath = window.api.getPathForFile(file);
        if (filePath) {
          setPendingTorrent({ path: filePath });
          setShowFileSelector(true);
        } else {
          // Fallback: keep the file for the "Add Selected Torrent" button
          setSelectedFile(file);
        }
      } else {
        addToast(t('downloads.dropTorrentOnly'), 'error');
      }
    }
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

  // Load downloads on mount
  useEffect(() => {
    loadDownloads();
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
    setShowOnDoneMenu(false);
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
    const isMagnet = openTorrentUri.startsWith('magnet:');
    setPendingTorrent(isMagnet ? { magnetUri: openTorrentUri } : { path: openTorrentUri });
    setShowFileSelector(true);
    onOpenHandled?.();
  }, [openTorrentUri]);

  // Subscribe to stats updates
  useEffect(() => {
    const unsubscribe = window.api.onDownloadStats((newStats) => {

      const statsMap = new Map<string, DownloadStats>();
      for (const stat of newStats) {
        statsMap.set(stat.id, stat);
      }
      lastStatsSnapshot = statsMap;
      setStats(statsMap);

      // Update download statuses from stats — ONLY when a status actually flips.
      // Rows read live progress/speed from the stats Map, so rebuilding every
      // download object each tick just churns GC and re-sorts the whole list for
      // nothing. Same-reference return makes React skip the update.
      setDownloads((prev) => {
        let changed = false;
        const next = prev.map((d) => {
          const stat = statsMap.get(d.id);
          if (stat && stat.status !== d.status) { changed = true; return { ...d, status: stat.status }; }
          return d;
        });
        return changed ? next : prev;
      });
    });

    // Cleanup listener on unmount to prevent memory leaks
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  // Load the alternative-speed toggle state on mount (reflects the toolbar button)
  useEffect(() => {
    window.api.getAltSpeed().then(({ altSpeedEnabled }) => setAltSpeed(altSpeedEnabled)).catch(() => {});
  }, []);

  // (Filter/sort dropdown state was removed — sorting lives in the list header)

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // A modal owns the keyboard while open — page-level shortcuts (Delete,
      // Space, Ctrl+A) acting on the list underneath would be destructive.
      if (shareRoomId || shareModalId || streamModalId || controlModalId || previewId || showFileSelector) return;
      const target = e.target as HTMLElement;
      const isInInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      // Ctrl+A - Select all downloads
      if (e.ctrlKey && e.key === 'a' && !isInInput) {
        e.preventDefault();
        setSelectedIds(new Set(downloads.map(d => d.id)));
      }

      // Delete - Remove selected downloads
      if (e.key === 'Delete' && selectedIds.size > 0 && !isInInput) {
        e.preventDefault();
        if (await confirm({ message: `${t('downloads.confirmRemoveMany')} (${selectedIds.size})`, danger: true })) {
          const idsToRemove = Array.from(selectedIds);
          Promise.all(idsToRemove.map(id => window.api.removeDownload(id, false)))
            .then(() => {
              setDownloads((prev) => prev.filter((d) => !selectedIds.has(d.id)));
              setSelectedIds(new Set());
              addToast(`${t('downloads.removedPrefix')} ${selectedIds.size} ${t('downloads.downloadsWord')}`, 'success');
            })
            .catch((error) => {
              console.error('Failed to remove some downloads:', error);
              loadDownloads();
            });
        }
      }

      // Space - Toggle pause/resume for selected
      if (e.key === ' ' && selectedIds.size > 0 && !isInInput) {
        e.preventDefault();
        const promises = Array.from(selectedIds).map(async (id) => {
          const download = downloads.find(d => d.id === id);
          if (download) {
            try {
              if (canPause(download.status)) {
                await window.api.pauseDownload(id);
              } else if (canResume(download.status)) {
                await window.api.resumeDownload(id);
              }
            } catch (error) {
              console.error('Failed to toggle pause/resume:', error);
            }
          }
        });
        Promise.all(promises).then(() => {
          loadDownloads();
        });
      }


      // Ctrl+F - Focus search box
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }

      // Ctrl+P - Toggle view mode
      if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        setViewMode(prev => prev === 'compact' ? 'detailed' : 'compact');
      }

      // Escape - Clear selection
      if (e.key === 'Escape') {
        setSelectedIds(new Set());
        setShowExportMenu(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, downloads, addToast, shareRoomId, shareModalId, streamModalId, controlModalId, previewId, showFileSelector]);

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
    setShowExportMenu(false);
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

  const loadDownloads = async () => {
    try {
      const list = await window.api.getDownloads();
      setDownloads(list.filter(d => d.status !== 'removed'));
    } catch (error) {
      console.error('Failed to load downloads:', error);
      addToast(
        `${t('downloads.failLoad')}: ${error instanceof Error ? error.message : t('downloads.unknownError')}`,
        'error'
      );
    } finally {
      setLoading(false);
    }
  };



  const handleAddTorrentFile = async () => {
    // Prevent duplicate calls while file dialog is open
    if (isAddingTorrent || showFileSelector) return;

    try {
      setIsAddingTorrent(true);
      let torrentPath: string | undefined;

      // Use dropped/selected file path without opening file dialog again if it exists
      if (selectedFile) {
        torrentPath = window.api.getPathForFile(selectedFile) || undefined;
      }
      if (!torrentPath) {
        const result = await window.api.selectTorrentFile();
        if (!result) {
          setIsAddingTorrent(false);
          return;
        }
        torrentPath = result.path;
      }

      // Show file selector to choose which files to download
      setPendingTorrent({ path: torrentPath });
      setShowFileSelector(true);
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

  const handleFileSelectionConfirm = async (selectedIndices: number[]) => {
    // Re-entry guard: a second click while the add is in flight used to fire a
    // second addDownload and surface a confusing "already being added" error.
    if (!pendingTorrent || isAddingTorrent) return;

    const request = {
      sourceType: (pendingTorrent.path ? 'torrent_file' : 'magnet') as 'torrent_file' | 'magnet',
      sourceUri: pendingTorrent.path || pendingTorrent.magnetUri!,
      selectedFiles: selectedIndices,
    };

    // Close the dialog immediately — the engine confirms fast now (metadata
    // resolves in the background) and the row appears in the list.
    setShowFileSelector(false);
    setPendingTorrent(null);
    setSelectedFile(null);
    setIsAddingTorrent(true);

    try {
      const download = await window.api.addDownload(request);

      // De-dupe by id: a re-add of a previously failed download returns the
      // EXISTING record, which may already be in the list.
      setDownloads((prev) => [download, ...prev.filter((d) => d.id !== download.id)]);

      addToast(
        `${t('downloads.downloadAddedWith')} ${selectedIndices.length} ${selectedIndices.length > 1 ? t('downloads.filesWord') : t('downloads.fileWord')}`,
        'success'
      );
    } catch (error) {
      addToast(`${t('downloads.failAddTorrent')}: ${cleanError(error)}`, 'error');
    } finally {
      setIsAddingTorrent(false);
    }
  };

  const handleFileSelectorCancel = () => {
    setShowFileSelector(false);
    setPendingTorrent(null);
    setSelectedFile(null);
  };

  const handleClearSelection = () => {
    setSelectedFile(null);
  };

  const handlePause = useCallback(async (id: string) => {
    try {
      await window.api.pauseDownload(id);
      await loadDownloads();
    } catch (error) {
      addToast(
        `${t('downloads.failPause')}: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }, [addToast]);

  const handleResume = useCallback(async (id: string) => {
    try {
      await window.api.resumeDownload(id);
      await loadDownloads(); // Reload immediately
    } catch (error) {
      addToast(
        `${t('downloads.failResume')}: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }, [addToast]);

  const handleRemove = useCallback(async (id: string, deleteFiles: boolean) => {
    try {
      await window.api.removeDownload(id, deleteFiles);
      setDownloads((prev) => prev.filter((d) => d.id !== id));
      addToast(
        deleteFiles ? t('downloads.removedWithFiles') : t('downloads.removedKeepFiles'),
        'success'
      );
    } catch (error) {
      addToast(
        `${t('downloads.failRemove')}: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }, [addToast]);

  const handleStopSeeding = useCallback(async (id: string) => {
    try {
      await window.api.stopSeeding(id);
      await loadDownloads(); // Reflect the new 'completed' status immediately
    } catch (error) {
      addToast(
        `${t('downloads.failStopSeeding')}: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }, [addToast, loadDownloads]);

  const handleRetry = useCallback(async (id: string) => {
    try {
      await window.api.retryDownload(id);
      addToast(t('downloads.retrying'), 'success');
      await loadDownloads(); // Reflect the re-queued status immediately
    } catch (error) {
      addToast(
        `${t('downloads.failRetry')}: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }, [addToast, loadDownloads]);

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
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      downloadId
    });
  }, []);

  // Filter downloads based on filter mode
  const filteredDownloads = useMemo(() => downloads.filter(download => {
    // Filter by status
    if (filterMode !== 'all') {
      if (filterMode === 'downloading' && !['downloading', 'queued'].includes(download.status)) {
        return false;
      }
      if (filterMode === 'completed' && !['completed', 'seeding'].includes(download.status)) {
        return false;
      }
      if (filterMode !== 'downloading' && filterMode !== 'completed' && download.status !== filterMode) {
        return false;
      }
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return download.name.toLowerCase().includes(query);
    }

    return true;
  }), [downloads, filterMode, searchQuery]);

  // Sort downloads based on sort mode and direction.
  // Convention: every comparator returns ascending order for direction=1, so
  // 'asc'/'desc' mean the same thing in every column.
  //
  // Only the 'progress'/'speed' modes read live stats, so only those depend on
  // the per-tick stats Map. For 'name'/'added' the memo stays stable across stats
  // ticks (statsForSort is null), so we don't re-sort the whole list ~1.3x/second.
  const statsForSort = (sortMode === 'progress' || sortMode === 'speed') ? stats : null;
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

  // Header sub-line: "↓ n · ↑ n · ratio×" (language-neutral, mirrors the concept's
  // "3 downloading · 12 seeding · giving back 2.4×")
  const headerCounts = {
    downloading: downloads.filter(d => ['downloading', 'queued'].includes(d.status)).length,
    seeding: downloads.filter(d => d.status === 'seeding').length,
  };
  // Byte totals prefer the live per-tick stats (the download records only
  // refresh on explicit reloads, so the ratio would otherwise freeze).
  const totalDownloadedBytes = downloads.reduce((sum, d) => sum + (stats.get(d.id)?.downloadedBytes ?? d.downloadedBytes), 0);
  const totalUploadedBytes = downloads.reduce((sum, d) => sum + (stats.get(d.id)?.uploadedBytes ?? d.uploadedBytes), 0);
  const aggregateRatio = totalDownloadedBytes > 0 ? totalUploadedBytes / totalDownloadedBytes : null;

  // Virtualize the downloads list so only the rows in view are mounted. The list
  // is its own scroll container (scrollMargin stays 0); rows are absolutely
  // positioned and measured dynamically, so compact/detailed/expanded heights
  // are all handled. estimateSize only seeds the first paint.
  const rowVirtualizer = useVirtualizer({
    count: sortedDownloads.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => (viewMode === 'detailed' ? 168 : 76),
    getItemKey: (index) => sortedDownloads[index].id,
    overscan: 8,
  });

  // Item heights change wholesale when the view mode flips — drop the cached
  // measurements so rows aren't briefly positioned with stale sizes.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [viewMode]);

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
      className="page-container"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="page-header">
        <div className="page-title-block">
          <h1 className="page-title">{t('downloads.title')}</h1>
          {downloads.length > 0 && (
            <div className="page-subtitle">
              ↓ {headerCounts.downloading} · ↑ {headerCounts.seeding}
              {aggregateRatio !== null && ` · ${aggregateRatio.toFixed(1)}×`}
            </div>
          )}
        </div>
        <div className="page-actions">
          <div className="view-mode-toggle">
            <Button
              variant={viewMode === 'compact' ? 'primary' : 'ghost'}
              size="sm"
              iconOnly
              icon={<Icon name="list" size={16} />}
              onClick={() => setViewMode('compact')}
              title={t('downloads.compactView')}
            />
            <Button
              variant={viewMode === 'detailed' ? 'primary' : 'ghost'}
              size="sm"
              iconOnly
              icon={<Icon name="grid" size={16} />}
              onClick={() => setViewMode('detailed')}
              title={t('downloads.detailedView')}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="pause" size={16} />}
            onClick={handlePauseAll}
            title={t('downloads.pauseAll')}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="play" size={16} />}
            onClick={handleResumeAll}
            title={t('downloads.resumeAll')}
          />
          <Button
            variant={altSpeed ? 'primary' : 'ghost'}
            size="sm"
            iconOnly
            icon={<Icon name="gauge" size={16} />}
            onClick={handleToggleAltSpeed}
            title={altSpeed ? t('downloads.altSpeedOn') : t('downloads.altSpeedOff')}
          />
          {/* On-completion action (one-shot) */}
          <div className="dropdown-wrapper">
            <Button
              variant={onDoneAction !== 'none' ? 'primary' : 'ghost'}
              size="sm"
              iconOnly
              icon={<Icon name="power" size={16} />}
              onClick={() => setShowOnDoneMenu(!showOnDoneMenu)}
              title={`${t('downloads.onDone')}: ${onDoneLabel(onDoneAction)}`}
            />
            {showOnDoneMenu && (
              <div className="dropdown-menu export-dropdown">
                {onDoneAvailable.map((a) => (
                  <button
                    key={a}
                    className="dropdown-item"
                    onClick={() => handleSelectOnDone(a)}
                  >
                    <Icon name={onDoneAction === a ? 'check-circle' : 'circle'} size={16} />
                    <span>{onDoneLabel(a)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="refresh" size={16} />}
            onClick={loadDownloads}
            title={t('downloads.refresh')}
          />
          {/* Export Dropdown */}
          <div className="dropdown-wrapper">
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="download" size={16} />}
              onClick={() => setShowExportMenu(!showExportMenu)}
              title={t('downloads.exportList')}
            >
              {t('downloads.export')}
            </Button>
            {showExportMenu && (
              <div className="dropdown-menu export-dropdown">
                <button
                  className="dropdown-item"
                  onClick={() => handleExport('json')}
                >
                  <Icon name="file" size={16} />
                  <span>{t('downloads.exportJson')}</span>
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => handleExport('csv')}
                >
                  <Icon name="grid" size={16} />
                  <span>{t('downloads.exportCsv')}</span>
                </button>
              </div>
            )}
          </div>
          <Button
            variant="primary"
            size="sm"
            icon={<Icon name="plus" size={16} />}
            onClick={handleAddTorrentFile}
            className="add-torrent-btn"
          >
            <span className="btn-text">{t('downloads.addTorrent')}</span>
          </Button>
        </div>
      </div>

      <div className="page-content">
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
              {(searchQuery || filterMode !== 'all') && (
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

              {/* Clear All Filters Button */}
              {(filterMode !== 'all' || searchQuery || sortMode !== 'added' || sortDirection !== 'desc') && (
                <button
                  className="clear-filters-btn"
                  onClick={() => {
                    onFilterChange?.('all');
                    setSearchQuery('');
                    setSortMode('added');
                    setSortDirection('desc');
                  }}
                  title={t('downloads.resetFilters')}
                >
                  <Icon name="x" size={14} />
                  <span>{t('downloads.clearAll')}</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Bulk Actions Bar */}
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
                onClick={async () => {
                  const promises = Array.from(selectedIds).map(id => window.api.pauseDownload(id).catch(err => console.error(err)));
                  await Promise.all(promises);
                  await loadDownloads();
                  setSelectedIds(new Set());
                }}
              >
                {t('downloads.pause')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="play" size={14} />}
                onClick={async () => {
                  const promises = Array.from(selectedIds).map(id => window.api.resumeDownload(id).catch(err => console.error(err)));
                  await Promise.all(promises);
                  await loadDownloads();
                  setSelectedIds(new Set());
                }}
              >
                {t('downloads.resume')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                icon={<Icon name="trash" size={14} />}
                onClick={async () => {
                  if (await confirm({ message: `${t('downloads.confirmRemoveMany')} (${selectedIds.size})`, danger: true })) {
                    const promises = Array.from(selectedIds).map(id => window.api.removeDownload(id, false).catch(err => console.error(err)));
                    await Promise.all(promises);
                    await loadDownloads();
                    setSelectedIds(new Set());
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
                    <DownloadItem
                      download={download}
                      stats={stats.get(download.id)}
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
                      onShowFiles={(id) => setPreviewId(id)}
                      onStream={(id) => setStreamModalId(id)}
                      onShare={(id) => setShareRoomId(id)}
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

        {/* Torrent File Selector */}
        {showFileSelector && pendingTorrent && (
          <TorrentFileSelector
            torrentPath={pendingTorrent.path}
            magnetUri={pendingTorrent.magnetUri}
            onConfirm={handleFileSelectionConfirm}
            onCancel={handleFileSelectorCancel}
          />
        )}
      </div>

      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} onClose={removeToast} />

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
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
              disabled: !canPause(downloads.find(d => d.id === contextMenu.downloadId)?.status ?? 'removed'),
              onClick: () => {
                handlePause(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: t('downloads.resume'),
              icon: 'play',
              disabled: !canResume(downloads.find(d => d.id === contextMenu.downloadId)?.status ?? 'removed'),
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
                const download = downloads.find(d => d.id === contextMenu.downloadId);
                if (download) {
                  handleOpenFolder(download.savePath);
                }
                setContextMenu(null);
              }
            },
            {
              label: t('downloads.forceRecheck'),
              icon: 'refresh-cw',
              onClick: () => {
                handleRecheck(contextMenu.downloadId);
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
                if (await confirm({ message: t('downloads.confirmRemoveWithFiles'), danger: true })) {
                  handleRemove(contextMenu.downloadId, true);
                }
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
            (stats.get(shareRoomDownload.id)?.progress ?? shareRoomDownload.progress) >= 1 ||
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

export default DownloadsPage;
