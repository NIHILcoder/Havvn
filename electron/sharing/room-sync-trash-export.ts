/** Export never moves trash bytes. Only a verified external file can authorize later manual cleanup. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { SYNC_TRASH_EXPORT_LIMIT, type RoomSyncStore, type SyncTrashExportReceipt } from '../db/room-sync-store';
import { validSyncName } from '../../shared/room-file-sync';
import type { SyncTrashExportResult } from '../../shared/room-file-sync-ui';
import { assertSyncPlainPath, syncFileDigest } from './room-sync-snapshot';
import { withSyncApplyLock } from './room-sync-apply';
import { previewSyncTrash, syncTrashIdentity, syncTrashDirectoryIdentity, syncTrashContext, type SyncTrashPlan, type SyncTrashRetentionOptions } from './room-sync-trash-retention';

export function syncTrashExportCurrent(receipt: SyncTrashExportReceipt): boolean {
  try { assertSyncPlainPath(receipt.path); const s = fs.lstatSync(receipt.path); return s.isFile() && s.nlink === 1 && syncTrashIdentity(s) === receipt.identity; }
  catch { return false; }
}
export async function verifySyncTrashExport(receipt: SyncTrashExportReceipt): Promise<boolean> {
  if (!syncTrashExportCurrent(receipt)) return false;
  try { return await syncFileDigest(receipt.path) === receipt.digest && syncTrashExportCurrent(receipt); } catch { return false; }
}
export function assertTrashExportDestination(target: string, forbidden: string[]): void {
  if (!path.isAbsolute(target) || target.length > 4096 || !validSyncName(path.basename(target))) throw new Error('Invalid trash export destination');
  for (const root of forbidden) {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    if (!relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) throw new Error('Trash export destination is managed');
  }
  assertSyncPlainPath(target); if (!fs.lstatSync(path.dirname(target)).isDirectory()) throw new Error('Invalid trash export directory');
  if (fs.existsSync(target)) throw new Error('Trash export destination already exists');
}
export type SyncTrashExportStep = 'opened' | 'copied' | 'verified';
export async function exportSyncTrash(store: RoomSyncStore, plan: SyncTrashPlan, operationId: string, target: string, options: SyncTrashRetentionOptions,
  forbidden: string[], onStep?: (step: SyncTrashExportStep) => void | Promise<void>): Promise<SyncTrashExportResult> {
  assertTrashExportDestination(target, [...forbidden, plan.folder]);
  const previous = store.trashExports();
  if (previous.length >= SYNC_TRASH_EXPORT_LIMIT && !previous.some(r => r.folder === plan.folder && r.operationId === operationId)) throw new Error('Trash export receipt capacity reached');
  const fresh = await previewSyncTrash(store, plan.selected.map(c => c.operationId), options);
  if (fresh.fingerprint !== plan.fingerprint || fresh.context !== plan.context) throw new Error('Trash export changed; review again');
  const copy = fresh.exportable.find(p => p.operationId === operationId);
  if (!copy) throw new Error('Trash copy is not exportable');
  return withSyncApplyLock(plan.folder, async () => {
    const directory = path.join(plan.folder, '.havvn-sync', 'trash', copy.operationId), source = path.join(directory, 'previous');
    const parentIdentity = syncTrashDirectoryIdentity(path.dirname(target));
    const current = () => {
      if (!options.current() || store.bindingEpoch() !== plan.epoch || store.binding()?.path !== plan.folder
        || syncTrashDirectoryIdentity(plan.folder) !== plan.rootIdentity || syncTrashDirectoryIdentity(directory) !== copy.directoryIdentity
        || syncTrashDirectoryIdentity(path.dirname(target)) !== parentIdentity) throw new Error('Trash export changed; review again');
    };
    current(); if (syncTrashContext(store, options) !== plan.context) throw new Error('Trash export changed; review again');
    assertTrashExportDestination(target, [...forbidden, plan.folder]); assertSyncPlainPath(source);
    let input: FileHandle | undefined, output: FileHandle | undefined;
    try {
      input = await fs.promises.open(source, 'r');
      if (syncTrashIdentity(await input.stat()) !== copy.fileIdentity || syncTrashIdentity(await fs.promises.lstat(source)) !== copy.fileIdentity) throw new Error('Trash export changed; review again');
      output = await fs.promises.open(target, 'wx+', 0o600); await onStep?.('opened');
      const buffer = Buffer.alloc(64 * 1024), hash = crypto.createHash('sha256'); let position = 0;
      while (position < copy.size) {
        current(); const read = await input.read(buffer, 0, Math.min(buffer.length, copy.size - position), position);
        if (!read.bytesRead) throw new Error('Trash export changed; review again');
        hash.update(buffer.subarray(0, read.bytesRead));
        for (let written = 0; written < read.bytesRead;) {
          const result = await output.write(buffer, written, read.bytesRead - written, position + written);
          if (!result.bytesWritten) throw new Error('Trash export write failed'); written += result.bytesWritten;
        }
        position += read.bytesRead;
      }
      await onStep?.('copied');
      if (hash.digest('hex') !== copy.digest) throw new Error('Trash export changed; review again');
      await output.sync(); const identity = syncTrashIdentity(await output.stat());
      const verify = crypto.createHash('sha256');
      for (let offset = 0; offset < copy.size;) {
        current(); const read = await output.read(buffer, 0, Math.min(buffer.length, copy.size - offset), offset);
        if (!read.bytesRead) throw new Error('Trash export write failed'); verify.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead;
      }
      if (verify.digest('hex') !== copy.digest || (await output.stat()).size !== copy.size || syncTrashIdentity(await output.stat()) !== identity) throw new Error('Trash export write failed');
      await onStep?.('verified'); current(); assertSyncPlainPath(source); assertSyncPlainPath(target);
      if (syncTrashIdentity(await input.stat()) !== copy.fileIdentity || syncTrashIdentity(await fs.promises.lstat(source)) !== copy.fileIdentity
        || syncTrashIdentity(await fs.promises.lstat(target)) !== identity || syncTrashContext(store, options) !== plan.context) throw new Error('Trash export changed; review again');
      const receipt: SyncTrashExportReceipt = { operationId, folder: plan.folder, revisionId: copy.revisionId, digest: copy.digest, size: copy.size, path: target, identity };
      // Close first: successful completion must not rely on an unflushed or still-open file.
      await output.close(); output = undefined; await input.close(); input = undefined;
      current(); if (!syncTrashExportCurrent(receipt)) throw new Error('Trash export changed; review again');
      try { store.rememberTrashExport(receipt); } catch { throw new Error('Trash export receipt failed; saved file kept'); }
      return { path: target, bytes: copy.size, digest: copy.digest };
    } finally { await output?.close().catch(() => {}); await input?.close().catch(() => {}); }
    // On failure even a partial destination is retained. It is never a verified recovery copy.
  });
}
