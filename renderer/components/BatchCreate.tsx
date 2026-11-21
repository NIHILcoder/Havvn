import { ErrorMessage } from './ErrorMessage';
/**
 * Batch Create Torrents Component
 * 
 * Create multiple torrents at once from a list of folders.
 */

import React, { useState, useCallback, useRef } from 'react';
import { Icon } from './Icon';
import { Button, ProgressBar } from '.';
import { Modal } from './Modal';
import { useTranslation } from '../utils/i18nContext';
import './BatchCreate.css';
import { parseTorrentUrls, isTorrentCreationCancelled } from '../../shared/torrent-creation';
import type { CreateTorrentResult } from '../../shared/types';
import { CreatedTorrentSeed } from './CreatedTorrentSeed';

interface BatchItem {
  id: string;
  path: string;
  name: string;
  size: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number | null;
  error?: string;
  result?: CreateTorrentResult;
}

interface BatchCreateProps {
  isOpen: boolean;
  onClose: () => void;
  trackers: string;
  isPrivate: boolean;
  pieceLength: number;
  startSeeding: boolean;
  createdBy: string;
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const BatchCreate: React.FC<BatchCreateProps> = ({
  isOpen,
  onClose,
  trackers,
  isPrivate,
  pieceLength,
  startSeeding,
  createdBy
}) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<BatchItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [validationError, setValidationError] = useState('');
  const stopRequested = useRef(false);
  const processing = useRef(false);
  const activeRequest = useRef<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [seedRetrying, setSeedRetrying] = useState<string | null>(null);
  const retryPending = useRef(false);
  const busy = isProcessing || !!seedRetrying;

  const handleRetrySeed = async (item: BatchItem) => {
    if (processing.current || retryPending.current || !item.result?.seedRetryId) return;
    retryPending.current = true; setSeedRetrying(item.id);
    try {
      const result = await window.api.retryCreatedTorrentSeed(item.result.seedRetryId);
      setItems(previous => previous.map(value => value.id === item.id ? { ...value, result } : value));
    } catch (cause) {
      const result: CreateTorrentResult = { ...item.result, seedingStatus: 'failed', seedingError: cause instanceof Error ? cause.message : String(cause) };
      setItems(previous => previous.map(value => value.id === item.id ? { ...value, result } : value));
    } finally { retryPending.current = false; setSeedRetrying(null); }
  };

  const handleAddFolders = useCallback(async () => {
    // Since we don't have selectMultipleFolders API yet, allow selecting one folder at a time
    const folder = await window.api.selectFolderForTorrent();
    if (!folder) return;

    const newItems: BatchItem[] = [];
    try {
      const info = await window.api.getPathInfo(folder);
      newItems.push({
        id: `${Date.now()}-${Math.random()}`,
        path: folder,
        name: info.name,
        size: info.size,
        status: 'pending'
      });
    } catch (err) {
      console.error('Failed to get folder info:', err);
    }

    setItems(prev => [...prev, ...newItems.filter(item => !prev.some(existing => existing.path === item.path))]);
  }, []);

  const handleRemoveItem = useCallback((id: string) => {
    setItems(prev => prev.filter(item => item.id !== id));
  }, []);

  const handleClearAll = useCallback(() => {
    if (!processing.current && !retryPending.current) {
      setItems([]);
      setCurrentIndex(0);
    }
  }, [isProcessing]);

