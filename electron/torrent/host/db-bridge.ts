/**
 * db-bridge — runs in the torrent-host process. Drop-in replacement for
 * `import * as db from '../db/store'`: each function forwards to the MAIN process
 * (which owns electron-store) and awaits the answer. Keeps the store single-owner
 * (no dual-writer corruption) while the engine lives in the utilityProcess.
 *
 * Type-safety: each export is typed as the real store function via
 * `typeof import('../db/store')`, so call sites in the manager are unchanged and
 * fully checked — without importing the store's runtime (which needs Electron app).
 */

import { DbRequest, DbBridgeFn } from './protocol';

type DB = typeof import('../../db/store.js');

let send: ((msg: DbRequest) => void) | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** Install the channel used to reach main (called once by the host on startup). */
export function wireDbBridge(sender: (msg: DbRequest) => void): void {
  send = sender;
}

/** Feed a db-res message back from main into the pending promise. */
export function resolveDbResponse(id: number, ok: boolean, result?: unknown, error?: string): void {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (ok) p.resolve(result);
  else p.reject(new Error(error || 'db bridge error'));
}

/** Reject everything in flight (e.g. on shutdown) so callers don't hang. */
export function failAllDbRequests(message: string): void {
  for (const [, p] of pending) p.reject(new Error(message));
  pending.clear();
}

function call(fn: string, args: unknown[]): Promise<unknown> {
  if (!send) return Promise.reject(new Error('db bridge not wired'));
  const id = ++seq;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send!({ kind: 'db', id, fn, args });
  });
}

function bridged<K extends DbBridgeFn>(fn: K): DB[K] {
  return ((...args: unknown[]) => call(fn, args)) as unknown as DB[K];
}

export const createDownload = bridged('createDownload');
export const deleteDownload = bridged('deleteDownload');
export const getAllDownloads = bridged('getAllDownloads');
export const getDownloadById = bridged('getDownloadById');
export const getDownloadsByStatus = bridged('getDownloadsByStatus');
export const getPrivacyConfig = bridged('getPrivacyConfig');
export const getSettings = bridged('getSettings');
export const updateDownloadField = bridged('updateDownloadField');
export const updateDownloadFields = bridged('updateDownloadFields');
export const updateDownloadProgress = bridged('updateDownloadProgress');
export const updateDownloadStatus = bridged('updateDownloadStatus');
export const updateDownloadsProgressBatch = bridged('updateDownloadsProgressBatch');
export const updateSettings = bridged('updateSettings');
