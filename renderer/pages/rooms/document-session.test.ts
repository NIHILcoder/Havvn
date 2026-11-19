import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { DocumentAwareness, documentBase64, documentBytes } from './document-session';
import type { DocumentCursor } from '../../../shared/room-documents';
it('round-trips large byte arrays without exhausting the JS argument stack', () => {
  const bytes = Uint8Array.from({ length: 256000 }, (_, i) => i % 256); expect(documentBytes(documentBase64(bytes))).toEqual(bytes);
});
it('binds remote cursor identity to authenticated sessions and preserves local awareness', () => {
  const doc = new Y.Doc(), text = doc.getText('text'); text.insert(0, 'hello'); const awareness = new Awareness(doc), adapter = new DocumentAwareness(awareness, text);
  try {
    awareness.setLocalState({ user: { name: 'self' } });
    const position = documentBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 2)));
    const cursor: DocumentCursor = { documentId: 'id', policyId: 'policy', sessionId: 'session', clientId: doc.clientID, clock: 1, at: Date.now(), anchor: position, head: position, memberId: 'a'.repeat(32), name: 'Alice', color: '#58c7f3' };
    adapter.apply([cursor, { ...cursor, sessionId: 'second', name: 'Bob' }]);
    expect(awareness.getStates().size).toBe(3); expect(awareness.getLocalState()).toEqual({ user: { name: 'self' } });
    const remote = [...awareness.getStates().entries()].filter(([id]) => id !== doc.clientID); expect(remote.map(([, state]) => state.user.name).sort()).toEqual(['Alice', 'Bob']);
    for (const [, state] of remote) expect(Y.createAbsolutePositionFromRelativePosition(state.cursor.anchor, doc)?.index).toBe(2);
    const end = documentBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, text.length)));
    adapter.apply([{ ...cursor, anchor: end, head: end }]);
    const endState = [...awareness.getStates().entries()].find(([id]) => id !== doc.clientID)![1];
    expect(Y.createAbsolutePositionFromRelativePosition(endState.cursor.anchor, doc)?.index).toBe(5);
    adapter.apply([{ ...cursor, anchor: 'AAAA' }]); expect(awareness.getStates().size).toBe(1); expect(awareness.meta.size).toBe(1);
    adapter.apply([cursor]); expect(awareness.getStates().size).toBe(2); adapter.apply([]); expect(awareness.getStates().size).toBe(1);
  } finally { awareness.destroy(); doc.destroy(); }
});
