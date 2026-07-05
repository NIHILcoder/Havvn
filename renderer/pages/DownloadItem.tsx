/**
 * A single download row — compact (default) and detailed/expanded views.
 * Extracted from DownloadsPage.tsx to keep that file focused on list/page logic.
 */

import React, { useState } from 'react';
import { Download, DownloadStats } from '../../shared/types';
import { canPause } from '../../shared/state-machine';
import { Button, Icon, ProgressBar, StatusBadge, HealthBadge } from '../components';
import { ViewMode, formatBytes, formatSpeed, formatEta, getTypeIcon, looksLikeMedia, isAudioMedia } from './download-helpers';
import { useTranslation } from '../utils/i18nContext';

export interface DownloadItemProps {
  download: Download;
  stats: DownloadStats | undefined;
  viewMode: ViewMode;
  expanded?: boolean;
  onToggleExpand?: (id: string) => void;
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
  onStream?: (id: string) => void;
}

export const DownloadItem: React.FC<DownloadItemProps> = ({
  download,
  stats,
  viewMode,
  expanded = false,
  onToggleExpand,
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
  onStream,
}) => {
  const { t } = useTranslation();
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

  // One-click "Watch/Listen" shortcut on media rows. Shown while there's
  // something to play (downloading — instant-play streams while it downloads —,
  // completed, or seeding); paused rows show Resume instead, so no icon clash.
  const canWatch = !!onStream && looksLikeMedia(download) &&
    (status === 'downloading' || status === 'completed' || status === 'seeding');
  const watchLabel = isAudioMedia(download) ? t('downloads.listen') : t('downloads.watch');

  const getProgressVariant = (): 'default' | 'success' | 'warning' | 'error' => {
    if (status === 'completed' || status === 'seeding') return 'success';
    if (status === 'error') return 'error';
    if (status === 'paused') return 'warning';
    return 'default';
  };

  // A row shows its full stats when globally in "detailed" mode OR when the user
  // has expanded just this one (accordion). Default is the compact row.
  const detailed = viewMode === 'detailed' || expanded;

  if (!detailed) {
    return (
      <div
        className={`download-item download-item-compact download-st-${status} ${isSelected ? 'selected' : ''}`}
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
        <div
          className="download-compact-main"
          onClick={() => onToggleExpand?.(download.id)}
          role="button"
          title={t('downloads.clickDetails')}
        >
          <span className={`download-expand-chevron ${expanded ? 'expanded' : ''}`}>
            <Icon name="chevron-down" size={14} />
          </span>
          <span className="download-type-icon"><Icon name={getTypeIcon(download)} size={15} /></span>
          <StatusBadge status={status} />
          <div className="download-compact-info">
            <span className="download-item-name truncate">{download.name}</span>
            <div className="download-compact-meta">
              <span className="progress-text">{(progress * 100).toFixed(1)}%</span>
              {status === 'downloading' && (
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
              title={t('downloads.pause')}
            />
          )}

          {(status === 'completed' || status === 'seeding') && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="folder" size={14} />}
              onClick={() => onOpenFolder(download.savePath)}
              title={t('downloads.openFolder')}
            />
          )}

          {status === 'paused' && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="play" size={14} />}
              onClick={() => onResume(download.id)}
              title={t('downloads.resume')}
            />
          )}

          {status === 'error' && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="refresh" size={14} />}
              onClick={() => onRetry(download.id)}
              title={t('downloads.retry')}
            />
          )}

          {canWatch && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              className="download-watch-btn"
              icon={<Icon name="play" size={14} />}
              onClick={() => onStream!(download.id)}
              title={watchLabel}
            />
          )}

          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="list" size={14} />}
            onClick={() => onShowFiles(download.id)}
            title={t('downloads.files')}
          />

          {!showRemoveConfirm ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="trash" size={14} />}
              onClick={() => setShowRemoveConfirm(true)}
              title={t('downloads.remove')}
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
                {t('downloads.deleteWithFiles')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onRemove(download.id, false);
                  setShowRemoveConfirm(false);
                }}
              >
                {t('downloads.keepFiles')}
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
      className={`download-item download-item-detailed download-st-${status} ${isSelected ? 'selected' : ''}`}
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
        <div
          className={`download-item-title ${viewMode === 'compact' ? 'collapsible' : ''}`}
          onClick={viewMode === 'compact' ? () => onToggleExpand?.(download.id) : undefined}
          title={viewMode === 'compact' ? t('downloads.collapse') : undefined}
        >
          {viewMode === 'compact' && (
            <span className="download-expand-chevron expanded"><Icon name="chevron-down" size={14} /></span>
          )}
          <span className="download-type-icon"><Icon name={getTypeIcon(download)} size={16} /></span>
          <span className="download-item-name">{download.name}</span>
          <StatusBadge status={status} />
        </div>
        <div className="download-item-actions">
          {canWatch && (
            <Button
              variant="ghost"
              size="sm"
              className="download-watch-btn"
              icon={<Icon name="play" size={16} />}
              onClick={() => onStream!(download.id)}
            >
              {watchLabel}
            </Button>
          )}

          {canPause(status) && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="pause" size={16} />}
              onClick={() => onPause(download.id)}
            >
              {t('downloads.pause')}
            </Button>
          )}

          {status === 'paused' && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="play" size={16} />}
              onClick={() => onResume(download.id)}
            >
              {t('downloads.resume')}
            </Button>
          )}

          {status === 'seeding' && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="stop" size={16} />}
              onClick={() => onStopSeeding(download.id)}
            >
              {t('downloads.stopSeeding')}
            </Button>
          )}

          {status === 'error' && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="refresh" size={16} />}
              onClick={() => onRetry(download.id)}
            >
              {t('downloads.retry')}
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="list" size={16} />}
            onClick={() => onShowFiles(download.id)}
          >
            {t('downloads.files')}
          </Button>

          {(status === 'completed' || status === 'seeding') && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="folder" size={16} />}
              onClick={() => onOpenFolder(download.savePath)}
            >
              {t('downloads.openFolder')}
            </Button>
          )}

          {!showRemoveConfirm ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="trash" size={16} />}
              onClick={() => setShowRemoveConfirm(true)}
            >
              {t('downloads.remove')}
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
                {t('downloads.deleteWithFiles')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onRemove(download.id, false);
                  setShowRemoveConfirm(false);
                }}
              >
                {t('downloads.keepFiles')}
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
              <span className="stat-label">{t('downloads.statDown')}</span>
              <span className="stat-value">{formatBytes(currentStats.downloadedBytes)}</span>
            </div>
          </div>

          <div className="stat-item">
            <Icon name="upload" size={12} />
            <div className="stat-content">
              <span className="stat-label">{t('downloads.statUp')}</span>
              <span className="stat-value">{formatBytes(currentStats.uploadedBytes)}</span>
            </div>
          </div>

          <div className="stat-item">
            <Icon name="percent" size={12} />
            <div className="stat-content">
              <span className="stat-label">{t('downloads.statRatio')}</span>
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
              <span className="stat-label">{t('downloads.statSize')}</span>
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
                  <span className="stat-label">{t('downloads.statSpeed')}</span>
                  <span className="stat-value">{formatSpeed(currentStats.downSpeedBps)}</span>
                </div>
              </div>

              <div className="stat-item">
                <Icon name="clock" size={12} />
                <div className="stat-content">
                  <span className="stat-label">{t('downloads.statEta')}</span>
                  <span className="stat-value">{formatEta(currentStats.etaSeconds)}</span>
                </div>
              </div>

              <div className="stat-item">
                <Icon name="users" size={12} />
                <div className="stat-content">
                  <span className="stat-label">{t('downloads.statPeers')}</span>
                  <span className="stat-value">{currentStats.peers}</span>
                </div>
              </div>

              <div className="stat-item">
                <Icon name="activity" size={12} />
                <div className="stat-content">
                  <span className="stat-label">{t('downloads.statHealth')}</span>
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
                  <span className="stat-label">{t('downloads.statSpeed')}</span>
                  <span className="stat-value">{formatSpeed(currentStats.upSpeedBps)}</span>
                </div>
              </div>

              <div className="stat-item">
                <Icon name="users" size={12} />
                <div className="stat-content">
                  <span className="stat-label">{t('downloads.statPeers')}</span>
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