  const handleStartBatch = useCallback(async () => {
    if (items.length === 0 || processing.current || retryPending.current) return;
    const parsedTrackers = parseTorrentUrls(trackers, 'tracker');
    if (parsedTrackers.invalidLines.length) {
      setValidationError(t('create.invalidTrackerLines').replace('{lines}', parsedTrackers.invalidLines.join(', ')));
      return;
    }
    setValidationError('');

    setIsProcessing(true);
    processing.current = true;
    stopRequested.current = false;
    setStopping(false);
    setCurrentIndex(0);

    const announceList = parsedTrackers.groups;

    // Process each item sequentially
    for (let i = 0; i < items.length; i++) {
      if (stopRequested.current) break;
      const item = items[i];
      if (item.status === 'completed') continue;
      setCurrentIndex(i);

      setItems(prev => prev.map(it => 
        it.id === item.id ? { ...it, status: 'processing' as const, progress: 0 } : it
      ));

      let unsubscribe: (() => void) | undefined;
      try {
        // Create output path
        const outputDir = await window.api.selectSaveTorrentPath(`${item.name}`);
        if (stopRequested.current) {
          setItems(prev => prev.map(it => it.id === item.id ? { ...it, status: 'pending', progress: undefined } : it));
          break;
        }
        if (!outputDir) {
          throw new Error(t('batchCreate.noOutputPath'));
        }

        // Listen to progress
        const requestId = crypto.randomUUID();
        activeRequest.current = requestId;
        unsubscribe = window.api.onCreateTorrentProgress((progressUpdate) => {
          if (progressUpdate.requestId !== requestId) return;
          setItems(prev => prev.map(it => 
            it.id === item.id ? { ...it, progress: progressUpdate.stage === 'verifying' ? null : progressUpdate.progress } : it
          ));
        });

        // Create torrent
        const result = await window.api.createTorrent({
          requestId,
          sourcePaths: [item.path],
          outputPath: outputDir,
          options: {
            name: item.name,
            createdBy,
            announceList,
            private: isPrivate,
            pieceLength: pieceLength > 0 ? pieceLength : undefined,
          },
          startSeeding,
        });

        setItems(prev => prev.map(it => 
          it.id === item.id 
            ? { 
                ...it, 
                status: 'completed' as const, 
                progress: 1,
                result,
              } 
            : it
        ));
      } catch (err) {
        if (isTorrentCreationCancelled(err)) {
          setItems(prev => prev.map(it => it.id === item.id ? { ...it, status: 'pending', progress: undefined, error: undefined } : it));
          break;
        }
        const errorMessage = err instanceof Error ? err.message : t('batchCreate.createFailed');
        setItems(prev => prev.map(it => 
          it.id === item.id 
            ? { ...it, status: 'failed' as const, error: errorMessage } 
            : it
        ));
      } finally {
        unsubscribe?.();
        activeRequest.current = null;
      }
    }

    setIsProcessing(false);
    processing.current = false;
    setStopping(false);
  }, [items, trackers, isPrivate, pieceLength, startSeeding, createdBy, isProcessing, t]);

  if (!isOpen) return null;

  const completedCount = items.filter(it => it.status === 'completed').length;
  const failedCount = items.filter(it => it.status === 'failed').length;
  const totalSize = items.reduce((sum, it) => sum + it.size, 0);

