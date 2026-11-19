import { SYNC_UUID, SYNC_HASH, SYNC_POLICY_LIMIT, SYNC_REVISION_LIMIT, validSyncPolicy, validSyncRevision,
  copySyncPolicy, copySyncRevision, type SyncRecord } from './room-file-sync';

export const FILE_SYNC_CAPABILITY = 'file-sync-v1';
export const FILE_SYNC_CAPABILITIES = ['file-sync-v1', 'file-sync-v2', 'file-sync-v3', 'file-sync-v4', 'file-sync-v5', 'file-sync-v6', 'file-sync-history-v1'] as const;
export type SyncWireVersion = 1 | 2 | 3 | 4 | 5 | 6;
export const syncFrameVersion = (t: string): SyncWireVersion => t === 'file-sync-v6' ? 6 : t === 'file-sync-v5' || t === 'file-sync-history-v1' ? 5 : t === 'file-sync-v4' ? 4 : t === 'file-sync-v3' ? 3 : t === 'file-sync-v2' ? 2 : 1;
export const SYNC_ROOT_LIMIT = 8;
export const SYNC_PAGE_RECORDS = 32;
export const SYNC_PAGE_BYTES = 96 * 1024;
export const SYNC_LOG_RECORDS = SYNC_POLICY_LIMIT + SYNC_REVISION_LIMIT;
export const SYNC_RECORD_BYTES = 8 * 1024 * 1024;
export const SYNC_RECORD_PART_BYTES = 48 * 1024;
export const SYNC_RECORD_STAGING_BYTES = 16 * 1024 * 1024;
export type SyncHistoryWireBody =
  | { kind: 'history-request'; rootId: string; streamId: string; checkpointId: string; archiveDigest: string; byteOffset: number }
  | { kind: 'history-part'; rootId: string; streamId: string; checkpointId: string; archiveDigest: string; digest: string; bytes: number; byteOffset: number; data: string }
  | { kind: 'history-missing'; rootId: string; streamId: string; checkpointId: string; archiveDigest: string };
export const syncHistoryBody = (body: { kind: string }): body is SyncHistoryWireBody => body.kind === 'history-request' || body.kind === 'history-part' || body.kind === 'history-missing';
export type SyncWireBody =
  | SyncHistoryWireBody
  | { kind: 'offer'; rootId: string; streamId: string; total: number }
  | { kind: 'request'; rootId: string; streamId: string; offset: number }
  | { kind: 'page'; rootId: string; streamId: string; offset: number; total: number; records: SyncRecord[] }
  | { kind: 'part-request'; rootId: string; streamId: string; offset: number; byteOffset: number; digest: string }
  | { kind: 'record-part'; rootId: string; streamId: string; offset: number; total: number; recordId: string; digest: string; bytes: number; byteOffset: number; data: string }
  | { kind: 'ack'; rootId: string; streamId: string; next: number }
  | { kind: 'blob-request'; rootId: string; streamId: string }
  | { kind: 'blob-metadata'; rootId: string; streamId: string; metadata: string };
