import React, { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Icon } from '../../components/Icon';
import { ErrorMessage } from '../../components/ErrorMessage';
import { useTranslation } from '../../utils/i18nContext';
import { HostWindowRealm, useHostWindow } from '../../utils/hostWindow';
import { usePopout } from '../../utils/popout';
import { VisibleWorkProvider } from '../../utils/visible-work';
import type { SyncEditorDraft } from '../../../shared/room-file-sync-editor';
import type { SyncToolTarget } from './RoomSyncFolders';
import type { ToolCloseGuard } from './RoomToolSurface';
import './RoomWorkspace.css';
import type { RoomWorkspaceObject } from '../../../shared/room-object-links';

const Folders = lazy(() => import('./RoomSyncFolders').then(m => ({ default: m.RoomSyncFolders })));
const Documents = lazy(() => import('./RoomDocumentsEditor').then(m => ({ default: m.RoomDocumentsEditor })));
const FileEditor = lazy(() => import('./RoomFileEditorModal').then(m => ({ default: m.RoomFileEditorModal })));
const Settings = lazy(() => import('./RoomSyncModal').then(m => ({ default: m.RoomSyncModal })));
type Entry = 'folders' | 'files' | 'documents';
type ToolTab = { id: string; kind: 'file'; draft: SyncEditorDraft } | { id: string; kind: 'settings'; target: SyncToolTarget } | { id: string; kind: 'copy'; seed: { title: string; text: string } };

