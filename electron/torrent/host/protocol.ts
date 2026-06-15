/**
 * Message protocol between the main process and the torrent-host utilityProcess.
 *
 * Directions:
 *   main → host : init, rpc (call a manager method), db-res (answer a db request)
 *   host → main : ready, rpc-res (method result), db (request a db op), event
 *
 * Only control/metadata/stats cross this boundary — never file bytes (those go
 * over local HTTP from the host's stream/cast servers, or via shared disk).
 */

import type { HostEnv } from './env';

// ── main → host ──────────────────────────────────────────────────────────────
export interface InitMsg {
  kind: 'init';
  env: HostEnv;
}
export interface RpcRequest {
  kind: 'rpc';
  id: number;
  method: string;
  args: unknown[];
}
export interface DbResponse {
  kind: 'db-res';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ── host → main ──────────────────────────────────────────────────────────────
export interface ReadyMsg {
  kind: 'ready';
}
export interface RpcResponse {
  kind: 'rpc-res';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}
export interface DbRequest {
  kind: 'db';
  id: number;
  fn: string;
  args: unknown[];
}
export interface EventMsg {
  kind: 'event';
  event: 'stats' | 'complete' | 'state' | 'create-progress';
  payload: unknown;
}

export type ToHost = InitMsg | RpcRequest | DbResponse;
export type FromHost = ReadyMsg | RpcResponse | DbRequest | EventMsg;

/** The db.* functions the engine calls — bridged from the host back to main. */
export const DB_BRIDGE_FNS = [
  'createDownload',
  'deleteDownload',
  'getAllDownloads',
  'getDownloadById',
  'getDownloadsByStatus',
  'getSettings',
  'updateDownloadField',
  'updateDownloadFields',
  'updateDownloadProgress',
  'updateDownloadStatus',
  'updateDownloadsProgressBatch',
  'updateSettings',
] as const;
export type DbBridgeFn = (typeof DB_BRIDGE_FNS)[number];