  return (
    <Modal
      onClose={onClose}
      title={t('batchCreate.title')}
      icon="layers"
      size="lg"
      className="torrent-batch-create"
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {isProcessing ? t('batchCreate.processing') : t('common.cancel')}
          </Button>
          {isProcessing && <Button variant="secondary" disabled={stopping} onClick={async () => {
            stopRequested.current = true;
            setStopping(true);
            if (!activeRequest.current) return;
            try { await window.api.cancelCreateTorrent(activeRequest.current); }
            catch (cause) { setValidationError(cause instanceof Error ? cause.message : String(cause)); }
          }}>{t(stopping ? 'create.cancelling' : 'batchCreate.stop')}</Button>}
          <Button
            variant="primary"
            onClick={handleStartBatch}
            disabled={items.length === 0 || busy}
          >
            <Icon name={isProcessing ? 'loader' : 'zap'} size={16} className={isProcessing ? 'spinning' : ''} />
            {isProcessing ? `${t('batchCreate.creating')} ${currentIndex + 1}/${items.length}...` : `${t('batchCreate.create')} ${items.length} ${t('batchCreate.torrents')}`}
          </Button>
        </>
      }
    >
      {validationError && <p className="item-error" role="alert"><ErrorMessage error={validationError} /></p>}
      <div className="batch-stats">
            <div className="stat-card">
              <Icon name="folder" size={16} />
              <div className="stat-info">
                <span className="stat-label">{t('batchCreate.folders')}</span>
                <span className="stat-value">{items.length}</span>
              </div>
            </div>
            <div className="stat-card">
              <Icon name="hard-drive" size={16} />
              <div className="stat-info">
                <span className="stat-label">{t('batchCreate.totalSize')}</span>
                <span className="stat-value">{formatBytes(totalSize)}</span>
              </div>
            </div>
            <div className="stat-card success">
              <Icon name="file" size={16} />
              <div className="stat-info">
                <span className="stat-label">{t('status.completed')}</span>
                <span className="stat-value">{completedCount}</span>
              </div>
            </div>
            {failedCount > 0 && (
              <div className="stat-card error">
                <Icon name="x-circle" size={16} />
                <div className="stat-info">
                  <span className="stat-label">{t('batchCreate.failed')}</span>
                  <span className="stat-value">{failedCount}</span>
                </div>
              </div>
            )}
          </div>

          <div className="batch-actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleAddFolders}
              disabled={busy}
            >
              <Icon name="folder-plus" size={14} />
              {t('batchCreate.addFolders')}
            </Button>
            {items.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearAll}
                disabled={busy}
              >
                <Icon name="trash" size={14} />
                {t('downloads.clearAll')}
              </Button>
            )}
          </div>

          {items.length === 0 ? (
            <div className="batch-empty">
              <Icon name="folder-open" size={48} />
              <h4>{t('batchCreate.emptyTitle')}</h4>
              <p>{t('batchCreate.emptyHint')}</p>
            </div>
          ) : (
            <div className="batch-list">
              {items.map((item, index) => (
                <div
                  key={item.id}
                  className={`batch-item ${item.status} ${currentIndex === index && isProcessing ? 'current' : ''}`}
                >
                  <div className="item-icon">
                    {item.status === 'pending' && <Icon name="folder" size={20} />}
                    {item.status === 'processing' && <Icon name="loader" size={20} className="spinning" />}
                    {item.status === 'completed' && <Icon name="file" size={20} />}
                    {item.status === 'failed' && <Icon name="x-circle" size={20} />}
                  </div>

                  <div className="item-info">
                    <div className="item-header">
                      <span className="item-name" title={item.name}>{item.name}</span>
                      <span className="item-size">{formatBytes(item.size)}</span>
                    </div>
                    
                    {item.status === 'processing' && item.progress !== undefined && (
                      <div className="item-progress">
                        <ProgressBar value={item.progress} size="sm" />
                        <span className="progress-text">{item.progress === null ? t('create.verifyingSeed') : Math.round(item.progress * 100) + '%'}</span>
                      </div>
                    )}
                    
                    {item.status === 'failed' && item.error && (
                      <div className="item-error">
                        <Icon name="alert-circle" size={12} />
                        <ErrorMessage error={item.error} />
                      </div>
                    )}
                    
                    {item.status === 'completed' && item.result && (
                      <div className="item-success">
                        <Icon name="file" size={12} />
                        {t('batchCreate.createdSuccess')}
                      </div>
                    )}
                    {item.result && <CreatedTorrentSeed result={item.result} busy={seedRetrying === item.id}
                      disabled={busy && seedRetrying !== item.id} onRetry={() => void handleRetrySeed(item)} />}
                  </div>

                  {!busy && item.status === 'pending' && (
                    <button
                      className="item-remove"
                      onClick={() => handleRemoveItem(item.id)}
                      title={t('downloads.remove')}
                    >
                      <Icon name="x" size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
    </Modal>
  );
};

export default BatchCreate;
