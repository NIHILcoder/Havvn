/**
 * A single download row — compact (default) and detailed/expanded views.
 * Extracted from DownloadsPage.tsx to keep that file focused on list/page logic.
 */

import React, { useState } from 'react';
import { Download, DownloadStats } from '../../shared/types';
import { canPause } from '../../shared/state-machine';
import { Button, Icon, ProgressBar, StatusBadge, HealthBadge } from '../components';
import { ViewMode, formatBytes, formatSpeed, formatEta, getTypeIcon, looksLikeMedia, isAudioMedia } from './download-helpers';
import { useCategories, categoryLabel } from '../utils/useCategories';
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
  onShare?: (id: string) => void;
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
  onShare,
}) => {
  const { t } = useTranslation();
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const categories = useCategories();
  const categoryColor = categories.find(c => c.id === download.category)?.color;

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
    const typeIcon = getTypeIcon(download);
    const ratio = currentStats.downloadedBytes > 0
      ? currentStats.uploadedBytes / currentStats.downloadedBytes
      : null;

    // Right-hand label over the progress bar: eta while downloading, the
    // give-back ratio once finished, otherwise the state name.
    const progLabel =
      status === 'downloading' ? formatEta(currentStats.etaSeconds)
      : status === 'seeding' || status === 'completed' ? (ratio !== null ? `${ratio.toFixed(2)}×` : '—')
      : t(`status.${status}`).toLowerCase();

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
          className="trow-main"
          onClick={() => onToggleExpand?.(download.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleExpand?.(download.id);
            }
          }}
          role="button"
          tabIndex={0}
          title={t('downloads.clickDetails')}
        >
          <span className={`trow-tile tile-${typeIcon}`}>
            <Icon name={typeIcon} size={17} />
          </span>
          <div className="trow-name">
            <div className="trow-title truncate">{download.name}</div>
            <div className="trow-sub">
              {download.totalSize > 0 && <span>{formatBytes(download.totalSize)}</span>}
              {/* Shown only at widths where the progress column is dropped */}
              <span className="trow-sub-pct">{(progress * 100).toFixed(0)}%</span>
              {/* Stored as a Category id, so resolve it — the raw "movies" was
                  never meant to be the label the user reads. */}
              {download.category && (
                <span className="trow-sub-cat" style={categoryColor ? { color: categoryColor } : undefined}>
                  {categoryLabel(categories, download.category)}
                </span>
              )}
              {status === 'error' && download.lastError && (
                <span className="error-text truncate">{download.lastError}</span>
              )}
            </div>
          </div>
          <div className="trow-prog">
            <div className="trow-prog-labels">
              <span className="trow-pct">{(progress * 100).toFixed(progress >= 1 ? 0 : 1)}%</span>
              <span className="trow-prog-hint">{progLabel}</span>
            </div>
            <ProgressBar value={progress} variant={getProgressVariant()} />
          </div>
          <div className="trow-rate">
            {status === 'downloading' ? (
              <>
                <span className="trow-rate-main rate-down">↓ {formatSpeed(currentStats.downSpeedBps)}</span>
                <span className="trow-rate-sub">
                  {currentStats.peers} {t('downloads.peersShort')}
                  {currentStats.seeds > 0 && ` · ${currentStats.seeds} ${t('downloads.seedsShort')}`}
                </span>
              </>
            ) : status === 'seeding' ? (
              <>
                <span className="trow-rate-main rate-up">↑ {formatSpeed(currentStats.upSpeedBps)}</span>
                <span className="trow-rate-sub">{currentStats.peers} {t('downloads.peersShort')}</span>
              </>
            ) : (
              <span className="trow-rate-sub">—</span>
            )}
          </div>
          <div className="trow-status">
            <StatusBadge status={status} showIcon={false} />
          </div>
        </div>

        {/* Hover-reveal actions (always visible on touch): Share + the one
            state action, then the icon utilities. Everything else lives in
            the ⋯ / right-click menu. */}
        <div className="trow-actions">
          {onShare && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="share-2" size={13} />}
              onClick={() => onShare(download.id)}
              title={t('downloads.share')}
            >
              {t('downloads.share')}
            </Button>
          )}
          {(status === 'downloading' || status === 'queued') && (
            <Button variant="ghost" size="sm" onClick={() => onPause(download.id)}>
              {t('downloads.pause')}
            </Button>
          )}
          {status === 'seeding' && (
            <Button variant="ghost" size="sm" onClick={() => onStopSeeding(download.id)} title={t('downloads.stopSeeding')}>
              {t('downloads.stop')}
            </Button>
          )}
          {status === 'paused' && (
            <Button variant="ghost" size="sm" onClick={() => onResume(download.id)}>
              {t('downloads.resume')}
            </Button>
          )}
          {status === 'error' && (
            <Button variant="ghost" size="sm" onClick={() => onRetry(download.id)}>
              {t('downloads.retry')}
            </Button>
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
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="more-horizontal" size={14} />}
            onClick={(e) => onContextMenu?.(e, download.id)}
            title={t('downloads.more')}
          />
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
