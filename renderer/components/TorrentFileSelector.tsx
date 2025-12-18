/**
 * Torrent File Selector Component
 * 
 * Modal for selecting which files to download from a torrent
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Button, Icon } from './index';
import './TorrentFileSelector.css';

interface TorrentFile {
  path: string;
  size: number;
  index: number;
}

interface TorrentInfo {
  name: string;
  files: TorrentFile[];
  totalSize: number;
}

interface TorrentFileSelectorProps {
  torrentPath?: string;
  magnetUri?: string;
  onConfirm: (selectedIndices: number[]) => void;
  onCancel: () => void;
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const TorrentFileSelector: React.FC<TorrentFileSelectorProps> = ({
  torrentPath,
  magnetUri,
  onConfirm,
  onCancel,
}) => {
  const [torrentInfo, setTorrentInfo] = useState<TorrentInfo | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectAllState, setSelectAllState] = useState<'all' | 'none' | 'partial'>('all');

  useEffect(() => {
    loadTorrentInfo();
  }, [torrentPath, magnetUri]);

  useEffect(() => {
    // Update select all state based on selection
    if (torrentInfo) {
      const filteredFiles = getFilteredFiles();
      const filteredIndices = filteredFiles.map(f => f.index);
      const selectedCount = filteredIndices.filter(i => selectedFiles.has(i)).length;
      
      if (selectedCount === 0) {
        setSelectAllState('none');
      } else if (selectedCount === filteredIndices.length) {
        setSelectAllState('all');
      } else {
        setSelectAllState('partial');
      }
    }
  }, [selectedFiles, torrentInfo, searchQuery]);

  const loadTorrentInfo = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Call API to get torrent file list
      const info = await window.api.getTorrentInfo({
        torrentPath,
        magnetUri,
      });
      
      setTorrentInfo(info);
      
      // Select all files by default
      const allIndices = new Set(info.files.map((_, index) => index));
      setSelectedFiles(allIndices);
    } catch (err) {
      console.error('Failed to load torrent info:', err);
      setError(err instanceof Error ? err.message : 'Failed to load torrent information');
    } finally {
      setLoading(false);
    }
  };

  const getFilteredFiles = () => {
    if (!torrentInfo) return [];
    if (!searchQuery) return torrentInfo.files;
    
    const query = searchQuery.toLowerCase();
    return torrentInfo.files.filter(file => 
      file.path.toLowerCase().includes(query)
    );
  };

  const handleToggleFile = (index: number) => {
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    const filteredFiles = getFilteredFiles();
    const filteredIndices = filteredFiles.map(f => f.index);
    
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      
      if (selectAllState === 'all') {
        // Deselect all filtered
        filteredIndices.forEach(i => newSet.delete(i));
      } else {
        // Select all filtered
        filteredIndices.forEach(i => newSet.add(i));
      }
      
      return newSet;
    });
  };

  const handleSelectByExtension = (extension: string) => {
    if (!torrentInfo) return;
    
    const matchingIndices = torrentInfo.files
      .filter(file => file.path.toLowerCase().endsWith(extension.toLowerCase()))
      .map(file => file.index);
    
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      matchingIndices.forEach(i => newSet.add(i));
      return newSet;
    });
  };

  const handleDeselectByExtension = (extension: string) => {
    if (!torrentInfo) return;
    
    const matchingIndices = torrentInfo.files
      .filter(file => file.path.toLowerCase().endsWith(extension.toLowerCase()))
      .map(file => file.index);
    
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      matchingIndices.forEach(i => newSet.delete(i));
      return newSet;
    });
  };

  const selectedSize = useMemo(() => {
    if (!torrentInfo) return 0;
    return torrentInfo.files
      .filter((_, index) => selectedFiles.has(index))
      .reduce((sum, file) => sum + file.size, 0);
  }, [torrentInfo, selectedFiles]);

  const filteredFiles = getFilteredFiles();

  const handleConfirm = () => {
    if (selectedFiles.size === 0) {
      return;
    }
    onConfirm(Array.from(selectedFiles));
  };

  if (loading) {
    return (
      <div className="torrent-file-selector-overlay">
        <div className="torrent-file-selector">
          <div className="file-selector-loading">
            <span className="spinner spinner-lg" />
            <p>Loading torrent information...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !torrentInfo) {
    return (
      <div className="torrent-file-selector-overlay">
        <div className="torrent-file-selector">
          <div className="file-selector-error">
            <Icon name="alert-circle" size={48} />
            <h3>Failed to Load Torrent</h3>
            <p>{error || 'Unknown error occurred'}</p>
            <Button onClick={onCancel}>Close</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="torrent-file-selector-overlay" onClick={onCancel}>
      <div className="torrent-file-selector" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="file-selector-header">
          <div className="file-selector-title">
            <Icon name="file" size={24} />
            <div>
              <h2>Select Files to Download</h2>
              <p className="torrent-name">{torrentInfo.name}</p>
            </div>
          </div>
          <button className="close-button" onClick={onCancel}>
            <Icon name="x" size={24} />
          </button>
        </div>

        {/* Stats Bar */}
        <div className="file-selector-stats">
          <div className="stat">
            <Icon name="file" size={16} />
            <span>
              <strong>{selectedFiles.size}</strong> of <strong>{torrentInfo.files.length}</strong> files
            </span>
          </div>
          <div className="stat">
            <Icon name="hard-drive" size={16} />
            <span>
              <strong>{formatBytes(selectedSize)}</strong> of <strong>{formatBytes(torrentInfo.totalSize)}</strong>
            </span>
          </div>
        </div>

        {/* Search and Quick Actions */}
        <div className="file-selector-controls">
          <div className="search-box">
            <Icon name="search" size={16} />
            <input
              type="text"
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="search-clear" onClick={() => setSearchQuery('')}>
                <Icon name="x" size={14} />
              </button>
            )}
          </div>

          <div className="quick-actions">
            <Button
              variant="ghost"
              size="sm"
              icon={
                selectAllState === 'all' ? <Icon name="check-circle" size={16} /> :
                selectAllState === 'partial' ? <Icon name="minus" size={16} /> :
                <Icon name="inbox" size={16} />
              }
              onClick={handleSelectAll}
            >
              {selectAllState === 'all' ? 'Deselect All' : 'Select All'}
            </Button>
            
            <div className="dropdown-wrapper">
              <Button variant="ghost" size="sm">
                Quick Select
                <Icon name="chevron-down" size={14} />
              </Button>
              <div className="quick-select-menu">
                <button onClick={() => handleSelectByExtension('.mp4')}>
                  <Icon name="film" size={14} />
                  Select Videos
                </button>
                <button onClick={() => handleSelectByExtension('.mkv')}>
                  <Icon name="film" size={14} />
                  Select MKV
                </button>
                <button onClick={() => handleDeselectByExtension('.txt')}>
                  <Icon name="file-text" size={14} />
                  Deselect Text Files
                </button>
                <button onClick={() => handleDeselectByExtension('.nfo')}>
                  <Icon name="file" size={14} />
                  Deselect NFO Files
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* File List */}
        <div className="file-list">
          {filteredFiles.length === 0 ? (
            <div className="no-results">
              <Icon name="search" size={48} />
              <p>No files match your search</p>
            </div>
          ) : (
            filteredFiles.map((file) => (
              <div
                key={file.index}
                className={`file-item ${selectedFiles.has(file.index) ? 'selected' : ''}`}
                onClick={() => handleToggleFile(file.index)}
              >
                <input
                  type="checkbox"
                  checked={selectedFiles.has(file.index)}
                  onChange={() => handleToggleFile(file.index)}
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="file-icon">
                  <Icon name="file" size={16} />
                </div>
                <div className="file-info">
                  <span className="file-path">{file.path}</span>
                  <span className="file-size">{formatBytes(file.size)}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="file-selector-footer">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Icon name="download" size={16} />}
            onClick={handleConfirm}
            disabled={selectedFiles.size === 0}
          >
            Download Selected ({selectedFiles.size})
          </Button>
        </div>
      </div>
    </div>
  );
};
