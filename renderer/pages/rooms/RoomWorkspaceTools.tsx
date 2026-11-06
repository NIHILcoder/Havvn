import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { DropdownMenu } from '../../components/DropdownMenu';
import { Icon } from '../../components/Icon';
import { ErrorMessage } from '../../components/ErrorMessage';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow } from '../../utils/hostWindow';
import { useVisibleWork } from '../../utils/visible-work';
import './RoomWorkspace.css';
import { ROOM_OBJECT_OPEN, type RoomObjectOpenRequest } from '../../utils/room-object-links';
import type { RoomWorkspaceObject } from '../../../shared/room-object-links';

const WorkArea = lazy(() => import('./RoomWorkArea').then(m => ({ default: m.RoomWorkArea })));

export function RoomWorkspaceTools({ roomId, disabled, onRootsChange }: { roomId: string; disabled?: boolean; onRootsChange(count: number): void }) {
  const { t } = useTranslation(), host = useHostWindow(), visible = useVisibleWork();
  const [panel, setPanel] = useState<'folders' | 'files' | null>(null), [documents, setDocuments] = useState(false);
  const [requestRevision, setRequestRevision] = useState(0);
  const [requestedObject, setRequestedObject] = useState<RoomWorkspaceObject | null>(null);
  const open = useCallback((entry: 'folders' | 'files' | 'documents', target?: RoomWorkspaceObject) => { setRequestedObject(target ?? null); setPanel(entry === 'documents' ? null : entry); setDocuments(entry === 'documents'); setRequestRevision(n => n + 1); }, []);
  useEffect(() => {
    const receive = (event: Event) => { const request = (event as CustomEvent<RoomObjectOpenRequest>).detail; if (!request || request.claimed || request.roomId !== roomId || disabled) return; request.claimed = true; open(request.target.kind === 'document' ? 'documents' : 'files', request.target); };
    window.addEventListener(ROOM_OBJECT_OPEN, receive); return () => window.removeEventListener(ROOM_OBJECT_OPEN, receive);
  }, [roomId, disabled, open]);
  const [count, setCount] = useState(0), [attention, setAttention] = useState(0), [error, setError] = useState('');
  const rootsChanged = useCallback((n: number) => { setCount(n); onRootsChange(n); }, [onRootsChange]);
  useEffect(() => {
    if (disabled || !visible || panel || documents) return;
    let alive = true, timer: number;
    const read = async () => {
      try { const next = await window.api.rooms.fileSync.state(roomId); if (alive) { setCount(next.roots.length); onRootsChange(next.roots.length); setAttention(next.roots.filter(r => r.conflicts || r.error || r.notice).length); setError(''); } }
      catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); }
      if (alive) timer = host.window.setTimeout(read, 3000);
    };
    void read(); return () => { alive = false; host.window.clearTimeout(timer); };
  }, [roomId, disabled, visible, panel, documents, host, onRootsChange]);
  return <>
    <div className="room-workspace-tools">
      <Button variant="secondary" size="sm" data-sync-folders-open disabled={disabled} icon={<Icon name="folder" size={15} />} onClick={() => open('folders')}>
        {t('rooms.workspace.folders')}{count > 0 && <span className="room-workspace-count">{count}</span>}{attention > 0 && <Icon name="alert-circle" size={13} />}
      </Button>
      <DropdownMenu portal menuClassName="dropdown-menu room-workspace-menu" renderTrigger={({ toggle, open }) =>
        <Button variant="secondary" size="sm" data-editor-open disabled={disabled} icon={<Icon name="edit-2" size={15} />} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          {t('rooms.workspace.editor')}<Icon name="chevron-down" size={12} />
        </Button>} items={[
          { key: 'files', icon: <Icon name="file-text" size={17} />, label: <span data-editor-files><strong>{t('rooms.workspace.projectFiles')}</strong><small>{t('rooms.workspace.projectFilesHint')}</small></span>, onSelect: () => open('files') },
          { key: 'documents', icon: <Icon name="users" size={17} />, label: <span data-docs-open><strong>{t('rooms.workspace.notes')}</strong><small>{t('rooms.workspace.notesHint')}</small></span>, onSelect: () => open('documents') },
        ]} />
    </div>
    {error && <p className="room-workspace-error" role="alert"><ErrorMessage error={error} /></p>}
    {(panel || documents) && <Suspense fallback={null}><WorkArea key={roomId} roomId={roomId} initial={documents ? 'documents' : panel!} requestRevision={requestRevision} requestedObject={requestedObject} disabled={disabled} onRootsChange={rootsChanged} onClose={() => { setPanel(null); setDocuments(false); }} /></Suspense>}
  </>;
}
