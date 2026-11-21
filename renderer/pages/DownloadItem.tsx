import { ErrorMessage } from '../components/ErrorMessage';
/**
 * A single download row — compact (default) and detailed/expanded views.
 * Extracted from DownloadsPage.tsx to keep that file focused on list/page logic.
 */

import React, { useState } from 'react';
import { Download, DownloadStats } from '../../shared/types';
import { canPause } from '../../shared/state-machine';
import { Button, Icon, ProgressBar, StatusBadge, HealthBadge, ContextMenu, Modal } from '../components';
import { ViewMode, formatBytes, formatSpeed, formatEta, getTypeIcon, looksLikeMedia, isAudioMedia } from './download-helpers';
import { useCategories, categoryLabel } from '../utils/useCategories';
import { useTranslation } from '../utils/i18nContext';
import { useDownloads } from '../state/downloads';
import { downloadOperation } from '../../shared/download-operation';
import { useOperationText, OperationStatus } from '../components/OperationStatus';

export const ConnectedDownloadItem = React.memo((props: Omit<DownloadItemProps, 'download' | 'stats'> & { downloadId: string }) => {
  const { downloadId, ...rowProps } = props;
  const download = useDownloads(s => s.byId.get(downloadId));
  const stats = useDownloads(s => s.statsById.get(downloadId));
  return download ? <DownloadItem {...rowProps} download={download} stats={stats} /> : null;
});

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
  onInspect?: (id: string) => void;
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
  onInspect,
}) => {
  const { t } = useTranslation();
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [localMenu, setLocalMenu] = useState<{ x: number; y: number } | null>(null);
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
  const operation = stats?.operation ?? downloadOperation({ ...download, status, progress }, stats ? {
    peers: stats.peers, downSpeedBps: stats.downSpeedBps,
  } : {});
  const operationText = useOperationText(operation);
  const percent = operationText.percent;
  const checking = operation.stage === 'checking';
  const showOperation = operation.stage === 'metadata' || checking || operation.status === 'waiting';
  const progressTitle = [operationText.stage, operationText.reason].filter(Boolean).join('. ');
  // Transfer counters survive restarts and can exceed the bytes on disk.
  // Size comes only from metadata, never downloadedBytes / progress.
  const sizeLabel = Number.isFinite(download.totalSize) && download.totalSize > 0
    ? formatBytes(download.totalSize)
    : null;

  // One-click "Watch/Listen" shortcut on media rows. Shown while there's
  // something to play (downloading — instant-play streams while it downloads —,
  // completed, or seeding); paused rows show Resume instead, so no icon clash.
  const canWatch = operation.stage !== 'metadata' && !checking && !!onStream && looksLikeMedia(download) &&
    (status === 'downloading' || status === 'completed' || status === 'seeding');
  const watchLabel = isAudioMedia(download) ? t('downloads.listen') : t('downloads.watch');
  const openMore = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (onContextMenu) { onContextMenu(event, download.id); return; }
    const rect = event.currentTarget.getBoundingClientRect(); setLocalMenu({ x: rect.left, y: rect.bottom });
  };
  const rowOverlays = <>
    {localMenu && <ContextMenu {...localMenu} autoFocus onClose={() => setLocalMenu(null)} items={[
      { label: t('downloads.files'), icon: 'list', onClick: () => onShowFiles(download.id) },
      ...(status === 'seeding' ? [{ label: t('downloads.stopSeeding'), icon: 'stop' as const, onClick: () => onStopSeeding(download.id) }] : []),
      ...(canWatch ? [{ label: watchLabel, icon: 'play' as const, onClick: () => onStream?.(download.id) }] : []),
      ...(onShare ? [{ label: t('downloads.share'), icon: 'share-2' as const, onClick: () => onShare(download.id) }] : []),
      ...(onInspect ? [{ label: t('downloads.help'), icon: 'info' as const, onClick: () => onInspect(download.id) }] : []),
      { label: t('downloads.openFolder'), icon: 'folder', onClick: () => onOpenFolder(download.savePath) },
      { label: t('downloads.remove'), icon: 'trash', danger: true, onClick: () => setShowRemoveConfirm(true) },
    ]} />}
    {showRemoveConfirm && <Modal title={t('downloads.remove')} icon="trash" size="sm" onClose={() => setShowRemoveConfirm(false)} footer={<Button variant="secondary" onClick={() => setShowRemoveConfirm(false)}>{t('common.cancel')}</Button>}>
      <p>{download.name}</p><div className="remove-confirm">
        <Button variant="danger" onClick={() => { setShowRemoveConfirm(false); onRemove(download.id, true); }}>{t('downloads.deleteWithFiles')}</Button>
        <Button variant="secondary" onClick={() => { setShowRemoveConfirm(false); onRemove(download.id, false); }}>{t('downloads.keepFiles')}</Button>
      </div>
    </Modal>}
  </>;

  const getProgressVariant = (): 'default' | 'success' | 'warning' | 'error' => {
    if (status === 'error') return 'error';
    if (checking) return 'default';
    if (status === 'completed' || status === 'seeding') return 'success';
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
      showOperation ? operationText.stage
      : status === 'downloading' ? formatEta(currentStats.etaSeconds)
      : status === 'seeding' || status === 'completed' ? (ratio !== null ? `${ratio.toFixed(2)}×` : '—')
      : t(`status.${status}`).toLowerCase();

    return (
      <div
        className={`download-item download-item-compact download-item-with-tail download-st-${status} ${isSelected ? 'selected' : ''}`}
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
              {sizeLabel && <span>{sizeLabel}</span>}
              {/* Shown only at widths where the progress column is dropped */}
              <span className={`trow-sub-pct${showOperation ? ' operation-summary' : ''}`} title={progressTitle}>
                {showOperation ? operationText.stage : ''}{showOperation && percent !== null ? ' · ' : ''}{percent === null ? '' : `${percent.toFixed(0)}%`}
              </span>
              {/* Stored as a Category id, so resolve it — the raw "movies" was
                  never meant to be the label the user reads. */}
              {download.category && (
                <span className="trow-sub-cat" style={categoryColor ? { color: categoryColor } : undefined}>
                  {categoryLabel(categories, download.category)}
                </span>
              )}
              {status === 'error' && download.lastError && (
                <span className="error-text truncate"><ErrorMessage error={download.lastError} /></span>
              )}
            </div>
          </div>
          <div className="trow-prog" title={progressTitle}>
            <div className="trow-prog-labels">
              <span className="trow-pct">{percent === null ? '—' : `${percent.toFixed(percent >= 100 ? 0 : 1)}%`}</span>
              <span className="trow-prog-hint">{progLabel}</span>
            </div>
            <ProgressBar value={percent === null ? null : percent / 100} variant={getProgressVariant()} label={operationText.stage} />
          </div>
        </div>
        <div className="trow-tail">
          <div className="trow-readouts">
            <div className="trow-rate" title={`${t('downloads.statDownSpeed')}: ${formatSpeed(currentStats.downSpeedBps)} · ${t('downloads.statUpSpeed')}: ${formatSpeed(currentStats.upSpeedBps)}`}>
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
              {checking ? <span className="badge" title={progressTitle}>{operationText.stage}</span> : <StatusBadge status={status} showIcon={false} />}
            </div>
          </div>

          {/* Readouts and actions share a reserved area, never the progress bar. */}
          <div className="trow-actions">
            {onShare && (
              <Button
                className="download-share-shortcut"
                variant="ghost"
                size="sm"
                icon={<Icon name="share-2" size={13} />}
                onClick={() => onShare(download.id)}
                title={t('downloads.share')}
              >
                <span className="trow-action-label">{t('downloads.share')}</span>
              </Button>
            )}
            {!checking && (status === 'downloading' || status === 'queued') && (
              <Button variant="ghost" size="sm" icon={<Icon name="pause" size={13} />} title={t('downloads.pause')} onClick={() => onPause(download.id)}>
                <span className="trow-action-label">{t('downloads.pause')}</span>
              </Button>
            )}
            {!checking && status === 'seeding' && (
              <Button variant="ghost" size="sm" icon={<Icon name="stop" size={13} />} onClick={() => onStopSeeding(download.id)} title={t('downloads.stopSeeding')}>
                <span className="trow-action-label">{t('downloads.stop')}</span>
              </Button>
            )}
            {!checking && (status === 'paused' || status === 'completed') && (
              <Button variant="ghost" size="sm" icon={<Icon name={status === 'completed' || progress >= 1 ? 'upload' : 'play'} size={13} />} title={t(status === 'completed' || progress >= 1 ? 'downloads.resumeSeeding' : 'downloads.resume')} onClick={() => onResume(download.id)}>
                <span className="trow-action-label">{t(status === 'completed' || progress >= 1 ? 'downloads.resumeSeeding' : 'downloads.resume')}</span>
              </Button>
            )}
            {status === 'error' && (
              <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} title={t('downloads.retry')} onClick={() => onRetry(download.id)}>
                <span className="trow-action-label">{t('downloads.retry')}</span>
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
                className="download-folder-shortcut"
                onClick={() => onOpenFolder(download.savePath)}
                title={t('downloads.openFolder')}
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="more-horizontal" size={14} />}
              onClick={openMore}
              title={t('downloads.more')}
            />
          </div>
        </div>
        {rowOverlays}
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
          <span className="download-item-name" title={download.name}>{download.name}</span>
          {checking ? <span className="badge">{operationText.stage}</span> : <StatusBadge status={status} />}
        </div>
        <div className="download-item-actions" role="group" aria-label={t('downloads.toolsTitle')}>
          {!checking && status === 'seeding' ? <Button variant="secondary" size="sm" icon={<Icon name="stop" size={16} />} onClick={() => onStopSeeding(download.id)}>{t('downloads.stopSeeding')}</Button>
            : !checking && canPause(status) ? <Button variant="secondary" size="sm" icon={<Icon name="pause" size={16} />} onClick={() => onPause(download.id)}>{t('downloads.pause')}</Button>
            : !checking && (status === 'paused' || status === 'completed') ? <Button variant="secondary" size="sm" icon={<Icon name="play" size={16} />} onClick={() => onResume(download.id)}>{t(status === 'completed' || progress >= 1 ? 'downloads.resumeSeeding' : 'downloads.resume')}</Button>
            : status === 'error' ? <Button variant="secondary" size="sm" icon={<Icon name="refresh" size={16} />} onClick={() => onRetry(download.id)}>{t('downloads.retry')}</Button> : null}
          {canWatch && <Button variant="ghost" size="sm" className="download-action-watch" icon={<Icon name="play" size={16} />} onClick={() => onStream?.(download.id)}>{watchLabel}</Button>}
          <Button variant="ghost" size="sm" icon={<Icon name="list" size={16} />} onClick={() => onShowFiles(download.id)}>{t('downloads.files')}</Button>
          <Button variant="ghost" size="sm" icon={<Icon name="more-horizontal" size={16} />} onClick={openMore} aria-haspopup="menu">{t('downloads.more')}</Button>
        </div>
      </div>
      {rowOverlays}

      <div className="download-detailed-progress">
        <ProgressBar
          value={percent === null ? null : percent / 100}
          variant={getProgressVariant()}
          label={operationText.stage}
        />
        <span className="progress-text-large">{percent === null ? '—' : `${percent.toFixed(1)}%`}</span>
      </div>
      {showOperation && <OperationStatus operation={operation} showProgress={false} />}
      {onInspect && (showOperation || status === 'error' || status === 'paused' || status === 'queued') && <Button variant="ghost" size="sm" className="download-help-link" icon={<Icon name="info" size={14} />} onClick={() => onInspect(download.id)}>{t('downloads.help')}</Button>}

      {status === 'error' && download.lastError && (
        <div className="download-error-message">
          <Icon name="alert-circle" size={16} />
          <ErrorMessage error={download.lastError} details />
        </div>
      )}

      <div className="download-detailed-stats">
        <div className="stats-grid">
          <div className="stat-item">
            <Icon name="download" size={12} />
            <div className="stat-content">
              <span className="stat-label" title={t('downloads.statDownHint')}>{t('downloads.statDown')}</span>
              <span className="stat-value">{formatBytes(currentStats.downloadedBytes)}</span>
            </div>
          </div>

          <div className="stat-item">
            <Icon name="upload" size={12} />
            <div className="stat-content">
              <span className="stat-label" title={t('downloads.statUpHint')}>{t('downloads.statUp')}</span>
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
                {sizeLabel ?? '--'}
              </span>
            </div>
          </div>

          {(status === 'downloading' || status === 'seeding') && <>
              <div className="stat-item">
                <Icon name="activity" size={12} />
                <div className="stat-content">
                  <span className="stat-label">{t('downloads.statDownSpeed')}</span>
                  <span className="stat-value">{formatSpeed(currentStats.downSpeedBps)}</span>
                </div>
              </div>
              <div className="stat-item">
                <Icon name="upload" size={12} />
                <div className="stat-content">
                  <span className="stat-label">{t('downloads.statUpSpeed')}</span>
                  <span className="stat-value">{formatSpeed(currentStats.upSpeedBps)}</span>
                </div>
              </div>
          </>}

          {status === 'downloading' && (
            <>
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
