/**
 * Downloads Page
 * 
 * Main downloads management page with compact/detailed view modes.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Download, DownloadStats } from '../../shared/types';
import { canPause, canResume } from '../../shared/state-machine';
import {
  Button,
  Icon,
  Input,
  ProgressBar,
  StatusBadge,
  HealthBadge,
  ToastContainer,
  EmptyState,
  FilePreview,
  ContextMenu,
  ContextMenuItem,
  TorrentFileSelector,
  TorrentControlModal,
  StreamPlayerModal,
  ShareLinkModal,
} from '../components';
import { useTranslation } from '../utils/i18nContext';
import './DownloadsPage.css';

// Utility functions
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatSpeed = (bytesPerSecond: number): string => {
  return formatBytes(bytesPerSecond) + '/s';
};

const formatEta = (seconds: number | null): string => {
  if (seconds === null || seconds <= 0) return '--';
  if (seconds > 86400) return '> 1 day';

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

const formatDate = (dateInput: string | Date): string => {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
};

type ViewMode = 'compact' | 'detailed';
type FilterMode = 'all' | 'downloading' | 'completed' | 'paused' | 'error';
type SortMode = 'name' | 'progress' | 'speed' | 'added';

interface DownloadItemProps {
  download: Download;
  stats: DownloadStats | undefined;
  viewMode: ViewMode;
  isSelected?: boolean;
  onSelect?: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent, id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRemove: (id: string, deleteFiles: boolean) => void;
  onStopSeeding: (id: string) => void;
  onRetry: (id: string) => void;
  onOpenFolder: (path: string) => void;
  onShowFiles: (id: string) => void;
}

const DownloadItem: React.FC<DownloadItemProps> = ({
  download,
  stats,
  viewMode,
  isSelected = false,
  onSelect,
  onContextMenu,
  onPause,
  onResume,
  onRemove,
  onStopSeeding,
  onRetry,
  onOpenFolder,
  onShowFiles,
}) => {
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  const currentStats = stats || {
    progress: download.progress,
    downloadedBytes: download.downloadedBytes,
    uploadedBytes: download.uploadedBytes,
    downSpeedBps: 0,
    upSpeedBps: 0,
    etaSeconds: null,
    peers: 0,
    seeds: 0,
    status: download.status,
  };

  const status = currentStats.status;
  const progress = currentStats.progress;



  const getProgressVariant = (): 'default' | 'success' | 'warning' | 'error' => {
    if (status === 'completed' || status === 'seeding') return 'success';
    if (status === 'error') return 'error';
    if (status === 'paused') return 'warning';
    return 'default';
  };

  if (viewMode === 'compact') {
    return (
      <div
        className={`download-item download-item-compact ${isSelected ? 'selected' : ''}`}
        onContextMenu={(e) => onContextMenu?.(e, download.id)}
      >
        {onSelect && (
          <input
            type="checkbox"
            className="download-checkbox"
            checked={isSelected}
            onChange={() => onSelect(download.id)}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        <div className="download-compact-main">
          <StatusBadge status={status} />
          <div className="download-compact-info">
            <span className="download-item-name truncate">{download.name}</span>
            <div className="download-compact-meta">
              <span className="progress-text">{(progress * 100).toFixed(1)}%</span>
              {(status === 'downloading' || status === 'queued') && (
                <>
                  <span className="meta-separator">•</span>
                  <HealthBadge
                    status={status}
                    seeds={currentStats.seeds}
                    peers={currentStats.peers}
                    downSpeedBps={currentStats.downSpeedBps}
                    progress={progress}
                    variant="full"
                  />
                </>
              )}
              {download.totalSize > 0 && (
                <>
                  <span className="meta-separator">•</span>
                  <span>{formatBytes(download.totalSize)}</span>
                </>
              )}
              {status === 'downloading' && (
                <>
                  <span className="meta-separator">•</span>
                  <span>{formatSpeed(currentStats.downSpeedBps)}</span>
                  <span className="meta-separator">•</span>
                  <span>{formatEta(currentStats.etaSeconds)}</span>
                </>
              )}
              {status === 'error' && download.lastError && (
                <>
                  <span className="meta-separator">•</span>
                  <span className="error-text truncate">{download.lastError}</span>
                </>
              )}
            </div>
          </div>
          <ProgressBar
            value={progress}
            variant={getProgressVariant()}
            className="download-compact-progress"
          />
        </div>

        <div className="download-item-actions">
          {canPause(status) && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="pause" size={14} />}
              onClick={() => onPause(download.id)}
              title="Pause"
            />
          )}

          {canResume(status) && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="play" size={14} />}
              onClick={() => onResume(download.id)}
              title="Resume"
            />
          )}

          {status === 'error' && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="refresh" size={14} />}
              onClick={() => onRetry(download.id)}
              title="Retry"
            />
          )}

          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="list" size={14} />}
            onClick={() => onShowFiles(download.id)}
            title="Files"
          />

          {!showRemoveConfirm ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="trash" size={14} />}
              onClick={() => setShowRemoveConfirm(true)}
              title="Remove"
            />
          ) : (
            <div className="remove-confirm">
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  onRemove(download.id, true);
                  setShowRemoveConfirm(false);
                }}
              >
                + Files
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onRemove(download.id, false);
                  setShowRemoveConfirm(false);
                }}
              >
                Keep
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Icon name="x" size={14} />}
                onClick={() => setShowRemoveConfirm(false)}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Detailed view
  return (
    <div
      className={`download-item download-item-detailed ${isSelected ? 'selected' : ''}`}
      onContextMenu={(e) => onContextMenu?.(e, download.id)}
    >
      {onSelect && (
        <input
          type="checkbox"
          className="download-checkbox"
          checked={isSelected}
          onChange={() => onSelect(download.id)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <div className="download-detailed-header">
        <div className="download-item-title">
          <span className="download-item-name">{download.name}</span>
          <StatusBadge status={status} />
        </div>
        <div className="download-item-actions">
          {canPause(status) && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="pause" size={16} />}
              onClick={() => onPause(download.id)}
            >
              Pause
            </Button>
          )}

          {canResume(status) && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="play" size={16} />}
              onClick={() => onResume(download.id)}
            >
              Resume
            </Button>
          )}

          {status === 'seeding' && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="stop" size={16} />}
              onClick={() => onStopSeeding(download.id)}
            >
              Stop Seeding
            </Button>
          )}

          {status === 'error' && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="refresh" size={16} />}
              onClick={() => onRetry(download.id)}
            >
              Retry
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="list" size={16} />}
            onClick={() => onShowFiles(download.id)}
          >
            Files
          </Button>

          {(status === 'completed' || status === 'seeding') && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="folder" size={16} />}
              onClick={() => onOpenFolder(download.savePath)}
            >
              Open Folder
            </Button>
          )}

          {!showRemoveConfirm ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="trash" size={16} />}
              onClick={() => setShowRemoveConfirm(true)}
            >
              Remove
            </Button>
          ) : (
            <div className="remove-confirm">
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  onRemove(download.id, true);
                  setShowRemoveConfirm(false);
                }}
              >
                Delete Files
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onRemove(download.id, false);
                  setShowRemoveConfirm(false);
                }}
              >
                Keep Files
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Icon name="x" size={16} />}
                onClick={() => setShowRemoveConfirm(false)}
              />
            </div>
          )}
        </div>
      </div>

      <div className="download-detailed-progress">
        <ProgressBar
          value={progress}
          variant={getProgressVariant()}
        />
        <span className="progress-text-large">{(progress * 100).toFixed(1)}%</span>
      </div>

      {status === 'error' && download.lastError && (
        <div className="download-error-message">
          <Icon name="alert-circle" size={16} />
          <span>{download.lastError}</span>
        </div>
      )}

      <div className="download-detailed-stats">
        <div className="stats-grid">
          <div className="stat-item">
            <Icon name="download" size={12} />
            <div className="stat-content">
              <span className="stat-label">Down</span>
              <span className="stat-value">{formatBytes(currentStats.downloadedBytes)}</span>
            </div>
          </div>

          <div className="stat-item">
            <Icon name="upload" size={12} />
            <div className="stat-content">
              <span className="stat-label">Up</span>
              <span className="stat-value">{formatBytes(currentStats.uploadedBytes)}</span>
            </div>
          </div>

          <div className="stat-item">
            <Icon name="percent" size={12} />
            <div className="stat-content">
              <span className="stat-label">Ratio</span>
              <span className="stat-value">
                {currentStats.downloadedBytes > 0
                  ? (currentStats.uploadedBytes / currentStats.downloadedBytes).toFixed(2)
                  : '0.00'}
              </span>
            </div>
          </div>

          <div className="stat-item">
            <Icon name="hard-drive" size={12} />
            <div className="stat-content">
              <span className="stat-label">Size</span>
              <span className="stat-value">
                {currentStats.progress > 0
                  ? formatBytes(Math.round(currentStats.downloadedBytes / currentStats.progress))
                  : '--'}
              </span>
            </div>
          </div>

          {status === 'downloading' && (
            <>
              <div className="stat-item">
                <Icon name="activity" size={12} />
                <div className="stat-content">
                  <span className="stat-label">Speed</span>
                  <span className="stat-value">{formatSpeed(currentStats.downSpeedBps)}</span>
                </div>
              </div>

              <div className="stat-item">
                <Icon name="clock" size={12} />
                <div className="stat-content">
                  <span className="stat-label">ETA</span>
                  <span className="stat-value">{formatEta(currentStats.etaSeconds)}</span>
                </div>
              </div>

              <div className="stat-item">
                <Icon name="users" size={12} />
                <div className="stat-content">
                  <span className="stat-label">Peers</span>
                  <span className="stat-value">{currentStats.peers}</span>
                </div>
              </div>

              <div className="stat-item">
                <Icon name="activity" size={12} />
                <div className="stat-content">
                  <span className="stat-label">Health</span>
                  <span className="stat-value">
                    <HealthBadge
                      status={status}
                      seeds={currentStats.seeds}
                      peers={currentStats.peers}
                      downSpeedBps={currentStats.downSpeedBps}
                      progress={progress}
                      variant="full"
                    />
                  </span>
                </div>
              </div>
            </>
          )}

          {status === 'seeding' && (
            <>
              <div className="stat-item">
                <Icon name="activity" size={12} />
                <div className="stat-content">
                  <span className="stat-label">Speed</span>
                  <span className="stat-value">{formatSpeed(currentStats.upSpeedBps)}</span>
                </div>
              </div>

              <div className="stat-item">
                <Icon name="users" size={12} />
                <div className="stat-content">
                  <span className="stat-label">Peers</span>
                  <span className="stat-value">{currentStats.peers}</span>
                </div>
              </div>
            </>
          )}

          <div className="stat-path">
            <Icon name="folder" size={12} />
            <span title={download.savePath}>{download.savePath}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

interface DownloadsPageProps {
  filterMode?: FilterMode;
  onFilterChange?: (filter: FilterMode) => void;
  // A torrent file path / magnet URI opened from the OS; opens the add dialog
  openTorrentUri?: string | null;
  onOpenHandled?: () => void;
}

const DownloadsPage: React.FC<DownloadsPageProps> = ({
  filterMode: externalFilterMode = 'all',
  onFilterChange,
  openTorrentUri,
  onOpenHandled
}) => {
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [stats, setStats] = useState<Map<string, DownloadStats>>(new Map());
  const [loading, setLoading] = useState(true);

  // Toast notifications
  const [toasts, setToasts] = useState<Array<{
    id: string;
    message: string;
    variant?: 'success' | 'error' | 'warning' | 'info';
    duration?: number;
  }>>([]);

  // UI State
  const [viewMode, setViewMode] = useState<ViewMode>('detailed');
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
  const [dragCounter, setDragCounter] = useState(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Torrent control modal
  const [controlModalId, setControlModalId] = useState<string | null>(null);
  const controlModalDownload = controlModalId ? downloads.find(d => d.id === controlModalId) : null;
  const [streamModalId, setStreamModalId] = useState<string | null>(null);
  const streamModalDownload = streamModalId ? downloads.find(d => d.id === streamModalId) : null;
  const [shareModalId, setShareModalId] = useState<string | null>(null);
  const shareModalDownload = shareModalId ? downloads.find(d => d.id === shareModalId) : null;

  // Refs
  const searchInputRef = useRef<HTMLInputElement>(null);

  // File selector state
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [pendingTorrent, setPendingTorrent] = useState<{
    path?: string;
    magnetUri?: string;
  } | null>(null);
  const [isAddingTorrent, setIsAddingTorrent] = useState(false);

  // Toast helper
  const addToast = useCallback((message: string, variant: 'success' | 'error' | 'warning' | 'info' = 'info', duration = 5000) => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, message, variant, duration }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // Drag and drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragCounter(prev => prev + 1);
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const newCounter = dragCounter - 1;
    setDragCounter(newCounter);
    if (newCounter === 0) {
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
    setDragCounter(0);

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
        addToast('Please drop a .torrent file', 'error');
      }
    }
  };

  // Load downloads on mount
  useEffect(() => {
    loadDownloads();
  }, []);

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
      setStats(statsMap);

      // Update download statuses from stats
      setDownloads((prev) =>
        prev.map((d) => {
          const stat = statsMap.get(d.id);
          if (stat) {
            return { ...d, status: stat.status };
          }
          return d;
        })
      );
    });

    // Cleanup listener on unmount to prevent memory leaks
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.dropdown-wrapper')) {
        setShowFilterMenu(false);
        setShowSortMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
        if (confirm(`Remove ${selectedIds.size} download(s)?`)) {
          const idsToRemove = Array.from(selectedIds);
          Promise.all(idsToRemove.map(id => window.api.removeDownload(id, false)))
            .then(() => {
              setDownloads((prev) => prev.filter((d) => !selectedIds.has(d.id)));
              setSelectedIds(new Set());
              addToast(`Removed ${selectedIds.size} download(s)`, 'success');
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
        setShowFilterMenu(false);
        setShowSortMenu(false);
        setShowExportMenu(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, downloads, addToast]);

  // Clipboard magnet detection — on window focus, check for magnet: URIs
  useEffect(() => {
    let lastDetectedMagnet = '';

    const handleFocus = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.startsWith('magnet:?') && text !== lastDetectedMagnet) {
          lastDetectedMagnet = text;
          addToast(
            `Magnet link detected in clipboard`,
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

    addToast(`Exported ${data.length} downloads as ${format.toUpperCase()}`, 'success');
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
        `Failed to load downloads: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
        `Failed to add: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
    } finally {
      setIsAddingTorrent(false);
    }
  };


  // Handle file selection from file input
  const handleFileSelect = async (file: File) => {
    try {
      // Save file to temp and add to downloads
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      const base64 = btoa(String.fromCharCode(...uint8Array));

      // For now, show file preview - actual upload will need API extension
      setSelectedFile(file);
      addToast('File ready to upload. Click "Add Selected Torrent" to proceed.', 'success');
    } catch (error) {
      addToast(
        `Failed to process file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
    }
  };

  const handleFileSelectionConfirm = async (selectedIndices: number[]) => {
    if (!pendingTorrent) return;

    try {
      const download = await window.api.addDownload({
        sourceType: pendingTorrent.path ? 'torrent_file' : 'magnet',
        sourceUri: pendingTorrent.path || pendingTorrent.magnetUri!,
        selectedFiles: selectedIndices,
      });

      setDownloads((prev) => [download, ...prev]);
      setShowFileSelector(false);
      setPendingTorrent(null);
      setSelectedFile(null);

      addToast(
        `Download added with ${selectedIndices.length} file${selectedIndices.length > 1 ? 's' : ''}`,
        'success'
      );
    } catch (error) {
      addToast(
        `Failed to add torrent: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
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
        `Failed to pause: ${error instanceof Error ? error.message : String(error)}`,
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
        `Failed to resume: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }, [addToast]);

  const handleRemove = useCallback(async (id: string, deleteFiles: boolean) => {
    try {
      await window.api.removeDownload(id, deleteFiles);
      setDownloads((prev) => prev.filter((d) => d.id !== id));
      addToast(
        deleteFiles ? 'Download and files removed' : 'Download removed (files kept)',
        'success'
      );
    } catch (error) {
      addToast(
        `Failed to remove: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }, [addToast]);

  const handleStopSeeding = useCallback(async (id: string) => {
    try {
      await window.api.stopSeeding(id);
    } catch (error) {
      addToast(
        `Failed to stop seeding: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }, [addToast]);

  const handleRetry = useCallback(async (id: string) => {
    try {
      await window.api.retryDownload(id);
      addToast('Retrying download...', 'success');
    } catch (error) {
      addToast(
        `Failed to retry: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }, [addToast]);

  const handleOpenFolder = useCallback(async (path: string) => {
    try {
      await window.api.openPath(path);
    } catch (error) {
      console.error('Failed to open folder:', error);
      addToast('Failed to open folder', 'error');
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
  const filteredDownloads = downloads.filter(download => {
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
  });

  // Sort downloads based on sort mode and direction
  const sortedDownloads = [...filteredDownloads].sort((a, b) => {
    const statA = stats.get(a.id);
    const statB = stats.get(b.id);
    const direction = sortDirection === 'asc' ? 1 : -1;

    switch (sortMode) {
      case 'name':
        return a.name.localeCompare(b.name) * direction;
      case 'progress':
        const progressA = statA?.progress ?? a.progress;
        const progressB = statB?.progress ?? b.progress;
        return (progressB - progressA) * direction;
      case 'speed':
        const speedA = statA?.downSpeedBps ?? 0;
        const speedB = statB?.downSpeedBps ?? 0;
        return (speedB - speedA) * direction;
      case 'added':
      default:
        return (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) * direction;
    }
  });

  // Calculate global stats
  const globalStats = {
    total: downloads.length,
    active: downloads.filter(d => ['downloading', 'seeding'].includes(d.status)).length,
    completed: downloads.filter(d => ['completed', 'seeding'].includes(d.status)).length,
    totalDownSpeed: Array.from(stats.values())
      .filter(s => s.status === 'downloading')
      .reduce((sum, s) => sum + s.downSpeedBps, 0),
    totalUpSpeed: Array.from(stats.values())
      .filter(s => ['downloading', 'seeding'].includes(s.status))
      .reduce((sum, s) => sum + s.upSpeedBps, 0),
  };

  if (loading) {
    return (
      <div className="page-loading">
        <span className="spinner spinner-lg" />
        <p>Loading downloads...</p>
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
        <h1 className="page-title">Downloads</h1>
        <div className="page-actions">
          <div className="view-mode-toggle">
            <Button
              variant={viewMode === 'compact' ? 'primary' : 'ghost'}
              size="sm"
              iconOnly
              icon={<Icon name="list" size={16} />}
              onClick={() => setViewMode('compact')}
              title="Compact view"
            />
            <Button
              variant={viewMode === 'detailed' ? 'primary' : 'ghost'}
              size="sm"
              iconOnly
              icon={<Icon name="grid" size={16} />}
              onClick={() => setViewMode('detailed')}
              title="Detailed view"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="refresh" size={16} />}
            onClick={loadDownloads}
            title="Refresh"
          />
          {/* Export Dropdown */}
          <div className="dropdown-wrapper">
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="download" size={16} />}
              onClick={() => {
                setShowExportMenu(!showExportMenu);
                setShowFilterMenu(false);
                setShowSortMenu(false);
              }}
              title="Export downloads list"
            >
              Export
            </Button>
            {showExportMenu && (
              <div className="dropdown-menu export-dropdown">
                <button
                  className="dropdown-item"
                  onClick={() => handleExport('json')}
                >
                  <Icon name="file" size={16} />
                  <span>Export as JSON</span>
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => handleExport('csv')}
                >
                  <Icon name="grid" size={16} />
                  <span>Export as CSV</span>
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
            <span className="btn-text">Add Torrent</span>
          </Button>
        </div>
      </div>

      <div className="page-content">
        {/* Global stats bar */}
        {downloads.length > 0 && (
          <div className="global-stats">
            <div className="global-stats-group">
              <div className="global-stat-item">
                <Icon name="download" size={14} />
                <span className="global-stat-value">{globalStats.total}</span>
                <span className="global-stat-label">Total</span>
              </div>
              <div className="global-stat-item">
                <Icon name="activity" size={14} />
                <span className="global-stat-value">{globalStats.active}</span>
                <span className="global-stat-label">Active</span>
              </div>
              <div className="global-stat-item">
                <Icon name="check-circle" size={14} />
                <span className="global-stat-value">{globalStats.completed}</span>
                <span className="global-stat-label">Done</span>
              </div>
            </div>

            <div className="global-stats-group">
              <div className="global-stat-item">
                <Icon name="arrow-down" size={14} />
                <span className="global-stat-value">{formatSpeed(globalStats.totalDownSpeed)}</span>
              </div>
              <div className="global-stat-item">
                <Icon name="arrow-up" size={14} />
                <span className="global-stat-value">{formatSpeed(globalStats.totalUpSpeed)}</span>
              </div>
            </div>
          </div>
        )}

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
                  placeholder="Search downloads... (Ctrl+F)"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="modern-search-input"
                />
                {searchQuery && (
                  <button
                    className="modern-search-clear"
                    onClick={() => setSearchQuery('')}
                    title="Clear search"
                  >
                    <Icon name="x" size={16} />
                  </button>
                )}
              </div>

              {/* Results Count */}
              {(searchQuery || filterMode !== 'all') && (
                <div className="results-count">
                  <Icon name="info" size={14} />
                  <span>{sortedDownloads.length} result{sortedDownloads.length !== 1 ? 's' : ''}</span>
                </div>
              )}
            </div>

            {/* Sort Options */}
            <div className="sort-options-section">
              <span className="section-label">
                <Icon name="arrow-down" size={14} />
                Sort by:
              </span>
              <div className="sort-chips">
                <button
                  className={`sort-chip ${sortMode === 'added' ? 'active' : ''}`}
                  onClick={() => handleHeaderSort('added')}
                >
                  <span>Date Added</span>
                  {sortMode === 'added' && (
                    <Icon name={sortDirection === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} />
                  )}
                </button>
                <button
                  className={`sort-chip ${sortMode === 'name' ? 'active' : ''}`}
                  onClick={() => handleHeaderSort('name')}
                >
                  <span>Name</span>
                  {sortMode === 'name' && (
                    <Icon name={sortDirection === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} />
                  )}
                </button>
                <button
                  className={`sort-chip ${sortMode === 'progress' ? 'active' : ''}`}
                  onClick={() => handleHeaderSort('progress')}
                >
                  <span>Progress</span>
                  {sortMode === 'progress' && (
                    <Icon name={sortDirection === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} />
                  )}
                </button>
                <button
                  className={`sort-chip ${sortMode === 'speed' ? 'active' : ''}`}
                  onClick={() => handleHeaderSort('speed')}
                >
                  <span>Speed</span>
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
                  title="Reset all filters"
                >
                  <Icon name="x" size={14} />
                  <span>Clear All</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Bulk Actions Bar */}
        {selectedIds.size > 0 && (
          <div className="bulk-actions-bar">
            <div className="bulk-actions-info">
              <span className="bulk-actions-count">{selectedIds.size} selected</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear selection
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
                Pause
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
                Resume
              </Button>
              <Button
                variant="danger"
                size="sm"
                icon={<Icon name="trash" size={14} />}
                onClick={async () => {
                  if (confirm(`Remove ${selectedIds.size} download(s)?`)) {
                    const promises = Array.from(selectedIds).map(id => window.api.removeDownload(id, false).catch(err => console.error(err)));
                    await Promise.all(promises);
                    await loadDownloads();
                    setSelectedIds(new Set());
                  }
                }}
              >
                Remove
              </Button>
            </div>
          </div>
        )}

        {/* Drag & Drop zone overlay */}
        <div className={`drop-zone ${isDragging ? 'drop-zone-active' : ''}`}>
          <Icon name="upload" size={48} />
          <div className="drop-zone-text">
            <p className="drop-zone-title">Drop torrent file here</p>
            <p className="drop-zone-subtitle">to start downloading</p>
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
                Add Selected Torrent
              </Button>
              <Button
                variant="ghost"
                iconOnly
                icon={<Icon name="x" size={16} />}
                onClick={handleClearSelection}
                title="Clear selection"
              />
            </div>
          </div>
        )}

        {/* Downloads list */}
        {sortedDownloads.length === 0 && downloads.length === 0 ? (
          <EmptyState
            icon="download"
            title="No downloads yet"
            description="Add a magnet link or torrent file to start downloading. You can also use Search to find legal open-source software."
          />
        ) : sortedDownloads.length === 0 ? (
          <EmptyState
            icon="search"
            title="No downloads match this filter"
            description="Try selecting a different filter or adding more downloads."
          />
        ) : (
          <>
            {/* Sortable Column Headers - Detailed View Only */}
            {viewMode === 'detailed' && (
              <div className="downloads-header">
                <button
                  className={`sortable-header ${sortMode === 'name' ? 'active' : ''}`}
                  onClick={() => handleHeaderSort('name')}
                >
                  <span>Name</span>
                  {sortMode === 'name' && (
                    <Icon name={sortDirection === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} />
                  )}
                </button>
                <button
                  className={`sortable-header ${sortMode === 'progress' ? 'active' : ''}`}
                  onClick={() => handleHeaderSort('progress')}
                >
                  <span>Progress</span>
                  {sortMode === 'progress' && (
                    <Icon name={sortDirection === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} />
                  )}
                </button>
                <button
                  className={`sortable-header ${sortMode === 'speed' ? 'active' : ''}`}
                  onClick={() => handleHeaderSort('speed')}
                >
                  <span>Speed</span>
                  {sortMode === 'speed' && (
                    <Icon name={sortDirection === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} />
                  )}
                </button>
                <button
                  className={`sortable-header ${sortMode === 'added' ? 'active' : ''}`}
                  onClick={() => handleHeaderSort('added')}
                >
                  <span>Added</span>
                  {sortMode === 'added' && (
                    <Icon name={sortDirection === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} />
                  )}
                </button>
              </div>
            )}
            <div className={`downloads-list downloads-list-${viewMode}`}>
              {sortedDownloads.map((download) => (
                <DownloadItem
                  key={download.id}
                  download={download}
                  stats={stats.get(download.id)}
                  viewMode={viewMode}
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
                />
              ))}
            </div>
          </>
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
              label: 'Watch / Listen',
              icon: 'play',
              onClick: () => {
                setStreamModalId(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: 'Share link…',
              icon: 'share-2',
              onClick: () => {
                setShareModalId(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: 'Advanced Controls...',
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
              label: 'Pause',
              icon: 'pause',
              onClick: () => {
                handlePause(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: 'Resume',
              icon: 'play',
              onClick: () => {
                handleResume(contextMenu.downloadId);
                setContextMenu(null);
              }
            },
            {
              label: 'Open Folder',
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
              label: '',
              onClick: () => {},
              divider: true,
            },
            {
              label: 'Remove',
              icon: 'trash',
              danger: true,
              onClick: () => {
                if (confirm('Remove download?')) {
                  handleRemove(contextMenu.downloadId, false);
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
    </div>
  );
};

export default DownloadsPage;
