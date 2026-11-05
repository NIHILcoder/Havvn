// Isolated native acceptance entry. Uses the production component and real preload IPC.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { I18nProvider } from '../../renderer/utils/i18nContext';
import { RoomSyncModal } from '../../renderer/pages/rooms/RoomSyncModal';
import { RoomFilesPanel } from '../../renderer/pages/RoomsPage';
import { ConfirmProvider } from '../../renderer/components/ConfirmDialog';
import { pageLeave } from '../../renderer/state/page-leave';
import type { RoomState } from '../../shared/types';
import '../../renderer/index.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/exo-2/600.css';
localStorage.setItem('language', 'ru');
// Observe the full production editor state, including lines outside CodeMirror's viewport.
(window as unknown as { __fixtureDocumentText(): string }).__fixtureDocumentText = () => {
  const element = [...document.querySelectorAll<HTMLElement>('.hd-buffer')].find(e => e.style.display !== 'none')?.querySelector('.cm-editor');
  return element ? EditorView.findFromDOM(element as HTMLElement)?.state.doc.toString() ?? '' : '';
};
const roomId = new URLSearchParams(location.search).get('roomId')!;
function FilesSurface() {
  const [room, setRoom] = useState<RoomState | null>(null);
  useEffect(() => {
    let alive = true;
    const update = () => { void window.api.rooms.get(roomId).then(state => { if (alive) setRoom(state); }); };
    update(); const timer = window.setInterval(update, 1000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  return room && <div style={{ height: '100vh', display: 'flex', padding: 20, boxSizing: 'border-box' }}><RoomFilesPanel room={room}
    onAddFiles={() => {}} onDropFiles={() => {}} onCreateFolder={() => {}} onUpdateFolder={() => {}} onDeleteFolder={() => {}}
    onAssignFile={() => {}} onWatch={() => {}} onWatchJoin={() => {}} watchCounts={{}} onInvite={() => {}} onShared={setRoom} onToggleAutoFetch={() => {}} busy={false} /></div>;
}
const surface = <I18nProvider><ConfirmProvider>{new URLSearchParams(location.search).get('surface') === 'files'
  ? <FilesSurface /> : <RoomSyncModal roomId={roomId} onClose={() => {}} />}</ConfirmProvider></I18nProvider>;
const fixtureRoot = createRoot(document.getElementById('root')!);
fixtureRoot.render(new URLSearchParams(location.search).get('strict') === '1' ? <React.StrictMode>{surface}</React.StrictMode> : surface);
(window as unknown as { __fixtureLeavePage(): void }).__fixtureLeavePage = () => {
  void pageLeave.run(() => fixtureRoot.render(<p data-fixture-left>Left the page</p>));
};
