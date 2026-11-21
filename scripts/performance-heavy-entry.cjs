/* eslint-disable @typescript-eslint/no-require-imports -- Isolated compiled UI fixture. */
const scenario = window.__heavyInput;
let openDocument = null, token = 0;
const summary = { documentId: 'document', title: 'Measured document.md', language: 'markdown', archived: false, writable: true, seq: 0, pending: 0, updatedAt: 0 };
window.__heavySessions = { opened: 0, closed: 0, active: 0 };
window.__perfOverrides = {
  'rooms.fileSync.state': () => ({ enabled: true, canCreate: true, roots: [] }),
  'rooms.documents.view': () => ({ enabled: true, selfId: 'self', ownerId: 'self', canCreate: true, ownerOnline: true, members: [{ memberId: 'self', name: 'Self', capable: true, online: true }], items: [summary] }),
  'rooms.documents.open': () => {
    window.__heavySessions.opened++; window.__heavySessions.active++;
    return openDocument = { ...summary, token: 'token-' + ++token, policyId: 'policy', state: scenario.document, version: 0, selfId: 'self', ownerId: 'self', ownerOnline: true, writers: ['self'], cursors: [], localDraft: false, blockedPending: false };
  },
  'rooms.documents.poll': () => openDocument,
  'rooms.documents.close': () => { window.__heavySessions.closed++; window.__heavySessions.active--; },
  'rooms.documents.presence': () => {},
};
window.__perfBaseline = { downloads: 100, files: 1000, messages: 200, history: 0, capabilities: ['file-sync-v1'] };
require('./performance-renderer-entry.cjs');
window.perfNavigate = page => document.querySelector('.pillar-btn:' + (page === 'rooms' ? 'last' : 'first') + '-child').click();
