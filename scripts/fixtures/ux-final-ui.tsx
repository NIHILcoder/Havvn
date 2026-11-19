// Real production components; isolated in-memory data and no external network.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import { I18nProvider, useTranslation } from '../../renderer/utils/i18nContext';
import { ConfirmProvider } from '../../renderer/components/ConfirmDialog';
import { ScreenSourcePicker } from '../../renderer/components/ScreenShare';
import { DeviceInvitation } from '../../renderer/components/DeviceInvitation';
import { DevicesSection } from '../../renderer/pages/settings/sections/DevicesSection';
import { RoomDocumentsEditor } from '../../renderer/pages/rooms/RoomDocumentsEditor';
import { ServerGroupReadiness } from '../../renderer/pages/rooms/ServerGroupReadiness';
import { CreateTorrentPage } from '../../renderer/pages/CreateTorrentPage';
import { SERVER_PREPARATION_CAPABILITY as CAP, ServerPreparationBook } from '../../shared/server-readiness';
import type { RoomServerInstance, RoomState } from '../../shared/types';
import type { DeviceUiState } from '../../shared/device-ui';
import '../../renderer/index.css';
import '../../renderer/pages/RoomsPage.css';
import '../../renderer/pages/SettingsPage.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
localStorage.setItem('language', 'ru'); document.documentElement.dataset.theme = 'dark';
const self = 'a'.repeat(32), owner = 'b'.repeat(32);
const f = {
  mode: 'screen', holdCreate: false, releaseCreate: null as null | (() => void), picks: [] as unknown[], copied: '', invitation: JSON.stringify({ fixture: 'local-invitation', secret: '1'.repeat(64) }), expiresAt: Date.now() + 600000,
  created: [] as unknown[], requests: [] as unknown[], policies: [] as unknown[], preparations: [] as unknown[], doc: new Y.Doc(), version: 1, reader: false, closed: 0,
  access: { supported: true, nextRequestAt: 0, own: null as unknown, pending: [] as unknown[] },
};
f.doc.getText('text').insert(0, '# Заметка комнаты\nТекст документа.');
const encoded = () => btoa(String.fromCharCode(...Y.encodeStateAsUpdate(f.doc)));
const docView = () => ({ documentId: 'note', title: 'Заметка комнаты', language: 'markdown', archived: false, writable: !f.reader, seq: f.version, pending: 0, updatedAt: 1,
  token: 'token', policyId: 'c'.repeat(64), state: encoded(), version: f.version, selfId: self, ownerId: f.reader ? owner : self, ownerOnline: true, writers: f.reader ? [owner] : [self], cursors: [], localDraft: false, blockedPending: false, access: structuredClone(f.access) });
