import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Store from 'electron-store';
import { encryptSecret, decryptSecretStrict } from './secrets';
import { assertSyncPlainPath } from '../sharing/room-sync-snapshot';
import { DOCUMENT_LIMIT, DOCUMENT_UUID, DOCUMENT_HASH, DOCUMENT_MEMBER, type DocumentCheckpoint, type DocumentCommit, type DocumentProposal, type DocumentLocalSnapshot } from '../../shared/room-documents';
export const DOCUMENT_STORE_BYTES = 16 * 1024 * 1024;
export interface DocumentContext { scope: string; ownerId: string; e2e: boolean; authority?: string; secret?: string; protocol?: 2 }
export interface DocumentRecoverySource { key: string; context: DocumentContext; persistence: DocumentsPersistence }
export interface StoredDocument {
  v: 1; scope: string; ownerId: string; checkpoint: DocumentCheckpoint; commits: DocumentCommit[]; state: string; working: string; text: string;
  pending: Array<{ proposal: DocumentProposal; rejected?: string }>; snapshots: DocumentLocalSnapshot[]; updatedAt: number;
  /** Old proofs remain bound to their original context until the new owner signs a checkpoint. */
  recovery?: { key: string; scope: string; ownerId: string };
  migratedFrom?: string;
  draftReview?: boolean;
}
export interface DocumentsPersistence { list(): string[]; read(id: string): unknown; write(id: string, value: StoredDocument): void }
export const documentContextKey = (roomId: string, context: DocumentContext): string => crypto.createHash('sha256').update(JSON.stringify([roomId, context])).digest('hex');
/** A return transfer must not make a previous owner's old signatures current again. */
export const documentContextScope = (context: DocumentContext): string => context.protocol === 2
  ? crypto.createHash('sha256').update(JSON.stringify(['havvn-doc-context-v2', context.scope, context.ownerId, context.e2e, context.authority ?? null, context.secret ?? null])).digest('hex') : context.scope;
/** Persist the source pointers before opening the destination. Old encrypted stores are never removed. */
export function rememberDocumentContext(userData: string, roomId: string, context: DocumentContext): { directory: string; sources: DocumentRecoverySource[] } {
  if (!DOCUMENT_UUID.test(roomId)) throw new Error('Invalid documents room');
  // Signed room scope is the historical 20-byte topicHash, not a SHA-256 record ID.
  const valid = (c: DocumentContext) => !!c && /^[a-f0-9]{40}$/.test(c.scope) && DOCUMENT_MEMBER.test(c.ownerId) && typeof c.e2e === 'boolean'
    && (c.protocol === undefined || c.protocol === 2)
    && (c.authority === undefined || DOCUMENT_HASH.test(c.authority)) && (c.secret === undefined || DOCUMENT_HASH.test(c.secret));
  if (!valid(context)) throw new Error('Invalid documents context');
  const directory = path.join(userData, 'room-document-contexts'); assertSyncPlainPath(directory);
  const name = 'room-' + crypto.createHash('sha256').update(roomId).digest('hex');
  const indexPath = path.join(directory, name + '.json'); assertSyncPlainPath(indexPath);
  if (fs.existsSync(indexPath)) { const stat = fs.lstatSync(indexPath); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new Error('Invalid document recovery index'); }
  const store = new Store<{ contexts: string }>({ cwd: directory, name, clearInvalidConfig: false });
  const sealed = store.get('contexts');
  if (sealed !== undefined && (typeof sealed !== 'string' || sealed.length > 256 * 1024)) throw new Error('Invalid protected document recovery index');
  const contexts = sealed === undefined ? [] : JSON.parse(decryptSecretStrict(sealed)) as DocumentContext[];
  if (!Array.isArray(contexts) || contexts.length > 256 || contexts.some(c => !valid(c)) || new Set(contexts.map(c => documentContextKey(roomId, c))).size !== contexts.length) throw new Error('Invalid document recovery contexts');
  // Upgrade an existing installation: its original store used only this three-field context.
  const legacy: DocumentContext = { scope: context.scope, ownerId: context.ownerId, e2e: context.e2e };
  const legacyDirectory = path.join(userData, 'room-documents', documentContextKey(roomId, legacy));
  if (!contexts.length && documentContextKey(roomId, legacy) !== documentContextKey(roomId, context) && fs.existsSync(legacyDirectory)) contexts.push(legacy);
  const key = documentContextKey(roomId, context), previous = contexts.filter(c => documentContextKey(roomId, c) !== key);
  if (contexts.at(-1) && documentContextKey(roomId, contexts.at(-1)!) !== key || !contexts.length) {
    if (previous.length >= 256) throw new Error('Document recovery context capacity reached');
    store.set('contexts', encryptSecret(JSON.stringify([...previous, context]), false));
  }
  return { directory: path.join(userData, 'room-documents', key), sources: previous.reverse().map(c => {
    const sourceKey = documentContextKey(roomId, c);
    return { key: sourceKey, context: c, persistence: openDocumentsPersistence(path.join(userData, 'room-documents', sourceKey)) };
  }) };
}
export function openDocumentsPersistence(directory: string): DocumentsPersistence {
  const stores = new Map<string, Store<{ document: string }>>();
  const backend = (id: string) => {
    if (!DOCUMENT_UUID.test(id)) throw new Error('Invalid document ID');
    let store = stores.get(id);
    if (!store) { assertSyncPlainPath(directory); store = new Store({ cwd: directory, name: 'document-' + id, clearInvalidConfig: false }); stores.set(id, store); }
    return store;
  };
  return {
    list: () => {
      assertSyncPlainPath(directory);
      let names: string[]; try { names = fs.readdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      if (names.length > DOCUMENT_LIMIT) throw new Error('Document catalog capacity reached');
      return names.map(name => {
        const id = name.startsWith('document-') && name.endsWith('.json') ? name.slice(9, -5) : '';
        if (!DOCUMENT_UUID.test(id)) throw new Error('Unknown document storage file');
        assertSyncPlainPath(path.join(directory, name)); const stat = fs.lstatSync(path.join(directory, name));
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > DOCUMENT_STORE_BYTES * 3) throw new Error('Invalid document storage file'); return id;
      });
    },
    read: id => {
      const store = backend(id); if (!store.has('document')) return undefined;
      const sealed = store.get('document'); if (typeof sealed !== 'string' || sealed.length > DOCUMENT_STORE_BYTES * 3) throw new Error('Invalid protected document');
      const plain = decryptSecretStrict(sealed); if (Buffer.byteLength(plain) > DOCUMENT_STORE_BYTES) throw new Error('Document storage capacity reached'); return JSON.parse(plain);
    },
    write: (id, value) => {
      const plain = JSON.stringify(value); if (Buffer.byteLength(plain) > DOCUMENT_STORE_BYTES) throw new Error('Document storage capacity reached');
      backend(id).set('document', encryptSecret(plain, false));
    },
  };
}
