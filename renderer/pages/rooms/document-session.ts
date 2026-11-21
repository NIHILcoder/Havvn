import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import type { DocumentCursor } from '../../../shared/room-documents';

export const documentBytes = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export const documentBase64 = (value: Uint8Array) => {
  let binary = ''; for (let offset = 0; offset < value.length; offset += 16384) binary += String.fromCharCode(...value.subarray(offset, offset + 16384)); return btoa(binary);
};
/** Presence IDs belong to authenticated member/session pairs, never a peer's claimed Yjs client ID. */
export class DocumentAwareness {
  private ids = new Map<string, number>();
  constructor(readonly awareness: Awareness, private readonly text: Y.Text) {}
  apply(cursors: DocumentCursor[]): void {
    const active = new Set<number>();
    for (const cursor of cursors) {
      try {
        if (!cursor.anchor || !cursor.head) continue;
        const anchor = Y.decodeRelativePosition(documentBytes(cursor.anchor)), head = Y.decodeRelativePosition(documentBytes(cursor.head));
        const a = Y.createAbsolutePositionFromRelativePosition(anchor, this.text.doc!), h = Y.createAbsolutePositionFromRelativePosition(head, this.text.doc!);
        if (!a || !h || a.type !== this.text || h.type !== this.text) continue;
        const key = cursor.memberId + ':' + cursor.sessionId;
        let id = this.ids.get(key);
        if (id === undefined) {
          id = 2166136261; for (const character of key) id = Math.imul(id ^ character.charCodeAt(0), 16777619) >>> 0;
          while (id === this.awareness.clientID || [...this.ids.values()].includes(id)) id = (id + 1) >>> 0;
          this.ids.set(key, id);
        }
        active.add(id);
        const encoded = encoding.createEncoder(); encoding.writeVarUint(encoded, 1); encoding.writeVarUint(encoded, id);
        encoding.writeVarUint(encoded, (this.awareness.meta.get(id)?.clock ?? 0) + 1);
        // The stable CodeMirror binding consumes full RelativePosition fields directly.
        // relativePositionToJSON omits null/default fields, which breaks end-of-text cursors.
        encoding.writeVarString(encoded, JSON.stringify({ user: { name: cursor.name, color: cursor.color, colorLight: cursor.color + '30' }, cursor: { anchor, head } }));
        applyAwarenessUpdate(this.awareness, encoding.toUint8Array(encoded), 'remote');
      } catch { /* Invalid/obsolete cursors never affect text or the local client. */ }
    }
    const removed = [...this.ids.entries()].filter(([, id]) => !active.has(id));
    removeAwarenessStates(this.awareness, removed.map(([, id]) => id), 'remote');
    for (const [key, id] of removed) { this.ids.delete(key); this.awareness.meta.delete(id); }
  }
}
