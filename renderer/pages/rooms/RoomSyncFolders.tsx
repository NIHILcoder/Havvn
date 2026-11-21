import { ErrorMessage } from '../../components/ErrorMessage';
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow } from '../../utils/hostWindow';
import { useVisibleWork } from '../../utils/visible-work';
import { formatBytes } from '../../utils/format-helpers';
import type { SyncFilesPage, SyncRoomView } from '../../../shared/room-file-sync-ui';
import type { SyncEditorDraft } from '../../../shared/room-file-sync-editor';
import { syncFolderStatus } from '../../../shared/room-file-sync-ui';
import './RoomSyncFolders.css';

const RoomSyncModal = lazy(() => import('./RoomSyncModal').then(m => ({ default: m.RoomSyncModal })));
const RoomFileEditorModal = lazy(() => import('./RoomFileEditorModal').then(m => ({ default: m.RoomFileEditorModal })));

/** Live folders belong in the room's Files surface. Disk consent stays with the existing picker. */
export interface SyncToolTarget { rootId?: string; entryId?: string; revisionId?: string; deleteEntryId?: string; pathEntryId?: string; missing?: boolean; trashStorage?: boolean }
export function RoomSyncFolders({ roomId, disabled = false, onRootsChange, editorOnly = false, onOpenEditor, onOpenSettings }: { roomId: string; disabled?: boolean; onRootsChange?(count: number): void; editorOnly?: boolean; onOpenEditor?(draft: SyncEditorDraft): void; onOpenSettings?(target: SyncToolTarget): void }) {
  const { t } = useTranslation(), host = useHostWindow();
  const visible = useVisibleWork();
  const [view, setView] = useState<SyncRoomView | null>(null), [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState<SyncFilesPage | null>(null), [offset, setOffset] = useState(0);
  const [trashRoot, setTrashRoot] = useState<string | null>(null);
  const [error, setError] = useState(''), [fetchError, setFetchError] = useState(''), [opening, setOpening] = useState(false);
  const [canceling, setCanceling] = useState<string | null>(null);
  const [settings, setLocalSettings] = useState<SyncToolTarget | null>(null);
  const setSettings = (target: SyncToolTarget) => onOpenSettings ? onOpenSettings(target) : setLocalSettings(target);
  const [draft, setDraft] = useState<SyncEditorDraft | null>(null);
  const mounted = useRef(false), generation = useRef(0), editorBusy = useRef(false);
  const autoExpanded = useRef(false);
  useEffect(() => {
    if (editorOnly && view?.roots.length && !autoExpanded.current) { autoExpanded.current = true; setExpanded((view.roots.find(r => r.path && !r.paused) ?? view.roots[0]).rootId); }
  }, [editorOnly, view]);
  const invalidate = useCallback(() => { mounted.current = false; generation.current++; }, []);
  const invalidateRead = useCallback(() => { generation.current++; }, []);
  const refresh = useCallback(async () => {
    if (disabled) return;
    const current = ++generation.current;
    try {
      const state = await window.api.rooms.fileSync.state(roomId);
      const files = expanded && state.roots.some(r => r.rootId === expanded && !r.paused) ? await window.api.rooms.fileSync.files(roomId, expanded, offset, trashRoot === expanded) : null;
      if (!mounted.current || current !== generation.current) return;
      setView(state); setPage(files); setFetchError(''); onRootsChange?.(state.roots.length);
    } catch (cause) { if (mounted.current && current === generation.current) setFetchError(cause instanceof Error ? cause.message : String(cause)); }
  }, [roomId, expanded, offset, disabled, onRootsChange, trashRoot]);
  useEffect(() => {
    mounted.current = true;
    return invalidate;
  }, [invalidate]);
  useEffect(() => {
    if (!visible || disabled) return;
    let alive = true, timer: number;
    const poll = async () => { await refresh(); if (alive) timer = host.window.setTimeout(poll, 3000); };
    void poll();
    // Invalidate a read, not an editor opened by the user: its token still needs cleanup.
    return () => { alive = false; invalidateRead(); host.window.clearTimeout(timer); };
  }, [refresh, host, visible, disabled, invalidateRead]);
  const openEditor = async (rootId: string, entryId: string) => {
    if (editorBusy.current || disabled) return;
    editorBusy.current = true; setOpening(true); setError('');
    try {
      const result = await window.api.rooms.fileSync.openEditor(roomId, rootId, entryId);
      if (mounted.current) { if (onOpenEditor) onOpenEditor(result); else setDraft(result); } else void window.api.rooms.fileSync.closeEditor(roomId, result.token).catch(() => {});
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { editorBusy.current = false; if (mounted.current) setOpening(false); }
  };
  const cancelWork = async (rootId: string) => {
    if (canceling) return;
    setCanceling(rootId); setError('');
    try { await window.api.rooms.fileSync.action(roomId, rootId, 'cancel-work'); await refresh(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setCanceling(null); }
  };
  if (view && !view.enabled) return null;
  return <section className="room-sync-library" aria-label={t('rooms.sync.library')} aria-busy={opening}>
    <div className="room-sync-library-heading">
      <span><Icon name="refresh" size={14} />{t('rooms.sync.library')}</span>
      <Button size="sm" variant={view?.canCreate ? 'primary' : 'secondary'} data-sync-library-manage disabled={disabled || opening} icon={<Icon name={view?.canCreate ? 'folder-plus' : 'sliders'} size={14} />} onClick={() => setSettings({})}>
        {t(view?.canCreate ? 'rooms.sync.addFolder' : 'rooms.sync.manageFolders')}
      </Button>
    </div>
    {(error || fetchError) && <p className="room-sync-library-error" role="alert"><ErrorMessage error={error || fetchError} /></p>}
    {view?.roots.map(root => <article key={root.rootId} className="room-sync-library-folder" data-sync-folder={root.rootId}>
      <div className="room-sync-library-folder-head">
        <button type="button" className="room-sync-library-expand" data-sync-folder-expand aria-expanded={expanded === root.rootId} disabled={disabled || root.paused} onClick={() => {
          setExpanded(expanded === root.rootId && trashRoot !== root.rootId ? null : root.rootId); setTrashRoot(null); setOffset(0); setPage(null);
        }}>
          <Icon name={expanded === root.rootId ? 'chevron-down' : 'chevron-right'} size={14} />
          <Icon name={expanded === root.rootId ? 'folder-open' : 'folder'} size={21} />
          <span><strong>{root.name}</strong><small>{t('rooms.sync.libraryCount').replace('{n}', String(root.files))} · {t(root.paused ? 'rooms.sync.paused' : root.path ? 'rooms.sync.connected' : 'rooms.sync.notConnected')}</small></span>
        </button>
        <span className={'room-sync-folder-status is-' + syncFolderStatus(root)} data-sync-folder-status={syncFolderStatus(root)}>{t(`rooms.workspace.status.${syncFolderStatus(root)}`)}{root.conflicts > 0 ? ` · ${root.conflicts}` : ''}</span>
        {(root.conflicts > 0 || root.error) && <Button size="sm" variant="secondary" data-sync-folder-review disabled={disabled || opening} onClick={() => setSettings({ rootId: root.rootId })}>{t('rooms.workspace.review')}</Button>}
        {root.publisher && root.deletes && root.path && !root.paused && <Button size="sm" variant={root.missing ? 'secondary' : 'ghost'} data-sync-library-missing disabled={disabled || opening} onClick={() => setSettings({ rootId: root.rootId, missing: true })}>{t('rooms.sync.missingTitle')}{root.missing ? ` · ${root.missing}` : ''}</Button>}
        {!!root.trash && !root.paused && <Button size="sm" variant={trashRoot === root.rootId ? 'secondary' : 'ghost'} data-sync-library-trash icon={<Icon name="trash" size={14} />} disabled={disabled || opening} onClick={() => { setExpanded(root.rootId); setTrashRoot(root.rootId); setOffset(0); setPage(null); }}>{t('rooms.sync.trash')} · {root.trash}</Button>}
        {!root.path && !root.paused && <Button size="sm" variant="primary" data-sync-folder-connect disabled={disabled || opening} onClick={() => setSettings({ rootId: root.rootId })}>{t('rooms.sync.connectFolder')}</Button>}
        <Button size="sm" variant="ghost" iconOnly icon={<Icon name="sliders" size={16} />} title={t('rooms.sync.folderSettings')} aria-label={`${t('rooms.sync.folderSettings')}: ${root.name}`} data-sync-folder-settings disabled={disabled || opening} onClick={() => setSettings({ rootId: root.rootId })} />
      </div>
      {root.work && <div className="room-sync-library-work" data-sync-work={root.rootId}>
        <p role="status">{root.work.waiting
          ? t('rooms.sync.workWaiting').replace('{n}', String(root.work.position ?? 1))
          : t('rooms.sync.workActive')}<small>{t('rooms.sync.workCancelNote')}</small></p>
        <Button size="sm" variant="ghost" data-sync-work-cancel disabled={disabled || canceling !== null}
          title={t('rooms.sync.workCancelHint')} loading={canceling === root.rootId}
          onClick={() => { void cancelWork(root.rootId); }}>{t('rooms.sync.workCancel')}</Button>
      </div>}
      {expanded === root.rootId && <div className="room-sync-library-contents">
        {trashRoot === root.rootId && <p>{t('rooms.sync.trashHint')}</p>}
        {trashRoot === root.rootId && root.path && <Button size="sm" variant="secondary" data-sync-library-trash-storage disabled={disabled || opening} onClick={() => setSettings({ rootId: root.rootId, trashStorage: true })}>{t('rooms.sync.trashStorageTitle')}</Button>}
        {!root.path && <p>{t('rooms.sync.connectToEdit')}</p>}
        {root.error && <p className="room-sync-library-error" role="alert"><ErrorMessage error={root.error} /></p>}
        {root.notice && <div className="room-sync-library-notice"><p>{t('rooms.workspace.rightsPaused')}</p><Button size="sm" variant="secondary" data-sync-folder-resume disabled={disabled || opening}
          onClick={() => setSettings({ rootId: root.rootId })}>{t('rooms.workspace.resume')}</Button></div>}
        {!page ? <p role="status">{t('common.loading')}</p> : <>
          {page.items.filter(file => !editorOnly || file.editable).map(file => <div className="room-sync-library-file" key={file.entryId} data-sync-entry={file.entryId}>
            <div className="room-sync-library-file-name"><Icon name="file-text" size={16} /><span><strong>{file.path}</strong><small>{t(`rooms.sync.status.${file.status}`)}</small></span>{!file.deleted && <small>{formatBytes(file.size)}</small>}</div>
            <div className="room-sync-library-file-actions">
              {file.pathResolvable && <Button size="sm" variant="secondary" data-sync-path-open disabled={disabled || opening} onClick={() => setSettings({ rootId: root.rootId, pathEntryId: file.entryId })}>{t('rooms.sync.pathTitle')}</Button>}
              {file.editable && <Button size="sm" variant="secondary" icon={<Icon name="edit-2" size={14} />} data-sync-open-editor disabled={disabled || opening} onClick={() => { void openEditor(root.rootId, file.entryId); }}>{t('rooms.sync.editorOpen')}</Button>}
              <Button size="sm" variant="ghost" icon={<Icon name="clock" size={14} />} data-sync-entry-history disabled={disabled || opening} onClick={() => setSettings({ rootId: root.rootId, entryId: file.entryId })}>{t('rooms.sync.history')}</Button>
              {file.deletable && <Button size="sm" variant="ghost" iconOnly icon={<Icon name="trash" size={15} />} data-sync-delete title={t('rooms.sync.deleteTitle')} aria-label={`${t('rooms.sync.deleteTitle')}: ${file.path}`} disabled={disabled || opening} onClick={() => setSettings({ rootId: root.rootId, deleteEntryId: file.entryId })} />}
            </div>
          </div>)}
          {(editorOnly ? !page.items.some(file => file.editable) : page.items.length === 0) && <p>{t(editorOnly ? 'rooms.workspace.noTextFiles' : 'rooms.sync.noFiles')}</p>}
          {(offset > 0 || page.next !== null) && <div className="room-sync-library-pages">
            <Button size="sm" variant="ghost" disabled={disabled || offset === 0} onClick={() => { setOffset(Math.max(0, offset - 100)); setPage(null); }}>{t('rooms.sync.previous')}</Button>
            <Button size="sm" variant="ghost" disabled={disabled || page.next === null} onClick={() => { setOffset(page.next!); setPage(null); }}>{t('rooms.sync.next')}</Button>
          </div>}
        </>}
      </div>}
    </article>)}
    {view?.roots.length === 0 && <p className="room-sync-library-empty">{t('rooms.sync.libraryEmpty')}</p>}
    {settings && <Suspense fallback={null}><RoomSyncModal roomId={roomId} initialRootId={settings.rootId} initialEntryId={settings.entryId} initialDeleteEntryId={settings.deleteEntryId} initialPathEntryId={settings.pathEntryId} initialMissing={settings.missing} initialTrashStorage={settings.trashStorage} onClose={() => { setLocalSettings(null); void refresh(); }} /></Suspense>}
    {draft && <Suspense fallback={null}><RoomFileEditorModal roomId={roomId} initial={draft}
      work={view?.roots.find(root => root.rootId === draft.rootId)?.work} onCancelWork={() => cancelWork(draft.rootId)}
      canceling={canceling === draft.rootId}
      onClose={() => { setDraft(null); void refresh(); }} /></Suspense>}
  </section>;
}
