import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Download, PersistedRoomFile } from '../../shared/types';
import type { StorageAction, StorageKind } from '../../shared/storage-overview';
import { safeStoragePath, type StorageCatalog, type StorageControl, type StorageLocation, type StorageRoot } from './storage-overview';

interface StorageRoom { roomId: string; name: string; folder: string; locked: boolean }
export interface StorageSourcesOptions {
  userData: string; sessionData: string;
  downloads(): Promise<Download[]>;
  rooms(): { rooms: StorageRoom[]; more: boolean };
  manifest(roomId: string): PersistedRoomFile[];
  decrypt(sealed: string): string;
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const fixedRoot = (candidate: string, kind: StorageKind, actions: StorageAction[] = [], key?: string): StorageRoot => ({
  path: candidate, key, kinds: [kind], locate: () => ({ kind, actions }),
});

/** Bounded reads of existing metadata only: no Store constructors or migrations. */
async function readIndex(candidate: string, control: StorageControl): Promise<unknown> {
  const limit = 1024 * 1024; control.check(); await safeStoragePath(candidate, control.signal, control.check);
  const handle = await fs.promises.open(candidate, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit) || before.nlink !== 1n) throw Error('metadata-limit');
    const bytes = Buffer.alloc(Number(before.size) + 1); let read = 0;
    while (read < bytes.length) { control.check(); const next = await handle.read(bytes, read, bytes.length - read, read); if (!next.bytesRead) break; read += next.bytesRead; }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || read !== Number(before.size)) throw Error('changed');
    return JSON.parse(bytes.subarray(0, read).toString('utf8'));
  } finally { await handle.close(); }
}