const members = [{ memberId: self, name: 'Вы', capable: true, online: true }, { memberId: owner, name: 'Участник', capable: true, online: true }];
const book = new ServerPreparationBook();
const server: RoomServerInstance = { instanceId: 'test-server', hostId: owner, moduleId: 'minecraft', name: 'Вечерняя игра', version: 'Fabric 1.21', role: 'viewer', isHost: false, status: 'running', since: 1, autoRestart: false, updatable: false, sharedContent: [], address: '100.88.0.1:25565' };
const room = { roomId: 'room', files: [], transfers: {}, members: [{ memberId: self, name: 'Вы', isSelf: true, online: true }, { memberId: owner, name: 'Владелец сервера', online: true, capabilities: [CAP] }, { memberId: 'legacy', name: 'Старая версия', online: true }], lan: { active: true, available: true, isHost: false, selfVip: '100.88.0.2', participants: [{ memberId: owner, admitted: true, status: 'connected', vip: '100.88.0.1' }] }, serverPreparation: [] } as unknown as RoomState;
let deviceChanged = () => {};
const deviceState: DeviceUiState = { enabled: true, status: 'online', error: null, self, peer: owner, grant: 'grant', scopes: ['preferences'], approved: true,
  config: { version: 1, enabled: true, listen: { host: '127.0.0.1', port: 41997 }, remote: null, scopes: ['preferences', 'views'], categories: {} }, addresses: [], confirmation: null,
  outbox: 2, pending: 0, conflicts: 1, recovering: false, records: [], inventory: { preferences: 1, views: 0, playback: 0 }, localRecords: [], issues: [], snapshotOffer: null, lastApplied: null };
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { f.copied = text; } } });
Object.defineProperty(window, 'api', { value: {
  setLanguage() {}, getCategories: async () => [], getDefaultTrackers: async () => [], onCreateTorrentProgress: () => () => {},
  devices: { state: async () => structuredClone(deviceState), changed: (cb: () => void) => { deviceChanged = cb; return () => {}; } },
  rooms: {
    screen: { sources: async () => [{ id: 'screen:fixture', name: 'Тестовый экран', display: true, systemAudioSupported: true }] },
    documents: {
      view: async () => ({ enabled: true, selfId: self, ownerId: f.reader ? owner : self, canCreate: !f.reader, ownerOnline: true, members, items: [docView()] }),
      open: async () => docView(), poll: async () => docView(), close: async () => {}, presence: async () => {}, history: async () => [],
      create: async (...args: unknown[]) => { f.created.push(args); if (f.holdCreate) await new Promise<void>(resolve => { f.releaseCreate = resolve; }); f.doc.getText('text').delete(0, f.doc.getText('text').length); f.doc.getText('text').insert(0, String(args[3])); f.version++; return { documentId: 'note' }; },
      requestAccess: async (...args: unknown[]) => { f.requests.push(args); f.access.own = { status: 'sent', at: Date.now() }; f.version++; },
      policy: async (...args: unknown[]) => { f.policies.push(args); f.access.pending = []; f.version++; },
      update: async (_r: string, _t: string, update: string) => { Y.applyUpdate(f.doc, Uint8Array.from(atob(update), c => c.charCodeAt(0))); f.version++; return docView(); },
    },
    servers: { preparation: async (_room: string, input: any) => { f.preparations.push(structuredClone(input)); book.accept({ ...input, memberId: self, at: Date.now() }, input.basis); room.serverPreparation = book.list(); (f as any).repaint(); return { ok: true }; } },
  },
} });
function Surface() {
  const [mode, setMode] = useState('screen'), [revision, setRevision] = useState(0), [confirmed, setConfirmed] = useState(false);
  const { setLanguage } = useTranslation();
  Object.assign(f, { mount: (next: string) => { f.mode = next; setMode(next); setRevision(n => n + 1); }, repaint: () => setRevision(n => n + 1), language: setLanguage, server, room, deviceState,
    deviceChanged: () => deviceChanged(), confirmReady: setConfirmed, templateText: () => f.doc.getText('text').toString() });
  return <div style={{ height: '100vh', padding: mode === 'documents' || mode === 'reader' ? 0 : 24, overflow: 'auto' }} data-fixture-mode={mode}>
    {mode === 'screen' && <ScreenSourcePicker key={revision} onClose={() => { f.closed++; }} onPick={(...args) => f.picks.push(args)} bitrateLimitKbps={2500} />}
    {mode === 'invitation' && <div style={{ maxWidth: 750 }}><h2>Приглашение устройства</h2><DeviceInvitation text={f.invitation} expiresAt={f.expiresAt} /></div>}
    {mode === 'devices' && <DevicesSection />}
    {(mode === 'documents' || mode === 'reader') && <RoomDocumentsEditor key={mode} roomId="room" onClose={() => { f.closed++; }} initialDocumentId={mode === 'reader' ? 'note' : undefined} />}
    {mode === 'group' && <div style={{ maxWidth: 700 }}><h2>{server.name}</h2><ServerGroupReadiness instance={server} room={room} confirmed={confirmed} /></div>}
    {mode === 'create' && <CreateTorrentPage />}
  </div>;
}
Object.assign(window, { fixture: f });
createRoot(document.getElementById('root')!).render(<I18nProvider><ConfirmProvider><Surface /></ConfirmProvider></I18nProvider>);
