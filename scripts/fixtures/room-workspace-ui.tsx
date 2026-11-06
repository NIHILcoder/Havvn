// Production components, isolated synthetic rooms. No user data or external network.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import * as Y from 'yjs';
import { I18nProvider } from '../../renderer/utils/i18nContext';
import { ConfirmProvider } from '../../renderer/components/ConfirmDialog';
import { RoomWorkspaceTools } from '../../renderer/pages/rooms/RoomWorkspaceTools';
import { VoiceSettingsModal } from '../../renderer/components/VoiceSettingsModal';
import { RoomDiagnostics } from '../../renderer/components/RoomDiagnostics';
import { SpeakerTester } from '../../electron/sharing/speaker-test';
import { buildRoomDiagnosticReport } from '../../shared/room-diagnostics';
import { pageLeave } from '../../renderer/state/page-leave';
import { VisibleWorkProvider } from '../../renderer/utils/visible-work';
import { RoomChatBody } from '../../renderer/pages/rooms/RoomChat';
import { RoomObjectOpener, openRoomObject } from '../../renderer/pages/rooms/RoomObjectOpener';
import { roomObjectLink, type RoomObjectLink } from '../../shared/room-object-links';
import type { RoomState } from '../../shared/types';
import '../../renderer/pages/RoomsPage.css';
import '../../renderer/index.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/exo-2/600.css';
localStorage.setItem('language', 'ru');
const f = {
  current: 'workspace', token: 0, stateReads: 0, opened: [] as string[], closed: [] as string[], saved: [] as string[], docClosed: [] as string[], micStarts: 0, speakerStarts: 0, speakerStops: 0, speakerFail: false, speakerHold: false, speakerRelease: undefined as undefined | (() => void),
  voiceCalls: [] as string[], docOpened: [] as string[], fileFetchCalls: 0, sharedFiles: [{ fileId: 'shared-file', name: 'Общий фильм.mp4', size: 120 }], documentVersion: 1, document: new Y.Doc(), fileText: '<Project>\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n', copied: '', probeCalls: 0,
  editor(doc: Document = document) { const el = [...doc.querySelectorAll<HTMLElement>('.room-workarea-pane:not([hidden]) .cm-editor')][0]; return el ? EditorView.findFromDOM(el) : null; },
  edit(text: string, anchor = 5, doc: Document = document) { const cm = this.editor(doc); if (!cm) throw Error('No editor'); cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text }, selection: { anchor } }); },
  cursor(doc: Document = document) { return this.editor(doc)?.state.selection.main.anchor; },
  text(doc: Document = document) { return this.editor(doc)?.state.doc.toString(); },
  async leave() { return pageLeave.run(() => root.render(<p data-left>Left</p>)); },
};
const originalOpen = window.open.bind(window);
window.open = (...args) => { const child = originalOpen(...args); Object.assign(f, { child }); return child; };
f.document.getText('text').insert(0, '# Room notes\nShared draft.');
const encoded = () => btoa(String.fromCharCode(...Y.encodeStateAsUpdate(f.document)));
const documentView = () => ({ documentId: 'note', title: 'Заметка комнаты', language: 'markdown', archived: false, writable: true, seq: f.documentVersion, pending: 0, updatedAt: 1,
  token: 'document-token', policyId: 'policy', state: encoded(), version: f.documentVersion, selfId: 'self', ownerId: 'self', ownerOnline: true, writers: ['self'], cursors: [], localDraft: false, blockedPending: false });
