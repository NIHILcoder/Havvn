/**
 * Torrent Metadata Preview Component
 *
 * Shows final torrent metadata before creation.
 */

import React from 'react';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { Button } from './Button';
import { useTranslation } from '../utils/i18nContext';
import './MetadataPreview.css';

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

interface MetadataPreviewProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  metadata: {
    name: string;
    comment?: string;
    totalSize: number;
    fileCount: number;
    pieceSize: number;
    pieceCount: number;
    trackers: string[];
    webSeeds?: string[];
    isPrivate: boolean;
    createdBy: string;
    estimatedTorrentSize: number;
  };
}

export const MetadataPreview: React.FC<MetadataPreviewProps> = ({
  isOpen,
  onClose,
  onConfirm,
  metadata
}) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <Modal
      onClose={onClose}
      title={t('metadata.previewTitle')}
      icon="eye"
      size="xl"
      className="torrent-metadata-preview"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} icon={<Icon name="arrow-left" size={16} />}>
            {t('metadata.goBack')}
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            <Icon name="file-plus" size={16} />
            {t('metadata.looksGoodCreate')}
          </Button>
        </>
      }
    >
      <p className="preview-description">
        {t('metadata.reviewDescription')}
      </p>

      <div className="metadata-section">
        <h4 className="section-title">
          <Icon name="info" size={16} />
          {t('metadata.basicInformation')}
        </h4>
        <div className="metadata-grid">
          <div className="metadata-item">
            <span className="item-label">{t('table.name')}</span>
            <span className="item-value">{metadata.name}</span>
          </div>
          {metadata.comment && (
            <div className="metadata-item full-width">
              <span className="item-label">{t('metadata.description')}</span>
              <span className="item-value description">{metadata.comment}</span>
            </div>
          )}
          <div className="metadata-item">
            <span className="item-label">{t('metadata.createdBy')}</span>
            <span className="item-value">{metadata.createdBy}</span>
          </div>
          <div className="metadata-item">
            <span className="item-label">{t('settings.privacy')}</span>
            <span className={`item-value badge ${metadata.isPrivate ? 'private' : 'public'}`}>
              <Icon name={metadata.isPrivate ? 'lock' : 'globe'} size={12} />
              {metadata.isPrivate ? t('metadata.private') : t('metadata.public')}
            </span>
          </div>
        </div>
      </div>

      <div className="metadata-section">
        <h4 className="section-title">
          <Icon name="hard-drive" size={16} />
          {t('metadata.contentInformation')}
        </h4>
        <div className="metadata-grid">
          <div className="metadata-item">
            <span className="item-label">{t('metadata.totalSize')}</span>
            <span className="item-value mono">{formatBytes(metadata.totalSize)}</span>
          </div>
          <div className="metadata-item">
            <span className="item-label">{t('downloads.files')}</span>
            <span className="item-value">{metadata.fileCount} {metadata.fileCount === 1 ? t('metadata.file') : t('filePicker.files')}</span>
          </div>
          <div className="metadata-item">
            <span className="item-label">{t('metadata.pieceSize')}</span>
            <span className="item-value mono">{formatBytes(metadata.pieceSize)}</span>
          </div>
          <div className="metadata-item">
            <span className="item-label">{t('metadata.pieces')}</span>
            <span className="item-value">{metadata.pieceCount.toLocaleString()}</span>
          </div>
          <div className="metadata-item">
            <span className="item-label">{t('metadata.torrentFileSize')}</span>
            <span className="item-value mono">~{formatBytes(metadata.estimatedTorrentSize)}</span>
          </div>
        </div>
      </div>

      <div className="metadata-section">
        <h4 className="section-title">
          <Icon name="server" size={16} />
          {t('create.trackers')} ({metadata.trackers.length})
        </h4>
        {metadata.trackers.length > 0 ? (
          <div className="tracker-list">
            {metadata.trackers.slice(0, 5).map((tracker, idx) => (
              <div key={idx} className="tracker-item">
                <Icon name="circle" size={6} />
                <span>{tracker}</span>
              </div>
            ))}
            {metadata.trackers.length > 5 && (
              <div className="tracker-more">
                + {metadata.trackers.length - 5} {t('metadata.moreTrackers')}
              </div>
            )}
          </div>
        ) : (
          <div className="empty-notice">
            <Icon name="alert-circle" size={14} />
            {t('metadata.noTrackers')}
          </div>
        )}
      </div>

      {metadata.webSeeds && metadata.webSeeds.length > 0 && (
        <div className="metadata-section">
          <h4 className="section-title">
            <Icon name="external-link" size={16} />
            {t('metadata.webSeeds')} ({metadata.webSeeds.length})
          </h4>
          <div className="tracker-list">
            {metadata.webSeeds.map((seed, idx) => (
              <div key={idx} className="tracker-item">
                <Icon name="circle" size={6} />
                <span>{seed}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="info-notice">
        <Icon name="info" size={16} />
        <span>
          {t('metadata.infoNotice')}
        </span>
      </div>
    </Modal>
  );
};

export default MetadataPreview;
