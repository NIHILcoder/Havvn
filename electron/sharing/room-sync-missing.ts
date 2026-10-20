/** A complete scan can suggest a deletion, but cannot authorize one. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertSyncPlainPath } from './room-sync-snapshot';
import type { RoomSyncStore } from '../db/room-sync-store';
import { canWriteSync } from '../../shared/room-file-sync';
import type { SyncMissingView } from '../../shared/room-file-sync-ui';
import { excludedSyncPath, type SyncScan } from './room-sync-watcher';

const key = (value: string) => value.normalize('NFC').toLowerCase();
export const SYNC_MISSING_SETTLE_MS = 3000;
export class RoomSyncMissing {
  private identity?: string;
  private binding = '';
  private folder?: string;
  private absent = new Map<string, { stamp: string; since: number }>();
  private view: SyncMissingView;
  constructor(private readonly rootId: string, private readonly store: RoomSyncStore, private readonly self: string, private readonly now = Date.now) {
    this.view = this.empty('unavailable');
  }
  private empty(blocked: SyncMissingView['blocked'] = null): SyncMissingView {
    return { rootId: this.rootId, stamp: '', waiting: 0, mass: false, blocked, items: [] };
  }
  stateStamp(): string {
    return JSON.stringify([this.store.bindingEpoch(), this.store.binding()?.path, this.store.policy()?.policyId,
      this.store.exclusions(), this.store.heads(), this.store.applied(), this.store.deferred()]);
  }
  read(): SyncMissingView { return structuredClone(this.view); }
  diskGuard(relativePath: string): () => boolean {
    const folder = this.store.binding()?.path, identity = this.identity;
    if (!folder || !identity) throw new Error('Sync missing files changed; review again');
    const parents = [folder], parts = relativePath.split('/'); parts.pop();
    parts.forEach((_part, index) => parents.push(path.join(folder, ...parts.slice(0, index + 1))));
    const identities = () => parents.map(parent => {
      assertSyncPlainPath(parent); const stat = fs.lstatSync(parent, { bigint: true });
      if (!stat.isDirectory()) throw new Error('Missing sync directory');
      return [stat.dev, stat.ino, stat.birthtimeNs].join(':');
    });
    const expected = identities();
    if (expected[0] !== identity) throw new Error('Sync missing files changed; review again');
    return () => {
      try {
        if (JSON.stringify(identities()) !== JSON.stringify(expected)) return false;
        const target = path.join(folder, ...relativePath.split('/')); assertSyncPlainPath(target);
        try { fs.lstatSync(target); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
      } catch { return false; }
    };
  }
  update(scan: SyncScan | null): SyncMissingView {
    const binding = JSON.stringify([this.store.bindingEpoch(), this.store.binding()?.path]);
    if (binding !== this.binding) { this.binding = binding; this.absent.clear(); }
    const folder = this.store.binding()?.path;
    if (folder !== this.folder) { this.folder = folder; this.identity = undefined; }
    const fail = (reason: SyncMissingView['blocked']) => { this.absent.clear(); this.view = this.empty(reason); return this.read(); };
    const policy = this.store.policy();
    if (!this.store.binding() || !policy || policy.v < 6 || !policy.allowDeletes || !canWriteSync(policy, this.self)) return fail(null);
    if (!scan) return fail('unavailable');
    this.identity ??= scan.rootIdentity;
    if (this.identity !== scan.rootIdentity) return fail('changed');
    if (!scan.complete) return fail('incomplete');
    const occupied = new Set(scan.occupied.map(key)), directories = new Set(scan.directories.map(key));
    const applied = new Map(this.store.applied().map(a => [a.entryId, a])), deferred = new Set(this.store.deferred());
    const conflicts = new Set(this.store.pathConflicts().flatMap(c => c.entryIds)), candidates: SyncMissingView['items'] = [];
    let tracked = 0, missingDirectory = false;
    for (const head of this.store.heads()) {
      if (head.revisionIds.length !== 1 || conflicts.has(head.entryId) || deferred.has(head.entryId)) continue;
      const revision = this.store.revision(head.revisionIds[0])!, base = applied.get(head.entryId);
      if (revision.op !== 'put' || base?.revisionId !== revision.revisionId || !base.digest || excludedSyncPath(revision.relativePath, this.store.exclusions())) continue;
      tracked++;
      if (occupied.has(key(revision.relativePath))) continue;
      const parts = revision.relativePath.split('/'); parts.pop();
      if (parts.some((_part, index) => !directories.has(key(parts.slice(0, index + 1).join('/'))))) { missingDirectory = true; continue; }
      candidates.push({ entryId: head.entryId, revisionId: revision.revisionId, path: revision.relativePath, size: revision.blob!.size });
    }
    if (missingDirectory) return fail('directory');
    if (candidates.length && !scan.files.length) return fail('all');
    const now = this.now(), presentIds = new Set(candidates.map(c => c.entryId)), ready: SyncMissingView['items'] = [];
    for (const id of this.absent.keys()) if (!presentIds.has(id)) this.absent.delete(id);
    const state = crypto.createHash('sha256').update(this.stateStamp()).digest('hex');
    for (const row of candidates) {
      const stamp = JSON.stringify([state, row]), previous = this.absent.get(row.entryId);
      if (!previous || previous.stamp !== stamp) this.absent.set(row.entryId, { stamp, since: now });
      else if (now - previous.since >= SYNC_MISSING_SETTLE_MS) ready.push(row);
    }
    ready.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    this.view = { rootId: this.rootId, items: ready, waiting: candidates.length - ready.length, blocked: null,
      mass: candidates.length >= 5 || candidates.length >= 2 && candidates.length / Math.max(1, tracked) >= 0.25,
      stamp: crypto.createHash('sha256').update(JSON.stringify([state, scan.rootIdentity, scan.fingerprint, candidates])).digest('hex') };
    return this.read();
  }
}