const roomView = { enabled: true, canCreate: true, roots: [{ rootId: 'root', name: 'Проект Havvn', path: 'D:/synthetic/project', paused: false, publisher: true, owner: true, multiWriter: false, autoApply: false, autoPublish: false, files: 2, pending: 0, conflicts: 0 }] };
const filesView = { items: [{ entryId: 'project', path: 'src/Havvn.csproj', size: 120, revisionId: 'revision', status: 'published', editable: true }, { entryId: 'readme', path: 'README.md', size: 200, revisionId: 'revision', status: 'published', editable: true }], next: null };
const draft = (entryId: string) => ({ token: 'editor-' + (++f.token), rootId: 'root', entryId, path: entryId === 'project' ? 'src/Havvn.csproj' : 'README.md', text: f.fileText, language: entryId === 'project' ? 'xml' : 'markdown', revisionId: 'revision', writable: true, newline: 'lf', bom: false, localChanges: false });
const tester = new SpeakerTester();
const report = buildRoomDiagnosticReport(undefined, { state: 'ready' }, false, '3.3.0');
report.connection.phase = 'discovering'; report.connection.trackers.configured = 3;
Object.assign(window, { fixture: f, fixtureReport: report });
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { f.copied = text; } } });
Object.defineProperty(window, 'api', { value: {
  setLanguage() {}, onVoiceDevicesChanged: () => () => {}, onVoiceMicLevel: () => () => {},
  rooms: {
    fileSync: {
      state: async () => { f.stateReads++; return structuredClone(roomView); }, files: async () => structuredClone(filesView),
      history: async () => ({ items: [{ revisionId: 'a'.repeat(64), createdAt: 1, size: 120, current: true, local: true }], next: null, canRestore: true, path: 'src/Havvn.csproj' }),
      openEditor: async (_room: string, _root: string, entryId: string) => { const result = draft(entryId); f.opened.push(result.token); return result; },
      closeEditor: async (_room: string, token: string) => { f.closed.push(token); },
      saveEditor: async (_room: string, token: string, text: string) => { f.saved.push(text); f.fileText = text; return { draft: { ...draft('project'), token } }; },
    },
    documents: {
      view: async () => ({ enabled: true, selfId: 'self', ownerId: 'self', canCreate: true, ownerOnline: true, members: [{ memberId: 'self', name: 'You', capable: true, online: true }], items: [documentView()] }),
      open: async (_room: string, id: string) => { f.docOpened.push(id); return documentView(); }, poll: async () => documentView(),
      close: async (_room: string, token: string) => { f.docClosed.push(token); },
      update: async (_room: string, _token: string, update: string) => { Y.applyUpdate(f.document, Uint8Array.from(atob(update), c => c.charCodeAt(0))); f.documentVersion++; return documentView(); },
      presence: async () => {}, history: async () => [], keepDraft: async () => {},
    },
    voice: {
      globalPtt: async () => ({ available: false, supported: false }),
      devices: async () => [{ deviceId: 'fixture-output', kind: 'audiooutput', label: 'Тестовый выход' }],
      micTestStart: async () => { f.micStarts++; return { ok: true }; }, micTestStop: async () => ({ ok: true }),
      speakerTestStart: async (settings: { masterVolume: number }) => { f.speakerStarts++; if (f.speakerFail) throw Error('Synthetic missing output'); if (f.speakerHold) await new Promise<void>(resolve => { f.speakerRelease = resolve; }); return tester.play(null, settings.masterVolume); },
      speakerTestStop: async () => { f.speakerStops++; tester.stop(); return { ok: true }; },
      leave: async () => { f.voiceCalls.push('leave'); },
    },
    diagnose: async () => structuredClone(report), retryConnection: async () => structuredClone(report), exportDiagnostics: async () => ({ success: false }),
    fetchFile: async () => { f.fileFetchCalls++; return {}; }, openFile: async () => {},
    probeConnection: async () => { f.probeCalls++; return { checkedAt: Date.now(), endpoints: [
      { index: 0, dns: 'failed', tcp: 'unknown', tls: 'unknown', websocket: 'unknown' },
      { index: 1, dns: 'ok', tcp: 'ok', tls: 'ok', websocket: 'ok' },
      { index: 2, dns: 'ok', tcp: 'failed', tls: 'unknown', websocket: 'unknown' }], turnEnabled: true, turnConfigured: false, customDiscovery: false }; },
  },
} });
function Surface() {
  const [mode, setMode] = useState('workspace');
  const [panelVisible, setPanelVisible] = useState(true);
  const [object, setObject] = useState<RoomObjectLink | null>(null), [, setRevision] = useState(0);
  Object.assign(f, { mount: setMode, setPanelVisible, repaint: () => setRevision(n => n + 1) });
  const syntheticRoom = { roomId: 'synthetic-room', files: f.sharedFiles, transfers: {}, kicked: false } as unknown as RoomState;
  const links = [roomObjectLink({ kind: 'document', id: 'note', name: 'Заметка комнаты' }), roomObjectLink({ kind: 'file', id: 'shared-file', name: 'Общий фильм.mp4' }), roomObjectLink({ kind: 'project', rootId: 'root', entryId: 'project', revisionId: 'a'.repeat(64), name: 'Версия проекта' }), roomObjectLink({ kind: 'document', id: 'missing', name: 'Удалённая заметка' })];
  return <><div data-fixture-nav><button onClick={() => setMode('workspace')}>Workspace</button><button onClick={() => setMode('voice')}>Voice</button><button onClick={() => setMode('diagnostics')}>Diagnostics</button></div>
    {mode === 'links' ? <><RoomWorkspaceTools roomId="synthetic-room" onRootsChange={() => {}} /><div style={{ padding: 20, maxWidth: 600 }}><RoomChatBody text={links.join('\n') + '\n```\n' + links[0] + '\n```'} copyLabel="Copy" copiedLabel="Copied" onObject={target => openRoomObject(syntheticRoom, target, setObject)} /></div>{object && <RoomObjectOpener room={syntheticRoom} target={object} onClose={() => setObject(null)} />}</>
      : mode === 'workspace' ? <VisibleWorkProvider active={panelVisible}><RoomWorkspaceTools roomId="synthetic-room" onRootsChange={() => {}} /></VisibleWorkProvider> : mode === 'voice' ? <VoiceSettingsModal onClose={() => setMode('workspace')} /> : <RoomDiagnostics roomId="synthetic-room" onClose={() => setMode('workspace')} />}</>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<I18nProvider><ConfirmProvider><Surface /></ConfirmProvider></I18nProvider>);
