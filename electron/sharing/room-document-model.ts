import * as Y from 'yjs';
import { DOCUMENT_STATE_BYTES, DOCUMENT_UPDATE_BYTES, documentBase64, validDocumentText } from '../../shared/room-documents';
export interface DocumentValidation { state?: string; updates: string[]; replace?: string; merge?: boolean }
export interface MaterializedDocument { state: string; text: string; changed: boolean; delta?: string; combined?: string }
/** Runs in a bounded worker for all untrusted network updates. */
export function materializeDocument(input: DocumentValidation): MaterializedDocument {
  if (!input || !Array.isArray(input.updates) || input.updates.length > 129 || input.state !== undefined && !documentBase64(input.state, DOCUMENT_STATE_BYTES)
    || input.updates.some(u => !documentBase64(u, DOCUMENT_UPDATE_BYTES)) || input.replace !== undefined && !validDocumentText(input.replace)) throw new Error('Invalid document update');
  const doc = new Y.Doc(), text = doc.getText('text');
  try {
    if (input.state) Y.applyUpdate(doc, Buffer.from(input.state, 'base64'));
    const before = Y.encodeStateAsUpdate(doc);
    for (const update of input.updates) Y.applyUpdate(doc, Buffer.from(update, 'base64'));
    let delta: string | undefined;
    if (input.replace !== undefined) {
      const vector = Y.encodeStateVector(doc);
      doc.transact(() => { text.delete(0, text.length); text.insert(0, input.replace!); });
      delta = Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64');
      if (!documentBase64(delta, DOCUMENT_UPDATE_BYTES)) throw new Error('Document update limit reached');
    }
    if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('Document dependencies missing');
    if (doc.share.size !== 1 || !doc.share.has('text') || Object.keys(text.getAttributes()).length
      || text.toDelta().some((p: { insert?: unknown; attributes?: Record<string, unknown> }) => typeof p.insert !== 'string' || p.attributes && Object.keys(p.attributes).length)) throw new Error('Only plain text document updates are allowed');
    const body = text.toString(), state = Y.encodeStateAsUpdate(doc);
    if (!validDocumentText(body) || state.byteLength > DOCUMENT_STATE_BYTES) throw new Error('Document capacity reached');
    const combined = input.merge ? Buffer.from(Y.mergeUpdates(input.updates.map(update => Buffer.from(update, 'base64')))).toString('base64') : undefined;
    return { state: Buffer.from(state).toString('base64'), text: body, changed: !Buffer.from(before).equals(state), ...(delta ? { delta } : {}),
      ...(combined && documentBase64(combined, DOCUMENT_UPDATE_BYTES) ? { combined } : {}) };
  } finally { doc.destroy(); }
}
