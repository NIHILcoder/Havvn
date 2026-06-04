/**
 * Create Torrent Page
 * 
 * Full-featured page for creating .torrent files with modern UI.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Button, Icon, Input, ProgressBar, ToastContainer, FileTreeSelector, FileNode, QRCode, TrackerTemplates, MetadataPreview, BatchCreate } from '../components';
import { CreateTorrentOptions, CreateTorrentProgress, CreateTorrentResult } from '../../shared/types';
import { useTranslation } from '../utils/i18nContext';
import { useCreateTorrentStore } from '../stores/createTorrentStore';
import './CreateTorrentPage.css';

// Utility functions
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatDate = (date: Date): string => {
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
};

interface CreateTorrentPageProps {
  onNavigateBack?: () => void;
}

type SourceMode = 'folder' | 'files';

// Toast item type
interface ToastItem {
  id: string;
  message: string;
  variant?: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
}

// Piece size options in bytes
const PIECE_SIZE_OPTIONS = [
  { label: 'Auto (Recommended)', value: 0 },
  { label: '16 KB', value: 16 * 1024 },
  { label: '32 KB', value: 32 * 1024 },
  { label: '64 KB', value: 64 * 1024 },
  { label: '128 KB', value: 128 * 1024 },
  { label: '256 KB', value: 256 * 1024 },
  { label: '512 KB', value: 512 * 1024 },
  { label: '1 MB', value: 1024 * 1024 },
  { label: '2 MB', value: 2 * 1024 * 1024 },
  { label: '4 MB', value: 4 * 1024 * 1024 },
  { label: '8 MB', value: 8 * 1024 * 1024 },
  { label: '16 MB', value: 16 * 1024 * 1024 },
];

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
  const { t } = useTranslation();
  // Source selection
  const [sourceMode, setSourceMode] = useState<SourceMode>('folder');
  const [sourcePaths, setSourcePaths] = useState<string[]>([]);
  const [sourceSize, setSourceSize] = useState<number>(0);
  const [sourceFileCount, setSourceFileCount] = useState<number>(0);
  
  // Torrent options
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [pieceLength, setPieceLength] = useState(0);
  const [trackers, setTrackers] = useState<string>('');
  const [webSeeds, setWebSeeds] = useState('');
  const [startSeeding, setStartSeeding] = useState(true);
  const [createdBy, setCreatedBy] = useState('TorrentHunt');
  
  // Create-session state lives in a store so it survives navigation away from
  // this page (creating in the background, returning to see the result).
  const stage = useCreateTorrentStore(s => s.stage);
  const progress = useCreateTorrentStore(s => s.progress);
  const result = useCreateTorrentStore(s => s.result);
  const error = useCreateTorrentStore(s => s.error);
  const setError = useCreateTorrentStore(s => s.setError);
  const startCreate = useCreateTorrentStore(s => s.start);
  const resetCreate = useCreateTorrentStore(s => s.reset);

  // UI state
  const [activeTab, setActiveTab] = useState<'basic' | 'trackers' | 'advanced'>('basic');
  const [copiedMagnet, setCopiedMagnet] = useState(false);
  const [copiedHash, setCopiedHash] = useState(false);
  
  // Toast notifications
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  
  // History of created torrents
  const [history, setHistory] = useState<CreatedTorrentHistory[]>([]);
  
  // Drag and drop
  const [isDragging, setIsDragging] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  
  // File list for preview
  const [fileList, setFileList] = useState<Array<{name: string, size: number, path: string}>>([]);
  
  // New features state
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [excludedPaths, setExcludedPaths] = useState<Set<string>>(new Set());
  const [showFileTree, setShowFileTree] = useState(false);
  const [showTrackerTemplates, setShowTrackerTemplates] = useState(false);
  const [showMetadataPreview, setShowMetadataPreview] = useState(false);
  const [showBatchCreate, setShowBatchCreate] = useState(false);
  const [showQRCode, setShowQRCode] = useState(false);

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
    window.api.getDefaultTrackers().then((defaultTrackers) => {
      const trackerList = defaultTrackers.map(group => group.join('\n')).join('\n');
      setTrackers(trackerList);
    });
  }, []);

  // Load path info when source changes
  useEffect(() => {
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
        const files: Array<{name: string, size: number, path: string}> = [];

        for (const sourcePath of sourcePaths) {
          const info = await window.api.getPathInfo(sourcePath);
          totalSize += info.size;
          totalFiles += info.fileCount;
          files.push({
            name: info.name,
            size: info.size,
            path: sourcePath
          });
        }

        setSourceSize(totalSize);
        setSourceFileCount(totalFiles);
        setFileList(files);

        // Build the REAL recursive file tree so the user can exclude individual
        // files (not just top-level items).
        try {
          const tree = await window.api.getFileTree(sourcePaths);
          setFileTree(tree as FileNode[]);
        } catch (treeErr) {
          console.error('Failed to build file tree:', treeErr);
          // Fallback: flat top-level nodes
          setFileTree(files.map(file => ({
            path: file.path, name: file.name, size: file.size,
            isDirectory: sourceMode === 'folder', children: [],
          })));
        }
        // Reset exclusions whenever the source changes
        setExcludedPaths(new Set());
      } catch (err) {
        console.error('Failed to get path info:', err);
      }
    };

    loadPathInfo();
  }, [sourcePaths]);

  // Handle file selection
  const handleSelectFiles = useCallback(async () => {
    const paths = await window.api.selectFilesForTorrent();
    if (paths && paths.length > 0) {
      setSourcePaths(paths);
      
      // Auto-set name from first file if not set. Keep the extension — for a
      // single-file torrent the name IS the file name, and stripping it makes
      // the torrent name diverge from the file on disk, so "start seeding"
      // can't find it (stuck at 0%) and sharing breaks.
      if (!name && paths.length === 1) {
        setName(paths[0].split(/[/\\]/).pop() || '');
      }
      addToast(`Selected ${paths.length} file(s)`, 'success');
    }
  }, [name, addToast]);

  const handleSelectFolder = useCallback(async () => {
    const folder = await window.api.selectFolderForTorrent();
    if (folder) {
      setSourcePaths([folder]);
      
      // Auto-set name from folder name if not set
      if (!name) {
        const folderName = folder.split(/[/\\]/).pop() || '';
        setName(folderName);
      }
      addToast('Folder selected', 'success');
    }
  }, [name, addToast]);

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      // Resolve real filesystem paths (webUtils / legacy File.path)
      const paths = files.map(f => window.api.getPathForFile(f)).filter(Boolean);
      if (paths.length === 0) {
        addToast('Could not read the dropped path. Use the Select button instead.', 'error');
        return;
      }
      setSourcePaths(paths);
      setSourceFileCount(paths.length);

      if (!name && paths[0]) {
        const fileName = paths[0].split(/[/\\]/).pop() || '';
        setName(fileName.replace(/\.[^/.]+$/, ''));
      }
      addToast(`Added ${paths.length} item(s)`, 'success');
    }
  }, [name, addToast]);

  // Clear selection
  const handleClearSource = useCallback(() => {
    setSourcePaths([]);
    setSourceSize(0);
    setSourceFileCount(0);
    setFileList([]);
    setName('');
  }, []);

  // Calculate estimated piece info
  const getEstimatedPieceInfo = useCallback(() => {
    if (sourceSize === 0) return null;
    
    let actualPieceLength = pieceLength;
    if (actualPieceLength === 0) {
      // Auto calculate optimal piece size
      if (sourceSize < 16 * 1024 * 1024) actualPieceLength = 16 * 1024;
      else if (sourceSize < 64 * 1024 * 1024) actualPieceLength = 32 * 1024;
      else if (sourceSize < 128 * 1024 * 1024) actualPieceLength = 64 * 1024;
      else if (sourceSize < 256 * 1024 * 1024) actualPieceLength = 128 * 1024;
      else if (sourceSize < 512 * 1024 * 1024) actualPieceLength = 256 * 1024;
      else if (sourceSize < 1024 * 1024 * 1024) actualPieceLength = 512 * 1024;
      else if (sourceSize < 2 * 1024 * 1024 * 1024) actualPieceLength = 1024 * 1024;
      else if (sourceSize < 4 * 1024 * 1024 * 1024) actualPieceLength = 2 * 1024 * 1024;
      else actualPieceLength = 4 * 1024 * 1024;
    }
    
    const pieceCount = Math.ceil(sourceSize / actualPieceLength);
    const torrentFileSize = pieceCount * 20 + 1000; // SHA1 hashes + metadata
    
    return {
      pieceLength: actualPieceLength,
      pieceCount,
      estimatedTorrentSize: torrentFileSize
    };
  }, [sourceSize, pieceLength]);

  const pieceInfo = getEstimatedPieceInfo();

  // Create torrent
  const handleCreate = useCallback(async () => {
    if (sourcePaths.length === 0) {
      setError('Please select files or folder');
      addToast('Please select files or folder first', 'warning');
      return;
    }

    // Get output path
    const outputPath = await window.api.selectSaveTorrentPath(name || 'torrent');
    if (!outputPath) return;

    setError(null);

    // Parse trackers
    const announceList: string[][] = [];
    const trackerLines = trackers.split('\n').map(l => l.trim()).filter(l => l);
    for (const line of trackerLines) {
      if (line.startsWith('udp://') || line.startsWith('http://') || line.startsWith('https://')) {
        announceList.push([line]);
      }
    }

    // Parse web seeds
    const urlList = webSeeds
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('http://') || l.startsWith('https://'));

    const options: CreateTorrentOptions = {
      name: name || undefined,
      comment: comment || undefined,
      createdBy: createdBy || 'TorrentHunt',
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
        isSeeding: startSeeding,
      };
      setHistory(prev => [historyItem, ...prev.slice(0, 9)]); // Keep last 10
      addToast('Torrent created successfully!', 'success');
    } else {
      addToast(r.error || 'Failed to create torrent', 'error');
    }
  }, [sourcePaths, name, comment, createdBy, trackers, webSeeds, isPrivate, pieceLength, startSeeding, excludedPaths, addToast, setError, startCreate]);

  // Copy magnet link
  const handleCopyMagnet = useCallback(() => {
    if (result?.magnetUri) {
      navigator.clipboard.writeText(result.magnetUri);
      setCopiedMagnet(true);
      setTimeout(() => setCopiedMagnet(false), 2000);
      addToast('Magnet link copied!', 'success');
    }
  }, [result, addToast]);

  // Copy info hash
  const handleCopyHash = useCallback(() => {
    if (result?.infoHash) {
      navigator.clipboard.writeText(result.infoHash);
      setCopiedHash(true);
      setTimeout(() => setCopiedHash(false), 2000);
      addToast('Info hash copied!', 'success');
    }
  }, [result, addToast]);

  // Show in folder
  const handleShowInFolder = useCallback(() => {
    if (result?.torrentFilePath) {
      window.api.showItemInFolder(result.torrentFilePath);
    }
  }, [result]);

  // Create new torrent (reset)
  const handleCreateNew = useCallback(() => {
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
  }, [resetCreate]);
  
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
    setTrackers(trackerList.join('\n'));
    addToast('Tracker template applied', 'success');
  }, [addToast]);
  
  // Metadata preview handler
  const handleShowMetadataPreview = useCallback(() => {
    setShowMetadataPreview(true);
  }, []);
  
  const handleConfirmCreate = useCallback(() => {
    setShowMetadataPreview(false);
    handleCreate();
  }, [handleCreate]);

  // Render source selection UI
  const renderSourceSelector = () => {
    // If no source selected - show drop zone
    if (sourcePaths.length === 0) {
      return (
        <div 
          className="source-dropzone"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={sourceMode === 'folder' ? handleSelectFolder : handleSelectFiles}
        >
          <div className={`dropzone-content ${isDragging ? 'dragging' : ''}`}>
            <div className="dropzone-icon">
              <Icon name={sourceMode === 'folder' ? 'folder-plus' : 'file-plus'} size={48} />
            </div>
            <div className="dropzone-text">
              <p className="dropzone-title">
                {isDragging 
                  ? 'Drop here!' 
                  : `Drag & drop ${sourceMode === 'folder' ? 'a folder' : 'files'} here`}
              </p>
              <p className="dropzone-subtitle">or click to browse</p>
            </div>
          </div>
        </div>
      );
    }

    // Source is selected - show info
    const sourceName = name || sourcePaths[0].split(/[/\\]/).pop() || 'Unknown';
    
    return (
      <div className="source-selected">
        <div className="source-card">
          <div className="source-card-icon">
            <Icon name={sourceMode === 'folder' ? 'folder' : 'file'} size={32} />
          </div>
          <div className="source-card-info">
            <h4 className="source-card-name">{sourceName}</h4>
            <p className="source-card-meta">
              {sourceFileCount} {sourceFileCount === 1 ? 'file' : 'files'}
              {sourceSize > 0 && ` • ${formatBytes(sourceSize)}`}
            </p>
          </div>
          <button className="source-card-remove" onClick={handleClearSource} title="Remove">
            <Icon name="x" size={18} />
          </button>
        </div>
        
        <button 
          className="source-change-button"
          onClick={sourceMode === 'folder' ? handleSelectFolder : handleSelectFiles}
        >
          <Icon name="refresh" size={16} />
          Change {sourceMode === 'folder' ? 'Folder' : 'Files'}
        </button>
      </div>
    );
  };

  return (
    <div className="page-container create-torrent-page">
      {/* Page Header */}
      <div className="page-header create-header">
        <div className="page-title-section">
          <button className="back-button" onClick={onNavigateBack} title="Back to Downloads">
            <Icon name="chevron-left" size={20} />
          </button>
          <div className="page-title-wrapper">
            <h1 className="page-title">
              <Icon name="file-plus" size={24} />
              {t('create.title')}
            </h1>
            <span className="page-subtitle">{t('create.subtitle')}</span>
          </div>
        </div>
        
        <div className="header-actions">
          {stage === 'setup' && (
            <>
              <Button variant="ghost" onClick={() => setShowBatchCreate(true)}>
                <Icon name="layers" size={16} />
                Batch Create
              </Button>
            </>
          )}
          {stage === 'success' && (
            <Button variant="secondary" onClick={handleCreateNew}>
              <Icon name="plus" size={16} />
              Create New
            </Button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="page-content create-content">
        {stage === 'setup' && (
          <div className="create-layout">
            {/* Left Panel - Source Selection */}
            <div className="create-panel source-panel">
              <div className="panel-header">
                <h3>
                  <Icon name="folder-plus" size={18} />
                  Source
                </h3>
              </div>
              
              <div className="panel-content">
                {/* Source Mode Toggle */}
                <div className="source-mode-toggle">
                  <button
                    className={`mode-btn ${sourceMode === 'folder' ? 'active' : ''}`}
                    onClick={() => setSourceMode('folder')}
                  >
                    <Icon name="folder" size={18} />
                    <span>Folder</span>
                  </button>
                  <button
                    className={`mode-btn ${sourceMode === 'files' ? 'active' : ''}`}
                    onClick={() => setSourceMode('files')}
                  >
                    <Icon name="file" size={18} />
                    <span>Files</span>
                  </button>
                </div>

                {/* Source Selection Area */}
                {renderSourceSelector()}
                
                {/* File Tree Selector */}
                {sourcePaths.length > 0 && fileTree.length > 0 && (
                  <div className="file-tree-section">
                    <div className="section-header">
                      <h4>
                        <Icon name="list" size={14} />
                        Files to Include
                      </h4>
                      <button
                        className="toggle-tree-btn"
                        onClick={() => setShowFileTree(!showFileTree)}
                      >
                        <Icon name={showFileTree ? 'chevron-up' : 'chevron-down'} size={14} />
                        {showFileTree ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    {showFileTree && (
                      <FileTreeSelector
                        files={fileTree}
                        excludedPaths={excludedPaths}
                        onToggle={handleToggleFile}
                        onToggleAll={handleToggleAllFiles}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Right Panel - Options */}
            <div className="create-panel options-panel">
              <div className="panel-header">
                <h3>
                  <Icon name="settings" size={18} />
                  Options
                </h3>
                <div className="options-tabs">
                  <button 
                    className={`tab-btn ${activeTab === 'basic' ? 'active' : ''}`}
                    onClick={() => setActiveTab('basic')}
                  >
                    <Icon name="file-text" size={14} />
                    Basic
                  </button>
                  <button 
                    className={`tab-btn ${activeTab === 'trackers' ? 'active' : ''}`}
                    onClick={() => setActiveTab('trackers')}
                  >
                    <Icon name="server" size={14} />
                    Trackers
                  </button>
                  <button 
                    className={`tab-btn ${activeTab === 'advanced' ? 'active' : ''}`}
                    onClick={() => setActiveTab('advanced')}
                  >
                    <Icon name="zap" size={14} />
                    Advanced
                  </button>
                </div>
              </div>

              <div className="panel-content">
                {/* Basic Tab */}
                {activeTab === 'basic' && (
                  <div className="options-form">
                    {/* Torrent Name */}
                    <div className="form-field">
                      <label className="field-label">
                        <Icon name="type" size={14} />
                        {t('create.name')}
                      </label>
                      <input
                        type="text"
                        className="field-input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('create.name.placeholder')}
                      />
                      <p className="field-hint">Leave empty to use source folder/file name</p>
                    </div>

                    {/* Description */}
                    <div className="form-field">
                      <label className="field-label">
                        <Icon name="file-text" size={14} />
                        {t('create.comment')}
                      </label>
                      <textarea
                        className="field-textarea"
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder={t('create.comment.placeholder')}
                        rows={3}
                      />
                    </div>

                    {/* Toggle Options */}
                    <div className="toggle-group">
                      <label className="toggle-option">
                        <div className="toggle-info">
                          <span className="toggle-name">{t('create.startSeeding')}</span>
                          <span className="toggle-desc">Begin sharing after creation</span>
                        </div>
                        <div className="toggle-control">
                          <input
                            type="checkbox"
                            checked={startSeeding}
                            onChange={(e) => setStartSeeding(e.target.checked)}
                          />
                          <span className="toggle-track"></span>
                        </div>
                      </label>

                      <label className="toggle-option">
                        <div className="toggle-info">
                          <span className="toggle-name">{t('create.private')}</span>
                          <span className="toggle-desc">Disable DHT/PEX (for private trackers)</span>
                        </div>
                        <div className="toggle-control">
                          <input
                            type="checkbox"
                            checked={isPrivate}
                            onChange={(e) => setIsPrivate(e.target.checked)}
                          />
                          <span className="toggle-track"></span>
                        </div>
                      </label>
                    </div>
                  </div>
                )}

                {/* Trackers Tab */}
                {activeTab === 'trackers' && (
                  <div className="options-form">
                    <div className="form-field">
                      <div className="field-header">
                        <label className="field-label">
                          <Icon name="server" size={14} />
                          {t('create.trackers')}
                        </label>
                        <span className="tracker-count">
                          {trackers.split('\n').filter(t => t.trim()).length} trackers
                        </span>
                      </div>
                      <textarea
                        className="field-textarea tracker-textarea"
                        value={trackers}
                        onChange={(e) => setTrackers(e.target.value)}
                        placeholder={t('create.trackers.placeholder')}
                        rows={10}
                      />
                      <p className="field-hint">
                        Public trackers are pre-filled. Add custom trackers or modify as needed.
                      </p>
                    </div>

                    <div className="tracker-buttons">
                      <button
                        className="tracker-btn"
                        onClick={() => setShowTrackerTemplates(true)}
                      >
                        <Icon name="layout-template" size={14} />
                        Templates
                      </button>
                      <button
                        className="tracker-btn"
                        onClick={() => {
                          window.api.getDefaultTrackers().then((defaultTrackers) => {
                            const trackerList = defaultTrackers.map(group => group.join('\n')).join('\n');
                            setTrackers(trackerList);
                            addToast('Default trackers restored', 'success');
                          });
                        }}
                      >
                        <Icon name="refresh" size={14} />
                        Restore Defaults
                      </button>
                      <button
                        className="tracker-btn danger"
                        onClick={() => {
                          setTrackers('');
                          addToast('Trackers cleared', 'info');
                        }}
                      >
                        <Icon name="trash" size={14} />
                        Clear All
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
                        Piece Size
                      </label>
                      <select
                        className="field-select"
                        value={pieceLength}
                        onChange={(e) => setPieceLength(Number(e.target.value))}
                      >
                        {PIECE_SIZE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <p className="field-hint">
                        Auto mode chooses optimal size based on content. Smaller = more pieces, larger = fewer pieces.
                      </p>
                    </div>

                    {/* Source Info */}
                    {sourceSize > 0 && pieceInfo && (
                      <div className="piece-info-card">
                        <div className="piece-info-row">
                          <span className="piece-info-label">Total Size</span>
                          <span className="piece-info-value">{formatBytes(sourceSize)}</span>
                        </div>
                        <div className="piece-info-row">
                          <span className="piece-info-label">Piece Size</span>
                          <span className="piece-info-value">{formatBytes(pieceInfo.pieceLength)}</span>
                        </div>
                        <div className="piece-info-row">
                          <span className="piece-info-label">Total Pieces</span>
                          <span className="piece-info-value">{pieceInfo.pieceCount.toLocaleString()}</span>
                        </div>
                        <div className="piece-info-row">
                          <span className="piece-info-label">Est. .torrent Size</span>
                          <span className="piece-info-value">{formatBytes(pieceInfo.estimatedTorrentSize)}</span>
                        </div>
                      </div>
                    )}

                    {/* Created By */}
                    <div className="form-field">
                      <label className="field-label">
                        <Icon name="user" size={14} />
                        Created By
                      </label>
                      <input
                        type="text"
                        className="field-input"
                        value={createdBy}
                        onChange={(e) => setCreatedBy(e.target.value)}
                        placeholder="TorrentHunt"
                      />
                    </div>

                    {/* Web Seeds */}
                    <div className="form-field">
                      <label className="field-label">
                        <Icon name="external-link" size={14} />
                        Web Seeds (Optional)
                      </label>
                      <textarea
                        className="field-textarea"
                        value={webSeeds}
                        onChange={(e) => setWebSeeds(e.target.value)}
                        placeholder="HTTP/HTTPS URLs for direct download fallback..."
                        rows={3}
                      />
                      <p className="field-hint">
                        Add HTTP URLs hosting the same files as backup download sources.
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
                  <Icon name="loader" size={64} />
                </div>
                <svg className="progress-ring" viewBox="0 0 120 120">
                  <circle
                    className="progress-ring-bg"
                    cx="60"
                    cy="60"
                    r="52"
                    strokeWidth="8"
                    fill="none"
                  />
                  <circle
                    className="progress-ring-fill"
                    cx="60"
                    cy="60"
                    r="52"
                    strokeWidth="8"
                    fill="none"
                    strokeDasharray={`${2 * Math.PI * 52}`}
                    strokeDashoffset={`${2 * Math.PI * 52 * (1 - progress.progress)}`}
                  />
                </svg>
              </div>
              
              <h2 className="progress-title">Creating Torrent</h2>
              <p className="progress-stage">{progress.stage === 'hashing' ? 'Hashing files...' : progress.message}</p>
              
              <div className="progress-bar-wrapper">
                <ProgressBar value={progress.progress} />
                <span className="progress-percent">{Math.round(progress.progress * 100)}%</span>
              </div>

              <div className="progress-details">
                <div className="progress-detail-item">
                  <Icon name="file" size={14} />
                  <span>{name || 'Torrent'}</span>
                </div>
                <div className="progress-detail-item">
                  <Icon name="clock" size={14} />
                  <span>Please wait...</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Success Stage */}
        {stage === 'success' && result && (
          <div className="create-success-view">
            <div className="success-card">
              <div className="success-header">
                <div className="success-icon-wrapper">
                  <Icon name="check-circle" size={64} />
                </div>
                <h2>Torrent Created Successfully!</h2>
                <p>Your torrent file is ready to share</p>
              </div>

              <div className="success-info-grid">
                <div className="info-card">
                  <div className="info-card-icon">
                    <Icon name="file" size={20} />
                  </div>
                  <div className="info-card-content">
                    <span className="info-label">File Name</span>
                    <span className="info-value truncate">{result.torrentFilePath.split(/[/\\]/).pop()}</span>
                  </div>
                </div>

                <div className="info-card">
                  <div className="info-card-icon">
                    <Icon name="hard-drive" size={20} />
                  </div>
                  <div className="info-card-content">
                    <span className="info-label">Total Size</span>
                    <span className="info-value">{formatBytes(result.totalSize)}</span>
                  </div>
                </div>

                <div className="info-card">
                  <div className="info-card-icon">
                    <Icon name="grid" size={20} />
                  </div>
                  <div className="info-card-content">
                    <span className="info-label">Pieces</span>
                    <span className="info-value">{result.pieceCount} × {formatBytes(result.pieceLength)}</span>
                  </div>
                </div>

                <div className="info-card">
                  <div className="info-card-icon">
                    <Icon name={startSeeding ? 'upload' : 'pause'} size={20} />
                  </div>
                  <div className="info-card-content">
                    <span className="info-label">Status</span>
                    <span className="info-value status-value">
                      {startSeeding ? 'Seeding' : 'Not seeding'}
                      {startSeeding && <span className="status-dot active"></span>}
                    </span>
                  </div>
                </div>
              </div>

              <div className="info-hash-section">
                <label className="section-label">Info Hash</label>
                <div className="hash-box">
                  <code className="hash-value">{result.infoHash}</code>
                  <Button
                    variant={copiedHash ? 'primary' : 'ghost'}
                    size="sm"
                    iconOnly
                    icon={<Icon name={copiedHash ? 'check' : 'copy'} size={16} />}
                    onClick={handleCopyHash}
                    title="Copy hash"
                  />
                </div>
              </div>

              <div className="magnet-section">
                <label className="section-label">Magnet Link</label>
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
                  >
                    <Icon name={copiedMagnet ? 'check' : 'copy'} size={16} />
                    {copiedMagnet ? 'Copied!' : 'Copy Link'}
                  </Button>
                </div>
                
                {/* QR Code Toggle */}
                <div className="qr-toggle">
                  <button
                    className="qr-toggle-btn"
                    onClick={() => setShowQRCode(!showQRCode)}
                  >
                    <Icon name="qr-code" size={14} />
                    {showQRCode ? 'Hide QR Code' : 'Show QR Code'}
                  </button>
                </div>
                
                {showQRCode && (
                  <div className="qr-code-wrapper">
                    <QRCode data={result.magnetUri} size={200} />
                    <p className="qr-hint">Scan to open magnet link on mobile device</p>
                  </div>
                )}
              </div>

              <div className="success-actions">
                <Button variant="ghost" onClick={handleShowInFolder}>
                  <Icon name="folder" size={16} />
                  Open Location
                </Button>
                <Button variant="primary" onClick={handleCreateNew}>
                  <Icon name="plus" size={16} />
                  Create Another
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Error Display */}
        {error && stage === 'setup' && (
          <div className="error-banner">
            <Icon name="alert-circle" size={18} />
            <span>{error}</span>
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
                  <Icon name="check-circle" size={14} />
                  <span className="preview-label">Source:</span>
                  <span className="preview-value">{name || 'Selected'}</span>
                </div>
                {pieceInfo && (
                  <>
                    <div className="preview-divider" />
                    <div className="preview-item">
                      <Icon name="grid" size={14} />
                      <span className="preview-label">Pieces:</span>
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
                  <span className="preview-label">Trackers:</span>
                  <span className="preview-value">{trackers.split('\n').filter(t => t.trim()).length}</span>
                </div>
              </div>
            ) : (
              <span className="footer-hint">
                <Icon name="info" size={14} />
                Select a folder or files to create a torrent
              </span>
            )}
          </div>
          <div className="footer-actions">
            <Button
              variant="secondary"
              size="lg"
              onClick={handleShowMetadataPreview}
              disabled={sourcePaths.length === 0}
            >
              <Icon name="eye" size={18} />
              Preview
            </Button>
            <Button
              variant="primary"
              size="lg"
              onClick={handleCreate}
              disabled={sourcePaths.length === 0}
              className="create-btn"
            >
              <Icon name="file-plus" size={18} />
              Create Torrent
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
            totalSize: sourceSize,
            fileCount: sourceFileCount,
            pieceSize: pieceInfo.pieceLength,
            pieceCount: pieceInfo.pieceCount,
            trackers: trackers.split('\n').map(l => l.trim()).filter(l => l),
            webSeeds: webSeeds ? webSeeds.split('\n').map(l => l.trim()).filter(l => l) : undefined,
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
