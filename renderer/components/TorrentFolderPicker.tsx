import React, { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { VirtualFileList } from './VirtualFileList';
import { useTranslation } from '../utils/i18nContext';
import './TorrentFolderPicker.css';

export function TorrentFolderPicker({ folders, onChoose, onClose }: {
  folders: readonly { path: string; count: number }[]; onChoose(path: string): void; onClose(): void;
}) {
  const { t } = useTranslation(), [query, setQuery] = useState('');
  const matches = useMemo(() => folders.filter(folder => folder.path.toLowerCase().includes(query.toLowerCase())), [folders, query]);
  return <Modal title={t('filePicker.chooseFolder')} size="md" icon="folder" onClose={onClose} footer={<>
    <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
    <Button variant="secondary" onClick={() => onChoose('')}>{t('filePicker.allFolders')}</Button>
  </>}>
    <input className="input" type="search" aria-label={t('filePicker.findFolder')} placeholder={t('filePicker.findFolder')} value={query} onChange={event => setQuery(event.target.value)} autoFocus />
    <p className="tfs-folder-count" role="status">{t('filePicker.folderCount').replace('{count}', String(matches.length))}</p>
    <VirtualFileList className="tfs-folders" items={matches} getKey={folder => folder.path} label={t('filePicker.chooseFolder')} estimateSize={56} resetKey={query}
      empty={<p>{t('filePicker.noFolders')}</p>} renderRow={folder => <button type="button" className="tfs-folder-option" title={folder.path} onClick={() => onChoose(folder.path)}>
        <span>{folder.path}</span><small>{t('filePicker.folderFiles').replace('{count}', String(folder.count))}</small>
      </button>} />
  </Modal>;
}
