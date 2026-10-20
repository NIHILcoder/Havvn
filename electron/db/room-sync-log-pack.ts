/** Lossless local log packing. Never a network checkpoint or permission to forget ancestry. */
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { SYNC_HASH, SYNC_POLICY_LIMIT, SYNC_REVISION_LIMIT, type SyncRecord } from '../../shared/room-file-sync';

export const SYNC_LOG_DECODE_BYTES = 16 * 1024 * 1024;
export interface SyncLogPack { v: 1; codec: 'gzip'; records: number; bytes: number; digest: string; data: string }
const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

export function packSyncLog(records: SyncRecord[]): SyncLogPack {
  if (!records.length || records.length > SYNC_POLICY_LIMIT + SYNC_REVISION_LIMIT) throw new Error('Invalid sync archive record count');
  const raw = Buffer.from(JSON.stringify(records));
  if (raw.length > SYNC_LOG_DECODE_BYTES) throw new Error('Sync archive decoded capacity reached');
  return { v: 1, codec: 'gzip', records: records.length, bytes: raw.length, digest: digest(raw), data: gzipSync(raw, { level: 6 }).toString('base64') };
}

/** Bounded decode is followed by the normal signature/causal replay in RoomSyncStore. */
export function unpackSyncLog(value: unknown): SyncRecord[] {
  const p = value as SyncLogPack;
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.v !== 1 || p.codec !== 'gzip'
    || !Number.isSafeInteger(p.records) || p.records < 1 || p.records > SYNC_POLICY_LIMIT + SYNC_REVISION_LIMIT
    || !Number.isSafeInteger(p.bytes) || p.bytes < 2 || p.bytes > SYNC_LOG_DECODE_BYTES
    || typeof p.digest !== 'string' || !SYNC_HASH.test(p.digest) || typeof p.data !== 'string' || !p.data.length
    || p.data.length > SYNC_LOG_DECODE_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.data)) throw new Error('Invalid sync log archive');
  const compressed = Buffer.from(p.data, 'base64');
  if (compressed.toString('base64') !== p.data) throw new Error('Invalid sync archive encoding');
  const raw = gunzipSync(compressed, { maxOutputLength: p.bytes });
  if (raw.length !== p.bytes || digest(raw) !== p.digest) throw new Error('Sync archive integrity mismatch');
  const records: unknown = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(records) || records.length !== p.records || !raw.equals(Buffer.from(JSON.stringify(records)))) throw new Error('Invalid sync archive contents');
  return records as SyncRecord[];
}
