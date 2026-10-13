/**
 * Create Torrent Modal
 * 
 * Modal dialog for creating .torrent files from local files/folders.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, Icon, Input, ProgressBar } from '../components';
import { Modal } from './Modal';
import { Select } from './Select';
import { useTranslation } from '../utils/i18nContext';
import { CreateTorrentOptions, CreateTorrentProgress, CreateTorrentResult } from '../../shared/types';
import './CreateTorrentModal.css';

// Utility function
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

interface CreateTorrentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (result: CreateTorrentResult) => void;
}

type SourceMode = 'files' | 'folder';
type CreateStage = 'setup' | 'creating' | 'success';

// Piece size options in bytes
const PIECE_SIZE_OPTIONS = [
  { label: 'Auto', value: 0 },
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

export const CreateTorrentModal: React.FC<CreateTorrentModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const { t } = useTranslation();
  // Source selection
  const [sourceMode, setSourceMode] = useState<SourceMode>('folder');
  const [sourcePaths, setSourcePaths] = useState<string[]>([]);
  
  // Torrent options
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [pieceLength, setPieceLength] = useState(0);
  const [trackers, setTrackers] = useState<string>('');
  const [webSeeds, setWebSeeds] = useState('');
  const [startSeeding, setStartSeeding] = useState(true);
  
  // UI state
  const [stage, setStage] = useState<CreateStage>('setup');
  const [progress, setProgress] = useState<CreateTorrentProgress | null>(null);
  const [result, setResult] = useState<CreateTorrentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copiedMagnet, setCopiedMagnet] = useState(false);

  // Load default trackers on mount
  useEffect(() => {
    if (isOpen && trackers === '') {
      window.api.getDefaultTrackers().then((defaultTrackers) => {
        const trackerList = defaultTrackers.map(group => group.join('\n')).join('\n');
        setTrackers(trackerList);
      });
    }
  }, [isOpen]);

  // Subscribe to progress updates
  useEffect(() => {
    if (!isOpen) return;

    const unsubscribe = window.api.onCreateTorrentProgress((progressUpdate) => {
      setProgress(progressUpdate);
    });

    return () => unsubscribe();
  }, [isOpen]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSourcePaths([]);
      setName('');
      setComment('');
      setIsPrivate(false);
      setPieceLength(0);
      setWebSeeds('');
      setStartSeeding(true);
      setStage('setup');
      setProgress(null);
      setResult(null);
      setError(null);
      setShowAdvanced(false);
      setCopiedMagnet(false);
    }
  }, [isOpen]);

  const handleSelectFiles = useCallback(async () => {
    const paths = await window.api.selectFilesForTorrent();
    if (paths && paths.length > 0) {
      setSourcePaths(paths);
      // Auto-set name from first file if not set
      if (!name) {
        const fileName = paths[0].split(/[/\\]/).pop() || '';
        setName(fileName.replace(/\.[^/.]+$/, '')); // Remove extension
      }
    }
  }, [name]);

  const handleSelectFolder = useCallback(async () => {
    const folder = await window.api.selectFolderForTorrent();
    if (folder) {
      setSourcePaths([folder]);
      // Auto-set name from folder name if not set
      if (!name) {
        const folderName = folder.split(/[/\\]/).pop() || '';
        setName(folderName);
      }
    }
  }, [name]);

  const handleCreate = useCallback(async () => {
    if (sourcePaths.length === 0) {
      setError(t('create.errorSelect'));
      return;
    }

    // Get output path
    const outputPath = await window.api.selectSaveTorrentPath(name || 'torrent');
    if (!outputPath) return;

    setStage('creating');
    setError(null);
    setProgress({ stage: 'hashing', progress: 0, message: t('create.starting') });

    try {
      // Parse trackers (one per line, groups separated by empty line)
      const announceList: string[][] = [];
      const trackerLines = trackers.split('\n').map(l => l.trim()).filter(l => l);
      
      // Group trackers - each non-empty line is a group
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
        announceList,
        urlList: urlList.length > 0 ? urlList : undefined,
        private: isPrivate,
        pieceLength: pieceLength > 0 ? pieceLength : undefined,
      };

      const createResult = await window.api.createTorrent({
        sourcePaths,
        outputPath,
        options,
        startSeeding,
      });

      setResult(createResult);
      setStage('success');
      onSuccess?.(createResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('create.errorFailed'));
      setStage('setup');
    }
  }, [sourcePaths, name, comment, trackers, webSeeds, isPrivate, pieceLength, startSeeding, onSuccess]);

  const handleCopyMagnet = useCallback(() => {
    if (result?.magnetUri) {
      navigator.clipboard.writeText(result.magnetUri);
      setCopiedMagnet(true);
      setTimeout(() => setCopiedMagnet(false), 2000);
    }
  }, [result]);

  const handleShowInFolder = useCallback(() => {
    if (result?.torrentFilePath) {
      window.api.showItemInFolder(result.torrentFilePath);
    }
  }, [result]);

  if (!isOpen) return null;

  const footer = (
    <>
      {stage === 'setup' && (
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={sourcePaths.length === 0}
          >
            <Icon name="file-plus" size={16} />
            {t('nav.create')}
          </Button>
        </>
      )}

      {stage === 'creating' && (
        <Button variant="ghost" onClick={onClose} disabled>
          {t('create.pleaseWait')}
        </Button>
      )}

      {stage === 'success' && (
        <Button variant="primary" onClick={onClose}>
          {t('common.done')}
        </Button>
      )}
    </>
  );

  return (
    <Modal
      onClose={onClose}
      title={t('nav.create')}
      icon="file-plus"
      size="lg"
      footer={footer}
    >
      {stage === 'setup' && (
            <>
              {/* Source Selection */}
              <div className="form-section">
                <label className="section-label">{t('create.source')}</label>
                <div className="source-mode-tabs">
                  <button
                    className={`source-mode-tab ${sourceMode === 'folder' ? 'active' : ''}`}
                    onClick={() => setSourceMode('folder')}
                  >
                    <Icon name="folder" size={16} />
                    {t('rooms.folder')}
                  </button>
                  <button
                    className={`source-mode-tab ${sourceMode === 'files' ? 'active' : ''}`}
                    onClick={() => setSourceMode('files')}
                  >
                    <Icon name="file" size={16} />
                    {t('downloads.files')}
                  </button>
                </div>

                <div className="source-selection">
                  {sourcePaths.length === 0 ? (
                    <Button
                      variant="secondary"
                      onClick={sourceMode === 'folder' ? handleSelectFolder : handleSelectFiles}
                      className="select-source-btn"
                    >
                      <Icon name={sourceMode === 'folder' ? 'folder-plus' : 'file-plus'} size={18} />
                      {sourceMode === 'folder' ? t('create.selectFolder') : t('create.selectFilesBtn')}
                    </Button>
                  ) : (
                    <div className="selected-sources">
                      <div className="source-list">
                        {sourcePaths.map((p, i) => (
                          <div key={i} className="source-item">
                            <Icon name={sourceMode === 'folder' ? 'folder' : 'file'} size={14} />
                            <span className="source-path truncate">{p}</span>
                          </div>
                        ))}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={sourceMode === 'folder' ? handleSelectFolder : handleSelectFiles}
                      >
                        {t('create.change')}
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {/* Basic Options */}
              <div className="form-section">
                <Input
                  label={t('create.name')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('create.namePlaceholder')}
                />

                <Input
                  label={t('create.commentOptional')}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder={t('create.commentPlaceholder')}
                />
              </div>

              {/* Trackers */}
              <div className="form-section">
                <label className="section-label">{t('create.trackers')}</label>
                <textarea
                  className="tracker-textarea"
                  value={trackers}
                  onChange={(e) => setTrackers(e.target.value)}
                  placeholder={t('create.trackersPlaceholder')}
                  rows={4}
                />
                <span className="help-text">{t('create.trackersHelp')}</span>
              </div>

              {/* Advanced Options */}
              <div className="form-section">
                <button
                  className="advanced-toggle"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                >
                  <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={16} />
                  {t('create.advancedOptions')}
                </button>

                {showAdvanced && (
                  <div className="advanced-options">
                    <div className="form-row">
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={isPrivate}
                          onChange={(e) => setIsPrivate(e.target.checked)}
                        />
                        <span>{t('create.privateTorrent')}</span>
                      </label>
                      <span className="help-text inline">{t('create.privateHelp')}</span>
                    </div>

                    <div className="form-group">
                      <label className="label">{t('create.pieceSize')}</label>
                      <Select value={String(pieceLength)} onChange={value => setPieceLength(Number(value))}
                        ariaLabel={t('create.pieceSize')} options={PIECE_SIZE_OPTIONS.map(opt => ({
                          value: String(opt.value), label: opt.value === 0 ? t('create.pieceAuto') : opt.label,
                        }))} />
                      <span className="help-text">{t('create.pieceHelp')}</span>
                    </div>

                    <div className="form-group">
                      <label className="label">{t('create.webSeeds')}</label>
                      <textarea
                        className="tracker-textarea"
                        value={webSeeds}
                        onChange={(e) => setWebSeeds(e.target.value)}
                        placeholder={t('create.webSeedsPlaceholder')}
                        rows={2}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Start Seeding Option */}
              <div className="form-section">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={startSeeding}
                    onChange={(e) => setStartSeeding(e.target.checked)}
                  />
                  <span>{t('create.startSeedingAfter')}</span>
                </label>
              </div>

              {error && (
                <div className="error-message">
                  <Icon name="alert-circle" size={16} />
                  {error}
                </div>
              )}
            </>
          )}

          {stage === 'creating' && progress && (
            <div className="creating-stage">
              <div className="creating-icon">
                <Icon name="loader" size={48} className="spin" />
              </div>
              <h3>{t('create.creating')}</h3>
              <p className="creating-message">{progress.stage === 'hashing' ? t('create.hashing') : progress.stage === 'writing' ? t('create.stageWriting') : t('create.stageComplete')}</p>
              <ProgressBar value={progress.progress} className="creating-progress" />
              <span className="progress-percent">{Math.round(progress.progress * 100)}%</span>
            </div>
          )}

          {stage === 'success' && result && (
            <div className="success-stage">
              <div className="success-icon">
                <Icon name="check-circle" size={48} />
              </div>
              <h3>{t('create.created')}</h3>

              <div className="result-details">
                <div className="result-row">
                  <span className="result-label">{t('create.resultFile')}</span>
                  <span className="result-value truncate">{result.torrentFilePath}</span>
                </div>
                <div className="result-row">
                  <span className="result-label">{t('create.resultSize')}</span>
                  <span className="result-value">{formatBytes(result.totalSize)}</span>
                </div>
                <div className="result-row">
                  <span className="result-label">{t('create.resultPieces')}</span>
                  <span className="result-value">
                    {result.pieceCount} × {formatBytes(result.pieceLength)}
                  </span>
                </div>
                <div className="result-row">
                  <span className="result-label">{t('create.resultInfoHash')}</span>
                  <span className="result-value mono">{result.infoHash}</span>
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
                  />
                  <Button
                    variant={copiedMagnet ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={handleCopyMagnet}
                  >
                    <Icon name={copiedMagnet ? 'check' : 'copy'} size={14} />
                    {copiedMagnet ? t('create.copied') : t('share.copy')}
                  </Button>
                </div>
              </div>

              <div className="success-actions">
                <Button variant="ghost" onClick={handleShowInFolder}>
                  <Icon name="folder" size={16} />
                  {t('create.showInFolder')}
                </Button>
                {startSeeding && (
                  <span className="seeding-status">
                    <Icon name="upload" size={14} />
                    {t('create.seedingStarted')}
                  </span>
                )}
              </div>
            </div>
          )}
        </Modal>
  );
};

export default CreateTorrentModal;