export interface SyncWireMessage { t: typeof FILE_SYNC_CAPABILITIES[number]; memberId: string; to: string; body: SyncWireBody; pub: string; sig: string }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const offset = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= SYNC_LOG_RECORDS;
export const syncRecordId = (r: SyncRecord) => r.kind === 'policy' ? r.value.policyId : r.value.revisionId;
export function copySyncRecord(r: SyncRecord): SyncRecord {
  return r.kind === 'policy' ? { kind: 'policy', value: copySyncPolicy(r.value) } : { kind: 'revision', value: copySyncRevision(r.value) };
}
/** Preflight before signing a local cutover into durable storage. */
export function syncRecordFitsTransport(record: SyncRecord): boolean {
  return record.value.v >= 5 ? new TextEncoder().encode(JSON.stringify(record)).length <= SYNC_RECORD_BYTES
    : validSyncWireBody({ kind: 'page', rootId: record.value.rootId, streamId: syncRecordId(record), offset: 0, total: 1, records: [record] });
}
export function validSyncWireBody(v: unknown): v is SyncWireBody {
  if (!obj(v) || typeof v.rootId !== 'string' || !SYNC_UUID.test(v.rootId) || typeof v.streamId !== 'string' || !SYNC_HASH.test(v.streamId)) return false;
  if (v.kind === 'offer') return offset(v.total) && (v.total as number) > 0;
  if (v.kind === 'request') return offset(v.offset);
  if (v.kind === 'ack') return offset(v.next) && (v.next as number) > 0;
  if (v.kind === 'part-request') return offset(v.offset) && Number.isSafeInteger(v.byteOffset) && (v.byteOffset as number) > 0
    && (v.byteOffset as number) < SYNC_RECORD_BYTES && (v.byteOffset as number) % SYNC_RECORD_PART_BYTES === 0 && typeof v.digest === 'string' && SYNC_HASH.test(v.digest);
  const history = v.kind === 'history-request' || v.kind === 'history-part' || v.kind === 'history-missing';
  if (history && !(typeof v.checkpointId === 'string' && SYNC_HASH.test(v.checkpointId) && typeof v.archiveDigest === 'string' && SYNC_HASH.test(v.archiveDigest))) return false;
  if (v.kind === 'history-request') return Number.isSafeInteger(v.byteOffset) && (v.byteOffset as number) >= 0 && (v.byteOffset as number) < SYNC_RECORD_BYTES && (v.byteOffset as number) % SYNC_RECORD_PART_BYTES === 0;
  if (v.kind === 'history-missing') return true;
  if (v.kind === 'record-part' || v.kind === 'history-part') return (history || offset(v.offset) && offset(v.total) && (v.offset as number) < (v.total as number)
    && typeof v.recordId === 'string' && SYNC_HASH.test(v.recordId)) && typeof v.digest === 'string' && SYNC_HASH.test(v.digest)
    && Number.isSafeInteger(v.bytes) && (v.bytes as number) > 0 && (v.bytes as number) <= SYNC_RECORD_BYTES
    && Number.isSafeInteger(v.byteOffset) && (v.byteOffset as number) >= 0 && (v.byteOffset as number) < (v.bytes as number) && (v.byteOffset as number) % SYNC_RECORD_PART_BYTES === 0
    && typeof v.data === 'string' && v.data.length > 0 && v.data.length <= SYNC_RECORD_PART_BYTES / 3 * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(v.data)
    && v.data.length === Math.ceil(Math.min(SYNC_RECORD_PART_BYTES, (v.bytes as number) - (v.byteOffset as number)) / 3) * 4
    && new TextEncoder().encode(JSON.stringify(v)).length <= SYNC_PAGE_BYTES;
  if (v.kind === 'blob-request') return true;
  if (v.kind === 'blob-metadata') return typeof v.metadata === 'string' && v.metadata.length > 0 && v.metadata.length <= 192 * 1024
    && /^[A-Za-z0-9+/]+={0,2}$/.test(v.metadata);
  return v.kind === 'page' && offset(v.offset) && offset(v.total) && (v.total as number) > 0 && Array.isArray(v.records)
    && v.records.length > 0 && v.records.length <= SYNC_PAGE_RECORDS && (v.offset as number) + v.records.length <= (v.total as number)
    && v.records.every(r => obj(r) && (r.kind === 'policy' && validSyncPolicy(r.value) || r.kind === 'revision' && validSyncRevision(r.value))
      && r.value.rootId === v.rootId)
    && new TextEncoder().encode(JSON.stringify(v)).length <= SYNC_PAGE_BYTES;
}
export function validSyncWireMessage(v: unknown): v is SyncWireMessage {
  return obj(v) && typeof v.t === 'string' && (FILE_SYNC_CAPABILITIES as readonly string[]).includes(v.t) && typeof v.memberId === 'string' && /^[a-f0-9]{32}$/.test(v.memberId)
    && typeof v.to === 'string' && (v.to === '' && obj(v.body) && ['offer', 'blob-request', 'history-request'].includes(v.body.kind as string) || /^[a-f0-9]{32}$/.test(v.to))
    && typeof v.pub === 'string' && v.pub.length > 0 && v.pub.length <= 2048
    && typeof v.sig === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(v.sig) && validSyncWireBody(v.body)
    && validSyncWireVersion(v.body, syncFrameVersion(v.t)) && (v.t === 'file-sync-history-v1') === syncHistoryBody(v.body);
}
/** A legacy frame must never acquire multi-writer semantics through nested records. */
export function validSyncWireVersion(body: SyncWireBody, version: SyncWireVersion): boolean {
  return (version === 1 || version === 2 || version === 3 || version === 4 || version === 5 || version === 6)
    && (body.kind !== 'part-request' && body.kind !== 'record-part' || version >= 5)
    && (!syncHistoryBody(body) || version === 5)
    && (body.kind !== 'page' || body.records.every(r => r.value.v <= version));
}
export function syncWireCanonical(topic: string, memberId: string, to: string, b: SyncWireBody, version: SyncWireVersion = 1): Uint8Array {
  const tail = b.kind === 'offer' ? [b.total] : b.kind === 'request' ? [b.offset] : b.kind === 'ack' ? [b.next]
    : b.kind === 'blob-request' ? [] : b.kind === 'blob-metadata' ? [b.metadata]
    : b.kind === 'part-request' ? [b.offset, b.byteOffset, b.digest]
    : b.kind === 'record-part' ? [b.offset, b.total, b.recordId, b.digest, b.bytes, b.byteOffset, b.data]
    : b.kind === 'history-request' ? [b.checkpointId, b.archiveDigest, b.byteOffset]
    : b.kind === 'history-missing' ? [b.checkpointId, b.archiveDigest]
    : b.kind === 'history-part' ? [b.checkpointId, b.archiveDigest, b.digest, b.bytes, b.byteOffset, b.data]
    : [b.offset, b.total, b.records.map(r => r.kind === 'policy'
      ? [r.kind, r.value.policyId, r.value.sig] : [r.kind, r.value.revisionId, r.value.sig])];
  // IDs commit to every semantic field; nested signatures and hashes are verified separately.
  return new TextEncoder().encode(JSON.stringify([`havvn-file-sync-wire:v${version}`, topic, memberId, to, b.kind, b.rootId, b.streamId, ...tail]));
}