export function storageSources(options: StorageSourcesOptions): (control: StorageControl) => Promise<StorageCatalog> {
  return async control => {
    const roots: StorageRoot[] = [], issues: StorageCatalog['issues'] = [];
    const issue = (kind: StorageKind, reason: StorageCatalog['issues'][number]['issue']) => {
      if (!issues.some(item => item.kind === kind && item.issue === reason)) issues.push({ kind, issue: reason });
    };
    const addRoot = (root: StorageRoot) => {
      control.check();
      if (roots.length >= 1024) { root.kinds.forEach(kind => issue(kind, 'limit')); return; }
      roots.push(root);
    };
    let rooms: StorageRoom[] = [];
    try {
      const inventory = options.rooms(); rooms = inventory.rooms.slice(0, 128);
      if (inventory.more || inventory.rooms.length > 128) for (const kind of ['room-copies', 'originals', 'backups', 'trash'] as const) issue(kind, 'catalog');
    } catch { for (const kind of ['room-copies', 'originals', 'backups', 'trash'] as const) issue(kind, 'catalog'); }
    const byId = new Map(rooms.map(room => [room.roomId, room])), byDirectory = new Map(rooms.map(room => [hash(room.roomId).slice(0, 32), room]));
    const documentActions: StorageAction[] = rooms.filter(room => !room.locked && UUID.test(room.roomId)).flatMap(room => [
      { kind: 'documents' as const, roomId: room.roomId, label: room.name }, { kind: 'room-data' as const, roomId: room.roomId, label: room.name },
    ]);
    let indexes = 0;
    const appKinds: StorageKind[] = ['ciphertext', 'sync-cache', 'drafts', 'app-cache', 'protected', 'backups', 'trash'];
    const locate = (relative: string): StorageLocation => {
      const parts = relative.split('/'), first = parts[0].toLowerCase();
      if (['cache', 'code cache', 'gpucache', 'dawngraphitecache', 'dawnwebgpucache'].includes(first)) return { kind: 'app-cache', actions: [{ kind: 'cache' }] };
      if (first === 'room-enc') {
        const room = byId.get(parts[1]); return { kind: 'ciphertext', actions: room && !room.locked && UUID.test(room.roomId) ? [{ kind: 'room-data', roomId: room.roomId, label: room.name }] : [] };
      }
      if (first === 'room-file-sync' && ['bytes', 'transfers'].includes(parts[2])) {
        const room = byDirectory.get(parts[1]), rootId = UUID.test(parts[3] ?? '') ? parts[3] : undefined;
        return { kind: 'sync-cache', actions: room && !room.locked && UUID.test(room.roomId) ? [{ kind: 'sync', roomId: room.roomId, rootId, label: room.name, section: 'cache' }] : [] };
      }
      if (['room-documents', 'room-document-contexts'].includes(first)) return { kind: 'drafts', actions: documentActions };
      return { kind: 'protected' };
    };
    const affects = (relative: string): StorageKind[] => {
      if (!relative) return appKinds;
      if (relative.split('/')[0] === 'room-file-sync') return ['sync-cache', 'protected', 'backups', 'trash'];
      return [locate(relative).kind];
    };
    const appRoot: StorageRoot = { path: options.userData, kinds: appKinds, locate, affects,
      discover: async (file, relative, size, current) => {
        const parts = relative.split('/');
        if (parts.length !== 3 || parts[0] !== 'room-file-sync' || !/^room-sync-[a-f0-9]{64}\.json$/.test(parts[2])) return [];
        const failed = (reason: 'metadata-limit' | 'encrypted' | 'catalog' | 'changed') => { current.issue('backups', reason); current.issue('trash', reason); return []; };
        if (++indexes > 128 || size > 1024 * 1024) return failed('metadata-limit');
        try {
          const envelope = await readIndex(file, current) as { snapshot?: unknown };
          if (typeof envelope.snapshot !== 'string') return failed('catalog');
          const plain = options.decrypt(envelope.snapshot); current.check();
          if (Buffer.byteLength(plain) > 1024 * 1024) return failed('metadata-limit');
          const snapshot = JSON.parse(plain) as { context?: { localRoomId?: string; rootId?: string }; binding?: { path?: string }; trashExports?: Array<{ path?: string }> };
          const roomId = snapshot.context?.localRoomId, rootId = snapshot.context?.rootId;
          if (!roomId || !rootId || !UUID.test(roomId) || !UUID.test(rootId) || parts[1] !== hash(roomId).slice(0, 32)
            || parts[2] !== 'room-sync-' + hash(JSON.stringify([roomId, rootId])) + '.json') return failed('catalog');
          const room = byId.get(roomId), actions = (section: 'backups' | 'trash'): StorageAction[] => room && !room.locked ? [{ kind: 'sync', roomId, rootId, label: room.name, section }] : [];
          const found: StorageRoot[] = [];
          if (typeof snapshot.binding?.path === 'string' && path.isAbsolute(snapshot.binding.path)) {
            for (const [directory, kind] of [['transactions', 'backups'], ['trash', 'trash']] as const) {
              found.push({ path: path.join(snapshot.binding.path, '.havvn-sync', directory), key: roomId + rootId, kinds: [kind, 'protected'], locate: rel =>
                /(?:^|\/)previous(?:\.pruning)?$/.test(rel) ? { kind, actions: actions(kind) } : { kind: 'protected' } });
            }
          }
          for (const receipt of (snapshot.trashExports ?? []).slice(0, 128)) {
            if (typeof receipt.path === 'string' && path.isAbsolute(receipt.path)) found.push(fixedRoot(receipt.path, 'trash', actions('trash'), roomId + rootId));
          }
          if ((snapshot.trashExports?.length ?? 0) > 128) current.issue('trash', 'limit');
          return found;
        } catch (error) {
          current.check(); return failed(error instanceof Error && error.message === 'metadata-limit' ? 'metadata-limit' : 'encrypted');
        }
      } };
    addRoot(appRoot);
    if (path.resolve(options.sessionData) !== path.resolve(options.userData)) addRoot({ path: options.sessionData, kinds: appKinds, locate, affects });
    // Chat drafts share their protected file with history, identities and metadata.
    addRoot({ ...fixedRoot(path.join(options.userData, 'rooms.json'), 'drafts', documentActions), locate: () => ({ kind: 'drafts', actions: documentActions, mixedData: true }) });
    for (const room of rooms) {
      control.check();
      if (room.locked || typeof room.folder !== 'string' || !path.isAbsolute(room.folder)) { issue('room-copies', 'encrypted'); issue('originals', 'encrypted'); continue; }
      addRoot(fixedRoot(path.join(room.folder, '.havvn-files'), 'room-copies', UUID.test(room.roomId) ? [{ kind: 'room-data', roomId: room.roomId, label: room.name }] : [], room.roomId));
      if (roots.length >= 1024) { issue('originals', 'limit'); continue; }
      try {
        const manifest = options.manifest(room.roomId);
        for (const file of manifest.slice(0, 1024)) {
          control.check();
          if (roots.length >= 1024) { issue('originals', 'limit'); break; }
          if (file.localOriginal) {
            if (file.localPath && path.isAbsolute(file.localPath)) addRoot(fixedRoot(file.localPath, 'originals', [], room.roomId + ':' + file.fileId));
            else issue('originals', 'catalog');
          }
        }
        if (manifest.length > 1024) issue('originals', 'limit');
      } catch { control.check(); issue('originals', 'catalog'); }
    }
    try {
      const downloads = await options.downloads(); control.check();
      for (const download of downloads.slice(0, 2048)) {
        control.check();
        if (roots.length >= 1024) { issue('downloads', 'limit'); break; }
        if (download.seedPaths?.length) {
          for (const candidate of download.seedPaths.slice(0, 32)) {
            if (roots.length >= 1024) { issue('downloads', 'limit'); break; }
            if (path.isAbsolute(candidate)) addRoot(fixedRoot(candidate, 'downloads', [{ kind: 'downloads' }], download.id));
            else issue('downloads', 'catalog');
          }
          if (download.seedPaths.length > 32) issue('downloads', 'limit');
        } else if (path.isAbsolute(download.savePath) && download.name && path.basename(download.name) === download.name && !['.', '..'].includes(download.name)) {
          addRoot(fixedRoot(path.join(download.savePath, download.name), 'downloads', [{ kind: 'downloads' }], download.id));
        } else issue('downloads', 'catalog');
      }
      if (downloads.length > 2048) issue('downloads', 'limit');
    } catch { control.check(); issue('downloads', 'catalog'); }
    return { roots, issues };
  };
}
