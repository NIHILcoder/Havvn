import { ErrorMessage } from '../components/ErrorMessage';
/**
 * Create Torrent Page
 * 
 * Full-featured page for creating .torrent files with modern UI.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Button, Icon, Input, ProgressBar, ToastContainer, FileTreeSelector, FileNode, QRCode, TrackerTemplates, MetadataPreview, BatchCreate } from '../components';
import { CreateTorrentOptions, CreateTorrentProgress, CreateTorrentResult } from '../../shared/types';
import { useTranslation } from '../utils/i18nContext';
import { useCreateTorrentStore, useCreateTorrentDraftField } from '../stores/createTorrentStore';
import { Select } from '../components/Select';
import { Toggle } from '../components/Toggle';
import { CreatedTorrentSeed } from '../components/CreatedTorrentSeed';
import { useClipboardCopy } from '../utils/useClipboardCopy';
import './CreateTorrentPage.css';
import { calculateTorrentPieceLength, torrentSelectionStats, mergeTorrentSources, torrentSourceKey, parseTorrentUrls } from '../../shared/torrent-creation';

import { TORRENT_PIECE_SIZES, formatTorrentBytes } from '../../shared/create-torrent-labels';

interface CreateTorrentPageProps {
  onNavigateBack?: () => void;
}

// Toast item type
interface ToastItem {
  id: string;
  message: string;
  variant?: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
}

// Recent created torrents for history
interface CreatedTorrentHistory {
  id: string;
  name: string;
  path: string;
  infoHash: string;
  size: number;
  createdAt: Date;
  isSeeding?: boolean;
}

export const CreateTorrentPage: React.FC<CreateTorrentPageProps> = ({ onNavigateBack }) => {
  const { t, language } = useTranslation();
  const formatBytes = (bytes: number) => formatTorrentBytes(bytes, language);
  const formatDate = (date: Date) => date.toLocaleString(language);
  // Source selection
  const [sourcePaths, setSourcePaths] = useCreateTorrentDraftField('sourcePaths');
  const [sourceSize, setSourceSize] = useState<number>(0);
  const [sourceFileCount, setSourceFileCount] = useState<number>(0);
  
  // Torrent options
  const [name, setName] = useCreateTorrentDraftField('name');
  const [comment, setComment] = useCreateTorrentDraftField('comment');
  const [isPrivate, setIsPrivate] = useCreateTorrentDraftField('isPrivate');
  const [pieceLength, setPieceLength] = useCreateTorrentDraftField('pieceLength');
  const [trackers, setTrackers] = useCreateTorrentDraftField('trackers');
  const [webSeeds, setWebSeeds] = useCreateTorrentDraftField('webSeeds');
  const [startSeeding, setStartSeeding] = useCreateTorrentDraftField('startSeeding');
  const [createdBy, setCreatedBy] = useCreateTorrentDraftField('createdBy');
  
  // Create-session state lives in a store so it survives navigation away from
  // this page (creating in the background, returning to see the result).
  const stage = useCreateTorrentStore(s => s.stage);
  const progress = useCreateTorrentStore(s => s.progress);
  const result = useCreateTorrentStore(s => s.result);
  const error = useCreateTorrentStore(s => s.error);
  const setError = useCreateTorrentStore(s => s.setError);
  const startCreate = useCreateTorrentStore(s => s.start);
  const resetCreate = useCreateTorrentStore(s => s.reset);
  const cancelCreate = useCreateTorrentStore(s => s.cancel);
  const cancelling = useCreateTorrentStore(s => s.cancelling);
  const cancelled = useCreateTorrentStore(s => s.cancelled);
  const retrySeed = useCreateTorrentStore(s => s.retrySeed);
  const seedRetrying = useCreateTorrentStore(s => s.seedRetrying);

  // UI state
  const [activeTab, setActiveTab] = useCreateTorrentDraftField('activeTab');
  
  // Toast notifications
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  
  // History of created torrents
  const [history, setHistory] = useState<CreatedTorrentHistory[]>([]);
  
  // Drag and drop
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);
  
  // File list for preview
  const [fileList, setFileList] = useState<Array<{name: string, size: number, path: string, isDirectory: boolean}>>([]);
  
  // New features state
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [excludedPaths, setExcludedPaths] = useCreateTorrentDraftField('excludedPaths');
  const [showFileTree, setShowFileTree] = useCreateTorrentDraftField('showFileTree');
  const [showTrackerTemplates, setShowTrackerTemplates] = useState(false);
  const [showMetadataPreview, setShowMetadataPreview] = useState(false);
  const [showBatchCreate, setShowBatchCreate] = useState(false);
  const [showQRCode, setShowQRCode] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceReady, setSourceReady] = useState(false);
  const [sourceUnreadable, setSourceUnreadable] = useState(false);
  const createPending = useRef(false);
  const parsedTrackers = useMemo(() => parseTorrentUrls(trackers, 'tracker'), [trackers]);
  const parsedWebSeeds = useMemo(() => parseTorrentUrls(webSeeds, 'webSeed'), [webSeeds]);
  const settingsInvalid = parsedTrackers.invalidLines.length > 0 || parsedWebSeeds.invalidLines.length > 0;
  const trackerError = parsedTrackers.invalidLines.length ? t('create.invalidTrackerLines').replace('{lines}', parsedTrackers.invalidLines.join(', ')) : '';
  const webSeedError = parsedWebSeeds.invalidLines.length ? t('create.invalidWebSeedLines').replace('{lines}', parsedWebSeeds.invalidLines.join(', ')) : '';
  const setTrackerText = useCallback((text: string) => {
    useCreateTorrentStore.getState().setDraftField('trackersEdited', true);
    setTrackers(text);
  }, [setTrackers]);

  // Toast helper
  const addToast = useCallback((message: string, variant: 'success' | 'error' | 'warning' | 'info' = 'info', duration = 5000) => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, message, variant, duration }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // Load default trackers on mount
  useEffect(() => {
    if (useCreateTorrentStore.getState().draft.trackersLoaded || useCreateTorrentStore.getState().draft.trackersEdited) return;
    let active = true;
    window.api.getDefaultTrackers().then((defaultTrackers) => {
      if (active && !useCreateTorrentStore.getState().draft.trackersEdited) {
        setTrackers(defaultTrackers.map(group => group.join('\n')).join('\n\n'));
        useCreateTorrentStore.getState().setDraftField('trackersLoaded', true);
      }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, []);

  // Load path info when source changes
  useEffect(() => {
    let active = true;
    setSourceReady(false);
    setSourceUnreadable(false);
    setSourceLoading(sourcePaths.length > 0);
    setFileTree([]);
    setSourceSize(0);
    setSourceFileCount(0);
    setFileList([]);
    setExcludedPaths(previous => new Set([...previous].filter(value => sourcePaths.some(source => {
      const key = torrentSourceKey(value), parent = torrentSourceKey(source);
      return key === parent || key.startsWith(parent.endsWith('/') ? parent : parent + '/');
    }))));
    const loadPathInfo = async () => {
      if (sourcePaths.length === 0) {
        setSourceSize(0);
        setSourceFileCount(0);
        setFileList([]);
        return;
      }

      try {
        let totalSize = 0;
        let totalFiles = 0;
        const files: Array<{name: string, size: number, path: string, isDirectory: boolean}> = [];

        for (const sourcePath of sourcePaths) {
          const info = await window.api.getPathInfo(sourcePath);
          totalSize += info.size;
          totalFiles += info.fileCount;
          files.push({
            name: info.name,
            size: info.size,
            path: sourcePath,
            isDirectory: info.isDirectory,
          });
        }

        if (!active) return;
        setSourceSize(totalSize);
        setSourceFileCount(totalFiles);
        setFileList(files);

        // Build the REAL recursive file tree so the user can exclude individual
        // files (not just top-level items).
        try {
          const tree = await window.api.getFileTree(sourcePaths);
          if (!active) return;
          setFileTree(tree as FileNode[]);
          // A capped tree must not pretend to describe the entire selection.
          setSourceReady(torrentSelectionStats(tree, new Set()).total === totalFiles);
        } catch (treeErr) {
          if (!active) return;
          console.error('Failed to build file tree:', treeErr);
          // Fallback: flat top-level nodes
          setFileTree(files.map(file => ({
            path: file.path, name: file.name, size: file.size,
            isDirectory: file.isDirectory, children: [],
          })));
        }
      } catch (err) {
        if (!active) return;
        setSourceUnreadable(true);
        console.error('Failed to get path info:', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setSourceLoading(false);
      }
    };

    void loadPathInfo();
    return () => { active = false; };
  }, [sourcePaths, setError]);

  const suggestedName = sourcePaths.length === 1 ? sourcePaths[0].split(/[/\\]/).filter(Boolean).pop() || ''
    : sourcePaths.length > 1 ? t('create.collectionName') : '';
  useEffect(() => {
    const previous = useCreateTorrentStore.getState().draft.automaticName;
    setName(current => !current || current === previous ? suggestedName : current);
    useCreateTorrentStore.getState().setDraftField('automaticName', suggestedName);
  }, [suggestedName]);

  const addSources = useCallback((paths: string[]) => {
    setError(null);
    setSourcePaths(previous => {
      const merged = mergeTorrentSources(previous, paths);
      return merged.length === previous.length && merged.every((value, index) => torrentSourceKey(value) === torrentSourceKey(previous[index])) ? previous : merged;
    });
  }, [setError]);
  const handleSelectFiles = useCallback(async () => {
    try {
      const paths = await window.api.selectFilesForTorrent();
      if (paths?.length) addSources(paths);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('create.dropReadError')); }
  }, [addSources, setError, t]);
  const handleSelectFolder = useCallback(async () => {
    try {
      const folder = await window.api.selectFolderForTorrent();
      if (folder) addSources([folder]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('create.dropReadError')); }
  }, [addSources, setError, t]);
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragDepth.current++;
    setIsDragging(true);
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragging(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setIsDragging(false);
  }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setIsDragging(false);
    try {
      const paths = Array.from(e.dataTransfer.files).map(file => window.api.getPathForFile(file));
      if (!paths.length || paths.some(value => !value)) { setError(t('create.dropReadError')); return; }
      addSources(paths);
    } catch { setError(t('create.dropReadError')); }
  }, [addSources, setError, t]);
  const handleClearSource = useCallback(() => {
    setSourcePaths([]);
    setName('');
  }, []);
  const handleRemoveSource = useCallback((source: string) => {
    setSourcePaths(previous => previous.filter(value => torrentSourceKey(value) !== torrentSourceKey(source)));
  }, []);

  // Calculate estimated piece info
  const selection = useMemo(() => torrentSelectionStats(fileTree, excludedPaths), [fileTree, excludedPaths]);
  const includedSize = sourceReady ? selection.totalSize - selection.excludedSize : sourceSize;
  const includedCount = sourceReady ? selection.total - selection.excluded : sourceFileCount;
  const getEstimatedPieceInfo = useCallback(() => {
    if (includedCount === 0) return null;
    
    let actualPieceLength = pieceLength;
    if (actualPieceLength === 0) {
      actualPieceLength = calculateTorrentPieceLength(includedSize);
    }
    
    const pieceCount = Math.ceil(includedSize / actualPieceLength);
    const torrentFileSize = pieceCount * 20 + 1000; // SHA1 hashes + metadata
    
    return {
      pieceLength: actualPieceLength,
      pieceCount,
      estimatedTorrentSize: torrentFileSize
    };
  }, [includedSize, includedCount, pieceLength]);

  const pieceInfo = getEstimatedPieceInfo();

  // Create torrent
  const handleCreate = useCallback(async () => {
    if (createPending.current || sourceLoading || sourceUnreadable || stage === 'creating') return;
    if (settingsInvalid) { setActiveTab(trackerError ? 'trackers' : 'advanced'); return; }
    if (sourcePaths.length === 0) {
      setError(t('create.selectSourceError'));
      addToast(t('create.selectSourceFirst'), 'warning');
      return;
    }

    if (sourceReady && includedCount === 0) {
      setError(t('create.noIncludedFiles'));
      return;
    }
    createPending.current = true;
    try {
      // Get output path
      const outputPath = await window.api.selectSaveTorrentPath(name || 'torrent');
      if (!outputPath) return;

      setError(null);

      const announceList = parsedTrackers.groups;
      const urlList = parsedWebSeeds.urls;

      const options: CreateTorrentOptions = {
        name: name || undefined,
        comment: comment || undefined,
        createdBy: createdBy || 'Havvn',
        announceList,
        urlList: urlList.length > 0 ? urlList : undefined,
        private: isPrivate,
        pieceLength: pieceLength > 0 ? pieceLength : undefined,
      };

      // Runs in the store so it keeps going (and the result is preserved) even if
      // the user navigates away mid-creation.
      const r = await startCreate({
        sourcePaths,
        outputPath,
        options,
        startSeeding,
        excludePaths: excludedPaths.size > 0 ? Array.from(excludedPaths) : undefined,
      });

      if (r.ok && r.result) {
        const historyItem: CreatedTorrentHistory = {
          id: r.result.infoHash,
          name: name || sourcePaths[0].split(/[/\\]/).pop() || 'Torrent',
          path: r.result.torrentFilePath,
          infoHash: r.result.infoHash,
          size: r.result.totalSize,
          createdAt: new Date(),
          isSeeding: r.result.seedingStatus === 'queued',
        };
        setHistory(prev => [historyItem, ...prev.slice(0, 9)]); // Keep last 10
        addToast(t(r.result.seedingStatus === 'failed' ? 'create.savedSeedFailed' : 'create.createdSuccess'), r.result.seedingStatus === 'failed' ? 'warning' : 'success');
      } else if (!r.cancelled) {
        addToast(r.error || t('create.createFailed'), 'error');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('create.createFailed'));
    } finally { createPending.current = false; }
  }, [sourcePaths, name, comment, createdBy, isPrivate, pieceLength, startSeeding, excludedPaths, addToast, setError, startCreate, t, sourceLoading, sourceReady, sourceUnreadable, includedCount, stage, settingsInvalid, trackerError, parsedTrackers, parsedWebSeeds]);

  const { copy: handleCopyMagnet, copied: copiedMagnet, copying: copyingMagnet } = useClipboardCopy(result?.magnetUri ?? '', {
    onSuccess: () => addToast(t('create.magnetCopied'), 'success'),
    onError: () => addToast(t('create.copyFailed'), 'error'),
  });
  const { copy: handleCopyHash, copied: copiedHash, copying: copyingHash } = useClipboardCopy(result?.infoHash ?? '', {
    onSuccess: () => addToast(t('create.hashCopied'), 'success'),
    onError: () => addToast(t('create.copyFailed'), 'error'),
  });

  // Show in folder
  const handleShowInFolder = useCallback(() => {
    if (result?.torrentFilePath) {
      window.api.showItemInFolder(result.torrentFilePath);
    }
  }, [result]);

  // Create new torrent (reset)
  const handleCreateNew = useCallback(() => {
    if (seedRetrying) return;
    setSourcePaths([]);
    setSourceSize(0);
    setSourceFileCount(0);
    setName('');
    setComment('');
    resetCreate();
    setActiveTab('basic');
    setExcludedPaths(new Set());
    setFileTree([]);
    setShowFileTree(false);
  }, [resetCreate, seedRetrying]);
  
  // File tree handlers
  const handleToggleFile = useCallback((path: string, isDirectory: boolean) => {
    setExcludedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
        // If it's a directory, remove all children too
        if (isDirectory) {
          const removeChildren = (nodes: FileNode[]) => {
            nodes.forEach(node => {
              next.delete(node.path);
              if (node.children) removeChildren(node.children);
            });
          };
          const findNode = (nodes: FileNode[], targetPath: string): FileNode | null => {
            for (const node of nodes) {
              if (node.path === targetPath) return node;
              if (node.children) {
                const found = findNode(node.children, targetPath);
                if (found) return found;
              }
            }
            return null;
          };
          const node = findNode(fileTree, path);
          if (node?.children) removeChildren(node.children);
        }
      } else {
        next.add(path);
        // If it's a directory, exclude all children too
        if (isDirectory) {
          const excludeChildren = (nodes: FileNode[]) => {
            nodes.forEach(node => {
              next.add(node.path);
              if (node.children) excludeChildren(node.children);
            });
          };
          const findNode = (nodes: FileNode[], targetPath: string): FileNode | null => {
            for (const node of nodes) {
              if (node.path === targetPath) return node;
              if (node.children) {
                const found = findNode(node.children, targetPath);
                if (found) return found;
              }
            }
            return null;
          };
          const node = findNode(fileTree, path);
          if (node?.children) excludeChildren(node.children);
        }
      }
      return next;
    });
  }, [fileTree]);
  
  const handleToggleAllFiles = useCallback((included: boolean) => {
    if (included) {
      setExcludedPaths(new Set());
    } else {
      const allPaths = new Set<string>();
      const collectPaths = (nodes: FileNode[]) => {
        nodes.forEach(node => {
          allPaths.add(node.path);
          if (node.children) collectPaths(node.children);
        });
      };
      collectPaths(fileTree);
      setExcludedPaths(allPaths);
    }
  }, [fileTree]);
  
  // Tracker templates handler
  const handleSelectTrackerTemplate = useCallback((trackerList: string[]) => {
    setTrackerText(trackerList.join('\n'));
    addToast(t('create.templateApplied'), 'success');
  }, [addToast, t, setTrackerText]);
  
  // Metadata preview handler
  const handleShowMetadataPreview = useCallback(() => {
    if (settingsInvalid) { setActiveTab(trackerError ? 'trackers' : 'advanced'); return; }
    setShowMetadataPreview(true);
  }, [settingsInvalid, trackerError]);
  
  const handleConfirmCreate = useCallback(() => {
    setShowMetadataPreview(false);
    handleCreate();
  }, [handleCreate]);

  const renderSourceSelector = () => <div className="source-selection">
    <div className={'source-dropzone' + (sourcePaths.length ? ' compact' : '')} data-dragging={isDragging}>
      <span className="dropzone-icon"><Icon name="folder-plus" size={28} /></span>
      <div className="dropzone-text">
        <p className="dropzone-title">{t(isDragging ? 'create.dropHere' : 'create.dropAnySource')}</p>
        <p className="dropzone-subtitle">{t('create.dropAnyHint')}</p>
      </div>
      <div className="source-picker-actions">
        <Button size="sm" variant="secondary" icon={<Icon name="file-plus" size={14} />} onClick={handleSelectFiles}>{t('create.addFiles')}</Button>
        <Button size="sm" variant="secondary" icon={<Icon name="folder-plus" size={14} />} onClick={handleSelectFolder}>{t('create.addFolder')}</Button>
      </div>
    </div>
    {sourcePaths.length > 0 && <>
      <div className="source-selection-summary">
        <span>{sourceLoading ? t('create.scanningSources') : sourceFileCount + ' ' + t('create.filesLower') + ' · ' + formatBytes(sourceSize)}</span>
        <Button size="sm" variant="ghost" onClick={handleClearSource}>{t('create.clearSelection')}</Button>
      </div>
      <ul className="source-items">
        {sourcePaths.map(source => {
          const info = fileList.find(file => torrentSourceKey(file.path) === torrentSourceKey(source));
          const label = info?.name || source.split(/[/\\]/).filter(Boolean).pop() || source;
          return <li className="source-item" key={source}>
            <Icon name={info?.isDirectory ? 'folder' : 'file'} size={20} />
            <div className="source-item-info">
              <strong>{label}</strong>
              <span className="source-card-path" title={source}>{source}</span>
              {info && <span className="source-item-size">{formatBytes(info.size)}</span>}
            </div>
            <Button variant="ghost" size="sm" iconOnly aria-label={t('create.removeSource').replace('{name}', label)} title={t('create.remove')} onClick={() => handleRemoveSource(source)} icon={<Icon name="x" size={14} />} />
          </li>;
        })}
      </ul>
    </>}
  </div>;

  return (
    <div className="page-container create-torrent-page">
      {/* Page Header */}
      <div className="page-header create-header">
        <div className="page-title-section">
          <button className="back-button" onClick={onNavigateBack} title={t('create.backToDownloads')} aria-label={t('create.backToDownloads')}>
            <Icon name="chevron-left" size={20} />
          </button>
          <div className="page-title-wrapper">
            <h1 className="page-title">
              {t('create.title')}
            </h1>
            <span className="page-subtitle">{t('create.subtitle')}</span>
          </div>
        </div>
        
        <div className="header-actions">
          {stage === 'setup' && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setShowBatchCreate(true)}>
                <Icon name="layers" size={16} />
                {t('create.batchCreate')}
              </Button>
            </>
          )}
          {stage === 'success' && (
            <Button variant="secondary" onClick={handleCreateNew} disabled={seedRetrying}>
              <Icon name="plus" size={16} />
              {t('create.createNew')}
            </Button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="page-content create-content">
        {stage === 'setup' && (
          <div className="create-layout" onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
            {/* Left Panel - Source Selection */}
            <div className={'create-panel source-panel' + (isDragging ? ' dragging' : '')}>
              <div className="panel-header">
                <h3>
                  <span className="create-section-number" aria-hidden="true">01</span>
                  {t('create.source')}
                </h3>
              </div>
              
              <div className="panel-content">
                {/* Source Selection Area */}
                {renderSourceSelector()}
                
                {/* File Tree Selector */}
                {sourcePaths.length > 0 && fileTree.length > 0 && (
                  <div className="file-tree-section">
                    <div className="section-header">
                      <h4>
                        <Icon name="list" size={14} />
                        {t('create.filesToInclude')}
                      </h4>
                      <button
                        className="toggle-tree-btn"
                        onClick={() => setShowFileTree(!showFileTree)}
                        disabled={!sourceReady || sourceLoading}
                      >
                        <Icon name={showFileTree ? 'chevron-up' : 'chevron-down'} size={14} />
                        {showFileTree ? t('create.hide') : t('create.show')}
                      </button>
                    </div>
                    {showFileTree && sourceReady && !sourceLoading && (
                      <FileTreeSelector
                        files={fileTree}
                        excludedPaths={excludedPaths}
                        onToggle={handleToggleFile}
                        onToggleAll={handleToggleAllFiles}
                      />
                    )}
                    {!sourceReady && !sourceLoading && <p className="field-hint">{t('create.fileSelectionUnavailable')}</p>}
                  </div>
                )}
              </div>
            </div>

            {/* Right Panel - Options */}
            <div className="create-panel options-panel">
              <div className="panel-header">
                <h3>
                  <span className="create-section-number" aria-hidden="true">02</span>
                  {t('create.options')}
                </h3>
                <div className="options-tabs">
                  <button 
                    className={`tab-btn ${activeTab === 'basic' ? 'active' : ''}`}
                    aria-pressed={activeTab === 'basic'}
                    onClick={() => setActiveTab('basic')}
                  >
                    <Icon name="file-text" size={14} />
                    {t('create.tabBasic')}
                  </button>
                  <button 
                    className={`tab-btn ${activeTab === 'trackers' ? 'active' : ''}`}
                    aria-pressed={activeTab === 'trackers'}
                    onClick={() => setActiveTab('trackers')}
                  >
                    <Icon name="server" size={14} />
                    {t('create.trackers')}
                  </button>
                  <button 
                    className={`tab-btn ${activeTab === 'advanced' ? 'active' : ''}`}
                    aria-pressed={activeTab === 'advanced'}
                    onClick={() => setActiveTab('advanced')}
                  >
                    <Icon name="zap" size={14} />
                    {t('create.tabAdvanced')}
                  </button>
                </div>
              </div>

              <div className="panel-content">
                {/* Basic Tab */}
                {activeTab === 'basic' && (
                  <div className="options-form">
                    {/* Torrent Name */}
                    <div className="form-field">
                      <label className="field-label" htmlFor="create-name">
                        <Icon name="type" size={14} />
                        {t('create.name')}
                      </label>
                      <input
                        type="text"
                        id="create-name"
                        className="field-input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('create.name.placeholder')}
                      />
                      <p className="field-hint">{t('create.nameHint')}</p>
                    </div>

                    {/* Description */}
                    <div className="form-field">
                      <label className="field-label" htmlFor="create-comment">
                        <Icon name="file-text" size={14} />
                        {t('create.comment')}
                      </label>
                      <textarea
                        id="create-comment"
                        className="field-textarea"
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder={t('create.comment.placeholder')}
                        rows={3}
                      />
                    </div>

                    {/* Toggle Options */}
                    <div className="toggle-group">
                      <div className="toggle-option">
                        <div className="toggle-info">
                          <label className="toggle-name" htmlFor="create-seed">{t('create.startSeeding')}</label>
                          <span className="toggle-desc" id="create-seed-hint">{t('create.seedingDesc')}</span>
                        </div>
                        <Toggle id="create-seed" size="small" checked={startSeeding} onChange={setStartSeeding} ariaLabel={t('create.startSeeding')} ariaDescribedBy="create-seed-hint" />
                      </div>

                      <div className="toggle-option">
                        <div className="toggle-info">
                          <label className="toggle-name" htmlFor="create-private">{t('create.private')}</label>
                          <span className="toggle-desc" id="create-private-hint">{t('create.privateDesc')}</span>
                        </div>
                        <Toggle id="create-private" size="small" checked={isPrivate} onChange={setIsPrivate} ariaLabel={t('create.private')} ariaDescribedBy="create-private-hint" />
                      </div>
                    </div>
                    {isPrivate && !parsedTrackers.urls.length && <p className="create-setting-note">{t('create.privateTrackerHint')}</p>}
                    <div className="create-settings-overview">
                      <button type="button" onClick={() => setActiveTab('advanced')}><span>{t('create.pieceSize')}</span><strong>{pieceLength === 0 ? t('create.pieceAutoShort') + (pieceInfo ? ' · ' + formatBytes(pieceInfo.pieceLength) : '') : formatBytes(pieceLength)}</strong></button>
                      <button type="button" onClick={() => setActiveTab('trackers')}><span>{t('create.trackers')}</span><strong>{parsedTrackers.urls.length}</strong></button>
                    </div>
                  </div>
                )}

                {/* Trackers Tab */}
                {activeTab === 'trackers' && (
                  <div className="options-form">
                    <div className="form-field">
                      <div className="field-header">
                        <label className="field-label" htmlFor="create-trackers">
                          <Icon name="server" size={14} />
                          {t('create.trackers')}
                        </label>
                        <span className="tracker-count">
                          {parsedTrackers.urls.length} {t('create.trackersCount')}
                        </span>
                      </div>
                      <textarea
                        id="create-trackers"
                        className="field-textarea tracker-textarea"
                        value={trackers}
                        onChange={(e) => setTrackerText(e.target.value)}
                        aria-invalid={!!trackerError}
                        aria-describedby={trackerError ? 'create-trackers-error create-trackers-hint' : 'create-trackers-hint'}
                        placeholder={t('create.trackers.placeholder')}
                        rows={10}
                      />
                      {trackerError && <p id="create-trackers-error" className="create-field-error" role="alert"><ErrorMessage error={trackerError} /></p>}
                      <p className="field-hint" id="create-trackers-hint">
                        {t('create.trackersHint')}
                      </p>
                      {parsedTrackers.duplicates > 0 && <p className="field-hint">{t('create.urlDuplicates').replace('{n}', String(parsedTrackers.duplicates))}</p>}
                    </div>

                    <div className="tracker-buttons">
                      <button
                        className="tracker-btn"
                        onClick={() => setShowTrackerTemplates(true)}
                      >
                        <Icon name="layout-template" size={14} />
                        {t('create.templates')}
                      </button>
                      <button
                        className="tracker-btn"
                        onClick={() => {
                          window.api.getDefaultTrackers().then((defaultTrackers) => {
                            const trackerList = defaultTrackers.map(group => group.join('\n')).join('\n\n');
                            setTrackerText(trackerList);
                            addToast(t('create.defaultsRestored'), 'success');
                          });
                        }}
                      >
                        <Icon name="refresh" size={14} />
                        {t('create.restoreDefaults')}
                      </button>
                      <button
                        className="tracker-btn danger"
                        onClick={() => {
                          setTrackerText('');
                          addToast(t('create.trackersCleared'), 'info');
                        }}
                      >
                        <Icon name="trash" size={14} />
                        {t('create.clearAll')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Advanced Tab */}
                {activeTab === 'advanced' && (
                  <div className="options-form">
                    {/* Piece Size */}
                    <div className="form-field">
                      <label className="field-label">
                        <Icon name="grid" size={14} />
                        {t('create.pieceSize')}
                      </label>
                      <Select value={String(pieceLength)} onChange={value => setPieceLength(Number(value))}
                        ariaLabel={t('create.pieceSize')} options={TORRENT_PIECE_SIZES.map(value => ({
                          value: String(value), label: value === 0 ? t('create.pieceAuto') : formatBytes(value),
                        }))} />
                      <p className="field-hint">
                        {t('create.pieceHint')}
                      </p>
                    </div>

                    {/* Source Info */}
                    {sourceSize > 0 && pieceInfo && (
                      <div className="piece-info-card">
                        <div className="piece-info-row">
                          <span className="piece-info-label">{t('create.totalSize')}</span>
                          <span className="piece-info-value">{formatBytes(includedSize)}</span>
                        </div>
                        <div className="piece-info-row">
                          <span className="piece-info-label">{t('create.pieceSize')}</span>
                          <span className="piece-info-value">{formatBytes(pieceInfo.pieceLength)}</span>
                        </div>
                        <div className="piece-info-row">
                          <span className="piece-info-label">{t('create.totalPieces')}</span>
                          <span className="piece-info-value">{pieceInfo.pieceCount.toLocaleString()}</span>
                        </div>
                        <div className="piece-info-row">
                          <span className="piece-info-label">{t('create.estTorrentSize')}</span>
                          <span className="piece-info-value">{formatBytes(pieceInfo.estimatedTorrentSize)}</span>
                        </div>
                      </div>
                    )}

                    {/* Created By */}
                    <div className="form-field">
                      <label className="field-label" htmlFor="create-author">
                        <Icon name="user" size={14} />
                        {t('create.createdBy')}
                      </label>
                      <input
                        id="create-author"
                        type="text"
                        className="field-input"
                        value={createdBy}
                        onChange={(e) => setCreatedBy(e.target.value)}
                        placeholder="Havvn"
                      />
                    </div>

                    {/* Web Seeds */}
                    <div className="form-field">
                      <label className="field-label" htmlFor="create-web-seeds">
                        <Icon name="external-link" size={14} />
                        {t('create.webSeeds')}
                      </label>
                      <textarea
                        id="create-web-seeds"
                        className="field-textarea"
                        value={webSeeds}
                        onChange={(e) => setWebSeeds(e.target.value)}
                        aria-invalid={!!webSeedError}
                        aria-describedby={webSeedError ? 'create-web-seeds-error create-web-seeds-hint' : 'create-web-seeds-hint'}
                        placeholder={t('create.webSeedsPlaceholder')}
                        rows={3}
                      />
                      {webSeedError && <p id="create-web-seeds-error" className="create-field-error" role="alert"><ErrorMessage error={webSeedError} /></p>}
                      <p className="field-hint" id="create-web-seeds-hint">
                        {t('create.webSeedsHint')}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Creating Stage */}
        {stage === 'creating' && progress && (
          <div className="create-progress-view">
            <div className="progress-card">
              <div className="progress-icon-wrapper">
                <div className="progress-icon spinning">
                  <Icon name="loader" size={28} />
                </div>
              </div>
              
              <h2 className="progress-title">{t('create.creating')}</h2>
              <p className="progress-stage">{progress.stage === 'verifying' ? t('create.verifyingSeed') : progress.stage === 'hashing' ? t('create.hashing') : progress.stage === 'writing' ? t('create.stageWriting') : t('create.stageComplete')}</p>
              
              <div className="progress-bar-wrapper">
                <ProgressBar value={progress.stage === 'verifying' ? null : progress.progress} />
                {progress.stage !== 'verifying' && <span className="progress-percent">{Math.round(progress.progress * 100)}%</span>}
              </div>

              <div className="progress-details">
                <div className="progress-detail-item">
                  <Icon name="file" size={14} />
                  <span>{name || t('create.torrentFallback')}</span>
                </div>
                <div className="progress-detail-item">
                  <Icon name="clock" size={14} />
                  <span>{t('create.pleaseWait')}</span>
                </div>
              </div>
              <p className="field-hint">{t('create.backgroundHint')}</p>
              {progress.stage === 'hashing' && <Button variant="secondary" onClick={() => void cancelCreate()} disabled={cancelling}>
                <Icon name="x" size={16} />{t(cancelling ? 'create.cancelling' : 'create.cancelCreation')}
              </Button>}
              {error && <p className="create-field-error" role="alert"><ErrorMessage error={error} /></p>}
            </div>
          </div>
        )}

        {/* Success Stage */}
        {stage === 'success' && result && (
          <div className="create-success-view">
            <div className="success-card">
              <div className="success-header">
                <div className="success-icon-wrapper">
                  <Icon name="file" size={24} />
                </div>
                <h2>{t('create.successTitle')}</h2>
                <p>{t('create.successSubtitle')}</p>
              </div>

              <div className="success-info-grid">
                <div className="info-card">
                  <div className="info-card-icon">
                    <Icon name="file" size={20} />
                  </div>
                  <div className="info-card-content">
                    <span className="info-label">{t('create.fileName')}</span>
                    <span className="info-value truncate">{result.torrentFilePath.split(/[/\\]/).pop()}</span>
                  </div>
                </div>

                <div className="info-card">
                  <div className="info-card-icon">
                    <Icon name="hard-drive" size={20} />
                  </div>
                  <div className="info-card-content">
                    <span className="info-label">{t('create.totalSize')}</span>
                    <span className="info-value">{formatBytes(result.totalSize)}</span>
                  </div>
                </div>

                <div className="info-card">
                  <div className="info-card-icon">
                    <Icon name="grid" size={20} />
                  </div>
                  <div className="info-card-content">
                    <span className="info-label">{t('create.pieces')}</span>
                    <span className="info-value">{result.pieceCount} × {formatBytes(result.pieceLength)}</span>
                  </div>
                </div>

                <div className="info-card">
                  <div className="info-card-icon">
                    <Icon name={result.seedingStatus === 'queued' ? 'upload' : 'pause'} size={20} />
                  </div>
                  <div className="info-card-content">
                    <span className="info-label">{t('table.status')}</span>
                    <span className="info-value status-value">
                      {result.seedingStatus === 'queued' ? t('create.seedQueued') : t('create.notSeeding')}
                      {result.seedingStatus === 'queued' && <span className="status-dot active"></span>}
                    </span>
                  </div>
                </div>
              </div>

              <CreatedTorrentSeed result={result} busy={seedRetrying} onRetry={() => void retrySeed()} />
              <div className="info-hash-section">
                <label className="section-label">{t('create.infoHash')}</label>
                <div className="hash-box">
                  <code className="hash-value">{result.infoHash}</code>
                  <Button
                    variant={copiedHash ? 'primary' : 'ghost'}
                    size="sm"
                    iconOnly
                    icon={<Icon name="copy" size={16} />}
                    onClick={handleCopyHash}
                    disabled={copyingHash}
                    title={t(copiedHash ? 'create.copied' : 'create.copyHash')}
                  />
                </div>
              </div>

              <div className="magnet-section">
                <label className="section-label">{t('create.magnetLink')}</label>
                <div className="magnet-box">
                  <input
                    type="text"
                    className="magnet-input"
                    value={result.magnetUri}
                    readOnly
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <Button
                    variant={copiedMagnet ? 'primary' : 'secondary'}
                    onClick={handleCopyMagnet}
                    disabled={copyingMagnet}
                  >
                    <Icon name="copy" size={16} />
                    {copiedMagnet ? t('create.copied') : t('create.copyLink')}
                  </Button>
                </div>
                
                {/* QR Code Toggle */}
                <div className="qr-toggle">
                  <button
                    className="qr-toggle-btn"
                    onClick={() => setShowQRCode(!showQRCode)}
                  >
                    <Icon name="qr-code" size={14} />
                    {showQRCode ? t('create.hideQr') : t('create.showQr')}
                  </button>
                </div>
                
                {showQRCode && (
                  <div className="qr-code-wrapper">
                    <QRCode data={result.magnetUri} size={200} />
                    <p className="qr-hint">{t('create.qrHint')}</p>
                  </div>
                )}
              </div>

              <div className="success-actions">
                <Button variant="ghost" onClick={handleShowInFolder}>
                  <Icon name="folder" size={16} />
                  {t('create.openLocation')}
                </Button>
                <Button variant="primary" onClick={handleCreateNew} disabled={seedRetrying}>
                  <Icon name="plus" size={16} />
                  {t('create.createAnother')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {cancelled && stage === 'setup' && <p className="field-hint" role="status">{t('create.cancelled')}</p>}
        {/* Error Display */}
        {error && stage === 'setup' && (
          <div className="error-banner">
            <Icon name="alert-circle" size={18} />
            <span><ErrorMessage error={error} /></span>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="x" size={14} />}
              onClick={() => setError(null)}
            />
          </div>
        )}
      </div>

      {/* Footer Action Bar */}
      {stage === 'setup' && (
        <div className="create-footer">
          <div className="footer-info">
            {sourcePaths.length > 0 ? (
              <div className="footer-preview">
                <div className="preview-item">
                  <Icon name="folder" size={14} />
                  <span className="preview-label">{t('create.sourceColon')}</span>
                  <span className="preview-value">{name || t('create.selected')}</span>
                </div>
                {pieceInfo && (
                  <>
                    <div className="preview-divider" />
                    <div className="preview-item">
                      <Icon name="grid" size={14} />
                      <span className="preview-label">{t('create.piecesColon')}</span>
                      <span className="preview-value">{pieceInfo.pieceCount.toLocaleString()}</span>
                    </div>
                    <div className="preview-divider" />
                    <div className="preview-item">
                      <Icon name="file" size={14} />
                      <span className="preview-label">.torrent:</span>
                      <span className="preview-value">~{formatBytes(pieceInfo.estimatedTorrentSize)}</span>
                    </div>
                  </>
                )}
                <div className="preview-divider" />
                <div className="preview-item">
                  <Icon name="server" size={14} />
                  <span className="preview-label">{t('create.trackersColon')}</span>
                  <span className="preview-value">{parsedTrackers.urls.length}</span>
                </div>
              </div>
            ) : (
              <span className="footer-hint">
                <Icon name="info" size={14} />
                {t('create.footerHint')}
              </span>
            )}
          </div>
          <div className="footer-actions">
            {settingsInvalid && <span className="create-field-error">{t('create.fixSettingsUrls')}</span>}
            <Button
              variant="secondary"
              size="md"
              onClick={handleShowMetadataPreview}
              disabled={sourcePaths.length === 0 || sourceLoading || sourceUnreadable || settingsInvalid || (sourceReady && includedCount === 0)}
            >
              <Icon name="eye" size={18} />
              {t('create.preview')}
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={handleCreate}
              loading={sourceLoading}
              disabled={sourcePaths.length === 0 || sourceLoading || sourceUnreadable || settingsInvalid || (sourceReady && includedCount === 0)}
              className="create-btn"
            >
              <Icon name="file-plus" size={18} />
              {t('create.createTorrent')}
            </Button>
          </div>
        </div>
      )}

      {/* Toast Container */}
      <ToastContainer toasts={toasts} onClose={removeToast} />
      
      {/* Tracker Templates Modal */}
      <TrackerTemplates
        isOpen={showTrackerTemplates}
        onClose={() => setShowTrackerTemplates(false)}
        onSelect={handleSelectTrackerTemplate}
      />
      
      {/* Metadata Preview Modal */}
      {pieceInfo && (
        <MetadataPreview
          isOpen={showMetadataPreview}
          onClose={() => setShowMetadataPreview(false)}
          onConfirm={handleConfirmCreate}
          metadata={{
            name: name || sourcePaths[0]?.split(/[/\\]/).pop() || 'Torrent',
            comment: comment || undefined,
            totalSize: includedSize,
            fileCount: includedCount,
            pieceSize: pieceInfo.pieceLength,
            pieceCount: pieceInfo.pieceCount,
            trackers: parsedTrackers.urls,
            webSeeds: parsedWebSeeds.urls.length ? parsedWebSeeds.urls : undefined,
            isPrivate,
            createdBy,
            estimatedTorrentSize: pieceInfo.estimatedTorrentSize
          }}
        />
      )}
      
      {/* Batch Create Modal */}
      <BatchCreate
        isOpen={showBatchCreate}
        onClose={() => setShowBatchCreate(false)}
        trackers={trackers}
        isPrivate={isPrivate}
        pieceLength={pieceLength}
        startSeeding={startSeeding}
        createdBy={createdBy}
      />
    </div>
  );
};

export default CreateTorrentPage;
