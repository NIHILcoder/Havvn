import Store from 'electron-store';
import crypto from 'node:crypto';
import { encryptSecret, decryptSecretStrict } from './secrets';
import { FileSyncIndex, type SyncIndexContext } from '../../shared/room-file-sync';
import { SYNC_ROOT_LIMIT } from '../../shared/room-file-sync-protocol';
import { verifySyncProof } from '../sharing/room-sync-proofs';

/** Local discovery only. A catalog never carries paths or permissions to another peer. */
export class RoomSyncCatalog {
  private readonly store: Store<{ catalog: string }>;
  constructor(directory: string, private readonly roomId: string) {
    this.store = new Store({ cwd: directory, name: 'sync-roots-' + crypto.createHash('sha256').update(roomId).digest('hex'), clearInvalidConfig: false });
  }
  roots(): SyncIndexContext[] {
    if (!this.store.has('catalog')) return [];
    const payload = this.store.get('catalog');
    if (typeof payload !== 'string' || payload.length > 32 * 1024) throw new Error('Invalid sync catalog');
    const raw = JSON.parse(decryptSecretStrict(payload));
    if (!raw || raw.v !== 1 || raw.roomId !== this.roomId || !Array.isArray(raw.roots) || raw.roots.length > SYNC_ROOT_LIMIT) throw new Error('Invalid sync catalog');
    for (const context of raw.roots) new FileSyncIndex(context, verifySyncProof);
    if (new Set(raw.roots.map((c: SyncIndexContext) => c.rootId)).size !== raw.roots.length) throw new Error('Duplicate sync root');
    return raw.roots.map((c: SyncIndexContext) => ({ rootId: c.rootId, scope: c.scope, ownerId: c.ownerId, e2e: c.e2e }));
  }
  add(context: SyncIndexContext): void {
    new FileSyncIndex(context, verifySyncProof);
    const roots = this.roots(), existing = roots.find(c => c.rootId === context.rootId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify({ rootId: context.rootId, scope: context.scope, ownerId: context.ownerId, e2e: context.e2e })) throw new Error('Sync root context changed');
      return;
    }
    if (roots.length >= SYNC_ROOT_LIMIT) throw new Error('Sync room root limit reached');
    this.store.set('catalog', encryptSecret(JSON.stringify({ v: 1, roomId: this.roomId, roots: [...roots, {
      rootId: context.rootId, scope: context.scope, ownerId: context.ownerId, e2e: context.e2e,
    }] }), false));
  }
}
