import { ErrorMessage } from './ErrorMessage';
/**
 * Create Torrent Modal
 * 
 * Modal dialog for creating .torrent files from local files/folders.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Button, Icon, Input, ProgressBar } from '../components';
import { Modal } from './Modal';
import { Select } from './Select';
import { Toggle } from './Toggle';
import { parseTorrentUrls, isTorrentCreationCancelled } from '../../shared/torrent-creation';
import { TORRENT_PIECE_SIZES, formatTorrentBytes } from '../../shared/create-torrent-labels';
import { useTranslation } from '../utils/i18nContext';
import { CreateTorrentOptions, CreateTorrentProgress, CreateTorrentResult } from '../../shared/types';
import './CreateTorrentModal.css';
import { CreatedTorrentSeed } from './CreatedTorrentSeed';
import { useClipboardCopy } from '../utils/useClipboardCopy';

interface CreateTorrentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (result: CreateTorrentResult) => void;
}

type SourceMode = 'files' | 'folder';
type CreateStage = 'setup' | 'creating' | 'success';

export const CreateTorrentModal: React.FC<CreateTorrentModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const { t, language } = useTranslation();
  const formatBytes = (bytes: number) => formatTorrentBytes(bytes, language);
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
  const [clipboardError, setClipboardError] = useState(false);
  const [seedRetrying, setSeedRetrying] = useState(false);
  const retryPending = useRef(false);
  const requestId = useRef<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

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
      if (progressUpdate.requestId === requestId.current) setProgress(progressUpdate);
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
      setClipboardError(false);
    }
  }, [isOpen]);

  const handleSelectFiles = useCallback(async () => {
    const paths = await window.api.selectFilesForTorrent();
    if (paths && paths.length > 0) {
      setSourcePaths(paths);
      // Auto-set name from first file if not set
      if (!name) {
        const fileName = paths[0].split(/[/\\]/).pop() || '';
        setName(fileName);
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
    requestId.current = crypto.randomUUID();
    setCancelling(false);
    setError(null);
    setProgress({ stage: 'hashing', progress: 0, message: t('create.starting') });

    try {
      const trackerUrls = parseTorrentUrls(trackers, 'tracker');
      const webSeedUrls = parseTorrentUrls(webSeeds, 'webSeed');
      if (trackerUrls.invalidLines.length) throw new Error(t('create.invalidTrackerLines').replace('{lines}', trackerUrls.invalidLines.join(', ')));
      if (webSeedUrls.invalidLines.length) throw new Error(t('create.invalidWebSeedLines').replace('{lines}', webSeedUrls.invalidLines.join(', ')));
      const announceList = trackerUrls.groups;
      const urlList = webSeedUrls.urls;

      const options: CreateTorrentOptions = {
        name: name || undefined,
        comment: comment || undefined,
        announceList,
        urlList: urlList.length > 0 ? urlList : undefined,
        private: isPrivate,
        pieceLength: pieceLength > 0 ? pieceLength : undefined,
      };

      const createResult = await window.api.createTorrent({
        requestId: requestId.current,
        sourcePaths,
        outputPath,
        options,
        startSeeding,
      });

      setResult(createResult);
      setStage('success');
      onSuccess?.(createResult);
    } catch (err) {
      setError(isTorrentCreationCancelled(err) ? null : err instanceof Error ? err.message : t('create.errorFailed'));
      setStage('setup');
    } finally { requestId.current = null; setCancelling(false); }
  }, [sourcePaths, name, comment, trackers, webSeeds, isPrivate, pieceLength, startSeeding, onSuccess]);

  const { copy: handleCopyMagnet, copied: copiedMagnet, copying: copyingMagnet } = useClipboardCopy(result?.magnetUri ?? '', {
    onSuccess: () => setClipboardError(false), onError: () => setClipboardError(true),
  });
  const handleRetrySeed = async () => {
    if (!result?.seedRetryId || retryPending.current) return;
    retryPending.current = true; setSeedRetrying(true);
    try {
      const updated = await window.api.retryCreatedTorrentSeed(result.seedRetryId);
      setResult(updated); onSuccess?.(updated);
    } catch (cause) {
      setResult({ ...result, seedingStatus: 'failed', seedingError: cause instanceof Error ? cause.message : String(cause) });
    } finally { retryPending.current = false; setSeedRetrying(false); }
  };

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
        <Button variant="secondary" disabled={cancelling || progress?.stage !== 'hashing'} onClick={async () => {
          const id = requestId.current;
          if (!id) return;
          setCancelling(true);
          try { if (!await window.api.cancelCreateTorrent(id)) setCancelling(false); }
          catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setCancelling(false); }
        }}>
          {t(progress?.stage !== 'hashing' ? 'create.pleaseWait' : cancelling ? 'create.cancelling' : 'create.cancelCreation')}
        </Button>
      )}

      {stage === 'success' && (
        <Button variant="primary" onClick={onClose} disabled={seedRetrying}>
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
      className="torrent-create-dialog"
      busy={stage === 'creating' || seedRetrying}
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
                      <Toggle checked={isPrivate} onChange={setIsPrivate} label={t('create.privateTorrent')} size="small" />
                      <span className="help-text inline">{t('create.privateHelp')}</span>
                    </div>

                    <div className="form-group">
                      <label className="label">{t('create.pieceSize')}</label>
                      <Select value={String(pieceLength)} onChange={value => setPieceLength(Number(value))}
                        ariaLabel={t('create.pieceSize')} options={TORRENT_PIECE_SIZES.map(value => ({
                          value: String(value), label: value === 0 ? t('create.pieceAuto') : formatBytes(value),
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
                <Toggle checked={startSeeding} onChange={setStartSeeding} label={t('create.startSeedingAfter')} size="small" />
              </div>

              {error && (
                <div className="error-message">
                  <Icon name="alert-circle" size={16} />
                  <ErrorMessage error={error} />
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
              <p className="creating-message">{progress.stage === 'verifying' ? t('create.verifyingSeed') : progress.stage === 'hashing' ? t('create.hashing') : progress.stage === 'writing' ? t('create.stageWriting') : t('create.stageComplete')}</p>
              <ProgressBar value={progress.stage === 'verifying' ? null : progress.progress} className="creating-progress" />
              {progress.stage !== 'verifying' && <span className="progress-percent">{Math.round(progress.progress * 100)}%</span>}
            </div>
          )}

          {stage === 'success' && result && (
            <div className="success-stage">
              <div className="success-icon">
                <Icon name="file" size={32} />
              </div>
              <h3>{t('create.created')}</h3>
              <CreatedTorrentSeed result={result} busy={seedRetrying} onRetry={() => void handleRetrySeed()} />

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
                    disabled={copyingMagnet}
                  >
                    <Icon name="copy" size={14} />
                    {copiedMagnet ? t('create.copied') : t('share.copy')}
                  </Button>
                </div>
                {clipboardError && <p className="help-text" role="alert">{t('create.copyFailed')}</p>}
              </div>

              <div className="success-actions">
                <Button variant="ghost" onClick={handleShowInFolder}>
                  <Icon name="folder" size={16} />
                  {t('create.showInFolder')}
                </Button>
                {result.seedingStatus === 'queued' && (
                  <span className="seeding-status">
                    <Icon name="upload" size={14} />
                    {t('create.seedQueued')}
                  </span>
                )}
              </div>
            </div>
          )}
        </Modal>
  );
};

export default CreateTorrentModal;
