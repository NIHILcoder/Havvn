import { ErrorMessage } from './ErrorMessage';
import React, { useEffect, useMemo, useState } from 'react';
import { TorrentFile } from '../../shared/types';
import { fileProgress } from '../../shared/file-progress';
import { Icon, IconName } from './Icon';
import { Modal } from './Modal';
import { Button } from './Button';
import { useTranslation } from '../utils/i18nContext';
import { useResourceEconomy } from '../utils/resource-mode';
import { RESOURCE_ECONOMY } from '../../shared/resource-mode';
import { useVisibleWork } from '../utils/visible-work';
import { useHostWindow } from '../utils/hostWindow';
import { VirtualFileList } from './VirtualFileList';
import { reconcileTorrentFiles, torrentFileKey } from '../utils/torrent-files';
import './FilePreview.css';

interface FilePreviewProps {
  downloadId: string;
  onClose: () => void;
}

export const FilePreview: React.FC<FilePreviewProps> = ({ downloadId, onClose }) => {
  const { t } = useTranslation();
  const economy = useResourceEconomy();
  const visible = useVisibleWork();
  const host = useHostWindow();
  const [files, setFiles] = useState<TorrentFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFiles([]); setLoading(true); setError(null);
  }, [downloadId]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: number | undefined;
    const loadFiles = async () => {
      try {
        const fileList = await window.api.getTorrentFiles(downloadId);
        if (cancelled) return;
        setFiles(previous => reconcileTorrentFiles(previous,
          fileList.map(file => ({ ...file, ...fileProgress(file.length, file.downloaded) }))));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(t('filePreview.loadFailed'));
        console.error(err);
      } finally {
        if (!cancelled) {
          setLoading(false);
          // Schedule after the response: slow IPC must not pile up requests.
          timer = host.window.setTimeout(loadFiles, economy ? RESOURCE_ECONOMY.previewIntervalMs : 1000);
        }
      }
    };
    void loadFiles();
    return () => { cancelled = true; host.window.clearTimeout(timer); };
  }, [downloadId, t, economy, visible, host]);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getFileIcon = React.useMemo(() => {
    const iconCache = new Map<string, IconName>();
    return (fileName: string): IconName => {
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      if (iconCache.has(ext)) return iconCache.get(ext)!;
      let icon: IconName = 'file';
      if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'].includes(ext)) icon = 'film';
      else if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'].includes(ext)) icon = 'music';
      else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico'].includes(ext)) icon = 'image';
      else if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) icon = 'archive';
      else if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt'].includes(ext)) icon = 'file-text';
      iconCache.set(ext, icon);
      return icon;
    };
  }, []);

  const getFileTypeColor = React.useMemo(() => {
    const colorCache = new Map<string, string>();
    return (fileName: string): string => {
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      if (colorCache.has(ext)) return colorCache.get(ext)!;
      let color = 'var(--color-text-tertiary)';
      if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'].includes(ext)) color = 'var(--color-video)';
      else if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'].includes(ext)) color = 'var(--color-audio)';
      else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico'].includes(ext)) color = 'var(--color-image)';
      else if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) color = 'var(--color-archive)';
      else if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt'].includes(ext)) color = 'var(--color-document)';
      colorCache.set(ext, color);
      return color;
    };
  }, []);

  const getFileExtension = (fileName: string): string => {
    return fileName.split('.').pop()?.toUpperCase() || 'FILE';
  };

  const { totalSize, downloadedSize, completedCount, totalProgress } = useMemo(() => {
    let totalSize = 0, downloadedSize = 0, completedCount = 0;
    let wantedSize = 0, wantedDownloaded = 0, wantedCount = 0, wantedComplete = 0;
    for (const file of files) {
      totalSize += file.length; downloadedSize += file.downloaded;
      if (file.progress === 1) completedCount++;
      if (file.priority !== 'skip') {
        wantedCount++; wantedSize += file.length; wantedDownloaded += file.downloaded;
        if (file.progress === 1) wantedComplete++;
      }
    }
    return { totalSize, downloadedSize, completedCount,
      totalProgress: wantedSize > 0 ? wantedDownloaded / wantedSize : wantedCount > 0 && wantedComplete === wantedCount ? 1 : 0 };
  }, [files]);

  if (loading) {
    return (
      <Modal onClose={onClose} size="xl" ariaLabel={t('filePreview.loadingAria')}>
        <div className="file-preview-loading">
          <div className="fp-spinner"></div>
          <p>{t('filePreview.loading')}</p>
        </div>
      </Modal>
    );
  }

  if (error && files.length === 0) {
    return (
      <Modal
        onClose={onClose}
        size="xl"
        ariaLabel={t('filePreview.loadFailed')}
        footer={<Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>}
      >
        <div className="file-preview-error">
          <div className="fp-state-icon fp-state-icon--error">
            <Icon name="alert-circle" size={32} />
          </div>
          <p><ErrorMessage error={error} /></p>
        </div>
      </Modal>
    );
  }

  if (files.length === 0) {
    return (
      <Modal onClose={onClose} size="xl" ariaLabel={t('downloads.files')}>
        <div className="file-preview-empty">
          <div className="fp-state-icon">
            <Icon name="inbox" size={32} />
          </div>
          <p>{t('filePreview.noInfo')}</p>
        </div>
      </Modal>
    );
  }

  const headerTitle = (
    <span className="fp-header-text">
      <span className="fp-title">{t('downloads.files')} ({files.length})</span>
      <span className="fp-subtitle">
        <span className="fp-chip">
          <Icon name="hard-drive" size={12} />
          {formatBytes(totalSize)}
        </span>
        <span className="fp-chip-sep">·</span>
        <span className="fp-chip">
          <Icon name="download" size={12} />
          {formatBytes(downloadedSize)} {t('filePreview.downloaded')}
        </span>
        <span className="fp-chip-sep">·</span>
        <span className="fp-chip fp-chip--progress">
          {(totalProgress * 100).toFixed(1)}% {t('filePreview.complete')}
        </span>
        {completedCount > 0 && (
          <>
            <span className="fp-chip-sep">·</span>
            <span className="fp-chip fp-chip--done">
              <Icon name="check-circle" size={12} />
              {completedCount} {t('filePreview.done')}
            </span>
          </>
        )}
      </span>
    </span>
  );

  return (
    <Modal
      onClose={onClose}
      size="xl"
      icon="layers"
      title={headerTitle}
      ariaLabel={`${t('downloads.files')} (${files.length})`}
      bodyClassName="fp-body"
    >
      {error && <p role="status" className="fp-refresh-error"><ErrorMessage error={error} /></p>}
      {/* ── Overall progress bar (sticky) ── */}
      <div className="fp-total-progress">
        <div className="fp-total-bar">
          <div
            className="fp-total-fill"
            style={{ width: `${totalProgress * 100}%` }}
          />
        </div>
      </div>

      {/* ── File list ── */}
      <VirtualFileList className="fp-list" items={files} getKey={torrentFileKey}
        estimateSize={114} gap={6} resetKey={downloadId} label={t('downloads.files')}
        renderRow={(file) => {
          const pct = Math.round(file.progress * 100);
          const isDone = file.progress === 1;
          const ext = getFileExtension(file.name);

          return (
            <div className={`fp-item ${isDone ? 'fp-item--done' : ''}`}>
              {/* Icon */}
              <div className="fp-item-icon" style={{ color: getFileTypeColor(file.name) }}>
                <Icon name={getFileIcon(file.name)} size={22} />
                <span className="fp-ext-badge">{ext}</span>
              </div>

              {/* Content */}
              <div className="fp-item-body">
                {/* Row 1: name + size */}
                <div className="fp-item-row">
                  <span className="fp-item-name" title={file.path}>{file.name}</span>
                  <span className="fp-item-size">{formatBytes(file.length)}</span>
                </div>

                {/* Row 2: path */}
                {file.path && file.path !== file.name && (
                  <div className="fp-item-path" title={file.path}>
                    <Icon name="folder" size={11} />
                    {file.path}
                  </div>
                )}

                {/* Row 3: progress bar */}
                <div className="fp-item-progress-track">
                  <div
                    className={`fp-item-progress-fill ${isDone ? 'fp-item-progress-fill--done' : ''}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                {/* Row 4: percent + downloaded/total */}
                <div className="fp-item-meta">
                  <span className="fp-item-pct">{pct}%</span>
                  {isDone ? (
                    <span className="fp-item-status fp-item-status--done">
                      <Icon name="check-circle" size={12} />
                      {t('status.completed')}
                    </span>
                  ) : (
                    <span className="fp-item-status">
                      <Icon name="download" size={12} />
                      {formatBytes(file.downloaded)} / {formatBytes(file.length)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        }} />
    </Modal>
  );
};
