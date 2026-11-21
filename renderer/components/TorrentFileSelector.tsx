/**
 * Torrent File Selector Component
 * 
 * Modal for selecting which files to download from a torrent
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Button, Icon } from './index';
import { DropdownMenu } from './DropdownMenu';
import { Modal } from './Modal';
import { useTranslation } from '../utils/i18nContext';
import './TorrentFileSelector.css';
import { SelectionCheckbox, SelectionMarker } from './SelectionCheckbox';
import type { DownloadDefaults } from '../../shared/types';
import { CategorySelect } from './CategorySelect';
import { DownloadDefaultsPreview, InheritedBooleanSelect } from './DownloadDefaultsPreview';
import { cleanError } from '../utils/format-helpers';
import { ErrorMessage } from './ErrorMessage';
import { VirtualFileList } from './VirtualFileList';
import { Select } from './Select';
import { TorrentFolderPicker } from './TorrentFolderPicker';
import { applyPickerAction, filesInPickerScope, pickerFolders, type PickerAction } from '../../shared/torrent-file-picker';

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

const fileKey = (file: TorrentFile) => file.index;

interface TorrentFileSelectorProps {
  queueNote?: string;
  onSkip?: () => void;
  torrentPath?: string;
  magnetUri?: string;
  onConfirm: (selectedIndices: number[], savePath?: string, options?: DownloadDefaults & { categoryId?: string; name?: string }) => void | Promise<void>;
  allowCategory?: boolean;
  downloadOptions?: DownloadDefaults & { categoryId?: string };
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
  queueNote, onSkip,
  torrentPath,
  magnetUri,
  onConfirm,
  onCancel,
  allowCategory = false,
  downloadOptions,
}) => {
  const { t } = useTranslation();
  const [torrentInfo, setTorrentInfo] = useState<TorrentInfo | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [folder, setFolder] = useState(''), [showFolders, setShowFolders] = useState(false);
  const [selectionScope, setSelectionScope] = useState<'filtered' | 'all'>('filtered');
  const [savePath, setSavePath] = useState<string>();
  const [categoryId, setCategoryId] = useState('');
  const [paused, setPaused] = useState<boolean | undefined>();
  const options = allowCategory ? { categoryId: categoryId || undefined, paused } : downloadOptions;
  const [choosingPath, setChoosingPath] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [submitError, setSubmitError] = useState('');
  const [pathError, setPathError] = useState(false);
  useEffect(() => {
    let active = true;
    setSavePath(undefined);
    setPathError(false);
    setSearchQuery('');
    setFolder(''); setShowFolders(false); setSelectionScope('filtered');
    setSubmitError('');
    setTorrentInfo(null);
    setSelectedFiles(new Set());
    setLoading(true);
    setError(null);
    window.api.getTorrentInfo({ torrentPath, magnetUri }).then(info => {
      if (!active) return;
      setTorrentInfo(info);
      setSelectedFiles(new Set(info.files.map(file => file.index)));
    }).catch(err => {
      if (!active) return;
      console.error('Failed to load torrent info:', err);
      setError(err instanceof Error ? err.message : t('filePicker.errorLoadInfo'));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [torrentPath, magnetUri]);

  const filteredFiles = useMemo(() => {
    if (!torrentInfo) return [];
    return filesInPickerScope(torrentInfo.files, searchQuery, folder);
  }, [torrentInfo, searchQuery, folder]);
  const folders = useMemo(() => pickerFolders(torrentInfo?.files ?? []), [torrentInfo]);
  const scopeFiles = useMemo(() => selectionScope === 'all' ? torrentInfo?.files ?? [] : filteredFiles, [selectionScope, torrentInfo, filteredFiles]);

  const selectAllState = useMemo(() => {
    let count = 0;
    for (const file of scopeFiles) if (selectedFiles.has(file.index)) count++;
    return count === 0 ? 'none' : count === scopeFiles.length ? 'all' : 'partial';
  }, [scopeFiles, selectedFiles]);
  const selectedOutsideList = useMemo(() => selectedFiles.size - filteredFiles.filter(file => selectedFiles.has(file.index)).length, [filteredFiles, selectedFiles]);

  const handleToggleFile = (index: number) => {
    if (submittingRef.current) return;
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
    if (submittingRef.current) return;
    const filteredIndices = scopeFiles.map(f => f.index);
    
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

  const handleQuickSelect = (action: PickerAction) => {
    if (!submittingRef.current) setSelectedFiles(previous => applyPickerAction(previous, scopeFiles, action));
  };

  const selectedSize = useMemo(() => {
    if (!torrentInfo) return 0;
    return torrentInfo.files.reduce((sum, file) => sum + (selectedFiles.has(file.index) ? file.size : 0), 0);
  }, [torrentInfo, selectedFiles]);

  const submit = async (indices: number[]) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true); setSubmitError('');
    try { await onConfirm(indices, savePath, { ...options, name: torrentInfo?.name }); }
    catch (reason) { setSubmitError(cleanError(reason)); }
    finally { submittingRef.current = false; setSubmitting(false); }
  };
  const handleConfirm = () => {
    if (selectedFiles.size === 0) {
      return;
    }
    void submit(Array.from(selectedFiles));
  };

  const pathPicker = (
    <>
    {allowCategory && <div className="tfs-destination tfs-category-options">
      <CategorySelect disabled={submitting} value={categoryId} onChange={setCategoryId} />
      <InheritedBooleanSelect disabled={submitting} label={t('category.defaults.paused')} value={paused} onChange={setPaused} yes={t('category.defaults.paused')} no={t('category.defaults.active')} />
    </div>}
    <div className="tfs-destination">
      <div className="tfs-destination-path">
        <span>{t('filePicker.savePath')}</span>
        <span title={savePath}>{savePath || t('filePicker.defaultPath')}</span>
        {pathError && <span role="alert">{t('filePicker.choosePathFailed')}</span>}
      </div>
      <Button
        variant="secondary"
        size="sm"
        icon={<Icon name="folder-open" size={14} />}
        disabled={choosingPath || submitting}
        onClick={async () => {
          setChoosingPath(true);
          setPathError(false);
          try {
            const chosen = await window.api.selectDirectory();
            if (chosen) setSavePath(chosen);
          } catch {
            setPathError(true);
          } finally {
            setChoosingPath(false);
          }
        }}
      >{t('settings.choose')}</Button>
      {savePath && (
        <Button variant="ghost" size="sm" disabled={submitting} onClick={() => setSavePath(undefined)}>
          {t('filePicker.defaultPath')}
        </Button>
      )}
    </div>
    <DownloadDefaultsPreview {...options} savePath={savePath} compact />
    {submitError && <div role="alert"><ErrorMessage error={submitError} details /></div>}
    </>
  );

  if (loading) {
    return (
      <Modal
        onClose={onCancel}
        size="xl"
        hideClose
        closeOnBackdrop={false}
        footer={<>{onSkip && <Button variant="secondary" onClick={onSkip}>{t('downloads.queue.skip')}</Button>}<Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button></>}
        ariaLabel={t('filePicker.loading')}
      >
        <div className="file-selector-loading">
          {queueNote && <p role="status">{queueNote}</p>}
          <span className="spinner spinner-lg" />
          <p>{t('filePicker.loading')}</p>
        </div>
      </Modal>
    );
  }

  if (error || !torrentInfo) {
    return (
      <Modal
        onClose={onCancel}
        size="xl"
        hideClose
        closeOnBackdrop={false}
        ariaLabel={t('filePicker.loadFailed')}
        busy={submitting}
      >
        <div className="file-selector-error">
          {queueNote && <p role="status">{queueNote}</p>}
          <Icon name="alert-circle" size={48} />
          <h3>{t('filePicker.loadFailed')}</h3>
          <div role="alert"><ErrorMessage error={error || t('filePicker.errorUnknown')} details /></div>
          {pathPicker}
          <div className="file-selector-error-actions">
            {onSkip && <Button variant="secondary" disabled={submitting} onClick={onSkip}>{t('downloads.queue.skip')}</Button>}
            {/* Preview is optional — a metadata timeout must not block the add.
                Empty selection = download everything. */}
            <Button variant="primary" disabled={choosingPath || submitting} loading={submitting} onClick={() => { void submit([]); }}>{t('filePicker.addAnyway')}</Button>
            <Button disabled={submitting} onClick={onCancel}>{t('player.close')}</Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <>
    <Modal
      onClose={onCancel}
      size="xl"
      icon="file"
      busy={submitting}
      bodyClassName="tfs-body"
      ariaLabel={t('filePicker.title')}
      title={
        <span className="tfs-heading">
          {t('filePicker.title')}
          <span className="torrent-name">{torrentInfo.name}</span>
        </span>
      }
      footer={
        <>
          {onSkip && <Button variant="secondary" disabled={submitting} onClick={onSkip}>{t('downloads.queue.skip')}</Button>}
          <Button variant="ghost" disabled={submitting} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<Icon name="download" size={16} />}
            onClick={handleConfirm}
            loading={submitting}
            disabled={selectedFiles.size === 0 || choosingPath || submitting}
          >
            {t('filePicker.downloadSelected')} ({selectedFiles.size})
          </Button>
        </>
      }
    >
        {queueNote && <p className="tfs-queue-note" role="status">{queueNote}</p>}
        {/* Stats Bar */}
        <div className="file-selector-stats">
          <div className="stat">
            <Icon name="file" size={16} />
            <span>
              <strong>{selectedFiles.size}</strong> {t('filePicker.of')} <strong>{torrentInfo.files.length}</strong> {t('filePicker.files')}
            </span>
          </div>
          <div className="stat">
            <Icon name="hard-drive" size={16} />
            <span>
              <strong>{formatBytes(selectedSize)}</strong> {t('filePicker.of')} <strong>{formatBytes(torrentInfo.totalSize)}</strong>
            </span>
          </div>
        </div>

        {/* Search and Quick Actions */}
        {pathPicker}
        <div className="file-selector-controls">
          <div className="search-box">
            <Icon name="search" size={16} />
            <input
              type="text"
              placeholder={t('filePicker.searchPlaceholder')}
              value={searchQuery}
              disabled={submitting}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="search-clear" disabled={submitting} onClick={() => setSearchQuery('')}>
                <Icon name="x" size={14} />
              </button>
            )}
          </div>

          <div className="quick-actions">
            <Button
              variant="ghost"
              size="sm"
              icon={
                <SelectionMarker checked={selectAllState === 'all'} indeterminate={selectAllState === 'partial'} />
              }
              onClick={handleSelectAll}
              disabled={submitting || scopeFiles.length === 0}
            >
              {selectAllState === 'all' ? t('filePicker.deselectAll') : t('filePicker.selectAll')}
            </Button>
            
            <DropdownMenu
              portal
              menuClassName="quick-select-menu"
              itemClassName=""
              renderTrigger={({ toggle }) => (
                <Button variant="ghost" size="sm" disabled={submitting || scopeFiles.length === 0} onClick={toggle}>
                  {t('filePicker.quickSelect')}
                  <Icon name="chevron-down" size={14} />
                </Button>
              )}
              items={[
                {
                  key: 'scope-only', icon: <Icon name="check" size={14} />,
                  label: t('filePicker.onlyScope'), onSelect: () => handleQuickSelect('scope-only'),
                },
                {
                  key: 'videos',
                  icon: <Icon name="film" size={14} />,
                  label: t('filePicker.onlyVideos'),
                  onSelect: () => handleQuickSelect('video-only'),
                },
                {
                  key: 'videos-subs', icon: <Icon name="film" size={14} />,
                  label: t('filePicker.videoSubtitles'), onSelect: () => handleQuickSelect('video-subtitles'),
                },
                {
                  key: 'mp4', icon: <Icon name="film" size={14} />,
                  label: t('filePicker.addMp4'), onSelect: () => handleQuickSelect('add-mp4'),
                },
                {
                  key: 'mkv',
                  icon: <Icon name="film" size={14} />,
                  label: t('filePicker.addMkv'),
                  onSelect: () => handleQuickSelect('add-mkv'),
                },
                {
                  key: 'samples', icon: <Icon name="x" size={14} />,
                  label: t('filePicker.excludeSamples'), onSelect: () => handleQuickSelect('exclude-sample'),
                },
                {
                  key: 'text',
                  icon: <Icon name="file-text" size={14} />,
                  label: t('filePicker.deselectText'),
                  onSelect: () => handleQuickSelect('exclude-txt'),
                },
                {
                  key: 'nfo',
                  icon: <Icon name="file" size={14} />,
                  label: t('filePicker.deselectNfo'),
                  onSelect: () => handleQuickSelect('exclude-nfo'),
                },
              ]}
            />
          </div>
        </div>

        <div className="tfs-selection-scope">
          <label><span>{t('filePicker.scope')}</span><Select disabled={submitting} value={selectionScope} onChange={value => setSelectionScope(value as 'filtered' | 'all')}
            ariaLabel={t('filePicker.scope')} options={[
              { value: 'filtered', label: t('filePicker.scopeList').replace('{count}', String(filteredFiles.length)) },
              { value: 'all', label: t('filePicker.scopeAll').replace('{count}', String(torrentInfo.files.length)) },
            ]} /></label>
          <Button variant="secondary" size="sm" className="tfs-folder-button" disabled={submitting || !folders.length} icon={<Icon name="folder" size={14} />}
            title={folder || t('filePicker.allFolders')} onClick={() => setShowFolders(true)}><span>{folder || t('filePicker.chooseFolder')}</span></Button>
          <p>{t('filePicker.scopeHint')}{selectedOutsideList > 0 && <> {t('filePicker.selectedOutside').replace('{count}', String(selectedOutsideList))}</>}</p>
        </div>

        {/* File List */}
        <VirtualFileList className="file-list" items={filteredFiles} getKey={fileKey}
          label={t('filePicker.title')} estimateSize={84} resetKey={`${torrentPath || magnetUri || ''}\n${folder}\n${searchQuery}`}
          empty={(
            <div className="no-results">
              <Icon name="search" size={48} />
              <p>{t('filePicker.noMatch')}</p>
            </div>
          )} renderRow={(file) => (
              <div
                key={file.index}
                className={`file-item ${selectedFiles.has(file.index) ? 'selected' : ''}`}
                onClick={() => handleToggleFile(file.index)}
              >
                <SelectionCheckbox
                  aria-label={file.path}
                  disabled={submitting}
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
            )} />
    </Modal>
    {showFolders && <TorrentFolderPicker folders={folders} onClose={() => setShowFolders(false)} onChoose={next => { setFolder(next); setShowFolders(false); }} />}
    </>
  );
};