export function RoomWorkArea({ roomId, initial, requestRevision = 0, requestedObject, disabled, onRootsChange, onClose }: { roomId: string; initial: Entry; requestRevision?: number; requestedObject?: RoomWorkspaceObject | null; disabled?: boolean; onRootsChange(n: number): void; onClose(): void }) {
  const { t } = useTranslation(), host = useHostWindow();
  const [active, setActive] = useState<string>(initial), [base, setBase] = useState<'folders' | 'files'>(initial === 'files' ? 'files' : 'folders');
  const [documents, setDocuments] = useState(initial === 'documents'), [tabs, setTabs] = useState<ToolTab[]>([]), [error, setError] = useState('');
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const guards = useRef(new Map<string, ToolCloseGuard>()), registrations = useRef(new Map<string, (guard: ToolCloseGuard | null) => void>());
  const closing = useRef(false), mounted = useRef(true);
  const { popout, root, openPopout, closePopout } = usePopout('havvn-room-workspace', t('rooms.workArea.title'));
  const detachedWindow = useRef(popout); detachedWindow.current = popout;
  useEffect(() => {
    setActive(initial); if (initial === 'folders' || initial === 'files') setBase(initial); else setDocuments(true);
    detachedWindow.current?.focus();
  }, [initial, requestRevision]);
  // React always targets this same node. Reparenting it does not remount buffers.
  const [container] = useState(() => { const el = host.document.createElement('div'); el.className = 'room-workarea-root'; return el; });
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { (root ?? slot.current)?.appendChild(container); }, [root, container]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const registration = (id: string) => {
    if (!registrations.current.has(id)) registrations.current.set(id, guard => { if (guard) guards.current.set(id, guard); else guards.current.delete(id); });
    return registrations.current.get(id)!;
  };
  const close = async (id?: string) => {
    if (closing.current) return;
    closing.current = true; setError('');
    try {
      if ((id ? [id] : [...tabsRef.current.map(tab => tab.id), ...(documents ? ['documents'] : [])]).some(key => !guards.current.has(key))) { setError(t('navigation.waitWork')); return; }
      for (const key of id ? [id] : [...guards.current.keys()].reverse()) {
        const guard = guards.current.get(key);
        if (guard && !await guard()) { setActive(key); return; }
      }
      if (!mounted.current) return;
      if (!id) { closePopout(); onClose(); return; }
      const opened = tabsRef.current, index = opened.findIndex(tab => tab.id === id);
      const next = opened.filter(tab => tab.id !== id); tabsRef.current = next; setTabs(next);
      registrations.current.delete(id); guards.current.delete(id);
      if (id === 'documents') setDocuments(false);
      setActive(current => current === id ? opened[index - 1]?.id ?? next[index]?.id ?? base : current);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { closing.current = false; }
  };
  const openEditor = (draft: SyncEditorDraft) => {
    const id = `file:${draft.rootId}:${draft.entryId}`, existing = tabsRef.current.find(tab => tab.id === id);
    if (existing || tabsRef.current.length >= 8) {
      void window.api.rooms.fileSync.closeEditor(roomId, draft.token).catch(() => {});
      if (existing) setActive(id); else setError(t('rooms.workArea.tabLimit'));
      return;
    }
    const next: ToolTab[] = [...tabsRef.current, { id, kind: 'file', draft }]; tabsRef.current = next; setTabs(next); setActive(id);
  };
  const openSettings = (target: SyncToolTarget) => {
    const id = 'settings:' + JSON.stringify(target);
    if (!tabsRef.current.some(tab => tab.id === id)) {
      if (tabsRef.current.length >= 8) { setError(t('rooms.workArea.tabLimit')); return; }
      const next: ToolTab[] = [...tabsRef.current, { id, kind: 'settings', target }]; tabsRef.current = next; setTabs(next);
    }
    setActive(id);
  };
  const openCopy = (seed: { title: string; text: string }) => {
    if (tabsRef.current.length >= 8) { setError(t('rooms.workArea.tabLimit')); return; }
    const tab: ToolTab = { id: `copy:${Date.now()}`, kind: 'copy', seed };
    const next = [...tabsRef.current, tab]; tabsRef.current = next; setTabs(next); setActive(tab.id);
  };
  const objectActions = useRef({ openEditor, openSettings, t }); objectActions.current = { openEditor, openSettings, t };
  useEffect(() => {
    if (!requestedObject || requestedObject.kind !== 'project' || disabled) return;
    let alive = true; setError('');
    if (requestedObject.revisionId) objectActions.current.openSettings({ rootId: requestedObject.rootId, entryId: requestedObject.entryId, revisionId: requestedObject.revisionId });
    else void window.api.rooms.fileSync.openEditor(roomId, requestedObject.rootId, requestedObject.entryId).then(draft => {
      if (alive && mounted.current) objectActions.current.openEditor(draft); else void window.api.rooms.fileSync.closeEditor(roomId, draft.token).catch(() => {});
    }).catch(() => { if (alive && mounted.current) setError(objectActions.current.t('rooms.objects.unavailable')); });
    return () => { alive = false; };
  }, [roomId, requestRevision, requestedObject, disabled]);
  const title = (tab: ToolTab) => tab.kind === 'file' ? tab.draft.path : tab.kind === 'copy' ? tab.seed.title : t(tab.target.entryId ? 'rooms.sync.history' : 'rooms.sync.folderSettings');
  const select = (id: string) => { setActive(id); if (id === 'folders' || id === 'files') setBase(id); if (id === 'documents') setDocuments(true); };
  const current = tabs.find(tab => tab.id === active);
  const view = <div className="room-workarea" data-active-kind={current?.kind ?? active}>
    <div className="room-workarea-toolbar"><span><Icon name="folder-open" size={15} />{t('rooms.workArea.title')}</span><Button variant="ghost" size="sm" icon={<Icon name={popout ? 'minimize' : 'external-link'} size={14} />} onClick={() => popout ? closePopout() : openPopout()}>{t(popout ? 'rooms.voice.popIn' : 'rooms.voice.popOut')}</Button></div>
    <div className="room-workarea-tabs" role="tablist" aria-label={t('rooms.workArea.tabs')} onKeyDown={e => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key) || (e.target as HTMLElement).getAttribute('role') !== 'tab') return;
      const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')), at = items.indexOf(e.target as HTMLButtonElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
      e.preventDefault(); items[next]?.click(); items[next]?.focus();
    }}>
      {(['folders', 'files', 'documents'] as const).map(id => <div className="room-workarea-tab" key={id}><button type="button" role="tab" aria-selected={active === id} tabIndex={active === id ? 0 : -1} onClick={() => select(id)}>{t(id === 'folders' ? 'rooms.workspace.folders' : id === 'files' ? 'rooms.workspace.projectFiles' : 'rooms.workspace.notes')}</button>{id === 'documents' && documents && <button type="button" aria-label={t('common.close') + ' ' + t('rooms.workspace.notes')} onClick={() => { void close('documents'); }}><Icon name="x" size={13} /></button>}</div>)}
      {tabs.map(tab => <div className="room-workarea-tab" key={tab.id}><button type="button" role="tab" aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1} title={title(tab)} onClick={() => setActive(tab.id)}>{title(tab)}</button><button type="button" aria-label={t('common.close') + ' ' + title(tab)} onClick={() => { void close(tab.id); }}><Icon name="x" size={13} /></button></div>)}
    </div>
    <nav className="room-workarea-breadcrumb" aria-label={t('rooms.workArea.location')}><button type="button" onClick={() => select('folders')}>{t('rooms.workspace.folders')}</button><Icon name="chevron-right" size={12} /><span title={current ? title(current) : undefined}>{current ? title(current) : t(active === 'documents' ? 'rooms.workspace.notes' : active === 'files' ? 'rooms.workspace.projectFiles' : 'rooms.sync.library')}</span></nav>
    {error && <p className="room-workspace-error" role="alert"><ErrorMessage error={error} /></p>}
    <Suspense fallback={<p role="status">{t('common.loading')}</p>}>
      <div className="room-workarea-pane room-workarea-library" role="tabpanel" aria-label={t(base === 'files' ? 'rooms.workspace.projectFiles' : 'rooms.workspace.folders')} hidden={!['folders', 'files'].includes(active)}><VisibleWorkProvider active={['folders', 'files'].includes(active)}><Folders roomId={roomId} disabled={disabled} editorOnly={base === 'files'} onRootsChange={onRootsChange} onOpenEditor={openEditor} onOpenSettings={openSettings} /></VisibleWorkProvider></div>
      {documents && <div className="room-workarea-pane" role="tabpanel" aria-label={t('rooms.workspace.notes')} hidden={active !== 'documents'}><Documents embedded visible={active === 'documents'} roomId={roomId} initialDocumentId={requestedObject?.kind === 'document' ? requestedObject.id : undefined} openRequestRevision={requestRevision} registerClose={registration('documents')} onClose={() => { void close('documents'); }} /></div>}
      {tabs.map(tab => <div key={tab.id} className="room-workarea-pane" role="tabpanel" aria-label={title(tab)} hidden={active !== tab.id} data-workarea-pane={tab.kind}><VisibleWorkProvider active={active === tab.id}>{tab.kind === 'file'
        ? <FileEditor embedded roomId={roomId} initial={tab.draft} registerClose={registration(tab.id)} onClose={() => { void close(tab.id); }} onDocumentCopy={openCopy} />
        : tab.kind === 'copy' ? <Documents embedded visible={active === tab.id} roomId={roomId} seed={tab.seed} registerClose={registration(tab.id)} onClose={() => { void close(tab.id); }} />
          : <Settings embedded roomId={roomId} initialRootId={tab.target.rootId} initialEntryId={tab.target.entryId} initialRevisionId={tab.target.revisionId} initialDeleteEntryId={tab.target.deleteEntryId} initialPathEntryId={tab.target.pathEntryId} initialMissing={tab.target.missing} initialTrashStorage={tab.target.trashStorage} registerClose={registration(tab.id)} onOpenEditor={openEditor} onClose={() => { void close(tab.id); }} />}</VisibleWorkProvider></div>)}
    </Suspense>
  </div>;
  return <>
    {popout ? <div className="room-workarea-detached"><Button variant="secondary" onClick={() => popout.focus()}>{t('rooms.workArea.showWindow')}</Button><Button variant="ghost" onClick={closePopout}>{t('rooms.voice.popIn')}</Button></div> : createPortal(<Modal size="full" title={t('rooms.workArea.title')} icon="folder-open" className="room-workarea-modal" onClose={() => { void close(); }} closeOnBackdrop={false}><div className="room-workarea-slot" ref={slot} /></Modal>, host.document.body)}
    {createPortal(<HostWindowRealm window={popout ?? host.window}><VisibleWorkProvider independent active>{view}</VisibleWorkProvider></HostWindowRealm>, container)}
  </>;
}
