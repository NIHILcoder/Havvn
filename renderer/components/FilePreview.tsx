import React, { useEffect, useState } from 'react';
import { TorrentFile } from '../../shared/types';
import { Icon, IconName } from './Icon';
import './FilePreview.css';

interface FilePreviewProps {
  downloadId: string;
  onClose: () => void;
}

export const FilePreview: React.FC<FilePreviewProps> = ({ downloadId, onClose }) => {
  const [files, setFiles] = useState<TorrentFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadFiles = async () => {
      try {
        const fileList = await window.api.getTorrentFiles(downloadId);
        setFiles(fileList);
      } catch (err) {
        setError('Failed to load files');
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    loadFiles();
  }, [downloadId]);

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
      // Video files
      if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'].includes(ext)) {
        icon = 'film';
      }
      // Audio files
      else if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'].includes(ext)) {
        icon = 'music';
      }
      // Image files
      else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico'].includes(ext)) {
        icon = 'image';
      }
      // Archive files
      else if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) {
        icon = 'archive';
      }
      // Document files
      else if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt'].includes(ext)) {
        icon = 'file-text';
      }
      
      iconCache.set(ext, icon);
      return icon;
    };
  }, []);

  const getFileTypeColor = React.useMemo(() => {
    const colorCache = new Map<string, string>();
    return (fileName: string): string => {
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      if (colorCache.has(ext)) return colorCache.get(ext)!;
      
      let color = 'var(--text-secondary)';
      if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'].includes(ext)) {
        color = 'var(--color-video)';
      } else if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'].includes(ext)) {
        color = 'var(--color-audio)';
      } else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico'].includes(ext)) {
        color = 'var(--color-image)';
      } else if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) {
        color = 'var(--color-archive)';
      } else if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt'].includes(ext)) {
        color = 'var(--color-document)';
      }
      
      colorCache.set(ext, color);
      return color;
    };
  }, []);

  if (loading) {
    return (
      <div className="file-preview-overlay">
        <div className="file-preview-modal">
          <div className="file-preview-loading">
            <div className="spinner"></div>
            <p>Loading files...</p>
          </div>
        </div>
      </div>
    );
  }
  
  if (error) {
    return (
      <div className="file-preview-overlay" onClick={onClose}>
        <div className="file-preview-modal" onClick={e => e.stopPropagation()}>
          <div className="file-preview-error">
            <Icon name="alert-circle" size={48} />
            <p>{error}</p>
            <button onClick={onClose} className="btn-secondary">Close</button>
          </div>
        </div>
      </div>
    );
  }
  
  if (files.length === 0) {
    return (
      <div className="file-preview-overlay" onClick={onClose}>
        <div className="file-preview-modal" onClick={e => e.stopPropagation()}>
          <div className="file-preview-empty">
            <Icon name="inbox" size={48} />
            <p>No files information available</p>
          </div>
        </div>
      </div>
    );
  }

  const totalSize = files.reduce((sum, file) => sum + file.length, 0);
  const downloadedSize = files.reduce((sum, file) => sum + file.downloaded, 0);
  const totalProgress = totalSize > 0 ? downloadedSize / totalSize : 0;

  return (
    <div className="file-preview-overlay" onClick={onClose}>
      <div className="file-preview-modal" onClick={e => e.stopPropagation()}>
        <div className="file-preview-header">
          <div className="file-preview-header-info">
            <h3>Files ({files.length})</h3>
            <div className="file-preview-summary">
              <span className="summary-item">
                <Icon name="hard-drive" size={14} />
                {formatBytes(totalSize)}
              </span>
              <span className="summary-separator">•</span>
              <span className="summary-item">
                <Icon name="download" size={14} />
                {(totalProgress * 100).toFixed(1)}%
              </span>
            </div>
          </div>
          <button onClick={onClose} className="file-preview-close">
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="file-preview-list">
          {files.map((file, index) => (
            <div key={index} className="file-preview-item">
              <div className="file-icon" style={{ color: getFileTypeColor(file.name) }}>
                <Icon name={getFileIcon(file.name)} size={20} />
              </div>
              <div className="file-details">
                <div className="file-header">
                  <div className="file-name-wrapper">
                    <span className="file-name" title={file.path}>{file.name}</span>
                    <span className="file-path" title={file.path}>{file.path}</span>
                  </div>
                  <span className="file-size">{formatBytes(file.length)}</span>
                </div>
                <div className="file-progress-container">
                  <div className="file-progress-wrapper">
                    <div 
                      className="file-progress-fill" 
                      style={{ 
                        width: `${file.progress * 100}%`,
                        backgroundColor: file.progress === 1 ? 'var(--success)' : 'var(--accent-primary)'
                      }}
                    />
                  </div>
                  <div className="file-meta">
                    <span className="file-percent">{Math.round(file.progress * 100)}%</span>
                    <span className={`file-status ${file.progress === 1 ? 'completed' : ''}`}>
                      {file.progress === 1 ? (
                        <>
                          <Icon name="check-circle" size={12} />
                          Completed
                        </>
                      ) : (
                        <>
                          <Icon name="download" size={12} />
                          {formatBytes(file.downloaded)} / {formatBytes(file.length)}
                        </>
                      )}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
